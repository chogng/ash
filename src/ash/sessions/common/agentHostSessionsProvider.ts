import type { IObservable } from '../../base/common/observable.js';
import type { ISessionsProvider } from '../services/sessions/common/sessionsProvider.js';

export const LOCAL_AGENT_HOST_PROVIDER_ID = 'local-agent-host';

/** The adapter owns connection state; Sessions consumers never inspect its transport. */
export interface IAgentHostSessionsProvider extends ISessionsProvider {
	readonly connectionStatus: IObservable<'connecting' | 'connected' | 'disconnected'>;
}
