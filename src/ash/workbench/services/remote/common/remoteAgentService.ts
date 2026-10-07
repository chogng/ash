import type { Event } from "../../../../base/common/event.js";
import { createServiceIdentifier } from "../../../../platform/instantiation/common/instantiation.js";
import type { RemoteConnectionState } from "../../../../platform/remote/common/remote.js";
import type { RemoteAgentConnection } from "../../../../platform/remote/common/remoteAgentApi.js";
import type { RemoteAgentReconnectResult } from "../../../../platform/remote/common/remoteAgentApi.js";
import type { RemoteRuntimeRollbackResult } from "../../../../platform/remote/common/remoteAgentApi.js";

/** Exposes the active remote agent without leaking the backend transport API. */
export interface IRemoteAgentService {
	readonly connectionState: RemoteConnectionState | undefined;
	readonly connection: RemoteAgentConnection | undefined;
	readonly onDidChangeConnectionState: Event<RemoteConnectionState>;
	readonly onDidChangeConnection: Event<RemoteAgentConnection>;
	reconnect(): Promise<RemoteAgentReconnectResult>;
	rollbackRuntime(): Promise<RemoteRuntimeRollbackResult>;
}

export const IRemoteAgentService = createServiceIdentifier<IRemoteAgentService>("remoteAgentService");
