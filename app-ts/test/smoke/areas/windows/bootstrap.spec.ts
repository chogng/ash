import { _electron, chromium, expect, test, type TestInfo } from '@playwright/test';
import type { Menu, Tray } from 'electron';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveElectronConfiguration, type ElectronConfiguration } from '../../../automation/electron.js';
import { Workbench } from '../../../automation/workbench.js';
import { URI } from '../../../../src/ash/base/common/uri.js';

const desktop = resolve(import.meta.dirname, '../../../..');
const mainOutput = resolve(desktop, '../.build/app-ts/main/src');

interface ShellProbe {
	__ashTray: Tray;
	__ashTrayMenu: Menu;
	__ashTrayTooltip: string;
	__ashQuitVetoCount: number;
}

async function writeShellEntry(testInfo: TestInfo): Promise<string> {
	const entry = testInfo.outputPath('late-start.mjs');
	await writeFile(entry, `
import { app, Tray } from 'electron/main';
import { writeFileSync } from 'node:fs';
import { bootstrapElectronMain } from ${JSON.stringify(pathToFileURL(join(mainOutput, 'bootstrap.js')).href)};
bootstrapElectronMain();
app.setAppPath(${JSON.stringify(desktop)});
const setToolTip = Tray.prototype.setToolTip;
Tray.prototype.setToolTip = function(text) {
	globalThis.__ashTray = this;
	globalThis.__ashTrayTooltip = text;
	setToolTip.call(this, text);
};
const setContextMenu = Tray.prototype.setContextMenu;
Tray.prototype.setContextMenu = function(menu) {
	globalThis.__ashTrayMenu = menu;
	setContextMenu.call(this, menu);
};
app.on('quit', () => writeFileSync(${JSON.stringify(testInfo.outputPath('tray-cleanup.json'))}, JSON.stringify({ destroyed: globalThis.__ashTray.isDestroyed() })));
void app.whenReady().then(async () => {
	const { startElectronApplication } = await import(${JSON.stringify(pathToFileURL(join(mainOutput, 'ash/code/electron-main/main.js')).href)});
	startElectronApplication({ initialModeId: 'code' });
});
`);
	return entry;
}

test.beforeEach(({}, testInfo) => {
	test.skip(testInfo.project.name !== 'electron-ui', 'Bootstrap scenarios exercise the Electron host without a backend.');
});

for (const scenario of [
	{ name: 'missing settings', settings: undefined, mode: 'code' },
	{ name: 'retired Academic JSONC mode migration', settings: '{\n// startup mode\n"workbench.mode":"academic",\n}', mode: 'code' },
	{ name: 'unregistered mode', settings: '{"workbench.mode":"unknown"}', mode: 'code' },
	{ name: 'obsolete settings wrapper', settings: '{"version":1,"values":{"workbench.mode":"academic"}}', mode: 'code' },
]) {
	test(`Desktop startup selects its mode from ${scenario.name}`, async ({}, testInfo) => {
		const userDataDirectory = testInfo.outputPath('user-data');
		const profile = join(userDataDirectory, 'profile');
		await mkdir(profile, { recursive: true });
		if (scenario.settings !== undefined) await writeFile(join(profile, 'settings.json'), scenario.settings);
		const configuration = resolveElectronConfiguration({ appServerMode: 'disabled', userDataDirectory });
		const environment = { ...configuration.env };
		delete environment.ASH_WORKBENCH_MODE;
		const application = await _electron.launch({ executablePath: configuration.executablePath, args: [...configuration.args], cwd: configuration.cwd, env: environment });
		try {
			const page = await application.firstWindow();
			await expect(page.locator('.ash-workbench')).toBeVisible();
			expect(new URL(page.url()).searchParams.get('ash-workbench-mode')).toBe(scenario.mode);
			if (scenario.name === 'retired Academic JSONC mode migration') {
				const source = await readFile(join(profile, 'settings.json'), 'utf8');
				expect(source).toContain('// startup mode');
				expect(source).toContain('"code"');
				expect(source).not.toContain('"academic"');
			}
		} finally {
			await application.close();
		}
	});
}

