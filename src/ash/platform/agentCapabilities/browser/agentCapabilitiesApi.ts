import type { AppServerProtocolClient } from '../../app-server/browser/appServerProtocolClient.js';
import { appServerRequest } from '../../app-server/browser/appServerRequest.js';
import type { ToolSourceProvenance } from '../../../../../.build/protocol/typescript/index.js';
import type { UnavailableOperation } from '../../renderer/browser/disconnectedHost.js';
import type { AgentCapabilitiesSnapshot, IAgentCapabilitiesService } from '../common/agentCapabilitiesService.js';

export function createAppServerAgentCapabilitiesApi(connection: AppServerProtocolClient): IAgentCapabilitiesService {
	return {
		read: async (): Promise<AgentCapabilitiesSnapshot> => {
			const result = await appServerRequest(connection, 'agent/capabilities/read', {});
			return {
				tools: result.tools.map(tool => ({
					name: tool.name,
					description: tool.description,
					source: tool.source,
					sourceDetails: tool.sourceChain.map(sourceDetail),
					exposure: tool.exposure,
					authority: tool.authority,
				})),
				localProcessSandboxConfigured: result.localProcessSandboxConfigured,
				sandboxBackends: result.sandboxBackends,
				sandboxDiagnostics: result.sandboxDiagnostics.map(diagnostic => ({
					backend: diagnostic.backend,
					network: diagnostic.network,
					readiness: { ...diagnostic.readiness },
				})),
				directoryGrantsReadable: result.directoryGrantsReadable,
			};
		},
	};
}

export function createDisconnectedAgentCapabilitiesApi(unavailable: UnavailableOperation): IAgentCapabilitiesService {
	return { read: () => unavailable('agentCapabilities.read') };
}

function sourceDetail(source: ToolSourceProvenance): string {
	switch (source.type) {
		case 'product': return source.component;
		case 'plugin': return `${source.pluginId}@${source.version}`;
		case 'mcp': return source.serverId;
		case 'dynamic': return source.name;
		case 'extension': return source.id;
		case 'system': return source.id;
	}
}
