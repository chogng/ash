import { createServiceIdentifier } from "../../../../platform/instantiation/common/instantiation.js";

export interface CodeIntelligenceDocumentSnapshot {
	readonly path: string;
	readonly languageId: string;
	readonly revision: number;
	readonly text: string;
}

/** Projects authoritative Editor snapshots into Workspace-scoped code-intelligence overlays. */
export interface ICodeIntelligenceDocumentService {
	synchronize(document: CodeIntelligenceDocumentSnapshot): Promise<void>;
	close(path: string): Promise<void>;
}

export const ICodeIntelligenceDocumentService = createServiceIdentifier<ICodeIntelligenceDocumentService>("codeIntelligenceDocumentService");
