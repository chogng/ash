import type { AppServerProtocolClient } from "../../agentHost/browser/appServerProtocolClient.js";
import { appServerRequest, voidResult } from "../../agentHost/browser/appServerRequest.js";
import type { UnavailableOperation } from "../../renderer/browser/disconnectedHost.js";
import type { IContentSearchApi } from "../common/searchApi.js";
import { generateUuid } from '../../../base/common/uuid.js';
import type { IContentSearchConfigurationService } from '../common/search.js';

export function createDisconnectedContentSearchApi(unavailable: UnavailableOperation): IContentSearchApi {
	return {
		start: () => unavailable("contentSearch.start"),
		read: () => unavailable("contentSearch.read"),
		cancel: () => unavailable("contentSearch.cancel"),
	};
}

export function createAppServerContentSearchApi(connection: AppServerProtocolClient): IContentSearchApi {
	return {
		start: (params) => appServerRequest(connection, "grep/search/start", params),
		read: (params) => appServerRequest(connection, "grep/search/read", params),
		cancel: (params) => voidResult(appServerRequest(connection, "grep/search/cancel", params)),
	};
}

export function createAppServerContentSearchConfigurationApi(connection: AppServerProtocolClient): IContentSearchConfigurationService {
	return {
		read: async () => {
			const result = await appServerRequest(connection, 'config/read', {});
			return { revision: result.revision, engine: result.grepBackend };
		},
		configure: async (engine, expectedRevision) => {
			await appServerRequest(connection, 'config/update', { commandId: generateUuid(), expectedRevision, grepBackend: engine });
		},
	};
}

export function createDisconnectedContentSearchConfigurationApi(unavailable: UnavailableOperation): IContentSearchConfigurationService {
	return {
		read: () => unavailable('contentSearchConfiguration.read'),
		configure: () => unavailable('contentSearchConfiguration.configure'),
	};
}
