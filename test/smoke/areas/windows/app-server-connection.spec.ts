import { _electron, type ElectronApplication, type Page } from '@playwright/test';
import { expect, test as baseTest } from '../../../automation/test.js';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { resolveElectronConfiguration } from '../../../automation/electron.js';
import { readDevelopmentAppServerGeneration } from '../../../../src/ash/platform/app-server-daemon/electron-main/developmentAppServerReloader.js';
import { developmentAppServerGenerationPath } from '../../../../src/ash/platform/app-server-daemon/node/appServerDaemonPackage.js';

const desktop = resolve(import.meta.dirname, '../../../..');
const mainOutput = resolve(desktop, '.build/desktop/main/src');
const execFileAsync = promisify(execFile);

interface ConnectionScenario {
	state: string;
	acquisitions: number;
	isClosing: boolean;
	restartSettled: boolean;
	restartError?: string;
	sameStartPromise: boolean;
	waitingValidation: boolean;
	delayedAcquisitionSettled: boolean;
	delayedAcquisitionError?: string;
	waitingInitialization: boolean;
	delayedInitializationSettled: boolean;
	delayedInitializationError?: string;
	readyCount: number;
	beginRestart(): void;
	releaseClose(): void;
	holdNextValidation(): void;
	releaseValidation(): void;
	holdNextInitialization(): void;
	releaseInitialization(): void;
	stop(): Promise<void>;
	killConnection(): void;
}

interface ConnectionHarness {
	readonly application: ElectronApplication;
	readonly page: Page;
	backend(): Promise<{ pid: number; instanceId: string; }>;
}

