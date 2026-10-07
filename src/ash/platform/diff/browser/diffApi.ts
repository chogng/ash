import type { AppServerProtocolClient } from "../../agentHost/browser/appServerProtocolClient.js";
import { appServerRequest } from "../../agentHost/browser/appServerRequest.js";
import type { UnavailableOperation } from "../../renderer/browser/disconnectedHost.js";
import type { IDiffApi } from "../common/diffApi.js";

export function createDisconnectedDiffApi(unavailable: UnavailableOperation): IDiffApi {
	return {
		compute: () => unavailable("diff.compute"),
	};
}

export function createAppServerDiffApi(connection: AppServerProtocolClient): IDiffApi {
	return {
		compute: request => appServerRequest(connection, "diff/compute", request),
	};
}
