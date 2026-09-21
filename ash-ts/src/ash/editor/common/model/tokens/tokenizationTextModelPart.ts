import { LanguageResultAcceptance } from '../languageResultStore.js';
import { Emitter, type Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Position } from '../../core/position.js';
import { type Range } from '../../core/range.js';
import { countEOL } from '../../core/misc/eolCounter.js';
import { ColorId, FontStyle, LanguageId, MetadataConsts, StandardTokenType } from '../../encodedTokenAttributes.js';
import { SYNTAX_TOKEN_LANE, type SyntaxLane, type SyntaxRequest, type SyntaxResult, TokenizationRegistry, type ILanguageIdCodec, type LanguageSemanticTokensProvider, type SyntaxServiceOptions } from '../../languages.js';
import { type LanguageFeatureRegistry, SyntaxProviderRegistry } from '../../languageFeatureRegistry.js';
import { createLanguageTokenStore, type LanguageTokenizationSource, type LanguageToken, type SemanticTokenModelSource, type SemanticTokenSource } from '../../tokens/languageTokens.js';
import { BackgroundTokenizationState, type ITokenizationTextModelPart, SynchronousTokenizationUnavailableError } from '../../tokenizationTextModelPart.js';
import { LanguageTokenLineIndex, StyledTokenSource, overlayTokenSources, type LanguageTokenLine } from '../../tokens/languageTokenLineIndex.js';
import { LineTokens } from '../../tokens/lineTokens.js';
import { type SparseMultilineTokens } from '../../tokens/sparseMultilineTokens.js';
import { SparseTokensStore } from '../../tokens/sparseTokensStore.js';
import { type TextModel } from '../textModel.js';
import { SemanticTokensTextModelPart } from './semanticTokensTextModelPart.js';
import { createSyntaxWorker } from '../../services/editorWebWorker.js';
import { LanguageRequestCoordinator } from '../languageRequestCoordinator.js';

export interface TokenizationTextModelPartOptions {
	readonly languageIdCodec?: ILanguageIdCodec;
	readonly syntaxProviderRegistry?: SyntaxProviderRegistry;
	readonly syntaxService?: SyntaxServiceOptions;
	readonly documentSemanticTokensProvider?: LanguageFeatureRegistry<LanguageSemanticTokensProvider>;
	readonly onDidChangeLanguageSupport?: Event<void>;
}

/** Owns syntax requests and their line-token index for exactly one TextModel. */
export class TokenizationTextModelPart extends Disposable implements ITokenizationTextModelPart {
	private readonly changeEmitter = this._register(new Emitter<void>());
	private readonly errorEmitter = this._register(new Emitter<unknown>());
	private readonly languageIdCodec: ILanguageIdCodec;
	private readonly syntaxProviderRegistry: SyntaxProviderRegistry;
	private readonly languageTokenLineIndex: LanguageTokenLineIndex;
	private readonly semanticTokensStore: SparseTokensStore;
	private readonly hasWorkerProvider: boolean;
	private requestGeneration = 0;

	readonly onDidChange: Event<void> = this.changeEmitter.event;
	readonly onDidEncounterError: Event<unknown> = this.errorEmitter.event;
	private readonly tokenStore: ReturnType<typeof createLanguageTokenStore>;
	private readonly coordinator: LanguageRequestCoordinator<SyntaxLane, SyntaxRequest, SyntaxResult>;
	readonly semanticTokens: SemanticTokensTextModelPart | undefined;
	readonly renderedTokens: SemanticTokenSource;
	readonly languageTokens: LanguageTokenizationSource & SemanticTokenModelSource;

