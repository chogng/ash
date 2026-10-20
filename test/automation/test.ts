import { test as base, expect } from "@playwright/test";
import { mkdtemp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchBrowser } from "./playwrightBrowser.js";
import { launchElectron } from "./playwrightElectron.js";
import { launchWeb, type WebLaunchResult, type GitHubBrowserTestConfiguration } from './playwrightWeb.js';
import type { PlaywrightApplication, PlaywrightDriver, WorkbenchDiagnostics } from "./playwrightDriver.js";
import { playwrightTargetForProject, supportsTestTarget, type PlaywrightTarget } from "./testTarget.js";
import { createTestWorkspace, disposeTestWorkspace, type TestWorkspace } from "./testWorkspace.js";
import type { Workbench } from "./workbench.js";
import type { ElectronWindowMode } from './electron.js';

interface RunningApplication {
	driver: PlaywrightDriver;
	diagnostics: Pick<WorkbenchDiagnostics, 'pageErrors' | 'consoleErrors' | 'errors'>;
	deferRestart(): Promise<void>;
	restartMessage(): Promise<string>;
	reload(reason?: 'windowClose' | 'quit'): Promise<{ application: PlaywrightApplication; workbench: Workbench; }>;
	restart(): Promise<{ application: PlaywrightApplication; workbench: Workbench; }>;
}

interface PlaywrightFixtures {
	readonly testTargetSupport: void;
	readonly electronWindowMode: ElectronWindowMode | undefined;
	readonly useInMemorySecretStorage: boolean;
	/** Product arguments for a test-owned Electron launch, such as --agents-window. */
	readonly electronArgs: readonly string[];
	/** JSON settings seeded in this Electron fixture's isolated profile before launch. */
	readonly electronUserSettings: Readonly<Record<string, unknown>> | undefined;
	readonly webAppServer: WebLaunchResult | undefined;
	readonly runningApplication: RunningApplication;
	readonly restartWorkbench: RunningApplication['restart'];
	readonly reloadWorkbench: RunningApplication['reload'];
	readonly deferRestart: () => Promise<void>;
	readonly restartMessage: () => Promise<string>;
	readonly includeLargeTestFile: boolean;
	readonly gitRepository: boolean;
	readonly gitMergeConflict: boolean;
	readonly openWorkspace: boolean;
	readonly reportIssueUrl: string | undefined;
	readonly githubAccount: GitHubBrowserTestConfiguration | undefined;
	/** Isolated config.toml contents installed before the owning App Server starts. */
	readonly backendConfiguration: string | undefined;
	/** Test-owned distribution inputs prepared before the profile daemon starts. */
	readonly backendFixture: BackendFixture | undefined;
	readonly target: PlaywrightTarget;
	readonly application: PlaywrightApplication;
	readonly driver: PlaywrightDriver;
	readonly testWorkspace: TestWorkspace;
	readonly workbench: Workbench;
}

export interface BackendFixture {
	readonly productServicesPath: string;
	prepareProfile(profileDirectory: string): Promise<void>;
}

