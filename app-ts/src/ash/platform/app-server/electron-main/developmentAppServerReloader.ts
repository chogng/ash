import { execFile } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, statSync, watch } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { Disposable, type IDisposable, toDisposable } from "../../../base/common/lifecycle.js";
import type { AppServerConnectionRelay } from "../../app-server/electron-main/appServerConnectionRelay.js";
import type { LocalAppServerProcessLauncher } from "../../app-server/electron-main/localAppServerProcessLauncher.js";

const MAX_GENERATION_BYTES = 4_096;
const execFileAsync = promisify(execFile);
type DevelopmentAppServerConnectionRelay = Pick<AppServerConnectionRelay, "onStateChange" | "start" | "state" | "stop">;
type RestartManagedDaemon = (launcher: LocalAppServerProcessLauncher) => Promise<void>;

export interface DevelopmentAppServerReloaderOptions {
	readonly generationFile: string;
	readonly launcher: LocalAppServerProcessLauncher;
	readonly supervisor: DevelopmentAppServerConnectionRelay;
	readonly debounceMs?: number;
	readonly watchGeneration?: (generationFile: string, listener: () => void) => IDisposable;
	readonly readGeneration?: (generationFile: string) => Promise<string | undefined>;
	readonly restartDaemon?: RestartManagedDaemon;
	readonly log?: (message: string, error?: unknown) => void;
}

/** Restarts one local App Server connection when a complete Rust generation is published. */
export class DevelopmentAppServerReloader extends Disposable {
	private readonly debounceMs: number;
	private readonly readGeneration: (generationFile: string) => Promise<string | undefined>;
	private readonly log: (message: string, error?: unknown) => void;
	private timeout?: NodeJS.Timeout;
	private pendingExecutable?: string;
	private drainPromise?: Promise<void>;

	constructor(private readonly options: DevelopmentAppServerReloaderOptions) {
		super();
		this.debounceMs = positiveInteger(options.debounceMs, 200, "debounceMs");
		this.readGeneration = options.readGeneration ?? readDevelopmentAppServerGeneration;
		this.log = options.log ?? ((message, error) => error === undefined ? console.info(message) : console.error(message, error));
		this._register((options.watchGeneration ?? watchGenerationFile)(options.generationFile, () => this.schedule()));
		this._register(options.supervisor.onStateChange(state => {
			if (this.pendingExecutable && isStableState(state)) void this.ensureDrain().catch(error => this.log("[app-server] Development restart failed", error));
		}));
		this._register(toDisposable(() => {
			if (this.timeout) clearTimeout(this.timeout);
		}));
	}

	/** Applies the newest published generation and resolves after any queued restart. */
	async reloadNow(): Promise<void> {
		if (this.isDisposed) return;
		const executable = await this.readGeneration(this.options.generationFile);
		if (!executable || executable === this.options.launcher.environment.ASH_APP_SERVER_PATH) return;
		this.pendingExecutable = executable;
		await this.ensureDrain();
	}

	private schedule(): void {
		if (this.isDisposed) return;
		if (this.timeout) clearTimeout(this.timeout);
		this.timeout = setTimeout(() => {
			this.timeout = undefined;
			void this.reloadNow().catch(error => this.log("[app-server] Development restart failed", error));
		}, this.debounceMs);
	}

	private async drain(): Promise<void> {
		while (!this.isDisposed && this.pendingExecutable) {
			const executable = this.pendingExecutable;
			if (!isStableState(this.options.supervisor.state)) return;
			this.pendingExecutable = undefined;
			if (this.options.supervisor.state === "stopped") {
				this.options.launcher.replaceEnvironment({ ...this.options.launcher.environment, ASH_APP_SERVER_PATH: executable });
				this.log(`[app-server] Selected ${basename(executable)} for initial startup`);
				continue;
			}
			await restartDevelopmentAppServer(this.options.supervisor, this.options.launcher, executable, this.options.restartDaemon);
			this.log(`[app-server] Restarted ${basename(executable)}`);
		}
	}

	private ensureDrain(): Promise<void> {
		if (this.drainPromise) return this.drainPromise;
		const drain = this.drain();
		this.drainPromise = drain;
		void drain.then(
			() => this.completeDrain(drain),
			() => this.completeDrain(drain),
		);
		return drain;
	}

