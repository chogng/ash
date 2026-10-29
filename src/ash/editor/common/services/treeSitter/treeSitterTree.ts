import type { RelativeToken, TreeSitterTokenStyle, TreeSitterTokenizationMeasure } from './treeSitterLibraryService.js';
import { prepareInjectedTrees, disposeInjectedTrees, type InjectedTree } from './treeSitterInjections.js';
import type { Language, Node, Parser, Query, Range as SyntaxRange } from '@vscode/tree-sitter-wasm';
import { raceCancellationError, runWhenGlobalIdle } from '../../../../base/common/async.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { throwIfCancelled } from '../../../../base/common/cancellation.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { Range } from '../../core/range.js';
import { Position } from '../../core/position.js';
import type { TextModelChange } from '../../core/textChange.js';
import { BackgroundTokenizationState, SynchronousTokenizationUnavailableError } from '../../tokenizationTextModelPart.js';
import type { LanguageToken } from '../../tokens/languageTokens.js';
import type { TextModel } from '../../model/textModel.js';
import type { FoldingRules } from '../../languages/languageConfiguration.js';

export type TreeSitterTextSource = Pick<
	TextModel,
	| 'version'
	| 'length'
	| 'onDidChangeContent'
	| 'onWillDispose'
	| 'onDidChangeAttached'
	| 'isAttachedToEditor'
	| 'getLineCount'
	| 'getLineLength'
	| 'getLineMaxColumn'
	| 'getOffsetAt'
	| 'getPositionAt'
	| 'getValueInRange'
>;

export interface TreeSitterTokenizationRuntime {
	readonly Parser: typeof Parser;
	readonly languageId?: string;
	readonly language: Language;
	/** Immutable, worker-owned query. A document must not delete it. */
	readonly query: Query;
	readonly symbols?: Query;
	readonly folds?: Query;
	readonly foldingRules?: FoldingRules;
	readonly injections?: Query;
	readonly loadEmbeddedLanguage?: (name: string) => Promise<TreeSitterTokenizationRuntime | undefined>;
}

interface Capture {
	readonly start: number;
	readonly end: number;
	readonly name: string;
	readonly priority: number;
	readonly languageId?: string;
}

/**
 * Worker-owned incremental tree and demand-filled highlight cache. Parsing reads
 * the editor buffer in chunks; edits never clone or send the complete document.
 * Only queried lines have cached captures, and themes do not participate in parsing.
 */
export class TreeSitterTree extends Disposable {
	private readonly changeEmitter = this._register(new Emitter<readonly { fromLineNumber: number; toLineNumber: number }[]>());
	private readonly disposedEmitter = this._register(new Emitter<void>());
	private readonly errorEmitter = this._register(new Emitter<unknown>());
	readonly onDidChangeTokens = this.changeEmitter.event;
	readonly onDidEncounterError = this.errorEmitter.event;
	private runtime: TreeSitterTokenizationRuntime | undefined;
	private injected: InjectedTree[] = [];
	private injectionPreparation: Promise<void> = Promise.resolve();
	private parser: Parser | undefined;
	private tree: ReturnType<Parser['parse']> = null;
	private parsedVersion = -1;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private failure: unknown;
	private readonly rows = new Map<number, readonly RelativeToken[]>();
	private readonly styles = new Map<string, TreeSitterTokenStyle | undefined>();
	private visible: readonly { startLineNumber: number; endLineNumber: number }[] = [];
	private dirty: { start: number; end: number }[] = [];
	private count = 0;
	private backgroundRow = 0;
	private readonly background = this._register(new MutableDisposable());

