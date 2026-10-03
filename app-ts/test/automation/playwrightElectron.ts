import { execFile, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { DisposableStore, toDisposable } from "../../src/ash/base/common/lifecycle.js";
import { promisify } from "node:util";
import { appServerDaemonExecutablePath } from "../../src/ash/platform/app-server-daemon/node/appServerDaemonPackage.js";
import { _electron, type ElectronApplication, type Request } from "@playwright/test";
import { ElectronPlaywrightDriver } from "./electronDriver.js";
import { WorkbenchDiagnostics } from './playwrightDriver.js';
import { resolveElectronConfiguration, type ElectronLaunchOptions } from "./electron.js";

export interface ElectronLaunchResult {
	readonly application: ElectronApplication;
	readonly driver: ElectronPlaywrightDriver;
	readonly videoStartedAt?: number;
	close(): Promise<void>;
}

export type ElectronLaunchMilestone = 'electron-launch-resolved' | 'first-window' | 'trust-accepted' | 'workbench-ready';

/** Launches Ash Desktop through Playwright's Electron adapter. */
export async function launchElectron(options: ElectronLaunchOptions, onMilestone?: (milestone: ElectronLaunchMilestone) => void): Promise<ElectronLaunchResult> {
	const configuration = resolveElectronConfiguration(options);
	const startupDeadline = Date.now() + (options.startupTimeout ?? 30_000);
	const application = await _electron.launch({
		args: [...configuration.args],
		cwd: configuration.cwd,
		env: configuration.env,
		executablePath: configuration.executablePath,
		recordVideo: options.recordVideo ? { dir: options.recordVideo.directory, size: options.recordVideo.size } : undefined,
		timeout: Math.max(1, startupDeadline - Date.now()),
	});
	const diagnostics = new WorkbenchDiagnostics(application.context());
	onMilestone?.('electron-launch-resolved');
	// Playwright releases the application channel on exit; retain the child process for startup diagnostics and cleanup.
	const electronProcess = application.process();
	let closing: Promise<void> | undefined;
	const close = (): Promise<void> => closing ??= (async () => {
		const exited = electronProcess.exitCode !== null || electronProcess.signalCode !== null
			? Promise.resolve() : new Promise<void>(resolveExit => electronProcess.once('close', () => resolveExit()));
		let termination: Promise<void> | undefined;
		const shutdownTimer = setTimeout(() => { termination = terminateElectronProcess(electronProcess); }, 10_000);
		try {
			try {
				// End the renderer before stopping its daemon, so it cannot reconnect.
				await application.evaluate(({ BrowserWindow }) => {
					for (const window of BrowserWindow.getAllWindows()) window.destroy();
				});
			} finally {
				await application.close();
			}
		} catch (error) {
			if (termination) throw new Error('Electron shutdown exceeded 10000ms; its process tree was terminated', { cause: error });
			throw error;
		} finally {
			try { await exited; await termination; }
			finally {
				clearTimeout(shutdownTimer);
				// The daemon stop command owns its own process-exit deadline. Run it
				// after renderer exit and keep explicit shared profiles caller-owned.
				if (options.appServerMode === 'required' && options.profileDirectory === undefined) {
					const daemon = appServerDaemonExecutablePath({ appPath: configuration.cwd, isPackaged: options.packagedBundle !== undefined, platform: process.platform, resourcesPath: configuration.resourcesPath });
					await promisify(execFile)(daemon, ['stop'], { env: { ...configuration.env, ASH_HOME: resolve(options.userDataDirectory, 'profile') }, windowsHide: true, timeout: 30_000 });
				}
			}
		}
		if (termination) throw new Error('Electron shutdown exceeded 10000ms; its process tree was terminated');
	})();
	const startupResources = new DisposableStore();
	let processErrors = '';
	const onProcessError = (chunk: Buffer): void => { processErrors = (processErrors + chunk.toString()).slice(-16_384); };
	electronProcess.stderr?.on('data', onProcessError);
	startupResources.add(toDisposable(() => { electronProcess.stderr?.off('data', onProcessError); }));
	const pendingRequests = new Set<Request>();
	const failedRequests: string[] = [];
	const start = async (): Promise<ElectronLaunchResult> => {
		const page = application.windows()[0] ?? await application.waitForEvent("window", { timeout: 30_000 });
		const videoStartedAt = options.recordVideo ? Date.now() : undefined;
		onMilestone?.('first-window');
		if (options.recordVideo) {
			await application.evaluate(({ BrowserWindow }, size) => {
				BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: size.width, height: size.height });
			}, options.recordVideo.size);
		}
		const driver = new ElectronPlaywrightDriver(application, page, diagnostics);
		const onRequest = (request: Request): void => { pendingRequests.add(request); };
		const onRequestFinished = (request: Request): void => { pendingRequests.delete(request); };
		const onRequestFailed = (request: Request): void => {
			pendingRequests.delete(request);
			failedRequests.push(`${request.url()}: ${request.failure()?.errorText}`);
		};
		page.on('request', onRequest);
		page.on('requestfinished', onRequestFinished);
		page.on('requestfailed', onRequestFailed);
		startupResources.add(toDisposable(() => {
			page.off('request', onRequest);
			page.off('requestfinished', onRequestFinished);
			page.off('requestfailed', onRequestFailed);
		}));
		const ready = driver.workbench.waitForReady();
		if (options.appServerMode === 'required' && options.workspaceDirectory && options.workspacePermissions === 'development') {
			const prompt = page.getByRole('dialog', { name: 'Ash' });
			await Promise.race([ready, prompt.waitFor({ state: 'visible' })]);
			if (await prompt.isVisible()) {
				await prompt.getByRole('button', { name: 'Trust Folder & Enable Features' }).click();
				onMilestone?.('trust-accepted');
			}
		}
		await ready;
		onMilestone?.('workbench-ready');
		return { application, driver, videoStartedAt, close };
	};
	try {
		return await beforeDeadline(start(), startupDeadline, 'Electron Workbench startup timed out');
	} catch (error) {
		// A deadline can win before the readiness call rejects. Collect the document
		// here while the process is still alive, with a separate bounded read.
		const page = application.windows()[0];
		const text = page ? await beforeDeadline(page.evaluate(() => [
			document.body.innerText,
			...Array.from(document.querySelectorAll('textarea'), field => field.value),
		].join('\n')), Date.now() + 1_000, 'Startup document diagnostics timed out').catch(error => String(error)) : 'No Electron window opened';
		const details = [
			...diagnostics.consoleErrors.slice(-8),
			...diagnostics.pageErrors,
			...failedRequests,
			...[...pendingRequests].map(request => `Pending: ${request.url()}`),
		].join('\n');
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
		throw new Error(`Electron startup failed${exitCode === null ? '' : ` (exit code ${exitCode})`}: ${String(error)}\n${text}\n${details}${processErrors ? `\n${processErrors}` : ''}`, { cause: error });
	} finally {
		startupResources.dispose();
	}
}

async function beforeDeadline<T>(operation: Promise<T>, deadline: number, message: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout>;
	const expired = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), Math.max(1, deadline - Date.now())); });
	try { return await Promise.race([operation, expired]); }
	finally { clearTimeout(timer!); }
}

async function terminateElectronProcess(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	if (!child.pid) throw new Error('Electron process has no PID');
	// Playwright owns a separate POSIX process group; on Windows its command shell
	// owns the Electron tree. Terminate that owned tree, including helper processes.
	if (process.platform === 'win32') {
		await promisify(execFile)('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5_000 });
	} else {
		process.kill(-child.pid, 'SIGKILL');
	}
}
