import { _electron, expect } from '@playwright/test';
import { test } from '../../../automation/test.js';
import { resolveElectronConfiguration } from '../../../automation/electron.js';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import sirv from 'sirv';

for (const [surface, outage] of [
	['workbench', 'startup'], ['workbench', 'reload'],
	['sessions', 'startup'], ['sessions', 'reload'],
] as const) {
	test(`development renderer (${surface}) recovers the same window after its HTTP server disconnects during ${outage}`, { tag: ['@electron-ui'] }, async ({ }, testInfo) => {
		test.setTimeout(45_000);
		const root = process.env.ASH_SMOKE_DESKTOP_DIRECTORY ?? resolve(import.meta.dirname, '../../../..');
		const selector = surface === 'workbench' ? '.ash-workbench' : '.ash-sessions-window[aria-busy="false"]';
		const entry = surface === 'workbench' ? 'electron-browser/workbench/workbench.html' : 'sessions/electron-browser/sessions.html';
		const profile = await mkdtemp(join(tmpdir(), 'ash-development-renderer-'));
		const serve = sirv(join(root, '.build/desktop/renderer/ash'), { dev: true });
		let entryReady = true;
		let unavailableRequests = 0;
		const server = createServer((request, response) => {
			if (!entryReady) { unavailableRequests++; response.writeHead(503).end(); return; }
			serve(request, response);
		});
		const stopServer = (): Promise<void> => new Promise((resolve, reject) => {
			if (!server.listening) { resolve(); return; }
			server.close(error => error ? reject(error) : resolve());
			server.closeAllConnections();
		});
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		const address = server.address();
		if (!address || typeof address === 'string') throw new Error('Missing test HTTP listener');
		const origin = `http://127.0.0.1:${address.port}`;
		if (outage === 'startup') await stopServer();
		const configuration = resolveElectronConfiguration({
			desktopDirectory: root, appServerMode: 'disabled', windowMode: 'active', userDataDirectory: profile,
			extraArgs: surface === 'sessions' ? ['--agents-window'] : [],
		});
		const electron = await _electron.launch({
			args: [...configuration.args], cwd: configuration.cwd, executablePath: configuration.executablePath,
			env: { ...configuration.env, ASH_RENDERER_URL: origin },
			recordVideo: { dir: testInfo.outputPath('videos'), size: { width: 1440, height: 900 } },
		});
		const readDiagnostics = async (): Promise<string> => {
			const directories = await readdir(join(profile, 'logs'));
			return (await Promise.all(directories.map(directory => readFile(join(profile, 'logs', directory, 'main.log'), 'utf8')))).join('\n');
		};
		const restoreServer = async (): Promise<void> => {
			// A listening port is insufficient: the host must wait for the entry's
			// successful HTTP response before navigating the window.
			entryReady = false;
			await new Promise<void>(resolve => server.listen(address.port, '127.0.0.1', resolve));
			await expect.poll(() => unavailableRequests, { timeout: 10_000 }).toBeGreaterThanOrEqual(2);
			entryReady = true;
		};
		try {
			if (outage === 'startup') {
				await expect.poll(async () => (await readDiagnostics()).includes('Waiting for development renderer')).toBe(true);
				await restoreServer();
			}
			const page = await electron.firstWindow();
			// Main owns beforeunload for product documents; prevent CDP from
			// automatically dismissing the same decision while Main handles it.
			page.on('dialog', dialog => { expect(dialog.type()).toBe('beforeunload'); });
			await expect(page.locator(selector)).toBeVisible();
			const window = await electron.browserWindow(page);
			const windowId = await window.evaluate(window => window.id);
			if (outage === 'reload') {
				await stopServer();
				const failedRequest = page.waitForEvent('requestfailed', { predicate: request => request.isNavigationRequest() && request.frame() === page.mainFrame() });
				await page.reload({ timeout: 10_000 }).catch(() => undefined);
				expect((await failedRequest).failure()).toEqual({ errorText: 'net::ERR_CONNECTION_REFUSED' });
				await restoreServer();
				await expect(page.locator(selector)).toBeVisible({ timeout: 10_000 });
			}
			const diagnostic = await readDiagnostics();
			const failure = diagnostic.split('\n').filter(Boolean).map(line => JSON.parse(line) as { message: string; }).find(row => row.message.includes('Renderer navigation failed'));
			if (outage === 'reload') expect(failure).toMatchObject({ message: expect.stringContaining(`"code":-102,"description":"ERR_CONNECTION_REFUSED","url":"${origin}/${entry}"`) });
			expect(await window.evaluate(window => window.id)).toBe(windowId);
			await electron.evaluate(({ app }) => app.focus({ steal: true }));
			await window.evaluate(window => { window.show(); window.focus(); });
			await page.bringToFront();
			await page.keyboard.press('F1');
			await expect(page.locator('.ash-quick-pick').getByRole('combobox')).toBeFocused();
			await page.keyboard.press('Escape');
			await testInfo.attach('recovered-workbench', { body: await page.screenshot({ path: testInfo.outputPath('recovered-workbench.png') }), contentType: 'image/png' });
			await testInfo.attach('main-load-diagnostics', { body: diagnostic, contentType: 'text/plain' });
			await window.dispose();
		} finally {
			await testInfo.attach('main-load-final-diagnostics', { body: await readDiagnostics().catch(String), contentType: 'text/plain' });
			await electron.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
			await electron.close();
			await stopServer();
			await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		}
	});
}