	constructor(
		private readonly model: TreeSitterTextSource,
		runtime: Promise<TreeSitterTokenizationRuntime>,
		private readonly resolveStyle: (capture: string) => TreeSitterTokenStyle | undefined,
		private readonly measure?: (sample: TreeSitterTokenizationMeasure) => void,
	) {
		super();
		this._register(model.onDidChangeContent(change => this.acceptChanges(change)));
		this._register(model.onWillDispose(() => this.dispose()));
		this._register(model.onDidChangeAttached(() => this.scheduleBackground()));
		void runtime
			.then(value => {
				if (this.isDisposed) return;
				this.runtime = value;
				this.parser = new value.Parser();
				this.parser.setLanguage(value.language);
				// Request cooperative slicing. The WASM runtime can exceed this budget
				// during subtree reuse; this is not a preemptive main-thread time limit.
				this.parser.setTimeoutMicros(4_000);
				this.parseWithinBudget();
			})
			.catch(error => this.fail(error));
	}

	get rootNode(): Node | undefined {
		return this.tree?.rootNode;
	}
	get foldingRules(): FoldingRules | undefined {
		return this.runtime?.foldingRules;
	}
	get captureRowsCache(): ReadonlyMap<number, readonly RelativeToken[]> {
		return this.rows;
	}
	/** Every structure query uses the same completed host/embedded tree revision. */
	get structureTrees(): readonly { root: Node; symbols?: Query; folds?: Query }[] {
		return this.tree
			? [
					{ root: this.tree.rootNode, symbols: this.runtime?.symbols, folds: this.runtime?.folds },
					...this.injected.map(item => ({
						root: item.tree.rootNode,
						symbols: item.symbols,
						folds: item.folds,
					})),
				]
			: [];
	}
	get embeddedRootNodes(): readonly Node[] {
		return this.injected.map(injection => injection.tree.rootNode);
	}

	get modelVersion(): number {
		return this.parsedVersion;
	}
	get tokenCount(): number {
		return this.count;
	}
	get backgroundTokenizationState(): BackgroundTokenizationState {
		return this.parsedVersion === this.model.version && this.rows.size === this.model.getLineCount() ? BackgroundTokenizationState.Completed : BackgroundTokenizationState.InProgress;
	}
	get lines(): readonly { lineIndex: number; tokens: readonly LanguageToken[] }[] {
		return [...this.rows.keys()].sort((a, b) => a - b).map(row => ({ lineIndex: row, tokens: this.getLanguageTokens(row + 1) }));
	}

	async whenReady(signal: AbortSignal): Promise<void> {
		throwIfCancelled(signal);
		if (this.isDisposed) throw new Error('Syntax backend was disposed');
		if (this.failure) throw this.failure;
		if (this.parsedVersion !== this.model.version) {
			let cleanup = () => {};
			const ready = new Promise<void>((resolve, reject) => {
				const changed = this.onDidChangeTokens(() => {
					if (this.parsedVersion === this.model.version) resolve();
				});
				const error = this.onDidEncounterError(reject);
				const disposed = this.disposedEmitter.event(() => reject(new Error('Syntax backend was disposed')));
				cleanup = () => {
					changed.dispose();
					error.dispose();
					disposed.dispose();
				};
			});
			try {
				await raceCancellationError(ready, signal, 'Tree-sitter preparation was cancelled');
			} finally {
				cleanup();
			}
		}
		await raceCancellationError(this.injectionPreparation, signal, 'Embedded syntax preparation was cancelled');
		this.forceTokenization(1);
	}

	hasAccurateTokensForLine(lineNumber: number): boolean {
		return this.parsedVersion === this.model.version && this.rows.has(lineNumber - 1);
	}

	isCheapToTokenize(lineNumber: number): boolean {
		return this.hasAccurateTokensForLine(lineNumber);
	}

	forceTokenization(lineNumber: number): void {
		if (this.parsedVersion !== this.model.version) throw new SynchronousTokenizationUnavailableError(lineNumber);
		const changed = this.refreshRange(lineNumber, lineNumber);
		if (changed.length) this.changeEmitter.fire(changed);
	}

	setVisibleLines(ranges: readonly { startLineNumber: number; endLineNumber: number }[]): void {
		this.visible = ranges;
		const changed = ranges.flatMap(range => this.refreshRange(range.startLineNumber, range.endLineNumber));
		if (changed.length) this.changeEmitter.fire(changed);
	}

