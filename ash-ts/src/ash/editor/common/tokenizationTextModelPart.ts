import { type Range } from './core/range.js';
import { type StandardTokenType } from './encodedTokenAttributes.js';
import { type LineTokens } from './tokens/lineTokens.js';
import { type LanguageToken } from './tokens/languageTokens.js';
import { type SparseMultilineTokens } from './tokens/sparseMultilineTokens.js';

/** Tokenization state and operations owned by one text model. */
export interface ITokenizationTextModelPart {
	readonly hasTokens: boolean;
	setSemanticTokens(tokens: SparseMultilineTokens[] | null, isComplete: boolean): void;
	setPartialSemanticTokens(range: Range, tokens: SparseMultilineTokens[] | null): void;
	hasCompleteSemanticTokens(): boolean;
	hasSomeSemanticTokens(): boolean;
	resetTokenization(): void;
	forceTokenization(lineNumber: number): void;
	tokenizeIfCheap(lineNumber: number): void;
	hasAccurateTokensForLine(lineNumber: number): boolean;
	isCheapToTokenize(lineNumber: number): boolean;
	getLineTokens(lineNumber: number): LineTokens;
	getLanguageTokens(lineIndex: number): readonly LanguageToken[];
	getTokenTypeIfInsertingCharacter(lineNumber: number, column: number, character: string): StandardTokenType;
	tokenizeLinesAt(lineNumber: number, lines: string[]): LineTokens[] | null;
	/** Tokenizes proposed lines using the current document's lexical state without publishing them. */
	tokenizeLinesAtAsync(lineNumber: number, lines: readonly string[], signal: AbortSignal): Promise<LineTokens[] | null>;
	getLanguageId(): string;
	getLanguageIdAtPosition(lineNumber: number, column: number): string;
	setLanguageId(languageId: string, source?: string): void;
	readonly backgroundTokenizationState: BackgroundTokenizationState;
}

export const enum BackgroundTokenizationState {
	InProgress = 1,
	Completed = 2,
}

/** Raised when the selected syntax provider cannot satisfy a synchronous force request. */
export class SynchronousTokenizationUnavailableError extends Error {
	constructor(readonly lineNumber: number) {
		super(`Accurate tokens for line ${lineNumber} are still being produced asynchronously`);
		this.name = 'SynchronousTokenizationUnavailableError';
	}
}
