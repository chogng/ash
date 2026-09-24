import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import type { URI } from "../../../base/common/uri.js";
import { AppServerProtocolIncompatibleError } from "../../app-server/common/appServerProtocolCompatibility.js";
import type { IAppServerProcessLauncher } from "../../app-server/electron-main/appServerProcessLauncher.js";
import { createSshRemoteWorkspaceUri, getRemoteAuthority, getRemoteWorkspacePath } from "../common/remote.js";
import { isCanonicalAbsolutePosixPath, validLocalCommand } from "./remoteCommand.js";

export interface SpawnSshAppServerOptions {
	readonly environment: NodeJS.ProcessEnv;
}

export type SpawnSshAppServer = (executable: string, args: readonly string[], options: SpawnSshAppServerOptions) => ChildProcessWithoutNullStreams;

export interface SshRuntimeProbeResult {
	readonly exitCode: number | null;
	readonly stdout: string;
	readonly stderr: string;
}

export type ProbeSshRuntime = (executable: string, args: readonly string[], options: SpawnSshAppServerOptions) => Promise<SshRuntimeProbeResult>;

/** Main-owned provisioning callback bound to a trusted package artifact by the product host. */
export type ProvisionSshRuntime = (host: string) => Promise<string>;
export type ResolveSshRuntime = (host: string, workspace: string) => Promise<string | undefined>;
export type ActivateSshRuntime = (host: string, workspace: string, runtime: string) => Promise<void>;
export type RollbackSshRuntime = (host: string, workspace: string, sshExecutable: string) => Promise<string>;
export type SettleSshRuntimeProvision = () => void;

export interface SshAppServerProcessLauncherOptions {
	readonly workspace: URI;
	readonly sshExecutable: string;
	readonly remoteExecutable: string;
	readonly localEnvironment: NodeJS.ProcessEnv;
	readonly spawnProcess?: SpawnSshAppServer;
	readonly probeRuntime?: ProbeSshRuntime;
	readonly provisionRuntime?: ProvisionSshRuntime;
	readonly settleRuntimeProvision?: SettleSshRuntimeProvision;
	readonly resolveRuntime?: ResolveSshRuntime;
	readonly activateRuntime?: ActivateSshRuntime;
	readonly rollbackRuntime?: RollbackSshRuntime;
}

/** Classifies a failed Desktop-side runtime availability check before App Server startup. */
export class SshRuntimeProbeError extends Error {
	constructor(readonly kind: "runtime-unavailable" | "transport", message: string) {
		super(message);
		this.name = "SshRuntimeProbeError";
	}
}

/** Starts an App Server over an OpenSSH stdio channel without exposing credentials to Renderer. */
export class SshAppServerProcessLauncher implements IAppServerProcessLauncher {
	private readonly host: string;
	private readonly spawnProcess: SpawnSshAppServer;
	private readonly probeRuntime: ProbeSshRuntime;
	private workspacePath: string;
	private remoteExecutable: string;
	private profileResolved = false;
	private provisionAttempted = false;

	readonly description: string;

	constructor(readonly options: SshAppServerProcessLauncherOptions) {
		const authority = getRemoteAuthority(options.workspace);
		if (!authority || authority.type !== "ssh") throw new Error("SSH App Server launcher requires an SSH Remote workspace");
		if (!validLocalCommand(options.sshExecutable) || !validLocalCommand(options.remoteExecutable)) throw new Error("SSH and Remote Ash executable names must be non-empty and contain no control characters");
		this.host = authority.host;
		this.workspacePath = getRemoteWorkspacePath(options.workspace);
		this.description = `ssh://${authority.host}`;
		this.remoteExecutable = options.remoteExecutable;
		this.spawnProcess = options.spawnProcess ?? defaultSpawn;
		this.probeRuntime = options.probeRuntime ?? defaultProbe;
	}

