import type { AppServerProtocolClient } from '../../agentHost/browser/appServerProtocolClient.js';
import { Event } from '../../../base/common/event.js';
import { appServerRequest } from '../../agentHost/browser/appServerRequest.js';
import type { UnavailableOperation } from '../../renderer/browser/disconnectedHost.js';
import type { AgentCapabilitiesSnapshot, IAgentCapabilitiesService } from '../common/agentCapabilitiesService.js';

export function createAppServerAgentCapabilitiesApi(connection: AppServerProtocolClient): IAgentCapabilitiesService {
	return {
		isAvailable: true,
		onDidChange: (listener, thisArgs, disposables) => {
			const subscription = connection.onNotification(event => {
				if (event.method === 'agent/tools/changed') listener.call(thisArgs);
			});
			if (Array.isArray(disposables)) disposables.push(subscription);
			else disposables?.add(subscription);
			return subscription;
		},
		read: async (): Promise<AgentCapabilitiesSnapshot> => {
			const result = await appServerRequest(connection, 'agent/capabilities/read', {});
			return {
				localProcessSandboxConfigured: result.localProcessSandboxConfigured,
				sandboxBackends: result.sandboxBackends,
				...(result.sandboxPolicy ? { sandboxPolicy: { ...result.sandboxPolicy } } : {}),
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
	return { isAvailable: false, onDidChange: Event.None, read: () => unavailable('agentCapabilities.read') };
}
