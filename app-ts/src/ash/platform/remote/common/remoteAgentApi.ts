import type { DisposableHandle } from "../../ipc/common/ipc.js";

export const REMOTE_AGENT_CONNECTION_READ_CHANNEL = "ash:remote:connection";
export const REMOTE_AGENT_CONNECTION_CHANGED_CHANNEL = "ash:remote:connectionChanged";
export const REMOTE_AGENT_RECONNECT_CHANNEL = "ash:remote:reconnect";
export const REMOTE_AGENT_RUNTIME_ROLLBACK_CHANNEL = "ash:remote:runtime:rollback";

/** Sanitized identity of the App Server connection currently owned by the native host. */
export type RemoteAgentConnection =
	| { readonly kind: "local"; readonly generation: number }
	| { readonly kind: "ssh"; readonly generation: number; readonly authority: string; readonly host: string };

/** Result of a Main-owned rollback interaction without exposing runtime paths to Renderer code. */
export type RemoteRuntimeRollbackResult =
	| { readonly kind: "rolledBack" }
	| { readonly kind: "cancelled" };

/** Result of asking the native host to replace a failed Remote connection. */
export type RemoteAgentReconnectResult =
	| { readonly kind: "reconnected" }
	| { readonly kind: "alreadyConnected" };

/** Narrow renderer bridge for connection identity plus a path-free, Main-owned recovery intent. */
export interface IRemoteAgentApi {
	getConnection(): Promise<RemoteAgentConnection>;
	reconnect(): Promise<RemoteAgentReconnectResult>;
	rollbackRuntime(): Promise<RemoteRuntimeRollbackResult>;
	onDidChangeConnection(listener: (connection: RemoteAgentConnection) => void): DisposableHandle;
}
