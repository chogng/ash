import { localize } from '../../../nls.js';
import type { AppServerProtocolClient } from '../../agentHost/browser/appServerProtocolClient.js';
import { appServerRequest } from '../../agentHost/browser/appServerRequest.js';
import type { UnavailableOperation } from '../../renderer/browser/disconnectedHost.js';
import type { IMcpServerStatusService } from '../common/mcpServerStatusService.js';

export function createAppServerMcpServerStatusApi(connection: AppServerProtocolClient): IMcpServerStatusService {
	return {
		get isAvailable() {
			return connection.capabilities?.mcp === true;
		},
		read: async () => {
			if (!connection.capabilities?.mcp) {
				throw new Error(
					localize(
						{ bundle: 'ash.extensions', key: 'mcpStatusUnavailable' },
						'MCP server status is unavailable.',
					),
				);
			}
			const result = await appServerRequest(connection, 'mcp/server/status', {});
			return {
				catalogGeneration: result.catalogGeneration,
				servers: result.servers.map(server => ({
					id: server.id,
					displayName: server.displayName,
					httpOrigin: server.httpOrigin,
					state: { ...server.state },
					catalogGeneration: server.catalogGeneration,
					connectionGeneration: server.connectionGeneration,
					toolCount: server.toolCount,
				})),
			};
		},
	};
}

export function createDisconnectedMcpServerStatusApi(unavailable: UnavailableOperation): IMcpServerStatusService {
	return { isAvailable: false, read: () => unavailable('mcpServerStatus.read') };
}
