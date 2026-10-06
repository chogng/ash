import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type Page } from '@playwright/test';
import { developmentAshPackagePath } from '../../../../../build/app_ts/runtimeStore.ts';
import { authenticatedWebUrl, startWeb } from '../../../../../build/app_ts/web.ts';
import { expect, test } from '../../../automation/test.js';
import { Workbench } from '../../../automation/workbench.js';
import { Editor } from '../../../automation/editor.js';

const repository = resolve(import.meta.dirname, '../../../../..');

test('Sessions UI development opens directly and restores a draft after reload', async ({ target }) => {
	test.skip(target.kind !== 'browser' || target.appServerMode !== 'disabled', 'Requires the Browser UI project');
	test.setTimeout(60_000);
	const browser = await chromium.launch();
	let launch: Awaited<ReturnType<typeof launchWeb>> | undefined;
	try {
		launch = await launchWeb('development', await freePort(), { ...process.env, ASH_WEB_APP_SERVER: '0', ASH_DEV_AGENTS_WINDOW: '1', NO_COLOR: '1' });
		const page = await browser.newPage();
		await page.goto(launch.url);
		await expect(page.locator('.ash-sessions-window')).toBeVisible();
		expect(new URL(page.url()).pathname).toBe('/browser/sessions/sessions-code.html');
		expect(await page.evaluate(() => globalThis.ashWebWorkbenchHost)).toBeUndefined();
		expect(await page.evaluate(() => performance.getEntriesByType('resource').some(entry => entry.name.includes('/@vite/client')))).toBe(true);
		const editor = new Editor(page.locator('.ash-sessions-chat-input'));
		await editor.waitForEditorFocus();
		await page.keyboard.insertText('Sessions UI development draft');
		await editor.waitForEditorContents(text => text === 'Sessions UI development draft');
		await expect.poll(() => page.evaluate(() => Object.values(localStorage).some(value => value.includes('Sessions UI development draft')))).toBe(true);
		await page.reload();
		await editor.waitForEditorContents(text => text === 'Sessions UI development draft');
	} finally {
		await browser.close();
		if (launch) await stop(launch.child);
	}
});