	constructor(readonly textModel: TextModel, options: TokenizationTextModelPartOptions = {}) {
		super();
		this.languageIdCodec = options.languageIdCodec ?? new ModelLanguageIdCodec();
		this.languageIdCodec.encodeLanguageId(textModel.getLanguageId());
		this.syntaxProviderRegistry = options.syntaxProviderRegistry ?? this._register(new SyntaxProviderRegistry());
		this.hasWorkerProvider = options.syntaxService?.workerFactory !== undefined;
		this.tokenStore = this._register(createLanguageTokenStore(textModel));
		this.coordinator = this._register(new LanguageRequestCoordinator(textModel, () => createSyntaxWorker(this.syntaxProviderRegistry, options.syntaxService ?? {})));
		this.languageTokenLineIndex = this._register(new LanguageTokenLineIndex(this.tokenStore));
		const tokenization = this;
		this.languageTokens = Object.freeze({
			textModel,
			onDidChange: (listener: (...args: any[]) => void) => tokenization.onDidChange(() => listener()),
			get modelVersion() { return tokenization.modelVersion; },
			get lines() { return tokenization.lines; },
			getLineTokens: (lineIndex: number) => tokenization.getLanguageTokens(lineIndex),
		});
		this.semanticTokensStore = new SparseTokensStore(this.languageIdCodec);
		this.semanticTokens = options.documentSemanticTokensProvider
			? this._register(new SemanticTokensTextModelPart(textModel, options.documentSemanticTokensProvider))
			: undefined;
		if (this.semanticTokens) this._register(this.semanticTokens.onDidEncounterError(error => this.errorEmitter.fire(error)));
		const lexicalSource = this._register(new StyledTokenSource(this.languageTokens));
		this.renderedTokens = this.semanticTokens
			? overlayTokenSources(lexicalSource, this._register(new StyledTokenSource(this.semanticTokens)))
			: lexicalSource;
		this._register(this.languageTokenLineIndex.onDidChange(() => this.changeEmitter.fire()));
		this._register(textModel.onDidChangeContent(change => {
			if (!change.isEolChange) {
				for (const contentChange of change.changes) {
					const [eolCount, firstLineLength, lastLineLength] = countEOL(contentChange.text);
					this.semanticTokensStore.acceptEdit(
						contentChange.range,
						eolCount,
						firstLineLength,
						lastLineLength,
						contentChange.text.length > 0 ? contentChange.text.charCodeAt(0) : 0,
					);
				}
			}
			this.scheduleAnalysis();
		}));
		this._register(textModel.onDidChangeLanguage(() => {
			this.coordinator.restartWorker();
			this.languageIdCodec.encodeLanguageId(textModel.getLanguageId());
			this.semanticTokensStore.flush();
			this.tokenStore.clear();
			this.changeEmitter.fire();
			this.scheduleAnalysis();
		}));
		this._register(this.syntaxProviderRegistry.onDidChange(() => {
			this.coordinator.restartWorker();
			this.tokenStore.clear();
			this.scheduleAnalysis();
		}));
		if (options.onDidChangeLanguageSupport) this._register(options.onDidChangeLanguageSupport(() => {
			this.coordinator.restartWorker();
			this.tokenStore.clear();
			this.scheduleAnalysis();
		}));
		this._register(TokenizationRegistry.onDidChange(event => {
			if (event.changedLanguages.includes(textModel.getLanguageId())) this.resetTokenization();
		}));
		this.scheduleAnalysis();
	}

	get modelVersion(): number {
		return this.languageTokenLineIndex.modelVersion;
	}

	get tokenCount(): number {
		return this.languageTokenLineIndex.tokenCount;
	}

	get lines(): readonly LanguageTokenLine[] {
		return this.languageTokenLineIndex.lines;
	}

	getLanguageTokens(lineIndex: number): readonly LanguageToken[] {
		return this.languageTokenLineIndex.getLineTokens(lineIndex);
	}

	get hasTokens(): boolean {
		return this.languageTokenLineIndex.tokenCount > 0 || !this.semanticTokensStore.isEmpty();
	}

	setSemanticTokens(tokens: SparseMultilineTokens[] | null, isComplete: boolean): void {
		this.semanticTokensStore.set(tokens, isComplete, this.textModel);
		this.changeEmitter.fire();
	}

	setPartialSemanticTokens(range: Range, tokens: SparseMultilineTokens[] | null): void {
		if (this.semanticTokensStore.isComplete()) return;
		this.semanticTokensStore.setPartial(range, tokens ?? []);
		this.changeEmitter.fire();
	}

	hasCompleteSemanticTokens(): boolean {
		return this.semanticTokensStore.isComplete();
	}

	hasSomeSemanticTokens(): boolean {
		return !this.semanticTokensStore.isEmpty();
	}