	/** Whether this product host supplied a credential-free, verified profile rollback. */
	get runtimeRollbackAvailable(): boolean {
		return this.options.rollbackRuntime !== undefined;
	}

	/** Absolute POSIX Workspace root selected for the next Remote App Server connection. */
	get workspaceRoot(): string {
		return this.workspacePath;
	}

	/** Retargets this same SSH authority without moving credentials or execution into Renderer. */
	replaceWorkspaceRoot(root: string): void {
		this.workspacePath = getRemoteWorkspacePath(createSshRemoteWorkspaceUri(this.host, root));
		this.profileResolved = false;
	}

	async validate(): Promise<void> {
		this.provisionAttempted = false;
		if (!this.profileResolved && this.options.resolveRuntime) {
			const stored = await this.options.resolveRuntime(this.host, this.workspacePath);
			if (stored !== undefined) {
				if (!isCanonicalAbsolutePosixPath(stored)) throw new Error("Stored Remote runtime is not a canonical absolute POSIX path");
				this.remoteExecutable = stored;
			}
			this.profileResolved = true;
		}
		const result = await this.probe(this.remoteExecutable);
		const resolved = resolvedRuntime(result);
		if (resolved !== undefined) {
			this.remoteExecutable = resolved;
			return;
		}
		if (!runtimeMissing(result)) throw runtimeProbeTransportError(result);
		if (!this.options.provisionRuntime) {
			throw new SshRuntimeProbeError("runtime-unavailable", `Remote runtime '${this.remoteExecutable}' is not installed or is not on the remote PATH`);
		}
		await this.provision();
	}

	async didInitialize(): Promise<void> {
		await this.options.activateRuntime?.(this.host, this.workspacePath, this.remoteExecutable);
	}

	/** Selects the previous runtime only after the host callback verifies its SSH compatibility. */
	async rollbackRuntime(): Promise<void> {
		const rollbackRuntime = this.options.rollbackRuntime;
		if (!rollbackRuntime) throw new Error("Remote runtime rollback is not available for this connection");
		const runtime = await rollbackRuntime(this.host, this.workspacePath, this.options.sshExecutable);
		if (!validLocalCommand(runtime) || !isCanonicalAbsolutePosixPath(runtime)) {
			throw new Error("Remote runtime rollback returned an invalid executable path");
		}
		this.remoteExecutable = runtime;
		this.profileResolved = true;
		this.provisionAttempted = false;
	}

	async recoverInitializationFailure(error: unknown): Promise<boolean> {
		if (!(error instanceof AppServerProtocolIncompatibleError) || !this.options.provisionRuntime || this.provisionAttempted) return false;
		await this.provision();
		return true;
	}

