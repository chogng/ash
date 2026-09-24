import type { DisposableHandle } from "../../ipc/common/ipc.js";

export const REMOTE_RUNTIME_INSTALL_PROGRESS_READ_CHANNEL = "ash:remote:runtimeInstallProgress:read";
export const REMOTE_RUNTIME_INSTALL_PROGRESS_CANCEL_CHANNEL = "ash:remote:runtimeInstallProgress:cancel";
export const REMOTE_RUNTIME_INSTALL_PROGRESS_CHANGED_CHANNEL = "ash:remote:runtimeInstallProgress:changed";

/** Structured phases emitted by the shared Remote runtime installer. */
export type RemoteRuntimeInstallProgress =
	| { readonly phase: "downloadingCatalog" }
	| { readonly phase: "downloadingArtifact"; readonly transferredBytes: number; readonly totalBytes: number }
	| { readonly phase: "validatingDownload" }
	| { readonly phase: "downloadComplete"; readonly disposition: "downloaded" | "reused" }
	| { readonly phase: "validatingArtifact" }
	| { readonly phase: "probingPlatform" }
	| { readonly phase: "uploading"; readonly transferredBytes: number; readonly totalBytes: number }
	| { readonly phase: "finalizingRemoteInstall" }
	| { readonly phase: "complete"; readonly disposition: "installed" | "reused" };

/** Credential-free snapshot shown while Desktop prepares one Remote runtime. */
export type RemoteRuntimeInstallProgressState = RemoteRuntimeInstallProgress & {
	readonly host: string;
	readonly status: "installing" | "cancelling";
};

/** Dedicated bootstrap-renderer bridge for one Main-owned installation operation. */
export interface IRemoteRuntimeInstallProgressApi {
	getState(): Promise<RemoteRuntimeInstallProgressState | undefined>;
	cancel(): Promise<void>;
	onDidChange(listener: (state: RemoteRuntimeInstallProgressState | undefined) => void): DisposableHandle;
}
