import type { AppServerProtocolClient } from "../../app-server/browser/appServerProtocolClient.js";
import { appServerRequest } from "../../app-server/browser/appServerRequest.js";
import type { UnavailableOperation } from "../../renderer/browser/disconnectedHost.js";
import type { ISyntaxApi } from "../common/syntaxApi.js";

export function createDisconnectedSyntaxApi(unavailable: UnavailableOperation): ISyntaxApi {
	return {
		analyze: () => unavailable("syntax.analyze"),
		selectionRanges: () => unavailable("syntax.selectionRanges"),
		close: () => unavailable("syntax.close"),
	};
}

export function createAppServerSyntaxApi(connection: AppServerProtocolClient): ISyntaxApi {
	return {
		analyze: params => appServerRequest(connection, "syntax/analyze", params),
		selectionRanges: params => appServerRequest(connection, "syntax/selectionRanges", { ...params, ranges: [...params.ranges] }),
		close: async params => { await appServerRequest(connection, "syntax/close", params); },
	};
}