for (const hasWorkbench of [false, true]) {
	test(`packaged startup rejects an incomplete renderer with Workbench ${hasWorkbench ? 'present' : 'missing'}`, async ({}, testInfo) => {
		const packagedRoot = testInfo.outputPath('package');
		await mkdir(packagedRoot, { recursive: true });
		if (hasWorkbench) {
			const workbenchRoot = join(packagedRoot, 'dist', 'renderer', 'ash', 'electron-browser', 'workbench');
			await mkdir(workbenchRoot, { recursive: true });
			await writeFile(join(workbenchRoot, 'workbench.html'), '<!doctype html>');
		}
		const entry = testInfo.outputPath('packaged-start.mjs');
		await writeFile(entry, `
import { app } from 'electron/main';
import { bootstrapElectronMain } from ${JSON.stringify(pathToFileURL(join(mainOutput, 'bootstrap.js')).href)};
bootstrapElectronMain();
app.setAppPath(${JSON.stringify(packagedRoot)});
Object.defineProperty(app, 'isPackaged', { value: true });
try {
	const { startElectronApplication } = await import(${JSON.stringify(pathToFileURL(join(mainOutput, 'ash/code/electron-main/main.js')).href)});
	await startElectronApplication({ initialModeId: 'code' });
} catch (error) {
	console.error(error);
	app.exit(1);
}
`);
		const configuration = resolveElectronConfiguration({ appServerMode: 'disabled', userDataDirectory: testInfo.outputPath('user-data') });
		const result = await runUntilExit({ ...configuration, args: configuration.args.map(argument => argument === desktop ? entry : argument) });
		expect(result.code).toBe(1);
		expect(result.output).toContain('Packaged Ash renderer is incomplete');
		expect(result.output).toContain(hasWorkbench ? 'sessions-code.html' : 'workbench.html');
	});
}

