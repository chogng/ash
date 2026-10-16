import type { RelativeToken, TreeSitterTokenizationMeasure, TreeSitterFacts, TreeSitterBracket, TreeSitterSyntaxResult } from './treeSitterLibraryService.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { type WebWorkerRequestHandler } from '../../../../base/common/worker/webWorker.js';
import { Position } from '../../core/position.js';
import { Range, type IRange } from '../../core/range.js';
import { type TextModelChange } from '../../core/textChange.js';
import { MirrorTextModel } from '../../model/mirrorTextModel.js';
import { TreeSitterTree, type TreeSitterTokenizationRuntime } from '../../model/tokens/treeSitter/treeSitterTree.js';
import type { Node } from '@vscode/tree-sitter-wasm';


/** Derived text mirror only: editor transactions remain owned by the renderer. */
class SyntaxMirror extends MirrorTextModel {
	tabSize = 4;
	private readonly content = new Emitter<TextModelChange>();
	readonly onDidChangeContent = this.content.event;
	readonly onWillDispose = Event.None;
	readonly onDidChangeAttached = Event.None;
	isAttachedToEditor(): boolean { return false; }
	getLineContent(line: number): string { return this._lines[line - 1]!; }
	getLineCount(): number { return this._lines.length; }
	getLineLength(line: number): number { return this._lines[line - 1]?.length ?? 0; }
	getLineMaxColumn(line: number): number { return this.getLineLength(line) + 1; }
	get length(): number { this._ensureLineStarts(); return this._lineStarts!.getTotalSum() - this._eol.length; }
	getOffsetAt(position: { lineNumber: number; column: number; }): number {
		this._ensureLineStarts();
		return this._lineStarts!.getPrefixSum(position.lineNumber - 2) + position.column - 1;
	}
	getPositionAt(offset: number): Position {
		this._ensureLineStarts();
		const result = this._lineStarts!.getIndexOf(Math.max(0, Math.min(this.length, offset)));
		return new Position(result.index + 1, Math.min(this.getLineLength(result.index + 1), result.remainder) + 1);
	}
	getValueInRange(range: IRange): string {
		const start = range.startLineNumber - 1, end = range.endLineNumber - 1;
		if (start === end) return this._lines[start]!.slice(range.startColumn - 1, range.endColumn - 1);
		return [this._lines[start]!.slice(range.startColumn - 1), ...this._lines.slice(start + 1, end), this._lines[end]!.slice(0, range.endColumn - 1)].join(this._eol);
	}
	accept(change: TextModelChange): void {
		if (change.version !== this.version + 1) throw new RangeError('Nonconsecutive syntax mirror revision');
		for (const edit of change.changes) {
			if (this.getOffsetAt(edit.range.getStartPosition()) !== edit.rangeOffset || this.getOffsetAt(edit.range.getEndPosition()) - edit.rangeOffset !== edit.rangeLength) throw new RangeError('Syntax edit does not match mirror');
		}
		this.onEvents({ changes: [...change.changes].sort((a, b) => b.rangeOffset - a.rangeOffset), eol: change.eol, versionId: change.version, isUndoing: false, isRedoing: false });
		this.content.fire(change);
	}
	[Symbol.dispose](): void { this.dispose(); }
	override dispose(): void { this.content.dispose(); super.dispose(); }
}

interface Document {
	readonly resources: DisposableStore;
	readonly model: SyntaxMirror;
	readonly tree: TreeSitterTree;
	readonly measures: TreeSitterTokenizationMeasure[];
	facts?: { revision: number; value: TreeSitterFacts; };
}

