import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { chromium, type Browser, type Page, type TestInfo } from '@playwright/test';
import { test as base, expect } from '../../../automation/test.js';
import { Workbench } from '../../../automation/workbench.js';
import { developmentAshPackagePath } from '../../../../src/ash/platform/environment/node/developmentArtifacts.js';

const repository = resolve(import.meta.dirname, '../../../..');
const execute = promisify(execFile);
// Self hosting deliberately opens this checkout. The normal fixture must never
// remove it or rewrite its launch.json; only the application profiles are isolated.
const test = base.extend<{ selfHostToolchain: void; }>({
	selfHostToolchain: [async ({ }, use) => {
		// The application home stays disposable. Build tasks share only the host's
		// Go toolchain cache, as the ordinary launcher already does for Cargo/rustup.
		const { stdout } = await execute('go', ['env', 'GOCACHE', 'GOMODCACHE']);
		const keys = ['GOCACHE', 'GOMODCACHE'] as const;
		const saved = keys.map(key => process.env[key]);
		const values = stdout.trim().split(/\r?\n/);
		for (let i = 0; i < keys.length; i++) process.env[keys[i]!] = values[i];
		const path = process.env.PATH;
		const manager = process.env.npm_execpath;
		if (manager && existsSync(join(dirname(manager), process.platform === 'win32' ? 'pnpm.exe' : 'pnpm'))) {
			// Use the already selected package manager, avoiding another pinned
			// pnpm installation in each disposable application home.
			process.env.PATH = `${dirname(manager)}${delimiter}${path ?? ''}`;
		}
		try { await use(); }
		finally {
			if (path === undefined) delete process.env.PATH;
			else process.env.PATH = path;
			for (let i = 0; i < keys.length; i++) {
				if (saved[i] === undefined) delete process.env[keys[i]!];
				else process.env[keys[i]!] = saved[i];
			}
		}
	}, { auto: true }],
	testWorkspace: async ({ }, use) => {
		await use({ directory: repository, file: join(repository, 'src/main.ts'), rustFile: join(repository, 'crates/app-server-host/src/main.rs'), academyFile: '', largeFile: '', pdfFile: '' });
	},
});

const desktopTest = test.extend<{ debugTarget: { directory: string; profile: string; endpoint: string; }; }>({
	debugTarget: async ({ }, use) => {
		const directory = await realpath(await mkdtemp(join(tmpdir(), 'ash-debug-watcher-')));
		const servers = Array.from({ length: 3 }, () => createServer());
		try {
			await Promise.all(servers.map(server => new Promise<void>((resolveReady, reject) => {
				server.once('error', reject);
				server.listen(0, '127.0.0.1', resolveReady);
			})));
			const ports = servers.map(server => (server.address() as AddressInfo).port);
			const profile = join(directory, 'profile');
			const replacements: Array<readonly [string, string]> = [
				['${workspaceFolder}/.build/desktop/debug/profile', profile],
				['${workspaceFolder}/.build/desktop/debug/user-data', join(directory, 'user-data')],
				['--folder=${workspaceFolder}', `--folder=${directory}`],
				['${workspaceFolder}', repository],
				...['5183', '9222', '9229'].map((port, index) => [port, String(ports[index])] as const),
			];
			const replace = (value: unknown): unknown => {
				if (typeof value === 'number') {
					const port = ['5183', '9222', '9229'].indexOf(String(value));
					return port < 0 ? value : ports[port];
				}
				if (typeof value === 'string') {
					let result = value;
					for (const [from, to] of replacements) result = result.replaceAll(from, to);
					return result;
				}
				if (Array.isArray(value)) return value.map(replace);
				if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, key === 'cwd' ? directory : replace(child)]));
				return value;
			};
			await mkdir(join(directory, '.vscode'));
			for (const name of ['launch.json', 'tasks.json']) {
				const source = JSON.parse(await readFile(join(repository, '.vscode', name), 'utf8'));
				if (name === 'tasks.json') {
					// Terminals stay authorized to the synthetic workspace. The actual
					// builders resolve this checkout through pnpm's directory option.
					for (const task of source.tasks) {
						if (task.command?.startsWith('pnpm ')) {
							task.args = ['--dir', repository, ...task.command.slice('pnpm '.length).split(' ')];
							task.command = 'pnpm';
							task.type = 'process';
						} else if (task.command === 'node') {
							task.args[0] = join(repository, task.args[0]);
						}
					}
				}
				await writeFile(join(directory, '.vscode', name), JSON.stringify(replace(source)));
			}
			await writeFile(join(directory, 'selfhost.txt'), 'Isolated Desktop debug task fixture.\n');
			await Promise.all(servers.map(server => new Promise<void>((resolveClosed, reject) => server.close(error => error ? reject(error) : resolveClosed()))));
			await use({ directory, profile, endpoint: `http://127.0.0.1:${ports[1]}` });
		} finally {
			for (const server of servers) if (server.listening) server.close();
			await rm(directory, { recursive: true, force: true });
		}
	},
	testWorkspace: async ({ debugTarget }, use) => {
		await use({ directory: debugTarget.directory, file: join(debugTarget.directory, 'selfhost.txt'), rustFile: '', academyFile: '', largeFile: '', pdfFile: '' });
	},
});

