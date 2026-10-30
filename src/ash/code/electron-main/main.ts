import { AshApplication, type AppServerStartupMode } from './app.js';
import { isCancellationError } from '../../base/common/errors.js';
import { app, protocol } from 'electron/main';
import { Schemas } from '../../base/common/network.js';
import { basename, dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import {
	AshApplicationId,
	AshApplicationName,
	AshRendererDirectory,
	AshUserDataFolderName,
} from '../common/application.js';
import { developmentArtifactsPath } from '../../platform/environment/node/developmentArtifacts.js';
import { getDefaultUserDataPath } from '../../platform/environment/node/userDataPath.js';
import { resolveHome } from '../../platform/home/node/home.js';
import { migrateLegacyLocalProfile } from '../../platform/profile/node/localProfile.js';
import { existsSync, watch } from 'node:fs';
import { parseMainProcessArgv, parseLaunchArguments } from '../../platform/environment/node/argvHelper.js';
import { parseWindowLaunch } from '../../platform/launch/electron-main/launchMainService.js';
import { localize2 } from '../../nls.js';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { access, writeFile } from 'node:fs/promises';
import {
	GPUProcessMainService,
	IGPUProcessMainService,
} from '../../platform/gpu/electron-main/gpuProcessMainService.js';
import { InstantiationService } from '../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../platform/instantiation/common/serviceCollection.js';
import { SyncDescriptor } from '../../platform/instantiation/common/descriptors.js';

/** Starts the Electron product and its fixed Workbench/Sessions entries. */
export async function startElectronApplication(): Promise<void> {
	const developmentLauncher = !app.isPackaged && process.env.ASH_DEV_LAUNCHER === '1';
	// This flag describes this process's IPC parent, never a terminal or helper
	// subsequently spawned by the application.
	delete process.env.ASH_DEV_LAUNCHER;
	if (developmentLauncher) {
		if (!process.connected) throw new Error('Development launcher disconnected before startup');
		// Debugger termination can bypass the launcher's signal handlers. The IPC
		// lifetime keeps this development instance from retaining the profile lock.
		process.once('disconnect', () => {
			setTimeout(() => app.exit(0), 5_000).unref();
			app.quit();
		});
	}
	const mainServices = new InstantiationService(
		new ServiceCollection([IGPUProcessMainService, new SyncDescriptor(GPUProcessMainService, [app])]),
	);
	let application: AshApplication | undefined;
	let releaseInstallation: (() => void) | undefined;
	try {
		// Capture GPU exit/recovery before profile I/O or window startup can yield.
		mainServices.get(IGPUProcessMainService);
		protocol.registerSchemesAsPrivileged([
			{
				scheme: Schemas.vscodeWebview,
				privileges: { standard: true, secure: true, supportFetchAPI: true, allowServiceWorkers: true },
			},
		]);
		if (!app.isPackaged) {
			process.env.ASH_HOME ??= developmentArtifactsPath(app.getAppPath(), 'dev', 'profile');
		}
		const profileRoot = resolveHome();
		configureApplicationDataPaths();
		if (app.isPackaged) {
			// Record the actual paths before profile migration creates them.
			// The shared maintenance host protects profiles used by another product.
			const installation =
				process.platform === 'darwin' ? resolve(process.resourcesPath, '..', '..') : dirname(process.execPath);
			const lease = spawn(
				join(
					process.resourcesPath,
					'bin',
					process.platform === 'win32' ? 'ash-app-server-daemon.exe' : 'ash-app-server-daemon',
				),
				[
					'installation',
					'lease',
					'--product',
					'desktop',
					'--root',
					installation,
					'--profile',
					profileRoot,
					'--user-data',
					app.getPath('userData'),
				],
				{ windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
			);
			let closing = false;
			releaseInstallation = () => {
				closing = true;
				lease.stdin.end();
			};
			// will-quit can be prevented while Main flushes state and closes its
			// services. Keep ownership until that shutdown has actually completed.
			app.once('quit', releaseInstallation);
			lease.stdin.on('error', error => {
				if (!closing) {
					console.error('Installation lease disconnected', error);
					app.quit();
				}
			});
			await new Promise<void>((done, fail) => {
				const timeout = setTimeout(() => {
					lease.kill();
					fail(new Error('Installation registration timed out'));
				}, 30_000);
				let output = '';
				let errors = '';
				lease.stdout.setEncoding('utf8').on('data', (chunk: string) => {
					output = (output + chunk).slice(-4096);
					if (output === 'ready\n') {
						clearTimeout(timeout);
						done();
					}
				});
				lease.stderr.setEncoding('utf8').on('data', (chunk: string) => {
					errors = (errors + chunk).slice(-4096);
				});
				lease.once('error', error => {
					clearTimeout(timeout);
					fail(error);
				});
				lease.once('exit', code => {
					clearTimeout(timeout);
					fail(new Error(`Installation registration exited with ${code}: ${errors}`));
					if (!closing && output === 'ready\n') app.quit();
				});
			});
		}
		const migrationConflict = await migrateLegacyLocalProfile({
			legacyUserDataRoot: app.getPath('userData'),
			profileRoot,
		});
		if (migrationConflict)
			console.error(
				`Settings migration conflict: ${migrationConflict.legacyPath} and ${migrationConflict.settingsPath}`,
			);
		const rendererBase = app.isPackaged
			? join(app.getAppPath(), 'dist', 'renderer')
			: developmentArtifactsPath(app.getAppPath(), 'renderer');
		const rendererRoot = app.isPackaged
			? resolvePackagedRendererRoot(rendererBase)
			: join(rendererBase, AshRendererDirectory);
		const appServerStartupMode: AppServerStartupMode =
			process.env.ASH_DESKTOP_UI_ONLY === '1' ? 'disabled' : 'required';

		app.setName(AshApplicationName);
		const initialLaunchArguments = parseMainProcessArgv({
			arguments: process.argv,
			packaging: app.isPackaged ? 'packaged' : 'development',
			appPath: app.getAppPath(),
		});
		const { args } = parseWindowLaunch(
			initialLaunchArguments,
			process.cwd(),
			localize2(
				'taskbar.invalidAgentsArguments',
				'Open the Agents window with --agents-window and an optional --folder or --workspace target. File, window, and wait options cannot be combined with it.',
			).original,
		);
		if (args.wait && !args.waitMarkerFilePath && !developmentLauncher) await addWaitMarker();

		const launchArguments = parseMainProcessArgv({
			arguments: process.argv,
			packaging: app.isPackaged ? 'packaged' : 'development',
			appPath: app.getAppPath(),
		});
		if (!app.requestSingleInstanceLock({ launchArguments, developmentLauncher })) {
			if (developmentLauncher && process.connected && process.send) {
				// A debugger may already have started the replacement while its previous
				// instance is still saving state. Let the launcher wait for that lock.
				await new Promise<void>(done => {
					process.send!('ash:dev:busy', () => done());
				});
				app.quit();
				return;
			}
			const marker = parseLaunchArguments(launchArguments).waitMarkerFilePath;
			if (marker) {
				await waitForMarkerDeletion(marker);
			}
			app.quit();
			return;
		}
		// Supervised retries must not create markers or open their arguments in
		// the previous instance. Only the successful replacement owns this wait.
		if (args.wait && !args.waitMarkerFilePath && developmentLauncher) await addWaitMarker();

		application = await AshApplication.create(
			{ rendererRoot, appServerStartupMode, developmentLauncher },
			mainServices,
		);

		void startup(application, developmentLauncher);
	} finally {
		// Once created, the application owns this scope through shutdown/failure cleanup.
		if (!application) {
			if (releaseInstallation) {
				app.removeListener('quit', releaseInstallation);
				releaseInstallation();
			}
			mainServices.dispose();
		}
	}
}

async function addWaitMarker(): Promise<void> {
	const marker = join(tmpdir(), `ash-wait-${randomUUID()}`);
	await writeFile(marker, '', { flag: 'wx' });
	const separator = process.argv.indexOf('--');
	process.argv.splice(separator < 0 ? process.argv.length : separator, 0, `--waitMarkerFilePath=${marker}`);
}

async function waitForMarkerDeletion(marker: string): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const check = (): void => {
			void access(marker).catch(error => {
				watcher.close();
				if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
					resolve();
				} else {
					reject(error);
				}
			});
		};
		const watcher = watch(dirname(marker), (_event, name) => {
			if (name?.toString() === basename(marker)) {
				check();
			}
		});
		watcher.on('error', error => {
			watcher.close();
			reject(error);
		});
		// Subscribe first, then check: the primary may already have completed the request.
		check();
	});
}

