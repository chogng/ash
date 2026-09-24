import { isAbsolute } from "node:path";
import { isRecord } from "../../../base/common/types.js";
import { isNonNegativeSafeInteger, isPositiveSafeInteger } from "../../../base/common/numbers.js";
import type { RemoteRuntimeInstallProgress } from "../common/remoteRuntimeInstallProgress.js";
import type { RemoteRuntimeCatalogSource } from "./packagedRemoteRuntimeCatalog.js";
import { type RunRemoteCommand, runRemoteCommand, validLocalCommand } from "./remoteCommand.js";
import { type TrustedRemoteRuntimeArtifact, validateTrustedRemoteRuntimeArtifact } from "./remoteRuntimeInstaller.js";

const ARTIFACT_KEYS = new Set(["archivePath", "version", "target", "archiveSize", "unpackedSize", "sha256"]);

export interface RemoteRuntimeFetcherOptions {
	readonly remoteExecutable: string;
	readonly environment: NodeJS.ProcessEnv;
	readonly source: Extract<RemoteRuntimeCatalogSource, { readonly kind: "network" }>;
	readonly onProgress?: (progress: RemoteRuntimeInstallProgress) => void;
	readonly runCommand?: RunRemoteCommand;
}

/** Materializes one product-authenticated network runtime through the shared Rust updater. */
export class RemoteRuntimeFetcher {
	private readonly runCommand: RunRemoteCommand;

	constructor(private readonly options: RemoteRuntimeFetcherOptions) {
		if (!validLocalCommand(options.remoteExecutable)) throw new Error("Remote runtime fetcher executable is invalid");
		if (!isAbsolute(options.source.cacheRoot) || !validLocalCommand(options.source.cacheRoot)) throw new Error("Remote runtime download cache must be an absolute local path");
		this.runCommand = options.runCommand ?? runRemoteCommand;
	}

	async fetch(target: string, request: { readonly signal?: AbortSignal; readonly onProgress?: (progress: RemoteRuntimeInstallProgress) => void } = {}): Promise<TrustedRemoteRuntimeArtifact> {
		const args = [ "fetch-runtime",
			"--catalog-url", this.options.source.catalogUrl,
			"--catalog-sha256", this.options.source.expectedSha256,
			"--target", target,
			"--cache-root", this.options.source.cacheRoot,
		];
		const reportProgress = request.onProgress ?? this.options.onProgress;
		const decoder = reportProgress === undefined ? undefined : new RemoteRuntimeDownloadProgressDecoder(reportProgress);
		if (decoder !== undefined) args.push("--progress", "json-lines");
		const observer = decoder === undefined && request.signal === undefined ? undefined : { onStderrData: (chunk: string) => decoder?.accept(chunk), signal: request.signal };
		const result = await this.runCommand(this.options.remoteExecutable, args, this.options.environment, observer);
		decoder?.finish();
		if (result.exitCode !== 0) {
			const diagnostic = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode ?? "unknown"}`;
			throw new Error(`Remote runtime download failed: ${diagnostic}`);
		}
		return parseArtifact(result.stdout, target);
	}
}

class RemoteRuntimeDownloadProgressDecoder {
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
		if (!/"kind"\s*:\s*"remoteRuntimeDownloadProgress"/u.test(line)) return;
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			throw new Error("Remote runtime fetcher returned malformed progress JSON");
		}
		if (!isRecord(value) || value.kind !== "remoteRuntimeDownloadProgress" || typeof value.phase !== "string") throw new Error("Remote runtime fetcher returned an invalid progress record");
		switch (value.phase) {
			case "downloadingCatalog":
				this.report(Object.freeze({ phase: "downloadingCatalog" }));
				return;
			case "downloadingArtifact":
				if (!isNonNegativeSafeInteger(value.transferredBytes) || !isPositiveSafeInteger(value.totalBytes) || value.transferredBytes > value.totalBytes) throw new Error("Remote runtime fetcher returned invalid download progress");
				this.report(Object.freeze({ phase: "downloadingArtifact", transferredBytes: value.transferredBytes, totalBytes: value.totalBytes }));
				return;
			case "validatingArtifact":
				this.report(Object.freeze({ phase: "validatingDownload" }));
				return;
			case "complete":
				if (value.disposition !== "downloaded" && value.disposition !== "reused") throw new Error("Remote runtime fetcher returned an invalid completion disposition");
				this.report(Object.freeze({ phase: "downloadComplete", disposition: value.disposition }));
				return;
			default:
				throw new Error(`Remote runtime fetcher returned an unknown progress phase: ${value.phase}`);
		}
	}
}

function parseArtifact(text: string, target: string): TrustedRemoteRuntimeArtifact {
	let value: unknown;
	try {
		value = JSON.parse(text.trim());
	} catch (error) {
		throw new Error("Remote runtime fetcher did not return valid artifact JSON", { cause: error });
	}
	if (!isRecord(value) || !hasExactKeys(value, ARTIFACT_KEYS)) throw new Error("Remote runtime fetcher returned an invalid artifact record");
	if (typeof value.archivePath !== "string" || typeof value.version !== "string" || typeof value.target !== "string" || typeof value.archiveSize !== "number" || typeof value.unpackedSize !== "number" || typeof value.sha256 !== "string") throw new Error("Remote runtime fetcher returned invalid artifact field types");
	const artifact: TrustedRemoteRuntimeArtifact = {
		archivePath: value.archivePath,
		version: value.version,
		target: value.target,
		archiveSize: value.archiveSize,
		unpackedSize: value.unpackedSize,
		sha256: value.sha256,
	};
	validateTrustedRemoteRuntimeArtifact(artifact);
	if (artifact.target !== target) throw new Error("Remote runtime fetcher returned an artifact for the wrong target");
	return Object.freeze({ ...artifact });
}

function hasExactKeys(value: Record<string, unknown>, expected: ReadonlySet<string>): boolean {
	const keys = Object.keys(value);
	return keys.length === expected.size && keys.every(key => expected.has(key));
}