async function openQuick(workbench: Workbench, value: string): Promise<void> {
	await workbench.page.bringToFront();
	await workbench.page.keyboard.press('F1');
	// Both native instances remain interactive even when macOS gives the other
	// window system focus. Scope input to the visible picker instead of requiring it.
	await expect(workbench.quickaccess.input).toBeVisible();
	await workbench.quickaccess.input.fill(value);
}

async function command(workbench: Workbench, id: string): Promise<void> {
	await openQuick(workbench, `>${id}`);
	const list = workbench.page.locator(`[id="${await workbench.quickaccess.input.getAttribute('aria-controls')}"]`);
	await workbench.quickaccess.items.filter({ has: workbench.page.locator('.ash-quick-pick-row-description').getByText(id, { exact: true }) }).click();
	await list.waitFor({ state: 'hidden' });
}

async function breakpoint(workbench: Workbench, file: string, token: string): Promise<void> {
	const lines = (await readFile(join(repository, file), 'utf8')).split('\n');
	const line = lines.findIndex(value => value.includes(token)) + 1;
	expect(line).toBeGreaterThan(0);
	await openQuick(workbench, join(repository, file));
	await workbench.quickaccess.select(file.split('/').at(-1)!);
	const editor = workbench.editors.groupAt(0).editor;
	await expect(editor.element).toBeVisible();
	await editor.input.focus();
	await openQuick(workbench, `:${line}`);
	await workbench.quickaccess.input.press('Enter');
	await expect(workbench.quickaccess.element).toBeHidden();
	await editor.input.focus();
	await workbench.page.keyboard.press('F9');
}

async function start(workbench: Workbench, name: string): Promise<void> {
	await workbench.page.bringToFront();
	if (!await workbench.page.locator('[data-view-container-id="ash.debug"]').isVisible()) {
		await workbench.page.getByRole('tab', { name: 'Run and Debug', exact: true }).first().click();
	}
	await openQuick(workbench, `debug ${name}`);
	await workbench.quickaccess.select(name);
}

async function readyTarget(page: Page): Promise<void> {
	const trust = page.getByRole('button', { name: 'Trust Folder', exact: true });
	await expect(page.locator('.ash-workbench').or(trust).first()).toBeVisible({ timeout: 120_000 });
	if (await trust.isVisible()) await trust.click();
	await expect(page.locator('.ash-workbench')).toBeVisible({ timeout: 60_000 });
}

async function expandScope(workbench: Workbench, name: 'Local' | 'Module'): Promise<void> {
	const scope = workbench.page.locator('[data-view-container-id="ash.debug"] .ash-debug-variable').filter({ hasText: new RegExp(`^[▸▾] ${name}(?::.*)?$`) });
	await expect(scope).toBeVisible();
	if (await scope.getAttribute('aria-expanded') === 'false') await scope.click();
}