test('Desktop starts when its application entry loads after Electron is ready', async ({}, testInfo) => {
	const userDataDirectory = testInfo.outputPath('user-data');
	await mkdir(userDataDirectory, { recursive: true });
	const configuration = resolveElectronConfiguration({ appServerMode: 'disabled', userDataDirectory });
	const entry = await writeShellEntry(testInfo);
	const application = await _electron.launch({
		executablePath: configuration.executablePath,
		args: configuration.args.map(argument => argument === desktop ? entry : argument),
		cwd: configuration.cwd,
		env: configuration.env,
	});
	try {
		const page = await application.firstWindow();
		await new Workbench(page).waitForReady();
		expect(await application.evaluate(({ app, BrowserWindow }) => ({
			ready: app.isReady(),
			windows: BrowserWindow.getAllWindows().length,
		}))).toEqual({ ready: true, windows: 1 });
		if (process.platform === 'win32' || process.platform === 'darwin') {
			await expect.poll(() => application.evaluate(() => (globalThis as typeof globalThis & ShellProbe).__ashTrayMenu?.items.map(item => item.label || item.type))).toEqual(['Show Ash', 'New Window', 'Open Agents Window', 'separator', 'Recent Folders & Workspaces', 'separator', 'Quit Ash']);
			expect(await application.evaluate(() => (globalThis as typeof globalThis & ShellProbe).__ashTrayMenu.items.find(item => item.submenu)!.submenu!.items.map(item => ({ label: item.label, enabled: item.enabled, type: item.type })))).toEqual([
				{ label: 'No Recent Projects', enabled: false, type: 'normal' },
				{ label: '', enabled: true, type: 'separator' },
				{ label: 'Clear Recently Opened', enabled: false, type: 'normal' },
			]);
			expect(await application.evaluate(() => (globalThis as typeof globalThis & { __ashTrayTooltip?: string }).__ashTrayTooltip)).toBe('Ash');
			if (process.platform === 'darwin') {
				expect(await application.evaluate(({ app }) => app.dock!.isVisible())).toBe(true);
				const menuBarIconPaths = [18, 27, 36].map(size => resolve(desktop, `../resources/tray/ash-black-${size}.png`));
				const menuBarIconSizes = await application.evaluate(({ nativeImage }, paths) => paths.map(path => nativeImage.createFromPath(path).getSize()), menuBarIconPaths);
				expect(menuBarIconSizes).toEqual([{ width: 18, height: 18 }, { width: 27, height: 27 }, { width: 36, height: 36 }]);
				const visibleMarkSize = await application.evaluate(({ nativeImage }, path) => {
					const image = nativeImage.createFromPath(path);
					const bitmap = image.toBitmap();
					const { width, height } = image.getSize();
					let left = width, top = height, right = -1, bottom = -1;
					for (let y = 0; y < height; y++) {
						for (let x = 0; x < width; x++) {
							if (bitmap[(y * width + x) * 4 + 3] <= 32) continue;
							left = Math.min(left, x);
							top = Math.min(top, y);
							right = Math.max(right, x);
							bottom = Math.max(bottom, y);
						}
					}
					return { width: right - left + 1, height: bottom - top + 1 };
				}, menuBarIconPaths[2]);
				expect(visibleMarkSize.width).toBeGreaterThanOrEqual(30);
				expect(visibleMarkSize.height).toBeGreaterThanOrEqual(30);
				const trayBounds = await application.evaluate(() => (globalThis as typeof globalThis & { __ashTray: { getBounds(): { width: number; height: number } } }).__ashTray.getBounds());
				expect(trayBounds.width).toBeGreaterThan(0);
				expect(trayBounds.height).toBeGreaterThan(0);
			}
			await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
			await expect.poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized())).toBe(true);
			await application.evaluate(() => (globalThis as typeof globalThis & { __ashTray: { emit(event: string): void } }).__ashTray.emit('click'));
			await expect.poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized())).toBe(false);
			await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
			await expect.poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized())).toBe(true);
			await application.evaluate(() => (globalThis as typeof globalThis & ShellProbe).__ashTrayMenu.items.find(item => item.label === 'Show Ash')!.click({ altKey: false }));
			await expect.poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized())).toBe(false);
			await application.evaluate(() => (globalThis as typeof globalThis & ShellProbe).__ashTrayMenu.items.find(item => item.label === 'New Window')!.click({ altKey: false }));
			await expect.poll(() => application.windows().length).toBe(2);
			await new Workbench(application.windows()[1]!).waitForReady();
			const projectPath = testInfo.outputPath('tray project with spaces');
			await mkdir(projectPath, { recursive: true });
			await page.evaluate(async folderUri => {
				await (globalThis as unknown as { ash: { ipcRenderer: { invoke(channel: string, value: unknown): Promise<unknown> } } }).ash.ipcRenderer.invoke('ash:workspaces:recent:add', { workspaces: [{ folderUri, label: 'Tray project' }] });
			}, URI.file(projectPath).toString());
			await expect.poll(() => application.evaluate(() => (globalThis as typeof globalThis & ShellProbe).__ashTrayMenu.items.find(item => item.submenu)!.submenu!.items[0]!.label)).toBe('Tray project');
			for (const window of application.windows()) await expect(window.locator('.ash-getting-started-recent-name')).toHaveText(['Tray project']);
			await application.evaluate(() => (globalThis as typeof globalThis & ShellProbe).__ashTrayMenu.items.find(item => item.submenu)!.submenu!.items[0]!.click({ altKey: false }));
			await expect.poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some(window => window.getTitle().includes('tray project with spaces')))).toBe(true);
			await application.evaluate(() => (globalThis as typeof globalThis & ShellProbe).__ashTrayMenu.items.find(item => item.submenu)!.submenu!.items.find(item => item.label === 'Clear Recently Opened')!.click({ altKey: false }));
			await expect.poll(() => application.evaluate(() => (globalThis as typeof globalThis & ShellProbe).__ashTrayMenu.items.find(item => item.submenu)!.submenu!.items[0]!.label)).toBe('No Recent Projects');
			await expect(page.locator('.ash-getting-started-recent-name')).toHaveCount(0);
			const agentsOpened = application.waitForEvent('window');
			await application.evaluate(() => (globalThis as typeof globalThis & ShellProbe).__ashTrayMenu.items.find(item => item.label === 'Open Agents Window')!.click({ altKey: false }));
			await expect((await agentsOpened).locator('.ash-sessions-window')).toBeVisible();
			await application.evaluate(() => (globalThis as typeof globalThis & ShellProbe).__ashTrayMenu.items.find(item => item.label === 'Open Agents Window')!.click({ altKey: false }));
			expect(application.windows().filter(window => window.url().includes('sessions'))).toHaveLength(1);
			if (process.platform === 'darwin') {
				await application.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.close(); });
				await expect.poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(0);
				await application.evaluate(() => (globalThis as typeof globalThis & { __ashTray: { emit(event: string): void } }).__ashTray.emit('click'));
				await expect.poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
			}
		}
	} finally {
		await application.close();
	}
});

