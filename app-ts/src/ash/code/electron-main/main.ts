import { AshApplication, type AppServerStartupMode } from "./app.js";
import { isCancellationError } from '../../base/common/errors.js';
import { app } from 'electron/main';
import { basename, dirname, join } from 'node:path';
import { AshApplicationId, AshApplicationName, AshRendererDirectory, AshUserDataFolderName } from '../common/application.js';
import { developmentArtifactsPath } from '../../platform/environment/node/developmentArtifacts.js';
import { migrateAcademicWorkbenchSettings } from '../../workbench/common/workbenchModeMigration.js';
import { WorkbenchModeConfigurationKey, WorkbenchModeRegistry, type WorkbenchModeId } from '../../workbench/common/workbenchMode.js';
import { ConfigurationMainService } from '../../platform/configuration/electron-main/configurationMainService.js';
import { getDefaultUserDataPath } from '../../platform/environment/node/userDataPath.js';
import { resolveHome } from '../../platform/home/node/home.js';
import { migrateLegacyLocalProfile } from '../../platform/profile/node/localProfile.js';
import { parseJsonc } from '../../base/common/jsonc.js';
import { readFileSync, existsSync, watch } from 'node:fs';
import { parseMainProcessArgv, parseLaunchArguments } from '../../platform/environment/node/argvHelper.js';
import { parseWindowLaunch } from '../../platform/launch/electron-main/launchMainService.js';
import { builtinLanguagePackCatalogs } from '../../workbench/services/localization/common/localizationCatalogs.js';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { access, writeFile } from 'node:fs/promises';

export interface StartElectronApplicationOptions {
	readonly initialModeId?: WorkbenchModeId;
}

/** Starts the shared Electron application with one selected initial Workbench mode. */
export async function startElectronApplication(options: StartElectronApplicationOptions = {}): Promise<void> {
	const profileRoot = resolveHome();
	const migrationConflict = await migrateLegacyLocalProfile({ legacyUserDataRoot: app.getPath('userData'), profileRoot });
	if (migrationConflict) console.error(`Settings migration conflict: ${migrationConflict.legacyPath} and ${migrationConflict.settingsPath}`);
	const settings = await ConfigurationMainService.create({ filePath: join(profileRoot, 'settings.json') });
	try {
		const snapshot = settings.read();
		const source = migrateAcademicWorkbenchSettings(snapshot.document.source);
		if (source !== undefined) { await settings.update({ expectedRevision: snapshot.revision, document: { version: 1, source } }); }
	} finally { await settings.close(); }
	const initialModeId = options.initialModeId ?? (!app.isPackaged && process.env.ASH_WORKBENCH_MODE !== undefined
		? WorkbenchModeRegistry.resolveModeId(process.env.ASH_WORKBENCH_MODE)
		: readPersistedWorkbenchModeId(join(profileRoot, 'settings.json'), WorkbenchModeRegistry.defaultModeId));
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
		initialModeId,
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

/** Reads the preferred startup mode without making the full configuration service a bootstrap dependency. */
function readPersistedWorkbenchModeId(configurationFilePath: string, fallback: WorkbenchModeId): WorkbenchModeId {
	let candidate: unknown;
	try {
		const document = parseJsonc(readFileSync(configurationFilePath, 'utf8'), 'settings');
		candidate = readConfigurationValue(document, WorkbenchModeConfigurationKey);
	} catch {
		return fallback;
	}
	return WorkbenchModeRegistry.isModeId(candidate) ? candidate : fallback;
}

function readConfigurationValue(document: unknown, key: string): unknown {
	if (typeof document !== 'object' || document === null || Array.isArray(document)) return undefined;
	return (document as Readonly<Record<string, unknown>>)[key];
}

/** Verifies that a packaged application contains the shared Workbench and each mode-owned entry. */
function resolvePackagedRendererRoot(rendererRoot: string): string {
	const packagedRoot = join(rendererRoot, AshRendererDirectory);
	const requiredEntries = [
		join(packagedRoot, 'electron-browser', 'workbench', 'workbench.html'),
		...WorkbenchModeRegistry.definitions.flatMap(mode => mode.dedicatedSessions
			? [join(packagedRoot, 'electron-browser', 'sessions', `${mode.dedicatedSessions.rendererEntry}.html`)]
			: []),
	];
	const missing = requiredEntries.filter(entry => !existsSync(entry));
	if (missing.length > 0) throw new Error(`Packaged Ash renderer is incomplete: ${missing.join(', ')}`);
	return packagedRoot;
}
