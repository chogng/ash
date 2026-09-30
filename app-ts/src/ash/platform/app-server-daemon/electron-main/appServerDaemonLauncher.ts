import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { buildAppServerEnvironment, isAllowedAppServerEnvironmentKey, type AppServerHostPlatform } from '../../app-server/common/appServerEnvironment.js';
import type { IAppServerProcessLauncher } from '../../app-server/electron-main/appServerProcessLauncher.js';
import { appServerDaemonExecutablePath, appServerExecutablePath, developmentAppServerGenerationPath, packagedAppServerDaemonSha256, packagedAppServerSha256, type AppServerDaemonPackageLocation } from '../node/appServerDaemonPackage.js';
import { readDevelopmentAppServerGenerationSync, selectDevelopmentAppServerExecutable } from './developmentAppServerReloader.js';

interface AppServerDaemonConnectionOptions {
	readonly packageLocation: AppServerDaemonPackageLocation;
	readonly sourceEnvironment: Readonly<Record<string, string | undefined>>;
	readonly profileRoot: string;
	readonly electronExecutable: string;
	readonly workspaceRoot?: string;
	readonly role: 'workbench' | 'agents';
}

/** Creates a connection carrier; stopping it leaves the profile's shared backend running. */
export function createAppServerDaemonLauncher(options: AppServerDaemonConnectionOptions): { readonly launcher: AppServerDaemonLauncher; readonly generationFile: string | undefined } {
	const { packageLocation, sourceEnvironment } = options;
	const generationFile = !packageLocation.isPackaged && sourceEnvironment.ASH_DEV_APP_SERVER_RELOAD === '1'
		? developmentAppServerGenerationPath(packageLocation.appPath)
		: undefined;
	let developmentExecutable: string | undefined;
	if (generationFile) {
		try {
			developmentExecutable = readDevelopmentAppServerGenerationSync(generationFile);
		} catch (error) {
			console.error('[app-server] Ignoring invalid development generation', error);
		}
	}
	const backendSha256 = packagedAppServerSha256(packageLocation);
	const productEnvironment: Record<string, string> = {
		ASH_ELECTRON_RUN_AS_NODE_PATH: options.electronExecutable,
		ASH_APP_SERVER_PATH: selectDevelopmentAppServerExecutable(appServerExecutablePath(packageLocation), developmentExecutable),
		ASH_HOME: options.profileRoot,
	};
	for (const key of ['ASH_RG_PATH', 'ASH_SSH_PATH', 'ASH_PRODUCT_SERVICES_PATH'] as const) {
		const value = sourceEnvironment[key];
		if (value) {
			productEnvironment[key] = value;
		}
	}
	if (backendSha256) {
		productEnvironment.ASH_APP_SERVER_SHA256 = backendSha256;
	}
	if (options.workspaceRoot !== undefined) {
		productEnvironment.ASH_WORKSPACE_ROOT = options.workspaceRoot;
		productEnvironment.ASH_DIR_GRANT_SOURCE = 'userConfig';
	}
	if (options.role === 'agents') {
		productEnvironment.ASH_APP_SERVER_CONNECTION_ROLE = 'agents';
	}
	let hostPlatform: AppServerHostPlatform;
	switch (packageLocation.platform) {
		case 'win32': hostPlatform = 'windows'; break;
		case 'darwin': hostPlatform = 'macos'; break;
		case 'linux': hostPlatform = 'linux'; break;
		default: throw new Error(`Unsupported App Server host platform: ${packageLocation.platform}`);
	}
	return {
		launcher: new AppServerDaemonLauncher({
			executable: appServerDaemonExecutablePath(packageLocation),
			expectedSha256: packagedAppServerDaemonSha256(packageLocation),
			// Development selects the current build; released clients reuse the profile's selected backend.
			args: [packageLocation.isPackaged ? 'connect' : 'connect-selected'],
			environment: buildAppServerEnvironment(sourceEnvironment, hostPlatform, productEnvironment, 'desktop'),
		}),
		generationFile,
	};
}

interface SpawnAppServerDaemonOptions {
	readonly environment: Readonly<Record<string, string>>;
}

type SpawnAppServerDaemon = (executable: string, args: readonly string[], options: SpawnAppServerDaemonOptions) => ChildProcessWithoutNullStreams;

interface AppServerDaemonLauncherOptions {
	readonly executable: string;
	readonly args: readonly string[];
	readonly environment: Readonly<Record<string, string>>;
	readonly spawnProcess?: SpawnAppServerDaemon;
	readonly fileExists?: (path: string) => boolean;
	readonly expectedSha256?: string;
	readonly fileSha256?: (path: string) => Promise<string>;
}

/** Launches the packaged daemon command used by the Desktop connection. */
export class AppServerDaemonLauncher implements IAppServerProcessLauncher {
	private readonly spawnProcess: SpawnAppServerDaemon;
	private readonly fileExists: (path: string) => boolean;
	private readonly fileSha256: (path: string) => Promise<string>;
	private environmentValue: Readonly<Record<string, string>>;

	constructor(readonly options: AppServerDaemonLauncherOptions) {
		validateExecutable(options.executable);
		if (options.expectedSha256 !== undefined && !/^[a-f0-9]{64}$/.test(options.expectedSha256)) throw new Error("App Server executable digest must be a SHA-256 hex string");
		this.validateEnvironment(options.environment);
		this.spawnProcess = options.spawnProcess ?? defaultSpawn;
		this.fileExists = options.fileExists ?? existsSync;
		this.fileSha256 = options.fileSha256 ?? sha256File;
		this.environmentValue = options.environment;
	}

	get description(): string {
		return this.options.executable;
	}

	get executable(): string {
		return this.options.executable;
	}

	get environment(): Readonly<Record<string, string>> {
		return this.environmentValue;
	}

	/** Selects the immutable authority scope used by the next launched connection. */
	replaceEnvironment(environment: Readonly<Record<string, string>>): void {
		this.validateEnvironment(environment);
		this.environmentValue = environment;
	}

	async validate(): Promise<void> {
		if (!this.fileExists(this.executable)) throw new Error(`Packaged Ash binary is missing: ${this.executable}`);
		if (this.options.expectedSha256 !== undefined) {
			const actual = await this.fileSha256(this.executable);
			if (actual !== this.options.expectedSha256) throw new Error(`Packaged Ash binary failed integrity validation: ${this.executable}`);
		}
	}

	launch(): ChildProcessWithoutNullStreams {
		return this.spawnProcess(this.executable, this.options.args, { environment: this.environmentValue });
	}

	private validateEnvironment(environment: Readonly<Record<string, string>>): void {
		for (const key of Object.keys(environment)) {
			if (!isAllowedAppServerEnvironmentKey(key)) throw new Error(`App Server environment variable is not allowed: ${key}`);
		}
	}
}

function sha256File(path: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const digest = createHash("sha256");
		const stream = createReadStream(path);
		stream.on("data", chunk => digest.update(chunk));
		stream.on("error", reject);
		stream.on("end", () => resolve(digest.digest("hex")));
	});
}

function validateExecutable(executable: string): void {
	if (!isAbsolute(executable)) throw new Error("App Server executable path must be absolute");
}

function defaultSpawn(executable: string, args: readonly string[], options: SpawnAppServerDaemonOptions): ChildProcessWithoutNullStreams {
	return spawn(executable, [...args], { env: { ...options.environment }, shell: false, stdio: "pipe" });
}
