import type { AgentCapabilitiesReadResult } from '../../../../../.build/protocol/typescript/index.js';
import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';
import type { Event } from '../../../base/common/event.js';

/** Transport-only catalog query. Tool consumers use ILanguageModelToolsService. */
export interface IAgentToolsApi {
	readonly isAvailable: boolean;
	/** Backend invalidation after a catalog replacement, scoped to this connection. */
	readonly onDidChangeTools: Event<void>;
	read(): Promise<Pick<AgentCapabilitiesReadResult, 'tools' | 'toolSets'>>;
}

export const IAgentToolsApi = createServiceIdentifier<IAgentToolsApi>('agentToolsApi');