async function debugServiceProcessIds(directory: string): Promise<number[]> {
	let processes: { pid: number; parent: number; command: string; }[];
	if (process.platform === 'win32') {
		const { stdout } = await execute('powershell.exe', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | Select-Object @{n="pid";e={$_.ProcessId}},@{n="parent";e={$_.ParentProcessId}},@{n="command";e={$_.CommandLine}} | ConvertTo-Json -Compress'], { windowsHide: true });
		processes = JSON.parse(stdout);
	} else {
		const { stdout } = await execute('ps', ['-eo', 'pid=,ppid=,args=']);
		processes = stdout.trim().split('\n').map(line => {
			const [, pid, parent, command] = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/u)!;
			return { pid: Number(pid), parent: Number(parent), command };
		});
	}
	const descendants = new Set(processes.filter(process => process.command?.includes('build/desktop/launch/electron.ts') && process.command.includes(directory)).map(process => process.pid));
	let count = -1;
	while (count !== descendants.size) {
		count = descendants.size;
		for (const process of processes) if (descendants.has(process.parent)) descendants.add(process.pid);
	}
	return processes.filter(process => descendants.has(process.pid) && /watch-app-server[.]ts|vite[/\\]bin[/\\]vite[.]js/u.test(process.command)).map(process => process.pid);
}

async function stop(workbench: Workbench, browser?: Browser, profile = join(repository, '.build/desktop/debug/profile')): Promise<void> {
	if (!workbench.page.isClosed()) {
		await command(workbench, 'workbench.action.debug.stopAll').catch(() => undefined);
	}
	await browser?.close();
	const daemon = join(developmentAshPackagePath(repository, 'host-provided-node'), 'bin', process.platform === 'win32' ? 'ash-app-server-daemon.exe' : 'ash-app-server-daemon');
	await execute(daemon, ['stop'], { env: { ...process.env, ASH_HOME: profile } });
}

async function finish(workbench: Workbench, info: TestInfo, failed: boolean, browser?: Browser, profile?: string): Promise<void> {
	try { await stop(workbench, browser, profile); }
	catch (error) {
		if (!failed) throw error;
		await info.attach('cleanup-error', { body: String(error), contentType: 'text/plain' });
	}
}

desktopTest('Desktop Stop releases its Renderer and Rust watcher before the next F5 in Ash', { tag: ['@electron-app-server'] }, async ({ workbench, debugTarget }, info) => {
	desktopTest.setTimeout(360_000);
	let servicePids: number[] = [];
	let failed = false;
	try {
		for (const [name, entry] of [['Ash', '/workbench.html'], ['Ash Agents', '/sessions.html']] as const) {
			await workbench.page.bringToFront();
			if (!await workbench.page.locator('[data-view-container-id="ash.debug"]').isVisible()) {
				await workbench.page.getByRole('tab', { name: 'Run and Debug', exact: true }).first().click();
			}
			await workbench.page.getByRole('button', { name: /^Debug configuration:/ }).click();
			await workbench.page.getByRole('menu').getByText(name, { exact: true }).click();
			await workbench.page.keyboard.press('F5');
			await expect.poll(async () => {
				try {
					const targets = await (await fetch(`${debugTarget.endpoint}/json/list`)).json() as Array<{ url: string; }>;
					return targets.some(target => target.url.includes(entry));
				} catch { return false; }
			}, { timeout: 120_000 }).toBe(true);
			await expect.poll(async () => {
				servicePids = await debugServiceProcessIds(debugTarget.directory);
				return servicePids.length;
			}).toBe(2);
			await expect(workbench.terminal.tabs.filter({ hasText: /Watch Ash Backend|Run Ash Desktop Renderer/u })).toHaveCount(0);
			await workbench.page.keyboard.press('Shift+F5');
			await expect.poll(async () => fetch(`${debugTarget.endpoint}/json/list`).then(() => true, () => false)).toBe(false);
			for (const pid of servicePids) await expect.poll(() => { try { process.kill(pid, 0); return true; } catch { return false; } }).toBe(false);
		}
	} catch (error) {
		failed = true;
		await info.attach('debug-state-before-cleanup', { body: await workbench.page.locator('body').innerText(), contentType: 'text/plain' });
		throw error;
	} finally {
		await finish(workbench, info, failed, undefined, debugTarget.profile);
		for (const pid of servicePids) await expect.poll(() => { try { process.kill(pid, 0); return true; } catch { return false; } }).toBe(false);
	}
});

