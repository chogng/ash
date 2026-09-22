import { generateUuid } from '../../../base/common/uuid.js';
import type { AppServerProtocolClient } from '../../app-server/browser/appServerProtocolClient.js';
import { appServerRequest } from '../../app-server/browser/appServerRequest.js';
import type { UnavailableOperation } from '../../renderer/browser/disconnectedHost.js';
import type { ILanguageServerService } from '../common/languageServerService.js';

export function createAppServerLanguageServerService(connection: AppServerProtocolClient): ILanguageServerService {
	return {
		read: async dirId => {
			const [config, result] = await Promise.all([appServerRequest(connection, 'config/read', {}), appServerRequest(connection, 'language/servers', { dirId })]);
			return { revision: config.revision, configurations: Object.fromEntries(Object.entries(config.languageServers).map(([id, value]) => [id, { mode: value.mode, executable: value.executable ?? undefined }])), servers: result.servers.map(server => ({ id: server.id, languageIds: server.languageIds })) };
		},
		configure: async (serverId, configuration, expectedRevision) => {
			await appServerRequest(connection, 'languageServer/configure', { commandId: generateUuid(), expectedRevision, serverId, config: configuration });
		},
		removeConfiguration: async (serverId, expectedRevision) => {
			await appServerRequest(connection, 'languageServer/remove', { commandId: generateUuid(), expectedRevision, serverId });
		},
	};
}

export function createDisconnectedLanguageServerService(unavailable: UnavailableOperation): ILanguageServerService {
	return { read: () => unavailable('languageServers.read'), configure: () => unavailable('languageServers.configure'), removeConfiguration: () => unavailable('languageServers.removeConfiguration') };
}
