import { Workbench } from '../../../automation/workbench.js';
import { Dialogs } from '../../../automation/dialogs.js';
import { _electron, type ElectronApplication, type Page } from '@playwright/test';
import { expect, test as baseTest } from '../../../automation/test.js';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
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
	preparedAcquisitions: number;
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
	waitingWorkspaceRead: boolean;
	workspaceReadFailures: number;
	holdNextWorkspaceRead(): void;
	releaseWorkspaceRead(): void;
	beginRestart(): void;
	releaseClose(): void;
	holdNextValidation(): void;
	holdNextAcquisitionValidation(): void;
	releaseValidation(): void;
	holdNextInitialization(): void;
	releaseInitialization(): void;
	stop(): Promise<void>;
	killConnection(): void;
}

interface ConnectionHarness {
	readonly application: ElectronApplication;
	readonly page: Page;
	readonly workspaceFolder: string | undefined;
	backend(): Promise<{ pid: number; instanceId: string; }>;
}

const test = baseTest.extend<{ connectionHarness: ConnectionHarness; connectionSurface: 'agents' | 'workbench'; connectionWorkspace: 'empty' | 'readOnly'; }>({
	connectionSurface: ['agents', { option: true }],
	connectionWorkspace: ['empty', { option: true }],
	connectionHarness: async ({ target, connectionSurface, connectionWorkspace }, use, testInfo) => {
		baseTest.skip(target.kind !== 'electron' || target.appServerMode !== 'required', 'Requires the Electron backend connection.');
		const directory = await mkdtemp(join(tmpdir(), 'ash-'));
		const workspaceFolder = connectionWorkspace === 'readOnly' || connectionSurface === 'workbench' ? join(directory, 'workspace') : undefined;
		if (workspaceFolder) {
			await mkdir(workspaceFolder);
			await writeFile(join(workspaceFolder, 'example.txt'), 'Workspace permission fixture\n');
		}
		const configuration = resolveElectronConfiguration({ appServerMode: 'required', userDataDirectory: directory, workspaceDirectory: workspaceFolder });
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
	preparedAcquisitions: 0,
	isClosing: false,
	restartSettled: false,
	sameStartPromise: false,
	waitingValidation: false,
	delayedAcquisitionSettled: false,
	waitingInitialization: false,
	delayedInitializationSettled: false,
	readyCount: 0,
	waitingWorkspaceRead: false,
	workspaceReadFailures: 0,
};
// Fault injection stays at Main's workspace IPC boundary; the renderer and window chrome are real.
const { TrustedIpcRouter } = await import(${JSON.stringify(pathToFileURL(join(mainOutput, 'ash/platform/ipc/electron-main/trustedIpcRouter.js')).href)});
let holdWorkspaceRead = false;
let workspaceReadBarrier;
scenario.holdNextWorkspaceRead = () => {
	holdWorkspaceRead = true;
	workspaceReadBarrier = new Promise(resolve => { scenario.releaseWorkspaceRead = resolve; });
};
const register = TrustedIpcRouter.prototype.register;
TrustedIpcRouter.prototype.register = function(target, routes) {
	return register.call(this, target, routes.map(route => route.channel !== 'ash:workspace:context:read' ? route : {
		...route,
		async invoke(value) {
			if (holdWorkspaceRead) {
				holdWorkspaceRead = false;
				scenario.waitingWorkspaceRead = true;
				await workspaceReadBarrier;
				scenario.workspaceReadFailures++;
				throw new Error('Injected workspace restore failure');
			}
			return route.invoke(value);
		},
	}));
};
let closingTransport;
let closeBarrier;
let validationBarrier;
let holdValidation = false;
let holdAcquisitionValidation = false;
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
	scenario.holdNextAcquisitionValidation = () => { holdAcquisitionValidation = true; validationBarrier = new Promise(resolve => { scenario.releaseValidation = resolve; }); };
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
				if (relay.state === 'starting') scenario.preparedAcquisitions++;
				const delayed = holdAcquisitionValidation;
				if (delayed) { holdAcquisitionValidation = false; holdValidation = true; }
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
		const application = await _electron.launch({ executablePath: configuration.executablePath, args: configuration.args.map(argument => argument === desktop ? entry : argument), cwd: configuration.cwd, env: { ...configuration.env, ASH_DEV_APP_SERVER_RELOAD: '1', ASH_DEV_AGENTS_WINDOW: connectionSurface === 'agents' ? '1' : '0' } });
		try {
			const page = await application.firstWindow();
			const startupErrors: string[] = [];
			page.on('pageerror', error => startupErrors.push(error.stack ?? error.message));
			page.on('console', message => { if (message.type() === 'error') startupErrors.push(message.text()); });
			if (workspaceFolder) {
				await page.getByRole('dialog', { name: 'Ash', exact: true }).getByRole('button', { name: connectionWorkspace === 'readOnly' ? 'Open Read-Only' : 'Trust Folder', exact: true }).click();
			}
			try {
				await new Workbench(page).waitForReady();
				await expect(page.locator(connectionSurface === 'agents' ? '.ash-sessions-window' : '.ash-workbench')).toBeVisible();
			} catch (error) {
				const details = await page.evaluate(() => [document.body.innerText, ...Array.from(document.querySelectorAll('textarea'), field => field.value), 'Root: ' + document.querySelector('#app')?.outerHTML.slice(0, 1600), 'Marks: ' + performance.getEntriesByType('mark').map(entry => entry.name).join(', ')].join('\n'));
				throw new Error(`${connectionSurface} startup failed at ${page.url()}:\n${details}\n${startupErrors.join('\n')}\nWindows: ${application.windows().map(window => window.url()).join(', ')}`, { cause: error });
			}
			// Fault injection starts only after both the Workbench and its carrier are ready.
			await expect.poll(() => application.evaluate(() => (globalThis as unknown as { connectionScenario: ConnectionScenario; }).connectionScenario.state)).toBe('ready');
			await use({
				application, page, workspaceFolder, backend: async () => {
					const runtime = await readDevelopmentAppServerGeneration(developmentAppServerGenerationPath(desktop));
					if (!runtime) { throw new Error('Prepare the development backend before this scenario'); }
					const output = await execFileAsync(join(runtime, `bin/ash-app-server-daemon${process.platform === 'win32' ? '.exe' : ''}`), ['version'], { env: configuration.env, windowsHide: true });
					return JSON.parse(output.stdout) as { pid: number; instanceId: string; };
				}
			});
			if (testInfo.status !== testInfo.expectedStatus) {
				const rendererErrors = testInfo.outputPath('renderer-errors.txt');
				await writeFile(rendererErrors, startupErrors.join('\n'));
				await testInfo.attach('renderer-errors.txt', { path: rendererErrors, contentType: 'text/plain' });
				const connectionState = testInfo.outputPath('connection-state.txt');
				await writeFile(connectionState, JSON.stringify(await application.evaluate(() => (globalThis as unknown as { connectionScenario: ConnectionScenario; }).connectionScenario)));
				await testInfo.attach('connection-state.txt', { path: connectionState, contentType: 'text/plain' });
				await testInfo.attach('connection-marks.txt', { body: await page.evaluate(() => performance.getEntriesByType('mark').filter(entry => /appServer|rendererApi/.test(entry.name)).map(entry => entry.name).join('\n')), contentType: 'text/plain' });
			}
		} finally {
			await application.evaluate(({ BrowserWindow }) => {
				const scenario = (globalThis as unknown as { connectionScenario: ConnectionScenario; }).connectionScenario;
				scenario.releaseClose?.();
				scenario.releaseValidation?.();
				scenario.releaseInitialization?.();
				scenario.releaseWorkspaceRead?.();
				for (const window of BrowserWindow.getAllWindows()) { window.destroy(); }
			});
			const runtime = await readDevelopmentAppServerGeneration(developmentAppServerGenerationPath(desktop));
			if (runtime) { await execFileAsync(join(runtime, `bin/ash-app-server-daemon${process.platform === 'win32' ? '.exe' : ''}`), ['stop'], { env: configuration.env, windowsHide: true }); }
			await application.close();
			await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		}
	}
});