/** One shared Worker owns all document parsers; every feature reads the same tree revision. */
export class TreeSitterWorker extends Disposable implements WebWorkerRequestHandler {
	private readonly documents = new Map<number, Document>();
	constructor(private readonly load: (language: string) => Promise<TreeSitterTokenizationRuntime>) { super(); }
	handleNotification(message: Record<string, unknown>): void {
		const id = integer(message.document, 1);
		if (message.kind === 'close') { this.documents.get(id)?.resources.dispose(); this.documents.delete(id); return; }
		if (message.kind === 'open') {
			if (this.documents.has(id) || typeof message.text !== 'string' || typeof message.language !== 'string' || (message.eol !== '\n' && message.eol !== '\r\n')) throw new TypeError('Invalid syntax open');
			const resources = new DisposableStore();
			const model = resources.add(new SyntaxMirror(URI.parse('inmemory:syntax'), message.text.split(/\r\n|\n/), message.eol, integer(message.revision, 1)));
			const measures: TreeSitterTokenizationMeasure[] = [];
			const tree = resources.add(new TreeSitterTree(model, this.load(message.language), name => ({ tokenType: name }), sample => { measures.push(sample); if (measures.length > 1000) measures.shift(); }));
			this.documents.set(id, { resources, model, tree, measures });
			return;
		}
		const document = this.document(id);
		if (message.kind === 'options') { document.model.tabSize = integer(message.tabSize, 1); document.facts = undefined; return; }
		if (message.kind !== 'update') throw new TypeError('Unknown syntax notification');
		const change = message.change as TextModelChange;
		if (!change || !Array.isArray(change.changes) || typeof change.isEolChange !== 'boolean' || (change.eol !== '\n' && change.eol !== '\r\n')) throw new TypeError('Invalid syntax edit');
		integer(change.version, 1);
		const edits = change.changes.map(edit => {
			const range = readRange(edit.range, document.model.getLineCount());
			integer(edit.rangeOffset, 0); integer(edit.rangeLength, 0);
			if (typeof edit.text !== 'string') throw new TypeError('Invalid syntax replacement');
			return { ...edit, range };
		});
		document.model.accept({ ...change, changes: edits });
		document.facts = undefined;
	}
	async handleRequest(message: Record<string, unknown>, signal: AbortSignal): Promise<TreeSitterSyntaxResult> {
		const document = this.document(integer(message.document, 1));
		const revision = integer(message.revision, 1);
		await document.tree.whenReady(signal);
		signal.throwIfAborted();
		if (document.model.version !== revision) throw new Error('Obsolete syntax request');
		const result = { revision, measures: document.measures.splice(0) };
		switch (message.operation) {
			case 'highlight': {
				if (!Array.isArray(message.ranges) || message.ranges.length > 1000) throw new TypeError('Invalid syntax viewport');
				const ranges = message.ranges;
				const rows: { row: number; tokens: readonly RelativeToken[]; }[] = [];
				for (const range of message.ranges) {
					const start = integer(range.startLineNumber, 1), end = integer(range.endLineNumber, start);
					if (end > document.model.getLineCount()) throw new RangeError('Syntax viewport outside model');
					document.tree.refreshRange(start, end);
					for (let row = start - 1; row < end; row++) rows.push({ row, tokens: document.tree.captureRowsCache.get(row) ?? [] });
				}
				return { ...result, rows, brackets: [document.tree.rootNode!, ...document.tree.embeddedRootNodes].flatMap(root => collectBrackets(root, ranges, document.model)), measures: [...result.measures, ...document.measures.splice(0)] };
			}
			case 'facts': {
				// Folding/outline consumers often request first in the content event. Let
				// visible-range queries use the completed tree before bulk extraction.
				await new Promise<void>(resolve => setTimeout(resolve, 0));
				signal.throwIfAborted();
				if (document.model.version !== revision) throw new Error('Obsolete syntax request');
				if (!document.facts) {
					const started = performance.now();
					document.facts = { revision, value: collectFacts(document.tree, document.model) };
					result.measures.push({ operation: 'facts', duration: performance.now() - started, incremental: true, completed: true, lines: document.model.getLineCount() });
				}
				return { ...result, facts: document.facts.value };
			}
			case 'selection': {
				if (!Array.isArray(message.ranges)) throw new TypeError('Invalid syntax selection');
				const selections: Range[] = [];
				for (const value of message.ranges) {
					const range = readRange(value, document.model.getLineCount());
					let node = document.tree.rootNode!.namedDescendantForPosition({ row: range.startLineNumber - 1, column: range.startColumn - 1 }, { row: range.endLineNumber - 1, column: range.endColumn - 1 });
					for (let count = 0; node?.parent && count < 64; node = node.parent, count++) if (node.isNamed && !node.isError && !node.isMissing) selections.push(nodeRange(node));
				}
				return { ...result, selections };
			}
			case 'preview': {
				const line = integer(message.line, 1);
				if (!Array.isArray(message.lines) || message.lines.some(value => typeof value !== 'string')) throw new TypeError('Invalid hypothetical syntax');
				return { ...result, preview: await document.tree.tokenizeLinesAtAsync(line, message.lines as string[], signal) };
			}
			default: throw new TypeError('Unknown syntax operation');
		}
	}
	private document(id: number): Document { const document = this.documents.get(id); if (!document) throw new Error('Unknown syntax document'); return document; }
	override dispose(): void { for (const document of this.documents.values()) document.resources.dispose(); this.documents.clear(); super.dispose(); }
}

