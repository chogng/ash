import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test } from '../../../automation/test.js';
import { launchElectronApplication } from '../../../automation/playwrightElectron.js';
import { installMainChannelTestClient } from '../../../automation/mainProcessIpc.js';
import type { SystemInfo } from '../../../../src/ash/platform/diagnostics/common/diagnostics.js';

interface GpuScenario {
	read(): Promise<Record<string, string>>;
	readonly exits: { reason: string; status: Record<string, string> }[];
}

const desktop = resolve(import.meta.dirname, '../../../..');
const mainOutput = join(desktop, '.build/desktop/main/src');

for (const mode of ['hardware', 'software'] as const) {
	test(`Desktop GPU diagnostics follow the real process in ${mode} mode`, async ({ target }, testInfo) => {
		test.skip(target.kind !== 'electron' || target.appServerMode !== 'disabled', 'Requires the Electron UI project.');
		const fixture = testInfo.outputPath('gpu-process-app');
		await mkdir(join(fixture, 'test/automation'), { recursive: true });
		await copyFile(join(desktop, 'test/automation/electronWindow.cjs'), join(fixture, 'test/automation/electronWindow.cjs'));
		await writeFile(join(fixture, 'package.json'), JSON.stringify({ name: 'ash-gpu-test', main: 'main.mjs' }));
		const rendererEntry = join(fixture, 'gpu.html');
		await writeFile(rendererEntry, '<!doctype html><html lang="en"><title>GPU lifecycle test</title><body>GPU lifecycle test</body></html>');
		const entry = join(fixture, 'main.mjs');
		await writeFile(
			entry,
			`
import { app, BrowserWindow } from 'electron/main';
import { bootstrapElectronMain } from ${JSON.stringify(pathToFileURL(join(mainOutput, 'bootstrap.js')).href)};
bootstrapElectronMain();
app.setAppPath(${JSON.stringify(desktop)});
app.commandLine.removeSwitch('in-process-gpu');
if (${JSON.stringify(mode)} === 'hardware') app.commandLine.removeSwitch('disable-gpu');
const { Server } = await import(${JSON.stringify(pathToFileURL(join(mainOutput, 'ash/base/parts/ipc/electron-main/ipc.electron.js')).href)});
const { GPUProcessMainService, IGPUProcessMainService } = await import(${JSON.stringify(pathToFileURL(join(mainOutput, 'ash/platform/gpu/electron-main/gpuProcessMainService.js')).href)});
const { ProcessMainService } = await import(${JSON.stringify(pathToFileURL(join(mainOutput, 'ash/platform/process/electron-main/processMainService.js')).href)});
const { InstantiationService } = await import(${JSON.stringify(pathToFileURL(join(mainOutput, 'ash/platform/instantiation/common/instantiationService.js')).href)});
const { ServiceCollection } = await import(${JSON.stringify(pathToFileURL(join(mainOutput, 'ash/platform/instantiation/common/serviceCollection.js')).href)});
const { SyncDescriptor } = await import(${JSON.stringify(pathToFileURL(join(mainOutput, 'ash/platform/instantiation/common/descriptors.js')).href)});
const { ProxyChannel } = await import(${JSON.stringify(pathToFileURL(join(mainOutput, 'ash/base/parts/ipc/common/ipc.js')).href)});
const { DisposableStore, toDisposable } = await import(${JSON.stringify(pathToFileURL(join(mainOutput, 'ash/base/common/lifecycle.js')).href)});
const resources = new DisposableStore();
const services = resources.add(new InstantiationService(new ServiceCollection([IGPUProcessMainService, new SyncDescriptor(GPUProcessMainService, [app])])));
services.get(IGPUProcessMainService);
const server = resources.add(new Server());
const channel = ProxyChannel.fromService(services.createInstance(ProcessMainService), resources);
server.registerChannel('process', channel);
const scenario = globalThis.gpuScenario = { exits: [], read: async () => (await channel.call('gpu-test', 'getSystemInfo', [])).gpuStatus };
const onExit = (_event, details) => {
	if (details.type === 'GPU') void scenario.read().then(status => scenario.exits.push({ reason: details.reason, status }));
};
app.on('child-process-gone', onExit);
resources.add(toDisposable(() => app.removeListener('child-process-gone', onExit)));
app.once('will-quit', () => resources.dispose());
void app.whenReady().then(async () => {
const window = new BrowserWindow({ show: false, webPreferences: {
	contextIsolation: true, nodeIntegration: false, sandbox: true,
	preload: ${JSON.stringify(join(desktop, '.build/desktop/preload/src/ash/base/parts/sandbox/electron-browser/preload.cjs'))},
} });
const entryUrl = ${JSON.stringify(pathToFileURL(rendererEntry).href)};
resources.add(server.registerClient(window.webContents, 'gpu-test', new Set([entryUrl])));
await window.loadURL(entryUrl);
});
`,
		);
		const { application, close } = await launchElectronApplication({
			appServerMode: 'disabled',
			userDataDirectory: testInfo.outputPath('user-data'),
			desktopDirectory: fixture,
		});
		try {
			const page = await application.firstWindow();
			await page.waitForFunction(() => Boolean((globalThis as unknown as { ash?: { ipcRenderer?: unknown } }).ash?.ipcRenderer));
			await installMainChannelTestClient(page);
			await page.evaluate(() => (globalThis as unknown as { ash: { ipcRenderer: { send(channel: string): void } } }).ash.ipcRenderer.send('ash:hello'));
			const readFromRenderer = () => page.evaluate(async () => (await globalThis.ashTestMainProcess.call<SystemInfo>('process', 'getSystemInfo', [])).gpuStatus);
			const snapshot = () =>
				application.evaluate(async ({ app }) => {
					const status = await (globalThis as unknown as { gpuScenario: GpuScenario }).gpuScenario.read();
					return {
						initialized: typeof status.gpu_compositing === 'string',
						consistent: JSON.stringify(status) === JSON.stringify(app.getGPUFeatureStatus()),
					};
				});
			await expect.poll(snapshot).toEqual({ initialized: true, consistent: true });
			expect(await readFromRenderer()).toEqual(await application.evaluate(({ app }) => app.getGPUFeatureStatus()));
			if (mode === 'software') {
				const status = await application.evaluate(() => (globalThis as unknown as { gpuScenario: GpuScenario }).gpuScenario.read());
				expect(status.gpu_compositing).not.toBe('enabled');
				return;
			}
			for (let crash = 1; crash <= 3; crash++) {
				await application.evaluate(async ({ BrowserWindow }) => {
					const contents = BrowserWindow.getAllWindows()[0]!.webContents;
					contents.debugger.attach('1.3');
					try {
						await contents.debugger.sendCommand('Browser.crashGpuProcess');
					} finally {
						contents.debugger.detach();
					}
				});
				await expect
					.poll(() => application.evaluate(() => (globalThis as unknown as { gpuScenario: GpuScenario }).gpuScenario.exits))
					.toEqual(Array.from({ length: crash }, () => ({ reason: 'crashed', status: {} })));
				await expect.poll(snapshot).toEqual({ initialized: true, consistent: true });
				expect(await readFromRenderer()).toEqual(await application.evaluate(({ app }) => app.getGPUFeatureStatus()));
				if (crash === 1) {
					await page.reload({ waitUntil: 'commit' });
					await page.waitForFunction(() => Boolean((globalThis as unknown as { ash?: { ipcRenderer?: unknown } }).ash?.ipcRenderer));
					await installMainChannelTestClient(page);
					await page.evaluate(() => (globalThis as unknown as { ash: { ipcRenderer: { send(channel: string): void } } }).ash.ipcRenderer.send('ash:hello'));
					expect(await readFromRenderer()).toEqual(await application.evaluate(({ app }) => app.getGPUFeatureStatus()));
				}
			}
		} finally {
			await close();
		}
	});
}
