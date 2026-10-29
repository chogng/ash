import type {
	TreeSitterSyntaxSession,
	TreeSitterBracket,
	TreeSitterFacts,
	TreeSitterSyntaxResult,
	RelativeToken,
	TreeSitterTokenStyle,
	TreeSitterTokenizationMeasure,
} from '../../../services/treeSitter/treeSitterLibraryService.js';
import { raceCancellationError } from '../../../../../base/common/async.js';
import { Emitter } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Range } from '../../../core/range.js';
import {
	BackgroundTokenizationState,
	SynchronousTokenizationUnavailableError,
} from '../../../tokenizationTextModelPart.js';
import type { LanguageToken } from '../../../tokens/languageTokens.js';
import type { TextModel } from '../../textModel.js';

/** Renderer cache only. Parsing, queries and structural facts run in the shared background session. */
export class TreeSitterSyntaxTokenBackend extends Disposable {
	private readonly changeEmitter = this._register(
		new Emitter<readonly { fromLineNumber: number; toLineNumber: number }[]>(),
	);
	private readonly errorEmitter = this._register(new Emitter<unknown>());
	readonly onDidChangeTokens = this.changeEmitter.event;
	readonly onDidEncounterError = this.errorEmitter.event;
	private readonly rows = new Map<number, readonly RelativeToken[]>();
	private readonly accurate = new Set<number>();
	private readonly styles = new Map<string, TreeSitterTokenStyle | undefined>();
	private visible: readonly { startLineNumber: number; endLineNumber: number }[] = [
		{ startLineNumber: 1, endLineNumber: 1 },
	];
	private pending: Promise<void> = Promise.resolve();
	private controller: AbortController | undefined;
	private factsQuery: AbortController | undefined;
	private factsRequest:
		{ version: number; controller: AbortController; promise: Promise<TreeSitterFacts> } | undefined;
	private parsedVersion = -1;
	private brackets: readonly TreeSitterBracket[] = [];
	private count = 0;
	private failure: unknown;
	private queued = false;
	private requestedVersion = -1;
	private requestedRanges: readonly { startLineNumber: number; endLineNumber: number }[] = [];
	constructor(
		private readonly model: TextModel,
		private readonly session: TreeSitterSyntaxSession,
		private readonly resolveStyle: (capture: string, language: string) => TreeSitterTokenStyle | undefined,
		private readonly measure?: (sample: TreeSitterTokenizationMeasure) => void,
	) {
		super();
		this._register(session);
		this.session.setTabSize(model.getOptions().tabSize);
		this._register(
			model.onDidChangeOptions(() => {
				this.session.setTabSize(model.getOptions().tabSize);
				this.factsRequest?.controller.abort();
				this.factsRequest = undefined;
				this.requestedVersion = -1;
				this.queueRefresh();
			}),
		);
		this._register(model.onWillDispose(() => this.dispose()));
		this._register(
			model.onDidChangeContent(change => {
				this.controller?.abort();
				this.factsRequest?.controller.abort();
				this.factsRequest = undefined;
				this.session.update(change);
				this.accurate.clear();
				// Old paint data remains available while current-version syntax is prepared.
				// Shift it for line insertions, but never certify it as current syntax.
				for (const edit of [...change.changes].sort((a, b) => b.rangeOffset - a.rangeOffset)) {
					const first = edit.range.startLineNumber - 1,
						last = edit.range.endLineNumber - 1;
					const delta = edit.text.split('\n').length - 1 - (last - first);
					if (delta !== 0) {
						const rows = [...this.rows];
						this.rows.clear();
						for (const [row, tokens] of rows) {
							if (row < first || row > last) this.rows.set(row > last ? row + delta : row, tokens);
							else this.count -= tokens.length;
						}
					}
				}
				this.queueRefresh();
			}),
		);
		this.queueRefresh();
	}
	get execution(): 'rust' | 'worker' {
		return this.session.execution ?? 'worker';
	}
	get modelVersion(): number {
		return this.parsedVersion;
	}
	get tokenCount(): number {
		return this.count;
	}
	get backgroundTokenizationState(): BackgroundTokenizationState {
		return this.parsedVersion === this.model.version &&
			this.visible.every(range => {
				for (let line = range.startLineNumber; line <= range.endLineNumber; line++)
					if (!this.accurate.has(line - 1)) return false;
				return true;
			})
			? BackgroundTokenizationState.Completed
			: BackgroundTokenizationState.InProgress;
	}
	get lines(): readonly { lineIndex: number; tokens: readonly LanguageToken[] }[] {
		return [...this.rows.keys()]
			.sort((a, b) => a - b)
			.map(row => ({ lineIndex: row, tokens: this.getLanguageTokens(row + 1) }));
	}
	async whenReady(signal: AbortSignal): Promise<void> {
		do {
			signal.throwIfAborted();
			if (this.isDisposed) throw new Error('Syntax backend was disposed');
			if (this.failure) throw this.failure;
			await Promise.resolve();
			await raceCancellationError(this.pending, signal, 'Syntax preparation cancelled');
		} while (this.parsedVersion !== this.model.version);
	}
	hasAccurateTokensForLine(line: number): boolean {
		return this.parsedVersion === this.model.version && this.accurate.has(line - 1);
	}
	isCheapToTokenize(line: number): boolean {
		return this.hasAccurateTokensForLine(line);
	}
	forceTokenization(line: number): void {
		if (!this.hasAccurateTokensForLine(line)) {
			this.refreshRange(line, line);
			throw new SynchronousTokenizationUnavailableError(line);
		}
	}
	setVisibleLines(ranges: readonly { startLineNumber: number; endLineNumber: number }[]): void {
		this.visible = ranges.length ? ranges : [{ startLineNumber: 1, endLineNumber: 1 }];
		if (
			this.visible.some(range => {
				for (let line = range.startLineNumber; line <= range.endLineNumber; line++)
					if (!this.hasAccurateTokensForLine(line)) return true;
				return false;
			})
		)
			this.queueRefresh();
	}
	refreshRange(startLineNumber: number, endLineNumber: number): void {
		if (!this.hasAccurateTokensForLine(startLineNumber) || !this.hasAccurateTokensForLine(endLineNumber)) {
			if (
				!this.visible.some(
					range => range.startLineNumber <= startLineNumber && range.endLineNumber >= endLineNumber,
				)
			)
				this.visible = [...this.visible, { startLineNumber, endLineNumber }];
			this.queueRefresh();
		}
	}
	/** Returns accurate parser captures for token inspection without another parse or text copy. */
	getTokenCaptures(line: number): readonly RelativeToken[] {
		return this.hasAccurateTokensForLine(line) ? (this.rows.get(line - 1) ?? []) : [];
	}
	getLanguageTokens(line: number): readonly LanguageToken[] {
		const length = this.model.getLineLength(line);
		return (this.rows.get(line - 1) ?? []).flatMap(token => {
			const language = token.languageId ?? this.model.getLanguageId();
			const key = JSON.stringify([token.name, language]);
			if (!this.styles.has(key)) this.styles.set(key, this.resolveStyle(token.name, language));
			const style = this.styles.get(key);
			if ((!style && !token.languageId) || token.start >= length) return [];
			const { tokenType, modifiers, ...presentation } = style ?? { tokenType: 'source' };
			return [
				{
					range: new Range(line, token.start + 1, line, Math.min(length, token.end) + 1),
					tokenType,
					languageId: token.languageId,
					modifiers: modifiers ?? [],
					presentation,
				},
			];
		});
	}
	resetStyles(): void {
		this.styles.clear();
		this.changeEmitter.fire(
			this.visible.map(range => ({ fromLineNumber: range.startLineNumber, toLineNumber: range.endLineNumber })),
		);
	}
	tokenizeLinesAt(line: number, _lines: readonly string[]): readonly LanguageToken[][] {
		throw new SynchronousTokenizationUnavailableError(line);
	}
	async tokenizeLinesAtAsync(
		line: number,
		lines: readonly string[],
		signal: AbortSignal,
	): Promise<readonly (readonly LanguageToken[])[]> {
		const result = await this.session.request('preview', { line, lines }, signal);
		if (result.revision !== this.model.version) throw new Error('Obsolete hypothetical syntax');
		return (result.preview ?? []).map(tokens =>
			tokens.flatMap(token => {
				const style = this.resolveStyle(token.tokenType, token.languageId ?? this.model.getLanguageId());
				return style
					? [{ ...token, range: Range.lift(token.range), tokenType: style.tokenType, presentation: style }]
					: [];
			}),
		);
	}
	getBracketPairs(range: Range): readonly TreeSitterBracket[] {
		this.refreshRange(range.startLineNumber, range.endLineNumber);
		if (this.parsedVersion !== this.model.version) return [];
		return this.brackets.filter(pair => Range.areIntersectingOrTouching(pair.range, range));
	}