test('tray Quit honors a window veto, keeps services usable, and restores drafts after shutdown', async ({}, testInfo) => {
	test.skip(process.platform !== 'win32' && process.platform !== 'darwin', 'The tray is available on Windows and macOS.');
	test.setTimeout(60_000);
	const userDataDirectory = testInfo.outputPath('user-data');
	await mkdir(userDataDirectory, { recursive: true });
	const configuration = resolveElectronConfiguration({ appServerMode: 'disabled', userDataDirectory });
	const entry = await writeShellEntry(testInfo);
	const options = { executablePath: configuration.executablePath, args: configuration.args.map(argument => argument === desktop ? entry : argument), cwd: configuration.cwd, env: configuration.env };
	let application = await _electron.launch(options);
	try {
		const page = await application.firstWindow();
		const workbench = new Workbench(page);
		await workbench.waitForReady();
		await page.keyboard.press('F1');
		await page.locator('.ash-quick-pick').getByRole('combobox').fill('New Untitled Text Editor');
		await page.keyboard.press('Enter');
		const input = workbench.editors.groupAt(0).content.locator('.stanza-editor-input');
		await input.focus();
		await input.type('unsaved tray draft');
		await application.evaluate(({ BrowserWindow }) => {
			const contents = BrowserWindow.getAllWindows()[0]!.webContents;
			const original = contents.send.bind(contents);
			const state = globalThis as typeof globalThis & ShellProbe;
			state.__ashQuitVetoCount = 0;
			contents.send = (channel, ...args) => {
				if (channel !== 'ash:window:prepare-close') { original(channel, ...args); return; }
				contents.send = original;
				// Simulate a renderer veto at the real close-protocol boundary, before shutdown.
				void contents.executeJavaScript(`globalThis.ash.ipcRenderer.invoke('ash:window:close-response', { kind: 'vetoed', token: ${Number(args[0])} })`).then(() => state.__ashQuitVetoCount++);
			};
		});
		await application.evaluate(() => (globalThis as typeof globalThis & ShellProbe).__ashTrayMenu.items.find(item => item.label === 'Quit Ash')!.click({ altKey: false }));
		await expect.poll(() => application.evaluate(() => (globalThis as typeof globalThis & ShellProbe).__ashQuitVetoCount)).toBe(1);
		await expect(workbench.editors.groupAt(0).content.locator('.stanza-editor-line-text').first()).toContainText('unsaved tray draft');
		await page.evaluate(async () => {
			const ipc = (globalThis as unknown as { ash: { ipcRenderer: { invoke(channel: string, value?: unknown): Promise<unknown> } } }).ash.ipcRenderer;
			const snapshot = await ipc.invoke('ash:configuration:read') as { revision: number; document: { source: string } };
			await ipc.invoke('ash:configuration:update', { expectedRevision: snapshot.revision, document: { version: 1, source: JSON.stringify({ ...JSON.parse(snapshot.document.source), 'workbench.locale': 'zh-cn' }) } });
		});
		await expect.poll(() => application.evaluate(() => (globalThis as typeof globalThis & ShellProbe).__ashTrayMenu.items.map(item => item.label || item.type))).toEqual(['显示 Ash', '新建窗口', '打开 Agents 窗口', 'separator', '最近的文件夹和工作区', 'separator', '退出 Ash']);
		await application.evaluate(() => (globalThis as typeof globalThis & ShellProbe).__ashTrayMenu.items.find(item => item.label === '新建窗口')!.click({ altKey: false }));
		await expect.poll(() => application.windows().length).toBe(2);
		await new Workbench(application.windows()[1]!).waitForReady();
		await page.evaluate(async () => {
			const ipc = (globalThis as unknown as { ash: { ipcRenderer: { invoke(channel: string, value?: unknown): Promise<unknown> } } }).ash.ipcRenderer;
			const snapshot = await ipc.invoke('ash:configuration:read') as { revision: number; document: { source: string } };
			await ipc.invoke('ash:configuration:update', { expectedRevision: snapshot.revision, document: { version: 1, source: JSON.stringify({ ...JSON.parse(snapshot.document.source), 'workbench.locale': 'en' }) } });
		});
		await expect.poll(() => application.evaluate(() => (globalThis as typeof globalThis & ShellProbe).__ashTrayMenu.items.at(-1)!.label)).toBe('Quit Ash');
		const closed = application.waitForEvent('close');
		await application.evaluate(() => { (globalThis as typeof globalThis & ShellProbe).__ashTrayMenu.items.find(item => item.label === 'Quit Ash')!.click({ altKey: false }); });
		await closed;
		expect(JSON.parse(await readFile(testInfo.outputPath('tray-cleanup.json'), 'utf8'))).toEqual({ destroyed: true });
		application = await _electron.launch(options);
		await expect.poll(() => application.windows().length).toBe(2);
		for (const restoredPage of application.windows()) await new Workbench(restoredPage).waitForReady();
		await expect(application.windows()[0]!.locator('.stanza-editor-line-text').first()).toContainText('unsaved tray draft');
	} finally {
		if (application.process().exitCode === null) await application.close();
	}
});

