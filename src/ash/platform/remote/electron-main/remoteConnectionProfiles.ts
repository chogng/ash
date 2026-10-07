import { isCanonicalAbsolutePosixPath, normalizeCredentialFreeSshHost, type RunRemoteCommand, runRemoteCommand, validLocalCommand } from "./remoteCommand.js";

export interface RemoteConnectionRuntimeProfile {
	readonly activeRuntime: string;
	readonly previousRuntime?: string;
}

export interface RemoteConnectionProfilesOptions {
	readonly remoteExecutable: string;
	readonly environment: NodeJS.ProcessEnv;
	readonly runCommand?: RunRemoteCommand;
}

/** Delegates credential-free Remote profile persistence to the shared Rust store. */
export class RemoteConnectionProfiles {
	private readonly runCommand: RunRemoteCommand;

	constructor(readonly options: RemoteConnectionProfilesOptions) {
		if (!validLocalCommand(options.remoteExecutable)) throw new Error("Remote profile command executable must be non-empty and contain no control characters");
		this.runCommand = options.runCommand ?? runRemoteCommand;
	}

	async get(host: string, workspace: string): Promise<RemoteConnectionRuntimeProfile | undefined> {
		const result = await this.invoke("get", host, workspace);
		return parseProfile(result);
	}

	async activate(host: string, workspace: string, runtime: string): Promise<RemoteConnectionRuntimeProfile> {
		if (!isCanonicalAbsolutePosixPath(runtime)) throw new Error("Verified Remote runtime must be a canonical absolute POSIX path");
		const result = await this.invoke("activate", host, workspace, runtime);
		const profile = parseProfile(result);
		if (profile === undefined || profile.activeRuntime !== runtime) throw new Error("Remote profile activation returned an unexpected runtime");
		return profile;
	}

	async rollback(host: string, workspace: string, sshExecutable: string): Promise<RemoteConnectionRuntimeProfile> {
		if (!validLocalCommand(sshExecutable)) throw new Error("Remote rollback SSH executable must be non-empty and contain no control characters");
		const result = await this.invoke("rollback", host, workspace, undefined, sshExecutable);
		const profile = parseProfile(result);
		if (profile === undefined) throw new Error("Remote profile rollback returned no active runtime");
		return profile;
	}

	private async invoke(command: "get" | "activate" | "rollback", host: string, workspace: string, runtime?: string, sshExecutable?: string) {
		const normalizedHost = normalizeCredentialFreeSshHost(host);
		if (!isCanonicalAbsolutePosixPath(workspace)) throw new Error("Remote profile Workspace must be a canonical absolute POSIX path");
		const args = ["profile", command, "--host", normalizedHost, "--workspace", workspace];
		if (runtime !== undefined) args.push("--runtime", runtime);
		if (sshExecutable !== undefined) args.push("--ssh", sshExecutable);
		const result = await this.runCommand(this.options.remoteExecutable, args, this.options.environment);
		if (result.exitCode !== 0) {
			const diagnostic = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode ?? "unknown"}`;
			throw new Error(`Remote profile ${command} failed: ${diagnostic}`);
		}
		return result.stdout;
	}
}

function parseProfile(output: string): RemoteConnectionRuntimeProfile | undefined {
	let value: unknown;
	try {
		value = JSON.parse(output);
	} catch {
		throw new Error("Remote profile command returned invalid JSON");
	}
	if (value === null) return undefined;
	if (typeof value !== "object" || Array.isArray(value)) throw new Error("Remote profile command returned an invalid record");
	const record = value as Record<string, unknown>;
	const names = Object.keys(record).sort();
	const activeRuntime = record.activeRuntime;
	const previousRuntime = record.previousRuntime;
	if (names.some(name => name !== "activeRuntime" && name !== "previousRuntime") || typeof activeRuntime !== "string" || !isCanonicalAbsolutePosixPath(activeRuntime)) {
		throw new Error("Remote profile command returned an invalid record");
	}
	if (previousRuntime !== undefined && (typeof previousRuntime !== "string" || !isCanonicalAbsolutePosixPath(previousRuntime))) {
		throw new Error("Remote profile command returned an invalid previous runtime");
	}
	return Object.freeze({
		activeRuntime,
		...(previousRuntime === undefined ? {} : { previousRuntime }),
	});
}
