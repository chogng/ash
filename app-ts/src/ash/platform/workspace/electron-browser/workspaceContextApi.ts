import { invoke, subscribe } from "../../ipc/electron-browser/rendererIpc.js";
import { WORKSPACE_CONTEXT_CHANGED_CHANNEL, WORKSPACE_CONTEXT_READ_CHANNEL, type IWorkspaceContextApi } from "../common/workspaceIpc.js";

export function createWorkspaceContextApi(): IWorkspaceContextApi {
	return {
		getWorkspace: () => invoke(WORKSPACE_CONTEXT_READ_CHANNEL),
		onDidChange: (listener) => subscribe(WORKSPACE_CONTEXT_CHANGED_CHANNEL, listener),
	};
}