	resetTokenization(): void {
		this.coordinator.restartWorker();
		this.tokenStore.clear();
		this.scheduleAnalysis();
	}

	forceTokenization(lineNumber: number): void {
		this.validateLineNumber(lineNumber);
		if (this.hasAccurateTokensForLine(lineNumber)) return;
		this.scheduleAnalysis();
		throw new SynchronousTokenizationUnavailableError(lineNumber);
	}

	tokenizeIfCheap(lineNumber: number): void {
		if (this.isCheapToTokenize(lineNumber)) this.forceTokenization(lineNumber);
	}

	hasAccurateTokensForLine(lineNumber: number): boolean {
		this.validateLineNumber(lineNumber);
		return !this.hasTokenProvider() || (
			this.languageTokenLineIndex.modelVersion === this.textModel.version
			&& this.languageTokenLineIndex.requestId !== undefined
		);
	}

	isCheapToTokenize(lineNumber: number): boolean {
		return this.hasAccurateTokensForLine(lineNumber);
	}

	getLineTokens(lineNumber: number): LineTokens {
		this.validateLineNumber(lineNumber);
		const lineContent = this.textModel.getLineContent(lineNumber);
		const syntacticTokens = createLineTokens(
			lineContent,
			this.languageTokenLineIndex.getLineTokens(lineNumber - 1),
			this.textModel.getLanguageId(),
			this.languageIdCodec,
		);
		return this.semanticTokensStore.addSparseTokens(lineNumber, syntacticTokens);
	}

	getTokenTypeIfInsertingCharacter(lineNumber: number, column: number, character: string): StandardTokenType {
		const position = this.textModel.validatePosition(new Position(lineNumber, column));
		if (typeof character !== 'string' || character.length === 0) throw new TypeError('Tokenization insertion character must be non-empty text');
		if (!this.hasTokenProvider()) return StandardTokenType.Other;
		this.forceTokenization(position.lineNumber);
		throw new SynchronousTokenizationUnavailableError(position.lineNumber);
	}

	tokenizeLinesAt(lineNumber: number, lines: string[]): LineTokens[] | null {
		this.validateLineNumber(lineNumber);
		if (!Array.isArray(lines) || lines.some(line => typeof line !== 'string')) throw new TypeError('Tokenization lines must be strings');
		return null;
	}

	getLanguageId(): string {
		return this.textModel.getLanguageId();
	}

	getLanguageIdAtPosition(lineNumber: number, column: number): string {
		const position = this.textModel.validatePosition(new Position(lineNumber, column));
		const lineTokens = this.getLineTokens(position.lineNumber);
		return lineTokens.getLanguageId(lineTokens.findTokenIndexAtOffset(position.column - 1));
	}

	setLanguageId(languageId: string, source?: string): void {
		this.textModel.setLanguage(languageId, source);
	}

	get backgroundTokenizationState(): BackgroundTokenizationState {
		return this.hasAccurateTokensForLine(1)
			? BackgroundTokenizationState.Completed
			: BackgroundTokenizationState.InProgress;
	}

	private hasTokenProvider(): boolean {
		const languageId = this.textModel.getLanguageId();
		return !this.textModel.largeFile.tooLargeForTokenization && (
			this.hasWorkerProvider
			|| TokenizationRegistry.get(languageId) !== null
			|| !TokenizationRegistry.isResolved(languageId)
			|| this.syntaxProviderRegistry.getTokenProviders(languageId).length > 0
		);
	}

	private scheduleAnalysis(): void {
		const generation = ++this.requestGeneration;
		if (this.textModel.largeFile.tooLargeForTokenization) return;
		const languageId = this.textModel.getLanguageId();
		if (!this.hasTokenProvider()) return;
		queueMicrotask(() => void this.requestAnalysis(generation, languageId));
	}

	private async requestAnalysis(generation: number, languageId: string): Promise<void> {
		try {
			if (this.isDisposed || generation !== this.requestGeneration || languageId !== this.textModel.getLanguageId()) return;
			await this.coordinator.runLatest(SYNTAX_TOKEN_LANE, { languageId }, result => {
				if (result.value.lane !== SYNTAX_TOKEN_LANE) throw new TypeError('Token request returned a different lane');
				const acceptance = this.tokenStore.accept({ ...result, value: result.value.value });
				if (acceptance !== LanguageResultAcceptance.Applied) {
					throw new Error(`Token store rejected current result as '${acceptance}'`);
				}
			});
		} catch (error) {
			if (this.isDisposed || generation !== this.requestGeneration || isCancellation(error)) return;
			this.errorEmitter.fire(error);
		}
	}