function collectFacts(tree: TreeSitterTree, model: SyntaxMirror): TreeSitterFacts {
	const folds: TreeSitterFacts['folds'][number][] = [], diagnostics: TreeSitterFacts['diagnostics'][number][] = [], symbols: TreeSitterFacts['symbols'][number][] = [];
	const root = tree.rootNode!;
	const cursor = root.walk();
	try {
		let visit = true;
		while (visit) {
			const node = cursor.currentNode;
			if (node.isError || node.isMissing) diagnostics.push({ range: nodeRange(node), missing: node.isMissing });
			if (cursor.gotoFirstChild()) continue;
			while (!cursor.gotoNextSibling()) if (!cursor.gotoParent()) { visit = false; break; }
		}
	} finally { cursor.delete(); }
	for (const structure of tree.structureTrees) {
		for (const capture of structure.folds?.captures(structure.root) ?? []) {
			const node = capture.node;
			const end = node.endPosition.row - (node.endPosition.column === 0 ? 1 : 0);
			if (end > node.startPosition.row) folds.push({ startLineIndex: node.startPosition.row, endLineIndex: end, ...(node.type.toLowerCase().includes('comment') ? { kind: 'comment' as const } : {}) });
		}
		for (const match of structure.symbols?.matches(structure.root) ?? []) {
			const definition = match.captures.find(capture => capture.name.startsWith('definition.'));
			const name = match.captures.find(capture => capture.name === 'name');
			if (definition && name) symbols.push({ name: model.getValueInRange(nodeRange(name.node)), kind: definition.name.slice('definition.'.length), range: nodeRange(definition.node), selectionRange: nodeRange(name.node) });
		}
	}
	const structuralStarts = new Set(folds.map(fold => fold.startLineIndex));
	const fallbackFold = (fold: TreeSitterFacts['folds'][number]) => { if (fold.kind === 'region' || !structuralStarts.has(fold.startLineIndex)) folds.push(fold); };
	// Indentation and region markers are derived once in the Worker, rather than
	// rescanning the renderer buffer on every token notification.
	const stack: { row: number; indent: number; }[] = [], regions: number[] = [];
	const rules = tree.foldingRules;
	const matches = (pattern: RegExp | undefined, text: string): boolean => {
		if (!pattern) return false;
		pattern.lastIndex = 0;
		return pattern.test(text);
	};
	let previous: { row: number; indent: number; } | undefined;
	for (let row = 0; row < model.getLineCount(); row++) {
		const text = model.getValueInRange(new Range(row + 1, 1, row + 1, model.getLineMaxColumn(row + 1)));
		if (matches(rules?.markers?.end, text)) { const start = regions.pop(); if (start !== undefined && row > start) fallbackFold({ startLineIndex: start, endLineIndex: row, kind: 'region' }); }
		else if (matches(rules?.markers?.start, text)) regions.push(row);
		if (!text.trim()) continue;
		let indent = 0;
		for (const character of text) { if (character === ' ') indent++; else if (character === '\t') indent += model.tabSize - indent % model.tabSize; else break; }
		while (stack.length && indent <= stack.at(-1)!.indent) { const entry = stack.pop()!, end = rules?.offSide ? row - 1 : previous?.row ?? row - 1; if (end > entry.row) fallbackFold({ startLineIndex: entry.row, endLineIndex: end }); }
		if (previous && indent > previous.indent) stack.push(previous);
		previous = { row, indent };
	}
	const end = rules?.offSide ? model.getLineCount() - 1 : previous?.row ?? 0;
	while (stack.length) { const entry = stack.pop()!; if (end > entry.row) fallbackFold({ startLineIndex: entry.row, endLineIndex: end }); }
	folds.sort((a, b) => a.startLineIndex - b.startLineIndex || b.endLineIndex - a.endLineIndex);
	symbols.sort((a, b) => a.selectionRange.startLineNumber - b.selectionRange.startLineNumber || a.selectionRange.startColumn - b.selectionRange.startColumn);
	return { folds: folds.filter((range, index) => index === 0 || folds[index - 1]!.startLineIndex !== range.startLineIndex), symbols, diagnostics };
}
function nodeRange(node: Node): Range { return new Range(node.startPosition.row + 1, node.startPosition.column + 1, node.endPosition.row + 1, node.endPosition.column + 1); }
function integer(value: unknown, minimum: number): number { if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new RangeError('Invalid syntax integer'); return value as number; }
function readRange(value: unknown, lines: number): Range {
	if (!value || typeof value !== 'object') throw new TypeError('Invalid syntax range');
	const range = value as IRange;
	integer(range.startLineNumber, 1); integer(range.endLineNumber, range.startLineNumber); integer(range.startColumn, 1); integer(range.endColumn, 1);
	if (range.endLineNumber > lines || range.startLineNumber === range.endLineNumber && range.startColumn > range.endColumn) throw new RangeError('Invalid syntax range');
	return Range.lift(range);
}

