import type { BrowserWindow, MessageBoxOptions } from "electron";
import { realpath } from "node:fs/promises";
import { _electron, type ElectronApplication, type Request } from "@playwright/test";
import { ElectronPlaywrightDriver } from "./electronDriver.js";
import { resolveElectronConfiguration, type ElectronLaunchOptions } from "./electron.js";

export interface ElectronLaunchResult {
	readonly application: ElectronApplication;
	readonly driver: ElectronPlaywrightDriver;
}

/** Launches Ash Desktop through Playwright's Electron adapter. */
export async function launchElectron(options: ElectronLaunchOptions): Promise<ElectronLaunchResult> {
	const configuration = resolveElectronConfiguration(options);
	const application = await _electron.launch({
		args: [...configuration.args],
		cwd: configuration.cwd,
		env: configuration.env,
		executablePath: configuration.executablePath,
		timeout: 30_000,
	});
	let processErrors = '';
	const onProcessError = (chunk: Buffer): void => { processErrors = (processErrors + chunk.toString()).slice(-16_384); };
	application.process().stderr?.on('data', onProcessError);
	try {
		if (options.appServerMode === 'required' && options.workspaceDirectory && options.workspacePermissions === 'development') {
			const workspacePaths = [options.workspaceDirectory, await realpath(options.workspaceDirectory)];
			await application.evaluate(({ dialog }, paths) => {
				const showMessageBox = dialog.showMessageBox.bind(dialog);
				dialog.showMessageBox = (async (...args: [MessageBoxOptions] | [BrowserWindow, MessageBoxOptions]) => {
					const options = args.length === 1 ? args[0] : args[1];
					if (options.message === 'Which capabilities should this directory receive?'
						&& paths.includes(options.detail?.split('\n')[0] ?? '')
						&& options.buttons?.[0] === 'Allow Development Features') {
						return { response: 0, checkboxChecked: false };
					}
					return args.length === 1 ? showMessageBox(args[0]) : showMessageBox(args[0], args[1]);
				}) as typeof dialog.showMessageBox;
			}, workspacePaths);
		}
		const page = application.windows()[0] ?? await application.waitForEvent("window", { timeout: 30_000 });
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
			await driver.workbench.waitForReady();
		} catch (error) {
			const text = await page.locator('body').innerText().catch(() => 'Document is unavailable');
			const details = [
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
			application.process().stderr?.off('data', onProcessError);
		}
		return { application, driver };
	} catch (error) {
		await application.close().catch(() => undefined);
		throw error;
	}
}
