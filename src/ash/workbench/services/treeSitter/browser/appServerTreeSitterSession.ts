import type {
	TreeSitterSyntaxSession,
	TreeSitterFacts,
	TreeSitterSyntaxResult,
	TreeSitterTokenizationMeasure,
} from '../../../../editor/common/services/treeSitter/treeSitterLibraryService.js';
import { syntaxLanguageForEditorLanguage } from '../../../../platform/syntax/common/syntaxApi.js';
import { raceCancellationError } from '../../../../base/common/async.js';
import { Range, type IRange } from '../../../../editor/common/core/range.js';
import type { TextModel } from '../../../../editor/common/model/textModel.js';
import type { ISyntaxApi, SyntaxQueryResult, SyntaxRange, SyntaxFactsDelta, SyntaxFactsSplice, SyntaxPosition } from '../../../../platform/syntax/common/syntaxApi.js';

/** The editor owns text; this handle owns only one connection-scoped Rust analysis document. */
export function createAppServerTreeSitterSession(api: ISyntaxApi, model: TextModel, documentId: string): TreeSitterSyntaxSession {
	const generation = api.generation;
	let tabSize = model.getOptions().tabSize;
	let length = model.getValueLength();
	let disposed = false;
	let ready = false;
	let failure: unknown;
	let facts: { revision: number; tabSize: number; value: TreeSitterFacts; } | undefined;
	const opened = api.open({
		documentId,
		revision: model.version,
		language: syntaxLanguageForEditorLanguage(model.getLanguageId())!,
		text: model.getValue(),
	}, 'shared').then(() => { ready = true; });
	// Once open, post updates and queries immediately in call order. The backend's
	// document resource serializes execution; waiting for each acknowledgement here
	// would put a second scheduling barrier behind synchronous input listeners.
	void opened.catch(error => { failure = error; });
	function send<T>(action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		const invoke = (): Promise<T> => {
			signal?.throwIfAborted();
			if (disposed || api.generation !== generation) {
				throw new Error('Syntax session is unavailable');
			}
			if (failure) {
				throw failure;
			}
			return action();
		};
		try { return ready ? invoke() : opened.then(invoke); }
		catch (error) { return Promise.reject(error); }
	}
	return {
		execution: 'rust',
		[Symbol.dispose]() { this.dispose(); },
		setTabSize: value => { tabSize = value; },
		update: change => {
			if (disposed) return;
			const edits = change.isEolChange
				? [{ startOffset: 0, endOffset: length, text: model.getValue() }]
				: change.changes.map(edit => ({
					startOffset: edit.rangeOffset,
					endOffset: edit.rangeOffset + edit.rangeLength,
					text: edit.text,
				}));
			length = model.getValueLength();
			void send(() => api.update({ documentId, previousRevision: change.version - 1, revision: change.version, edits }))
				.catch(error => { failure = error; });
		},
		request: async (operation, data, signal): Promise<TreeSitterSyntaxResult> => {
			const revision = model.version;
			signal.throwIfAborted();
			if (operation === 'selection') {
				const { ranges } = data as { ranges: readonly IRange[]; };
				const result = await raceCancellationError(send(() => api.selectionRanges({ documentId, revision, ranges: ranges.map(toSyntaxRange) }), signal), signal, 'Syntax selection cancelled');
				return { revision: result.revision, selections: result.ranges.map(value => fromSyntaxRange(value.range)), measures: [] };
			}
			const values = data as { ranges?: readonly { startLineNumber: number; endLineNumber: number; }[]; line?: number; lines?: readonly string[]; };
			const base = facts, requestedTabSize = tabSize;
			const result = await raceCancellationError(send(() => api.query({
				documentId, revision, kind: operation, tabSize: requestedTabSize, factsRevision: base?.revision, factsTabSize: base?.tabSize,
				ranges: values.ranges?.map(range => ({ startLineIndex: range.startLineNumber - 1, endLineIndex: range.endLineNumber })) ?? [],
				lineIndex: values.line === undefined ? undefined : values.line - 1,
				lines: values.lines ?? [],
			}, signal), signal), signal, 'Syntax query cancelled');
			signal.throwIfAborted();
			if (disposed || api.generation !== generation) {
				throw new Error('Syntax session is unavailable');
			}
			const converted = editorResult(result, operation, model.getLineCount());
			if (result.facts) {
				const value = applyFactsDelta(result.facts, base);
				// Concurrent requests can finish after a newer result. Each applies
				// against its captured base, and only the newest advances the cache.
				if (!facts || facts.revision <= result.revision) {
					facts = { revision: result.revision, tabSize: requestedTabSize, value };
				}
				return { ...converted, facts: value };
			}
			return converted;
		},
		dispose: () => {
			if (disposed) return;
			disposed = true;
			facts = undefined;
			void opened.then(() => { if (api.generation === generation) return api.close({ documentId }); }).catch(() => undefined);
		},
	};
}