export const test = base.extend<PlaywrightFixtures>({
	testTargetSupport: [async ({ target }, use, testInfo) => {
		testInfo.skip(!supportsTestTarget(testInfo.tags, target, process.platform), 'Scenario does not apply to this host, backend or platform.');
		await use();
	}, { auto: true }],
	electronWindowMode: [undefined, { option: true }],
	useInMemorySecretStorage: [true, { option: true }],
	electronArgs: [[], { option: true }],
	electronUserSettings: [undefined, { option: true }],
	includeLargeTestFile: [false, { option: true }],
	gitRepository: [false, { option: true }],
	gitMergeConflict: [false, { option: true }],
	openWorkspace: [true, { option: true }],
	reportIssueUrl: [undefined, { option: true }],
	githubAccount: [undefined, { option: true }],
	backendConfiguration: [undefined, { option: true }],
	backendFixture: [undefined, { option: true }],
	// Workspace options may depend on the platform. Connection addresses belong
	// to the later launch, otherwise target -> server -> workspace -> target cycles.
	target: async ({ }, use, testInfo) => {
		await use(playwrightTargetForProject(testInfo.project.name));
	},
	webAppServer: [async ({ testWorkspace, reportIssueUrl, backendConfiguration, githubAccount }, use, testInfo) => {
		if (testInfo.project.name !== 'browser-app-server') { await use(undefined); return; }
		// The full smoke prehook (or CI's explicit preparation) owns this build.
		// no-compile runs reuse it without compiling again in each test fixture.
		const server = await launchWeb(testWorkspace.directory, { reportIssueUrl, backendConfiguration, githubAccount, preparedBackend: true });
		try { await use(server); } finally { await server.close(); }
	}, { timeout: 75_000 }],
	testWorkspace: async ({ includeLargeTestFile, gitRepository, gitMergeConflict }, use) => {
		const workspace = await createTestWorkspace({ includeLargeFile: includeLargeTestFile, gitRepository, gitMergeConflict });
		try {
			await use(workspace);
		} finally {
			await disposeTestWorkspace(workspace);
		}
	},
	// Startup (30s), process exit (10s), and daemon stop (30s) have independent
	// owned budgets. Keep them inside the fixture budget; test actions retain 45s.
	runningApplication: [async ({ target, testWorkspace, openWorkspace, webAppServer, baseURL, backendConfiguration, backendFixture, githubAccount, video, electronWindowMode, electronArgs, electronUserSettings, useInMemorySecretStorage }, use, testInfo) => {
		if (backendFixture && githubAccount) { throw new Error('Backend fixture and GitHub account fixture both select product services'); }
		// Evidence scenarios opt into full recording; the launchers own every page until cleanup.
		const videoOptions = typeof video === 'string' ? { mode: video, size: undefined } : video;
		const recordVideo = videoOptions.mode === 'on' ? { directory: testInfo.outputPath('recordings'), size: videoOptions.size ?? { width: 1440, height: 900 } } : undefined;
		// Restart replaces the driver; retain errors from each application generation.
		const generations: WorkbenchDiagnostics[] = [];
		const diagnostics = {
			get pageErrors(): string[] { return generations.flatMap(generation => generation.pageErrors); },
			get consoleErrors(): string[] { return generations.flatMap(generation => generation.consoleErrors); },
			get errors(): readonly string[] { return generations.flatMap(generation => generation.errors); },
		};
		const useApplication = async (running: RunningApplication): Promise<void> => {
			let page = running.driver.workbench.page;
			await page.context().tracing.start({ screenshots: true, snapshots: true, sources: true });
			await use(running);

			page = running.driver.workbench.page;
			const { pageErrors, consoleErrors } = running.diagnostics;
			const errors = running.diagnostics.errors;
			const failed = testInfo.status !== testInfo.expectedStatus || errors.length > 0;
			if (failed) { await testInfo.attach("diagnostics", { body: JSON.stringify({ url: page.url(), pageErrors, consoleErrors }), contentType: "application/json" }); }
			if (failed && !page.isClosed()) {
				const screenshotPath = testInfo.outputPath("workbench.png");
				await page.screenshot({ path: screenshotPath }).catch(() => undefined);
				await testInfo.attach("workbench", { path: screenshotPath, contentType: "image/png" }).catch(() => undefined);
			}
			if (failed) {
				const tracePath = testInfo.outputPath("trace.zip");
				await page.context().tracing.stop({ path: tracePath }).catch(() => undefined);
				await testInfo.attach("trace", { path: tracePath, contentType: "application/zip" }).catch(() => undefined);
			} else {
				await page.context().tracing.stop().catch(() => undefined);
			}
			if (errors.length > 0 && testInfo.status === 'passed') {
				throw new Error(`Workbench errors:\n${errors.join("\n\n")}`);
			}
		};
		if (target.kind === 'browser') {
			const url = target.appServerMode === 'required' ? webAppServer!.connection.endpoint : baseURL;
			if (url === undefined) throw new Error(`Browser project '${testInfo.project.name}' requires a baseURL`);
			const { application, driver } = await launchBrowser({ ...target, baseURL: url, webSession: webAppServer?.connection, recordVideo });
			generations.push(driver.diagnostics);
			const running: RunningApplication = {
				driver, diagnostics,
				reload: async () => {
					await driver.workbench.page.context().tracing.stop();
					await driver.workbench.reloadWindow();
					await driver.workbench.waitForReady();
					await driver.workbench.page.context().tracing.start({ screenshots: true, snapshots: true, sources: true });
					return { application, workbench: driver.workbench };
				},
				deferRestart: async () => { await driver.workbench.page.getByRole('button', { name: /^(Later|稍后)$/u }).click(); },
				restartMessage: async () => driver.workbench.page.locator('.ash-dialog-message').textContent().then(text => text ?? ''),
				restart: async () => {
					await driver.workbench.page.context().tracing.stop();
					const loaded = driver.workbench.page.waitForEvent('domcontentloaded');
					await driver.workbench.page.getByRole('button', { name: /^(Restart now|立即重启)$/u }).click();
					await loaded;
					await driver.workbench.waitForReady();
					await driver.workbench.page.context().tracing.start({ screenshots: true, snapshots: true, sources: true });
					return { application, workbench: driver.workbench };
				}
			};
			try { await useApplication(running); } finally { await application.close(); }
			return;
		}
		const userDataDirectory = await mkdtemp(join(tmpdir(), 'ash-'));
		const options = {
			appServerMode: target.appServerMode, userDataDirectory, recordVideo,
			productServicesPath: backendFixture?.productServicesPath ?? (githubAccount ? join(userDataDirectory, 'product-services.json') : undefined),
			windowMode: electronWindowMode,
			useInMemorySecretStorage,
			extraArgs: electronArgs,
			workspaceDirectory: openWorkspace ? testWorkspace.directory : undefined,
			workspacePermissions: openWorkspace ? 'development' as const : undefined,
		};
		try {
			if (backendFixture) { await backendFixture.prepareProfile(join(userDataDirectory, 'profile')); }
			if (electronUserSettings) {
				const profileDirectory = join(userDataDirectory, 'profile');
				await mkdir(profileDirectory, { recursive: true });
				await writeFile(join(profileDirectory, 'settings.json'), JSON.stringify(electronUserSettings) + '\n');
			}
			if (githubAccount && options.productServicesPath) {
				await writeFile(options.productServicesPath, JSON.stringify({ schemaVersion: 3, githubAccount }) + '\n');
			}
			// Startup-only backend options must be present before the daemon is composed.
			if (backendConfiguration) {
				const profileDirectory = join(userDataDirectory, 'profile');
				await mkdir(profileDirectory, { recursive: true });
				await writeFile(join(profileDirectory, 'config.toml'), backendConfiguration);
			}
			const languageServer = process.env.ASH_PLAYWRIGHT_LANGUAGE_SERVER;
			if (languageServer && target.appServerMode === 'required') {
				const profileDirectory = join(userDataDirectory, 'profile');
				await mkdir(profileDirectory, { recursive: true });
				await writeFile(join(profileDirectory, 'config.toml'), `${backendConfiguration ?? ''}\n[languageServers.servers.rust-analyzer]\nmode = "enabled"\nexecutable = ${JSON.stringify(languageServer)}\n`);
			}
			let current = await launchElectron(options);
			try {
				generations.push(current.driver.diagnostics);
				await captureRestartDialogs(current.application);
				let generation = 0;
				const running: RunningApplication = {
					driver: current.driver, diagnostics,
					reload: async (reason = 'windowClose') => {
						await current.driver.workbench.page.context().tracing.stop();
						if (reason === 'quit') await current.quit();
						else {
							const page = current.driver.workbench.page;
							const closed = page.waitForEvent('close');
							const window = await current.application.browserWindow(page);
							await window.evaluate(window => window.close());
							await closed;
							await current.close();
						}
						current = await launchElectron(options);
						generations.push(current.driver.diagnostics);
						await captureRestartDialogs(current.application);
						running.driver = current.driver;
						await current.driver.workbench.page.context().tracing.start({ screenshots: true, snapshots: true, sources: true });
						return { application: current.application, workbench: current.driver.workbench };
					},
					deferRestart: async () => {
						await expect.poll(async () => current.application.evaluate(() => Boolean((globalThis as RestartDialogGlobal).ashTestRestartDialog))).toBe(true);
						await current.application.evaluate(() => (globalThis as RestartDialogGlobal).ashTestRestartDialog!.respond('later'));
					},
					restartMessage: async () => current.application.evaluate(() => (globalThis as RestartDialogGlobal).ashTestRestartDialog?.message ?? ''),
					restart: async () => {
						const marker = join(userDataDirectory, `restart-${++generation}`);
						// Playwright owns process launch so it can attach to the replacement. Verify the
						// production shutdown reaches app.relaunch, then launch with the same profile.
						await current.application.evaluate(({ app }, marker) => {
							const fs = process.getBuiltinModule('fs');
							app.relaunch = () => { fs.writeFileSync(marker, 'relaunch'); };
						}, marker);
						await current.driver.workbench.page.context().tracing.stop();
						const childProcess = current.application.process();
						let processOutput = '';
						childProcess.stderr?.on('data', data => { processOutput += data.toString(); });
						const exited = new Promise<void>(resolve => childProcess.once('exit', () => resolve()));
						const closed = current.application.waitForEvent('close');
						await expect.poll(async () => current.application.evaluate(() => Boolean((globalThis as RestartDialogGlobal).ashTestRestartDialog))).toBe(true);
						await current.application.evaluate(() => (globalThis as RestartDialogGlobal).ashTestRestartDialog!.respond('restart'));
						await exited;
						// The daemon can retain inherited pipes after Main exits on Windows.
						// Release the old fixture before awaiting Playwright's pipe-close event.
						await current.close();
						await closed;
						const relaunched = await readFile(marker, 'utf8').catch(() => 'missing');
						if (relaunched !== 'relaunch') throw new Error(`Desktop shutdown did not request relaunch. Exit ${childProcess.exitCode}; ${processOutput}`);
						current = await launchElectron(options);
						generations.push(current.driver.diagnostics);
						await captureRestartDialogs(current.application);
						running.driver = current.driver;
						await current.driver.workbench.page.context().tracing.start({ screenshots: true, snapshots: true, sources: true });
						return { application: current.application, workbench: current.driver.workbench };
					}
				};
				await useApplication(running);
			} finally {
				await current.close();
			}
		} finally {
			await rm(userDataDirectory, { force: true, recursive: true, maxRetries: 10, retryDelay: 100 });
		}
	}, { timeout: 75_000 }],
	driver: async ({ runningApplication }, use) => { await use(runningApplication.driver); },
	reloadWorkbench: async ({ runningApplication }, use) => { await use(() => runningApplication.reload()); },
	restartWorkbench: async ({ runningApplication }, use) => { await use(() => runningApplication.restart()); },
	deferRestart: async ({ runningApplication }, use) => { await use(() => runningApplication.deferRestart()); },
	restartMessage: async ({ runningApplication }, use) => { await use(() => runningApplication.restartMessage()); },
	application: async ({ driver }, use) => {
		await use(driver.application);
	},
	workbench: async ({ driver }, use) => { await use(driver.workbench); },
});

