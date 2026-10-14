import type { AppServerProtocolClient } from "../../agentHost/browser/appServerProtocolClient.js";
import { appServerRequest } from "../../agentHost/browser/appServerRequest.js";
import type { UnavailableOperation } from "../../renderer/browser/disconnectedHost.js";
import type { ICodebaseApi } from "../common/codebaseApi.js";

export function createDisconnectedCodebaseApi(unavailable: UnavailableOperation): ICodebaseApi {
	return {
		readConfig: () => unavailable("codebase.readConfig"),
		configure: () => unavailable("codebase.configure"),
		status: () => unavailable("codebase.status"),
	};
}

export function createAppServerCodebaseApi(connection: AppServerProtocolClient): ICodebaseApi {
	return {
		readConfig: () => appServerRequest(connection, "config/read", {}),
		configure: params => appServerRequest(connection, "codebase/configure", params),
		status: () => appServerRequest(connection, "codebase/status", {}),
	};
}
