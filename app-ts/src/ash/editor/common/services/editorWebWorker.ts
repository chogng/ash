import * as languages from '../languages.js';
import { Range, type IRange } from '../core/range.js';
import { type LanguageToken, createLanguageTokenSnapshotNormalizer, type LanguageTokenResult } from '../tokens/languageTokens.js';
import { SyntaxProviderRegistry } from '../languageFeatureRegistry.js';
import { type LanguageWorkerModelSynchronizer, type LanguageWorkerResultSettler, type LanguageWorkerResultDisposition, type LanguageWorkerRequest } from '../model/languageRequestCoordinator.js';
import { type WorkerTextModelCodec, type LanguageWorkerDocumentSynchronization, type LanguageWorkerDocumentSynchronizationObserver } from './textModelSync/textModelSync.protocol.js';
import { Position } from "../core/position.js";
import { getTextWordSegments } from "../core/textSegmentation.js";
import { AbstractDisposable } from '../../../base/common/lifecycle.js';
import { normalizeTextLineEndings, type TextSnapshot } from '../core/textChange.js';
import { StringText } from '../core/text/abstractText.js';
import { TextReplacement } from '../core/edits/textEdit.js';
import { TokenizationStateStore } from '../model/textModelTokens.js';
import type { TextModel } from '../model/textModel.js';
import { Color } from '../../../base/common/color.js';
import { ColorId, FontStyle, StandardTokenType, TokenMetadata } from '../encodedTokenAttributes.js';
import { getWordAtText } from '../core/wordHelper.js';
import { BasicInplaceReplace } from '../languages/supports/inplaceReplaceSupport.js';
import { type UnicodeHighlight, type UnicodeHighlightKind, computeUnicodeHighlights } from './unicodeTextModelHighlighter.js';
import { URI } from '../../../base/common/uri.js';
import { EDITOR_WORKER_TEXTUAL_SUGGEST_LANE, EDITOR_WORKER_MINIMAL_EDITS_LANE, EDITOR_WORKER_NAVIGATE_VALUE_LANE, EDITOR_WORKER_UNICODE_HIGHLIGHTS_LANE, type EditorWorkerImplementation, type EditorWorkerLane, type EditorWorkerMinimalEditsRequest, type EditorWorkerNavigateValueRequest, type EditorWorkerRequest, type EditorWorkerResult } from './editorWorker.js';

const MINIMAL_EDIT_LIMIT = 100_000;

/** Executes model-versioned editor computations inside a dedicated Worker or in-process host. */
export class EditorWorker extends AbstractDisposable implements EditorWorkerImplementation {
	private readonly wordProvider = createLanguageWordCompletionProvider();

	public async run(request: LanguageWorkerRequest<EditorWorkerLane, EditorWorkerRequest>, signal: AbortSignal): Promise<EditorWorkerResult> {
		this.assertNotDisposed();
		signal.throwIfAborted();
		switch (request.lane) {
			case EDITOR_WORKER_TEXTUAL_SUGGEST_LANE: {
				const payload = request.payload as languages.LanguageCompletionRequest;
				const result = await this.wordProvider.provideCompletions({ ...payload, requestId: request.requestId, snapshot: request.snapshot }, signal);
				return {
					position: payload.position,
					items: (result?.items ?? []).map(item => ({ ...item, providerId: this.wordProvider.id, hasDeferredDetails: false })),
					isIncomplete: result?.isIncomplete ?? false,
				};
			}
			case EDITOR_WORKER_UNICODE_HIGHLIGHTS_LANE:
				return computeUnicodeHighlights(request.snapshot, signal);
			case EDITOR_WORKER_MINIMAL_EDITS_LANE:
				return computeMoreMinimalEdits(request.snapshot, request.payload as EditorWorkerMinimalEditsRequest, signal);
			case EDITOR_WORKER_NAVIGATE_VALUE_LANE:
				return navigateValueSet(request.snapshot, request.payload as EditorWorkerNavigateValueRequest);
		}
	}

	protected disposeCore(): void {}
}

function computeMoreMinimalEdits(snapshot: TextSnapshot, request: EditorWorkerMinimalEditsRequest, signal: AbortSignal): readonly languages.TextEdit[] {
	const document = new StringText(snapshot.getText());
	const edits = mergeAdjacentEdits(request.edits);
	const result: languages.TextEdit[] = [];
	const eol = [...request.edits].reverse().find(edit => edit.eol !== undefined)?.eol;
	for (const edit of edits) {
		signal.throwIfAborted();
		const text = normalizeTextLineEndings(edit.text);
		const range = Range.lift(edit.range);
		const original = document.getValueOfRange(range);
		if (original === text) continue;
		if (Math.max(original.length, text.length) > MINIMAL_EDIT_LIMIT) {
			result.push(Object.freeze({ range: edit.range, text }));
			continue;
		}
		const replacement = new TextReplacement(range, text).removeCommonPrefixAndSuffix(document);
		if (!replacement.isEmpty) result.push(Object.freeze({ range: replacement.range, text: replacement.text }));
	}
	if (eol !== undefined) {
		if (result.length > 0) {
			result[result.length - 1] = { ...result[result.length - 1], eol };
		} else {
			result.push({ range: new Range(1, 1, 1, 1), text: '', eol });
		}
	}
	return Object.freeze(result);
}

