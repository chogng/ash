import type { IFileSystemDirectory } from '../../files/common/fileApi.js';
import type { Event } from '../../../base/common/event.js';
import type { URI } from '../../../base/common/uri.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import type { IAgentConnection } from './agentService.js';
import { isSSHAgentHost, remoteAgentHostRoot, type RemoteAgentHostConnection } from './remoteAgentHostService.js';
import type { AppServerConnectionState } from './appServerApi.js';

/** The current window's execution host. It can itself be remote. */
export const AMBIENT_AGENT_HOST_AUTHORITY = 'local';

export interface IAgentHostConnectionInfo {
	readonly id: string;
	/** Registry key: canonical SSH/WSL workspace URI or the forwarded Tunnel endpoint. Resource identity lives in directory.uri. */
	readonly authority: string;
	readonly address: string | undefined;
	readonly name: string;
	readonly isAmbient: boolean;
	readonly state: AppServerConnectionState;
	/** Existing domain ports, retained across transient transport recovery and absent during initial acquisition. */
	readonly connection: IAgentConnection | undefined;
	readonly remoteConnection: RemoteAgentHostConnection | undefined;
	readonly directory: IFileSystemDirectory | undefined;
}

export function agentHostConnectionAddress(connection: RemoteAgentHostConnection): string {
	return !isSSHAgentHost(connection) && connection.type === 'tunnel' ? connection.endpoint : remoteAgentHostRoot(connection).toString();
}

/** Lookup and observation only; the renderer runtime port owns endpoint creation and retirement. */
export interface IAgentHostConnectionsService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeConnections: Event<void>;
	readonly connections: readonly IAgentHostConnectionInfo[];
	/** The selected window host, which may itself be remote. Borrowed, never owned here. */
	readonly ambientConnection: IAgentConnection;
	/** Resolves a remote resource namespace and its most specific registered directory.
	 * A single namespace owner also serves its separately granted worktrees. Ambiguous
	 * ownership throws; absence returns undefined. This lookup grants no file access.
	 */
	resolveConnection(resource: URI): IAgentHostConnectionInfo | undefined;
}

export const IAgentHostConnectionsService = createDecorator<IAgentHostConnectionsService>('agentHostConnectionsService');
