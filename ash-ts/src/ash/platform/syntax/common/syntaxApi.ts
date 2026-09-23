import { createServiceIdentifier } from "../../instantiation/common/instantiation.js";

export type SyntaxLanguage = "javascript" | "javascriptreact" | "json" | "jsonc" | "rust" | "shell" | "typescript" | "typescriptreact";

export interface SyntaxPosition {
	readonly lineIndex: number;
	readonly columnIndex: number;
}

export interface SyntaxRange {
	readonly start: SyntaxPosition;
	readonly end: SyntaxPosition;
}

export type SyntaxTokenKind = "attribute" | "comment" | "constant" | "constructor" | "embedded" | "function" | "keyword" | "label" | "module" | "number" | "operator" | "property" | "punctuation" | "string" | "type" | "variable";

export interface SyntaxToken {
	readonly range: SyntaxRange;
	readonly kind: SyntaxTokenKind;
}

export interface SyntaxFoldingRange {
	readonly range: SyntaxRange;
}

export interface SyntaxSelectionRange {
	readonly range: SyntaxRange;
}

export type SyntaxSymbolKind = "constant" | "enum" | "field" | "function" | "macro" | "method" | "module" | "static" | "struct" | "trait" | "type" | "variable";

export interface SyntaxSymbol {
	readonly name: string;
	readonly kind: SyntaxSymbolKind;
	readonly range: SyntaxRange;
	readonly selectionRange: SyntaxRange;
}

export interface SyntaxDiagnostic {
	readonly range: SyntaxRange;
	readonly kind: "error" | "missing";
}

export interface SyntaxAnalyzeParams {
	readonly documentId: string;
	readonly language: SyntaxLanguage;
	readonly revision: number;
	readonly text: string;
}

export interface SyntaxAnalyzeResult {
	readonly revision: number;
	readonly hasErrors: boolean;
	readonly tokens: readonly SyntaxToken[];
	readonly foldingRanges: readonly SyntaxFoldingRange[];
	readonly symbols: readonly SyntaxSymbol[];
	readonly diagnostics: readonly SyntaxDiagnostic[];
}

export interface SyntaxSelectionRangesParams extends SyntaxAnalyzeParams {
	readonly ranges: readonly SyntaxRange[];
}

export interface SyntaxSelectionRangesResult {
	readonly revision: number;
	readonly ranges: readonly SyntaxSelectionRange[];
}

export interface SyntaxCloseParams {
	readonly documentId: string;
}

/** Transport-neutral entry point for bounded, authoritative source syntax analysis. */
export interface ISyntaxApi {
	analyze(params: SyntaxAnalyzeParams): Promise<SyntaxAnalyzeResult>;
	selectionRanges(params: SyntaxSelectionRangesParams): Promise<SyntaxSelectionRangesResult>;
	close(params: SyntaxCloseParams): Promise<void>;
}

export const ISyntaxApi = createServiceIdentifier<ISyntaxApi>("syntaxApi");