function mergeAdjacentEdits(edits: readonly languages.TextEdit[]): readonly languages.TextEdit[] {
	const sorted = edits.map(edit => Object.freeze({ range: Range.lift(edit.range), text: edit.text })).sort((left, right) => Position.compare(left.range.getStartPosition(), right.range.getStartPosition()));
	const result: { readonly range: Range; readonly text: string }[] = [];
	for (const edit of sorted) {
		const previous = result.at(-1);
		if (previous && previous.range.getEndPosition().equals(edit.range.getStartPosition())) {
			result[result.length - 1] = Object.freeze({ range: previous.range.plusRange(edit.range), text: previous.text + edit.text });
			continue;
		}
		if (previous && Position.isBefore(edit.range.getStartPosition(), previous.range.getEndPosition())) throw new RangeError('Editor worker edits must not overlap');
		result.push(edit);
	}
	return result;
}

function navigateValueSet(snapshot: TextSnapshot, request: EditorWorkerNavigateValueRequest): EditorWorkerResult {
	const document = new StringText(snapshot.getText());
	const range = validateRange(document, request.range);
	const selectionRange = range.isEmpty() && range.getEndPosition().column <= document.getLineLength(range.getEndPosition().lineNumber)
		? Range.fromPositions(range.getStartPosition(), new Position(range.endLineNumber, range.endColumn + 1))
		: range;
	const selectionText = document.getValueOfRange(selectionRange);
	const line = document.getLineAt(range.getStartPosition().lineNumber);
	const word = getWordAtText(range.getStartPosition().column, request.wordDefinition, line, 0)
		?? (range.startColumn > 1 ? getWordAtText(range.startColumn - 1, request.wordDefinition, line, 0) : undefined);
	const wordRange = word ? Range.fromPositions(
		new Position(range.startLineNumber, word.startColumn),
		new Position(range.startLineNumber, word.endColumn),
	) : undefined;
	if (range.isEmpty() && wordRange) {
		return BasicInplaceReplace.INSTANCE.navigateValueSet(wordRange, word!.word, selectionRange, selectionText, request.up) ?? undefined;
	}
	return BasicInplaceReplace.INSTANCE.navigateValueSet(selectionRange, selectionText, wordRange ?? selectionRange, word?.word ?? null, request.up) ?? undefined;
}

function validateRange(document: StringText, range: Range): Range {
	const lifted = Range.fromPositions(range.getStartPosition(), range.getEndPosition());
	document.getValueOfRange(lifted);
	return lifted;
}

const DEFAULT_MAXIMUM_WORD_COMPLETIONS = 100;

export interface LanguageWordCompletionProviderOptions {
	readonly id?: string;
	readonly languageIds?: readonly string[];
	readonly maximumItems?: number;
}

/** Creates a snapshot-local lexical word provider suitable for a worker realm. */
export function createLanguageWordCompletionProvider(options: LanguageWordCompletionProviderOptions = {}): languages.LanguageCompletionProvider {
	const id = options.id ?? "language.word";
	const languageIds = Object.freeze([...(options.languageIds ?? ["*"])]);
	const maximumItems = options.maximumItems ?? DEFAULT_MAXIMUM_WORD_COMPLETIONS;
	if (!Number.isSafeInteger(maximumItems) || maximumItems <= 0) {
		throw new RangeError("Maximum word completion items must be a positive safe integer");
	}
	return Object.freeze({
		id,
		languageIds,
		provideCompletions: (request: languages.LanguageCompletionProviderRequest, signal: AbortSignal): languages.LanguageCompletionProviderResult | undefined => {
			signal.throwIfAborted();
			const lines = request.snapshot.getText().split("\n");
			const columnIndex = request.position.column - 1;
			const triggerLine = lines[request.position.lineNumber - 1];
			if (triggerLine === undefined || columnIndex < 0 || columnIndex > triggerLine.length) {
				throw new RangeError("Word completion position is outside its snapshot");
			}
			const active = getTextWordSegments(triggerLine).find(segment => (
				segment.wordLike &&
				columnIndex > segment.start &&
				columnIndex <= segment.end
			));
			if (!active) return undefined;
			const prefix = triggerLine.slice(active.start, columnIndex);
			if (prefix.length === 0) return undefined;
			const currentWord = triggerLine.slice(active.start, active.end);
			const words = new Set<string>();
			for (const line of lines) {
				signal.throwIfAborted();
				for (const segment of getTextWordSegments(line)) {
					if (!segment.wordLike) continue;
					const word = line.slice(segment.start, segment.end);
					if (word !== currentWord && word.startsWith(prefix)) words.add(word);
				}
			}
			const candidates = [...words].sort().slice(0, maximumItems);
			if (candidates.length === 0) return undefined;
			const range = Range.fromPositions(
				new Position(request.position.lineNumber, active.start + 1),
				new Position(request.position.lineNumber, active.end + 1),
			);
			return Object.freeze({
				items: Object.freeze(candidates.map(word => Object.freeze({
					id: wordIdentity(word),
					label: word,
					kind: languages.LanguageCompletionItemKind.Text,
					range,
					insertText: word,
					sortText: word,
				}))),
				isIncomplete: words.size > maximumItems,
			});
		},
	});
}

function wordIdentity(word: string): string {
	return `word-${[...word].map(character => character.codePointAt(0)!.toString(16)).join("-")}`;
}

/** Provider host shared by in-process and Worker transports. */
export class SyntaxProviderWorker implements languages.SyntaxWorker, LanguageWorkerDocumentSynchronizationObserver {
	private disposed = false;
	private tokenizationCache: {
		readonly support: languages.ITokenizationSupport;
		readonly languageId: string;
		readonly initialState: languages.IState;
		readonly states: TokenizationStateStore<languages.IState>;
		readonly lines: readonly { text: string; hasEOL: boolean; tokens: readonly languages.Token[] | Uint32Array; rawTokens?: readonly languages.Token[] }[];
	} | undefined;