test('Windows development launcher shows the Workbench window', async ({}, testInfo) => {
	test.skip(process.platform !== 'win32', 'The launcher visibility regression is Windows-specific.');
	test.setTimeout(60_000);
	const userDataDirectory = testInfo.outputPath('user-data');
	await mkdir(userDataDirectory, { recursive: true });
	const configuration = resolveElectronConfiguration({ appServerMode: 'disabled', userDataDirectory });
	const portListener = createServer();
	await new Promise<void>(resolve => portListener.listen(0, '127.0.0.1', resolve));
	const address = portListener.address();
	if (!address || typeof address === 'string') { throw new Error('Could not reserve a CDP port'); }
	const port = address.port;
	await new Promise<void>(resolve => portListener.close(() => resolve()));
	const environment = { ...configuration.env };
	delete environment.NODE_OPTIONS;
	const child = spawn(process.execPath, [
		resolve(desktop, '../build/app_ts/launch/electron.ts'),
		'--inspect=0',
		`--remote-debugging-port=${port}`,
		`--user-data-dir=${userDataDirectory}`,
	], { cwd: desktop, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
	let output = '';
	child.stderr.on('data', (chunk: Buffer) => { output = (output + chunk.toString()).slice(-16_384); });
	const closed = new Promise<void>(resolveClose => child.once('close', () => resolveClose()));
	let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
	try {
		await expect.poll(() => /Debugger listening on ws:\/\/127\.0\.0\.1:\d+/u.test(output), { timeout: 15_000, message: output }).toBe(true);
		await expect.poll(async () => {
			try { return (await fetch(`http://127.0.0.1:${port}/json/version`)).ok; }
			catch { return false; }
		}, { timeout: 15_000 }).toBe(true);
		browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
		const context = browser.contexts()[0];
		await expect.poll(() => context.pages().some(page => page.url().includes('/workbench/workbench.html'))).toBe(true);
		const page = context.pages().find(page => page.url().includes('/workbench/workbench.html'))!;
		await expect(page.getByText('ASH', { exact: true })).toBeVisible();
		const inspectorPort = Number(output.match(/Debugger listening on ws:\/\/127\.0\.0\.1:(\d+)/u)![1]);
		const [target] = await (await fetch(`http://127.0.0.1:${inspectorPort}/json/list`)).json() as Array<{ webSocketDebuggerUrl: string }>;
		const socket = new WebSocket(target.webSocketDebuggerUrl);
		try {
			await new Promise<void>((resolveOpen, reject) => { socket.onopen = () => resolveOpen(); socket.onerror = reject; });
			let requestId = 0;
			const isVisible = (): Promise<boolean> => new Promise((resolveResult, reject) => {
				const id = ++requestId;
				const timer = setTimeout(() => { socket.removeEventListener('message', onMessage); reject(new Error('Electron visibility check timed out')); }, 5_000);
				const onMessage = (event: MessageEvent): void => {
					const response = JSON.parse(String(event.data)) as { id?: number; result?: { result?: { value?: boolean }; exceptionDetails?: { text: string } } };
					if (response.id !== id) return;
					clearTimeout(timer);
					socket.removeEventListener('message', onMessage);
					if (response.result?.exceptionDetails) { reject(new Error(response.result.exceptionDetails.text)); return; }
					resolveResult(response.result?.result?.value === true);
				};
				socket.addEventListener('message', onMessage);
				socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: "process.mainModule.require('electron').BrowserWindow.getAllWindows()[0].isVisible()", returnByValue: true } }));
			});
			await expect.poll(isVisible, { timeout: 10_000 }).toBe(true);
		} finally { socket.close(); }
	} finally {
		await browser?.close();
		if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); }
		await closed;
	}
});