	refreshRange(startLineNumber: number, endLineNumber: number): { fromLineNumber: number; toLineNumber: number }[] {
		const changed: { fromLineNumber: number; toLineNumber: number }[] = [];
		if (!this.tree || this.parsedVersion !== this.model.version) return changed;
		const end = Math.min(this.model.getLineCount(), endLineNumber);
		let firstMissing: number | undefined;
		for (let row = Math.max(0, startLineNumber - 1); row < end; row++) {
			if (!this.rows.has(row)) firstMissing ??= row;
			if (firstMissing !== undefined && (this.rows.has(row) || row === end - 1)) {
				const lastMissing = this.rows.has(row) ? row - 1 : row;
				this.queryRows(firstMissing, lastMissing);
				changed.push({ fromLineNumber: firstMissing + 1, toLineNumber: lastMissing + 1 });
				firstMissing = undefined;
			}
		}
		return changed;
	}

	getLanguageTokens(lineNumber: number): readonly LanguageToken[] {
		return (this.rows.get(lineNumber - 1) ?? []).flatMap(token => {
			if (!this.styles.has(token.name)) this.styles.set(token.name, this.resolveStyle(token.name));
			const style = this.styles.get(token.name);
			if (!style && !token.languageId) return [];
			const { tokenType, modifiers, ...presentation } = style ?? { tokenType: 'source' };
			return [
				{
					range: new Range(lineNumber, token.start + 1, lineNumber, token.end + 1),
					tokenType,
					languageId: token.languageId,
					modifiers: modifiers ?? [],
					presentation,
				},
			];
		});
	}

	/** Restyling cached captures leaves both the parse tree and query results intact. */
	resetStyles(): void {
		this.styles.clear();
		this.changeEmitter.fire(this.visible.map(range => ({ fromLineNumber: range.startLineNumber, toLineNumber: range.endLineNumber })));
	}

	/** Hypothetical typing uses an isolated parser and never edits the authoritative tree. */
	tokenizeLinesAt(lineNumber: number, lines: readonly string[]): readonly LanguageToken[][] {
		if (!this.runtime) return lines.map(() => []);
		const start = this.model.getOffsetAt({ lineNumber, column: 1 });
		const lastLine = Math.min(this.model.getLineCount(), lineNumber + lines.length - 1);
		const oldEnd = this.model.getOffsetAt({ lineNumber: lastLine, column: this.model.getLineMaxColumn(lastLine) });
		const replacement = lines.join('\n');
		const delta = replacement.length - (oldEnd - start);
		const parser = new this.runtime.Parser();
		parser.setLanguage(this.runtime.language);
		const edited = this.tree?.copy();
		edited?.edit({
			startIndex: start,
			oldEndIndex: oldEnd,
			newEndIndex: start + replacement.length,
			startPosition: { row: lineNumber - 1, column: 0 },
			oldEndPosition: { row: lastLine - 1, column: this.model.getLineLength(lastLine) },
			newEndPosition: { row: lineNumber + lines.length - 2, column: lines.at(-1)?.length ?? 0 },
		});
		const tree = parser.parse(offset => {
			if (offset < start) return this.model.getValueInRange(Range.fromPositions(this.model.getPositionAt(offset), this.model.getPositionAt(Math.min(start, offset + 4096))));
			if (offset < start + replacement.length) return replacement.slice(offset - start, offset - start + 4096);
			const original = offset - delta;
			if (original >= this.model.length) return '';
			return this.model.getValueInRange(Range.fromPositions(this.model.getPositionAt(original), this.model.getPositionAt(original + 4096)));
		}, edited);
		try {
			if (!tree) return lines.map(() => []);
			const rows = this.captureRows(tree.rootNode, lineNumber - 1, lineNumber + lines.length - 2, row => lines[row - lineNumber + 1]!.length);
			return lines.map((_, index) =>
				(rows.get(lineNumber - 1 + index) ?? []).flatMap(token => {
					const style = this.resolveStyle(token.name);
					if (!style && !token.languageId) return [];
					const { tokenType, modifiers, ...presentation } = style ?? { tokenType: 'source' };
					return [
						{
							range: new Range(index + 1, token.start + 1, index + 1, token.end + 1),
							tokenType,
							languageId: token.languageId,
							modifiers: modifiers ?? [],
							presentation,
						},
					];
				}),
			);
		} finally {
			tree?.delete();
			edited?.delete();
			parser.delete();
		}
	}