test('Agents shows connection status without moving content and automatically restores its connection after the carrier exits', async ({
	connectionHarness: { application, page },
}, testInfo) => {
	// Use local content so this connection test does not depend on a signed-in chat provider.
	await page.locator('[data-action-id="sessions.open.projects"] button').click();
	const projects = page.locator('.ash-projects');
	await expect(projects).toBeVisible();
	const contentAction = projects.locator('[data-action-id="projects.create"] button');
	await contentAction.focus();
	await expect(contentAction).toBeFocused();
	const contentBounds = await projects.boundingBox();
	const before = await application.evaluate(() => {
		const scenario = (globalThis as unknown as { connectionScenario: ConnectionScenario; }).connectionScenario;
		return { acquisitions: scenario.acquisitions, readyCount: scenario.readyCount };
	});
	await application.evaluate(() => {
		const scenario = (globalThis as unknown as { connectionScenario: ConnectionScenario; }).connectionScenario;
		scenario.holdNextAcquisitionValidation();
		scenario.killConnection();
	});
	await expect
		.poll(() =>
			application.evaluate(
				() =>
					(globalThis as unknown as { connectionScenario: ConnectionScenario }).connectionScenario
						.waitingValidation,
			),
		)
		.toBe(true);
	const connection = page
		.locator('[data-part="titlebar"]')
		.getByRole('button', { name: 'Reconnecting to the Agent Host…', exact: true });
	await expect(connection).toBeVisible();
	await expect(page.locator('[data-part="banner"]')).toHaveCount(0);
	await expect(contentAction).toBeFocused();
	expect(await projects.boundingBox()).toEqual(contentBounds);
	await page.screenshot({ path: testInfo.outputPath('agent-host-recovery-status.png') });
	await application.evaluate(() =>
		(globalThis as unknown as { connectionScenario: ConnectionScenario }).connectionScenario.releaseValidation(),
	);
	await expect
		.poll(() =>
			application.evaluate(
				() =>
					(globalThis as unknown as { connectionScenario: ConnectionScenario }).connectionScenario
						.acquisitions,
			),
		)
		.toBeGreaterThan(before.acquisitions);
	await expect
		.poll(() =>
			application.evaluate(() => {
				const scenario = (globalThis as unknown as { connectionScenario: ConnectionScenario })
					.connectionScenario;
				return { state: scenario.state, readyCount: scenario.readyCount };
			}),
		)
		.toEqual({ state: 'ready', readyCount: before.readyCount + 1 });
	await expect(connection).toHaveCount(0);
	await expect(contentAction).toBeFocused();
	expect(await projects.boundingBox()).toEqual(contentBounds);
	await expect(page.locator('.ash-sessions-window')).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Unable to start Ash' })).toHaveCount(0);
});