	constructor(
		private readonly registry: SyntaxProviderRegistry,
		private readonly onProviderError: languages.SyntaxProviderErrorHandler = reportProviderError,
		private readonly languageIdCodec?: languages.ILanguageIdCodec,
		private readonly model?: TextModel,
	) {
		if (typeof onProviderError !== "function") {
			throw new TypeError("Syntax provider error handler must be a function");
		}
	}

	async run(request: LanguageWorkerRequest<languages.SyntaxLane, languages.SyntaxRequest>, signal: AbortSignal): Promise<languages.SyntaxResult> {
		this.ensureAlive();
		signal.throwIfAborted();
		languages.assertSyntaxRequest(request.payload);
		if (request.lane === languages.SYNTAX_TOKEN_LANE) {
			return Object.freeze({
				lane: languages.SYNTAX_TOKEN_LANE,
				value: await this.runTokens(request, signal),
			});
		}
		if (request.lane === languages.SYNTAX_TOKENIZE_LANE) {
			return Object.freeze({ lane: languages.SYNTAX_TOKENIZE_LANE, value: await this.runTokenization(request, signal) });
		}
		if (request.lane === languages.SYNTAX_DIAGNOSTIC_LANE) {
			return Object.freeze({
				lane: languages.SYNTAX_DIAGNOSTIC_LANE,
				value: await this.runDiagnostics(request, signal),
			});
		}
		throw new RangeError(`Unknown syntax lane '${request.lane}'`);
	}

	dispose(): void {
		this.disposed = true;
		this.tokenizationCache = undefined;
	}

	[Symbol.dispose](): void {
		this.dispose();
	}

	synchronizeDocument(synchronization: LanguageWorkerDocumentSynchronization): void {
		this.ensureAlive();
		for (const provider of this.registry.getDocumentSynchronizers()) {
			try {
				provider.synchronizeDocument!(synchronization);
			} catch (error) {
				this.reportProviderError(provider.id, languages.SYNTAX_SYNCHRONIZATION, error);
			}
		}
	}

	private async runTokens(request: LanguageWorkerRequest<languages.SyntaxLane, languages.SyntaxRequest>, signal: AbortSignal): Promise<LanguageTokenResult> {
		const providers = this.registry.getTokenProviders(request.payload.languageId);
		const support = await this.getTokenizationSupport(request.payload.languageId);
		signal.throwIfAborted();
		if (support) return this.tokenizeDocument(support, request, signal);
		if (providers.length === 0) return EMPTY_TOKENS;
		const normalize = createLanguageTokenSnapshotNormalizer(request.snapshot);
		for (const provider of providers) {
			try {
				const value = await provider.provideTokens!(providerRequest(request, this.model), signal);
				signal.throwIfAborted();
				if (value !== undefined) return normalize(value);
			} catch (error) {
				if (signal.aborted) throw error;
				this.reportProviderError(provider.id, languages.SYNTAX_TOKEN_LANE, error);
			}
		}
		return EMPTY_TOKENS;
	}

	private async getTokenizationSupport(languageId: string): Promise<languages.ITokenizationSupport | null> {
		if (this.registry.getTokenProviders(languageId).some(provider => provider.tokenPriority > 0)) return null;
		return languages.TokenizationRegistry.get(languageId) ?? (languages.TokenizationRegistry.isResolved(languageId)
			? null : await languages.TokenizationRegistry.getOrCreate(languageId));
	}

	private tokenizeDocument(support: languages.ITokenizationSupport, request: LanguageWorkerRequest<languages.SyntaxLane, languages.SyntaxRequest>, signal: AbortSignal): LanguageTokenResult {
		const tokens: LanguageToken[] = [];
		const cached = this.tokenizationCache?.support === support && this.tokenizationCache.languageId === request.payload.languageId
			? this.tokenizationCache
			: undefined;
		const next: { text: string; hasEOL: boolean; tokens: readonly languages.Token[] | Uint32Array; rawTokens?: readonly languages.Token[] }[] = [];
		const states = new TokenizationStateStore<languages.IState>();
		let state = support.getInitialState();
		const initialState = state.clone();
		const lines = request.snapshot.getText().split('\n');
		for (let index = 0; index < lines.length; index++) {
			signal.throwIfAborted();
			const line = lines[index]!;
			const hasEOL = index < lines.length - 1;
			const previous = cached?.lines[index];
			const previousStartState = index === 0 ? cached?.initialState : cached?.states.getEndState(index);
			const previousEndState = cached?.states.getEndState(index + 1);
			const result = previous?.text === line && previous.hasEOL === hasEOL && previousStartState?.equals(state) && previousEndState
				? { tokens: previous.tokens, rawTokens: previous.rawTokens, endState: previousEndState }
				: support.tokenizeEncoded ? support.tokenizeEncoded(line, hasEOL, state.clone()) : support.tokenize(line, hasEOL, state.clone());
			const rawTokens = 'rawTokens' in result ? result.rawTokens : undefined;
			next.push({ text: line, hasEOL, tokens: result.tokens, rawTokens });
			states.setEndState(index + 1, result.endState.clone());
			state = result.endState;
			this.appendLineTokens(tokens, result.tokens, index + 1, line, rawTokens);
		}
		const normalized = createLanguageTokenSnapshotNormalizer(request.snapshot)({ tokens });
		this.tokenizationCache = { support, languageId: request.payload.languageId, initialState, states, lines: next };
		return normalized;
	}