	/** Preview embedded syntax against a temporary view of the same buffer. */
	async tokenizeLinesAtAsync(lineNumber: number, lines: readonly string[], signal: AbortSignal): Promise<readonly (readonly LanguageToken[])[]> {
		if (!this.runtime || !lines.length) return lines.map(() => []);
		const lastLine = Math.min(this.model.getLineCount(), lineNumber + lines.length - 1);
		const start = this.model.getOffsetAt({ lineNumber, column: 1 });
		const oldEnd = this.model.getOffsetAt({ lineNumber: lastLine, column: this.model.getLineMaxColumn(lastLine) });
		const replacement = lines.join('\n'),
			delta = replacement.length - (oldEnd - start);
		const lineDelta = lines.length - (lastLine - lineNumber + 1);
		const offsets = [0];
		for (let index = 0; index + 1 < lines.length; index++) offsets.push(offsets[index]! + lines[index]!.length + 1);
		const position = (offset: number) => {
			if (offset < start) return this.model.getPositionAt(offset);
			if (offset <= start + replacement.length) {
				let index = offsets.length - 1;
				while (offset - start < offsets[index]!) index--;
				return new Position(lineNumber + index, offset - start - offsets[index]! + 1);
			}
			const original = this.model.getPositionAt(offset - delta);
			return new Position(original.lineNumber + lineDelta, original.lineNumber === lastLine ? original.column - this.model.getLineLength(lastLine) + lines.at(-1)!.length : original.column);
		};
		const source: TreeSitterTextSource = {
			version: this.model.version,
			length: this.model.length + delta,
			onDidChangeContent: Event.None,
			onWillDispose: Event.None,
			onDidChangeAttached: Event.None,
			isAttachedToEditor: () => false,
			getLineCount: () => this.model.getLineCount() + lineDelta,
			getLineLength: row => (row >= lineNumber && row < lineNumber + lines.length ? lines[row - lineNumber]!.length : this.model.getLineLength(row < lineNumber ? row : row - lineDelta)),
			getLineMaxColumn: row => source.getLineLength(row) + 1,
			getOffsetAt: point =>
				point.lineNumber < lineNumber
					? this.model.getOffsetAt(point)
					: point.lineNumber < lineNumber + lines.length
						? start + offsets[point.lineNumber - lineNumber]! + point.column - 1
						: this.model.getOffsetAt({ lineNumber: point.lineNumber - lineDelta, column: point.column }) + delta,
			getPositionAt: offset => position(Math.min(source.length, Math.max(0, offset))),
			getValueInRange: range => {
				const from = source.getOffsetAt(Range.lift(range).getStartPosition()),
					to = source.getOffsetAt(Range.lift(range).getEndPosition());
				let value = '';
				if (from < start) value += this.model.getValueInRange(Range.fromPositions(this.model.getPositionAt(from), this.model.getPositionAt(Math.min(to, start))));
				if (to > start && from < start + replacement.length) value += replacement.slice(Math.max(0, from - start), to - start);
				if (to > start + replacement.length)
					value += this.model.getValueInRange(Range.fromPositions(this.model.getPositionAt(Math.max(from, start + replacement.length) - delta), this.model.getPositionAt(to - delta)));
				return value;
			},
		};
		const preview = new TreeSitterTree(source, Promise.resolve(this.runtime), this.resolveStyle);
		try {
			await preview.whenReady(signal);
			preview.refreshRange(lineNumber, lineNumber + lines.length - 1);
			return lines.map((_, index) =>
				preview.getLanguageTokens(lineNumber + index).map(token => ({
					...token,
					range: new Range(index + 1, token.range.startColumn, index + 1, token.range.endColumn),
				})),
			);
		} finally {
			preview.dispose();
		}
	}

