import type { JsonValue } from '../../../base/common/jsonValue.js';
import type { JsonValue as ProtocolJsonValue } from '../../../../../.build/protocol/typescript/index.js';
import { generateUuid } from '../../../base/common/uuid.js';
import type { AppServerProtocolClient } from '../../agentHost/browser/appServerProtocolClient.js';
import { appServerRequest } from '../../agentHost/browser/appServerRequest.js';
import type { UnavailableOperation } from '../../renderer/browser/disconnectedHost.js';
import type { ILanguageServerService } from '../common/languageServerService.js';

export function createAppServerLanguageServerService(connection: AppServerProtocolClient): ILanguageServerService {
	return {
		read: async dirId => {
			const [config, result] = await Promise.all([
				appServerRequest(connection, 'config/read', {}),
				appServerRequest(connection, 'language/servers', { dirId }),
			]);
			return {
				revision: config.revision,
				configurations: Object.fromEntries(
					Object.entries(config.languageServers).map(([id, value]) => [
						id,
						{
							...value,
							executable: value.executable ?? undefined,
							initializationOptions: value.initializationOptions ?? undefined,
						},
					]),
				),
				servers: result.servers.map(server => ({
					id: server.id,
					languageIds: server.languageIds,
					state: server.state ?? undefined,
				})),
			};
		},
		control: async request => {
			await appServerRequest(connection, 'language/serverControl', request);
		},
		configure: async (serverId, configuration, expectedRevision) => {
			await appServerRequest(connection, 'languageServer/configure', {
				commandId: generateUuid(),
				expectedRevision,
				serverId,
				config: {
					...configuration,
					languageIds: configuration.languageIds ? [...configuration.languageIds] : undefined,
					args: configuration.args ? [...configuration.args] : undefined,
					initializationOptions:
						configuration.initializationOptions === undefined
							? undefined
							: protocolJsonValue(configuration.initializationOptions),
					settings: configuration.settings
						? Object.fromEntries(
								Object.entries(configuration.settings).map(([key, value]) => [
									key,
									protocolJsonValue(value),
								]),
							)
						: undefined,
				},
			});
		},
		removeConfiguration: async (serverId, expectedRevision) => {
			await appServerRequest(connection, 'languageServer/remove', {
				commandId: generateUuid(),
				expectedRevision,
				serverId,
			});
		},
	};
}

export function createDisconnectedLanguageServerService(unavailable: UnavailableOperation): ILanguageServerService {
	return {
		read: () => unavailable('languageServers.read'),
		control: () => unavailable('languageServers.control'),
		configure: () => unavailable('languageServers.configure'),
		removeConfiguration: () => unavailable('languageServers.removeConfiguration'),
	};
}

function protocolJsonValue(value: JsonValue): ProtocolJsonValue {
	if (value === null || typeof value !== 'object') return value;
	if (Array.isArray(value)) return value.map(protocolJsonValue);
	return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, protocolJsonValue(entry)]));
}