interface RestartDialogGlobal {
	ashTestRestartDialog?: { message: string; respond(action: 'restart' | 'later'): void; };
}

async function captureRestartDialogs(application: import('@playwright/test').ElectronApplication): Promise<void> {
	await application.evaluate(({ dialog }) => {
		const original = dialog.showMessageBox.bind(dialog);
		dialog.showMessageBox = ((windowOrOptions: Electron.BrowserWindow | Electron.MessageBoxOptions, suppliedOptions?: Electron.MessageBoxOptions) => {
			const options = suppliedOptions ?? windowOrOptions as Electron.MessageBoxOptions;
			if (!/^(Restart Ash|重启 Ash)/u.test(options.message)) return suppliedOptions
				? original(windowOrOptions as Electron.BrowserWindow, suppliedOptions) : original(options);
			return new Promise<Electron.MessageBoxReturnValue>(resolve => {
				(globalThis as RestartDialogGlobal).ashTestRestartDialog = {
					message: options.message, respond(action) {
						delete (globalThis as RestartDialogGlobal).ashTestRestartDialog;
						// Main has already reordered native buttons for the host platform.
						const response = action === 'restart' ? options.defaultId ?? 0 : options.cancelId ?? 1;
						resolve({ response, checkboxChecked: false });
					}
				};
			});
		}) as typeof dialog.showMessageBox;
	});
}

