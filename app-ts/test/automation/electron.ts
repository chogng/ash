import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import type { AppServerTestMode, DesktopWorkbenchMode } from "./testTarget.js";

export interface ElectronLaunchOptions {
	readonly appServerMode: AppServerTestMode;
	readonly userDataDirectory: string;
	readonly profileDirectory?: string;
	readonly workspaceDirectory?: string;
	readonly workspacePermissions?: "development";
	readonly workbenchMode?: DesktopWorkbenchMode;
	readonly extraArgs?: readonly string[];
	readonly recordVideo?: {
		readonly directory: string;
		readonly size: { readonly width: number; readonly height: number };
	};
	/** Owning app-ts package. Scenario bundles pass this explicitly because their output lives outside app-ts. */
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
	const environment = Object.fromEntries(
		Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
	);
	if (bundle) {
		for (const key of Object.keys(environment)) if (key.startsWith('ASH_')) delete environment[key];
		environment.ELECTRON_ENABLE_LOGGING = '1';
		if (process.platform === 'darwin') environment.HOME = options.userDataDirectory;
	}
	if (options.appServerMode === "disabled") {
		environment.ASH_DESKTOP_UI_ONLY = "1";
	} else {
		delete environment.ASH_DESKTOP_UI_ONLY;
	}
	environment.ASH_WORKBENCH_MODE = options.workbenchMode ?? "code";
	environment.ASH_HOME = options.profileDirectory ?? resolve(options.userDataDirectory, "profile");
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
			...(options.workspaceDirectory === undefined ? [] : [`--folder=${options.workspaceDirectory}`]),
			...(options.extraArgs ?? []),
		],
		cwd: bundle ? dirname(bundle) : desktopDirectory,
		env: environment,
		resourcesPath,
	};
}
