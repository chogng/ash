import type { Event } from '../../../base/common/event.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import type { IRendererHost } from '../../renderer/common/rendererHost.js';
import type { RemoteConnectionDefinition } from '../../remote/common/remoteConnectionService.js';
import { createSshRemoteWorkspaceUri } from '../../remote/common/remote.js';
import type { AppServerConnectionState } from './appServerApi.js';

/** The current window's execution host. It can itself be remote. */
export const AMBIENT_AGENT_HOST_AUTHORITY = 'local';

export interface IAgentHostConnectionInfo {
	readonly id: string;
	/** Additional endpoints use the canonical workspace URI, keeping equal hosts with different roots distinct. */
	readonly authority: string;
	readonly address: string | undefined;
	readonly name: string;
	readonly isAmbient: boolean;
	readonly state: AppServerConnectionState;
	/** Existing domain ports, retained across transient transport recovery and absent during initial acquisition. */
	readonly connection: IRendererHost | undefined;
	readonly remoteConnection: RemoteConnectionDefinition | undefined;
}

export function agentHostConnectionAddress(connection: RemoteConnectionDefinition): string {
	return createSshRemoteWorkspaceUri(connection.host, connection.workspace).toString();
}

/** Lookup and observation only; the renderer runtime port owns endpoint creation and retirement. */
export interface IAgentHostConnectionsService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeConnections: Event<void>;
	readonly connections: readonly IAgentHostConnectionInfo[];
}

export const IAgentHostConnectionsService = createDecorator<IAgentHostConnectionsService>('agentHostConnectionsService');
