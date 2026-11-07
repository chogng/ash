import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { chromium, expect, type Browser, type Page } from '@playwright/test';
import { detachedProcess, ProcessRun, registerRunResource } from '../../build/processes.ts';
import { appServerDaemonExecutablePath } from '../../src/ash/platform/app-server-daemon/node/appServerDaemonPackage.js';
import { directoryPermissionPrompt } from './dialogs.js';
import { resolveElectronConfiguration, type ElectronLaunchOptions } from './electron.js';
import { WorkbenchDiagnostics } from './playwrightDriver.js';
import { Workbench } from './workbench.js';

interface PackagedDesktop {
	readonly page: Page;
	readonly process: ChildProcess;
	readonly diagnostics: WorkbenchDiagnostics;
	quit(): Promise<void>;
	close(): Promise<void>;
}

/** Connect to the delivered bundle through Chromium CDP. The release executable has no Main inspector. */
export async function launchPackagedDesktop(options: Omit<ElectronLaunchOptions, 'appServerMode'> & { readonly packagedBundle: string; }): Promise<PackagedDesktop> {
	const homeDirectory = options.homeDirectory ?? resolve(options.userDataDirectory, 'home');
	await mkdir(homeDirectory, { recursive: true });
	const configuration = resolveElectronConfiguration({ ...options, homeDirectory, appServerMode: 'required' });
	const profile = options.profileDirectory ?? resolve(options.userDataDirectory, 'profile');
	const daemon = appServerDaemonExecutablePath({
		appPath: configuration.cwd, isPackaged: true, platform: process.platform, resourcesPath: configuration.resourcesPath,
	});
	const resource = await registerRunResource(options.profileDirectory === undefined ? { executable: daemon, profile } : undefined);
	const run = new ProcessRun(configuration.cwd, undefined, 5_000);
	const environment = { ...configuration.env };
	delete environment.NODE_OPTIONS;
	const child = spawn(configuration.executablePath, [
		...configuration.args,
		'--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
	], { cwd: configuration.cwd, env: environment, stdio: ['ignore', 'pipe', 'pipe'], detached: detachedProcess(), windowsHide: true });
	const exited = Promise.withResolvers<void>();
	const endpoint = Promise.withResolvers<string>();
	void endpoint.promise.catch(() => { });
	let output = '';
	const collect = (chunk: Buffer): void => { output = (output + chunk.toString()).slice(-16_384); };
	child.stdout.on('data', collect);
	let stderr = '';
	child.stderr.on('data', (chunk: Buffer) => {
		collect(chunk);
		stderr = (stderr + chunk.toString()).slice(-16_384);
		const match = /DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/\S+)/u.exec(stderr);
		if (match) endpoint.resolve(match[1]!);
	});
	child.once('error', error => { endpoint.reject(error); exited.resolve(); });
	child.once('exit', (code, signal) => {
		endpoint.reject(new Error(`Packaged Ash exited before CDP startup (${code ?? signal})`));
		exited.resolve();
	});

	let browser: Browser | undefined;
	let cleanup: Promise<void> | undefined;
	const close = (): Promise<void> => cleanup ??= (async () => {
		try {
			await run.stop('SIGTERM');
		} finally {
			try {
				await browser?.close();
			} finally {
				try {
					if (options.profileDirectory === undefined) {
						await promisify(execFile)(daemon, ['stop'], { env: { ...environment, ASH_HOME: profile }, timeout: 30_000, windowsHide: true });
					}
				} finally {
					await resource.dispose();
				}
			}
		}
	})();
	const startupTimeout = options.startupTimeout ?? 30_000;
	const deadline = Date.now() + startupTimeout;
	const startup = setTimeout(() => endpoint.reject(new Error('Packaged Ash did not open Chromium CDP')), startupTimeout);
	try {
		await run.own(child);
		await resource.process(child);
		browser = await chromium.connectOverCDP(await endpoint.promise, { timeout: Math.max(1, deadline - Date.now()) });
		const context = browser.contexts()[0]!;
		const diagnostics = new WorkbenchDiagnostics(context);
		const workbenchUrl = /\/workbench\/workbench\.html(?:[?#].*)?$/u;
		let page = context.pages().find(candidate => workbenchUrl.test(candidate.url()));
		if (!page) {
			await expect.poll(() => {
				page = context.pages().find(candidate => workbenchUrl.test(candidate.url()));
				return Boolean(page);
			}, { timeout: Math.max(1, deadline - Date.now()) }).toBe(true);
		}
		assert.ok(page);
		const workbench = new Workbench(page);
		page.setDefaultTimeout(Math.max(1, deadline - Date.now()));
		const ready = workbench.waitForReady();
		if (options.workspaceDirectory && options.workspacePermissions === 'development') {
			const prompt = directoryPermissionPrompt(page);
			await Promise.race([ready, prompt.waitFor({ state: 'visible', timeout: Math.max(1, deadline - Date.now()) })]);
			if (await prompt.isVisible()) await prompt.getByRole('button', { name: /^(?:Trust Folder(?: & Enable Features)?|Trust and Open|信任文件夹|信任并打开)$/u }).click();
		}
		await ready;
		page.setDefaultTimeout(30_000);
		assert.doesNotMatch(output, /^Debugger listening on /mu);
		const connection = browser;
		return {
			page, process: child, diagnostics, close,
			quit: async () => {
				const deadline = Promise.withResolvers<never>();
				const timeout = setTimeout(() => deadline.reject(new Error('Packaged Ash did not exit after Browser.close')), 10_000);
				try {
					const session = await Promise.race([connection.newBrowserCDPSession(), deadline.promise]);
					// Chromium closes the socket as Electron enters its normal app.quit() lifecycle.
					void session.send('Browser.close').catch(() => { });
					await Promise.race([exited.promise, deadline.promise]);
					assert.equal(child.exitCode, 0, `Packaged Ash did not quit cleanly (${child.signalCode})\n${output}`);
				} finally {
					clearTimeout(timeout);
					await close();
				}
			},
		};
	} catch (error) {
		try { await close(); }
		catch (cleanupError) { throw new AggregateError([error, cleanupError], `Packaged Ash startup and cleanup failed\n${output}`); }
		throw new Error(`Packaged Ash startup failed: ${String(error)}\n${output}`, { cause: error });
	} finally {
		clearTimeout(startup);
	}
}
