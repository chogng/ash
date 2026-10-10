import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { mkdirSync } from 'node:fs';
import { createTestEnvironment } from './testEnvironment.js';
import type { AppServerTestMode } from "./testTarget.js";

export interface ElectronLaunchOptions {
	readonly appServerMode: AppServerTestMode;
	/** Total budget for process launch and Workbench restoration. */
	readonly startupTimeout?: number;
	readonly userDataDirectory: string;
	readonly profileDirectory?: string;
	/** Public product configuration, selected before the profile daemon starts. */
	readonly productServicesPath?: string;
	readonly workspaceDirectory?: string;
	readonly workspacePermissions?: "development";
	readonly extraArgs?: readonly string[];
	readonly recordVideo?: {
		readonly directory: string;
		readonly size: { readonly width: number; readonly height: number; };
	};
	/** Repository application root. Scenario bundles pass this explicitly because their output lives elsewhere. */
	readonly desktopDirectory?: string;
	/** Launch the delivered executable and resolve all helpers from its resources. */
	readonly packagedBundle?: string;
}

export interface ElectronConfiguration {
	readonly executablePath: string;
	readonly args: readonly string[];
	readonly cwd: string;
	readonly env: Readonly<Record<string, string>>;
	readonly resourcesPath: string;
}

/** Resolves the Electron executable, arguments, and environment for a test run. */
export function resolveElectronConfiguration(options: ElectronLaunchOptions): ElectronConfiguration {
	const desktopDirectory = options.desktopDirectory ?? resolve(import.meta.dirname, "../..");
	const bundle = options.packagedBundle && resolve(options.packagedBundle);
	const resourcesPath = bundle ? process.platform === 'darwin' ? join(bundle, 'Contents', 'Resources') : join(bundle, 'resources') : '';
	const electronExecutablePath = bundle
		? process.platform === 'darwin' ? join(bundle, 'Contents', 'MacOS', 'Ash') : join(bundle, 'Ash.exe')
		: createRequire(resolve(desktopDirectory, "package.json"))("electron") as string;
	const environment = createTestEnvironment(options.userDataDirectory, process.env);
	if (process.platform === 'win32') {
		// Windows cannot begin a Jump List transaction without its destination stores
		// beneath the isolated USERPROFILE. Keep Shell data inside the test home too.
		for (const store of ['AutomaticDestinations', 'CustomDestinations']) {
			mkdirSync(join(options.userDataDirectory, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Recent', store), { recursive: true });
		}
	}
	if (bundle) {
		for (const key of Object.keys(environment)) if (key.startsWith('ASH_')) delete environment[key];
		environment.ELECTRON_ENABLE_LOGGING = '1';
	}
	if (options.appServerMode === "disabled") {
		environment.ASH_DESKTOP_UI_ONLY = "1";
	} else {
		delete environment.ASH_DESKTOP_UI_ONLY;
	}
	environment.ASH_HOME = options.profileDirectory ?? resolve(options.userDataDirectory, "profile");
	if (options.productServicesPath) environment.ASH_PRODUCT_SERVICES_PATH = options.productServicesPath;
	delete environment.ASH_PROFILE_ROOT;
	delete environment.ELECTRON_RUN_AS_NODE;
	delete environment.ASH_RENDERER_URL;

	return {
		executablePath: electronExecutablePath,
		args: [
			"--disable-gpu",
			"--in-process-gpu",
			...(bundle ? [] : [desktopDirectory]),
			`--user-data-dir=${options.userDataDirectory}`,
			// AppKit's recovery prompt can block ready after test-owned processes are terminated.
			// Keep this launch isolated from macOS saved UI; Ash restores its own profile state.
			...(process.platform === 'darwin' ? ['-ApplePersistenceIgnoreState', 'YES'] : []),
			...(options.workspaceDirectory === undefined ? [] : [`--folder=${options.workspaceDirectory}`]),
			...(options.extraArgs ?? []),
		],
		cwd: bundle ? dirname(bundle) : desktopDirectory,
		env: environment,
		resourcesPath,
	};
}