/** Query just the viewport and its ancestors; no second renderer bracket AST. */
function collectBrackets(root: Node, ranges: readonly { startLineNumber: number; endLineNumber: number; }[], model: SyntaxMirror): readonly TreeSitterBracket[] {
	const parents = new Map<number, Node>();
	for (const range of ranges) {
		const start = { row: range.startLineNumber - 1, column: 0 }, end = { row: range.endLineNumber, column: 0 };
		for (const leaf of root.descendantsOfType(['(', ')', '[', ']', '{', '}'], start, end)) if (leaf?.parent) parents.set(leaf.parent.id, leaf.parent);
		for (let node = root.descendantForPosition(start); node?.parent; node = node.parent) parents.set(node.parent.id, node.parent);
	}
	const result: TreeSitterBracket[] = [];
	for (const parent of parents.values()) {
		const children = parent.children.filter((node): node is Node => node !== null), opens = children.filter(node => !node.isNamed && ['(', '[', '{'].includes(node.type));
		for (const open of opens) {
			const closeText = ({ '(': ')', '[': ']', '{': '}' } as Record<string, string>)[open.type]!;
			const close = children.find(node => !node.isNamed && node.type === closeText && node.startIndex >= open.endIndex);
			let level = 0, equalLevel = 0;
			for (let ancestor = parent.parent; ancestor; ancestor = ancestor.parent) {
				const first = ancestor.firstChild;
				if (first && !first.isNamed && ['(', '[', '{'].includes(first.type)) { level++; if (first.type === open.type) equalLevel++; }
			}
			let minIndent = Number.MAX_SAFE_INTEGER;
			if (close && close.startPosition.row > open.endPosition.row) for (let row = open.endPosition.row + 1; row <= close.startPosition.row; row++) {
				const line = model.getLineContent(row + 1); if (!line.trim()) continue;
				let indent = 0; for (const ch of line) { if (ch === ' ') indent++; else if (ch === '\t') indent += model.tabSize - indent % model.tabSize; else break; }
				minIndent = Math.min(minIndent, indent);
			}
			result.push({ range: Range.fromPositions(nodeRange(open).getStartPosition(), nodeRange(close ?? parent).getEndPosition()), opening: nodeRange(open), ...(close ? { closing: nodeRange(close), closeText } : {}), text: open.type, level, equalLevel, minIndent: minIndent === Number.MAX_SAFE_INTEGER ? -1 : minIndent });
		}
	}
	return result.sort((a, b) => Range.compareRangesUsingStarts(a.range, b.range));
}
