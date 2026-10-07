import type { AppServerProtocolClient } from "../../app-server/browser/appServerProtocolClient.js";
import { appServerRequest } from "../../app-server/browser/appServerRequest.js";
import type { UnavailableOperation } from "../../renderer/browser/disconnectedHost.js";
import type { IToolSearchApi } from "../common/toolSearchApi.js";

export function createDisconnectedToolSearchApi(unavailable: UnavailableOperation): IToolSearchApi {
	return {
		readConfig: () => unavailable("toolSearch.readConfig"),
		configure: () => unavailable("toolSearch.configure"),
	};
}

export function createAppServerToolSearchApi(connection: AppServerProtocolClient): IToolSearchApi {
	return {
		readConfig: () => appServerRequest(connection, "config/read", {}),
		configure: params => appServerRequest(connection, "toolSearch/configure", params),
	};
}