	private acceptChanges(change: TextModelChange): void {
		this.parser?.reset();
		if (change.isEolChange) {
			this.tree?.delete();
			this.tree = null;
			this.rows.clear();
			this.count = 0;
		} else {
			for (const edit of [...change.changes].sort((a, b) => b.rangeOffset - a.rangeOffset)) {
				const start = edit.range.startLineNumber - 1;
				const end = edit.range.endLineNumber - 1;
				const added = edit.text.split('\n');
				const delta = added.length - 1 - (end - start);
				const scope = this.tree ? enclosingScope(this.tree.rootNode, start, edit.range.startColumn - 1) : { start, end };
				this.invalidate(scope.start, Math.max(end, scope.end));
				// Only multi-line edits shift cached row keys. Relative columns elsewhere are reusable.
				if (delta !== 0) {
					const shifted = [...this.rows].filter(([row]) => row > end);
					for (const [row] of shifted) this.rows.delete(row);
					for (const [row, tokens] of shifted) this.rows.set(row + delta, tokens);
				}
				this.dirty.push({ start, end: start + added.length - 1 });
				this.tree?.edit({
					startIndex: edit.rangeOffset,
					oldEndIndex: edit.rangeOffset + edit.rangeLength,
					newEndIndex: edit.rangeOffset + edit.text.length,
					startPosition: { row: start, column: edit.range.startColumn - 1 },
					oldEndPosition: { row: end, column: edit.range.endColumn - 1 },
					newEndPosition: {
						row: start + added.length - 1,
						column: added.length === 1 ? edit.range.startColumn - 1 + edit.text.length : added.at(-1)!.length,
					},
				});
			}
		}
		this.parsedVersion = -1;
		// Let queued edit notifications reach the mirror before resuming parsing.
		this.scheduleParse();
	}

	private invalidate(start: number, end: number): void {
		this.backgroundRow = Math.min(this.backgroundRow, start);
		for (let row = start; row <= end; row++) {
			this.count -= this.rows.get(row)?.length ?? 0;
			this.rows.delete(row);
		}
	}