for (const [mode, entry] of [['production', 'workbench'], ['development', 'workbench'], ['development', 'sessions']] as const) {
	test(`Web ${entry} ${mode} reconnects after backend restart without reloading and revokes closed launches`, async ({ target, testWorkspace }) => {
		test.skip(target.kind !== 'browser' || target.appServerMode !== 'required', 'Requires built Web and App Server artifacts');
		test.setTimeout(90_000);
		const profile = await mkdtemp(join(tmpdir(), 'ash-web-lifecycle-'));
		const port = await freePort();
		const env = { ...process.env, ASH_WEB_APP_SERVER: '1', ASH_DEV_AGENTS_WINDOW: entry === 'sessions' ? '1' : '0', ASH_WEB_APP_SERVER_PROFILE: profile, ASH_HOME: profile, ASH_WORKSPACE_ROOT: testWorkspace.directory };
		const browser = await chromium.launch();
		const context = await browser.newContext();
		const page = await context.newPage();
		const diagnostics: string[] = [];
		page.on('console', message => { if (message.type() === 'error') { diagnostics.push(message.text()); } });
		page.on('pageerror', error => diagnostics.push(error.message));
		page.on('websocket', socket => {
			socket.on('close', () => diagnostics.push(`Socket closed: ${socket.url()}`));
			socket.on('socketerror', error => diagnostics.push(`Socket error: ${error}`));
		});
		let launch: Awaited<ReturnType<typeof launchWeb>> | undefined;
		let hostDiagnostics = '';
		try {
			launch = await launchWeb(mode, port, env);
			launch.child.stderr!.on('data', chunk => { hostDiagnostics = (hostDiagnostics + String(chunk)).slice(-8192); });
			await page.goto(launch.url);
			await expectWorkspace(page, entry);
			expect(new URL(page.url()).pathname).toBe(entry === 'sessions' ? '/browser/sessions/sessions-code.html' : '/browser/workbench/workbench.html');
			expect(new URL(page.url()).hash).toBe('');
			const session = await page.evaluate(() => {
				const endpoint = sessionStorage.getItem('ash.appServer.endpoint')!;
				return { endpoint, token: sessionStorage.getItem(`ash.appServer.session:${new URL(endpoint).origin}`)! };
			});
			if (mode === 'development') {
				expect(new URL(session.endpoint).origin).not.toBe(new URL(page.url()).origin);
				expect(await page.evaluate(() => performance.getEntriesByType('resource').some(entry => entry.name.includes('/@vite/client')))).toBe(true);
				await page.reload();
				await expectWorkspace(page, entry);
			}
			await createConversation(page, 'Selected before reconnect');
			if (entry === 'workbench') await page.locator('[data-action-id="agentSessions.toggleAgentSessionsSidebar"] button').click();
			const sidebar = page.locator(entry === 'sessions' ? '.ash-sessions-list' : '.ash-chat-sessions-sidebar');
			const rows = entry === 'sessions' ? '.ash-sessions-list-item' : '.ash-agent-session-row';
			const selected = sidebar.locator(rows).filter({ hasText: 'Selected before reconnect' });
			await expect(selected).toBeVisible();
			await selected.click();
			const editor = new Editor(page.locator(entry === 'sessions' ? '.ash-sessions-chat-input' : '.ash-chat-view-pane'));
			await editor.waitForEditorFocus();
			await page.keyboard.insertText('Keep my unsent message after reconnect');
			await editor.waitForEditorContents(text => text === 'Keep my unsent message after reconnect');
			await page.evaluate(() => {
				(globalThis as typeof globalThis & { acceptanceHost: unknown; }).acceptanceHost = globalThis.ashWebWorkbenchHost;
			});
			await stopBackend(env);
			await expect.poll(async () => {
				try { await fetch(session.endpoint, { signal: AbortSignal.timeout(500) }); return true; } catch { return false; }
			}).toBe(false);
			expect(launch.child.exitCode).toBeNull();
			await stopBackend(env, 'start');
			await expect.poll(async () => {
				return page.evaluate(async () => {
					try {
						const host = globalThis.ashWebWorkbenchHost!;
						return (await host.api.fs.readFile({ dirId: host.workspace!.id, path: 'main.ts' })).content;
					} catch { return undefined; }
				});
			}, { timeout: 30_000 }).toBe('const value = 1;\n');
			expect(await page.evaluate(() => (globalThis as typeof globalThis & { acceptanceHost: unknown; }).acceptanceHost === globalThis.ashWebWorkbenchHost)).toBe(true);
			await expect(selected).toHaveAttribute('aria-current', 'page');
			await editor.waitForEditorContents(text => text === 'Keep my unsent message after reconnect');
			// A second client writes through the real API; only a restored catalog subscription
			// can notify the retained Workbench about this previously unknown Session.
			const peer = await context.newPage();
			try {
				await peer.addInitScript(({ endpoint, token }) => {
					sessionStorage.setItem('ash.appServer.endpoint', endpoint);
					sessionStorage.setItem(`ash.appServer.session:${new URL(endpoint).origin}`, token);
				}, session);
				await peer.goto(page.url());
				await expectWorkspace(peer, entry);
				const peerSessionId = await createConversation(peer, 'Created by another client');
				const added = sidebar.locator(rows).filter({ hasText: 'Created by another client' });
				await expect(added).toBeVisible();
				await peer.evaluate(async sessionId => {
					await globalThis.ashWebWorkbenchHost!.api.session.archive({ commandId: crypto.randomUUID(), sessionId });
				}, peerSessionId);
				await expect(added).toHaveCount(0);
				await expect(selected).toHaveAttribute('aria-current', 'page');
				await editor.waitForEditorContents(text => text === 'Keep my unsent message after reconnect');
			} finally {
				await peer.close();
			}
			const resumed = await fetch(new URL('/ash/session', session.endpoint), { method: 'POST', headers: { Origin: mode === 'development' ? new URL(page.url()).origin : new URL(session.endpoint).origin, Authorization: `Bearer ${session.token}` } });
			expect(resumed.status).toBe(200);

			await stop(launch.child);
			await expect.poll(async () => {
				try { await fetch(session.endpoint, { signal: AbortSignal.timeout(500) }); return true; } catch { return false; }
			}).toBe(false);
			if (mode === 'production') {
				launch = await launchWeb(mode, port, env);
				const revoked = await fetch(new URL('/ash/session', session.endpoint), { method: 'POST', headers: { Origin: new URL(session.endpoint).origin, Authorization: `Bearer ${session.token}` } });
				expect(revoked.status).toBe(401);
				await Promise.all([page.waitForEvent('load'), page.goto(launch.url)]);
				await expectWorkspace(page, entry);
			}
		} catch (error) {
			throw new Error(`${String(error)}\n${hostDiagnostics}\n${diagnostics.slice(-12).join('\n')}\n${await page.locator('body').innerText()}`, { cause: error });
		} finally {
			await browser.close();
			if (launch) { await stop(launch.child); }
			await stopBackend(env);
			await rm(profile, { recursive: true, force: true });
		}
	});
}

