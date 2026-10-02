import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { appServerDaemonExecutablePath } from "../../src/ash/platform/app-server-daemon/node/appServerDaemonPackage.js";
import { _electron, type ElectronApplication, type Page, type Request } from "@playwright/test";
import { ElectronPlaywrightDriver } from "./electronDriver.js";
import { resolveElectronConfiguration, type ElectronLaunchOptions } from "./electron.js";
import { StartupDeadline } from './startupDeadline.js';
import { createElectronCleanup } from './electronCleanup.js';
import { Workbench } from './workbench.js';

export interface ElectronLaunchResult {
	readonly application: ElectronApplication;
	readonly driver: ElectronPlaywrightDriver;
	readonly videoStartedAt?: number;
	close(): Promise<void>;
}

export type ElectronLaunchMilestone = 'electron-launch-resolved' | 'first-window' | 'trust-accepted' | 'workbench-ready';

/**
 * Arm before opening a window; resolves only after its initial navigation and renderer are usable.
 * This observer never accepts workspace trust or dispatches/retries the action that opens the window.
 * Tests exercising startup, trust prompts, or immediate close keep the raw window event boundary.
 */
export async function waitForNewElectronWindow(application: ElectronApplication, surface: 'sessions' | 'workbench'): Promise<Page> {
	const deadline = new StartupDeadline();
	let page: Page | undefined;
	try {
		page = await deadline.run(`new ${surface} window`, timeout => application.waitForEvent('window', { timeout }));
		const opened = page;
		// Electron can publish the Page while it still owns the initial about:blank context.
		await deadline.run(`${surface} initial navigation`, timeout => opened.waitForURL(url => url.href !== 'about:blank', { waitUntil: 'load', timeout }));
		await deadline.run(`${surface} renderer IPC bridge`, timeout => opened.waitForFunction(() => {
			const bridge = (globalThis as unknown as { ash?: { ipcRenderer?: { invoke?: unknown } } }).ash?.ipcRenderer;
			return typeof bridge?.invoke === 'function';
		}, undefined, { timeout }));
		if (surface === 'workbench') {
			await new Workbench(opened).waitForReady(deadline);
		} else {
			// Sessions creates its shell after connecting Main IPC and loading configuration.
			// Its hidden editor and independent lifecycle do not use Workbench's aria-busy contract.
			await deadline.run('Sessions shell', timeout => opened.locator('.ash-code-sessions-window').waitFor({ state: 'visible', timeout }));
		}
		return opened;
	} catch (error) {
		throw new Error(`New ${surface} window failed at ${page?.url() ?? 'before the window event'}: ${String(error)}`, { cause: error });
	}
}

