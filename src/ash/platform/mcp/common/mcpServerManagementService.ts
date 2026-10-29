import type { Event } from '../../../base/common/event.js';
import type { IDisposable } from '../../../base/common/lifecycle.js';
import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';

/** A standalone declaration; credentials remain references to backend-owned secret storage. */
export interface McpServerConfiguration {
	readonly id: string;
	readonly displayName: string;
	readonly transport: { readonly type: 'stdio'; readonly command: string; readonly args: readonly string[] } | { readonly type: 'streamableHttp'; readonly url: string };
	readonly credential: { readonly type: 'unauthenticated' } | { readonly type: 'reference'; readonly credentialRef: string };
	readonly enablement: 'enabled' | 'disabled';
}

export interface McpServerConfigurationSnapshot {
	readonly revision: number;
	readonly servers: readonly McpServerConfiguration[];
}

/** Config is persistent user intent; connect/disconnect affect only the running backend process. */
/** The server requires client registration details before a browser flow can start. */
export class McpOAuthClientRequiredError extends Error {}

export interface McpOAuthLoginOptions {
	readonly clientId?: string;
	readonly clientMetadataUrl?: string;
	readonly scopes?: readonly string[];
}

export interface IMcpServerManagementService extends IDisposable {
	readonly isOAuthAvailable: boolean;
	login(serverId: string, options?: McpOAuthLoginOptions, signal?: AbortSignal): Promise<void>;
	logout(serverId: string): Promise<void>;

	readonly isAvailable: boolean;
	/** Invalidates snapshots after configuration changes or a completed local lifecycle request. */
	readonly onDidChange: Event<void>;
	readConfiguration(): Promise<McpServerConfigurationSnapshot>;
	save(server: McpServerConfiguration, expectedRevision: number): Promise<void>;
	remove(serverId: string, expectedRevision: number): Promise<void>;
	setEnablement(serverId: string, enabled: boolean, expectedRevision: number): Promise<void>;
	connect(serverId: string): Promise<void>;
	disconnect(serverId: string): Promise<void>;
}

export const IMcpServerManagementService = createServiceIdentifier<IMcpServerManagementService>('mcpServerManagementService');
