import { _electron, chromium, expect, test } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveElectronConfiguration, type ElectronConfiguration } from '../../../automation/electron.js';
import { Workbench } from '../../../automation/workbench.js';

const desktop = resolve(import.meta.dirname, '../../../..');
const mainOutput = resolve(desktop, '../.build/app-ts/main/src');

test.beforeEach(({}, testInfo) => {
	test.skip(testInfo.project.name !== 'electron-ui', 'Bootstrap scenarios exercise the Electron host without a backend.');
});

test('Desktop starts when its application entry loads after Electron is ready', async ({}, testInfo) => {
	const userDataDirectory = testInfo.outputPath('user-data');
	await mkdir(userDataDirectory, { recursive: true });
	const configuration = resolveElectronConfiguration({ appServerMode: 'disabled', userDataDirectory });
	const entry = testInfo.outputPath('late-start.mjs');
	await writeFile(entry, `
import { app, Tray } from 'electron/main';
import { bootstrapElectronMain } from ${JSON.stringify(pathToFileURL(join(mainOutput, 'bootstrap.js')).href)};
bootstrapElectronMain();
app.setAppPath(${JSON.stringify(desktop)});
const setToolTip = Tray.prototype.setToolTip;
Tray.prototype.setToolTip = function(text) {
	globalThis.__ashTray = this;
	globalThis.__ashTrayTooltip = text;
	setToolTip.call(this, text);
};
void app.whenReady().then(async () => {
	const { startElectronApplication } = await import(${JSON.stringify(pathToFileURL(join(mainOutput, 'ash/code/electron-main/startElectronApplication.js')).href)});
	startElectronApplication({ initialModeId: 'code' });
});
`);
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
			if (process.platform === 'darwin') {
				await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
				await expect.poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(0);
				await application.evaluate(() => (globalThis as typeof globalThis & { __ashTray: { emit(event: string): void } }).__ashTray.emit('click'));
				await expect.poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
			}
		}
	} finally {
		await application.close();
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
			const visible = await new Promise<boolean>((resolveResult, reject) => {
				const timer = setTimeout(() => reject(new Error('Electron visibility check timed out')), 5_000);
				socket.onmessage = event => {
					const response = JSON.parse(String(event.data)) as { id?: number; result?: { result?: { value?: boolean } } };
					if (response.id !== 1) { return; }
					clearTimeout(timer);
					resolveResult(response.result?.result?.value === true);
				};
				socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: "process.mainModule.require('electron').BrowserWindow.getAllWindows()[0].isVisible()", returnByValue: true } }));
			});
			expect(visible).toBe(true);
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
