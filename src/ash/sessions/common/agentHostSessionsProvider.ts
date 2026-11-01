import type { IObservable } from '../../base/common/observable.js';
import type { ISessionsProvider } from '../services/sessions/common/sessionsProvider.js';
import type { URI } from '../../base/common/uri.js';
import type { CancellationToken } from '../../base/common/cancellation.js';

export const LOCAL_AGENT_HOST_PROVIDER_ID = 'local-agent-host';

/** The adapter owns connection state; Sessions consumers never inspect its transport. */
export interface IAgentHostSessionsProvider extends ISessionsProvider {
	readonly connectionStatus: IObservable<'connecting' | 'connected' | 'disconnected'>;
	isDevContainerWorkspaceAvailable?(workspaceUri: URI, token?: CancellationToken): Promise<boolean>;
}
