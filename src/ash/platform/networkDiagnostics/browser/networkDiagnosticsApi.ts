import type { AppServerProtocolClient } from '../../agentHost/browser/appServerProtocolClient.js';
import { appServerRequest } from '../../agentHost/browser/appServerRequest.js';
import { generateUuid } from '../../../base/common/uuid.js';
import type { NetworkReadResult } from '../../../../../.build/protocol/typescript/index.js';
import type { UnavailableOperation } from '../../renderer/browser/disconnectedHost.js';
import type { INetworkDiagnosticsService, NetworkSnapshot } from '../common/networkDiagnosticsService.js';

export function createAppServerNetworkDiagnosticsApi(connection: AppServerProtocolClient): INetworkDiagnosticsService {
	return {
		read: async () => snapshot(await appServerRequest(connection, 'network/read', {})),
		configureHttp: async (httpMode, expectedRevision) => {
			await appServerRequest(connection, 'network/http/configure', { commandId: generateUuid(), expectedRevision, httpMode });
		},
		run: async () => {
			const result = await appServerRequest(connection, 'network/diagnostics/run', {});
			return { network: snapshot(result.network), checks: result.checks.map(check => ({ connection: check.connection, targetId: check.targetId, outcome: { ...check.outcome } })) };
		},
	};
}

export function createDisconnectedNetworkDiagnosticsApi(unavailable: UnavailableOperation): INetworkDiagnosticsService {
	return {
		read: () => unavailable('network.read'),
		configureHttp: () => unavailable('network.configureHttp'),
		run: () => unavailable('network.run'),
	};
}

function snapshot(result: NetworkReadResult): NetworkSnapshot {
	return { revision: result.revision, httpMode: result.httpMode, targets: result.targets.map(target => ({ ...target, route: { ...target.route } })) };
}
