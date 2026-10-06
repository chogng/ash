import { _electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test as baseTest } from '../../../automation/test.js';
import { resolveElectronConfiguration } from '../../../automation/electron.js';

const desktop = resolve(import.meta.dirname, '../../../..');
const mainOutput = resolve(desktop, '../.build/app-ts/main/src');

interface IpcScenario {
	readonly active: Map<string, number>;
	holdNextRead: boolean;
	waitingRead: boolean;
	cancelled: boolean;
	readReleased: boolean;
	releaseRead(): void;
}

interface IpcHarness {
	readonly application: ElectronApplication;
	readonly page: Page;
	active(): Promise<readonly [string, number][]>;
}

const test = baseTest.extend<{ ipcHarness: IpcHarness; }>({
	ipcHarness: async ({ target }, use, testInfo) => {
		baseTest.skip(target.kind !== 'electron' || target.appServerMode !== 'disabled', 'Requires the Electron UI project.');
		const directory = await mkdtemp(join(tmpdir(), 'ash-ipc-'));
		const configuration = resolveElectronConfiguration({ appServerMode: 'disabled', userDataDirectory: directory });
		const entry = testInfo.outputPath('main-process-ipc.mjs');
		await writeFile(entry, `
import { app, nativeTheme } from 'electron/main';
import { bootstrapElectronMain } from ${JSON.stringify(pathToFileURL(join(mainOutput, 'bootstrap.js')).href)};
bootstrapElectronMain();
app.setAppPath(${JSON.stringify(desktop)});
nativeTheme.themeSource = 'light';
const { Server } = await import(${JSON.stringify(pathToFileURL(join(mainOutput, 'ash/base/parts/ipc/electron-main/ipc.electron.js')).href)});
const { toDisposable } = await import(${JSON.stringify(pathToFileURL(join(mainOutput, 'ash/base/common/lifecycle.js')).href)});
const scenario = globalThis.ipcScenario = { active: new Map(), holdNextRead: false, waitingRead: false, cancelled: false, readReleased: false };
const register = Server.prototype.registerChannel;
Server.prototype.registerChannel = function(name, channel) {
	if (name !== 'colorScheme') return register.call(this, name, channel);
	return register.call(this, name, {
		async call(context, command, arg, token) {
			const result = await channel.call(context, command, arg, token);
			if (scenario.holdNextRead) {
				scenario.holdNextRead = false;
				scenario.waitingRead = true;
				const cancellation = token.onCancellationRequested(() => { scenario.cancelled = true; });
				try { await new Promise(resolve => { scenario.releaseRead = resolve; }); }
				finally { cancellation.dispose(); scenario.readReleased = true; }
			}
			return result;
		},
		listen(context, event, arg) {
			const source = channel.listen(context, event, arg);
			return listener => {
				scenario.active.set(context, (scenario.active.get(context) ?? 0) + 1);
				const subscription = source(listener);
				return toDisposable(() => {
					subscription.dispose();
					const remaining = scenario.active.get(context) - 1;
					if (remaining) scenario.active.set(context, remaining); else scenario.active.delete(context);
				});
			};
		},
	});
};
const { startElectronApplication } = await import(${JSON.stringify(pathToFileURL(join(mainOutput, 'ash/code/electron-main/main.js')).href)});
startElectronApplication();
`);
		const application = await _electron.launch({ executablePath: configuration.executablePath, args: configuration.args.map(argument => argument === desktop ? entry : argument), cwd: configuration.cwd, env: configuration.env });
		const errors: string[] = [];
		try {
			const page = await application.firstWindow();
			page.on('pageerror', error => errors.push(error.message));
			await expect(page.locator('.ash-workbench')).toBeVisible();
			await use({ application, page, active: () => application.evaluate(() => [...(globalThis as unknown as { ipcScenario: IpcScenario; }).ipcScenario.active]) });
			expect(errors).toEqual([]);
		} finally {
			await application.evaluate(({ BrowserWindow }) => {
				(globalThis as unknown as { ipcScenario: IpcScenario; }).ipcScenario.releaseRead?.();
				for (const window of BrowserWindow.getAllWindows()) { window.destroy(); }
			});
			await application.close();
			await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		}
	}
});

