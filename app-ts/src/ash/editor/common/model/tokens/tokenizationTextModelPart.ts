import { LanguageResultAcceptance } from '../languageResultStore.js';
import { Emitter, type Event } from '../../../../base/common/event.js';
import { Disposable, MutableDisposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { Position } from '../../core/position.js';
import { type Range } from '../../core/range.js';
import { countEOL } from '../../core/misc/eolCounter.js';
import { ColorId, FontStyle, LanguageId, MetadataConsts, StandardTokenType } from '../../encodedTokenAttributes.js';
import { SYNTAX_TOKEN_LANE, SYNTAX_TOKENIZE_LANE, assertSyntaxRequest, type SyntaxLane, type SyntaxRequest, type SyntaxResult, TokenizationRegistry, type ILanguageIdCodec, type LanguageSemanticTokensProvider, type SyntaxServiceOptions } from '../../languages.js';
import { type LanguageFeatureRegistry, SyntaxProviderRegistry } from '../../languageFeatureRegistry.js';
import { createLanguageTokenStore, createLanguageTokenSnapshotNormalizer, type LanguageTokenizationSource, type LanguageToken, type SemanticTokenModelSource, type SemanticTokenSource } from '../../tokens/languageTokens.js';
import { BackgroundTokenizationState, type ITokenizationTextModelPart, SynchronousTokenizationUnavailableError } from '../../tokenizationTextModelPart.js';
import { LanguageTokenLineIndex, StyledTokenSource, overlayTokenSources, type LanguageTokenLine } from '../../tokens/languageTokenLineIndex.js';
import { LineTokens } from '../../tokens/lineTokens.js';
import { type SparseMultilineTokens } from '../../tokens/sparseMultilineTokens.js';
import { SparseTokensStore } from '../../tokens/sparseTokensStore.js';
import { type TextModel } from '../textModel.js';
import { TokenizerSyntaxTokenBackend } from './tokenizerSyntaxTokenBackend.js';
import { SemanticTokensTextModelPart } from './semanticTokensTextModelPart.js';
import { createSyntaxWorker } from '../../services/editorWebWorker.js';
import { LanguageRequestCoordinator } from '../languageRequestCoordinator.js';
import { toStandardTokenType } from '../../languages/supports/tokenization.js';
import { PLAINTEXT_LANGUAGE_ID } from '../../languages/modesRegistry.js';
import { Color } from '../../../../base/common/color.js';
import { raceCancellationError } from '../../../../base/common/async.js';
import { throwIfCancelled } from '../../../../base/common/cancellation.js';

export interface TokenizationTextModelPartOptions {
	readonly languageIdCodec?: ILanguageIdCodec;
	readonly syntaxProviderRegistry?: SyntaxProviderRegistry;
	readonly syntaxService?: SyntaxServiceOptions;
	readonly documentSemanticTokensProvider?: LanguageFeatureRegistry<LanguageSemanticTokensProvider>;
	readonly onDidChangeLanguageSupport?: Event<void>;
}

/** Owns syntax requests and their line-token index for exactly one TextModel. */
export class TokenizationTextModelPart extends Disposable implements ITokenizationTextModelPart {
	private readonly changeEmitter = this._register(new Emitter<readonly { fromLineNumber: number; toLineNumber: number }[] | undefined>());
	private readonly errorEmitter = this._register(new Emitter<unknown>());
	private readonly languageIdCodec: ILanguageIdCodec;
	private readonly syntaxProviderRegistry: SyntaxProviderRegistry;
	private readonly languageTokenLineIndex: LanguageTokenLineIndex;
	private readonly semanticTokensStore: SparseTokensStore;
	private readonly hasWorkerProvider: boolean;
	private readonly lineBackendListeners = this._register(new DisposableStore());
	private readonly lineBackend = this._register(new MutableDisposable<TokenizerSyntaxTokenBackend>());
	private visibleLines: readonly { startLineNumber: number; endLineNumber: number }[] = [];
	private requestGeneration = 0;
	private pendingAnalysis: Promise<void> = Promise.resolve();

	readonly onDidChange: Event<readonly { fromLineNumber: number; toLineNumber: number }[] | undefined> = this.changeEmitter.event;
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
		this.coordinator = this._register(new LanguageRequestCoordinator(textModel, () => createSyntaxWorker(this.syntaxProviderRegistry, options.syntaxService ?? {}, this.languageIdCodec)));
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
			? overlayTokenSources(lexicalSource, this._register(new StyledTokenSource(this.semanticTokens, 'semantic')))
			: lexicalSource;
		this._register(this.languageTokenLineIndex.onDidChange(() => {
			if (!this.lineBackend.value) this.changeEmitter.fire(undefined);
		}));
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
			this.lineBackendListeners.clear();
			this.lineBackend.clear();
			this.languageIdCodec.encodeLanguageId(textModel.getLanguageId());
			this.semanticTokensStore.flush();
			this.tokenStore.clear();
			this.changeEmitter.fire(undefined);
			this.scheduleAnalysis();
		}));
		this._register(this.syntaxProviderRegistry.onDidChange(() => {
			this.coordinator.restartWorker();
			this.lineBackendListeners.clear();
			this.lineBackend.clear();
			this.tokenStore.clear();
			this.scheduleAnalysis();
		}));
		if (options.onDidChangeLanguageSupport) this._register(options.onDidChangeLanguageSupport(() => {
			// The worker synchronizes its grammar catalog and theme before each request.
			// Retaining it keeps the loaded grammars and document mirror available.
			this.lineBackendListeners.clear();
			this.lineBackend.clear();
			this.tokenStore.clear();
			this.scheduleAnalysis();
		}));
		this._register(TokenizationRegistry.onDidChange(event => {
			if (event.changedLanguages.includes(textModel.getLanguageId())) this.resetTokenization();
		}));
		this.scheduleAnalysis();
	}

	get modelVersion(): number {
		return this.lineBackend.value ? this.textModel.version : this.languageTokenLineIndex.modelVersion;
	}

	get tokenCount(): number {
		return this.lineBackend.value?.tokenCount ?? this.languageTokenLineIndex.tokenCount;
	}

	get lines(): readonly LanguageTokenLine[] {
		return this.lineBackend.value?.lines ?? this.languageTokenLineIndex.lines;
	}

	getLanguageTokens(lineIndex: number): readonly LanguageToken[] {
		return this.lineBackend.value?.getLanguageTokens(lineIndex + 1) ?? this.languageTokenLineIndex.getLineTokens(lineIndex);
	}

	get hasTokens(): boolean {
		return this.tokenCount > 0 || !this.semanticTokensStore.isEmpty();
	}

	setSemanticTokens(tokens: SparseMultilineTokens[] | null, isComplete: boolean): void {
		this.semanticTokensStore.set(tokens, isComplete, this.textModel);
		this.changeEmitter.fire(undefined);
	}

	setPartialSemanticTokens(range: Range, tokens: SparseMultilineTokens[] | null): void {
		if (this.semanticTokensStore.isComplete()) return;
		this.semanticTokensStore.setPartial(range, tokens ?? []);
		this.changeEmitter.fire(undefined);
	}

	hasCompleteSemanticTokens(): boolean {
		return this.semanticTokensStore.isComplete();
	}

	hasSomeSemanticTokens(): boolean {
		return !this.semanticTokensStore.isEmpty();
	}

	resetTokenization(): void {
		this.coordinator.restartWorker();
		this.lineBackendListeners.clear();
		this.lineBackend.clear();
		this.tokenStore.clear();
		this.scheduleAnalysis();
		// Line tokenizers do not write the worker store, so clearing that store alone
		// cannot invalidate retained token styling when a line provider is removed.
		this.changeEmitter.fire(undefined);
	}

	async whenReady(signal: AbortSignal): Promise<void> {
		throwIfCancelled(signal);
		this.assertNotDisposed();
		if (this.lineBackend.value) this.forceTokenization(1);
		while (!this.hasAccurateTokensForLine(1)) {
			const analysis = this.pendingAnalysis;
			try {
				await raceCancellationError(analysis, signal);
			} catch (error) {
				if (signal.aborted || analysis === this.pendingAnalysis) {
					throw error;
				}
			}
			this.assertNotDisposed();
			if (this.lineBackend.value) this.forceTokenization(1);
		}
	}

	forceTokenization(lineNumber: number): void {
		this.validateLineNumber(lineNumber);
		if (this.lineBackend.value) { this.lineBackend.value.forceTokenization(lineNumber); return; }
		if (this.hasAccurateTokensForLine(lineNumber)) return;
		this.scheduleAnalysis();
		throw new SynchronousTokenizationUnavailableError(lineNumber);
	}

	tokenizeIfCheap(lineNumber: number): void {
		if (this.isCheapToTokenize(lineNumber)) this.forceTokenization(lineNumber);
	}

	hasAccurateTokensForLine(lineNumber: number): boolean {
		this.validateLineNumber(lineNumber);
		return this.lineBackend.value?.hasAccurateTokensForLine(lineNumber) ?? (!this.hasTokenProvider() || (
			this.languageTokenLineIndex.modelVersion === this.textModel.version
			&& this.languageTokenLineIndex.requestId !== undefined
		));
	}

	isCheapToTokenize(lineNumber: number): boolean {
		return this.lineBackend.value?.isCheapToTokenize(lineNumber) ?? this.hasAccurateTokensForLine(lineNumber);
	}

	getLineTokens(lineNumber: number): LineTokens {
		this.validateLineNumber(lineNumber);
		const lineContent = this.textModel.getLineContent(lineNumber);
		const syntacticTokens = createLineTokens(
			lineContent,
			this.getLanguageTokens(lineNumber - 1),
			this.textModel.getLanguageId(),
			this.languageIdCodec,
		);
		return this.semanticTokensStore.addSparseTokens(lineNumber, syntacticTokens);
	}

	getTokenTypeIfInsertingCharacter(lineNumber: number, column: number, character: string): StandardTokenType {
		const position = this.textModel.validatePosition(new Position(lineNumber, column));
		if (typeof character !== 'string' || character.length === 0) throw new TypeError('Tokenization insertion character must be non-empty text');
		if (!this.hasTokenProvider()) return StandardTokenType.Other;
		if (this.lineBackend.value) {
			const line = this.textModel.getLineContent(position.lineNumber);
			const tokens = this.tokenizeLinesAt(position.lineNumber, [line.slice(0, position.column - 1) + character + line.slice(position.column - 1)])![0]!;
			return tokens.getStandardTokenType(tokens.findTokenIndexAtOffset(position.column - 1));
		}
		this.forceTokenization(position.lineNumber);
		throw new SynchronousTokenizationUnavailableError(position.lineNumber);
	}

	tokenizeLinesAt(lineNumber: number, lines: string[]): LineTokens[] | null {
		this.validateLineNumber(lineNumber);
		if (!Array.isArray(lines) || lines.some(line => typeof line !== 'string')) throw new TypeError('Tokenization lines must be strings');
		const backend = this.lineBackend.value;
		return backend ? backend.tokenizeLinesAt(lineNumber, lines).map((tokens, index) => createLineTokens(lines[index]!, tokens, this.textModel.getLanguageId(), this.languageIdCodec)) : null;
	}

	async tokenizeLinesAtAsync(lineNumber: number, lines: readonly string[], signal: AbortSignal): Promise<LineTokens[] | null> {
		this.validateLineNumber(lineNumber);
		const languageId = this.textModel.getLanguageId();
		const payload = { languageId, tokenize: { lineNumber, lines: [...lines] } };
		assertSyntaxRequest(payload);
		if (!this.hasTokenProvider() || signal.aborted) return null;
		if (this.lineBackend.value) return this.tokenizeLinesAt(lineNumber, [...lines]);
		const text = lines.join('\n');
		const generation = this.requestGeneration;
		let result: LineTokens[] | null = null;
		await this.coordinator.runLatest(SYNTAX_TOKENIZE_LANE, payload, response => {
			if (response.value.lane !== SYNTAX_TOKENIZE_LANE) throw new TypeError('Hypothetical tokenization returned a different lane');
			if (response.value.value === null || generation !== this.requestGeneration) return;
			const tokens = createLanguageTokenSnapshotNormalizer({
				version: response.modelVersion, length: text.length, lineCount: payload.tokenize.lines.length,
				getText: () => text, getTextBetweenOffsets: (start, end) => text.slice(start, end),
			})(response.value.value).tokens;
			const byLine = new Map<number, LanguageToken[]>();
			for (const token of tokens) {
				const group = byLine.get(token.range.startLineNumber) ?? [];
				group.push(token);
				byLine.set(token.range.startLineNumber, group);
			}
			result = payload.tokenize.lines.map((line, index) => createLineTokens(line, byLine.get(index + 1) ?? [], languageId, this.languageIdCodec));
		}, { signal });
		return result;
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
		return this.hasAccurateTokensForLine(this.textModel.getLineCount())
			? BackgroundTokenizationState.Completed
			: BackgroundTokenizationState.InProgress;
	}

	setVisibleLines(ranges: readonly { startLineNumber: number; endLineNumber: number }[]): void {
		this.visibleLines = ranges;
		for (const range of ranges) this.lineBackend.value?.refreshRange(range.startLineNumber, range.endLineNumber);
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
		const languageId = this.textModel.getLanguageId();
		if (!this.hasTokenProvider()) {
			this.pendingAnalysis = Promise.resolve();
			return;
		}
		const support = TokenizationRegistry.get(languageId);
		if (support) {
			if (!this.lineBackend.value) {
				const backend = this.lineBackend.value = new TokenizerSyntaxTokenBackend(this.textModel, support, this.languageIdCodec);
				this.lineBackendListeners.clear();
				this.lineBackendListeners.add(backend.onDidChangeTokens(ranges => this.changeEmitter.fire(ranges)));
				this.lineBackendListeners.add(backend.onDidEncounterError(error => this.errorEmitter.fire(error)));
				this.setVisibleLines(this.visibleLines);
			}
			this.pendingAnalysis = Promise.resolve();
			return;
		}
		// Readers join the same scheduled request; opening another view must not restart its worker.
		this.pendingAnalysis = Promise.resolve().then(() => this.requestAnalysis(generation, languageId));
		void this.pendingAnalysis.catch(error => {
			if (this.isDisposed || generation !== this.requestGeneration || isCancellation(error)) return;
			this.errorEmitter.fire(error);
		});
	}

	private async requestAnalysis(generation: number, languageId: string): Promise<void> {
		if (this.isDisposed || generation !== this.requestGeneration || languageId !== this.textModel.getLanguageId()) return;
		if (!TokenizationRegistry.isResolved(languageId)) {
			const support = await TokenizationRegistry.getOrCreate(languageId);
			if (this.isDisposed || generation !== this.requestGeneration) return;
			if (support) { this.scheduleAnalysis(); return; }
		}
		await this.coordinator.runLatest(SYNTAX_TOKEN_LANE, { languageId }, result => {
			if (result.value.lane !== SYNTAX_TOKEN_LANE) throw new TypeError('Token request returned a different lane');
			const acceptance = this.tokenStore.accept({ ...result, value: result.value.value });
			if (acceptance !== LanguageResultAcceptance.Applied) {
				throw new Error(`Token store rejected current result as '${acceptance}'`);
			}
		});
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
		const standardType = toStandardTokenType(token.tokenType);
		appendToken(data, lineContent.slice(startOffset, endOffset), metadata(
			token.languageId ?? topLevelLanguageId,
			standardType,
			token.balancedBrackets !== false && standardType === StandardTokenType.Other,
			codec,
			token.presentation,
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

function metadata(languageId: string, tokenType: StandardTokenType, balancedBrackets: boolean, codec: ILanguageIdCodec, presentation?: LanguageToken['presentation']): number {
	let foreground: number = ColorId.DefaultForeground;
	let background: number = ColorId.DefaultBackground;
	let fontStyle = FontStyle.None;
	if (presentation) {
		const colors = TokenizationRegistry.getColorMap();
		const foregroundColor = presentation.foreground ? Color.fromHex(presentation.foreground) : undefined;
		const backgroundColor = presentation.background ? Color.fromHex(presentation.background) : undefined;
		const foregroundId = foregroundColor && colors?.findIndex((color, index) => index > 0 && color.equals(foregroundColor));
		const backgroundId = backgroundColor && colors?.findIndex((color, index) => index > 0 && color.equals(backgroundColor));
		if (foregroundId !== undefined && foregroundId > 0) foreground = foregroundId;
		if (backgroundId !== undefined && backgroundId > 0) background = backgroundId;
		for (const style of presentation.fontStyle ?? []) {
			switch (style) {
				case 'italic': fontStyle |= FontStyle.Italic; break;
				case 'bold': fontStyle |= FontStyle.Bold; break;
				case 'underline': fontStyle |= FontStyle.Underline; break;
				case 'strikethrough': fontStyle |= FontStyle.Strikethrough; break;
			}
		}
	}
	return (
		(codec.encodeLanguageId(languageId) << MetadataConsts.LANGUAGEID_OFFSET)
		| (tokenType << MetadataConsts.TOKEN_TYPE_OFFSET)
		| (balancedBrackets ? MetadataConsts.BALANCED_BRACKETS_MASK : 0)
		| (fontStyle << MetadataConsts.FONT_STYLE_OFFSET)
		| (foreground << MetadataConsts.FOREGROUND_OFFSET)
		| (background << MetadataConsts.BACKGROUND_OFFSET)
	) >>> 0;
}

function isCancellation(error: unknown): boolean {
	return error instanceof Error && (error.name === 'AbortError' || error.name === 'Canceled' || error.name === 'CancellationError');
}

class ModelLanguageIdCodec implements ILanguageIdCodec {
	private readonly ids = new Map<string, LanguageId>([[PLAINTEXT_LANGUAGE_ID, LanguageId.PlainText]]);
	private readonly languages = new Map<LanguageId, string>([[LanguageId.PlainText, PLAINTEXT_LANGUAGE_ID]]);

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
		return this.languages.get(languageId) ?? PLAINTEXT_LANGUAGE_ID;
	}
}