	launch(): ChildProcessWithoutNullStreams {
		const remoteCommand = remoteRemoteCommand(this.remoteExecutable, this.workspacePath);
		return this.spawnProcess(this.options.sshExecutable, ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", this.host, remoteCommand], { environment: this.options.localEnvironment });
	}

	private async provision(): Promise<void> {
		const provisionRuntime = this.options.provisionRuntime;
		if (!provisionRuntime) throw new SshRuntimeProbeError("runtime-unavailable", "No trusted Remote runtime provisioner is available");
		try {
			this.provisionAttempted = true;
			const installedExecutable = await provisionRuntime(this.host);
			if (!validLocalCommand(installedExecutable) || !isCanonicalAbsolutePosixPath(installedExecutable)) {
				throw new SshRuntimeProbeError("runtime-unavailable", "Remote runtime installer returned an invalid executable path");
			}
			this.remoteExecutable = installedExecutable;
			const installedResult = await this.probe(this.remoteExecutable);
			const resolved = resolvedRuntime(installedResult);
			if (resolved !== undefined) {
				this.remoteExecutable = resolved;
				return;
			}
			if (runtimeMissing(installedResult)) {
				throw new SshRuntimeProbeError("runtime-unavailable", `Installed Remote runtime '${this.remoteExecutable}' is not executable`);
			}
			throw runtimeProbeTransportError(installedResult);
		} finally {
			this.options.settleRuntimeProvision?.();
		}
	}

	private probe(executable: string): Promise<SshRuntimeProbeResult> {
		return this.probeRuntime(
			this.options.sshExecutable,
			sshRuntimeProbeArguments(this.host, executable),
			{ environment: this.options.localEnvironment },
		);
	}
}

export function remoteRemoteCommand(executable: string, workspacePath: string): string {
	return ["env", `ASH_WORKSPACE_ROOT=${workspacePath}`, executable, "connect"].map(quotePosixShellArgument).join(" ");
}

const RUNTIME_FOUND_MARKER = "__ASH_REMOTE_RUNTIME_FOUND__:";
const RUNTIME_MISSING_MARKER = "__ASH_REMOTE_RUNTIME_MISSING__";

/** Builds the non-interactive SSH command used by Main to classify runtime availability. */
export function sshRuntimeProbeArguments(host: string, executable: string): readonly string[] {
	return [
		"-T",
		"-o",
		"BatchMode=yes",
		"-o",
		"ConnectTimeout=10",
		host,
		remoteRuntimeProbeCommand(executable),
	];
}

function remoteRuntimeProbeCommand(executable: string): string {
	const quotedExecutable = quotePosixShellArgument(executable);
	return `if command -v ${quotedExecutable} >/dev/null 2>&1; then printf '%s%s\\n' '${RUNTIME_FOUND_MARKER}' \"$(command -v ${quotedExecutable})\"; else printf '%s\\n' '${RUNTIME_MISSING_MARKER}'; exit 127; fi`;
}

function quotePosixShellArgument(value: string): string {
	if (value.includes("\0") || value.includes("\n") || value.includes("\r")) throw new Error("Remote command arguments must not contain control characters");
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

function resolvedRuntime(result: SshRuntimeProbeResult): string | undefined {
	const resolved = result.stdout.split(/\r?\n/u).map(line => line.trim()).find(line => line.startsWith(RUNTIME_FOUND_MARKER));
	if (resolved === undefined) return undefined;
	const executable = resolved.slice(RUNTIME_FOUND_MARKER.length).trim();
	if (!isCanonicalAbsolutePosixPath(executable)) throw new SshRuntimeProbeError("transport", "Remote runtime probe returned a non-canonical executable path");
	return executable;
}

function runtimeMissing(result: SshRuntimeProbeResult): boolean {
	return result.stdout.split(/\r?\n/u).some(line => line.trim() === RUNTIME_MISSING_MARKER);
}

function runtimeProbeTransportError(result: SshRuntimeProbeResult): SshRuntimeProbeError {
	const diagnostic = result.stderr.trim();
	return new SshRuntimeProbeError(
		"transport",
		diagnostic ? `Remote runtime probe failed: ${diagnostic}` : `Remote runtime probe exited with code ${result.exitCode ?? "unknown"}`,
	);
}

function defaultSpawn(executable: string, args: readonly string[], options: SpawnSshAppServerOptions): ChildProcessWithoutNullStreams {
	return spawn(executable, [...args], { env: { ...options.environment }, shell: false, stdio: "pipe" });
}

function defaultProbe(executable: string, args: readonly string[], options: SpawnSshAppServerOptions): Promise<SshRuntimeProbeResult> {
	const child = defaultSpawn(executable, args, options);
	return new Promise((resolve, reject) => {
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", chunk => { stdout = appendBounded(stdout, String(chunk)); });
		child.stderr.on("data", chunk => { stderr = appendBounded(stderr, String(chunk)); });
		child.once("error", reject);
		child.once("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
	});
}

function appendBounded(value: string, addition: string): string {
	const next = value + addition;
	return next.length <= 8_192 ? next : next.slice(0, 8_192);
}
