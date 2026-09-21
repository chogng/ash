import * as languages from '../languages.js';
import { Range } from '../core/range.js';
import { type LanguageToken, createLanguageTokenSnapshotNormalizer, type LanguageTokenResult } from '../tokens/languageTokens.js';
import { SyntaxProviderRegistry } from '../languageFeatureRegistry.js';
import { type LanguageWorkerRequest } from '../model/languageRequestCoordinator.js';
import { type LanguageWorkerDocumentSynchronization, type LanguageWorkerDocumentSynchronizationObserver } from './textModelSync/textModelSync.protocol.js';
import { Position } from "../core/position.js";
import { getTextWordSegments } from "../core/textSegmentation.js";
import { AbstractDisposable } from '../../../base/common/lifecycle.js';
import { normalizeTextLineEndings, type TextSnapshot } from '../core/textChange.js';
import { StringText } from '../core/text/abstractText.js';
import { TextReplacement } from '../core/edits/textEdit.js';
import { getWordAtText } from '../core/wordHelper.js';
import { BasicInplaceReplace } from '../languages/supports/inplaceReplaceSupport.js';
import { EDITOR_WORKER_TEXTUAL_SUGGEST_LANE, EDITOR_WORKER_MINIMAL_EDITS_LANE, EDITOR_WORKER_NAVIGATE_VALUE_LANE, EDITOR_WORKER_UNICODE_HIGHLIGHTS_LANE, type EditorWorkerImplementation, type EditorWorkerLane, type EditorWorkerMinimalEditsRequest, type EditorWorkerNavigateValueRequest, type EditorWorkerRequest, type EditorWorkerResult } from './editorWorkerWire.js';
import { computeUnicodeHighlights } from './unicodeTextModelHighlighter.js';

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
		readonly lines: readonly { text: string; hasEOL: boolean; state: languages.IState; result: languages.TokenizationResult }[];
	} | undefined;

	constructor(
		private readonly registry: SyntaxProviderRegistry,
		private readonly onProviderError: languages.SyntaxProviderErrorHandler = reportProviderError,
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
		let support = languages.TokenizationRegistry.get(request.payload.languageId);
		if (providers.some(provider => provider.tokenPriority > 0)) {
			support = null;
		} else if (!support && !languages.TokenizationRegistry.isResolved(request.payload.languageId)) {
			support = await languages.TokenizationRegistry.getOrCreate(request.payload.languageId);
		}
		signal.throwIfAborted();
		if (support) {
			const tokens: LanguageToken[] = [];
			const cached = this.tokenizationCache?.support === support ? this.tokenizationCache.lines : [];
			const next: { text: string; hasEOL: boolean; state: languages.IState; result: languages.TokenizationResult }[] = [];
			let state = support.getInitialState();
			const lines = request.snapshot.getText().split('\n');
			for (let index = 0; index < lines.length; index++) {
				signal.throwIfAborted();
				const line = lines[index]!;
				const hasEOL = index < lines.length - 1;
				const previous = cached[index];
				const result = previous?.text === line && previous.hasEOL === hasEOL && previous.state.equals(state)
					? previous.result
					: support.tokenize(line, hasEOL, state.clone());
				next.push({ text: line, hasEOL, state: state.clone(), result });
				state = result.endState;
				for (let tokenIndex = 0; tokenIndex < result.tokens.length; tokenIndex++) {
					const token = result.tokens[tokenIndex]!;
					const end = result.tokens[tokenIndex + 1]?.offset ?? line.length;
					if (end > token.offset && token.type) tokens.push({
						range: new Range(index + 1, token.offset + 1, index + 1, end + 1),
						tokenType: token.type,
						modifiers: [],
						languageId: token.language,
					});
				}
			}
			const normalized = createLanguageTokenSnapshotNormalizer(request.snapshot)({ tokens });
			this.tokenizationCache = { support, lines: next };
			return normalized;
		}
		if (providers.length === 0) return EMPTY_TOKENS;
		const normalize = createLanguageTokenSnapshotNormalizer(request.snapshot);
		for (const provider of providers) {
			try {
				const value = await provider.provideTokens!(providerRequest(request), signal);
				signal.throwIfAborted();
				if (value !== undefined) return normalize(value);
			} catch (error) {
				if (signal.aborted) throw error;
				this.reportProviderError(provider.id, languages.SYNTAX_TOKEN_LANE, error);
			}
		}
		return EMPTY_TOKENS;
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
			const value = await provider.provideDiagnostics!(providerRequest(request), signal);
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

function providerRequest(request: LanguageWorkerRequest<languages.SyntaxLane, languages.SyntaxRequest>): languages.SyntaxProviderRequest {
	return Object.freeze({
		requestId: request.requestId,
		snapshot: request.snapshot,
		languageId: request.payload.languageId,
	});
}

function reportProviderError(providerId: string, operation: languages.SyntaxProviderOperation, error: unknown): void {
	console.error(`Syntax provider '${providerId}' failed in '${operation}'`, error);
}
