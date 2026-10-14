import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { localize } from '../../../nls.js';
import { AppServerRemoteError } from '../../agentHost/common/appServerError.js';
import type { AppServerProtocolClient } from '../../agentHost/browser/appServerProtocolClient.js';
import { appServerRequest } from '../../agentHost/browser/appServerRequest.js';
import type { UnavailableOperation } from '../../renderer/browser/disconnectedHost.js';
import type { IMcpServerManagementService, McpServerConfiguration, McpServerConfigurationSnapshot } from '../common/mcpServerManagementService.js';

/** Converts the existing stable protocol without retaining a second configuration or runtime catalog. */
export class AppServerMcpServerManagementService extends Disposable implements IMcpServerManagementService {
	private readonly changed = this._register(new Emitter<void>());
	readonly onDidChange = this.changed.event;

	constructor(private readonly connection: AppServerProtocolClient) {
		super();
		this._register(connection.onNotification(event => {
			if (event.method === 'config/changed') { this.changed.fire(); }
		}));
		this._register(connection.onStateChange(() => this.changed.fire()));
	}

	get isAvailable(): boolean { return this.connection.capabilities?.mcp === true; }

	async readConfiguration(): Promise<McpServerConfigurationSnapshot> {
		this.requireAvailable();
		try {
			const config = await appServerRequest(this.connection, 'config/read', {});
			return {
				revision: config.revision,
				servers: Object.values(config.mcpServers).map(server => ({
					id: server.id, displayName: server.displayName,
					transport: server.transport.type === 'stdio'
						? { type: 'stdio', command: server.transport.command, args: [...server.transport.args] }
						: { type: 'streamableHttp', url: server.transport.url },
					credential: server.credential.type === 'reference'
						? { type: 'reference', credentialRef: server.credential.credentialRef }
						: { type: 'unauthenticated' },
					enablement: server.enablement,
				})),
			};
		} catch (error) { throw explain(error); }
	}

	async save(server: McpServerConfiguration, expectedRevision: number): Promise<void> {
		await this.mutate(() => appServerRequest(this.connection, 'mcp/server/upsert', {
			commandId: generateUuid(), expectedRevision,
			server: {
				id: server.id, displayName: server.displayName, enablement: server.enablement,
				transport: server.transport.type === 'stdio'
					? { type: 'stdio', command: server.transport.command, args: [...server.transport.args] }
					: { type: 'streamableHttp', url: server.transport.url },
				credential: { ...server.credential },
			},
		}));
	}

	async remove(serverId: string, expectedRevision: number): Promise<void> {
		await this.mutate(() => appServerRequest(this.connection, 'mcp/server/remove', { commandId: generateUuid(), expectedRevision, serverId }));
	}

	async setEnablement(serverId: string, enabled: boolean, expectedRevision: number): Promise<void> {
		await this.mutate(() => appServerRequest(this.connection, 'mcp/server/enablement/set', {
			commandId: generateUuid(), expectedRevision, serverId, enablement: enabled ? 'enabled' : 'disabled',
		}));
	}

	async connect(serverId: string): Promise<void> {
		await this.mutate(() => appServerRequest(this.connection, 'mcp/server/connect', { serverId }));
	}

	async disconnect(serverId: string): Promise<void> {
		await this.mutate(() => appServerRequest(this.connection, 'mcp/server/disconnect', { serverId }));
	}

	private requireAvailable(): void {
		if (!this.isAvailable) {
			throw new Error(localize({ bundle: 'ash.extensions', key: 'mcpManagementUnavailable' }, 'MCP server management is unavailable.'));
		}
	}

	private async mutate(operation: () => Promise<unknown>): Promise<void> {
		this.requireAvailable();
		try { await operation(); }
		catch (error) { throw explain(error); }
		finally { this.changed.fire(); }
	}
}

function explain(error: unknown): unknown {
	if (error instanceof AppServerRemoteError) {
		switch (error.errorName) {
			case 'ConfigRevisionConflict': return new Error(localize({ bundle: 'ash.extensions', key: 'mcpConfigurationConflict' }, 'MCP configuration changed. Refresh and review the current configuration before trying again.'));
			case 'McpServerNotFound': return new Error(localize({ bundle: 'ash.extensions', key: 'mcpConfigurationMissing' }, 'This MCP server is no longer configured.'));
			case 'InvalidParams': return new Error(localize({ bundle: 'ash.extensions', key: 'mcpConfigurationInvalid' }, 'The backend rejected this MCP server configuration. Check its ID, transport and credential reference.'));
			case 'ConfigUnavailable':
			case 'McpRuntimeUnavailable': return new Error(localize({ bundle: 'ash.extensions', key: 'mcpManagementUnavailable' }, 'MCP server management is unavailable.'));
		}
	}
	return error;
}

export function createDisconnectedMcpServerManagementService(unavailable: UnavailableOperation): IMcpServerManagementService {
	return {
		isAvailable: false, onDidChange: Event.None, dispose: () => { }, [Symbol.dispose]: () => { },
		readConfiguration: () => unavailable('mcpServerManagement.readConfiguration'),
		save: () => unavailable('mcpServerManagement.save'), remove: () => unavailable('mcpServerManagement.remove'),
		setEnablement: () => unavailable('mcpServerManagement.setEnablement'),
		connect: () => unavailable('mcpServerManagement.connect'), disconnect: () => unavailable('mcpServerManagement.disconnect'),
	};
}
