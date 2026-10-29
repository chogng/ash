import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';

export type McpServerRuntimeState =
	| { readonly status: 'disabled' | 'disconnected' | 'connected' | 'stale' }
	| { readonly status: 'unavailable'; readonly reason: string };

export interface McpServerStatus {
	readonly id: string;
	readonly displayName: string;
	/** Only the HTTP origin is exposed; transport configuration and credentials stay in the backend. */
	readonly httpOrigin: string | null;
	readonly state: McpServerRuntimeState;
	readonly catalogGeneration: number;
	readonly connectionGeneration: number | null;
	readonly toolCount: number;
}

export interface McpServerStatusSnapshot {
	readonly catalogGeneration: number;
	readonly servers: readonly McpServerStatus[];
}

/** Reads backend-owned lifecycle state without inferring it from installed packages or tool availability. */
export interface IMcpServerStatusService {
	readonly isAvailable: boolean;
	/** The backend provides snapshots, so callers read again when opened or explicitly refreshed. */
	read(): Promise<McpServerStatusSnapshot>;
}

export const IMcpServerStatusService = createServiceIdentifier<IMcpServerStatusService>('mcpServerStatusService');
