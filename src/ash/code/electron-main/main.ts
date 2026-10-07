import { AshApplication, type AppServerStartupMode } from "./app.js";
import { isCancellationError } from '../../base/common/errors.js';
import { app } from 'electron/main';
import { basename, dirname, join } from 'node:path';
import { AshApplicationId, AshApplicationName, AshRendererDirectory, AshSessionsRendererEntry, AshUserDataFolderName } from '../common/application.js';
import { developmentArtifactsPath } from '../../platform/environment/node/developmentArtifacts.js';
import { getDefaultUserDataPath } from '../../platform/environment/node/userDataPath.js';
import { resolveHome } from '../../platform/home/node/home.js';
import { migrateLegacyLocalProfile } from '../../platform/profile/node/localProfile.js';
import { existsSync, watch } from 'node:fs';
import { parseMainProcessArgv, parseLaunchArguments } from '../../platform/environment/node/argvHelper.js';
import { parseWindowLaunch } from '../../platform/launch/electron-main/launchMainService.js';
import { builtinLanguagePackCatalogs } from '../../workbench/services/localization/common/localizationCatalogs.js';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { access, writeFile } from 'node:fs/promises';

/** Starts the Electron product and its fixed Workbench/Sessions entries. */
export async function startElectronApplication(): Promise<void> {
	const profileRoot = resolveHome();
	const migrationConflict = await migrateLegacyLocalProfile({ legacyUserDataRoot: app.getPath('userData'), profileRoot });
	if (migrationConflict) console.error(`Settings migration conflict: ${migrationConflict.legacyPath} and ${migrationConflict.settingsPath}`);
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
	const initialLaunchArguments = parseMainProcessArgv({ arguments: process.argv, packaging: app.isPackaged ? 'packaged' : 'development', appPath: app.getAppPath() });
	const { args } = parseWindowLaunch(initialLaunchArguments, process.cwd(), messages['taskbar.invalidAgentsArguments']!);
	if (args.wait && !args.waitMarkerFilePath) {
		const marker = join(tmpdir(), `ash-wait-${randomUUID()}`);
		await writeFile(marker, '', { flag: 'wx' });
		const separator = process.argv.indexOf('--');
		process.argv.splice(separator < 0 ? process.argv.length : separator, 0, `--waitMarkerFilePath=${marker}`);
	}

	const launchArguments = parseMainProcessArgv({ arguments: process.argv, packaging: app.isPackaged ? 'packaged' : 'development', appPath: app.getAppPath() });
	if (!app.requestSingleInstanceLock({ launchArguments })) {
		const marker = parseLaunchArguments(launchArguments).waitMarkerFilePath;
		if (marker) {
			await waitForMarkerDeletion(marker);
		}
		app.quit();
		return;
	}

	const application = await AshApplication.create({
		rendererRoot,
		appServerStartupMode,
	});

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
		await application.startup();
	} catch (error) {
		if (isCancellationError(error)) { return; }
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
	if (!hasUserDataDirectoryOverride(process.argv)) app.setPath('userData', getDefaultUserDataPath(AshUserDataFolderName));
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
		join(packagedRoot, 'electron-browser', 'sessions', `${AshSessionsRendererEntry}.html`),
	];
	const missing = requiredEntries.filter(entry => !existsSync(entry));
	if (missing.length > 0) throw new Error(`Packaged Ash renderer is incomplete: ${missing.join(', ')}`);
	return packagedRoot;
}