base('Stop cancels a pre-launch build and its already started task dependencies in Ash', { tag: ['@electron-app-server'] }, async ({ workbench, testWorkspace }) => {
	const root = testWorkspace.directory;
	await mkdir(join(root, '.vscode'), { recursive: true });
	await writeFile(join(root, 'watch.cjs'), "require('node:fs').writeFileSync('watch.pid', String(process.pid)); console.log('WATCH_READY'); setInterval(() => {}, 1000);");
	await writeFile(join(root, 'build.cjs'), "const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); require('node:fs').writeFileSync('build.pids', JSON.stringify([process.pid, child.pid])); setInterval(() => {}, 1000);");
	await writeFile(join(root, 'unexpected.cjs'), "require('node:fs').writeFileSync('unexpected', 'started');");
	await writeFile(join(root, '.vscode/tasks.json'), JSON.stringify({
		version: '2.0.0', tasks: [
			{ label: 'prepare', dependsOrder: 'sequence', dependsOn: ['watch', 'build', 'later'] },
			{
				label: 'watch', type: 'process', command: process.execPath, args: ['watch.cjs'], isBackground: true,
				problemMatcher: { owner: 'selfhost-test', pattern: { regexp: '^(never):(\\d+):(.*)$', file: 1, line: 2, message: 3 }, background: { activeOnStart: true, beginsPattern: '^WATCH_READY$', endsPattern: '^WATCH_READY$' } },
			},
			{ label: 'build', type: 'process', command: process.execPath, args: ['build.cjs'], problemMatcher: [] },
			{ label: 'later', type: 'process', command: process.execPath, args: ['unexpected.cjs'], problemMatcher: [] },
		]
	}));
	await writeFile(join(root, '.vscode/launch.json'), JSON.stringify({
		version: '0.2.0', configurations: [
			{ name: 'Cancel preparation', type: 'node', request: 'launch', program: '${workspaceFolder}/unexpected.cjs', cwd: '${workspaceFolder}', preLaunchTask: 'prepare' },
		]
	}));
	await workbench.quickaccess.runCommand('workbench.action.debug.start');
	await expect.poll(async () => readFile(join(root, 'build.pids'), 'utf8').then(() => true, () => false)).toBe(true);
	const pids = [Number(await readFile(join(root, 'watch.pid'), 'utf8')), ...JSON.parse(await readFile(join(root, 'build.pids'), 'utf8')) as number[]];
	await workbench.page.keyboard.press('Shift+F5');
	for (const pid of pids) await expect.poll(() => { try { process.kill(pid, 0); return true; } catch { return false; } }, { timeout: 15_000 }).toBe(false);
	expect(existsSync(join(root, 'unexpected'))).toBe(false);
});

