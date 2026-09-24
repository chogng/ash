import type { AppServerConnectionRelay } from "../../app-server/electron-main/appServerConnectionRelay.js";
import type { IpcRoute } from "../../ipc/electron-main/trustedIpcRouter.js";
import type { IAnyWorkspaceIdentifier } from "../../workspace/common/workspace.js";
import { isRemoteWorkspaceIdentifier } from "../../workspace/common/workspace.js";
import { REMOTE_AGENT_CONNECTION_READ_CHANNEL, REMOTE_AGENT_RECONNECT_CHANNEL, REMOTE_AGENT_RUNTIME_ROLLBACK_CHANNEL, type RemoteAgentConnection, type RemoteAgentReconnectResult, type RemoteRuntimeRollbackResult } from "../common/remoteAgentApi.js";
import { getRemoteAuthority } from "../common/remote.js";

export interface IRemoteAgentRecoveryMainService {
	reconnect(): Promise<RemoteAgentReconnectResult>;
	rollback(): Promise<RemoteRuntimeRollbackResult>;
}

/** Projects connection metadata without exposing SSH credentials or native process details. */
export function remoteAgentConnection(supervisor: AppServerConnectionRelay, workspace: IAnyWorkspaceIdentifier): RemoteAgentConnection {
	if (!isRemoteWorkspaceIdentifier(workspace)) return Object.freeze({ kind: "local", generation: supervisor.generation });
	const authority = getRemoteAuthority(workspace.uri);
	if (!authority || authority.type !== "ssh") throw new Error("Remote Workspace does not provide a supported connection authority");
	return Object.freeze({ kind: "ssh", generation: supervisor.generation, authority: authority.authority, host: authority.host });
}

export function remoteAgentIpcRoutes(supervisor: AppServerConnectionRelay, getWorkspace: () => IAnyWorkspaceIdentifier, recovery?: IRemoteAgentRecoveryMainService): readonly IpcRoute<unknown, unknown>[] {
	return [
		{
			channel: REMOTE_AGENT_CONNECTION_READ_CHANNEL,
			validate: emptyParams,
			invoke: () => remoteAgentConnection(supervisor, getWorkspace()),
		},
		{
			channel: REMOTE_AGENT_RECONNECT_CHANNEL,
			validate: emptyParams,
			invoke: () => {
				if (!isRemoteWorkspaceIdentifier(getWorkspace())) throw new Error("Remote reconnect requires an SSH Remote Workspace");
				if (!recovery) throw new Error("Remote reconnect is not available for this connection");
				return recovery.reconnect();
			},
		},
		{
			channel: REMOTE_AGENT_RUNTIME_ROLLBACK_CHANNEL,
			validate: emptyParams,
			invoke: () => {
				if (!isRemoteWorkspaceIdentifier(getWorkspace())) throw new Error("Remote runtime rollback requires an SSH Remote Workspace");
				if (!recovery) throw new Error("Remote runtime rollback is not available for this connection");
				return recovery.rollback();
			},
		},
	];
}

function emptyParams(value: unknown): undefined {
	if (value !== undefined) throw new Error("Remote Agent operation does not accept parameters");
	return undefined;
}
