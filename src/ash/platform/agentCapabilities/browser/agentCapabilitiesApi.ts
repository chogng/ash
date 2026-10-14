import type { AppServerProtocolClient } from '../../agentHost/browser/appServerProtocolClient.js';
import { appServerRequest } from '../../agentHost/browser/appServerRequest.js';
import type { UnavailableOperation } from '../../renderer/browser/disconnectedHost.js';
import type { AgentCapabilitiesSnapshot, IAgentCapabilitiesService } from '../common/agentCapabilitiesService.js';

export function createAppServerAgentCapabilitiesApi(connection: AppServerProtocolClient): IAgentCapabilitiesService {
	return {
		isAvailable: true,
		read: async (): Promise<AgentCapabilitiesSnapshot> => {
			const result = await appServerRequest(connection, 'agent/capabilities/read', {});
			return {
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
	return { isAvailable: false, read: () => unavailable('agentCapabilities.read') };
}