test('Ash self hosts Electron main and renderer source breakpoints and releases debug targets', { tag: ['@electron-app-server'] }, async ({ workbench }, info) => {
	test.setTimeout(360_000);
	const page = workbench.page;
	let browser: Browser | undefined;
	let failed = false;
	const pane = page.locator('[data-view-container-id="ash.debug"]');
	try {
		await breakpoint(workbench, 'src/ash/code/electron-main/main.ts', 'const profileRoot = resolveHome();');
		await start(workbench, 'Ash');
		await expect(pane.locator('.ash-debug-frame.selected')).toContainText('main.ts:', { timeout: 120_000 });
		await expandScope(workbench, 'Local');
		await expect(pane.locator('.ash-debug-variables')).toContainText('developmentLauncher');
		await page.screenshot({ path: info.outputPath('main-breakpoint.png') });
		// This startup breakpoint has served its assertion. Rebuilds triggered by
		// another development window must not pause a replacement main process.
		await pane.getByRole('button', { name: 'Remove breakpoint', exact: true }).click();
		await command(workbench, 'workbench.action.debug.continue');
		await expect.poll(async () => {
			try { return (await fetch('http://127.0.0.1:9222/json/list')).ok; } catch { return false; }
		}, { timeout: 60_000 }).toBe(true);
		browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
		await expect.poll(() => browser!.contexts()[0]!.pages().some(candidate => candidate.url().includes('workbench.html')), { timeout: 60_000 }).toBe(true);
		const target = browser.contexts()[0]!.pages().find(candidate => candidate.url().includes('workbench.html'))!;
		expect(target).toBeDefined();
		await readyTarget(target);
		await breakpoint(workbench, 'src/ash/workbench/contrib/terminal/browser/terminalService.ts', 'const scope = terminalExecutionScope(this.workspaceContext.getWorkspace());');
		const sessions = pane.getByRole('combobox', { name: 'Active debug session' }).getByRole('option');
		const title = await target.title();
		await start(workbench, 'Ash Renderer');
		// The browser adapter publishes its page as a separate DAP child. Wait for
		// that page (workers can arrive first) before the one-shot terminal command.
		await expect(sessions.filter({ hasText: title })).toHaveCount(1, { timeout: 60_000 });
		const targetWorkbench = new Workbench(target);
		// The target's renderer is paused by this action, including Playwright's
		// command-picker completion check. Let the debugger resume it first.
		const creatingTerminal = command(targetWorkbench, 'workbench.action.terminal.new');
		void creatingTerminal.catch(() => undefined);
		await expect(pane.locator('.ash-debug-frame.selected')).toContainText('terminalService.ts:', { timeout: 30_000 });
		await expandScope(workbench, 'Local');
		await expect(pane.locator('.ash-debug-variables')).toContainText('options');
		await page.screenshot({ path: info.outputPath('renderer-breakpoint.png') });
		const frame = await pane.locator('.ash-debug-frame.selected').innerText();
		await command(workbench, 'workbench.action.debug.stepOver');
		await expect(pane.locator('.ash-debug-frame.selected')).not.toHaveText(frame);
		await expect(pane.locator('.ash-debug-frame.selected')).toContainText('.ts:');
		await pane.getByRole('button', { name: 'Remove breakpoint', exact: true }).click();
		await command(workbench, 'workbench.action.debug.continue');
		await creatingTerminal;
		await expect(targetWorkbench.terminal.activeInstance).toBeVisible({ timeout: 30_000 });
		await command(workbench, 'workbench.action.debug.stopAll');
		await expect(pane.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
		await expect.poll(async () => fetch('http://127.0.0.1:9222/json/list').then(() => true, () => false)).toBe(false);
	} catch (error) {
		failed = true;
		await info.attach('debug-state-before-cleanup', { body: await page.locator('body').innerText(), contentType: 'text/plain' });
		throw error;
	} finally {
		await finish(workbench, info, failed, browser);
	}
});

test('Ash self hosts its symbol-bearing Rust App Server through CodeLLDB attach', { tag: ['@electron-app-server', '@darwin'] }, async ({ workbench }, info) => {
	test.setTimeout(480_000);
	const page = workbench.page;
	const pane = page.locator('[data-view-container-id="ash.debug"]');
	let browser: Browser | undefined;
	let failed = false;
	try {
		await start(workbench, 'Ash (Native Debug)');
		await expect.poll(async () => fetch('http://127.0.0.1:9222/json/list').then(response => response.ok, () => false), { timeout: 240_000 }).toBe(true);
		browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
		await expect.poll(() => browser!.contexts()[0]!.pages().some(candidate => candidate.url().includes('workbench.html')), { timeout: 60_000 }).toBe(true);
		const target = browser.contexts()[0]!.pages().find(candidate => candidate.url().includes('workbench.html'))!;
		await readyTarget(target);
		const { stdout } = await execute(process.execPath, ['build/python.ts', '-B', 'build/desktop/debug.py', '--status'], { cwd: repository });
		const status = JSON.parse(stdout) as { status: string; pid: number; };
		expect(status.status).toBe('running');
		expect(status.pid).toBeGreaterThan(0);
		const processPath = (await execute('ps', ['-p', String(status.pid), '-o', 'comm='])).stdout.trim();
		expect(processPath).toContain('/debug/app-server/generations/');
		await breakpoint(workbench, 'crates/app-server/src/server/request_processors/search.rs', 'let params: ContentSearchStartParams = decode(params)?;');
		await start(workbench, 'Ash App Server (Attach)');
		const processInput = page.getByRole('textbox', { name: /^PID of the isolated Ash/ });
		await processInput.fill(String(status.pid));
		await processInput.press('Enter');
		await expect(pane.getByRole('status')).toHaveText('Ash App Server (Attach): running', { timeout: 60_000 });
		await expect(pane.locator('.ash-debug-breakpoints').getByRole('listitem')).not.toHaveClass(/unverified/, { timeout: 60_000 });
		const targetWorkbench = new Workbench(target);
		await command(targetWorkbench, 'workbench.action.findInFiles');
		await expect(targetWorkbench.search.element).toBeVisible();
		await targetWorkbench.search.query.fill('');
		await targetWorkbench.search.query.press('Enter');
		await targetWorkbench.search.query.fill('AshApplicationName');
		await targetWorkbench.search.query.press('Enter');
		await expect(pane.locator('.ash-debug-frame.selected')).toContainText('search.rs:', { timeout: 120_000 });
		await expect(pane.locator('.ash-debug-variables')).toContainText('params');
		await page.screenshot({ path: info.outputPath('rust-breakpoint.png') });
		await pane.getByRole('button', { name: 'Remove breakpoint', exact: true }).click();
		await command(workbench, 'workbench.action.debug.continue');
		// A deliberately paused backend may expire an ordinary RPC. Its owning
		// window reconnects after resume; submit a fresh search on that connection.
		await expect(target.getByText('Reconnecting to the Agent Host…', { exact: true })).toBeHidden({ timeout: 60_000 });
		await targetWorkbench.search.query.press('Enter');
		await expect(targetWorkbench.search.files.first()).toBeVisible({ timeout: 30_000 });
		await command(workbench, 'workbench.action.debug.stopAll');
		// Stopping attach must leave the target profile's service under its daemon owner.
		expect(() => process.kill(status.pid, 0)).not.toThrow();
	} catch (error) {
		failed = true;
		await info.attach('debug-state-before-cleanup', { body: await page.locator('body').innerText(), contentType: 'text/plain' });
		if (browser) for (const target of browser.contexts()[0]!.pages()) {
			await info.attach('native-target-before-cleanup', { body: await target.locator('body').innerText(), contentType: 'text/plain' });
		}
		throw error;
	} finally {
		await finish(workbench, info, failed, browser);
	}
});

for (const [name, executable] of [
	['Chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
	['Edge', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
]) test(`Ash self hosts its Web frontend in ${name} with TypeScript source breakpoints`, { tag: ['@electron-app-server', '@darwin'] }, async ({ workbench }, info) => {
	test.skip(!existsSync(executable!), `${name} must be installed for its real-browser acceptance`);
	test.setTimeout(240_000);
	const page = workbench.page;
	const pane = page.locator('[data-view-container-id="ash.debug"]');
	let failed = false;
	try {
		await breakpoint(workbench, 'src/ash/code/browser/workbench/workbench.ts', 'showPartsSplash(document, readBrowserPartsSplash(window));');
		await start(workbench, `Ash Web (${name})`);
		await expect(pane.locator('.ash-debug-frame.selected')).toContainText('workbench.ts:', { timeout: 120_000 });
		await expandScope(workbench, 'Module');
		await expect(pane.locator('.ash-debug-variables')).toContainText('readBrowserPartsSplash');
		await page.screenshot({ path: info.outputPath(`${name.toLowerCase()}-breakpoint.png`) });
		await pane.getByRole('button', { name: 'Remove breakpoint', exact: true }).click();
		await command(workbench, 'workbench.action.debug.continue');
		await command(workbench, 'workbench.debug.action.focusRepl');
		const input = page.getByRole('textbox', { name: 'Debug Console expression', exact: true });
		await input.focus();
		await page.keyboard.insertText('await new Promise((resolve, reject) => { const ready = () => document.querySelector(".ash-workbench") ? resolve(true) : document.querySelector("h1[role=alert]") ? reject(new Error(document.querySelector("textarea").value)) : setTimeout(ready, 50); ready(); })');
		await input.press('Enter');
		await expect(page.getByRole('log', { name: 'Debug Console output', exact: true })).toContainText('true', { timeout: 60_000 });
		await command(workbench, 'workbench.action.debug.stopAll');
		await expect(pane.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
		await expect.poll(async () => fetch('http://127.0.0.1:5184').then(() => true, () => false)).toBe(false);
	} catch (error) {
		failed = true;
		await info.attach('debug-state-before-cleanup', { body: await page.locator('body').innerText(), contentType: 'text/plain' });
		throw error;
	} finally {
		await finish(workbench, info, failed);
	}
});