	private completeDrain(drain: Promise<void>): void {
		if (this.drainPromise !== drain) return;
		this.drainPromise = undefined;
		if (this.pendingExecutable && isStableState(this.options.supervisor.state) && !this.isDisposed) {
			void this.ensureDrain().catch(error => this.log("[app-server] Development restart failed", error));
		}
	}

}

export async function readDevelopmentAppServerGeneration(generationFile: string): Promise<string | undefined> {
	let contents: string;
	try {
		contents = await readFile(generationFile, "utf8");
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return undefined;
		throw error;
	}
	return parseDevelopmentAppServerGeneration(generationFile, contents);
}

export function readDevelopmentAppServerGenerationSync(generationFile: string): string | undefined {
	let contents: string;
	try {
		contents = readFileSync(generationFile, "utf8");
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return undefined;
		throw error;
	}
	return parseDevelopmentAppServerGeneration(generationFile, contents);
}

/** Prefers a development generation only when it is newer than the freshly assembled package. */
export function selectDevelopmentAppServerExecutable(packagedExecutable: string, developmentExecutable: string | undefined): string {
	if (!developmentExecutable) return packagedExecutable;
	try {
		return statSync(developmentExecutable).mtimeMs > statSync(packagedExecutable).mtimeMs
			? developmentExecutable
			: packagedExecutable;
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT" && existsSync(developmentExecutable)) return developmentExecutable;
		throw error;
	}
}

export async function restartDevelopmentAppServer(
	supervisor: Pick<AppServerConnectionRelay, "start" | "stop">,
	launcher: LocalAppServerProcessLauncher,
	executable: string,
	restartDaemon: RestartManagedDaemon = restartManagedDaemon,
): Promise<void> {
	if (launcher.environment.ASH_APP_SERVER_PATH === executable) return;
	const previous = launcher.environment;
	await supervisor.stop();
	launcher.replaceEnvironment({ ...launcher.environment, ASH_APP_SERVER_PATH: executable });
	try {
		await restartDaemon(launcher);
		await supervisor.start();
	} catch (error) {
		await supervisor.stop().catch(() => {});
		launcher.replaceEnvironment(previous);
		try {
			await restartDaemon(launcher);
			await supervisor.start();
		} catch (rollbackError) {
			throw new AggregateError([error, rollbackError], "Development App Server restart and rollback both failed");
		}
		throw error;
	}
}

async function restartManagedDaemon(launcher: LocalAppServerProcessLauncher): Promise<void> {
	await execFileAsync(launcher.executable, ["restart"], {
		env: { ...launcher.environment },
		maxBuffer: 1_048_576,
		timeout: 40_000,
		windowsHide: true,
	});
}

function watchGenerationFile(generationFile: string, listener: () => void): IDisposable {
	const directory = dirname(generationFile);
	const file = basename(generationFile);
	mkdirSync(directory, { recursive: true });
	const watcher = watch(directory, (_event, changed) => {
		if (changed === null || changed.toString() === file) listener();
	});
	return toDisposable(() => watcher.close());
}

function isExactGeneration(value: unknown): value is { readonly version: 1; readonly executable: string } {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	if (Object.keys(record).sort().join(",") !== "executable,version") return false;
	if (record.version !== 1 || typeof record.executable !== "string") return false;
	return record.executable === basename(record.executable)
		&& /^ash-app-server(?:\.\d+\.\d+|\.[a-f0-9]{64})(?:\.exe)?$/u.test(record.executable);
}

function parseDevelopmentAppServerGeneration(generationFile: string, contents: string): string {
	if (Buffer.byteLength(contents, "utf8") > MAX_GENERATION_BYTES) throw new Error("Development Server Host generation is oversized");
	const value: unknown = JSON.parse(contents);
	if (!isExactGeneration(value)) throw new Error("Development Server Host generation is invalid");
	const executable = resolve(dirname(generationFile), value.executable);
	let metadata;
	try {
		metadata = lstatSync(executable);
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") throw new Error(`Development Server Host generation is missing: ${executable}`, { cause: error });
		throw error;
	}
	if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`Development Server Host generation is not a regular file: ${executable}`);
	return executable;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
	const resolved = value ?? fallback;
	if (!Number.isSafeInteger(resolved) || resolved <= 0) throw new Error(`${name} must be a positive safe integer`);
	return resolved;
}

function isStableState(state: DevelopmentAppServerConnectionRelay["state"]): boolean {
	return state === "ready" || state === "crashed" || state === "stopped";
}
