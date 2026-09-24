import { type IDocumentDiffProviderOptions } from "./documentDiffProvider.js";

/** One immutable text document with LF line endings supplied to a diff computation. */
export interface DiffComputationDocument {
	readonly version: number;
	readonly text: string;
}

/** One version-pinned request for a presentation-independent text diff. */
export interface DiffComputationRequest {
	readonly original: DiffComputationDocument;
	readonly modified: DiffComputationDocument;
	readonly options: IDocumentDiffProviderOptions;
}
