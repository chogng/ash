import { chromium, expect, test, type Browser, type Page } from '@playwright/test';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { ProcessRun, isProcessRunning, registerRunResource } from '../../../../build/processes.ts';
import { developmentAshPackagePath } from '../../../../build/desktop/runtimeStore.ts';
import { createTestEnvironment } from '../../../automation/testEnvironment.ts';
import { Workbench } from '../../../automation/workbench.js';

const repository = resolve(import.meta.dirname, '../../../..');
const execute = promisify(execFile);

async function freePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolveReady, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveReady); });
	const address = server.address();
	if (!address || typeof address === 'string') throw new Error('Missing test port');
	await new Promise<void>((resolveClosed, reject) => server.close(error => error ? reject(error) : resolveClosed()));
	return address.port;
}

async function inspect(port: number, expression: string): Promise<unknown> {
	const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as Array<{ webSocketDebuggerUrl: string; }>;
	const socket = new WebSocket(targets[0]!.webSocketDebuggerUrl);
	try {
		await new Promise<void>((resolveOpen, reject) => { socket.addEventListener('open', () => resolveOpen(), { once: true }); socket.addEventListener('error', reject, { once: true }); });
		return await new Promise((resolveResult, reject) => {
			const timeout = setTimeout(() => reject(new Error('Main inspector timed out')), 5_000);
			socket.addEventListener('message', event => {
				const message = JSON.parse(String(event.data)) as { id?: number; result?: { result?: { value?: unknown; }; }; error?: unknown; };
				if (message.id !== 1) return;
				clearTimeout(timeout);
				if (message.error) reject(message.error); else resolveResult(message.result?.result?.value);
			});
			socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
		});
	} finally { socket.close(); }
}

