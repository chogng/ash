import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { isAllowedAppServerEnvironmentKey } from "../common/appServerEnvironment.js";
import type { IAppServerProcessLauncher } from "./appServerProcessLauncher.js";

export interface SpawnLocalAppServerOptions {
	readonly environment: Readonly<Record<string, string>>;
}

export type SpawnLocalAppServer = (executable: string, args: readonly string[], options: SpawnLocalAppServerOptions) => ChildProcessWithoutNullStreams;

export interface LocalAppServerProcessLauncherOptions {
	readonly executable: string;
	readonly args: readonly string[];
	readonly environment: Readonly<Record<string, string>>;
	readonly allowedEnvironmentKeys?: readonly string[];
	readonly spawnProcess?: SpawnLocalAppServer;
	readonly fileExists?: (path: string) => boolean;
	readonly expectedSha256?: string;
	readonly fileSha256?: (path: string) => Promise<string>;
}

/** Launches the packaged App Server directly on the Desktop host. */
export class LocalAppServerProcessLauncher implements IAppServerProcessLauncher {
	private readonly spawnProcess: SpawnLocalAppServer;
	private readonly fileExists: (path: string) => boolean;
	private readonly fileSha256: (path: string) => Promise<string>;
	private executableValue: string;
	private environmentValue: Readonly<Record<string, string>>;

	constructor(readonly options: LocalAppServerProcessLauncherOptions) {
		validateExecutable(options.executable);
		if (options.expectedSha256 !== undefined && !/^[a-f0-9]{64}$/.test(options.expectedSha256)) throw new Error("App Server executable digest must be a SHA-256 hex string");
		this.validateEnvironment(options.environment);
		this.spawnProcess = options.spawnProcess ?? defaultSpawn;
		this.fileExists = options.fileExists ?? existsSync;
		this.fileSha256 = options.fileSha256 ?? sha256File;
		this.executableValue = options.executable;
		this.environmentValue = options.environment;
	}

	get description(): string {
		return this.executableValue;
	}

	get executable(): string {
		return this.executableValue;
	}

	get environment(): Readonly<Record<string, string>> {
		return this.environmentValue;
	}

	/** Selects the immutable authority scope used by the next launched connection. */
	replaceEnvironment(environment: Readonly<Record<string, string>>): void {
		this.validateEnvironment(environment);
		this.environmentValue = environment;
	}

	/** Selects a fully built development generation for the next connection. */
	replaceExecutable(executable: string): void {
		validateExecutable(executable);
		this.executableValue = executable;
	}

	async validate(): Promise<void> {
		if (!this.fileExists(this.executableValue)) throw new Error(`Packaged Ash binary is missing: ${this.executableValue}`);
		if (this.options.expectedSha256 !== undefined) {
			const actual = await this.fileSha256(this.executableValue);
			if (actual !== this.options.expectedSha256) throw new Error(`Packaged Ash binary failed integrity validation: ${this.executableValue}`);
		}
	}

	launch(): ChildProcessWithoutNullStreams {
		return this.spawnProcess(this.executableValue, this.options.args, { environment: this.environmentValue });
	}

	private validateEnvironment(environment: Readonly<Record<string, string>>): void {
		const allowedEnvironmentKeys = this.options.allowedEnvironmentKeys ? new Set(this.options.allowedEnvironmentKeys) : undefined;
		for (const key of Object.keys(environment)) {
			const allowed = allowedEnvironmentKeys ? allowedEnvironmentKeys.has(key) : isAllowedAppServerEnvironmentKey(key);
			if (!allowed) throw new Error(`App Server environment variable is not allowed: ${key}`);
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

function defaultSpawn(executable: string, args: readonly string[], options: SpawnLocalAppServerOptions): ChildProcessWithoutNullStreams {
	return spawn(executable, [...args], { env: { ...options.environment }, shell: false, stdio: "pipe" });
}
