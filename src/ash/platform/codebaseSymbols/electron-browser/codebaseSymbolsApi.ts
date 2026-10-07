import type { CodebaseSymbolsSearchResult, CodebaseSymbolsStatusResult, DocumentOverlayStatusResult } from "../../app-server/common/generated/index.js";
import { invoke } from "../../ipc/electron-browser/rendererIpc.js";
import type { ICodebaseSymbolsApi } from "../common/codebaseSymbolsApi.js";

export function createCodebaseSymbolsApi(): ICodebaseSymbolsApi {
	return {
		status: () => invoke<CodebaseSymbolsStatusResult>("ash:codebase-symbols:status"),
		search: params => invoke<CodebaseSymbolsSearchResult>("ash:codebase-symbols:search", params),
		synchronize: params => invoke<DocumentOverlayStatusResult>("ash:codebase-symbols:document-synchronize", params),
		close: params => invoke<DocumentOverlayStatusResult>("ash:codebase-symbols:document-close", params),
	};
}