	private appendLineTokens(target: LanguageToken[], tokens: readonly languages.Token[] | Uint32Array, lineNumber: number, line: string, rawTokens?: readonly languages.Token[]): void {
		if (!(tokens instanceof Uint32Array)) {
			for (let index = 0; index < tokens.length; index++) {
				const token = tokens[index]!;
				const end = tokens[index + 1]?.offset ?? line.length;
				if (end > token.offset && token.type) {
					target.push({ range: new Range(lineNumber, token.offset + 1, lineNumber, end + 1), tokenType: token.type, modifiers: [], languageId: token.language });
				}
			}
			return;
		}
		const codec = this.languageIdCodec;
		const colors = languages.TokenizationRegistry.getColorMap();
		if (!codec || !colors) {
			throw new ReferenceError('Encoded tokenization requires a language codec and color map');
		}
		if (tokens.length % 2 !== 0) {
			throw new TypeError('Encoded tokens must contain offset and metadata pairs');
		}
		let rawIndex = 0;
		for (let index = 0; index < tokens.length; index += 2) {
			const start = tokens[index]!;
			const end = tokens[index + 2] ?? line.length;
			if (end <= start) {
				continue;
			}
			const metadata = tokens[index + 1]!;
			const type = TokenMetadata.getTokenType(metadata);
			const foreground = TokenMetadata.getForeground(metadata);
			const background = TokenMetadata.getBackground(metadata);
			const style = TokenMetadata.getFontStyle(metadata);
			const fontStyle: NonNullable<LanguageToken['presentation']>['fontStyle'] = [
				...(style & FontStyle.Italic ? ['italic' as const] : []),
				...(style & FontStyle.Bold ? ['bold' as const] : []),
				...(style & FontStyle.Underline ? ['underline' as const] : []),
				...(style & FontStyle.Strikethrough ? ['strikethrough' as const] : []),
			];
			const languageId = codec.decodeLanguageId(TokenMetadata.getLanguageId(metadata));
			const standardType = type === StandardTokenType.Comment ? 'comment' : type === StandardTokenType.String ? 'string' : type === StandardTokenType.RegEx ? 'regexp' : 'other';
			const presentation = {
				foreground: foreground === ColorId.None ? undefined : Color.Format.CSS.formatHexA(colors[foreground]!, true),
				background: background === ColorId.None || background === ColorId.DefaultBackground ? undefined : Color.Format.CSS.formatHexA(colors[background]!, true),
				fontStyle,
			};
			while (rawTokens?.[rawIndex + 1] && rawTokens[rawIndex + 1]!.offset <= start) rawIndex++;
			const append = (from: number, to: number): void => {
				if (to <= from) return;
				const rawToken = rawTokens?.[rawIndex];
				target.push({
					range: new Range(lineNumber, from + 1, lineNumber, to + 1),
					tokenType: rawToken && rawToken.offset <= from && rawToken.language === languageId && rawToken.type ? rawToken.type : standardType,
					modifiers: [],
					languageId,
					...(TokenMetadata.containsBalancedBrackets(metadata) ? {} : { balancedBrackets: false as const }),
					presentation,
				});
			};
			let segmentStart = start;
			while (rawTokens?.[rawIndex + 1] && rawTokens[rawIndex + 1]!.offset < end) {
				const boundary = rawTokens[rawIndex + 1]!.offset;
				append(segmentStart, boundary);
				rawIndex++;
				segmentStart = boundary;
			}
			append(segmentStart, end);
		}
	}

	private async runTokenization(request: LanguageWorkerRequest<languages.SyntaxLane, languages.SyntaxRequest>, signal: AbortSignal): Promise<LanguageTokenResult | null> {
		const proposed = request.payload.tokenize;
		if (!proposed || proposed.lineNumber > request.snapshot.lineCount) throw new RangeError("Hypothetical tokenization requires a start line in the document");
		const support = await this.getTokenizationSupport(request.payload.languageId);
		signal.throwIfAborted();
		if (support) {
			this.tokenizeDocument(support, request, signal);
			const cache = this.tokenizationCache!;
			let state = proposed.lineNumber === 1 ? cache.initialState : cache.states.getEndState(proposed.lineNumber - 1)!;
			const tokens: LanguageToken[] = [];
			for (let index = 0; index < proposed.lines.length; index++) {
				signal.throwIfAborted();
				const line = proposed.lines[index]!;
				const result = support.tokenize(line, index < proposed.lines.length - 1, state.clone());
				state = result.endState;
				for (let tokenIndex = 0; tokenIndex < result.tokens.length; tokenIndex++) {
					const token = result.tokens[tokenIndex]!;
					const end = result.tokens[tokenIndex + 1]?.offset ?? line.length;
					if (end > token.offset) tokens.push({
						range: new Range(index + 1, token.offset + 1, index + 1, end + 1),
						tokenType: token.type === '' ? 'other' : token.type,
						modifiers: [], languageId: token.language,
					});
				}
			}
			return { tokens };
		}
		// The provider that owns live tokens also decides whether preview is available.
		for (const provider of this.registry.getTokenProviders(request.payload.languageId)) {
			try {
				const realRequest = providerRequest(request, this.model);
				const realTokens = await provider.provideTokens!(realRequest, signal);
				signal.throwIfAborted();
				if (realTokens === undefined) continue;
				const value = await provider.provideTokensForLines?.({ ...realRequest, tokenize: proposed }, signal);
				signal.throwIfAborted();
				return value ?? null;
			} catch (error) {
				if (signal.aborted) throw error;
				this.reportProviderError(provider.id, languages.SYNTAX_TOKENIZE_LANE, error);
				return null;
			}
		}
		return null;
	}