test('Desktop exits with a failure status when entry initialization fails', async ({}, testInfo) => {
	const configuration = resolveElectronConfiguration({ appServerMode: 'disabled', userDataDirectory: testInfo.outputPath('user-data') });
	const result = await runUntilExit({ ...configuration, env: { ...configuration.env, ASH_WORKBENCH_MODE: 'invalid-mode' } });
	expect(result.code).toBe(1);
	expect(result.output).toContain('Failed to initialize Ash');
	expect(result.output).toContain('invalid-mode');
});

test('Desktop exits with a failure status when persistent services cannot start', async ({}, testInfo) => {
	const userDataDirectory = testInfo.outputPath('user-data');
	await mkdir(join(userDataDirectory, 'state.json'), { recursive: true });
	const configuration = resolveElectronConfiguration({ appServerMode: 'disabled', userDataDirectory });
	const result = await runUntilExit(configuration);
	expect(result.code).toBe(1);
	expect(result.output).toContain('Failed to start Ash');
});

async function runUntilExit(configuration: ElectronConfiguration): Promise<{ code: number | null; output: string }> {
	const child = spawn(configuration.executablePath, [...configuration.args], {
		cwd: configuration.cwd,
		env: configuration.env,
		stdio: ['ignore', 'pipe', 'pipe'],
		windowsHide: true,
	});
	let output = '';
	const collect = (chunk: Buffer): void => { output = (output + chunk.toString()).slice(-16_384); };
	child.stdout.on('data', collect);
	child.stderr.on('data', collect);
	let processError: Error | undefined;
	child.once('error', error => { processError = error; });
	const closed = new Promise<void>(resolveClose => child.once('close', () => resolveClose()));
	try {
		await expect.poll(() => {
			if (processError) { throw processError; }
			return child.exitCode;
		}, { timeout: 15_000, message: 'Startup failure must terminate the Electron process' }).not.toBeNull();
		await closed;
		return { code: child.exitCode, output };
	} finally {
		if (child.exitCode === null && child.signalCode === null) { child.kill(); }
		await closed;
	}
}
