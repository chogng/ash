import type { Event } from '../../base/common/event.js';
import type { IDisposable } from '../../base/common/lifecycle.js';
import type { TextModel } from './model/textModel.js';
import type { LanguageFeatureRegistry, SyntaxProviderRegistry } from './languageFeatureRegistry.js';
import type { ILanguageIdCodec, LanguageSemanticTokensProvider, SyntaxServiceOptions } from './languages.js';
import type {
	LanguageTokenizationSource,
	SemanticTokenModelSource,
	SemanticTokenSource,
	LanguageToken,
} from './tokens/languageTokens.js';
import type { LanguageRequestOptions, LanguageRequestOutcome } from './model/languageRequestCoordinator.js';
import type {
	TreeSitterBracket,
	TreeSitterFacts,
	RelativeToken,
	TreeSitterSyntaxSession,
	TreeSitterTokenStyle,
	TreeSitterTokenizationMeasure,
} from './services/treeSitter/treeSitterLibraryService.js';
import { type Range } from './core/range.js';
import { type StandardTokenType } from './encodedTokenAttributes.js';
import { type LineTokens } from './tokens/lineTokens.js';
import { type SparseMultilineTokens } from './tokens/sparseMultilineTokens.js';

/** Tokenization state and operations owned by one text model. */
export interface ITokenizationTextModelPart {
	/** The same syntax and semantic ranges consumed by editor presentation. */
	readonly renderedTokens: SemanticTokenSource;
	/** Shared background syntax capability, present only for the Tree-sitter backend. */
	readonly syntaxTree?: ISyntaxTreeTextModelPart;

	readonly hasTokens: boolean;
	setSemanticTokens(tokens: SparseMultilineTokens[] | null, isComplete: boolean): void;
	setPartialSemanticTokens(range: Range, tokens: SparseMultilineTokens[] | null): void;
	hasCompleteSemanticTokens(): boolean;
	hasSomeSemanticTokens(): boolean;
	resetTokenization(): void;
	/** Prepares the first line for line tokenizers, or the accepted version for document providers. */
	whenReady(signal: AbortSignal): Promise<void>;
	forceTokenization(lineNumber: number): void;
	tokenizeIfCheap(lineNumber: number): void;
	hasAccurateTokensForLine(lineNumber: number): boolean;
	isCheapToTokenize(lineNumber: number): boolean;
	getLineTokens(lineNumber: number): LineTokens;
	getLanguageTokens(lineIndex: number): readonly LanguageToken[];
	getTokenTypeIfInsertingCharacter(lineNumber: number, column: number, character: string): StandardTokenType;
	tokenizeLinesAt(lineNumber: number, lines: string[]): LineTokens[] | null;
	/** Tokenizes proposed lines using the current document's lexical state without publishing them. */
	tokenizeLinesAtAsync(
		lineNumber: number,
		lines: readonly string[],
		signal: AbortSignal,
	): Promise<LineTokens[] | null>;
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

/** Optional analysis backend supplied by a provider; the text model never creates a parser. */
export interface ISyntaxTreeTextModelPart extends IDisposable {
	readonly execution: 'rust' | 'worker';
	readonly modelVersion: number;
	readonly tokenCount: number;
	readonly backgroundTokenizationState: BackgroundTokenizationState;
	readonly lines: readonly { lineIndex: number; tokens: readonly LanguageToken[] }[];
	readonly onDidChangeTokens: Event<readonly { fromLineNumber: number; toLineNumber: number }[]>;
	readonly onDidEncounterError: Event<unknown>;
	whenReady(signal: AbortSignal): Promise<void>;
	hasAccurateTokensForLine(line: number): boolean;
	isCheapToTokenize(line: number): boolean;
	forceTokenization(line: number): void;
	setVisibleLines(ranges: readonly { startLineNumber: number; endLineNumber: number }[]): void;
	refreshRange(startLineNumber: number, endLineNumber: number): void;
	getTokenCaptures(line: number): readonly RelativeToken[];
	getLanguageTokens(line: number): readonly LanguageToken[];
	resetStyles(): void;
	tokenizeLinesAt(line: number, lines: readonly string[]): readonly LanguageToken[][];
	tokenizeLinesAtAsync(
		line: number,
		lines: readonly string[],
		signal: AbortSignal,
	): Promise<readonly (readonly LanguageToken[])[]>;
	getBracketPairs(range: Range): readonly TreeSitterBracket[];
	getFacts(signal: AbortSignal): Promise<TreeSitterFacts>;
	getSelectionRanges(ranges: readonly Range[], signal: AbortSignal): Promise<readonly Range[]>;
}

export interface TextModelSyntaxSession {
	readonly session: TreeSitterSyntaxSession;
	readonly resolveStyle: (capture: string, language: string) => TreeSitterTokenStyle | undefined;
	readonly measure?: (sample: TreeSitterTokenizationMeasure) => void;
}

export interface TextModelTokenizationOptions {
	readonly createSyntaxSession?: (model: TextModel) => TextModelSyntaxSession | undefined;
	readonly createSyntaxTokenBackend?: (model: TextModel) => ISyntaxTreeTextModelPart | undefined;
	readonly onDidChangeSyntaxBackend?: Event<void>;
	readonly languageIdCodec?: ILanguageIdCodec;
	readonly syntaxProviderRegistry?: SyntaxProviderRegistry;
	readonly syntaxService?: SyntaxServiceOptions;
	readonly documentSemanticTokensProvider?: LanguageFeatureRegistry<LanguageSemanticTokensProvider>;
	readonly onDidChangeLanguageSupport?: Event<void>;
}

/** Stable client-side token ports. The provider owns requests and disposable analysis state. */
export interface IModelTokenization extends ITokenizationTextModelPart, IDisposable {
	readonly textModel: TextModel;
	readonly modelVersion: number;
	readonly tokenCount: number;
	readonly lines: readonly { lineIndex: number; tokens: readonly LanguageToken[] }[];
	readonly onDidChange: Event<readonly { fromLineNumber: number; toLineNumber: number }[] | undefined>;
	readonly onDidEncounterError: Event<unknown>;
	readonly languageTokens: LanguageTokenizationSource & SemanticTokenModelSource;
	readonly semanticTokens?: SemanticTokenModelSource & {
		readonly onDidEncounterError: Event<unknown>;
		requestTokens(languageId: string, options?: LanguageRequestOptions): Promise<LanguageRequestOutcome>;
	};
	setVisibleLines(ranges: readonly { startLineNumber: number; endLineNumber: number }[]): void;
}
