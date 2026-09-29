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
	readonly localProcessSandboxConfigured: boolean;
	readonly sandboxBackends: readonly string[];
	readonly directoryGrantsReadable: boolean;
}

/** Read-only view of the current Agent tool and sandbox configuration. */
export interface IAgentCapabilitiesApi {
	read(): Promise<AgentCapabilitiesSnapshot>;
}
