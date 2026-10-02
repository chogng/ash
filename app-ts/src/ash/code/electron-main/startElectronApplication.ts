import { AshApplication, type AppServerStartupMode } from "./app.js";
import { app } from 'electron/main';
import { basename, dirname, join } from 'node:path';
import { AshApplicationId, AshApplicationName, AshRendererDirectory } from '../common/application.js';
import { developmentArtifactsPath } from '../../platform/environment/node/developmentArtifacts.js';
import type { WorkbenchModeId } from '../../workbench/common/workbenchMode.js';
import { resolveApplicationDataPaths, resolvePackagedRendererRoot } from './applicationPaths.js';
import { electronWorkspaceLaunchArguments, parseElectronWindowLaunch } from './electronWindowLaunch.js';
import { builtinLanguagePackCatalogs } from '../../workbench/services/localization/common/localizationCatalogs.js';
import { parseLaunchArguments } from '../../platform/environment/node/argvHelper.js';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { watch } from 'node:fs';
import { access, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export interface StartElectronApplicationOptions {
	readonly initialModeId: WorkbenchModeId;
}

/** Starts the shared Electron application with one selected initial Workbench mode. */
export async function startElectronApplication(options: StartElectronApplicationOptions): Promise<void> {
	const rendererBase = app.isPackaged
		? join(app.getAppPath(), 'dist', 'renderer')
		: developmentArtifactsPath(app.getAppPath(), 'renderer');
	const rendererRoot = app.isPackaged
		? resolvePackagedRendererRoot(rendererBase)
		: join(rendererBase, AshRendererDirectory);
	const appServerStartupMode: AppServerStartupMode = process.env.ASH_DESKTOP_UI_ONLY === '1'
		? 'disabled'
		: 'required';

	app.setName(AshApplicationName);
	configureApplicationDataPaths();
	const messages = builtinLanguagePackCatalogs.find(catalog => catalog.locale === 'en')!.bundles.ash!;
	const initialLaunchArguments = electronWorkspaceLaunchArguments({ arguments: process.argv, packaging: app.isPackaged ? 'packaged' : 'development', appPath: app.getAppPath() });
	const { args } = parseElectronWindowLaunch(initialLaunchArguments, process.cwd(), messages['taskbar.invalidAgentsArguments']!);
	if (args.wait && !args.waitMarkerFilePath) {
		const marker = join(tmpdir(), `ash-wait-${randomUUID()}`);
		await writeFile(marker, '', { flag: 'wx' });
		const separator = process.argv.indexOf('--');
		process.argv.splice(separator < 0 ? process.argv.length : separator, 0, `--waitMarkerFilePath=${marker}`);
	}

	const launchArguments = electronWorkspaceLaunchArguments({ arguments: process.argv, packaging: app.isPackaged ? 'packaged' : 'development', appPath: app.getAppPath() });
	if (!app.requestSingleInstanceLock({ launchArguments })) {
		const marker = parseLaunchArguments(launchArguments).waitMarkerFilePath;
		if (marker) {
			await waitForMarkerDeletion(marker);
		}
		app.quit();
		return;
	}

	const application = AshApplication.create({
		initialModeId: options.initialModeId,
		rendererRoot,
		appServerStartupMode,
	});

	app.on('second-instance', (_event, arguments_, cwd, data) => {
		if (data && typeof data === 'object' && 'launchArguments' in data) {
			if (!Array.isArray(data.launchArguments) || !data.launchArguments.every((argument: unknown) => typeof argument === 'string')) {
				throw new TypeError('Invalid launch arguments from another process');
			}
			application.handleLaunchArguments(data.launchArguments, cwd);
		} else {
			application.handleSecondInstance(arguments_, cwd);
		}
	});
	app.on('open-file', (event, file) => {
		event.preventDefault();
		application.handleLaunchArguments([`--file-uri=${pathToFileURL(file)}`], process.cwd());
	});
	app.on('open-url', (event, url) => {
		event.preventDefault();
		application.handleLaunchArguments([`--open-url=${url}`], process.cwd());
	});
	app.on('activate', () => application.handleActivate());
	app.on('window-all-closed', () => application.handleWindowAllClosed());
	void startup(application);
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

async function startup(application: AshApplication): Promise<void> {
	try {
		await app.whenReady();
		await application.startupAfterReady();
	} catch (error) {
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
	const paths = resolveApplicationDataPaths(app.getPath('appData'));
	if (!hasUserDataDirectoryOverride(process.argv)) app.setPath('userData', paths.userDataPath);
	const userDataPath = app.getPath('userData');
	app.setPath('sessionData', join(userDataPath, 'session-data'));
	app.setPath('logs', join(userDataPath, 'logs'));
	app.setPath('crashDumps', join(userDataPath, 'crashes'));
}

function hasUserDataDirectoryOverride(args: readonly string[]): boolean {
	return args.some(argument => argument === '--user-data-dir' || argument.startsWith('--user-data-dir='));
}