	private validateLineNumber(lineNumber: number): void {
		if (!Number.isSafeInteger(lineNumber) || lineNumber < 1 || lineNumber > this.textModel.getLineCount()) {
			throw new RangeError('Tokenization line number is outside the TextModel');
		}
	}
}

function createLineTokens(lineContent: string, tokens: readonly LanguageToken[], topLevelLanguageId: string, codec: ILanguageIdCodec): LineTokens {
	const data: { text: string; metadata: number }[] = [];
	let offset = 0;
	for (const token of tokens) {
		const startOffset = token.range.startColumn - 1;
		const endOffset = token.range.endColumn - 1;
		if (startOffset > offset) appendToken(data, lineContent.slice(offset, startOffset), metadata(topLevelLanguageId, StandardTokenType.Other, true, codec));
		const standardType = standardTokenType(token.tokenType);
		appendToken(data, lineContent.slice(startOffset, endOffset), metadata(
			token.languageId ?? topLevelLanguageId,
			standardType,
			token.balancedBrackets !== false && standardType === StandardTokenType.Other,
			codec,
		));
		offset = endOffset;
	}
	if (offset < lineContent.length || data.length === 0) {
		appendToken(data, lineContent.slice(offset), metadata(topLevelLanguageId, StandardTokenType.Other, true, codec));
	}
	return LineTokens.createFromTextAndMetadata(data, codec);
}

function appendToken(target: { text: string; metadata: number }[], text: string, tokenMetadata: number): void {
	const previous = target.at(-1);
	if (previous?.metadata === tokenMetadata) {
		previous.text += text;
		return;
	}
	target.push({ text, metadata: tokenMetadata });
}

function metadata(languageId: string, tokenType: StandardTokenType, balancedBrackets: boolean, codec: ILanguageIdCodec): number {
	return (
		(codec.encodeLanguageId(languageId) << MetadataConsts.LANGUAGEID_OFFSET)
		| (tokenType << MetadataConsts.TOKEN_TYPE_OFFSET)
		| (balancedBrackets ? MetadataConsts.BALANCED_BRACKETS_MASK : 0)
		| (FontStyle.None << MetadataConsts.FONT_STYLE_OFFSET)
		| (ColorId.DefaultForeground << MetadataConsts.FOREGROUND_OFFSET)
		| (ColorId.DefaultBackground << MetadataConsts.BACKGROUND_OFFSET)
	) >>> 0;
}

function standardTokenType(tokenType: string): StandardTokenType {
	if (tokenType === 'comment') return StandardTokenType.Comment;
	if (tokenType === 'string') return StandardTokenType.String;
	if (tokenType === 'regexp' || tokenType === 'regex') return StandardTokenType.RegEx;
	return StandardTokenType.Other;
}

function isCancellation(error: unknown): boolean {
	return error instanceof Error && (error.name === 'AbortError' || error.name === 'Canceled' || error.name === 'CancellationError');
}

class ModelLanguageIdCodec implements ILanguageIdCodec {
	private readonly ids = new Map<string, LanguageId>([['plaintext', LanguageId.PlainText]]);
	private readonly languages = new Map<LanguageId, string>([[LanguageId.PlainText, 'plaintext']]);

	encodeLanguageId(languageId: string): LanguageId {
		const current = this.ids.get(languageId);
		if (current !== undefined) return current;
		const next = this.ids.size + 1;
		if (next > MetadataConsts.LANGUAGEID_MASK) throw new RangeError('TextModel tokenization exhausted encoded language IDs');
		const encoded = next as LanguageId;
		this.ids.set(languageId, encoded);
		this.languages.set(encoded, languageId);
		return encoded;
	}

	decodeLanguageId(languageId: LanguageId): string {
		return this.languages.get(languageId) ?? 'plaintext';
	}
}