test.describe('Agents recovery actions', () => {
	test.use({ connectionWorkspace: 'readOnly' });
	test('Agents retries a failed workspace restore from the keyboard without a banner or layout shift', async ({
		connectionHarness: { application, page },
	}, testInfo) => {
		const titlebar = page.locator('[data-part="titlebar"]');
		const sidebar = page.locator('[data-part="sidebar"]');
		const before = { titlebar: await titlebar.boundingBox(), sidebar: await sidebar.boundingBox() };
		await application.evaluate(() => {
			const scenario = (globalThis as unknown as { connectionScenario: ConnectionScenario }).connectionScenario;
			scenario.holdNextWorkspaceRead();
			scenario.killConnection();
		});
		await expect
			.poll(() =>
				application.evaluate(
					() =>
						(globalThis as unknown as { connectionScenario: ConnectionScenario }).connectionScenario
							.waitingWorkspaceRead,
				),
			)
			.toBe(true);
		await expect(
			titlebar.getByRole('button', { name: 'Reconnecting to the Agent Host…', exact: true }),
		).toBeVisible();
		const connection = await application.evaluate(() => {
			const scenario = (globalThis as unknown as { connectionScenario: ConnectionScenario }).connectionScenario;
			scenario.releaseWorkspaceRead();
			return { acquisitions: scenario.acquisitions, readyCount: scenario.readyCount };
		});
		const reconnect = titlebar.getByRole('button', { name: 'Reconnect Agent Host', exact: true });
		await expect(reconnect).toBeVisible();
		await expect(page.locator('[data-part="banner"]')).toHaveCount(0);
		expect({ titlebar: await titlebar.boundingBox(), sidebar: await sidebar.boundingBox() }).toEqual(before);
		await reconnect.focus();
		await reconnect.press('Alt+F1');
		const help = page.getByRole('textbox', { name: 'Accessibility Help', exact: true });
		await expect(help).toBeFocused();
		await expect(help).toHaveValue(/Agent window status/);
		await help.press('Escape');
		await expect(reconnect).toBeFocused();
		await page.screenshot({ path: testInfo.outputPath('agents-connection-retry.png') });
		await reconnect.press('Enter');
		await expect(reconnect).toHaveCount(0);
		await expect(
			titlebar.getByRole('button', { name: 'Reconnecting to the Agent Host…', exact: true }),
		).toHaveCount(0);
		expect(
			await application.evaluate(() => {
				const scenario = (globalThis as unknown as { connectionScenario: ConnectionScenario })
					.connectionScenario;
				return { acquisitions: scenario.acquisitions, readyCount: scenario.readyCount };
			}),
		).toEqual(connection);
		expect({ titlebar: await titlebar.boundingBox(), sidebar: await sidebar.boundingBox() }).toEqual(before);
	});
});