const test = baseTest.extend<{ connectionHarness: ConnectionHarness; }>({
	connectionHarness: async ({ target }, use, testInfo) => {
		baseTest.skip(target.kind !== 'electron' || target.appServerMode !== 'required', 'Requires the Electron backend connection.');
		const directory = await mkdtemp(join(tmpdir(), 'ash-'));
		const configuration = resolveElectronConfiguration({ appServerMode: 'required', userDataDirectory: directory });
		const entry = testInfo.outputPath('connection-restart.mjs');
		await writeFile(entry, `
import { app } from 'electron/main';
import { bootstrapElectronMain } from ${JSON.stringify(pathToFileURL(join(mainOutput, 'bootstrap.js')).href)};
bootstrapElectronMain();
app.setAppPath(${JSON.stringify(desktop)});
const { AppServerConnectionRelay } = await import(${JSON.stringify(pathToFileURL(join(mainOutput, 'ash/platform/agentHost/electron-main/appServerConnectionRelay.js')).href)});
const { ChildProcessJsonlTransport } = await import(${JSON.stringify(pathToFileURL(join(mainOutput, 'ash/platform/agentHost/node/childProcessJsonlTransport.js')).href)});
const scenario = globalThis.connectionScenario = {
	acquisitions: 0,
	isClosing: false,
	restartSettled: false,
	sameStartPromise: false,
	waitingValidation: false,
	delayedAcquisitionSettled: false,
	waitingInitialization: false,
	delayedInitializationSettled: false,
	readyCount: 0,
};
let closingTransport;
let closeBarrier;
let validationBarrier;
let holdValidation = false;
let initializationBarrier;
let holdInitialization = false;
const close = ChildProcessJsonlTransport.prototype.close;
ChildProcessJsonlTransport.prototype.close = function() {
	const completion = close.call(this);
	if (this !== closingTransport) return completion;
	scenario.isClosing = true;
	return completion.then(() => closeBarrier);
};
const routes = AppServerConnectionRelay.prototype.routes;
AppServerConnectionRelay.prototype.routes = function(...args) {
	const relay = this;
	const launcher = relay.options.processLauncher;
	const validate = launcher.validate.bind(launcher);
	launcher.validate = async () => {
		if (holdValidation) {
			holdValidation = false;
			scenario.waitingValidation = true;
			await validationBarrier;
		}
		await validate();
	};
	const initialized = launcher.didInitialize?.bind(launcher);
	launcher.didInitialize = async () => {
		if (holdInitialization) {
			holdInitialization = false;
			scenario.waitingInitialization = true;
			await initializationBarrier;
		}
		await initialized?.();
	};
	scenario.holdNextValidation = () => { holdValidation = true; validationBarrier = new Promise(resolve => { scenario.releaseValidation = resolve; }); };
	scenario.holdNextInitialization = () => { holdInitialization = true; initializationBarrier = new Promise(resolve => { scenario.releaseInitialization = resolve; }); };
	scenario.stop = () => relay.stop();
	scenario.killConnection = () => relay.transport.value.process.kill();
	scenario.state = relay.state;
	relay._register(relay.onStateChange(state => { scenario.state = state; if (state === 'ready') scenario.readyCount++; }));
	scenario.beginRestart = () => {
		closingTransport = relay.transport.value;
		closeBarrier = new Promise(resolve => { scenario.releaseClose = resolve; });
		const first = relay.start();
		const second = relay.start();
		const third = relay.start();
		scenario.sameStartPromise = first === second && first === third;
		void Promise.all([first, second, third]).then(() => { scenario.restartSettled = true; }, error => { scenario.restartError = error.name; scenario.restartSettled = true; });
	};
	return routes.apply(this, args).map(route => {
		if (route.channel === 'ash:app-server:acquire') return {
			...route,
			async invoke(value) {
				scenario.acquisitions++;
				const delayed = holdValidation;
				try { return await route.invoke(value); }
				catch (error) { if (delayed) scenario.delayedAcquisitionError = error.name; throw error; }
				finally { if (delayed) scenario.delayedAcquisitionSettled = true; }
			},
		};
		if (route.channel === 'ash:app-server:initialized') return {
			...route,
			async invoke(value) {
				const delayed = holdInitialization;
				try { return await route.invoke(value); }
				catch (error) { if (delayed) scenario.delayedInitializationError = error.name; throw error; }
				finally { if (delayed) scenario.delayedInitializationSettled = true; }
			},
		};
		return route;
	});
};
const { startElectronApplication } = await import(${JSON.stringify(pathToFileURL(join(mainOutput, 'ash/code/electron-main/main.js')).href)});
startElectronApplication();
`);
		const application = await _electron.launch({ executablePath: configuration.executablePath, args: configuration.args.map(argument => argument === desktop ? entry : argument), cwd: configuration.cwd, env: { ...configuration.env, ASH_DEV_APP_SERVER_RELOAD: '1', ASH_DEV_AGENTS_WINDOW: '1' } });
		try {
			const page = await application.firstWindow();
			try {
				await expect(page.locator('.ash-sessions-window')).toBeVisible();
			} catch (error) {
				const details = await page.evaluate(() => [document.body.innerText, ...Array.from(document.querySelectorAll('textarea'), field => field.value)].join('\n'));
				throw new Error(`Agents startup failed at ${page.url()}:\n${details}`, { cause: error });
			}
			// The window can render before its first handshake finishes; restart scenarios need a ready carrier.
			await expect.poll(() => application.evaluate(() => (globalThis as unknown as { connectionScenario: ConnectionScenario; }).connectionScenario.state)).toBe('ready');
			await use({
				application, page, backend: async () => {
					const runtime = await readDevelopmentAppServerGeneration(developmentAppServerGenerationPath(desktop));
					if (!runtime) { throw new Error('Prepare the development backend before this scenario'); }
					const output = await execFileAsync(join(runtime, `bin/ash-app-server-daemon${process.platform === 'win32' ? '.exe' : ''}`), ['version'], { env: configuration.env, windowsHide: true });
					return JSON.parse(output.stdout) as { pid: number; instanceId: string; };
				}
			});
		} finally {
			await application.evaluate(({ BrowserWindow }) => {
				const scenario = (globalThis as unknown as { connectionScenario: ConnectionScenario; }).connectionScenario;
				scenario.releaseClose?.();
				scenario.releaseValidation?.();
				scenario.releaseInitialization?.();
				for (const window of BrowserWindow.getAllWindows()) { window.destroy(); }
			});
			const runtime = await readDevelopmentAppServerGeneration(developmentAppServerGenerationPath(desktop));
			if (runtime) { await execFileAsync(join(runtime, `bin/ash-app-server-daemon${process.platform === 'win32' ? '.exe' : ''}`), ['stop'], { env: configuration.env, windowsHide: true }); }
			await application.close();
			await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		}
	}
});

test('Agents reload waits for a connection restart to finish closing its previous carrier', async ({ connectionHarness: { application, page, backend } }) => {
	const beforeBackend = await backend();
	const before = await application.evaluate(() => {
		const scenario = (globalThis as unknown as { connectionScenario: ConnectionScenario; }).connectionScenario;
		scenario.beginRestart();
		return scenario.acquisitions;
	});
	await expect.poll(() => application.evaluate(() => (globalThis as unknown as { connectionScenario: ConnectionScenario; }).connectionScenario.isClosing)).toBe(true);
	await page.reload();
	await expect.poll(() => application.evaluate(() => (globalThis as unknown as { connectionScenario: ConnectionScenario; }).connectionScenario.acquisitions)).toBeGreaterThan(before);
	await application.evaluate(() => (globalThis as unknown as { connectionScenario: ConnectionScenario; }).connectionScenario.releaseClose());
	await expect(page.locator('.ash-sessions-window')).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Unable to start Ash' })).toHaveCount(0);
	await expect.poll(() => application.evaluate(() => {
		const scenario = (globalThis as unknown as { connectionScenario: ConnectionScenario; }).connectionScenario;
		return { settled: scenario.restartSettled, error: scenario.restartError };
	})).toEqual({ settled: true, error: undefined });
	expect(await application.evaluate(() => (globalThis as unknown as { connectionScenario: ConnectionScenario; }).connectionScenario.sameStartPromise)).toBe(true);
	expect(await backend()).toEqual(beforeBackend);
});

