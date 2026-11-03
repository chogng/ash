import { localize } from '../../nls.js';
import { tunnelEndpoint } from '../../platform/agentHost/common/remoteAgentHostService.js';
import { StorageScope, StorageTarget, type IStorageService } from '../../platform/storage/common/storage.js';

const keyPrefix = 'sessions.remoteTunnel:';

/** Remember machine-local forward addresses. Authentication and resource grants belong to each live lease. */
export function listSavedTunnelEndpoints(storage: IStorageService): readonly string[] {
	return storage.keys(StorageScope.PROFILE, StorageTarget.MACHINE).flatMap(key => {
		if (!key.startsWith(keyPrefix)) return [];
		const value = storage.get(key, StorageScope.PROFILE);
		if (!value) return [];
		try {
			const endpoint = tunnelEndpoint(value);
			return key === keyPrefix + endpoint.port ? [endpoint.href] : [];
		} catch {
			return [];
		}
	});
}

export async function saveTunnelEndpoint(storage: IStorageService, value: string): Promise<void> {
	const endpoint = tunnelEndpoint(value);
	storage.store(keyPrefix + endpoint.port, endpoint.href, StorageScope.PROFILE, StorageTarget.MACHINE);
	await storage.flush();
}

export function tunnelEnvironmentLabel(endpoint: string): string {
	return localize('sessions.hosts.tunnelName', 'Ash Tunnel ({0})', tunnelEndpoint(endpoint).port);
}
