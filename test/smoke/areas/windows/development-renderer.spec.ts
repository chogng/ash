import { _electron, expect } from '@playwright/test';
import { test } from '../../../automation/test.js';
import { resolveElectronConfiguration } from '../../../automation/electron.js';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import sirv from 'sirv';

for (const [surface, outage] of [
	['workbench', 'startup'], ['workbench', 'reload'],
	['sessions', 'startup'], ['sessions', 'reload'],
] as const) {
	test(`development renderer (${surface}) recovers the same window after its HTTP server disconnects during ${outage}`, { tag: ['@electron-ui'] }, async ({ }, testInfo) => {
		test.setTimeout(45_000);
		const root = resolve(import.meta.dirname, '../../../..');
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
		const configuration = resolveElectronConfiguration({ desktopDirectory: root, appServerMode: 'disabled', userDataDirectory: profile, extraArgs: surface === 'sessions' ? ['--agents-window'] : [] });
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
			await page.keyboard.press('F1');
			await expect(page.locator('.ash-quick-pick').getByRole('combobox')).toBeFocused();
			await page.keyboard.press('Escape');
			await testInfo.attach('recovered-workbench', { body: await page.screenshot(), contentType: 'image/png' });
			await testInfo.attach('main-load-diagnostics', { body: diagnostic, contentType: 'text/plain' });
			await window.dispose();
		} finally {
			await electron.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
			await electron.close();
			await stopServer();
			await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		}
	});
}
