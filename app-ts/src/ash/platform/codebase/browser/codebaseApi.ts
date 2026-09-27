import type { AppServerProtocolClient } from "../../app-server/browser/appServerProtocolClient.js";
import { appServerRequest } from "../../app-server/browser/appServerRequest.js";
import type { UnavailableOperation } from "../../renderer/browser/disconnectedHost.js";
import type { ICodebaseApi } from "../common/codebaseApi.js";

export function createDisconnectedCodebaseApi(unavailable: UnavailableOperation): ICodebaseApi {
	return {
		readConfig: () => unavailable("codebase.readConfig"),
		activateProvider: () => unavailable("codebase.activateProvider"),
		configureProvider: () => unavailable("codebase.configureProvider"),
		configure: () => unavailable("codebase.configure"),
		status: () => unavailable("codebase.status"),
	};
}

export function createAppServerCodebaseApi(connection: AppServerProtocolClient): ICodebaseApi {
	return {
		readConfig: () => appServerRequest(connection, "config/read", {}),
		activateProvider: params => appServerRequest(connection, "provider/activate", params),
		configureProvider: params => appServerRequest(connection, "provider/configure", params),
		configure: params => appServerRequest(connection, "codebase/configure", params),
		status: () => appServerRequest(connection, "codebase/status", {}),
	};
}