/** Launches Ash Desktop through Playwright's Electron adapter. */
export async function launchElectron(options: ElectronLaunchOptions, onMilestone?: (milestone: ElectronLaunchMilestone) => void): Promise<ElectronLaunchResult> {
	const deadline = new StartupDeadline();
	const configuration = resolveElectronConfiguration(options);
	const application = await _electron.launch({
		args: [...configuration.args],
		cwd: configuration.cwd,
		env: configuration.env,
		executablePath: configuration.executablePath,
		recordVideo: options.recordVideo ? { dir: options.recordVideo.directory, size: options.recordVideo.size } : undefined,
		timeout: deadline.remaining('Electron process launch'),
	});
	onMilestone?.('electron-launch-resolved');
	// Playwright releases the application channel on exit; retain the child process for startup diagnostics and cleanup.
	const electronProcess = application.process();
	const close = createElectronCleanup(application, async () => {
		// Explicit shared profiles remain owned by their caller.
		if (options.appServerMode === 'required' && options.profileDirectory === undefined) {
			const daemon = appServerDaemonExecutablePath({ appPath: configuration.cwd, isPackaged: options.packagedBundle !== undefined, platform: process.platform, resourcesPath: configuration.resourcesPath });
			await promisify(execFile)(daemon, ['stop'], { env: { ...configuration.env, ASH_HOME: resolve(options.userDataDirectory, 'profile') }, windowsHide: true, timeout: 30_000 });
		}
	});
	let processErrors = '';
	const onProcessError = (chunk: Buffer): void => { processErrors = (processErrors + chunk.toString()).slice(-16_384); };
	electronProcess.stderr?.on('data', onProcessError);
	try {
		const page = await deadline.run('first window', async timeout => application.windows()[0] ?? await application.waitForEvent("window", { timeout }));
		const videoStartedAt = options.recordVideo ? Date.now() : undefined;
		onMilestone?.('first-window');
		if (options.recordVideo) {
			await deadline.run('window sizing', () => application.evaluate(({ BrowserWindow }, size) => {
				BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: size.width, height: size.height });
			}, options.recordVideo!.size));
		}
		const driver = new ElectronPlaywrightDriver(application, page);
		const pageErrors: string[] = [];
		const pendingRequests = new Set<Request>();
		const failedRequests: string[] = [];
		const onPageError = (error: Error): void => { pageErrors.push(error.message); };
		const onRequest = (request: Request): void => { pendingRequests.add(request); };
		const onRequestFinished = (request: Request): void => { pendingRequests.delete(request); };
		const onRequestFailed = (request: Request): void => {
			pendingRequests.delete(request);
			failedRequests.push(`${request.url()}: ${request.failure()?.errorText}`);
		};
		page.on('pageerror', onPageError);
		page.on('request', onRequest);
		page.on('requestfinished', onRequestFinished);
		page.on('requestfailed', onRequestFailed);
		try {
			const ready = driver.workbench.waitForReady(deadline);
			if (options.appServerMode === 'required' && options.workspaceDirectory && options.workspacePermissions === 'development') {
				const prompt = page.getByRole('dialog', { name: 'Ash' });
				await Promise.race([ready, prompt.waitFor({ state: 'visible', timeout: deadline.remaining('workspace trust prompt') })]);
				if (await deadline.run('workspace trust state', () => prompt.isVisible())) {
					await prompt.getByRole('button', { name: 'Trust Folder & Enable Features' }).click({ timeout: deadline.remaining('workspace trust acceptance') });
					onMilestone?.('trust-accepted');
				}
			}
			await ready;
			onMilestone?.('workbench-ready');
		} catch (error) {
			const text = await page.evaluate(() => [document.body.innerText, ...Array.from(document.querySelectorAll('textarea'), field => field.value)].join('\n')).catch(() => 'Document is unavailable');
			const startup = await page.evaluate(() => ({
				visibility: document.visibilityState,
				readyState: document.readyState,
				busy: document.querySelector('.ash-workbench')?.getAttribute('aria-busy'),
				marks: performance.getEntriesByType('mark').filter(entry => entry.name.startsWith('ash.')).map(entry => ({ name: entry.name, startTime: entry.startTime })),
			})).catch(() => undefined);
			const windows = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({
				visible: window.isVisible(),
				minimized: window.isMinimized(),
				loading: window.webContents.isLoading(),
			}))).catch(() => undefined);
			const details = [
				`Startup diagnostics: ${JSON.stringify({ startup, windows })}`,
				...driver.consoleErrors.slice(-8),
				...pageErrors,
				...failedRequests,
				...[...pendingRequests].map(request => `Pending: ${request.url()}`),
			].join('\n');
			throw new Error(`Workbench startup failed at ${page.url()}:\n${text}\n${details}\n${processErrors}`, { cause: error });
		} finally {
			page.off('pageerror', onPageError);
			page.off('request', onRequest);
			page.off('requestfinished', onRequestFinished);
			page.off('requestfailed', onRequestFailed);
			electronProcess.stderr?.off('data', onProcessError);
		}
		return { application, driver, videoStartedAt, close };
	} catch (error) {
		const bufferedError = electronProcess.stderr?.read();
		if (bufferedError) {
			onProcessError(Buffer.isBuffer(bufferedError) ? bufferedError : Buffer.from(String(bufferedError)));
		}
		const exitCode = electronProcess.exitCode;
		try {
			await close();
		} catch (closeError) {
			processErrors = `${processErrors}\nCleanup: ${String(closeError)}`;
		}
		throw new Error(`Electron startup failed${exitCode === null ? '' : ` (exit code ${exitCode})`}: ${String(error)}${processErrors ? `\n${processErrors}` : ''}`, { cause: error });
	} finally {
		electronProcess.stderr?.off('data', onProcessError);
	}
}