export { expect } from "@playwright/test";

/** Writes a real VS Code package alongside its Plugin authority envelope. */
export async function writeEditorExtensionFixture(root: string, source: string, debuggerDefaults?: readonly unknown[]): Promise<void> {
	const plugin = JSON.parse(await readFile(join(root, '.ash-plugin', 'plugin.json'), 'utf8'));
	const commands = [...source.matchAll(/commands\.registerCommand\('([^']+)'/g)].flatMap(match => {
		if (match[1] === 'acme.debugCancellation.descriptor.') return ['undefined', 'null'].map(value => match[1] + value);
		if (match[1] === 'acme.debugCancellation.') return ['before.undefined', 'before.null', 'after.undefined', 'after.null'].map(value => match[1] + value);
		return [match[1]];
	});
	const types = (method: string): string[] => [...source.matchAll(new RegExp(method + "\\(['\"]([^'\"]+)['\"]", 'g'))].map(match => match[1]).filter(value => value !== '*');
	const contribution = plugin.contributions.editorExtensions[0];
	await writeFile(join(root, 'package.json'), JSON.stringify({
		publisher: plugin.id.split('/')[0], name: plugin.id.split('/')[1], version: plugin.version, main: 'extension.js', engines: { vscode: '^1.100.0' },
		activationEvents: contribution.activationEvents.map((event: { type: string; id?: string; taskType?: string; debugType?: string; }) => event.type === 'startup' ? '*' : event.type === 'onCommand' ? 'onCommand:' + event.id : event.type === 'onTaskType' ? 'onTaskType:' + event.taskType : event.type === 'onDebugType' ? 'onDebugResolve:' + event.debugType : 'onDebug'),
		contributes: {
			// Visible titles differ from stable IDs so commands participate in the Command Palette.
			commands: [...new Set(commands)].map(command => ({ command, title: 'Run ' + command })),
			debuggers: debuggerDefaults ?? [...new Set([...types('registerDebugConfigurationProvider'), ...types('registerDebugAdapterDescriptorFactory')])].map(type => ({ type, label: type })),
			taskDefinitions: types('registerTaskProvider').map(type => ({ type, required: [], properties: {} })),
		},
	}));
	await writeFile(join(root, 'extension.js'), source);
}