test('Web backend selection restores a Sessions connection and preserves its draft', async ({ target, testWorkspace }) => {
	test.skip(target.kind !== 'browser' || target.appServerMode !== 'required', 'Requires a real Web App Server');
	test.setTimeout(90_000);
	const profile = await mkdtemp(join(tmpdir(), 'ash-web-select-'));
	const env = { ...process.env, ASH_WEB_APP_SERVER_PROFILE: profile, ASH_HOME: profile, ASH_WORKSPACE_ROOT: testWorkspace.directory };
	const browser = await chromium.launch();
	let launch: Awaited<ReturnType<typeof startWeb>> | undefined;
	try {
		launch = await test.step('Start a managed Web listener', () => startWeb({ port: 0, assets: join(repository, '.build/app-ts/web/ash'), environment: env }));
		const page = await browser.newPage();
		await page.goto(authenticatedWebUrl(launch.info, launch.info.endpoint, '/browser/sessions/sessions-code.html'));
		await test.step('Open Sessions with its real workspace', () => expectWorkspace(page, 'sessions'));
		const editor = new Editor(page.locator('.ash-sessions-chat-input'));
		await editor.waitForEditorFocus();
		await page.keyboard.insertText('Retain my Sessions draft');
		await editor.waitForEditorContents(text => text === 'Retain my Sessions draft');
		await page.evaluate(() => { (globalThis as typeof globalThis & { acceptanceDocument: Document; }).acceptanceDocument = document; });
		await test.step('Stop the backend and select its current development package', async () => { await stopBackend(env); await launch!.reloadBackend(); });
		await expect.poll(() => page.evaluate(async () => {
			try {
				const host = globalThis.ashWebWorkbenchHost!;
				return (await host.api.fs.readFile({ dirId: host.workspace!.id, path: 'main.ts' })).content;
			} catch { return undefined; }
		}), { timeout: 30_000 }).toBe('const value = 1;\n');
		expect(await page.evaluate(() => (globalThis as typeof globalThis & { acceptanceDocument: Document; }).acceptanceDocument === document)).toBe(true);
		await editor.waitForEditorContents(text => text === 'Retain my Sessions draft');
	} finally {
		await browser.close();
		await launch?.close();
		await stopBackend(env);
		await rm(profile, { recursive: true, force: true });
	}
});

async function createConversation(page: Page, title: string): Promise<string> {
	return page.evaluate(async title => {
		const api = globalThis.ashWebWorkbenchHost!.api.session;
		const created = await api.create({ commandId: crypto.randomUUID(), title, executionTarget: null, agent: { type: 'default' } });
		await api.createThread({ commandId: crypto.randomUUID(), sessionId: created.session.sessionId, title: 'Main' });
		return created.session.sessionId;
	}, title);
}

async function expectWorkspace(page: Page, entry: 'workbench' | 'sessions'): Promise<void> {
	await page.waitForFunction(() => globalThis.ashWebWorkbenchHost !== undefined);
	if (entry === 'workbench') await new Workbench(page).waitForReady();
	else await expect(page.locator('.ash-sessions-window')).toBeVisible();
	const result = await page.evaluate(async () => {
		const host = globalThis.ashWebWorkbenchHost!;
		return host.api.fs.readFile({ dirId: host.workspace!.id, path: 'main.ts' });
	});
	expect(result.content).toBe('const value = 1;\n');
}

async function launchWeb(mode: 'production' | 'development', port: number, env: NodeJS.ProcessEnv): Promise<{ child: ChildProcess; url: string; }> {
	const args = mode === 'production'
		? ['../build/app_ts/launch/web.ts', '../.build/app-ts/web/ash', String(port)]
		: ['node_modules/vite/bin/vite.js', '--config', '../build/app_ts/vite/vite.config.ts', '--mode', 'web', '--port', String(port)];
	const child = spawn(process.execPath, args, { cwd: join(repository, 'app-ts'), env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
	try {
		const url = await new Promise<string>((resolveUrl, reject) => {
			let output = '';
			const timer = setTimeout(() => finish(new Error(`Web startup timed out: ${output}`)), 40_000);
			const finish = (error?: Error, url?: string): void => {
				clearTimeout(timer); child.off('error', onError); child.off('exit', onExit);
				child.stdout!.off('data', onData); child.stderr!.off('data', onData);
				child.stdout!.resume(); child.stderr!.resume();
				if (error) { reject(error); } else { resolveUrl(url!); }
			};
			const onError = (error: Error): void => finish(error);
			const onExit = (): void => finish(new Error(`Web exited before ready: ${output}`));
			const onData = (chunk: Buffer): void => {
				output = (output + chunk.toString()).slice(-16_384);
				const match = (env.ASH_WEB_APP_SERVER === '0' ? /Local:\s+(http:\/\/[^\s\x1b]+)/ : /Open Ash: (http:\/\/[^\s\x1b]+)/).exec(output);
				if (match) { finish(undefined, match[1]); }
			};
			child.stdout!.on('data', onData); child.stderr!.on('data', onData);
			child.once('error', onError); child.once('exit', onExit);
		});
		return { child, url };
	} catch (error) { await stop(child); throw error; }
}

async function stopBackend(env: NodeJS.ProcessEnv, command: 'stop' | 'start' = 'stop'): Promise<void> {
	const root = developmentAshPackagePath(repository, 'packaged-node');
	const executable = join(root, 'bin', process.platform === 'win32' ? 'ash-app-server-daemon.exe' : 'ash-app-server-daemon');
	await new Promise<void>((resolveExit, reject) => {
		const child = spawn(executable, [command], { env, stdio: 'ignore', windowsHide: true });
		child.once('error', reject);
		child.once('exit', code => code === 0 ? resolveExit() : reject(new Error(`Backend stop failed: ${code}`)));
	});
}

async function stop(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) { return; }
	await new Promise<void>(resolveExit => {
		child.once('close', resolveExit);
		child.kill();
	});
}

async function freePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
	const address = server.address();
	if (!address || typeof address === 'string') { throw new Error('Missing test port'); }
	await new Promise<void>(resolveClose => server.close(() => resolveClose()));
	return address.port;
}
