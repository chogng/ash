import { throwIfCancelled } from "../../../base/common/cancellation.js";
import { Disposable } from "../../../base/common/lifecycle.js";
import type { URI } from "../../../base/common/uri.js";
import type { RemoteRuntimeInstallProgress } from "../common/remoteRuntimeInstallProgress.js";
import { RemoteRuntimeInstallProgressMainService } from "./remoteRuntimeInstallProgressMainService.js";
import type { RemoteRuntimeInstallProgressOperation } from "./remoteRuntimeInstallProgressMainService.js";
import { SshAppServerProcessLauncher } from "./sshAppServerProcessLauncher.js";
import type { RemoteRuntimeInstallRequestOptions } from "./remoteRuntimeInstaller.js";

/** Installs one trusted Remote runtime selected entirely by the local product host. */
export interface IRemoteRuntimeInstaller {
	install(host: string, options?: RemoteRuntimeInstallRequestOptions): Promise<string>;
}

/** Minimal verified runtime identity consumed by the SSH bootstrap owner. */
export interface RemoteRuntimeConnectionProfile {
	readonly activeRuntime: string;
	readonly previousRuntime?: string;
}

/** Persists credential-free active and previous runtime identities for one SSH Workspace. */
export interface IRemoteRuntimeConnectionProfiles {
	get(host: string, workspace: string): Promise<RemoteRuntimeConnectionProfile | undefined>;
	activate(host: string, workspace: string, runtime: string): Promise<RemoteRuntimeConnectionProfile>;
	rollback(host: string, workspace: string, sshExecutable: string): Promise<RemoteRuntimeConnectionProfile>;
}

export interface RemoteRuntimeBootstrapMainServiceOptions {
	readonly workspace: URI;
	readonly sshExecutable: string;
	readonly remoteExecutable: string;
	readonly localEnvironment: NodeJS.ProcessEnv;
	readonly runtimeInstaller: IRemoteRuntimeInstaller;
	readonly connectionProfiles?: IRemoteRuntimeConnectionProfiles;
	readonly logProgress?: (progress: RemoteRuntimeInstallProgress) => void;
}

/**
 * Owns one SSH startup gate, including its cancellable install projection and
 * verified active/previous runtime profile binding.
 */
export class RemoteRuntimeBootstrapMainService extends Disposable {
	readonly installProgress = this._register(new RemoteRuntimeInstallProgressMainService());
	readonly processLauncher: SshAppServerProcessLauncher;

	private installOperation: RemoteRuntimeInstallProgressOperation | undefined;

	constructor(private readonly options: RemoteRuntimeBootstrapMainServiceOptions) {
		super();
		const profiles = options.connectionProfiles;
		this.processLauncher = new SshAppServerProcessLauncher({
			workspace: options.workspace,
			sshExecutable: options.sshExecutable,
			remoteExecutable: options.remoteExecutable,
			localEnvironment: options.localEnvironment,
			provisionRuntime: host => this.provisionRuntime(host),
			settleRuntimeProvision: () => this.settleRuntimeProvision(),
			resolveRuntime: profiles === undefined ? undefined : async (host, workspace) => (await profiles.get(host, workspace))?.activeRuntime,
			activateRuntime: profiles === undefined ? undefined : async (host, workspace, runtime) => { await profiles.activate(host, workspace, runtime); },
			rollbackRuntime: profiles === undefined ? undefined : async (host, workspace, runtimeSshExecutable) => (await profiles.rollback(host, workspace, runtimeSshExecutable)).activeRuntime,
		});
	}

	private async provisionRuntime(host: string): Promise<string> {
		const operation = this.installProgress.begin(host);
		this.installOperation = operation;
		const runtime = await this.options.runtimeInstaller.install(host, {
			signal: operation.signal,
			onProgress: progress => {
				this.options.logProgress?.(progress);
				operation.report(progress);
			},
		});
		throwIfCancelled(operation.signal, "Remote runtime installation cancelled");
		return runtime;
	}

	private settleRuntimeProvision(): void {
		const operation = this.installOperation;
		this.installOperation = undefined;
		operation?.finish();
	}
}

/** Produces bounded upload logs while preserving every structured UI update. */
export function createRemoteRuntimeInstallProgressLogger(log: (message: string, progress?: RemoteRuntimeInstallProgress) => void = defaultLog): (progress: RemoteRuntimeInstallProgress) => void {
	let nextDownloadPercent = 0;
	let nextUploadPercent = 0;
	return progress => {
		if (progress.phase === "downloadingCatalog") nextDownloadPercent = 0;
		if (progress.phase === "downloadingArtifact") {
			const percent = Math.floor(progress.transferredBytes * 100 / progress.totalBytes);
			if (percent < nextDownloadPercent && progress.transferredBytes !== progress.totalBytes) return;
			nextDownloadPercent = Math.min(100, percent + 10);
			log(`Remote runtime installation: downloaded ${percent}%`);
			return;
		}
		if (progress.phase === "validatingArtifact") nextUploadPercent = 0;
		if (progress.phase === "uploading") {
			const percent = Math.floor(progress.transferredBytes * 100 / progress.totalBytes);
			if (percent < nextUploadPercent && progress.transferredBytes !== progress.totalBytes) return;
			nextUploadPercent = Math.min(100, percent + 10);
			log(`Remote runtime installation: uploaded ${percent}%`);
			return;
		}
		log("Remote runtime installation", progress);
	};
}

function defaultLog(message: string, progress?: RemoteRuntimeInstallProgress): void {
	if (progress === undefined) console.info(message);
	else console.info(`${message}:`, progress);
}