	private async runDiagnostics(request: LanguageWorkerRequest<languages.SyntaxLane, languages.SyntaxRequest>, signal: AbortSignal): Promise<languages.LanguageDiagnosticResult> {
		const providers = this.registry.getDiagnosticProviders(request.payload.languageId);
		if (providers.length === 0) return EMPTY_DIAGNOSTICS;
		const normalize = languages.createLanguageDiagnosticSnapshotNormalizer(request.snapshot);
		const batches = await Promise.all(providers.map(provider => this.runDiagnosticProvider(provider, request, signal, normalize)));
		signal.throwIfAborted();
		const diagnostics: languages.LanguageDiagnostic[] = [];
		for (const batch of batches) diagnostics.push(...(batch?.diagnostics ?? []));
		return normalize({ diagnostics });
	}

	private async runDiagnosticProvider(
		provider: languages.RegisteredSyntaxProvider,
		request: LanguageWorkerRequest<languages.SyntaxLane, languages.SyntaxRequest>,
		signal: AbortSignal,
		normalize: (value: languages.LanguageDiagnosticResult) => languages.LanguageDiagnosticResult,
	): Promise<languages.LanguageDiagnosticResult | undefined> {
		try {
			const value = await provider.provideDiagnostics!(providerRequest(request, this.model), signal);
			signal.throwIfAborted();
			return value === undefined ? undefined : normalize(value);
		} catch (error) {
			if (signal.aborted) throw error;
			this.reportProviderError(provider.id, languages.SYNTAX_DIAGNOSTIC_LANE, error);
			return undefined;
		}
	}

	private reportProviderError(providerId: string, operation: languages.SyntaxProviderOperation, error: unknown): void {
		try {
			this.onProviderError(providerId, operation, error);
		} catch (reportingError) {
			reportProviderError(providerId, operation, new AggregateError([error, reportingError], "Syntax and error reporting both failed"));
		}
	}

	private ensureAlive(): void {
		if (this.disposed) {
			throw new ReferenceError("SyntaxProviderWorker is already disposed");
		}
	}
}

const EMPTY_TOKENS: LanguageTokenResult = Object.freeze({ tokens: Object.freeze([]) });

const EMPTY_DIAGNOSTICS: languages.LanguageDiagnosticResult = Object.freeze({ diagnostics: Object.freeze([]) });

function providerRequest(request: LanguageWorkerRequest<languages.SyntaxLane, languages.SyntaxRequest>, model?: TextModel): languages.SyntaxProviderRequest {
	return Object.freeze({
		requestId: request.requestId,
		snapshot: request.snapshot,
		languageId: request.payload.languageId,
		...(model ? { model } : {}),
	});
}

function reportProviderError(providerId: string, operation: languages.SyntaxProviderOperation, error: unknown): void {
	console.error(`Syntax provider '${providerId}' failed in '${operation}'`, error);
}

export const editorWorkerWireCodec: WorkerTextModelCodec<EditorWorkerLane, EditorWorkerRequest, EditorWorkerResult> = Object.freeze({
	lanes: Object.freeze([
		EDITOR_WORKER_TEXTUAL_SUGGEST_LANE,
		EDITOR_WORKER_UNICODE_HIGHLIGHTS_LANE,
		EDITOR_WORKER_MINIMAL_EDITS_LANE,
		EDITOR_WORKER_NAVIGATE_VALUE_LANE,
	] as const),
	encodePayload(lane: EditorWorkerLane, payload: EditorWorkerRequest): unknown {
		switch (lane) {
			case EDITOR_WORKER_TEXTUAL_SUGGEST_LANE:
				return languageCompletionWireCodec.encodePayload('completion', payload as languages.LanguageCompletionRequest);
			case EDITOR_WORKER_UNICODE_HIGHLIGHTS_LANE:
				return Object.freeze({});
			case EDITOR_WORKER_MINIMAL_EDITS_LANE:
				return Object.freeze({ edits: Object.freeze((payload as EditorWorkerMinimalEditsRequest).edits.map(encodeEdit)) });
			case EDITOR_WORKER_NAVIGATE_VALUE_LANE: {
				const request = payload as EditorWorkerNavigateValueRequest;
				return Object.freeze({
					range: encodeRange(request.range),
					up: request.up,
					wordDefinition: Object.freeze({ source: request.wordDefinition.source, flags: request.wordDefinition.flags }),
				});
			}
		}
	},
	decodePayload(lane: EditorWorkerLane, value: unknown, snapshot: TextSnapshot): EditorWorkerRequest {
		assertRecord(value, 'Editor worker request');
		switch (lane) {
			case EDITOR_WORKER_TEXTUAL_SUGGEST_LANE:
				return languageCompletionWireCodec.decodePayload('completion', value, snapshot);
			case EDITOR_WORKER_UNICODE_HIGHLIGHTS_LANE:
				return Object.freeze({});
			case EDITOR_WORKER_MINIMAL_EDITS_LANE:
				if (!Array.isArray(value.edits)) throw new TypeError('Editor worker minimal edits must be an array');
				return Object.freeze({ edits: Object.freeze(value.edits.map(edit => decodeEdit(edit, snapshot))) });
			case EDITOR_WORKER_NAVIGATE_VALUE_LANE: {
				if (typeof value.up !== 'boolean') throw new TypeError('Editor worker navigation direction must be boolean');
				assertRecord(value.wordDefinition, 'Editor worker word definition');
				const source = decodeString(value.wordDefinition.source, 'Editor worker word definition source');
				const flags = decodeString(value.wordDefinition.flags, 'Editor worker word definition flags');
				return Object.freeze({ range: decodeRange(value.range, snapshot), up: value.up, wordDefinition: new RegExp(source, flags) });
			}
		}
	},
	encodeResult(lane: EditorWorkerLane, result: EditorWorkerResult, snapshot: TextSnapshot): unknown {
		switch (lane) {
			case EDITOR_WORKER_TEXTUAL_SUGGEST_LANE:
				return languageCompletionWireCodec.encodeResult('completion', result as languages.LanguageCompletionResult, snapshot, undefined);
			case EDITOR_WORKER_UNICODE_HIGHLIGHTS_LANE:
				return Object.freeze((result as readonly UnicodeHighlight[]).map(highlight => Object.freeze({
					range: encodeRange(highlight.range),
					kind: highlight.kind,
					character: highlight.character,
				})));
			case EDITOR_WORKER_MINIMAL_EDITS_LANE:
				return Object.freeze((result as readonly languages.TextEdit[]).map(encodeEdit));
			case EDITOR_WORKER_NAVIGATE_VALUE_LANE: {
				const navigation = result as languages.IInplaceReplaceSupportResult | undefined;
				return navigation ? Object.freeze({ range: encodeRange(navigation.range), value: navigation.value }) : null;
			}
		}
	},
	decodeResult(lane: EditorWorkerLane, value: unknown, snapshot: TextSnapshot): EditorWorkerResult {
		switch (lane) {
			case EDITOR_WORKER_TEXTUAL_SUGGEST_LANE:
				return languageCompletionWireCodec.decodeResult('completion', value, snapshot, undefined);
			case EDITOR_WORKER_UNICODE_HIGHLIGHTS_LANE:
				if (!Array.isArray(value)) throw new TypeError('Editor worker Unicode result must be an array');
				return Object.freeze(value.map(item => decodeUnicodeHighlight(item, snapshot)));
			case EDITOR_WORKER_MINIMAL_EDITS_LANE:
				if (!Array.isArray(value)) throw new TypeError('Editor worker minimal edit result must be an array');
				return Object.freeze(value.map(edit => decodeEdit(edit, snapshot)));
			case EDITOR_WORKER_NAVIGATE_VALUE_LANE:
				if (value === null) return undefined;
				assertRecord(value, 'Editor worker navigation result');
				return Object.freeze({ range: decodeRange(value.range, snapshot), value: decodeString(value.value, 'Editor worker navigation value') });
		}
	},
});

