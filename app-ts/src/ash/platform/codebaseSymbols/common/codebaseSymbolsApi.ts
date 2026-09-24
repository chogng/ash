import type { CodebaseSymbolsSearchParams, CodebaseSymbolsSearchResult, CodebaseSymbolsStatusResult, DocumentOverlayCloseParams, DocumentOverlayStatusResult, DocumentOverlaySynchronizeParams } from "../../app-server/common/generated/index.js";
import { createServiceIdentifier } from "../../instantiation/common/instantiation.js";

/** Transport-only codebase-symbols operations. Product consumers use ICodebaseSymbolsService. */
export interface ICodebaseSymbolsApi {
	status(): Promise<CodebaseSymbolsStatusResult>;
	search(params: CodebaseSymbolsSearchParams): Promise<CodebaseSymbolsSearchResult>;
	synchronize(params: DocumentOverlaySynchronizeParams): Promise<DocumentOverlayStatusResult>;
	close(params: DocumentOverlayCloseParams): Promise<DocumentOverlayStatusResult>;
}

export const ICodebaseSymbolsApi = createServiceIdentifier<ICodebaseSymbolsApi>("codebaseSymbolsApi");
