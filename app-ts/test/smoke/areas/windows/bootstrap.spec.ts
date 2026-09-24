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
import { app } from 'electron/main';
import { bootstrapElectronMain } from ${JSON.stringify(pathToFileURL(join(mainOutput, 'bootstrap.js')).href)};
bootstrapElectronMain();
app.setAppPath(${JSON.stringify(desktop)});
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
		await expect(page.getByText('ASH CODE', { exact: true })).toBeVisible();
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