function encodeEdit(edit: languages.TextEdit): unknown {
	return Object.freeze({ range: encodeRange(edit.range), text: edit.text, ...(edit.eol === undefined ? {} : { eol: edit.eol }) });
}

function decodeEdit(value: unknown, snapshot: TextSnapshot): languages.TextEdit {
	assertRecord(value, 'Editor worker edit');
	if (value.eol !== undefined && value.eol !== 0 && value.eol !== 1) {
		throw new TypeError('Editor worker edit EOL must be LF or CRLF');
	}
	return Object.freeze({ range: decodeRange(value.range, snapshot), text: decodeString(value.text, 'Editor worker edit text'), ...(value.eol === undefined ? {} : { eol: value.eol }) });
}

function encodeRange(range: IRange): unknown {
	return Object.freeze({
		start: Object.freeze({ lineIndex: range.startLineNumber - 1, columnIndex: range.startColumn - 1 }),
		end: Object.freeze({ lineIndex: range.endLineNumber - 1, columnIndex: range.endColumn - 1 }),
	});
}

function decodeRange(value: unknown, snapshot: TextSnapshot): Range {
	assertRecord(value, 'Editor worker range');
	const start = decodePosition(value.start, 'Editor worker range start');
	const end = decodePosition(value.end, 'Editor worker range end');
	const range = Range.fromPositions(start, end);
	const lines = snapshot.getText().split('\n');
	for (const position of [range.getStartPosition(), range.getEndPosition()]) {
		if (position.lineNumber < 1 || position.lineNumber > lines.length || position.column < 1 || position.column > lines[position.lineNumber - 1]!.length + 1) {
			throw new RangeError('Editor worker range is outside its snapshot');
		}
	}
	return range;
}

function decodePosition(value: unknown, owner: string): Position {
	assertRecord(value, owner);
	return new Position((decodebase(value.lineIndex, `${owner} line index`)) + 1, (decodebase(value.columnIndex, `${owner} column index`)) + 1);
}

function decodeUnicodeHighlight(value: unknown, snapshot: TextSnapshot): UnicodeHighlight {
	assertRecord(value, 'Editor worker Unicode highlight');
	const kind = decodeString(value.kind, 'Editor worker Unicode highlight kind');
	if (!isUnicodeHighlightKind(kind)) throw new TypeError(`Unknown Unicode highlight kind '${kind}'`);
	const character = decodeString(value.character, 'Editor worker Unicode highlight character');
	if ([...character].length !== 1) throw new TypeError('Editor worker Unicode highlight must contain one character');
	return Object.freeze({ range: decodeRange(value.range, snapshot), kind, character });
}

function isUnicodeHighlightKind(value: string): value is UnicodeHighlightKind {
	return value === 'invisible' || value === 'bidi' || value === 'confusable';
}

function decodebase(value: unknown, owner: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) throw new RangeError(`${owner} must be a non-negative safe integer`);
	return value as number;
}

function decodeString(value: unknown, owner: string): string {
	if (typeof value !== 'string') throw new TypeError(`${owner} must be a string`);
	return value;
}

function assertRecord(value: unknown, owner: string): asserts value is Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(`${owner} must be an object`);
}

export const languageCompletionWireCodec: WorkerTextModelCodec<languages.LanguageCompletionLane, languages.LanguageCompletionRequest, languages.LanguageCompletionResult> = Object.freeze({
	lanes: Object.freeze([languages.LANGUAGE_COMPLETION_LANE] as const),
	encodePayload(_lane: languages.LanguageCompletionLane, request: languages.LanguageCompletionRequest): unknown {
		return encodeCompletionRequest(request);
	},
	decodePayload(_lane: languages.LanguageCompletionLane, value: unknown, snapshot: TextSnapshot): languages.LanguageCompletionRequest {
		return decodeCompletionRequest(value, snapshot);
	},
	encodeResult(_lane: languages.LanguageCompletionLane, result: languages.LanguageCompletionResult): unknown {
		return encodeCompletionResult(result);
	},
	decodeResult(_lane: languages.LanguageCompletionLane, value: unknown, snapshot: TextSnapshot): languages.LanguageCompletionResult {
		return decodeCompletionResult(value, snapshot);
	},
});