async function startup(application: AshApplication, developmentLauncher: boolean): Promise<void> {
	try {
		await application.startup();
		if (developmentLauncher && process.connected) process.send?.('ash:dev:ready');
	} catch (error) {
		if (isCancellationError(error)) {
			return;
		}
		console.error('Failed to start Ash', error);
		try {
			await application.disposeAfterStartupFailure();
		} catch (cleanupError) {
			console.error('Failed to clean up Ash after startup failure', cleanupError);
		} finally {
			app.exit(1);
		}
	}
}

function configureApplicationDataPaths(): void {
	if (process.platform === 'win32') app.setAppUserModelId(AshApplicationId);
	if (!hasUserDataDirectoryOverride(process.argv)) {
		app.setPath('userData', app.isPackaged ? getDefaultUserDataPath(AshUserDataFolderName) : developmentArtifactsPath(app.getAppPath(), 'dev', 'user-data'));
	}
	const userDataPath = app.getPath('userData');
	app.setPath('sessionData', join(userDataPath, 'session-data'));
	app.setPath('logs', join(userDataPath, 'logs'));
	app.setPath('crashDumps', join(userDataPath, 'crashes'));
}

function hasUserDataDirectoryOverride(args: readonly string[]): boolean {
	return args.some(argument => argument === '--user-data-dir' || argument.startsWith('--user-data-dir='));
}

/** Verifies that a packaged application contains the Workbench and Sessions pages. */
function resolvePackagedRendererRoot(rendererRoot: string): string {
	const packagedRoot = join(rendererRoot, AshRendererDirectory);
	const requiredEntries = [
		join(packagedRoot, 'electron-browser', 'workbench', 'workbench.html'),
		join(packagedRoot, 'sessions', 'electron-browser', 'sessions.html'),
	];
	const missing = requiredEntries.filter(entry => !existsSync(entry));
	if (missing.length > 0) throw new Error(`Packaged Ash renderer is incomplete: ${missing.join(', ')}`);
	return packagedRoot;
}
