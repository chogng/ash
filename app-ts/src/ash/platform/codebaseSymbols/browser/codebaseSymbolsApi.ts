import type { AppServerProtocolClient } from "../../app-server/browser/appServerProtocolClient.js";
import { appServerRequest } from "../../app-server/browser/appServerRequest.js";
import type { UnavailableOperation } from "../../renderer/browser/disconnectedHost.js";
import type { ICodebaseSymbolsApi } from "../common/codebaseSymbolsApi.js";

export function createDisconnectedCodebaseSymbolsApi(unavailable: UnavailableOperation): ICodebaseSymbolsApi {
	return {
		status: () => unavailable("codebaseSymbols.status"),
		search: () => unavailable("codebaseSymbols.search"),
		synchronize: () => unavailable("codebaseSymbols.synchronize"),
		close: () => unavailable("codebaseSymbols.close"),
	};
}

export function createAppServerCodebaseSymbolsApi(connection: AppServerProtocolClient): ICodebaseSymbolsApi {
	return {
		status: () => appServerRequest(connection, "codebase/symbols/status", {}),
		search: params => appServerRequest(connection, "codebase/symbols/search", params),
		synchronize: params => appServerRequest(connection, "codeIntelligence/document/synchronize", params),
		close: params => appServerRequest(connection, "codeIntelligence/document/close", params),
	};
}