for (const surface of ['workbench', 'sessions'] as const) {
	for (const locale of ['en', 'zh-CN'] as const) {
		test(`window recovery (${surface}, ${locale}) cancels stale prompts and reopens a crashed renderer`, { tag: ['@electron-ui'] }, async ({ }, testInfo) => {
			const root = process.env.ASH_SMOKE_DESKTOP_DIRECTORY ?? resolve(import.meta.dirname, '../../../..');
			const profile = await mkdtemp(join(tmpdir(), 'ash-window-recovery-'));
			const configuration = resolveElectronConfiguration({
				desktopDirectory: root, appServerMode: 'disabled', windowMode: 'active', userDataDirectory: profile,
				extraArgs: surface === 'sessions' ? ['--agents-window'] : [],
			});
			await mkdir(configuration.env.ASH_HOME!, { recursive: true });
			await writeFile(join(configuration.env.ASH_HOME!, 'settings.json'), JSON.stringify({ 'workbench.locale': locale }));
			const electron = await _electron.launch({
				args: [...configuration.args], cwd: configuration.cwd, executablePath: configuration.executablePath,
				env: configuration.env,
				recordVideo: { dir: testInfo.outputPath('videos'), size: { width: 1440, height: 900 } },
			});
			try {
				const page = await electron.firstWindow();
				// Main owns beforeunload for product documents; prevent CDP from
				// automatically dismissing the same decision while Main handles it.
				page.on('dialog', dialog => { expect(dialog.type()).toBe('beforeunload'); });
				const selector = surface === 'workbench' ? '.ash-workbench' : '.ash-sessions-window[aria-busy="false"]';
				await expect(page.locator(selector)).toBeVisible();
				const window = await electron.browserWindow(page);
				const id = await window.evaluate(window => window.id);
				// Only the OS response is controlled. Electron events, renderer crash,
				// window ownership, loading and Renderer initialization remain real.
				const fixture = await electron.evaluateHandle(({ dialog }) => {
					const original = dialog.showMessageBox;
					const prompts: Electron.MessageBoxOptions[] = [];
					const pending: ((result: Electron.MessageBoxReturnValue) => void)[] = [];
					Object.defineProperty(dialog, 'showMessageBox', {
						configurable: true, value: (...args: unknown[]) => {
							const options = args.at(-1) as Electron.MessageBoxOptions;
							prompts.push(options);
							return new Promise<Electron.MessageBoxReturnValue>(resolve => pending.push(resolve));
						}
					});
					return {
						prompts,
						choose(index: number, label: string): void {
							pending[index]!({ response: prompts[index]!.buttons!.indexOf(label), checkboxChecked: false });
						},
						restore(): void { dialog.showMessageBox = original; },
					};
				});
				const labels = locale === 'zh-CN'
					? { unresponsive: '窗口没有响应。', gone: '窗口意外关闭。', close: '关闭', reopen: '重新打开' }
					: { unresponsive: 'The window is not responding.', gone: 'The window closed unexpectedly.', close: 'Close', reopen: 'Reopen' };
				try {
					await window.evaluate(window => { window.emit('unresponsive'); window.emit('unresponsive'); });
					await expect.poll(() => fixture.evaluate(fixture => fixture.prompts.map(prompt => prompt.message))).toEqual([labels.unresponsive]);
					await window.evaluate(window => window.emit('responsive'));
					expect(await fixture.evaluate(fixture => fixture.prompts[0]!.signal?.aborted)).toBe(true);
					await fixture.evaluate((fixture, label) => fixture.choose(0, label), labels.close);
					expect(await window.evaluate(window => window.isDestroyed())).toBe(false);

					const crashed = page.waitForEvent('crash');
					await window.evaluate(window => window.webContents.forcefullyCrashRenderer());
					await crashed;
					await expect.poll(() => fixture.evaluate(fixture => fixture.prompts.map(prompt => prompt.message))).toEqual([labels.unresponsive, labels.gone]);
					await fixture.evaluate((fixture, label) => fixture.choose(1, label), labels.reopen);
					// Playwright permanently retires a Page after its crash event. Use
					// Electron's live renderer here to verify the real recovery, rather
					// than asking the retired automation target to inspect a new document.
					await expect.poll(() => window.evaluate((window, selector) => window.webContents.executeJavaScript(
						`(document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect().width ?? 0) > 0`,
					), selector)).toBe(true);
					expect(await window.evaluate(window => window.id)).toBe(id);
					await electron.evaluate(({ app }) => app.focus({ steal: true }));
					await window.evaluate(window => {
						window.show();
						window.focus();
						window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'F1' });
						window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'F1' });
					});
					await expect.poll(() => window.evaluate(window => window.webContents.executeJavaScript(
						`document.activeElement?.matches('.ash-quick-pick input[role="combobox"]') === true`,
					))).toBe(true);
					await window.evaluate(window => {
						window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
						window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
					});
					await expect.poll(() => window.evaluate(window => window.webContents.executeJavaScript(
						`document.querySelector('.ash-quick-pick')?.getBoundingClientRect().width ?? 0`,
					))).toBe(0);
					const screenshot = await window.evaluate(async window => (await window.webContents.capturePage()).toPNG().toString('base64'));
					const screenshotPath = testInfo.outputPath('recovered-window.png');
					await writeFile(screenshotPath, Buffer.from(screenshot, 'base64'));
					await testInfo.attach('recovered-window', { path: screenshotPath, contentType: 'image/png' });
					const prompts = await fixture.evaluate(fixture => fixture.prompts.map(({ message, buttons }) => ({ message, buttons })));
					await testInfo.attach('recovery-prompts', { body: JSON.stringify(prompts), contentType: 'application/json' });
				} finally {
					await fixture.evaluate(fixture => fixture.restore());
					await fixture.dispose();
					await window.dispose();
				}
			} finally {
				await electron.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
				await electron.close();
				await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
			}
		});
	}
}
