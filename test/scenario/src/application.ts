import type { Browser, BrowserContext, ElectronApplication, Page, Video } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { launchBrowser } from '../../automation/playwrightBrowser.ts';
import { launchElectron } from '../../automation/playwrightElectron.ts';
import type { PlaywrightApplication, PlaywrightDriver } from '../../automation/playwrightDriver.ts';
import type { Workbench } from '../../automation/workbench.ts';
import type { RunnerOptions } from './options.ts';

export type JSONValue = string | number | boolean | null | JSONValue[] | { readonly [key: string]: JSONValue; };

export interface ApplicationLaunchOptions {
	readonly runPath: string;
	readonly workspacePath?: string;
	readonly userSettings?: Readonly<Record<string, JSONValue>>;
	readonly extraArgs?: readonly string[];
}

export interface RunningApplication {
	readonly application: PlaywrightApplication;
	readonly driver: PlaywrightDriver;
	readonly workbench: Workbench;
	readonly page: Page;
	readonly context: BrowserContext;
	readonly videoStartedAt?: number;
	readonly target: 'desktop' | 'web';
	readonly diagnosticMessages: readonly string[];
	videoFiles(): readonly Video[];
	close(): Promise<void>;
	dispose(): Promise<void>;
}

const repositoryRoot = resolve(import.meta.dirname, '../../..');
const videoSize = { width: 1440, height: 900 } as const;

export class ApplicationService {
	private running: RunningApplication | undefined;

	constructor(private readonly options: RunnerOptions) { }

	get application(): RunningApplication | undefined {
		return this.running;
	}

	async start(options: ApplicationLaunchOptions): Promise<RunningApplication> {
		if (this.running) {
			throw new Error('An Ash scenario application is already running.');
		}
		assertNoLaunchOverrides(options.extraArgs);
		const videoDirectory = join(options.runPath, '.recordings');
		await mkdir(videoDirectory, { recursive: true });
		this.running = this.options.web
			? await this.startWeb(options, videoDirectory)
			: await this.startDesktop(options, videoDirectory);
		return this.running;
	}

	async stop(): Promise<void> {
		const running = this.running;
		if (!running) {
			return;
		}
		this.running = undefined;
		await running.close();
	}

