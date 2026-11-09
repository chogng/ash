import type { RemoteConnectionDefinition } from '../../platform/remote/common/remoteConnectionService.js';
import type { IObservable } from '../../base/common/observable.js';
import type { ISessionsProvider } from '../services/sessions/common/sessionsProvider.js';
import type { URI } from '../../base/common/uri.js';
import type { SessionExecutionTarget } from '../services/sessions/common/session.js';
import type { CancellationToken } from '../../base/common/cancellation.js';

export const LOCAL_AGENT_HOST_PROVIDER_ID = 'local-agent-host';
export const SSH_AGENT_HOST_PROVIDER_PREFIX = 'ssh-agent-host:';

export function sshAgentHostProviderId(connection: RemoteConnectionDefinition): string {
	return `${SSH_AGENT_HOST_PROVIDER_PREFIX}${JSON.stringify([connection.host, connection.workspace])}`;
}

/** The adapter owns connection state; Sessions consumers never inspect its transport. */
export interface IAgentHostSessionsProvider extends ISessionsProvider {
	readonly connectionStatus: IObservable<'connecting' | 'connected' | 'disconnected'>;
	authorizeWorkspace?(target: SessionExecutionTarget, signal: AbortSignal, onTrustDeclined?: () => void): Promise<boolean>;
	isDevContainerWorkspaceAvailable?(workspaceUri: URI, token?: CancellationToken): Promise<boolean>;
}
