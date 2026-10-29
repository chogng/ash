import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';
import type { Event } from '../../../base/common/event.js';

export interface AgentCapabilitiesSnapshot {
	readonly localProcessSandboxConfigured: boolean;
	readonly sandboxBackends: readonly string[];
	readonly sandboxDiagnostics: readonly SandboxDiagnostic[];
	readonly sandboxPolicy?: {
		readonly profile: string;
		readonly fileSystem: 'readOnly' | 'directoryWrite' | 'fullAccess';
		readonly network: 'denied' | 'allowed' | 'managed';
		readonly hostRead: 'host' | 'grantedRoots';
		readonly managedConstraints: boolean;
		readonly pathRuleCount: number;
	};
	readonly directoryGrantsReadable: boolean;
}

export interface SandboxDiagnostic {
	readonly backend: string;
	readonly network: 'denied' | 'allowed' | 'managed';
	readonly readiness: { readonly type: 'ready' } | { readonly type: 'unsupported' | 'unavailable'; readonly reason: string };
}

/** Ash environment diagnostics and connection support, independent of the tool catalog. */
export interface IAgentCapabilitiesService {
	readonly isAvailable: boolean;
	/** Invalidates diagnostics after backend tool or permission policy installation. */
	readonly onDidChange: Event<void>;
	read(): Promise<AgentCapabilitiesSnapshot>;
}

export const IAgentCapabilitiesService = createServiceIdentifier<IAgentCapabilitiesService>('agentCapabilitiesService');