test('an acquisition delayed in an old Agents document cannot replace the reloaded connection', async ({ connectionHarness: { application, page, backend } }) => {
	const beforeBackend = await backend();
	await application.evaluate(() => (globalThis as unknown as { connectionScenario: ConnectionScenario; }).connectionScenario.holdNextValidation());
	await page.reload();
	await expect.poll(() => application.evaluate(() => (globalThis as unknown as { connectionScenario: ConnectionScenario; }).connectionScenario.waitingValidation)).toBe(true);
	await page.reload();
	await expect(page.locator('.ash-sessions-window')).toBeVisible();
	await application.evaluate(() => (globalThis as unknown as { connectionScenario: ConnectionScenario; }).connectionScenario.releaseValidation());
	await expect.poll(() => application.evaluate(() => {
		const scenario = (globalThis as unknown as { connectionScenario: ConnectionScenario; }).connectionScenario;
		return { settled: scenario.delayedAcquisitionSettled, error: scenario.delayedAcquisitionError };
	})).toEqual({ settled: true, error: 'CancellationError' });
	await expect(page.locator('.ash-sessions-window')).toBeVisible();
	expect(await backend()).toEqual(beforeBackend);
});

test('stopping a delayed restart cancels it before the reloaded Agents connection is acquired', async ({ connectionHarness: { application, page, backend } }) => {
	const beforeBackend = await backend();
	await application.evaluate(() => {
		const scenario = (globalThis as unknown as { connectionScenario: ConnectionScenario; }).connectionScenario;
		scenario.holdNextValidation();
		scenario.beginRestart();
		scenario.releaseClose();
	});
	await expect.poll(() => application.evaluate(() => (globalThis as unknown as { connectionScenario: ConnectionScenario; }).connectionScenario.waitingValidation)).toBe(true);
	await application.evaluate(() => (globalThis as unknown as { connectionScenario: ConnectionScenario; }).connectionScenario.stop());
	await page.reload();
	await expect(page.locator('.ash-sessions-window')).toBeVisible();
	await application.evaluate(() => (globalThis as unknown as { connectionScenario: ConnectionScenario; }).connectionScenario.releaseValidation());
	await expect.poll(() => application.evaluate(() => {
		const scenario = (globalThis as unknown as { connectionScenario: ConnectionScenario; }).connectionScenario;
		return { settled: scenario.restartSettled, error: scenario.restartError };
	})).toEqual({ settled: true, error: 'CancellationError' });
	await expect(page.locator('.ash-sessions-window')).toBeVisible();
	expect(await backend()).toEqual(beforeBackend);
});

test('initialization of an exited carrier cannot report a ready Agents connection', async ({ connectionHarness: { application, page, backend } }) => {
	const beforeBackend = await backend();
	const beforeReady = await application.evaluate(() => {
		const scenario = (globalThis as unknown as { connectionScenario: ConnectionScenario; }).connectionScenario;
		scenario.holdNextInitialization();
		scenario.beginRestart();
		scenario.releaseClose();
		return scenario.readyCount;
	});
	await expect.poll(() => application.evaluate(() => (globalThis as unknown as { connectionScenario: ConnectionScenario; }).connectionScenario.waitingInitialization)).toBe(true);
	await application.evaluate(() => (globalThis as unknown as { connectionScenario: ConnectionScenario; }).connectionScenario.killConnection());
	await expect.poll(() => application.evaluate(() => (globalThis as unknown as { connectionScenario: ConnectionScenario; }).connectionScenario.state)).toBe('crashed');
	await application.evaluate(() => (globalThis as unknown as { connectionScenario: ConnectionScenario; }).connectionScenario.releaseInitialization());
	await expect.poll(() => application.evaluate(() => {
		const scenario = (globalThis as unknown as { connectionScenario: ConnectionScenario; }).connectionScenario;
		return { settled: scenario.delayedInitializationSettled, error: scenario.delayedInitializationError };
	})).toEqual({ settled: true, error: 'CancellationError' });
	await page.reload();
	await expect(page.locator('.ash-sessions-window')).toBeVisible();
	expect(await application.evaluate(() => (globalThis as unknown as { connectionScenario: ConnectionScenario; }).connectionScenario.readyCount)).toBe(beforeReady + 1);
	expect(await backend()).toEqual(beforeBackend);
});