test('full checkout self-hosting retains edits across Renderer HMR, Main restart and Rust replacement', { tag: ['@electron-app-server'] }, async ({ }, info) => {
	test.skip(process.env.ASH_SELFHOST_ACCEPTANCE !== '1', 'Opt in to the exclusive checkout source-mutation scenario.');
	test.setTimeout(900_000);
	const directory = await mkdtemp(join(tmpdir(), 'ash-selfhost-'));
	const workspace = join(directory, 'workspace');
	const profile = join(directory, 'profile');
	await mkdir(workspace);
	await writeFile(join(workspace, 'selfhost.txt'), 'selfhost saved baseline\n');
	const environment = createTestEnvironment(directory, process.env);
	environment.ASH_HOME = profile;
	environment.CODEX_HOME = join(directory, 'codex');
	await mkdir(environment.CODEX_HOME);
	environment.ASH_DEV_APP_SERVER_RELOAD = '1';
	environment.ASH_TEST_WINDOW_MODE = 'hidden';
	delete environment.ASH_DESKTOP_UI_ONLY;
	const [vitePort, mainPort] = await Promise.all([freePort(), freePort()]);
	const userData = join(directory, 'user-data');
	environment.ASH_RENDERER_URL = `http://127.0.0.1:${vitePort}`;
	const run = new ProcessRun(repository, undefined, 5_000);
	const daemon = join(developmentAshPackagePath(repository), 'bin', `ash-app-server-daemon${process.platform === 'win32' ? '.exe' : ''}`);
	const registration = await registerRunResource({ executable: daemon, profile });
	let output = '';
	const start = async (arguments_: string[]) => {
		const child = spawn(process.execPath, arguments_, { cwd: repository, env: environment, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
		child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
		child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
		child.on('exit', (code, signal) => { output += `\n[${arguments_[0]}] exited: ${code ?? signal}\n`; });
		await run.own(child);
		return child;
	};
	const sources = await Promise.all([
		'src/ash/workbench/browser/parts/statusbar/statusbarPart.ts',
		'src/ash/code/electron-main/main.ts',
		'crates/app-server/src/startup.rs',
	].map(async path => ({ path: join(repository, path), original: await readFile(join(repository, path), 'utf8'), written: '' })));
	for (const source of sources) source.written = source.original;
	const patch = async (index: number, next: string) => {
		const source = sources[index]!;
		expect(await readFile(source.path, 'utf8')).toBe(source.written);
		await writeFile(source.path + '.selfhost-swap', next);
		await rename(source.path + '.selfhost-swap', source.path);
		source.written = next;
	};
	const backendLog = async () => {
		const root = join(profile, 'run');
		const files = await readdir(root).catch(() => [] as string[]);
		const logs = await Promise.all(files.filter(file => file.endsWith('.log')).map(async file => ({ file: join(root, file), mtime: (await stat(join(root, file))).mtimeMs })));
		return (await Promise.all(logs.sort((a, b) => a.mtime - b.mtime).map(file => readFile(file.file, 'utf8')))).join('\n');
	};
	const backendPid = async () => Number([...(await backendLog()).matchAll(/endpoint ready:.*\(pid (\d+)\)/g)].at(-1)?.[1]);
	let browser: Browser | undefined;
	let page: Page | undefined;
	let workbench: Workbench | undefined;
	const connect = async () => {
		// Each Electron generation owns a new ephemeral port. Reusing the old
		// listener on Windows can fail while its CDP sockets are still closing.
		let cdpPort = 0;
		await expect.poll(async () => {
			try {
				cdpPort = Number([...output.matchAll(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//g)].at(-1)?.[1]);
				return (await fetch(`http://127.0.0.1:${cdpPort}/json/version`, { signal: AbortSignal.timeout(2_000) })).ok;
			} catch { return false; }
		}, { timeout: 180_000 }).toBe(true);
		browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
		await expect.poll(() => browser!.contexts()[0]!.pages().filter(candidate => candidate.url().includes('workbench')).length, { timeout: 60_000 }).toBe(1);
		page = browser.contexts()[0]!.pages().find(candidate => candidate.url().includes('workbench'))!;
		page.on('pageerror', error => { output += `\n[renderer] ${error.stack ?? error.message}\n`; });
		page.on('console', message => { if (message.type() === 'error' || message.text().startsWith('[selfhost-rpc]')) output += `\n[renderer console] ${message.text()}\n`; });
		page.on('close', () => { output += '\n[renderer] page closed\n'; });
		await page.evaluate(() => {
			const saved = MessagePort.prototype.postMessage;
			const observed = new WeakSet<MessagePort>();
			const pending = new Map<number, string>();
			const bytes = (value: unknown) => value && typeof value === 'object' && 'data' in value && value.data instanceof Uint8Array ? value.data : undefined;
			MessagePort.prototype.postMessage = function (message: unknown, options?: Transferable[] | StructuredSerializeOptions) {
				const raw = bytes(message);
				if (raw) {
					const request = JSON.parse(new TextDecoder().decode(raw)) as { id: number; method?: string; params?: { extensionId?: string; event?: unknown; }; };
					if (request.method === 'extensionHost/activate') {
						pending.set(request.id, request.params?.extensionId ?? 'unknown');
						console.info('[selfhost-rpc]', JSON.stringify({ id: request.id, method: request.method, extension: request.params?.extensionId, event: request.params?.event }));
					}
					if (!observed.has(this)) {
						observed.add(this);
						let buffer = '';
						this.addEventListener('message', event => {
							const raw = bytes(event.data); if (!raw) return;
							buffer += new TextDecoder().decode(raw);
							let end: number;
							while ((end = buffer.indexOf('\n')) >= 0) {
								const response = JSON.parse(buffer.slice(0, end)) as { id?: number; error?: unknown; }; buffer = buffer.slice(end + 1);
								if (response.id !== undefined && pending.has(response.id)) { console.info('[selfhost-rpc]', JSON.stringify({ id: response.id, extension: pending.get(response.id), completed: true, failed: Boolean(response.error) })); pending.delete(response.id); }
							}
						});
					}
				}
				Reflect.apply(saved, this, options === undefined ? [message] : [message, options]);
			};
		});
		const trust = page.getByRole('button', { name: 'Trust Folder & Enable Features', exact: true });
		await expect.poll(async () => await trust.isVisible() || await page!.locator('.ash-workbench').isVisible(), { timeout: 60_000 }).toBe(true);
		if (await trust.isVisible()) await trust.click();
		workbench = new Workbench(page);
		await workbench.waitForReady();
	};
	const draft = 'selfhost unsaved edit survives all three owners';
	try {
		await test.step('start the actual development Renderer, Electron launcher and Rust watcher', async () => {
			await start(['node_modules/vite/bin/vite.js', '--config', 'build/desktop/vite/vite.config.ts', '--port', String(vitePort), '--strictPort']);
			await expect.poll(async () => { try { return (await fetch(`${environment.ASH_RENDERER_URL}/@vite/client`, { signal: AbortSignal.timeout(2_000) })).ok; } catch { return false; } }, { timeout: 180_000 }).toBe(true);
			await start(['build/desktop/launch/electron.ts', '--watch', `--inspect=${mainPort}`, '--remote-debugging-port=0', `--user-data-dir=${userData}`, `--folder=${workspace}`, '--use-inmemory-secretstorage', '--disable-gpu', '--in-process-gpu']);
			await connect();
			await start(['build/desktop/watch-app-server.ts', '--skip-initial']);
			await workbench!.quickaccess.open('selfhost.txt');
			await expect(page!.getByRole('option').filter({ hasText: 'selfhost.txt' })).toHaveCount(1, { timeout: 90_000 });
			await workbench!.quickaccess.select('selfhost.txt');
			const editor = workbench!.editors.groupAt(0).editor;
			await editor.waitForEditorFocus(); await editor.input.press('ControlOrMeta+A'); await page!.keyboard.insertText(draft);
			await editor.waitForEditorContents(value => value === draft);
			await page!.evaluate(() => Object.assign(globalThis, { ashSelfhostRealm: 'renderer-preserved' }));
		});
		const mainPid = Number(await inspect(mainPort, 'process.pid'));
		await test.step('patch a live Workbench method without replacing the Renderer or editor draft', async () => {
			await patch(0, sources[0]!.original.replace('focus(preserveEntryFocus = true): void {', 'focus(preserveEntryFocus = true): void {\n\t\tthis.domNode.dataset.selfhostHotReload = "applied";'));
			await expect.poll(async () => { await workbench!.quickaccess.runCommand('workbench.action.focusStatusBar'); return page!.locator('[data-part="statusbar"]').getAttribute('data-selfhost-hot-reload'); }, { timeout: 30_000 }).toBe('applied');
			expect(await page!.evaluate(() => (globalThis as typeof globalThis & { ashSelfhostRealm: string; }).ashSelfhostRealm)).toBe('renderer-preserved');
			await workbench!.editors.groupAt(0).editor.waitForEditorContents(value => value === draft);
			expect(await inspect(mainPort, 'process.pid')).toBe(mainPid);
		});
		await test.step('rebuild the real Main host, observe its new code and restore the unsaved editor', async () => {
			await browser!.close();
			expect(isProcessRunning(mainPid)).toBe(true);
			await patch(1, sources[1]!.original.replace('const developmentLauncher =', 'process.env.ASH_SELFHOST_MAIN_REVISION = "applied";\n\tconst developmentLauncher ='));
			await expect.poll(async () => { try { return await inspect(mainPort, 'process.env.ASH_SELFHOST_MAIN_REVISION'); } catch { return undefined; } }, { timeout: 90_000 }).toBe('applied');
			expect(await inspect(mainPort, 'process.pid')).not.toBe(mainPid);
			await expect.poll(() => isProcessRunning(mainPid)).toBe(false);
			await connect();
			await workbench!.editors.groupAt(0).editor.waitForEditorContents(value => value === draft);
			await page!.evaluate(() => Object.assign(globalThis, { ashSelfhostRealm: 'backend-reconnect-preserved' }));
		});
		const previousBackend = await backendPid();
		expect(previousBackend).toBeGreaterThan(0);
		await test.step('a failed Rust build keeps the current backend and editor usable', async () => {
			await patch(2, sources[2]!.original + '\ncompile_error!("ASH_SELFHOST_EXPECTED_BUILD_FAILURE");\n');
			await expect.poll(() => output.includes('error: ASH_SELFHOST_EXPECTED_BUILD_FAILURE'), { timeout: 300_000 }).toBe(true);
			expect(await backendPid()).toBe(previousBackend); expect(isProcessRunning(previousBackend)).toBe(true);
			await workbench!.editors.groupAt(0).editor.waitForEditorContents(value => value === draft);
		});
		await test.step('a corrected Rust save replaces the backend and reconnects the same Renderer', async () => {
			await patch(2, sources[2]!.original.replace('let arguments = arguments.into_iter()', 'eprintln!("ASH_SELFHOST_BACKEND_APPLIED");\n    let arguments = arguments.into_iter()'));
			await expect.poll(async () => (await backendLog()).includes('ASH_SELFHOST_BACKEND_APPLIED'), { timeout: 300_000 }).toBe(true);
			expect(await backendPid()).not.toBe(previousBackend);
			await expect.poll(() => isProcessRunning(previousBackend)).toBe(false);
			expect(await page!.evaluate(() => (globalThis as typeof globalThis & { ashSelfhostRealm: string; }).ashSelfhostRealm)).toBe('backend-reconnect-preserved');
			const editor = workbench!.editors.groupAt(0).editor;
			await editor.waitForEditorContents(value => value === draft);
			// The new process publishes its marker before protocol initialization.
			// Saving must exercise the restored connection, after Main confirms the
			// complete restart, rather than race the intentional offline interval.
			await expect.poll(() => output.includes('[app-server] Restarted development runtime'), { timeout: 90_000 }).toBe(true);
			await editor.waitForEditorFocus();
			await editor.input.press('ControlOrMeta+s');
			await expect.poll(() => readFile(join(workspace, 'selfhost.txt'), 'utf8')).toBe(draft);
		});
		await test.step('restore source files and accept the restored Main and backend generations', async () => {
			const backend = await backendPid();
			await browser!.close();
			await patch(0, sources[0]!.original); await patch(1, sources[1]!.original); await patch(2, sources[2]!.original);
			await expect.poll(async () => { try { return await inspect(mainPort, 'process.env.ASH_SELFHOST_MAIN_REVISION') === undefined; } catch { return false; } }, { timeout: 90_000 }).toBe(true);
			await expect.poll(async () => { const current = await backendPid(); return current > 0 && current !== backend; }, { timeout: 300_000 }).toBe(true);
			await connect();
			const editor = workbench!.editors.groupAt(0).editor;
			await editor.waitForEditorContents(value => value === draft);
			// The ARIA live region retains its last announcement after the visible
			// notice is removed, so inspect the banner's owned message element.
			await expect(page!.locator('.ash-banner-message').filter({ hasText: 'Reconnecting to the Agent Host…' })).toHaveCount(0, { timeout: 90_000 });
			// A new backend PID alone does not prove the restored window can save.
			// Exercise a fresh edit after restoration and leave the original draft.
			await editor.waitForEditorFocus();
			await editor.input.press('ControlOrMeta+End');
			await page!.keyboard.insertText('\nrestored backend accepts saves');
			await editor.input.press('ControlOrMeta+s');
			await expect.poll(() => readFile(join(workspace, 'selfhost.txt'), 'utf8')).toBe(`${draft}\nrestored backend accepts saves`);
			await editor.input.press('ControlOrMeta+A');
			await page!.keyboard.insertText(draft);
			await editor.input.press('ControlOrMeta+s');
			await expect.poll(() => readFile(join(workspace, 'selfhost.txt'), 'utf8')).toBe(draft);
			await page!.screenshot({ path: info.outputPath('selfhost-restored.png') });
		});
	} finally {
		const restoreErrors: unknown[] = [];
		for (const source of sources) {
			try {
				const current = await readFile(source.path, 'utf8');
				if (current === source.written) { if (current !== source.original) await writeFile(source.path, source.original); }
				else throw new Error(`Source changed concurrently; preserving ${source.path}`);
			} catch (error) { restoreErrors.push(error); }
		}
		try {
			const processLog = info.outputPath('selfhost-development.log');
			const serverLog = info.outputPath('selfhost-backend.log');
			await writeFile(processLog, output);
			await writeFile(serverLog, await backendLog());
			await info.attach('selfhost-development-processes', { path: processLog, contentType: 'text/plain' });
			await info.attach('selfhost-backend', { path: serverLog, contentType: 'text/plain' });
		}
		finally {
			try { await run.stop('SIGTERM'); }
			finally {
				await browser?.close().catch(() => { });
				await execute(daemon, ['stop'], { env: environment, windowsHide: true, timeout: 30_000 });
				await registration.dispose();
				const owned = relative(tmpdir(), directory);
				if (isAbsolute(owned) || !owned.startsWith('ash-selfhost-') || owned.includes('..')) throw new Error('Unsafe test cleanup path');
				await rm(directory, { recursive: true, force: true });
			}
		}
		if (restoreErrors.length) throw new AggregateError(restoreErrors, 'Self-host source restoration failed');
	}
});
