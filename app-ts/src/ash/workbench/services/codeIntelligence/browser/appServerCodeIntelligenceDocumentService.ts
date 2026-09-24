import { type ICodebaseSymbolsApi } from "../../../../platform/codebaseSymbols/common/codebaseSymbolsApi.js";
import { type CodeIntelligenceDocumentSnapshot, type ICodeIntelligenceDocumentService } from "../common/codeIntelligenceDocumentService.js";

/** App Server adapter for ephemeral code-intelligence document overlays. */
export class AppServerCodeIntelligenceDocumentService implements ICodeIntelligenceDocumentService {
	constructor(private readonly api: Pick<ICodebaseSymbolsApi, "synchronize" | "close">) {}

	async synchronize(document: CodeIntelligenceDocumentSnapshot): Promise<void> {
		await this.api.synchronize({ document });
	}

	async close(path: string): Promise<void> {
		await this.api.close({ path });
	}
}
