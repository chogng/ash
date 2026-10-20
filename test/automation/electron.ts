import { dirname, join, resolve } from "node:path";
import { mkdirSync } from 'node:fs';
import { createTestEnvironment } from './testEnvironment.ts';
import type { AppServerTestMode } from "./testTarget.js";
import { resolveDevelopmentElectronExecutable } from '../../build/desktop/electron.ts';

export type ElectronWindowMode = 'hidden' | 'inactive' | 'active';

export interface ElectronLaunchOptions {
	readonly appServerMode: AppServerTestMode;
	/** Ordinary tests keep credentials in memory. Persistence scenarios opt out explicitly. */
	readonly useInMemorySecretStorage?: boolean;
	/** Ordinary runs hide windows; system focus/fullscreen tests opt into active. */
	readonly windowMode?: ElectronWindowMode;
	/** Scenario-specific host inputs; the launcher still isolates the test home/profile. */
	readonly environment?: Readonly<NodeJS.ProcessEnv>;
	/** Total budget for process launch and Workbench restoration. */
	readonly startupTimeout?: number;
	readonly userDataDirectory: string;
	readonly profileDirectory?: string;
	/** Explicit opt-in for real-model scenarios; ordinary tests keep account storage isolated. */
	readonly externalCodexHome?: string;
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
	// A long smoke run can pin a copy of this checkout's prepared product artifacts.
	const desktopDirectory = options.desktopDirectory ?? (options.environment ?? process.env).ASH_SMOKE_DESKTOP_DIRECTORY ?? resolve(import.meta.dirname, "../..");
	const bundle = options.packagedBundle && resolve(options.packagedBundle);
	const resourcesPath = bundle ? process.platform === 'darwin' ? join(bundle, 'Contents', 'Resources') : join(bundle, 'resources') : '';
	const electronExecutablePath = bundle
		? process.platform === 'darwin' ? join(bundle, 'Contents', 'MacOS', 'Ash') : join(bundle, 'Ash.exe')
		: resolveDevelopmentElectronExecutable(desktopDirectory);
	const environment = createTestEnvironment(options.userDataDirectory, options.environment ?? process.env, options.externalCodexHome);
	if (process.platform === 'win32') {
		// Known-folder APIs verify this directory exists before returning LocalAppData
		// to backend services such as the cross-process Git operation lock.
		mkdirSync(join(options.userDataDirectory, 'AppData', 'Local'), { recursive: true });
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
	delete environment.ASH_USE_INMEMORY_SECRETSTORAGE;
	const isDebug = Boolean(environment.PWDEBUG && environment.PWDEBUG !== '0');
	const windowMode = options.windowMode ?? (isDebug ? 'active' : 'hidden');
	delete environment.ASH_TEST_WINDOW_MODE;
	if (windowMode !== 'active') environment.ASH_TEST_WINDOW_MODE = windowMode;

	return {
		executablePath: electronExecutablePath,
		args: [
			"--disable-gpu",
			"--in-process-gpu",
			...(options.useInMemorySecretStorage === false ? [] : ['--use-inmemory-secretstorage']),
			// Chromium cookie encryption bypasses the application's credential service.
			// Test profiles use the native test facility rather than a system keychain.
			...(process.platform === 'darwin' ? ['--use-mock-keychain'] : process.platform === 'linux' ? ['--password-store=basic'] : []),
			// Keep the preload value in the switch: packaged Electron can retain Node
			// switches in argv, where a separate value would become a file to open.
			...(windowMode === 'active' ? [] : [`--require=${join(desktopDirectory, 'test', 'automation', 'electronWindow.cjs')}`]),
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
