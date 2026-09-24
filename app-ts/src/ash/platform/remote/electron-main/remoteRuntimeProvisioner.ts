import type { RemoteRuntimeInstallProgress } from "../common/remoteRuntimeInstallProgress.js";
import { PackagedRemoteRuntimeCatalog, type RemoteRuntimeCatalogSource } from "./packagedRemoteRuntimeCatalog.js";
import { normalizeCredentialFreeSshHost, type RunRemoteCommand, runRemoteCommand, validLocalCommand } from "./remoteCommand.js";
import { RemoteRuntimeFetcher } from "./remoteRuntimeFetcher.js";
import type { RemoteRuntimeInstallRequestOptions } from "./remoteRuntimeInstaller.js";
import { RemoteRuntimeInstaller } from "./remoteRuntimeInstaller.js";

export interface RemoteRuntimeProvisionerOptions {
	readonly source: RemoteRuntimeCatalogSource;
	readonly remoteExecutable: string;
	readonly sshExecutable: string;
	readonly environment: NodeJS.ProcessEnv;
	readonly installRoot?: string;
	readonly onProgress?: (progress: RemoteRuntimeInstallProgress) => void;
	readonly runCommand?: RunRemoteCommand;
}

/** Selects a package-authenticated artifact for the probed host and delegates installation. */
export class RemoteRuntimeProvisioner {
	private readonly runCommand: RunRemoteCommand;
	private catalog: Promise<PackagedRemoteRuntimeCatalog> | undefined;

	constructor(private readonly options: RemoteRuntimeProvisionerOptions) {
		if (!validLocalCommand(options.remoteExecutable) || !validLocalCommand(options.sshExecutable)) throw new Error("Remote provisioner executables must be non-empty and contain no control characters");
		this.runCommand = options.runCommand ?? runRemoteCommand;
	}

	async install(host: string, request: RemoteRuntimeInstallRequestOptions = {}): Promise<string> {
		const normalizedHost = normalizeCredentialFreeSshHost(host);
		const target = await this.probeTarget(normalizedHost, request.signal);
		const reportProgress = request.onProgress ?? this.options.onProgress;
		const artifact = this.options.source.kind === "network"
			? await new RemoteRuntimeFetcher({ remoteExecutable: this.options.remoteExecutable, environment: this.options.environment, source: this.options.source, runCommand: this.runCommand }).fetch(target, { signal: request.signal, onProgress: reportProgress })
			: (await this.loadCatalog()).artifactFor(target);
		if (artifact === undefined) throw new Error(`The Desktop release has no Remote runtime for ${target}`);
		return new RemoteRuntimeInstaller({
			remoteExecutable: this.options.remoteExecutable,
			sshExecutable: this.options.sshExecutable,
			environment: this.options.environment,
			artifact,
			installRoot: this.options.installRoot,
			runCommand: this.runCommand,
		}).install(normalizedHost, { signal: request.signal, onProgress: reportProgress });
	}

	private loadCatalog(): Promise<PackagedRemoteRuntimeCatalog> {
		if (this.options.source.kind !== "packaged") throw new Error("Network Remote runtime sources do not have a packaged catalog");
		this.catalog ??= PackagedRemoteRuntimeCatalog.load(this.options.source.bundleRoot, this.options.source.expectedSha256);
		return this.catalog;
	}

	private async probeTarget(host: string, signal: AbortSignal | undefined): Promise<string> {
		const result = await this.runCommand(this.options.remoteExecutable, ["probe", "--host", host, "--ssh", this.options.sshExecutable], this.options.environment, signal === undefined ? undefined : { onStderrData: () => {}, signal });
		if (result.exitCode !== 0) {
			const diagnostic = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode ?? "unknown"}`;
			throw new Error(`Remote platform probe failed: ${diagnostic}`);
		}
		const targets = result.stdout.split(/\r?\n/u).map(line => line.trim()).filter(line => line.length > 0);
		if (targets.length !== 1) throw new Error("Remote platform probe did not return exactly one package target");
		return targets[0]!;
	}
}
