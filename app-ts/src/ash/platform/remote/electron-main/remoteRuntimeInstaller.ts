import type { RemoteRuntimeInstallProgress } from "../common/remoteRuntimeInstallProgress.js";
import { isAbsolute } from "node:path";
import { isRecord } from "../../../base/common/types.js";
import { isNonNegativeSafeInteger, isPositiveSafeInteger } from "../../../base/common/numbers.js";
import { isCanonicalAbsolutePosixPath, normalizeCredentialFreeSshHost, type RunRemoteCommand, runRemoteCommand, validLocalCommand } from "./remoteCommand.js";

export type { RunRemoteCommand, RemoteCommandResult } from "./remoteCommand.js";

const POSIX_REMOTE_TARGETS = new Set([
	"aarch64-apple-darwin",
	"aarch64-unknown-linux-gnu",
	"aarch64-unknown-linux-musl",
	"x86_64-apple-darwin",
	"x86_64-unknown-linux-gnu",
	"x86_64-unknown-linux-musl",
]);
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

/** Release-catalog facts checked by the shared Rust installer before and after SSH upload. */
export interface TrustedRemoteRuntimeArtifact {
	readonly archivePath: string;
	readonly version: string;
	readonly target: string;
	readonly archiveSize: number;
	readonly unpackedSize: number;
	readonly sha256: string;
}

export interface RemoteRuntimeInstallerOptions {
	readonly remoteExecutable: string;
	readonly sshExecutable: string;
	readonly environment: NodeJS.ProcessEnv;
	readonly artifact: TrustedRemoteRuntimeArtifact;
	readonly installRoot?: string;
	readonly onProgress?: (progress: RemoteRuntimeInstallProgress) => void;
	readonly runCommand?: RunRemoteCommand;
}

export interface RemoteRuntimeInstallRequestOptions {
	readonly signal?: AbortSignal;
	readonly onProgress?: (progress: RemoteRuntimeInstallProgress) => void;
}

/**
 * Invokes the packaged `ash-remote-server remote install` command from Electron Main.
 *
 * The artifact and all integrity facts are bound by the trusted product host. Renderer supplies
 * neither paths nor SSH options, and the Remote host never downloads release content itself.
 */
export class RemoteRuntimeInstaller {
	private readonly runCommand: RunRemoteCommand;

	constructor(readonly options: RemoteRuntimeInstallerOptions) {
		validateTrustedRemoteRuntimeArtifact(options.artifact);
		if (!validLocalCommand(options.remoteExecutable) || !validLocalCommand(options.sshExecutable)) throw new Error("Remote installer executables must be non-empty and contain no control characters");
		if (options.installRoot !== undefined && !isCanonicalAbsolutePosixPath(options.installRoot)) throw new Error("Remote runtime install root must be a canonical absolute POSIX path");
		this.runCommand = options.runCommand ?? runRemoteCommand;
	}

