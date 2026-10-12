import { _electron } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test } from '../../../automation/test.js';
import { resolveElectronConfiguration } from '../../../automation/electron.js';
import { installMainChannelTestClient } from '../../../automation/mainProcessIpc.js';
import type { SystemInfo } from '../../../../src/ash/platform/diagnostics/common/diagnostics.js';

interface GpuScenario {
	read(): Promise<Record<string, string>>;
	readonly exits: { reason: string; status: Record<string, string>; }[];
}

const desktop = resolve(import.meta.dirname, '../../../..');
const mainOutput = join(desktop, '.build/desktop/main/src');

for (const mode of ['hardware', 'software'] as const) {
	test(`Desktop GPU diagnostics follow the real process in ${mode} mode`, async ({ target }, testInfo) => {
		test.skip(target.kind !== 'electron' || target.appServerMode !== 'disabled', 'Requires the Electron UI project.');
		const configuration = resolveElectronConfiguration({ appServerMode: 'disabled', userDataDirectory: testInfo.outputPath('user-data') });
		const entry = testInfo.outputPath('gpu-process.mjs');
		await writeFile(entry, `
import { app } from 'electron/main';
import { bootstrapElectronMain } from ${JSON.stringify(pathToFileURL(join(mainOutput, 'bootstrap.js')).href)};
bootstrapElectronMain();
app.setAppPath(${JSON.stringify(desktop)});
const { Server } = await import(${JSON.stringify(pathToFileURL(join(mainOutput, 'ash/base/parts/ipc/electron-main/ipc.electron.js')).href)});
const scenario = globalThis.gpuScenario = { exits: [] };
const register = Server.prototype.registerChannel;
Server.prototype.registerChannel = function(name, channel) {
	if (name === 'process') {
		scenario.read = async () => (await channel.call('gpu-test', 'getSystemInfo', [])).gpuStatus;
		// The production GPU monitor was subscribed before this channel was registered.
		app.on('child-process-gone', (_event, details) => {
			if (details.type === 'GPU') {
				void scenario.read().then(status => scenario.exits.push({ reason: details.reason, status }));
			}
		});
	}
	return register.call(this, name, channel);
};
const { startElectronApplication } = await import(${JSON.stringify(pathToFileURL(join(mainOutput, 'ash/code/electron-main/main.js')).href)});
await startElectronApplication();
`);
		const args = configuration.args
			.filter(argument => argument !== '--in-process-gpu' && (mode === 'software' || argument !== '--disable-gpu'))
			.map(argument => argument === desktop ? entry : argument);
		const application = await _electron.launch({ executablePath: configuration.executablePath, args, cwd: configuration.cwd, env: configuration.env });
		try {
			const page = await application.firstWindow();
			await page.waitForFunction(() => document.readyState === 'complete');
			await installMainChannelTestClient(page);
			const readFromRenderer = () => page.evaluate(async () => (await globalThis.ashTestMainProcess.call<SystemInfo>('process', 'getSystemInfo', [])).gpuStatus);
			const snapshot = () => application.evaluate(async ({ app }) => {
				const status = await (globalThis as unknown as { gpuScenario: GpuScenario; }).gpuScenario.read();
				return { initialized: typeof status.gpu_compositing === 'string', consistent: JSON.stringify(status) === JSON.stringify(app.getGPUFeatureStatus()) };
			});
			await expect.poll(snapshot).toEqual({ initialized: true, consistent: true });
			expect(await readFromRenderer()).toEqual(await application.evaluate(({ app }) => app.getGPUFeatureStatus()));
			if (mode === 'software') {
				const status = await application.evaluate(() => (globalThis as unknown as { gpuScenario: GpuScenario; }).gpuScenario.read());
				expect(status.gpu_compositing).not.toBe('enabled');
				return;
			}
			for (let crash = 1; crash <= 3; crash++) {
				await application.evaluate(async ({ BrowserWindow }) => {
					const contents = BrowserWindow.getAllWindows()[0]!.webContents;
					contents.debugger.attach('1.3');
					try { await contents.debugger.sendCommand('Browser.crashGpuProcess'); }
					finally { contents.debugger.detach(); }
				});
				await expect.poll(() => application.evaluate(() => (globalThis as unknown as { gpuScenario: GpuScenario; }).gpuScenario.exits)).toEqual(
					Array.from({ length: crash }, () => ({ reason: 'crashed', status: {} })),
				);
				await expect.poll(snapshot).toEqual({ initialized: true, consistent: true });
				expect(await readFromRenderer()).toEqual(await application.evaluate(({ app }) => app.getGPUFeatureStatus()));
				if (crash === 1) {
					await page.reload();
					await page.waitForFunction(() => document.readyState === 'complete');
					await installMainChannelTestClient(page);
					expect(await readFromRenderer()).toEqual(await application.evaluate(({ app }) => app.getGPUFeatureStatus()));
				}
			}
		} finally {
			await application.evaluate(({ BrowserWindow }) => {
				for (const window of BrowserWindow.getAllWindows()) window.destroy();
			});
			await application.close();
		}
	});
}
