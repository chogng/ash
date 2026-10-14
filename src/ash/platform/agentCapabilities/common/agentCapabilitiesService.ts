import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';

export interface AgentCapabilitiesSnapshot {
	readonly localProcessSandboxConfigured: boolean;
	readonly sandboxBackends: readonly string[];
	readonly sandboxDiagnostics: readonly SandboxDiagnostic[];
	readonly directoryGrantsReadable: boolean;
}

export interface SandboxDiagnostic {
	readonly backend: string;
	readonly network: 'denied' | 'allowed' | 'managed';
	readonly readiness: { readonly type: 'ready'; } | { readonly type: 'unsupported' | 'unavailable'; readonly reason: string; };
}

/** Ash environment diagnostics and connection support, independent of the tool catalog. */
export interface IAgentCapabilitiesService {
	readonly isAvailable: boolean;
	read(): Promise<AgentCapabilitiesSnapshot>;
}

export const IAgentCapabilitiesService = createServiceIdentifier<IAgentCapabilitiesService>('agentCapabilitiesService');
