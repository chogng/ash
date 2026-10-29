import type { ChatToolSource } from './agent.js';
import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';
import type { Event } from '../../../base/common/event.js';

export type ToolCategory =
	| 'read'
	| 'edit'
	| 'search'
	| 'execute'
	| 'browser'
	| 'web'
	| 'agent'
	| 'plan'
	| 'workbench'
	| 'sessions'
	| 'projects'
	| 'automations'
	| 'app'
	| 'memory'
	| 'skills'
	| 'image';

export interface AgentTool {
	readonly category?: ToolCategory;
	readonly name: string;
	readonly description: string;
	readonly source: 'environment' | 'dynamic' | 'extension' | 'host' | 'local' | 'mcp';
	readonly sourceChain: readonly ChatToolSource[];
	readonly exposure: 'direct' | 'deferred' | 'modelOnly' | 'hidden';
	readonly authority: 'directoryRead' | 'directoryWrite' | 'processExecution' | 'productService' | 'providerDefined';
}

export interface ToolProductProfile {
	readonly id: string;
	readonly sets: readonly string[];
	readonly status: 'ready' | 'planned';
}

/** Frontend catalog snapshot; registration and policy remain backend-owned. */
export interface AgentToolsCatalog {
	readonly tools: readonly AgentTool[];
	readonly sourceGroups: readonly {
		readonly id: string;
		readonly source: AgentTool['source'];
		readonly sourceId: string;
		readonly tools: readonly string[];
	}[];
	readonly toolSets: readonly { readonly id: string; readonly tools: readonly string[] }[];
	readonly profiles: readonly ToolProductProfile[];
}

/** Catalog adapter contract. Tool consumers use ILanguageModelToolsService. */
export interface IAgentToolsApi {
	readonly isAvailable: boolean;
	/** Backend invalidation after a catalog replacement, scoped to this connection. */
	readonly onDidChangeTools: Event<void>;
	read(): Promise<AgentToolsCatalog>;
}

export const IAgentToolsApi = createServiceIdentifier<IAgentToolsApi>('agentToolsApi');