function encodeCompletionRequest(request: languages.LanguageCompletionRequest): unknown {
	return Object.freeze({
		languageId: request.languageId,
		...(request.resource ? { resource: request.resource.toString() } : {}),
		position: encodePosition(request.position),
		context: encodeContext(request.context),
	});
}

function decodeCompletionRequest(value: unknown, snapshot: TextSnapshot): languages.LanguageCompletionRequest {
	assertRecord(value, "Completion wire request");
	if (typeof value.languageId !== "string") {
		throw new TypeError("Completion wire language ID must be a string");
	}
	const position = decodePosition(value.position, "Completion wire request position");
	assertSnapshotPosition(snapshot, position);
	return Object.freeze({
		languageId: value.languageId,
		...(typeof value.resource === "string" ? { resource: URI.parse(value.resource) } : {}),
		position,
		context: decodeContext(value.context),
	});
}

function encodeCompletionResult(result: languages.LanguageCompletionResult): unknown {
	return Object.freeze({
		position: encodePosition(result.position),
		items: Object.freeze(result.items.map(encodeItem)),
		isIncomplete: result.isIncomplete,
	});
}

function decodeCompletionResult(value: unknown, snapshot: TextSnapshot): languages.LanguageCompletionResult {
	assertRecord(value, "Completion wire result");
	if (!Array.isArray(value.items)) {
		throw new TypeError("Completion wire result must contain an items array");
	}
	if (typeof value.isIncomplete !== "boolean") {
		throw new TypeError("Completion wire isIncomplete must be a boolean");
	}
	return languages.normalizeLanguageCompletionSnapshotResult({
		position: decodePosition(value.position, "Completion wire result position"),
		items: value.items.map(decodeItem),
		isIncomplete: value.isIncomplete,
	}, snapshot);
}

function encodeItem(item: languages.LanguageCompletionItem): unknown {
	return Object.freeze({
		providerId: item.providerId,
		id: item.id,
		label: item.label,
		kind: item.kind,
		range: Object.freeze({
			start: encodePosition(item.range.getStartPosition()),
			end: encodePosition(item.range.getEndPosition()),
		}),
		insertText: item.insertText,
		...(item.insertTextFormat === undefined ? {} : { insertTextFormat: item.insertTextFormat }),
		...(item.detail === undefined ? {} : { detail: item.detail }),
		...(item.documentation === undefined ? {} : { documentation: item.documentation }),
		...(item.filterText === undefined ? {} : { filterText: item.filterText }),
		...(item.sortText === undefined ? {} : { sortText: item.sortText }),
		...(item.preselect === undefined ? {} : { preselect: item.preselect }),
		...(item.commitCharacters === undefined ? {} : { commitCharacters: item.commitCharacters }),
		...(item.additionalTextEdits === undefined ? {} : { additionalTextEdits: item.additionalTextEdits.map(edit => Object.freeze({
			range: Object.freeze({ start: encodePosition(edit.range.getStartPosition()), end: encodePosition(edit.range.getEndPosition()) }),
			text: edit.text,
		})) }),
		...(item.hasDeferredDetails === undefined ? {} : { hasDeferredDetails: item.hasDeferredDetails }),
	});
}

function decodeItem(value: unknown): languages.LanguageCompletionItem {
	assertRecord(value, "Completion wire item");
	const range = value.range;
	assertRecord(range, "Completion wire item range");
	const detail = decodeOptionalString(value.detail, "Completion wire item detail");
	const documentation = decodeOptionalString(value.documentation, "Completion wire item documentation");
	const filterText = decodeOptionalString(value.filterText, "Completion wire item filter text");
	const sortText = decodeOptionalString(value.sortText, "Completion wire item sort text");
	const commitCharacters = decodeOptionalCommitCharacters(value.commitCharacters);
	const additionalTextEdits = decodeOptionalAdditionalTextEdits(value.additionalTextEdits);
	if (value.preselect !== undefined && typeof value.preselect !== "boolean") {
		throw new TypeError("Completion wire item preselect must be a boolean");
	}
	if (value.hasDeferredDetails !== undefined && typeof value.hasDeferredDetails !== "boolean") {
		throw new TypeError("Completion wire item hasDeferredDetails must be a boolean");
	}
	return {
		providerId: decodeString(value.providerId, "Completion wire provider ID"),
		id: decodeString(value.id, "Completion wire item ID"),
		label: decodeString(value.label, "Completion wire item label"),
		kind: decodeString(value.kind, "Completion wire item kind") as languages.LanguageCompletionItem["kind"],
		range: Range.fromPositions(
			decodePosition(range.start, "Completion wire item range start"),
			decodePosition(range.end, "Completion wire item range end"),
		),
		insertText: decodeString(value.insertText, "Completion wire item insertion text"),
		...(value.insertTextFormat === undefined ? {} : { insertTextFormat: decodeString(value.insertTextFormat, "Completion wire item insert text format") as languages.LanguageCompletionItem["insertTextFormat"] }),
		...(detail === undefined ? {} : { detail }),
		...(documentation === undefined ? {} : { documentation }),
		...(filterText === undefined ? {} : { filterText }),
		...(sortText === undefined ? {} : { sortText }),
		...(value.preselect === undefined ? {} : { preselect: value.preselect }),
		...(commitCharacters === undefined ? {} : { commitCharacters }),
		...(additionalTextEdits === undefined ? {} : { additionalTextEdits }),
		...(value.hasDeferredDetails === undefined ? {} : { hasDeferredDetails: value.hasDeferredDetails }),
	};
}

