import type { IpcRoute } from "../../ipc/electron-main/trustedIpcRouter.js";
import { REMOTE_RUNTIME_INSTALL_PROGRESS_CANCEL_CHANNEL } from "../common/remoteRuntimeInstallProgress.js";
import { REMOTE_RUNTIME_INSTALL_PROGRESS_READ_CHANNEL } from "../common/remoteRuntimeInstallProgress.js";
import type { RemoteRuntimeInstallProgressMainService } from "./remoteRuntimeInstallProgressMainService.js";

/** Trusted routes exposed only to the dedicated Remote installation bootstrap window. */
export function remoteRuntimeInstallProgressIpcRoutes(service: RemoteRuntimeInstallProgressMainService): readonly IpcRoute<unknown, unknown>[] {
	return [
		{
			channel: REMOTE_RUNTIME_INSTALL_PROGRESS_READ_CHANNEL,
			validate: emptyParams,
			invoke: () => service.getState(),
		},
		{
			channel: REMOTE_RUNTIME_INSTALL_PROGRESS_CANCEL_CHANNEL,
			validate: emptyParams,
			invoke: () => service.cancel(),
		},
	];
}

function emptyParams(value: unknown): undefined {
	if (value !== undefined) throw new Error("Remote runtime installation progress does not accept parameters");
	return undefined;
}