test.describe('main Workbench recovery', () => {
	test.use({ connectionSurface: 'workbench' });
	test('Workbench shows a persistent banner while restoring its backend connection', async ({ connectionHarness: { application, page } }, testInfo) => {
		await application.evaluate(() => {
			const scenario = (globalThis as unknown as { connectionScenario: ConnectionScenario; }).connectionScenario;
			scenario.holdNextAcquisitionValidation();
			scenario.killConnection();
		});
		await expect.poll(() => application.evaluate(() => (globalThis as unknown as { connectionScenario: ConnectionScenario; }).connectionScenario.waitingValidation)).toBe(true);
		const banner = page.locator('[data-part="banner"]');
		await expect(banner).toContainText('Reconnecting to the Agent Host');
		await banner.focus();
		await page.keyboard.press('Alt+F1');
		const help = page.getByRole('textbox', { name: 'Accessibility Help', exact: true });
		await expect(help).toHaveValue(/Window Banner/);
		await help.press('Escape');
		await expect(banner).toBeFocused();
		await page.screenshot({ path: testInfo.outputPath('workbench-agent-host-recovery-banner.png') });
		await application.evaluate(() => (globalThis as unknown as { connectionScenario: ConnectionScenario; }).connectionScenario.releaseValidation());
		await expect(banner).toBeHidden();
		await expect(page.locator('[data-part="editor"]')).toBeVisible();
	});
	test('workspace restore failure keeps the Banner visible and retries without replacing the ready connection', async ({ connectionHarness: { application, page } }, testInfo) => {
		await application.evaluate(() => {
			const scenario = (globalThis as unknown as { connectionScenario: ConnectionScenario; }).connectionScenario;
			scenario.holdNextWorkspaceRead();
			scenario.killConnection();
		});
		await expect.poll(() => application.evaluate(() => (globalThis as unknown as { connectionScenario: ConnectionScenario; }).connectionScenario.waitingWorkspaceRead)).toBe(true);
		await expect.poll(() => application.evaluate(() => (globalThis as unknown as { connectionScenario: ConnectionScenario; }).connectionScenario.state)).toBe('ready');
		const banner = page.locator('[data-part="banner"]');
		await expect(banner).toContainText('Reconnecting to the Agent Host');
		const before = await application.evaluate(() => {
			const scenario = (globalThis as unknown as { connectionScenario: ConnectionScenario; }).connectionScenario;
			scenario.releaseWorkspaceRead();
			return { acquisitions: scenario.acquisitions, readyCount: scenario.readyCount };
		});
		await expect(banner).toContainText('Could not restore the Agent Host connection or workspace');
		await expect.poll(() => application.evaluate(() => (globalThis as unknown as { connectionScenario: ConnectionScenario; }).connectionScenario.workspaceReadFailures)).toBe(1);
		await page.screenshot({ path: testInfo.outputPath('workspace-recovery-failed-banner.png') });
		await banner.getByRole('button', { name: 'Reconnect', exact: true }).click();
		await expect(banner).toBeHidden();
		expect(await application.evaluate(() => {
			const scenario = (globalThis as unknown as { connectionScenario: ConnectionScenario; }).connectionScenario;
			return { acquisitions: scenario.acquisitions, readyCount: scenario.readyCount };
		})).toEqual(before);
		await expect(page.locator('[data-part="editor"]')).toBeVisible();
	});
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

test('a committed Agents reload prepares its carrier before Renderer acquisition without a second handshake', async ({ connectionHarness: { application, page, backend } }) => {
	const beforeBackend = await backend();
	const before = await application.evaluate(() => {
		const scenario = (globalThis as unknown as { connectionScenario: ConnectionScenario; }).connectionScenario;
		return { prepared: scenario.preparedAcquisitions, ready: scenario.readyCount };
	});
	await page.reload();
	await expect(page.locator('.ash-sessions-window')).toBeVisible();
	await expect.poll(() => application.evaluate(() => {
		const scenario = (globalThis as unknown as { connectionScenario: ConnectionScenario; }).connectionScenario;
		return { prepared: scenario.preparedAcquisitions, ready: scenario.readyCount, state: scenario.state };
	})).toEqual({ prepared: before.prepared + 1, ready: before.ready + 1, state: 'ready' });
	expect(await backend()).toEqual(beforeBackend);
});

test('an acquisition delayed in an old Agents document cannot replace the reloaded connection', async ({ connectionHarness: { application, page, backend } }) => {
	const beforeBackend = await backend();
	await application.evaluate(() => (globalThis as unknown as { connectionScenario: ConnectionScenario; }).connectionScenario.holdNextAcquisitionValidation());
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

for (const surface of ['workbench', 'agents'] as const) {
	test.describe(`${surface} Workspace Trust`, () => {
		test.use({ connectionSurface: surface, connectionWorkspace: 'readOnly' });
		if (surface === 'agents') {
			test('Agents scopes permission status to Code without a banner or content offset', async ({
				connectionHarness: { page },
			}, testInfo) => {
				await expect(page.locator('[data-part="banner"]')).toHaveCount(0);
				const permissions = page.locator(
					'[data-part="titlebar"] [data-action-id="workbench.trust.manage"] button',
				);
				await expect(permissions).toHaveCount(0);
				await page.locator('[data-action-id="sessions.open.projects"] button').click();
				await expect(page.locator('.ash-projects')).toBeVisible();
				const partStyles = await readFile(join(desktop, 'src/ash/workbench/browser/media/part.css'), 'utf8');
				await page.addStyleTag({ content: partStyles });
				const titlebar = page.locator('[data-part="titlebar"]');
				const titlebarBounds = (await titlebar.boundingBox())!;
				expect(titlebarBounds.y).toBe(0);
				expect(titlebarBounds.height).toBe(process.platform === 'darwin' ? 36 : 35);
				for (const id of ['sidebar', 'editor']) {
					const bounds = (await page.locator(`[data-part="${id}"]`).boundingBox())!;
					expect(bounds.y).toBe(titlebarBounds.height);
					expect(bounds.y + bounds.height).toBeLessThanOrEqual(await page.evaluate(() => innerHeight));
				}
				await expect(permissions).toHaveCount(0);
				await page
					.locator('.ash-window-mode-control')
					.getByRole('button', { name: 'Code', exact: true })
					.click();
				await expect(permissions).toHaveAttribute('aria-label', 'Read-only workspace: workspace');
				await expect(page.locator('[data-part="banner"]')).toHaveCount(0);
				expect(await titlebar.boundingBox()).toEqual(titlebarBounds);
				for (const button of await titlebar.getByRole('button').all()) {
					const bounds = (await button.boundingBox())!;
					expect(Math.abs(bounds.y + bounds.height / 2 - titlebarBounds.height / 2)).toBeLessThanOrEqual(1);
				}
				await page.screenshot({ path: testInfo.outputPath('agents-scoped-workspace-permissions.png') });
			});
		}
		if (surface === 'workbench') {
			test('New Terminal awaits Workspace Trust before creating a process in a read-only workspace', async ({ connectionHarness: { application, page } }) => {
				const workbench = new Workbench(page);
				const banner = page.locator('[data-part="banner"]');
				await expect(banner).toContainText('This workspace is read-only');
				const dialogs = new Dialogs(page);
				const canceled = await dialogs.confirm(application, 'Workspace Trust', 'Cancel', () => workbench.quickaccess.runCommand('workbench.action.terminal.new'));
				expect(canceled.message).toContain('Creating a terminal can run code from this workspace');
				await expect(page.locator('.xterm-screen')).toHaveCount(0);
				await expect(banner).toContainText('This workspace is read-only');
				await dialogs.confirm(application, 'Workspace Trust', 'Trust workspace', () => workbench.quickaccess.runCommand('workbench.action.terminal.new'));
				await expect(banner).toBeHidden();
				await expect(page.locator('[data-part="panel"] .xterm-screen')).toBeVisible();
			});
		}
		test('Workspace status manages the current permissions and refreshes effective trust', async ({
			connectionHarness: { application, page, workspaceFolder },
		}, testInfo) => {
			const folder = await realpath(workspaceFolder!);
			const permissionStatus =
				surface === 'agents'
					? page.locator('[data-part="titlebar"]').getByRole('button', { name: /^Read-only workspace:/u })
					: page.locator('[data-part="banner"]');
			if (surface === 'agents') {
				await page
					.locator('.ash-window-mode-control')
					.getByRole('button', { name: 'Code', exact: true })
					.click();
				await expect(page.locator('[data-part="banner"]')).toHaveCount(0);
				await permissionStatus.click();
			} else {
				await expect(permissionStatus).toContainText('This workspace is read-only');
				await permissionStatus.getByRole('button', { name: 'Manage', exact: true }).click();
			}
			const editor = page.locator('.ash-workspace-trust-editor');
			await expect(editor).toBeVisible();
			const modal = page.getByRole('dialog', { name: 'Workspace Trust', exact: true });
			await expect(modal).toHaveCSS('width', '560px');
			await expect(modal).toHaveCSS('height', '360px');
			await expect(editor.locator('.workspace-trust-folder-path')).toHaveText(folder);
			await expect(editor.getByRole('heading', { level: 2 })).toHaveText('Read-only workspace');
			await expect(editor.getByRole('switch')).toHaveCount(0);
			await expect(editor.getByRole('button')).toHaveCount(1);
			const trust = editor.getByRole('button', { name: 'Trust workspace', exact: true });
			const readOnly = editor.getByRole('button', { name: 'Open read-only', exact: true });
			const confirm = async (button: string, enableDevelopment: boolean): Promise<void> => {
				const action = enableDevelopment ? trust : readOnly;
				if (surface === 'workbench') {
					const message = await new Dialogs(page).confirm(application, 'Confirm', button, () => action.click());
					expect(message.message).toContain(folder.split('/').at(-1)!);
				} else {
					await action.click();
					await page.getByRole('dialog', { name: 'Confirm', exact: true }).getByRole('button', { name: button, exact: true }).click();
				}
			};
			await page.screenshot({ path: testInfo.outputPath(`${surface}-workspace-trust-read-only.png`) });
			await expect(permissionStatus).toBeVisible();
			await confirm('Cancel', true);
			await expect(trust).toBeEnabled();
			await expect(permissionStatus).toBeVisible();
			await confirm('Trust workspace', true);
			await expect(permissionStatus).toBeHidden();
			await expect(editor.getByRole('heading', { level: 2 })).toHaveText('Trusted workspace');
			await expect(trust).toBeHidden();
			await expect(editor.getByRole('switch')).toHaveCount(0);
			await page.screenshot({ path: testInfo.outputPath(`${surface}-workspace-trust-management.png`) });
			await confirm('Open read-only', false);
			await expect(editor.getByRole('heading', { level: 2 })).toHaveText('Read-only workspace');
			await expect(permissionStatus).toBeVisible();
			await editor.locator('summary').focus();
			await page.keyboard.press('Enter');
			const write = editor.getByRole('switch', { name: 'Write files', exact: true });
			await expect(write).not.toBeChecked();
			await write.focus();
			await write.press('Space');
			const save = editor.getByRole('button', { name: 'Save permissions', exact: true });
			await save.focus();
			await expect(save).toBeInViewport({ ratio: 1 });
			await expect(modal).toHaveCSS('height', '360px');
			await expect(permissionStatus).toBeVisible();
			await page.keyboard.press('Escape');
			await expect(modal).toBeHidden();
		});
	});
}
