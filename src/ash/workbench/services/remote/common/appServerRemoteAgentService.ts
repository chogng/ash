import type { Event } from "../../../../base/common/event.js";
import { createServiceIdentifier } from "../../../../platform/instantiation/common/instantiation.js";
import type { RemoteConnectionState } from "../../../../platform/remote/common/remote.js";
import type { RemoteAgentConnection } from "../../../../platform/remote/common/remoteAgentApi.js";
import type { RemoteAgentReconnectResult } from "../../../../platform/remote/common/remoteAgentApi.js";
import type { RemoteRuntimeRollbackResult } from "../../../../platform/remote/common/remoteAgentApi.js";

/** Owns the window view of App Server connection state and SSH recovery operations. */
export interface IAppServerRemoteAgentService {
	readonly connectionState: RemoteConnectionState | undefined;
	readonly connection: RemoteAgentConnection | undefined;
	readonly onDidChangeConnectionState: Event<RemoteConnectionState>;
	readonly onDidChangeConnection: Event<RemoteAgentConnection>;
	reconnect(): Promise<RemoteAgentReconnectResult>;
	rollbackRuntime(): Promise<RemoteRuntimeRollbackResult>;
}

export const IAppServerRemoteAgentService = createServiceIdentifier<IAppServerRemoteAgentService>("appServerRemoteAgentService");
