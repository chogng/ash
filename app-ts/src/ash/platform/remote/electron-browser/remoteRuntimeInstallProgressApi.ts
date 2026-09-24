import { invoke } from "../../ipc/electron-browser/rendererIpc.js";
import { subscribe } from "../../ipc/electron-browser/rendererIpc.js";
import { REMOTE_RUNTIME_INSTALL_PROGRESS_CANCEL_CHANNEL } from "../common/remoteRuntimeInstallProgress.js";
import { REMOTE_RUNTIME_INSTALL_PROGRESS_CHANGED_CHANNEL } from "../common/remoteRuntimeInstallProgress.js";
import { REMOTE_RUNTIME_INSTALL_PROGRESS_READ_CHANNEL } from "../common/remoteRuntimeInstallProgress.js";
import type { IRemoteRuntimeInstallProgressApi } from "../common/remoteRuntimeInstallProgress.js";
import type { RemoteRuntimeInstallProgressState } from "../common/remoteRuntimeInstallProgress.js";

/** Creates the narrow API used by the pre-Workbench Remote installation page. */
export function createRemoteRuntimeInstallProgressApi(): IRemoteRuntimeInstallProgressApi {
	return {
		getState: () => invoke<RemoteRuntimeInstallProgressState | undefined>(REMOTE_RUNTIME_INSTALL_PROGRESS_READ_CHANNEL),
		cancel: () => invoke<void>(REMOTE_RUNTIME_INSTALL_PROGRESS_CANCEL_CHANNEL),
		onDidChange: listener => subscribe(REMOTE_RUNTIME_INSTALL_PROGRESS_CHANGED_CHANNEL, listener),
	};
}
