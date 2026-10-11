import type { AppServerProtocolClient } from '../../agentHost/browser/appServerProtocolClient.js';
import { APP_SERVER_METHODS, type AppServerMethod } from '../../../../../.build/protocol/typescript/index.js';
import { decodeAppServerRequestParams } from '../../../../../.build/protocol/typescript/AppServerProtocolDecoder.js';
import { normalizeExtensionHostPayload } from '../common/extensionHostApi.js';
import type { IExtensionBackendApi } from '../common/extensionBackendApi.js';

export function createExtensionBackendApi(connection: AppServerProtocolClient): IExtensionBackendApi {
	return {
		async request(method, params, signal) {
			signal.throwIfAborted();
			if (!Object.hasOwn(APP_SERVER_METHODS, method)) { throw new TypeError('Unknown extension backend route'); }
			const route = method as AppServerMethod;
			const result = await connection.request(APP_SERVER_METHODS[route], decodeAppServerRequestParams(route, params));
			signal.throwIfAborted();
			return normalizeExtensionHostPayload(result);
		},
	};
}
