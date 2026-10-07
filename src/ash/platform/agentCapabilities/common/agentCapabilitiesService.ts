import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';

export type ToolAuthority = 'directoryRead' | 'directoryWrite' | 'processExecution' | 'productService' | 'providerDefined';
export type ToolSource = 'environment' | 'dynamic' | 'extension' | 'host' | 'local' | 'mcp';
export type ToolExposure = 'direct' | 'deferred' | 'modelOnly' | 'hidden';

export interface AgentToolCapability {
	readonly name: string;
	readonly description: string;
	readonly source: ToolSource;
	readonly sourceDetails: readonly string[];
	readonly exposure: ToolExposure;
	readonly authority: ToolAuthority;
}

export interface AgentCapabilitiesSnapshot {
	readonly tools: readonly AgentToolCapability[];
	readonly toolSets: readonly AgentToolSetCapability[];
	readonly localProcessSandboxConfigured: boolean;
	readonly sandboxBackends: readonly string[];
	readonly sandboxDiagnostics: readonly SandboxDiagnostic[];
	readonly directoryGrantsReadable: boolean;
}

export interface AgentToolSetCapability {
	readonly id: string;
	readonly source: ToolSource;
	readonly sourceId: string;
	readonly tools: readonly string[];
}

export interface SandboxDiagnostic {
	readonly backend: string;
	readonly network: 'denied' | 'allowed' | 'managed';
	readonly readiness: { readonly type: 'ready'; } | { readonly type: 'unsupported' | 'unavailable'; readonly reason: string; };
}

/** Read-only view of the current Agent tool and sandbox configuration. */
export interface IAgentCapabilitiesService {
	readonly isAvailable: boolean;
	read(): Promise<AgentCapabilitiesSnapshot>;
}

export const IAgentCapabilitiesService = createServiceIdentifier<IAgentCapabilitiesService>('agentCapabilitiesService');