	async getFacts(signal: AbortSignal): Promise<TreeSitterFacts> {
		this.assertNotDisposed();
		// Content listeners can ask for folds before the renderer's queued paint
		// request runs. Put visible syntax on the wire before bulk structure work.
		this.queueRefresh(true);
		if (this.factsRequest?.version !== this.model.version) {
			const controller = new AbortController(),
				version = this.model.version;
			const promise = this.requestFacts(controller.signal).then(result => {
				for (const sample of result.measures) this.measure?.(sample);
				if (result.revision !== this.model.version || !result.facts) throw new Error('Obsolete syntax facts');
				return result.facts;
			});
			void promise.catch(() => undefined);
			this.factsRequest = { version, controller, promise };
		}
		return raceCancellationError(this.factsRequest.promise, signal, 'Syntax facts cancelled');
	}
	private async requestFacts(signal: AbortSignal): Promise<TreeSitterSyntaxResult> {
		while (true) {
			signal.throwIfAborted();
			const query = (this.factsQuery = new AbortController());
			const abort = (): void => query.abort();
			signal.addEventListener('abort', abort, { once: true });
			try {
				const result = await this.session.request('facts', {}, query.signal);
				query.signal.throwIfAborted();
				return result;
			} catch (error) {
				// A new viewport preempts lower-priority structure work. Keep the
				// callers' shared promise and retry after its highlight was submitted.
				if (!query.signal.aborted || signal.aborted) throw error;
			} finally {
				signal.removeEventListener('abort', abort);
				if (this.factsQuery === query) this.factsQuery = undefined;
			}
		}
	}
	async getSelectionRanges(ranges: readonly Range[], signal: AbortSignal): Promise<readonly Range[]> {
		const result = await this.session.request('selection', { ranges }, signal);
		if (result.revision !== this.model.version) return [];
		return (result.selections ?? []).map(range => Range.lift(range));
	}
	private coversCurrentViewport(): boolean {
		return (
			!!this.controller &&
			!this.controller.signal.aborted &&
			this.requestedVersion === this.model.version &&
			this.visible.every(range =>
				this.requestedRanges.some(
					requested =>
						requested.startLineNumber <= range.startLineNumber &&
						requested.endLineNumber >= range.endLineNumber,
				),
			)
		);
	}
	private queueRefresh(immediate = false): void {
		if (this.isDisposed || this.coversCurrentViewport()) return;
		if (immediate) {
			this.refresh();
			return;
		}
		if (this.queued) return;
		this.queued = true;
		queueMicrotask(() => {
			this.queued = false;
			if (!this.isDisposed && !this.coversCurrentViewport()) this.refresh();
		});
	}
	private refresh(): void {
		this.controller?.abort();
		// Rust observes cancellation during its traversal. A worker can only
		// receive cancellation after its synchronous query has already finished.
		if (this.session.execution === 'rust') this.factsQuery?.abort();
		const controller = (this.controller = new AbortController());
		const ranges = this.visible.map(range => ({
			startLineNumber: Math.max(1, Math.min(this.model.getLineCount(), range.startLineNumber)),
			endLineNumber: Math.max(1, Math.min(this.model.getLineCount(), range.endLineNumber)),
		}));
		this.requestedVersion = this.model.version;
		this.requestedRanges = ranges;
		this.pending = this.session.request('highlight', { ranges }, controller.signal).then(
			result => {
				if (controller.signal.aborted || this.isDisposed || result.revision !== this.model.version) return;
				for (const row of result.rows ?? []) {
					this.count += row.tokens.length - (this.rows.get(row.row)?.length ?? 0);
					this.rows.set(row.row, row.tokens);
					this.accurate.add(row.row);
				}
				this.parsedVersion = result.revision;
				this.brackets = result.brackets ?? [];
				for (const sample of result.measures) this.measure?.(sample);
				this.changeEmitter.fire(
					ranges.map(range => ({ fromLineNumber: range.startLineNumber, toLineNumber: range.endLineNumber })),
				);
			},
			error => {
				if (!controller.signal.aborted && !this.isDisposed) {
					this.failure = error;
					this.errorEmitter.fire(error);
				}
			},
		);
	}

	override dispose(): void {
		if (this.isDisposed) return;
		this.controller?.abort();
		this.factsRequest?.controller.abort();
		this.rows.clear();
		super.dispose();
	}
}