	async install(host: string, request: RemoteRuntimeInstallRequestOptions = {}): Promise<string> {
		const normalizedHost = normalizeCredentialFreeSshHost(host);
		const artifact = this.options.artifact;
		const args = [
			"install",
			"--host",
			normalizedHost,
			"--archive",
			artifact.archivePath,
			"--version",
			artifact.version,
			"--target",
			artifact.target,
			"--archive-size",
			String(artifact.archiveSize),
			"--unpacked-size",
			String(artifact.unpackedSize),
			"--sha256",
			artifact.sha256,
			"--ssh",
			this.options.sshExecutable,
		];
		if (this.options.installRoot !== undefined) args.push("--install-root", this.options.installRoot);
		const reportProgress = request.onProgress ?? this.options.onProgress;
		const progressDecoder = reportProgress === undefined ? undefined : new RemoteRuntimeInstallProgressDecoder(reportProgress);
		if (progressDecoder !== undefined) args.push("--progress", "json-lines");
		const observer = progressDecoder === undefined && request.signal === undefined
			? undefined
			: { onStderrData: (chunk: string) => progressDecoder?.accept(chunk), signal: request.signal };
		const result = await this.runCommand(this.options.remoteExecutable, args, this.options.environment, observer);
		progressDecoder?.finish();
		if (result.exitCode !== 0) {
			const diagnostic = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode ?? "unknown"}`;
			throw new Error(`Remote runtime installation failed: ${diagnostic}`);
		}
		const executable = result.stdout.split(/\r?\n/u).map(line => line.trim()).reverse().find(line => line.length > 0);
		if (executable === undefined || !isCanonicalAbsolutePosixPath(executable) || !executable.endsWith("/bin/ash-remote-server")) {
			throw new Error("Remote runtime installation did not return a valid immutable executable path");
		}
		return executable;
	}
}

class RemoteRuntimeInstallProgressDecoder {
	private buffered = "";

	constructor(private readonly report: (progress: RemoteRuntimeInstallProgress) => void) {}

	accept(chunk: string): void {
		this.buffered += chunk;
		const lines = this.buffered.split(/\r?\n/u);
		this.buffered = lines.pop() ?? "";
		for (const line of lines) this.acceptLine(line);
	}

	finish(): void {
		if (this.buffered.length > 0) this.acceptLine(this.buffered);
		this.buffered = "";
	}

	private acceptLine(line: string): void {
		const progress = parseRemoteRuntimeInstallProgress(line);
		if (progress !== undefined) this.report(progress);
	}
}

function parseRemoteRuntimeInstallProgress(line: string): RemoteRuntimeInstallProgress | undefined {
	if (!/"kind"\s*:\s*"remoteRuntimeInstallProgress"/u.test(line)) return undefined;
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		throw new Error("Remote runtime installer returned malformed progress JSON");
	}
	if (!isRecord(value) || value.kind !== "remoteRuntimeInstallProgress" || typeof value.phase !== "string") throw new Error("Remote runtime installer returned an invalid progress record");
	switch (value.phase) {
		case "validatingArtifact":
		case "probingPlatform":
		case "finalizingRemoteInstall":
			return Object.freeze({ phase: value.phase });
		case "uploading":
			if (!isNonNegativeSafeInteger(value.transferredBytes) || !isPositiveSafeInteger(value.totalBytes) || value.transferredBytes > value.totalBytes) throw new Error("Remote runtime installer returned invalid upload progress");
			return Object.freeze({ phase: value.phase, transferredBytes: value.transferredBytes, totalBytes: value.totalBytes });
		case "complete":
			if (value.disposition !== "installed" && value.disposition !== "reused") throw new Error("Remote runtime installer returned an invalid completion disposition");
			return Object.freeze({ phase: value.phase, disposition: value.disposition });
		default:
			throw new Error(`Remote runtime installer returned an unknown progress phase: ${value.phase}`);
	}
}

/** Reads the explicit Main-process artifact override; incomplete records fail closed. */
export function remoteRuntimeArtifactFromEnvironment(environment: NodeJS.ProcessEnv): TrustedRemoteRuntimeArtifact | undefined {
	const names = [
		"ASH_REMOTE_RUNTIME_ARCHIVE",
		"ASH_REMOTE_RUNTIME_VERSION",
		"ASH_REMOTE_RUNTIME_TARGET",
		"ASH_REMOTE_RUNTIME_ARCHIVE_SIZE",
		"ASH_REMOTE_RUNTIME_UNPACKED_SIZE",
		"ASH_REMOTE_RUNTIME_SHA256",
	] as const;
	const values = names.map(name => environment[name]);
	if (values.every(value => value === undefined)) return undefined;
	const missing = names.filter((_, index) => values[index] === undefined);
	if (missing.length > 0) throw new Error(`Incomplete Remote runtime artifact override; missing ${missing.join(", ")}`);
	const artifact = {
		archivePath: values[0]!,
		version: values[1]!,
		target: values[2]!,
		archiveSize: parsePositiveSafeInteger(values[3]!, names[3]),
		unpackedSize: parsePositiveSafeInteger(values[4]!, names[4]),
		sha256: values[5]!,
	};
	validateTrustedRemoteRuntimeArtifact(artifact);
	return Object.freeze(artifact);
}

export function validateTrustedRemoteRuntimeArtifact(artifact: TrustedRemoteRuntimeArtifact): void {
	if (!isAbsolute(artifact.archivePath) || !validLocalCommand(artifact.archivePath)) throw new Error("Remote runtime archive path must be an absolute local path");
	if (!VERSION_PATTERN.test(artifact.version)) throw new Error("Remote runtime artifact version is invalid");
	if (!POSIX_REMOTE_TARGETS.has(artifact.target)) throw new Error(`Unsupported POSIX Remote runtime target: ${artifact.target}`);
	if (!Number.isSafeInteger(artifact.archiveSize) || artifact.archiveSize <= 0) throw new Error("Remote runtime archive size must be a positive safe integer");
	if (!Number.isSafeInteger(artifact.unpackedSize) || artifact.unpackedSize <= 0) throw new Error("Remote runtime unpacked size must be a positive safe integer");
	if (!SHA256_PATTERN.test(artifact.sha256)) throw new Error("Remote runtime SHA-256 must be 64 lowercase hex characters");
}

function parsePositiveSafeInteger(value: string, name: string): number {
	if (!/^[1-9][0-9]*$/u.test(value)) throw new Error(`${name} must be a positive integer`);
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed)) throw new Error(`${name} exceeds the supported integer range`);
	return parsed;
}