function editorResult(result: SyntaxQueryResult, operation: 'highlight' | 'facts' | 'preview', lineCount: number): TreeSitterSyntaxResult {
	const timing = { incremental: result.incremental, completed: true, lines: lineCount };
	const measures: TreeSitterTokenizationMeasure[] = [{
		...timing, operation: operation === 'facts' ? 'facts' : 'query', duration: result.queryMs,
	}];
	if (result.parseMs > 0) measures.unshift({ ...timing, operation: 'parse', duration: result.parseMs });
	const common = { revision: result.revision, measures };
	if (operation === 'preview') {
		return {
			...common, preview: result.rows.map(row => row.tokens.map(token => ({
				range: new Range(row.row + 1, token.start + 1, row.row + 1, token.end + 1),
				tokenType: token.name, languageId: token.languageId ?? undefined, modifiers: [],
			})))
		};
	}
	if (operation === 'highlight') {
		return {
			...common, rows: result.rows.map(row => ({ ...row, tokens: row.tokens.map(token => ({ ...token, languageId: token.languageId ?? undefined })) })), brackets: result.brackets.map(pair => ({
				...pair,
				range: fromSyntaxRange(pair.range), opening: fromSyntaxRange(pair.opening),
				closing: pair.closing ? fromSyntaxRange(pair.closing) : undefined,
				closeText: pair.closeText ?? undefined,
			}))
		};
	}
	return common;
}

function fromSyntaxRange(range: SyntaxRange): Range {
	return new Range(range.start.lineIndex + 1, range.start.columnIndex + 1, range.end.lineIndex + 1, range.end.columnIndex + 1);
}
function toSyntaxRange(range: IRange): SyntaxRange {
	return { start: { lineIndex: range.startLineNumber - 1, columnIndex: range.startColumn - 1 }, end: { lineIndex: range.endLineNumber - 1, columnIndex: range.endColumn - 1 } };
}

function applyFactsDelta(delta: SyntaxFactsDelta, base: { revision: number; value: TreeSitterFacts; } | undefined): TreeSitterFacts {
	if (delta.baseRevision !== null && delta.baseRevision !== base?.revision) {
		throw new Error('Syntax facts base revision mismatch');
	}
	const previous = delta.baseRevision === null ? undefined : base!.value;
	let symbols = previous?.symbols ?? [], folds = previous?.folds ?? [], diagnostics = previous?.diagnostics ?? [];
	for (const edit of delta.edits) {
		const shift = (range: IRange): IRange => {
			// Most nodes are on unrelated lines. Preserve their objects, especially
			// during a name edit that moves no following rows.
			if (range.endLineNumber - 1 < edit.range.start.lineIndex
				|| edit.range.end.lineIndex === edit.end.lineIndex && range.startLineNumber - 1 > edit.range.end.lineIndex) {
				return range;
			}
			const start = shiftPosition({ lineIndex: range.startLineNumber - 1, columnIndex: range.startColumn - 1 }, edit);
			const end = shiftPosition({ lineIndex: range.endLineNumber - 1, columnIndex: range.endColumn - 1 }, edit);
			if (start.lineNumber === range.startLineNumber && start.column === range.startColumn && end.lineNumber === range.endLineNumber && end.column === range.endColumn) {
				return range;
			}
			return Range.fromPositions(start, end);
		};
		symbols = symbols.map(symbol => {
			const range = shift(symbol.range), selectionRange = shift(symbol.selectionRange);
			return range === symbol.range && selectionRange === symbol.selectionRange ? symbol : { ...symbol, range, selectionRange };
		});
		if (edit.range.start.lineIndex !== edit.range.end.lineIndex || edit.range.end.lineIndex !== edit.end.lineIndex) {
			folds = folds.map(fold => ({
				...fold,
				startLineIndex: shiftPosition({ lineIndex: fold.startLineIndex, columnIndex: 0 }, edit).lineNumber - 1,
				endLineIndex: shiftPosition({ lineIndex: fold.endLineIndex, columnIndex: 0 }, edit).lineNumber - 1,
			}));
		}
		diagnostics = diagnostics.map(diagnostic => {
			const range = shift(diagnostic.range);
			return range === diagnostic.range ? diagnostic : { ...diagnostic, range };
		});
	}
	return {
		symbols: spliceFacts(symbols, { ...delta.symbols, items: delta.symbols.items.map(symbol => ({ ...symbol, range: fromSyntaxRange(symbol.range), selectionRange: fromSyntaxRange(symbol.selectionRange) })) }),
		folds: spliceFacts(folds, delta.folds),
		diagnostics: spliceFacts(diagnostics, { ...delta.diagnostics, items: delta.diagnostics.items.map(diagnostic => ({ range: fromSyntaxRange(diagnostic.range), missing: diagnostic.kind === 'missing' })) }),
	};
}
function spliceFacts<T>(previous: readonly T[], change: SyntaxFactsSplice<T>): readonly T[] {
	if (change.start < 0 || change.deleteCount < 0 || change.start + change.deleteCount > previous.length) {
		throw new Error('Invalid syntax facts splice');
	}
	return [...previous.slice(0, change.start), ...change.items, ...previous.slice(change.start + change.deleteCount)];
}
function shiftPosition(point: SyntaxPosition, edit: SyntaxFactsDelta['edits'][number]): { lineNumber: number; column: number; } {
	const before = (left: SyntaxPosition, right: SyntaxPosition): boolean => left.lineIndex < right.lineIndex || left.lineIndex === right.lineIndex && left.columnIndex < right.columnIndex;
	let shifted = point;
	if (!before(point, edit.range.start)) {
		shifted = before(point, edit.range.end) ? edit.range.start : {
			lineIndex: point.lineIndex - edit.range.end.lineIndex + edit.end.lineIndex,
			columnIndex: point.lineIndex === edit.range.end.lineIndex ? point.columnIndex - edit.range.end.columnIndex + edit.end.columnIndex : point.columnIndex,
		};
	}
	return { lineNumber: shifted.lineIndex + 1, column: shifted.columnIndex + 1 };
}
