import type { AppServerProtocolClient } from "../../agentHost/browser/appServerProtocolClient.js";
import { appServerRequest } from "../../agentHost/browser/appServerRequest.js";
import type { UnavailableOperation } from "../../renderer/browser/disconnectedHost.js";
import type { ITypstApi } from "../common/typstApi.js";

export function createDisconnectedTypstApi(unavailable: UnavailableOperation): ITypstApi {
	return { compile: () => unavailable("typst.compile") };
}

export function createAppServerTypstApi(connection: AppServerProtocolClient): ITypstApi {
	return { compile: (params) => appServerRequest(connection, "document/typst/compile", params) };
}