test('Main color subscriptions follow their own window through reload and close', async ({ ipcHarness: { application, page, active } }) => {
	const firstId = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.id);
	await expect.poll(active).toEqual([[`window:${firstId}`, 1]]);
	const opened = application.waitForEvent('window');
	await application.evaluate(({ app }) => { app.emit('second-instance', {}, [process.execPath, app.getAppPath(), '--new-window'], process.cwd(), {}); });
	const second = await opened;
	const secondId = await application.evaluate(({ BrowserWindow }, firstId) => BrowserWindow.getAllWindows().find(window => window.id !== firstId)!.id, firstId);
	await expect(second.locator('.ash-workbench')).toBeVisible();
	await expect.poll(active).toEqual([[`window:${firstId}`, 1], [`window:${secondId}`, 1]]);
	await application.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = 'dark'; });
	for (const window of [page, second]) { await expect(window.locator('.ash-workbench')).toHaveAttribute('data-color-theme', 'ash-dark'); }
	await page.reload();
	await expect(page.locator('.ash-workbench')).toHaveAttribute('data-color-theme', 'ash-dark');
	await expect.poll(async () => [...await active()].sort()).toEqual([[`window:${firstId}`, 1], [`window:${secondId}`, 1]].sort());
	await application.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = 'light'; });
	for (const window of [page, second]) { await expect(window.locator('.ash-workbench')).toHaveAttribute('data-color-theme', 'ash-light'); }
	await application.evaluate(({ BrowserWindow }, id) => { BrowserWindow.fromId(id)!.destroy(); }, firstId);
	await expect.poll(active).toEqual([[`window:${secondId}`, 1]]);
	await application.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = 'dark'; });
	await expect(second.locator('.ash-workbench')).toHaveAttribute('data-color-theme', 'ash-dark');
});

test('reload cancels a pending Main call and an old reply cannot overwrite the new document', async ({ ipcHarness: { application, page, active } }) => {
	await application.evaluate(() => { (globalThis as unknown as { ipcScenario: IpcScenario; }).ipcScenario.holdNextRead = true; });
	await page.reload();
	await expect.poll(() => application.evaluate(() => (globalThis as unknown as { ipcScenario: IpcScenario; }).ipcScenario.waitingRead)).toBe(true);
	await page.reload();
	await expect(page.locator('.ash-workbench')).toBeVisible();
	await expect.poll(() => application.evaluate(() => (globalThis as unknown as { ipcScenario: IpcScenario; }).ipcScenario.cancelled)).toBe(true);
	await application.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = 'dark'; });
	await expect(page.locator('.ash-workbench')).toHaveAttribute('data-color-theme', 'ash-dark');
	await application.evaluate(() => { (globalThis as unknown as { ipcScenario: IpcScenario; }).ipcScenario.releaseRead(); });
	await expect.poll(() => application.evaluate(() => (globalThis as unknown as { ipcScenario: IpcScenario; }).ipcScenario.readReleased)).toBe(true);
	await expect(page.locator('.ash-workbench')).toHaveAttribute('data-color-theme', 'ash-dark');
	await expect.poll(async () => (await active()).map(([, count]) => count)).toEqual([1]);
	await application.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = 'light'; });
	await expect(page.locator('.ash-workbench')).toHaveAttribute('data-color-theme', 'ash-light');
});

test('Main acquisition rejects renderer-supplied identity and removed color channels', async ({ ipcHarness: { page } }) => {
	const errors = await page.evaluate(async () => {
		const ipc = (globalThis as unknown as { ash: { ipcRenderer: { invoke(channel: string, arg?: unknown): Promise<unknown>; }; }; }).ash.ipcRenderer;
		const failures: string[] = [];
		for (const [channel, arg] of [
			['ash:ipc:connect', { nonce: crypto.randomUUID(), context: 'window:other' }],
			['ash:ipc:window-id', { id: 10 }],
			['ash:native-host:get-color-scheme', undefined],
		] as const) {
			try { await ipc.invoke(channel, arg); failures.push('accepted'); } catch (error) { failures.push((error as Error).message); }
		}
		return failures;
	});
	expect(errors[0]).toContain('Invalid Main IPC acquisition');
	expect(errors[1]).toContain('takes no arguments');
	expect(errors[2]).toContain('No handler registered');
});