function decodeOptionalCommitCharacters(value: unknown): readonly string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) throw new TypeError("Completion wire item commit characters must be an array");
	return value.map(character => decodeString(character, "Completion wire item commit character"));
}

function decodeOptionalAdditionalTextEdits(value: unknown): readonly { readonly range: Range; readonly text: string }[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) throw new TypeError("Completion wire item additional text edits must be an array");
	return value.map(edit => {
		assertRecord(edit, "Completion wire additional text edit");
		assertRecord(edit.range, "Completion wire additional text edit range");
		return {
			range: Range.fromPositions(
				decodePosition(edit.range.start, "Completion wire additional text edit range start"),
				decodePosition(edit.range.end, "Completion wire additional text edit range end"),
			),
			text: decodeString(edit.text, "Completion wire additional text edit text"),
		};
	});
}

function encodeContext(context: languages.LanguageCompletionContext): unknown {
	return context.kind === languages.LanguageCompletionTriggerKind.TriggerCharacter
		? Object.freeze({ kind: context.kind, triggerCharacter: context.triggerCharacter })
		: Object.freeze({ kind: context.kind });
}

function decodeContext(value: unknown): languages.LanguageCompletionContext {
	assertRecord(value, "Completion wire context");
	if (value.kind === languages.LanguageCompletionTriggerKind.Invoke) {
		return languages.createLanguageCompletionInvokeContext();
	}
	if (value.kind === languages.LanguageCompletionTriggerKind.IncompleteRefresh) {
		return languages.createLanguageCompletionIncompleteRefreshContext();
	}
	if (value.kind === languages.LanguageCompletionTriggerKind.TriggerCharacter) {
		return languages.createLanguageCompletionTriggerCharacterContext(
			decodeString(value.triggerCharacter, "Completion wire trigger character"),
		);
	}
	throw new TypeError(`Unknown completion wire trigger kind '${String(value.kind)}'`);
}

function encodePosition(position: Position): unknown {
	if (!(position instanceof Position)) {
		throw new TypeError("Completion wire position must be a Position");
	}
	return Object.freeze({
		lineIndex: position.lineNumber - 1,
		columnIndex: position.column - 1,
	});
}

function assertSnapshotPosition(snapshot: TextSnapshot, position: Position): void {
	const lines = snapshot.getText().split("\n");
	if (position.lineNumber < 1 || position.lineNumber > lines.length || position.column < 1 || position.column > lines[position.lineNumber - 1]!.length + 1) {
		throw new RangeError("Completion wire request position is outside its snapshot");
	}
}

function decodeOptionalString(value: unknown, owner: string): string | undefined {
	return value === undefined ? undefined : decodeString(value, owner);
}

function decodeNonNegativeSafeInteger(value: unknown, owner: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) {
		throw new RangeError(`${owner} must be a non-negative safe integer`);
	}
	return value as number;
}

export function createSyntaxWorker(registry: SyntaxProviderRegistry, options: languages.SyntaxServiceOptions, languageIdCodec?: languages.ILanguageIdCodec): languages.SyntaxWorker {
	if (options.workerFactory && options.onProviderError) {
		throw new TypeError('A custom syntax worker owns its provider error policy');
	}
	const worker = options.workerFactory ? new SyntaxProviderOverlayWorker(registry, options.workerFactory(), languageIdCodec) : new SyntaxProviderWorker(registry, options.onProviderError, languageIdCodec);
	return options.workerDecorator ? options.workerDecorator(worker) : worker;
}

/** Gives explicitly prioritized renderer providers precedence over a host Worker. */
class SyntaxProviderOverlayWorker implements languages.SyntaxWorker, LanguageWorkerModelSynchronizer, LanguageWorkerResultSettler {
	private readonly providers: SyntaxProviderWorker;

	constructor(private readonly registry: SyntaxProviderRegistry, private readonly fallback: languages.SyntaxWorker, languageIdCodec?: languages.ILanguageIdCodec) {
		this.providers = new SyntaxProviderWorker(registry, undefined, languageIdCodec);
	}

	run(request: LanguageWorkerRequest<languages.SyntaxLane, languages.SyntaxRequest>, signal: AbortSignal): Promise<languages.SyntaxResult> {
		const languageId = request.payload.languageId;
		const preferred = request.lane !== languages.SYNTAX_DIAGNOSTIC_LANE
			? languages.TokenizationRegistry.get(languageId) !== null || !languages.TokenizationRegistry.isResolved(languageId) || this.registry.getTokenProviders(languageId).some(provider => provider.tokenPriority > 0)
			: this.registry.getDiagnosticProviders(languageId).some(provider => provider.diagnosticPriority > 0);
		return preferred ? this.providers.run(request, signal) : this.fallback.run(request, signal);
	}

	synchronizeModel(change: Parameters<LanguageWorkerModelSynchronizer["synchronizeModel"]>[0]): void {
		const synchronizer = this.fallback as Partial<LanguageWorkerModelSynchronizer>;
		synchronizer.synchronizeModel?.(change);
	}

	settleResult(requestId: number, disposition: LanguageWorkerResultDisposition): void {
		const settler = this.fallback as Partial<LanguageWorkerResultSettler>;
		settler.settleResult?.(requestId, disposition);
	}

	dispose(): void {
		this.providers.dispose();
		this.fallback.dispose();
	}

	[Symbol.dispose](): void {
		this.dispose();
	}
}