	private scheduleParse(): void {
		if (this.timer !== undefined || !this.parser || this.isDisposed) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			try {
				this.parse();
			} catch (error) {
				this.fail(error);
			}
		}, 0);
	}

	/** Start parsing after grammar initialization; suspended work resumes on a timer. */
	private parseWithinBudget(): void {
		if (!this.parser || this.isDisposed) return;
		if (this.timer !== undefined) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		try {
			this.parse();
		} catch (error) {
			this.fail(error);
		}
	}

	private parse(): void {
		if (!this.parser || this.isDisposed) return;
		const started = performance.now();
		const incremental = !!this.tree;
		const next = this.parser.parse(offset => {
			// The mirror supplies buffer-owned length and chunks without joining
			// the complete source inside parser callbacks.
			if (offset >= this.model.length) return '';
			return this.model.getValueInRange(Range.fromPositions(this.model.getPositionAt(offset), this.model.getPositionAt(offset + 4096)));
		}, this.tree);
		this.measure?.({
			operation: 'parse',
			duration: performance.now() - started,
			incremental,
			completed: !!next,
			lines: this.model.getLineCount(),
		});
		if (!next) {
			this.scheduleParse();
			return;
		}
		const changed = this.tree?.getChangedRanges(next) ?? [];
		for (const range of changed) this.dirty.push({ start: range.startPosition.row, end: range.endPosition.row });
		this.tree?.delete();
		this.tree = next;
		for (const range of this.dirty) {
			const start = enclosingScope(next.rootNode, range.start, 0);
			const end = enclosingScope(next.rootNode, range.end, 0);
			this.invalidate(Math.min(start.start, range.start), Math.max(end.end, range.end));
		}
		this.dirty = [];
		this.parsedVersion = this.model.version;
		disposeInjectedTrees(this.injected);
		this.injected = [];
		if (this.runtime?.injections) {
			const revision = this.model.version;
			const snapshot = next.copy();
			const pending: InjectedTree[] = [];
			this.injectionPreparation = prepareInjectedTrees(snapshot.rootNode, this.runtime, this.model, () => !this.isDisposed && this.model.version === revision, pending)
				.then(() => {
					if (this.isDisposed || this.model.version !== revision) {
						disposeInjectedTrees(pending);
						return;
					}
					this.injected = pending;
					this.rows.clear();
					this.count = 0;
				})
				.catch(error => {
					disposeInjectedTrees(pending);
					throw error;
				})
				.finally(() => snapshot.delete());
			void this.injectionPreparation.catch(error => this.fail(error));
		}

		const visible = this.visible.length ? this.visible : [{ startLineNumber: 1, endLineNumber: 1 }];
		// Retained rows keep their paint data as well as their captures. A version
		// completion with no visible changes still wakes asynchronous readers.
		const changedLines = visible.flatMap(range => this.refreshRange(range.startLineNumber, range.endLineNumber));
		this.changeEmitter.fire(changedLines);
		this.scheduleBackground();
	}

	/** Fill offscreen rows in idle slices so minimap and later scrolls retain syntax coverage. */
	private scheduleBackground(): void {
		if (this.background.value || this.isDisposed || !this.model.isAttachedToEditor() || this.parsedVersion !== this.model.version) return;
		if (this.backgroundRow >= this.model.getLineCount()) return;
		this.background.value = runWhenGlobalIdle(() => {
			this.background.clear();
			if (this.parsedVersion !== this.model.version || !this.model.isAttachedToEditor()) return;
			const started = performance.now();
			let first: number | undefined;
			let last = 0;
			while (this.backgroundRow < this.model.getLineCount()) {
				if (this.rows.has(this.backgroundRow)) {
					this.backgroundRow++;
					continue;
				}
				const start = this.backgroundRow;
				while (this.backgroundRow < Math.min(start + 32, this.model.getLineCount()) && !this.rows.has(this.backgroundRow)) this.backgroundRow++;
				this.queryRows(start, this.backgroundRow - 1);
				first ??= start;
				last = this.backgroundRow;
				if (performance.now() - started >= 1) break;
			}
			if (first !== undefined) this.changeEmitter.fire([{ fromLineNumber: first + 1, toLineNumber: last }]);
			this.scheduleBackground();
		}, 100);
	}

	private queryRows(start: number, end: number): void {
		const started = performance.now();
		const rows = this.captureRows(this.tree!.rootNode, start, end, row => this.model.getLineLength(row + 1));
		for (let row = start; row <= end; row++) {
			const tokens = rows.get(row) ?? [];
			this.count += tokens.length - (this.rows.get(row)?.length ?? 0);
			this.rows.set(row, tokens);
		}
		this.measure?.({
			operation: 'query',
			duration: performance.now() - started,
			incremental: true,
			completed: true,
			lines: end - start + 1,
		});
	}

	private captureRows(root: Node, start: number, end: number, lineLength: (row: number) => number): Map<number, readonly RelativeToken[]> {
		const options = { startPosition: { row: start, column: 0 }, endPosition: { row: end + 1, column: 0 } };
		const captures = [
			...this.runtime!.query.captures(root, options).map(capture => ({
				...capture,
				depth: 0,
				languageId: undefined as string | undefined,
				ranges: undefined as readonly SyntaxRange[] | undefined,
			})),
			...(root.id === this.tree?.rootNode.id ? this.injected : []).flatMap(injection =>
				injection.query.captures(injection.tree.rootNode, options).map(capture => ({
					...capture,
					depth: injection.depth,
					languageId: injection.languageId,
					ranges: injection.ranges,
				})),
			),
		];
		const rows = new Map<number, Capture[]>();
		for (const capture of captures) {
			if (capture.name.startsWith('_') || capture.name === 'spell' || capture.name === 'nospell') continue;
			const node = capture.node;
			for (let row = Math.max(start, node.startPosition.row); row <= Math.min(end, node.endPosition.row); row++) {
				const from = row === node.startPosition.row ? node.startPosition.column : 0;
				const to = row === node.endPosition.row ? node.endPosition.column : lineLength(row);
				if (from >= to) continue;
				let line = rows.get(row);
				if (!line) rows.set(row, (line = []));
				// Node spans may cross excluded host bytes between included ranges.
				const segments = capture.ranges
					? capture.ranges
							.filter(range => range.startPosition.row <= row && range.endPosition.row >= row)
							.map(range => ({
								from: Math.max(from, range.startPosition.row === row ? range.startPosition.column : 0),
								to: Math.min(to, range.endPosition.row === row ? range.endPosition.column : lineLength(row)),
							}))
					: [{ from, to }];
				for (const segment of segments)
					if (segment.from < segment.to)
						line.push({
							start: segment.from,
							end: segment.to,
							name: capture.name,
							languageId: capture.languageId,
							priority: capture.depth * 100000 + capture.patternIndex,
						});
			}
		}
		// Coverage carries language identity even for whitespace and unstyled identifiers.
		if (root.id === this.tree?.rootNode.id)
			for (const injection of this.injected)
				for (const range of injection.ranges) {
					for (let row = Math.max(start, range.startPosition.row); row <= Math.min(end, range.endPosition.row); row++) {
						const from = row === range.startPosition.row ? range.startPosition.column : 0;
						const to = row === range.endPosition.row ? range.endPosition.column : lineLength(row);
						if (from >= to) continue;
						let line = rows.get(row);
						if (!line) rows.set(row, (line = []));
						line.push({
							start: from,
							end: to,
							name: '',
							languageId: injection.languageId,
							priority: injection.depth * 100000 - 1,
						});
					}
				}
		return new Map([...rows].map(([row, line]) => [row, flattenCaptures(line)]));
	}

	private fail(error: unknown): void {
		if (this.isDisposed) return;
		this.failure = error;
		this.errorEmitter.fire(error);
	}

	override dispose(): void {
		if (this.isDisposed) return;
		this.disposedEmitter.fire();
		if (this.timer !== undefined) clearTimeout(this.timer);
		disposeInjectedTrees(this.injected);
		this.injected = [];
		this.tree?.delete();
		this.parser?.delete();
		this.rows.clear();
		super.dispose();
	}
}