	private async startDesktop(options: ApplicationLaunchOptions, videoDirectory: string): Promise<RunningApplication> {
		const userDataDirectory = await mkdtemp(join(tmpdir(), 'ash-scenario-'));
		if (options.userSettings) {
			const settingsPath = join(userDataDirectory, 'User', 'settings.json');
			await mkdir(dirname(settingsPath), { recursive: true });
			await writeFile(settingsPath, `${JSON.stringify(options.userSettings, undefined, 2)}\n`, 'utf8');
		}
		try {
			const launched = await launchElectron({
				appServerMode: 'required',
				userDataDirectory,
				workspaceDirectory: options.workspacePath,
				workspacePermissions: options.workspacePath ? 'development' : undefined,
				extraArgs: options.extraArgs,
				recordVideo: { directory: videoDirectory, size: videoSize },
				desktopDirectory: join(repositoryRoot, '.'),
			});
			return createRunningApplication({
				application: launched.application,
				driver: launched.driver,
				videoStartedAt: launched.videoStartedAt,
				target: 'desktop',
				close: launched.close,
				dispose: () => rm(userDataDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
			});
		} catch (error) {
			await rm(userDataDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
			throw error;
		}
	}

	private async startWeb(options: ApplicationLaunchOptions, videoDirectory: string): Promise<RunningApplication> {
		if (options.userSettings) {
			throw new Error('Web scenarios do not yet support pre-seeding user settings.');
		}
		if (options.extraArgs?.length) {
			throw new Error('Web scenarios do not accept desktop command-line arguments.');
		}
		const port = await availablePort();
		const baseURL = `http://127.0.0.1:${port}/`;
		const server = spawn(process.execPath, [
			join(repositoryRoot, 'build/desktop/launch/web.ts'),
			join(repositoryRoot, '.build/desktop/renderer/ash'),
			String(port),
		], { cwd: repositoryRoot, env: { ...process.env, ASH_WEB_APP_SERVER: '0' }, stdio: ['ignore', 'ignore', 'pipe'] });
		let serverErrors = '';
		server.stderr?.on('data', chunk => serverErrors = `${serverErrors}${String(chunk)}`.slice(-16_384));
		try {
			await waitForServer(baseURL, server);
			const launched = await launchBrowser({
				appServerMode: 'disabled',
				baseURL,
				headless: this.options.headless,
				recordVideo: { directory: videoDirectory, size: videoSize },
			});
			return createRunningApplication({
				application: launched.application,
				driver: launched.driver,
				videoStartedAt: launched.videoStartedAt,
				target: 'web',
				close: async () => {
					await launched.application.close();
					await stopProcess(server);
				},
				dispose: async () => undefined,
			});
		} catch (error) {
			await stopProcess(server);
			throw new Error(`${String(error)}${serverErrors ? `\nWeb server:\n${serverErrors}` : ''}`, { cause: error });
		}
	}
}

function createRunningApplication(input: {
	readonly application: Browser | ElectronApplication;
	readonly driver: PlaywrightDriver;
	readonly videoStartedAt?: number;
	readonly target: 'desktop' | 'web';
	readonly close: () => Promise<void>;
	readonly dispose: () => Promise<void>;
}): RunningApplication {
	const { application, driver } = input;
	const context = driver.currentPage.context();
	const videos = new Set<Video>();
	const diagnosticMessages: string[] = [];
	const observe = (page: Page): void => {
		const video = page.video();
		if (video) videos.add(video);
		page.on('console', message => {
			if (message.type() === 'error' || message.type() === 'warning') diagnosticMessages.push(`[console:${message.type()}] ${message.text()}`);
		});
		page.on('pageerror', error => diagnosticMessages.push(`[pageerror] ${error.stack ?? error.message}`));
		page.on('crash', () => diagnosticMessages.push('[crash] Workbench page crashed'));
	};
	for (const page of context.pages()) observe(page);
	context.on('page', observe);
	return {
		application,
		driver,
		workbench: driver.workbench,
		page: driver.currentPage,
		context,
		videoStartedAt: input.videoStartedAt,
		target: input.target,
		diagnosticMessages,
		videoFiles: () => [...videos],
		close: input.close,
		dispose: input.dispose,
	};
}

function assertNoLaunchOverrides(arguments_: readonly string[] | undefined): void {
	for (const option of ['--user-data-dir', '--folder']) {
		if (arguments_?.some(argument => argument === option || argument.startsWith(`${option}=`))) {
			throw new Error(`Scenario extraArgs cannot override the isolated '${option}' launch value.`);
		}
	}
}

async function availablePort(): Promise<number> {
	return new Promise((resolvePort, reject) => {
		const server = createServer();
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			if (!address || typeof address === 'string') {
				server.close();
				reject(new Error('Could not reserve a Web scenario port.'));
				return;
			}
			server.close(error => error ? reject(error) : resolvePort(address.port));
		});
	});
}

async function waitForServer(url: string, process: ChildProcess): Promise<void> {
	const deadline = Date.now() + 120_000;
	while (Date.now() < deadline) {
		if (process.exitCode !== null) throw new Error(`Web server exited with code ${process.exitCode}.`);
		try {
			const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
			if (response.ok) return;
		} catch { }
		await new Promise(resolveWait => setTimeout(resolveWait, 100));
	}
	throw new Error(`Web server did not become ready at ${url}.`);
}

async function stopProcess(process: ChildProcess): Promise<void> {
	if (process.exitCode !== null || process.signalCode !== null) return;
	await new Promise<void>(resolveStop => {
		const timeout = setTimeout(() => process.kill('SIGKILL'), 5_000);
		process.once('close', () => { clearTimeout(timeout); resolveStop(); });
		process.kill('SIGTERM');
	});
}
