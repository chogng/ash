import { invoke, subscribe } from "../../ipc/electron-browser/rendererIpc.js";
import { REMOTE_AGENT_CONNECTION_CHANGED_CHANNEL, REMOTE_AGENT_CONNECTION_READ_CHANNEL, REMOTE_AGENT_RECONNECT_CHANNEL, REMOTE_AGENT_RUNTIME_ROLLBACK_CHANNEL, type IRemoteAgentApi, type RemoteAgentConnection, type RemoteAgentReconnectResult, type RemoteRuntimeRollbackResult } from "../common/remoteAgentApi.js";

export function createRemoteAgentApi(): IRemoteAgentApi {
	return {
		getConnection: () => invoke<RemoteAgentConnection>(REMOTE_AGENT_CONNECTION_READ_CHANNEL),
		reconnect: () => invoke<RemoteAgentReconnectResult>(REMOTE_AGENT_RECONNECT_CHANNEL),
		rollbackRuntime: () => invoke<RemoteRuntimeRollbackResult>(REMOTE_AGENT_RUNTIME_ROLLBACK_CHANNEL),
		onDidChangeConnection: listener => subscribe<RemoteAgentConnection>(REMOTE_AGENT_CONNECTION_CHANGED_CHANNEL, listener),
	};
}