/** Root-child invalidation preserves query contexts, including text-only predicate changes. */
function enclosingScope(root: Node, row: number, column: number): { start: number; end: number } {
	let node = root.namedDescendantForPosition({ row, column });
	if (!node || node.id === root.id) return { start: row, end: row };
	while (node.parent && node.parent.id !== root.id) node = node.parent;
	return { start: node.startPosition.row, end: node.endPosition.row };
}

function flattenCaptures(captures: readonly Capture[]): readonly RelativeToken[] {
	const events = captures
		.flatMap((capture, order) => {
			const value = { ...capture, order };
			return [
				{ offset: capture.start, entering: true, value },
				{ offset: capture.end, entering: false, value },
			];
		})
		.sort((a, b) => a.offset - b.offset);
	const active = new Set<(typeof events)[number]['value']>();
	const tokens: RelativeToken[] = [];
	for (let index = 0; index < events.length;) {
		const start = events[index]!.offset;
		while (index < events.length && events[index]!.offset === start) {
			const event = events[index++]!;
			if (event.entering) active.add(event.value);
			else active.delete(event.value);
		}
		const end = events[index]?.offset;
		if (end === undefined) break;
		let winner: (typeof events)[number]['value'] | undefined;
		let language: (typeof events)[number]['value'] | undefined;
		for (const capture of active) {
			if (capture.languageId && (!language || capture.priority > language.priority)) language = capture;
			if (capture.name && (!winner || capture.priority > winner.priority || (capture.priority === winner.priority && capture.order > winner.order))) winner = capture;
		}
		if (!winner && !language) continue;
		const name = winner?.name ?? 'none',
			languageId = language?.languageId;
		const previous = tokens.at(-1);
		if (previous && previous.end === start && previous.name === name && previous.languageId === languageId) tokens[tokens.length - 1] = { ...previous, end };
		else tokens.push({ start, end, name, languageId });
	}
	return tokens;
}
