import { createServiceIdentifier } from "../../instantiation/common/instantiation.js";

export type CodebaseSymbolsState = "empty" | "indexing" | "ready" | "stale" | "failed";
export type CodebaseSymbolsSymbolKind = "constant" | "enum" | "field" | "function" | "macro" | "method" | "module" | "static" | "struct" | "trait" | "type" | "variable";

export interface CodebaseSymbolsPosition {
	readonly lineIndex: number;
	readonly columnIndex: number;
}

export interface CodebaseSymbolsRange {
	readonly start: CodebaseSymbolsPosition;
	readonly end: CodebaseSymbolsPosition;
}

export interface CodebaseSymbolsStatus {
	readonly state: CodebaseSymbolsState;
	readonly rootId: string;
	readonly generation: number;
	readonly sourceGeneration: number;
	readonly indexedSourceCount: number;
	readonly indexedSymbolCount: number;
	readonly symbolLimitHit: boolean;
}

export interface CodebaseSymbolsMatch {
	readonly name: string;
	readonly kind: CodebaseSymbolsSymbolKind;
	readonly containerName?: string;
	readonly path: string;
	readonly language: string;
	readonly sourceRevision: string;
	readonly declarationRange: CodebaseSymbolsRange;
	readonly selectionRange: CodebaseSymbolsRange;
	readonly score: number;
	readonly matchedIndices: readonly number[];
}

export interface CodebaseSymbolsSearchResult {
	readonly status: CodebaseSymbolsStatus;
	readonly matches: readonly CodebaseSymbolsMatch[];
	readonly discardedStaleMatchCount: number;
}

/** Frontend-owned local declaration search contract for the active Workspace. */
export interface ICodebaseSymbolsService {
	status(signal?: AbortSignal): Promise<CodebaseSymbolsStatus>;
	search(query: string, maxResults: number, signal?: AbortSignal): Promise<CodebaseSymbolsSearchResult>;
}

export const ICodebaseSymbolsService = createServiceIdentifier<ICodebaseSymbolsService>("codebaseSymbolsService");
