import { AshApplication, type AppServerStartupMode } from "./app.js";
import { app } from 'electron/main';
import { join } from 'node:path';
import { AshApplicationId, AshApplicationName, AshRendererDirectory } from '../common/application.js';
import { developmentArtifactsPath } from '../../platform/environment/node/developmentArtifacts.js';
import type { WorkbenchModeId } from '../../workbench/common/workbenchMode.js';
import { resolveApplicationDataPaths, resolvePackagedRendererRoot } from './applicationPaths.js';

export interface StartElectronApplicationOptions {
	readonly initialModeId: WorkbenchModeId;
}

/** Starts the shared Electron application with one selected initial Workbench mode. */
export function startElectronApplication(options: StartElectronApplicationOptions): void {
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

	if (!app.requestSingleInstanceLock()) {
		app.quit();
		return;
	}

	const application = AshApplication.create({
		initialModeId: options.initialModeId,
		rendererRoot,
		appServerStartupMode,
	});

	app.on('second-instance', (_event, arguments_, cwd) => application.handleSecondInstance(arguments_, cwd));
	app.on('activate', () => application.handleActivate());
	app.on('window-all-closed', () => application.handleWindowAllClosed());
	void startup(application);
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
