import { test as base, expect } from "@playwright/test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchBrowser } from "./playwrightBrowser.js";
import { launchElectron } from "./playwrightElectron.js";
import type { PlaywrightApplication, PlaywrightDriver } from "./playwrightDriver.js";
import { playwrightTargetForProject, type PlaywrightTarget } from "./testTarget.js";
import { createTestWorkspace, disposeTestWorkspace, type TestWorkspace } from "./testWorkspace.js";
import type { Workbench } from "./workbench.js";

interface RunningApplication {
	driver: PlaywrightDriver;
	deferRestart(): Promise<void>;
	restartMessage(): Promise<string>;
	restart(): Promise<{ application: PlaywrightApplication; workbench: Workbench }>;
}

interface PlaywrightFixtures {
	readonly runningApplication: RunningApplication;
	readonly restartWorkbench: RunningApplication['restart'];
	readonly deferRestart: () => Promise<void>;
	readonly restartMessage: () => Promise<string>;
	readonly includeLargeTestFile: boolean;
	readonly gitRepository: boolean;
	readonly gitMergeConflict: boolean;
	readonly openWorkspace: boolean;
	readonly target: PlaywrightTarget;
	readonly application: PlaywrightApplication;
	readonly driver: PlaywrightDriver;
	readonly testWorkspace: TestWorkspace;
	readonly workbench: Workbench;
}

const FORBIDDEN_WORKBENCH_CONSOLE_ERRORS = ["App Server language document synchronization failed", "Declarative extension refresh failed"] as const;

export const test = base.extend<PlaywrightFixtures>({
	includeLargeTestFile: [false, { option: true }],
	gitRepository: [false, { option: true }],
	gitMergeConflict: [false, { option: true }],
	openWorkspace: [true, { option: true }],
	target: async ({ baseURL }, use, testInfo) => {
		await use(playwrightTargetForProject(testInfo.project.name, baseURL));
	},
	testWorkspace: async ({ includeLargeTestFile, gitRepository, gitMergeConflict }, use) => {
		const workspace = await createTestWorkspace({ includeLargeFile: includeLargeTestFile, gitRepository, gitMergeConflict });
		try {
			await use(workspace);
		} finally {
			await disposeTestWorkspace(workspace);
		}
	},
	runningApplication: async ({ target, testWorkspace, openWorkspace }, use) => {
		if (target.kind === 'browser') {
			const { application, driver } = await launchBrowser(target);
			const running: RunningApplication = { driver,
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
			} };
			try { await use(running); } finally { await application.close(); }
			return;
		}
		const userDataDirectory = await mkdtemp(join(tmpdir(), 'ash-'));
		const options = {
			appServerMode: target.appServerMode, workbenchMode: target.workbenchMode, userDataDirectory,
			workspaceDirectory: openWorkspace ? testWorkspace.directory : undefined,
			workspacePermissions: openWorkspace && testWorkspace.removeOnDispose ? 'development' as const : undefined,
		};
		let current = await launchElectron(options);
		await captureRestartDialogs(current.application);
		let generation = 0;
		const running: RunningApplication = { driver: current.driver,
			deferRestart: async () => {
				await expect.poll(async () => current.application.evaluate(() => Boolean((globalThis as RestartDialogGlobal).ashTestRestartDialog))).toBe(true);
				await current.application.evaluate(() => (globalThis as RestartDialogGlobal).ashTestRestartDialog!.respond(1));
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
			await current.application.evaluate(() => (globalThis as RestartDialogGlobal).ashTestRestartDialog!.respond(0));
			await closed;
			await exited;
			const relaunched = await readFile(marker, 'utf8').catch(() => 'missing');
			if (relaunched !== 'relaunch') throw new Error(`Desktop shutdown did not request relaunch. Exit ${childProcess.exitCode}; ${processOutput}`);
			current = await launchElectron(options);
			await captureRestartDialogs(current.application);
			running.driver = current.driver;
			await current.driver.workbench.page.context().tracing.start({ screenshots: true, snapshots: true, sources: true });
			return { application: current.application, workbench: current.driver.workbench };
		} };
		try { await use(running); } finally {
			try { await current.close(); } finally { await rm(userDataDirectory, { force: true, recursive: true, maxRetries: 10, retryDelay: 100 }); }
		}
	},
	driver: async ({ runningApplication }, use) => { await use(runningApplication.driver); },
	restartWorkbench: async ({ runningApplication }, use) => { await use(() => runningApplication.restart()); },
	deferRestart: async ({ runningApplication }, use) => { await use(() => runningApplication.deferRestart()); },
	restartMessage: async ({ runningApplication }, use) => { await use(() => runningApplication.restartMessage()); },
	application: async ({ driver }, use) => {
		await use(driver.application);
	},
	workbench: async ({ driver, runningApplication }, use, testInfo) => {
		const workbench = driver.workbench;
		let page = workbench.page;
		const pageErrors: string[] = [];
		page.on("pageerror", error => pageErrors.push(error.stack ?? error.message));
		await page.context().tracing.start({ screenshots: true, snapshots: true, sources: true });
		await use(workbench);

		page = runningApplication.driver.workbench.page;
		const failed = testInfo.status !== testInfo.expectedStatus;
		if (failed) { await testInfo.attach("diagnostics", { body: JSON.stringify({ url: page.url(), pageErrors, consoleErrors: runningApplication.driver.consoleErrors }), contentType: "application/json" }); }
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
		if (pageErrors.length > 0 && !failed) {
			throw new Error(`Workbench page errors:\n${pageErrors.join("\n\n")}`);
		}
		const forbiddenConsoleErrors = driver.consoleErrors.filter(message => FORBIDDEN_WORKBENCH_CONSOLE_ERRORS.some(prefix => message.startsWith(prefix)));
		if (forbiddenConsoleErrors.length > 0 && !failed) {
			throw new Error(`Workbench emitted a forbidden console error:\n${forbiddenConsoleErrors.join("\n\n")}`);
		}
	},
});

interface RestartDialogGlobal {
	ashTestRestartDialog?: { message: string; respond(response: number): void };
}

async function captureRestartDialogs(application: import('@playwright/test').ElectronApplication): Promise<void> {
	await application.evaluate(({ dialog }) => {
		const original = dialog.showMessageBox.bind(dialog);
		dialog.showMessageBox = ((windowOrOptions: Electron.BrowserWindow | Electron.MessageBoxOptions, suppliedOptions?: Electron.MessageBoxOptions) => {
			const options = suppliedOptions ?? windowOrOptions as Electron.MessageBoxOptions;
			if (!/^(Restart Ash|重启 Ash)/u.test(options.message)) return suppliedOptions
				? original(windowOrOptions as Electron.BrowserWindow, suppliedOptions) : original(options);
			return new Promise<Electron.MessageBoxReturnValue>(resolve => {
				(globalThis as RestartDialogGlobal).ashTestRestartDialog = { message: options.message, respond(response) {
					delete (globalThis as RestartDialogGlobal).ashTestRestartDialog;
					resolve({ response, checkboxChecked: false });
				} };
			});
		}) as typeof dialog.showMessageBox;
	});
}

export { expect } from "@playwright/test";
