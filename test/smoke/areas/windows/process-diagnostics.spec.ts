import { _electron } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test } from '../../../automation/test.js';
import { resolveElectronConfiguration } from '../../../automation/electron.js';
import { installMainChannelTestClient } from '../../../automation/mainProcessIpc.js';
import { Workbench } from '../../../automation/workbench.js';
import type { SystemInfo } from '../../../../src/ash/platform/diagnostics/common/diagnostics.js';

interface CpuScenario {
	mode: 'native' | 'held' | 'sample' | 'empty' | 'error' | 'exit' | 'invalid' | 'constructionError';
	speed: number;
	readonly control: SharedArrayBuffer;
	readonly started: number;
	readonly exited: number;
	readonly mainReads: number;
}

const desktop = resolve(import.meta.dirname, '../../../..');
const mainOutput = join(desktop, '.build/desktop/main/src');

test('Desktop CPU diagnostics stay responsive, share concurrent reads and recover after collection failures', async ({ target }, testInfo) => {
	test.skip(target.kind !== 'electron' || target.appServerMode !== 'disabled', 'Requires the Electron UI project.');
	const entry = testInfo.outputPath('cpu-diagnostics.mjs');
	await writeFile(entry, `
import { app } from 'electron/main';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { bootstrapElectronMain } from ${JSON.stringify(pathToFileURL(join(mainOutput, 'bootstrap.js')).href)};
bootstrapElectronMain();
app.setAppPath(${JSON.stringify(desktop)});
const require = createRequire(import.meta.url);
const threads = require('node:worker_threads');
const OriginalWorker = threads.Worker;
const os = require('node:os');
const originalCpus = os.cpus;
const scenario = globalThis.cpuScenario = {
	mode: 'native', speed: 1000, control: new SharedArrayBuffer(8), started: 0, exited: 0, mainReads: 0,
};
// Exercise real Workers while controlling only their operating-system input.
// Any synchronous fallback in Main fails immediately rather than hanging the test.
os.cpus = () => { scenario.mainReads++; throw new Error('CPU enumeration reached the main thread'); };
threads.Worker = class extends OriginalWorker {
	constructor(source, options) {
		if (options?.name !== 'ash-cpu-diagnostics') { super(source, options); return; }
		scenario.started++;
		if (scenario.mode === 'constructionError') throw new Error('Deliberate Worker construction failure');
		const prefix = ${JSON.stringify(`
const { workerData } = require('node:worker_threads');
if (workerData.mode === 'error') throw new Error('Deliberate CPU collection failure');
if (workerData.mode === 'exit') process.exit(0);
if (workerData.mode !== 'native') {
	require('node:os').cpus = () => {
		if (workerData.mode === 'held') {
			const control = new Int32Array(workerData.control);
			Atomics.store(control, 0, 1);
			Atomics.wait(control, 1, 0);
		}
		return workerData.mode === 'empty' ? [] : [
			{ model: 'Diagnostic CPU', speed: workerData.speed },
			{ model: 'Diagnostic CPU', speed: workerData.speed },
		];
	};
}
`)};
		const body = scenario.mode === 'invalid'
			? "require('node:worker_threads').parentPort.postMessage({ invalid: true });"
			: source;
		super(prefix + body, { ...options, workerData: { mode: scenario.mode, speed: scenario.speed, control: scenario.control } });
		this.once('exit', () => { scenario.exited++; });
	}
};
syncBuiltinESMExports();
app.once('will-quit', () => {
	os.cpus = originalCpus;
	threads.Worker = OriginalWorker;
	syncBuiltinESMExports();
});
const { startElectronApplication } = await import(${JSON.stringify(pathToFileURL(join(mainOutput, 'ash/code/electron-main/main.js')).href)});
startElectronApplication();
`);
	const configuration = resolveElectronConfiguration({ appServerMode: 'disabled', userDataDirectory: testInfo.outputPath('user-data') });
	const application = await _electron.launch({
		executablePath: configuration.executablePath, args: configuration.args.map(argument => argument === desktop ? entry : argument),
		cwd: configuration.cwd, env: configuration.env, chromiumSandbox: process.platform === 'linux' ? true : undefined,
	});
	try {
		const page = await application.firstWindow();
		await new Workbench(page).waitForReady();
		await installMainChannelTestClient(page);
		const read = () => page.evaluate(() => globalThis.ashTestMainProcess.call<SystemInfo>('process', 'getSystemInfo', []));
		const native = await read();
		expect(native.cpus).toMatch(/.+ \(\d+ × \d+ MHz\)/u);
		expect(native.os).not.toBe('');
		expect(native.memory).not.toBe('');
		await application.evaluate(() => {
			const scenario = (globalThis as unknown as { cpuScenario: CpuScenario; }).cpuScenario;
			scenario.mode = 'held';
		});
		await page.evaluate(() => {
			const pending = globalThis as unknown as { cpuRead: Promise<SystemInfo[]>; cpuReadComplete: boolean; };
			pending.cpuReadComplete = false;
			pending.cpuRead = Promise.all([
				globalThis.ashTestMainProcess.call<SystemInfo>('process', 'getSystemInfo', []),
				globalThis.ashTestMainProcess.call<SystemInfo>('process', 'getSystemInfo', []),
			]).then(results => { pending.cpuReadComplete = true; return results; });
		});
		// The gate is released through Main itself, proving it can respond while cpus() waits.
		await expect.poll(() => application.evaluate(() => {
			const scenario = (globalThis as unknown as { cpuScenario: CpuScenario; }).cpuScenario;
			return { waiting: Atomics.load(new Int32Array(scenario.control), 0), started: scenario.started };
		})).toEqual({ waiting: 1, started: 2 });
		expect(await page.evaluate(() => (globalThis as unknown as { cpuReadComplete: boolean; }).cpuReadComplete)).toBe(false);
		await application.evaluate(() => {
			const control = new Int32Array((globalThis as unknown as { cpuScenario: CpuScenario; }).cpuScenario.control);
			Atomics.store(control, 1, 1);
			Atomics.notify(control, 1);
		});
		const concurrent = await page.evaluate(() => (globalThis as unknown as { cpuRead: Promise<SystemInfo[]>; }).cpuRead);
		expect(concurrent.map(info => info.cpus)).toEqual(['Diagnostic CPU (2 × 1000 MHz)', 'Diagnostic CPU (2 × 1000 MHz)']);
		await application.evaluate(() => {
			const scenario = (globalThis as unknown as { cpuScenario: CpuScenario; }).cpuScenario;
			scenario.mode = 'sample';
			scenario.speed = 2000;
		});
		expect((await read()).cpus).toBe('Diagnostic CPU (2 × 2000 MHz)');
		for (const mode of ['empty', 'error', 'exit', 'invalid', 'constructionError'] as const) {
			await application.evaluate((_electron, mode) => { (globalThis as unknown as { cpuScenario: CpuScenario; }).cpuScenario.mode = mode; }, mode);
			const unavailable = await read();
			expect(unavailable.cpus, mode).toBeUndefined();
			expect(unavailable.os, mode).toBe(native.os);
			expect(unavailable.memory, mode).not.toBe('');
			expect(unavailable.gpuStatus, mode).toEqual(expect.any(Object));
		}
		await application.evaluate(() => { (globalThis as unknown as { cpuScenario: CpuScenario; }).cpuScenario.mode = 'sample'; });
		expect((await read()).cpus).toBe('Diagnostic CPU (2 × 2000 MHz)');
		await expect.poll(() => application.evaluate(() => {
			const { started, exited, mainReads } = (globalThis as unknown as { cpuScenario: CpuScenario; }).cpuScenario;
			return { started, exited, mainReads };
		})).toEqual({ started: 9, exited: 8, mainReads: 0 });
	} finally {
		try {
			await application.evaluate(({ BrowserWindow }) => {
				const control = new Int32Array((globalThis as unknown as { cpuScenario: CpuScenario; }).cpuScenario.control);
				Atomics.store(control, 1, 1);
				Atomics.notify(control, 1);
				for (const window of BrowserWindow.getAllWindows()) { window.destroy(); }
			});
		} finally {
			await application.close();
		}
	}
});
