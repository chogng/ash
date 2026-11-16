import './arkdownEditor.css';
import { addDisposableListener, h } from '../../../../../base/browser/dom.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { Emitter } from '../../../../../base/common/event.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { Selection } from '../../../../../editor/common/core/selection.js';
import type { TextModel } from '../../../../../editor/common/model/textModel.js';
import { localize } from '../../../../../nls.js';
import { RawContextKey } from '../../../../../platform/contextkey/common/contextkey.js';
import { CodeEditorWidget } from '../../../../../editor/browser/widget/codeEditor/codeEditorWidget.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { type IDimension } from '../../../../../base/browser/dom.js';
import type { ArkdownNode, ArkdownOperation, ArkdownProjection, ArkdownRange, ArkdownRuntime } from './arkdownRuntime.js';
import type { DocsEditorMode } from '../../common/docs.js';
import type { BufferRemoteChange } from '../../../../../workbench/services/collab/common/bufferCollabService.js';
import type { IEditorDecorationsCollection } from '../../../../../editor/common/editorCommon.js';
import { readDocsDropdown, writeDocsDropdown } from '../../common/docsDropdown.js';

const collaboratorColors = ['blue', 'purple', 'green', 'orange', 'red', 'yellow'];

interface Segment { readonly text: Text; readonly offsets: readonly number[]; }
interface RenderedRoot {
	readonly dom: readonly Node[];
	readonly segments: readonly Segment[];
	readonly key: string;
	readonly raw: string;
	range: ArkdownRange;
}
interface Composition { readonly range: ArkdownRange; readonly version: number; }
export const ArkdownEditorFocused = new RawContextKey<boolean>('arkdownEditorFocus', false);

/** Direct Markdown editing over the Workbench model. DOM and Rust output are
 * projections; only a validated model transaction can change document content. */
export class ArkdownEditor extends Disposable {
	readonly domNode: HTMLElement;
	private readonly projection: ArkdownProjection;
	private readonly prose: HTMLElement;
	private readonly source: HTMLElement;
	private readonly remoteHistory: HTMLDetailsElement;
	private readonly remoteSummary: HTMLElement;
	private readonly remoteList: HTMLElement;
	private remoteChanges: readonly BufferRemoteChange[] = [];
	private readonly remoteHighlights = new Map<string, { readonly highlight: Highlight; readonly ranges: readonly globalThis.Range[]; }>();
	private sourceHighlights: IEditorDecorationsCollection | undefined;
	private sourceEditor: CodeEditorWidget | undefined;
	private readonly segments: Segment[] = [];
	private readonly ranges = new WeakMap<Node, ArkdownRange>();
	private selection: ArkdownRange = { start: 0, end: 0 };
	private composition: Composition | undefined;
	private skipCompositionInput: string | undefined;
	private readOnly = false;
	private mode: DocsEditorMode;
	private renderedVersion = -1;
	private syntax: readonly ArkdownNode[] = [];
	private renderedRoots: RenderedRoot[] = [];
	private terminal: HTMLElement | undefined;
	private readonly modeChanged = this._register(new Emitter<DocsEditorMode>());
	readonly onDidChangeMode = this.modeChanged.event;
	private readonly selectionChanged = this._register(new Emitter<void>());
	readonly onDidChangeSelection = this.selectionChanged.event;

	constructor(parent: HTMLElement, private readonly model: TextModel, private readonly runtime: ArkdownRuntime, mode: DocsEditorMode,
		private readonly onError: (error: unknown) => void, private readonly openLink: (url: string) => void,
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@IContextKeyService contextKeys: IContextKeyService,
		@IConfigurationService private readonly configuration: IConfigurationService,
	) {
		super();
		this.projection = this._register(runtime.createProjection());
		this.mode = mode;
		const document = parent.ownerDocument;
		this.domNode = h(document, 'div', { className: 'stanza-arkdown-editor' });
		this.prose = h(document, 'div', { className: 'stanza-arkdown-prose', attributes: { role: 'textbox', 'aria-multiline': 'true', 'aria-label': localize({ bundle: 'ash.arkdown', key: 'documentBody' }, 'Document body'), 'data-arkdown-engine': 'wasm' } });
		this.source = document.createElement('div');
		this.source.className = 'stanza-arkdown-source';
		this.remoteHistory = document.createElement('details');
		this.remoteHistory.className = 'stanza-arkdown-remote-history';
		this.remoteHistory.hidden = true;
		this.remoteSummary = document.createElement('summary');
		this.remoteList = document.createElement('ol');
		this.remoteHistory.append(this.remoteSummary, this.remoteList);
		this._register(addDisposableListener(this.remoteHistory, 'toggle', () => this.layout({ width: this.source.clientWidth, height: this.source.clientHeight })));
		this.prose.tabIndex = 0;
		ArkdownEditorFocused.bindTo(this._register(contextKeys.createScoped(this.prose))).set(true);
		this.domNode.append(this.remoteHistory, this.prose, this.source);
		this._register(toDisposable(() => {
			this.clearRemoteHighlights();
			this.sourceHighlights?.clear();
		}));
		parent.append(this.domNode);
		this._register(addDisposableListener(this.prose, 'beforeinput', event => this.beforeInput(event as InputEvent)));
		// Native drops must not mutate the projection outside a model transaction.
		this._register(addDisposableListener(this.prose, 'drop', event => event.preventDefault()));
		this._register(addDisposableListener(this.prose, 'compositionstart', () => { this.renderedVersion = -1; this.renderedRoots = []; this.composition = { range: this.readSelection(), version: model.getVersionId() }; }));
		this._register(addDisposableListener(this.prose, 'compositionend', event => this.finishComposition((event as CompositionEvent).data)));
		this._register(addDisposableListener(this.prose, 'paste', event => {
			event.preventDefault();
			if (!this.readOnly) {
				this.insertText(this.readSelection(), (event as ClipboardEvent).clipboardData?.getData('text/plain') ?? '');
			}
		}));
		this._register(addDisposableListener(this.prose, 'cut', event => {
			if (this.readOnly) return;
			const range = this.readSelection();
			if (range.start === range.end) return;
			event.preventDefault();
			(event as ClipboardEvent).clipboardData?.setData('text/plain', document.defaultView?.getSelection()?.toString() ?? '');
			this.replace(range, '', true);
		}));
		this._register(addDisposableListener(this.prose, 'click', event => {
			const link = (event.target as Element).closest?.('a[data-href]');
			if (link && (event.ctrlKey || event.metaKey)) { event.preventDefault(); this.openLink(link.getAttribute('data-href')!); }
		}));
		this._register(addDisposableListener(document, 'selectionchange', () => {
			if (this.composition || !this.hasFocus() || !this.containsSelection()) return;
			const next = this.readSelection();
			if (next.start === this.selection.start && next.end === this.selection.end) return;
			this.selection = next;
			this.selectionChanged.fire();
		}));
		this._register(addDisposableListener(this.prose, 'change', event => {
			const select = (event.target as Element).closest<HTMLSelectElement>('select[data-arkdown-dropdown]');
			const range = select && this.ranges.get(select);
			if (!select || !range || this.readOnly) return;
			const value = readDocsDropdown(this.model.getValue().slice(range.start, range.end));
			if (!value) return;
			const source = writeDocsDropdown({ ...value, selected: select.selectedIndex });
			this.replace(range, source + (this.model.getValue().slice(range.start, range.end).endsWith('\n') ? '\n' : ''), false);
			for (const next of this.prose.querySelectorAll<HTMLSelectElement>('select[data-arkdown-dropdown]')) {
				if (this.ranges.get(next)?.start === range.start) { next.focus(); break; }
			}
		}));
		// Capture before a toolbar pointer press changes focus and collapses the DOM selection.
		this._register(addDisposableListener(document, 'pointerdown', event => { if (this.hasFocus() && !this.domNode.contains(event.target as Node)) this.selection = this.readSelection(); }, true));
		this._register(addDisposableListener(this.prose, 'keydown', event => this.keydown(event)));
		this._register(model.onDidChangeContent(change => {
			if (this.composition) return;
			const cursor = change.resultingSelection?.[0];
			if (cursor) this.selection = { start: model.getOffsetAt(cursor.getStartPosition()), end: model.getOffsetAt(cursor.getEndPosition()) };
			else {
				const map = (offset: number): number => {
					let delta = 0;
					for (const edit of change.changes) {
						if (offset < edit.rangeOffset) continue;
						if (offset <= edit.rangeOffset + edit.rangeLength) return edit.rangeOffset + delta + edit.text.length;
						delta += edit.text.length - edit.rangeLength;
					}
					return offset + delta;
				};
				this.selection = { start: map(this.selection.start), end: map(this.selection.end) };
			}
			this.render(this.hasFocus());
		}));
		this.render(false);
	}

	setReadOnly(value: boolean): void {
		this.readOnly = value;
		this.prose.contentEditable = String(!value);
		this.prose.setAttribute('aria-readonly', String(value));
		this.sourceEditor?.updateOptions({ readOnly: value });
		for (const select of this.prose.querySelectorAll<HTMLSelectElement>('select[data-arkdown-dropdown]')) select.disabled = value;
	}
	setMode(mode: DocsEditorMode): void { this.selection = this.readSelection(); this.mode = mode; this.render(false); this.modeChanged.fire(this.mode); this.focus(); }
	getMode(): DocsEditorMode { return this.mode; }
	focus(): void { if (this.mode === 'rich') this.prose.focus(); else this.ensureSourceEditor().focus(); this.restoreSelection(); }
	getText(): string { return this.model.getValue(); }
	getAccessibleText(): string { return [this.mode === 'markdown' ? this.model.getValue() : this.getPlainText(), this.remoteHistory.hidden ? '' : `${this.remoteSummary.textContent}\n${this.remoteList.textContent}`].filter(Boolean).join('\n\n'); }
	setRemoteChanges(changes: readonly BufferRemoteChange[]): void {
		this.remoteChanges = changes;
		this.remoteHistory.hidden = !changes.length;
		this.remoteSummary.textContent = localize({ bundle: 'ash.arkdown', key: 'recentRemoteChanges' }, 'Recent remote changes ({0})', changes.length);
		this.remoteHistory.setAttribute('aria-label', localize({ bundle: 'ash.arkdown', key: 'remoteChangesScope' }, 'Last 20 remote changes in this session. Text previews show up to 160 characters. Connection IDs identify sessions, not verified users.'));
		this.remoteList.replaceChildren();
		for (const change of changes) {
			const item = this.domNode.ownerDocument.createElement('li');
			item.className = `arkdown-remote-color-${this.remoteColor(change)}`;
			const label = this.domNode.ownerDocument.createElement('span');
			label.textContent = change.clientId
				? localize({ bundle: 'ash.arkdown', key: 'remoteConnection' }, 'Connection {0}', change.clientId)
				: localize({ bundle: 'ash.arkdown', key: 'remoteSynchronization' }, 'Shared document synchronization');
			item.append(label);
			if (change.removed) {
				const removed = this.domNode.ownerDocument.createElement('del');
				removed.textContent = localize({ bundle: 'ash.arkdown', key: 'removedText' }, 'Removed: {0}', change.removed);
				item.append(removed);
			}
			if (change.inserted) {
				const inserted = this.domNode.ownerDocument.createElement('ins');
				inserted.textContent = localize({ bundle: 'ash.arkdown', key: 'insertedText' }, 'Inserted: {0}', change.inserted);
				item.append(inserted);
			}
			this.remoteList.append(item);
		}
		this.renderRemoteHighlights();
		this.sourceEditor?.layout({ width: this.source.clientWidth, height: this.source.clientHeight });
	}
	private remoteColor(change: BufferRemoteChange): number {
		let hash = 0;
		for (const character of change.clientId ?? '') hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
		return hash % collaboratorColors.length;
	}
	private clearRemoteHighlights(): void {
		const registry = (this.domNode.ownerDocument.defaultView as Window & typeof globalThis).CSS?.highlights;
		for (const [name, { highlight, ranges }] of this.remoteHighlights) {
			for (const range of ranges) highlight.delete(range);
			if (!highlight.size && registry?.get(name) === highlight) registry.delete(name);
		}
		this.remoteHighlights.clear();
	}
	private renderRemoteHighlights(): void {
		const document = this.domNode.ownerDocument;
		const view = document.defaultView as Window & typeof globalThis;
		this.clearRemoteHighlights();
		for (let slot = 0; slot < collaboratorColors.length; slot++) {
			const name = `arkdown-remote-${collaboratorColors[slot]}`;
			if (this.mode !== 'rich' || this.composition || !view.Highlight || !view.CSS?.highlights) continue;
			const ranges: globalThis.Range[] = [];
			for (const change of this.remoteChanges) {
				if (this.remoteColor(change) !== slot || change.start === change.end) continue;
				for (const segment of this.segments) {
					const start = segment.offsets.findIndex(offset => offset >= change.start);
					const end = segment.offsets.findIndex(offset => offset >= change.end);
					if (start < 0 || segment.offsets[start] >= change.end) continue;
					const range = document.createRange();
					range.setStart(segment.text, start);
					range.setEnd(segment.text, end < 0 ? segment.text.length : end);
					ranges.push(range);
				}
			}
			if (ranges.length) {
				// The document shares six highlight types; each editor owns only its
				// ranges so refreshing or closing it preserves other editors' marks.
				const highlight = view.CSS.highlights.get(name) ?? new view.Highlight();
				for (const range of ranges) highlight.add(range);
				view.CSS.highlights.set(name, highlight);
				this.remoteHighlights.set(name, { highlight, ranges });
			}
		}
		if (this.sourceEditor) {
			this.sourceHighlights ??= this.sourceEditor.createDecorationsCollection();
			this.sourceHighlights.set(this.remoteChanges.filter(change => change.start < change.end).map(change => ({
				range: Range.fromPositions(this.model.getPositionAt(change.start), this.model.getPositionAt(change.end)),
				options: { description: 'arkdown-remote-change', inlineClassName: `arkdown-remote-change arkdown-remote-color-${this.remoteColor(change)}` },
			})));
		}
	}
	getPlainText(): string {
		this.renderProse();
		// innerText depends on visibility; exports also work while source mode hides prose.
		const read = (node: Node): string => {
			if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
			if (node.nodeName === 'IMG') return (node as HTMLImageElement).alt;
			if (node.nodeName === 'SELECT') {
				const select = node as HTMLSelectElement;
				return `${select.getAttribute('aria-label')}: ${select.selectedOptions[0]?.textContent ?? ''}`;
			}
			const text = Array.from(node.childNodes, read).join('');
			const tag = node.nodeName;
			if (/^(?:P|H[1-6]|PRE|BLOCKQUOTE|UL|OL|ASIDE)$/u.test(tag)) return text + '\n\n';
			if (tag === 'LI' || tag === 'TR') return text + '\n';
			if (tag === 'TD' || tag === 'TH') return text + '\t';
			return text;
		};
		return read(this.prose).replace(/[\t ]+\n/gu, '\n').replace(/\n{3,}/gu, '\n\n').trimEnd();
	}
	selectAll(): void { this.selection = { start: 0, end: this.model.getValueLength() }; this.restoreSelection(); }
	undo(): void { if (!this.readOnly && !this.composition) this.model.undo(); }
	redo(): void { if (!this.readOnly && !this.composition) this.model.redo(); }
	getSelectedText(): string { const range = this.readSelection(); return this.model.getValue().slice(range.start, range.end); }
	getSelectionFormatting(): { readonly bold: boolean; readonly italic: boolean; readonly heading: number; readonly list?: 'bullet' | 'ordered' | 'task'; } {
		const range = this.readSelection();
		let bold = false, italic = false, heading = 0;
		let list: 'bullet' | 'ordered' | 'task' | undefined;
		const visit = (nodes: readonly ArkdownNode[]): void => {
			for (const node of nodes) {
				if (node.range.start > range.start || node.range.end < range.end) continue;
				if (node.kind === 'strong') bold = true;
				if (node.kind === 'emphasis') italic = true;
				if (node.kind === 'heading') heading = node.level ?? 0;
				if (node.kind === 'list') list = node.start === undefined ? 'bullet' : 'ordered';
				if (node.kind === 'item' && node.children.some(child => child.kind === 'task_list_marker' || child.children.some(marker => marker.kind === 'task_list_marker'))) list = 'task';
				visit(node.children);
			}
		};
		if (this.mode === 'rich') visit(this.syntax);
		return { bold, italic, heading, list };
	}
	setHeading(level: number): void { this.structure({ kind: 'set_heading', offset: this.readSelection().start, level }); }
	setListKind(list: 'bullet' | 'ordered' | 'task'): void { this.structure({ kind: 'set_list_kind', offset: this.readSelection().start, list }); }
	/** Inserts a complete block after the current top-level block without splitting its Markdown syntax. */
	insertBlock(markdown: string): void {
		if (this.readOnly || this.composition) return;
		const source = this.model.getValue();
		const range = this.readSelection();
		const nodes = this.projection.parse(source);
		const offset = nodes.find(node => node.range.start <= range.end && node.range.end >= range.end)?.range.end ?? range.end;
		const before = source.slice(0, offset);
		const prefix = !before || /(?:\r?\n){2}$/u.test(before) ? '' : before.endsWith('\n') ? '\n' : '\n\n';
		this.replace({ start: offset, end: offset }, prefix + markdown + '\n\n', true);
	}

	format(mark: '**' | '_'): void {
		if (this.readOnly) return;
		const range = this.readSelection();
		const text = this.model.getValue();
		if (range.start === range.end) {
			// Empty emphasis has no editable text node. Select a valid snippet label
			// so the next input replaces it, as in the Markdown editor's format snippets.
			const label = mark === '**' ? localize({ bundle: 'ash.arkdown', key: 'bold' }, 'Bold') : localize({ bundle: 'ash.arkdown', key: 'italic' }, 'Italic');
			this.replace(range, mark + label + mark, true, { start: range.start + mark.length, end: range.start + mark.length + label.length });
			return;
		}
		if (text.slice(range.start - mark.length, range.start) === mark && text.slice(range.end, range.end + mark.length) === mark) {
			this.replace({ start: range.start - mark.length, end: range.end + mark.length }, text.slice(range.start, range.end), true, range.end - mark.length);
		} else this.replace(range, mark + text.slice(range.start, range.end) + mark, true, range.end + mark.length);
	}

	private beforeInput(event: InputEvent): void {
		if (this.readOnly) { event.preventDefault(); return; }
		if (this.composition || event.isComposing) return;
		event.preventDefault();
		if (this.skipCompositionInput !== undefined && (event.inputType === 'insertFromComposition' || event.inputType === 'insertText') && event.data === this.skipCompositionInput) {
			this.skipCompositionInput = undefined; return;
		}
		this.skipCompositionInput = undefined;
		let range = this.readSelection();
		switch (event.inputType) {
			case 'insertText': case 'insertReplacementText': this.insertText(range, event.data ?? ''); break;
			case 'insertParagraph': this.replace(range, '\n\n', true); break;
			case 'insertLineBreak': this.replace(range, '  \n', true); break;
			case 'deleteContentBackward': case 'deleteContentForward':
				if (range.start === range.end) range = event.inputType === 'deleteContentBackward'
					? { start: this.runtime.grapheme(this.model.getValue(), range.start, 'previous'), end: range.end }
					: { start: range.start, end: this.runtime.grapheme(this.model.getValue(), range.end, 'next') };
				this.replace(range, '', true); break;
			case 'deleteWordBackward': case 'deleteWordForward': case 'deleteSoftLineBackward': case 'deleteSoftLineForward': case 'deleteHardLineBackward': case 'deleteHardLineForward': {
				const target = event.getTargetRanges()[0];
				if (target) this.replace({ start: this.point(target.startContainer, target.startOffset), end: this.point(target.endContainer, target.endOffset) }, '', true);
				break;
			}
			case 'deleteByCut': case 'deleteContent': this.replace(range, '', true); break;
			case 'historyUndo': this.model.undo(); break;
			case 'historyRedo': this.model.redo(); break;
			case 'formatBold': this.format('**'); break;
			case 'formatItalic': this.format('_'); break;
		}
	}

	private keydown(event: KeyboardEvent): void {
		if (this.composition || event.isComposing) return;
		if (event.key === 'Tab' && !event.ctrlKey && !event.metaKey && !event.altKey && this.tableTab(event.shiftKey)) {
			event.preventDefault(); event.stopPropagation(); return;
		}
		if ((event.ctrlKey || event.metaKey) && event.altKey && /^Digit[0-6]$/u.test(event.code)) {
			event.preventDefault(); event.stopPropagation();
			this.structure({ kind: 'set_heading', offset: this.readSelection().start, level: Number(event.code.slice(-1)) }); return;
		}
		if ((event.ctrlKey || event.metaKey) && event.shiftKey && ['7', '8', '9'].includes(event.code.slice(-1)) && event.code.startsWith('Digit')) {
			event.preventDefault(); event.stopPropagation();
			this.structure({ kind: 'set_list_kind', offset: this.readSelection().start, list: event.code === 'Digit7' ? 'ordered' : event.code === 'Digit8' ? 'bullet' : 'task' }); return;
		}
		if (event.isComposing || this.composition || !(event.ctrlKey || event.metaKey) || event.altKey) return;
		const key = event.key.toLowerCase();
		if (!['a', 'z', 'y', 'b', 'i'].includes(key)) return;
		event.preventDefault(); event.stopPropagation();
		if (key === 'a') { this.selectAll(); return; }
		if (this.readOnly) return;
		if (key === 'z') { if (event.shiftKey) this.model.redo(); else this.model.undo(); }
		else if (key === 'y') this.model.redo();
		else this.format(key === 'b' ? '**' : '_');
	}

	private structure(operation: ArkdownOperation): void {
		if (this.readOnly || this.composition) return;
		try {
			const edits = this.runtime.operation(this.model.getValue(), operation);
			if (!edits.length) return;
			const before = this.readSelection();
			let caret = before.start;
			for (const edit of edits) {
				if (edit.range.end <= before.start) caret += edit.text.length - (edit.range.end - edit.range.start);
				else if (edit.range.start <= before.start) caret = edit.range.start + edit.text.length;
			}
			this.model.pushStackElement();
			this.model.pushEditOperations([Selection.fromPositions(this.model.getPositionAt(before.start), this.model.getPositionAt(before.end))], edits.map(edit => ({ range: Range.fromPositions(this.model.getPositionAt(edit.range.start), this.model.getPositionAt(edit.range.end)), text: edit.text })), () => [Selection.fromPositions(this.model.getPositionAt(caret))]);
			this.model.pushStackElement();
			this.focus();
		} catch (error) { this.onError(new Error(localize({ bundle: 'ash.arkdown', key: 'structureUnavailable' }, 'This structure cannot be changed here. Use Markdown source to edit nested blocks or Setext headings.'), { cause: error })); }
	}

	private tableTab(backwards: boolean): boolean {
		const offset = this.readSelection().start;
		const cells: ArkdownNode[] = [];
		const collect = (node: ArkdownNode): void => {
			if (node.kind === 'table_cell') cells.push(node);
			else for (const child of node.children) collect(child);
		};
		const table = this.syntax.find(node => node.kind === 'table' && node.range.start <= offset && offset <= node.range.end);
		if (!table) return false;
		collect(table);
		const current = cells.findIndex(cell => cell.range.start <= offset && offset <= cell.range.end);
		if (current < 0) return false;
		let target = cells[current + (backwards ? -1 : 1)];
		if (!target && !backwards && !this.readOnly) {
			const count = cells.length;
			this.structure({ kind: 'insert_table_row', offset: cells[current].range.start });
			cells.length = 0;
			const updated = this.syntax.find(node => node.kind === 'table' && node.range.start === table.range.start);
			if (updated) collect(updated);
			target = cells[count];
		}
		if (!target) return false;
		const caret = this.segments.find(segment => segment.offsets[0] >= target.range.start && segment.offsets[0] <= target.range.end)?.offsets[0] ?? target.range.start;
		this.selection = { start: caret, end: caret }; this.restoreSelection();
		return true;
	}

	private finishComposition(text: string): void {
		const composition = this.composition;
		this.composition = undefined;
		if (!composition) return;
		if (composition.version !== this.model.getVersionId() || this.readOnly || !text) { this.render(this.hasFocus()); return; }
		this.skipCompositionInput = text;
		this.insertText(composition.range, text);
	}

	private insertText(range: ArkdownRange, text: string): void {
		const code = this.findCodeAt(range);
		if (code?.kind === 'code') {
			const source = this.model.getValue();
			const { start, end, fenceLength } = inlineCodeContent(code.range, source);
			if (start <= range.start && range.end <= end) {
				if (!text.includes('`')) {
					this.replace(range, text, true);
					return;
				}
				const before = source.slice(start, range.start);
				const inserted = text.replace(/\r\n?|\n/gu, this.model.getEOL());
				const content = before + inserted + source.slice(range.end, end);
				let length = fenceLength;
				for (const run of content.matchAll(/`+/gu)) {
					length = Math.max(length, run[0].length + 1);
				}
				// Backticks cannot be escaped inside a code span. Use a longer delimiter and
				// pad boundary backticks so they cannot join the delimiter.
				const fence = '`'.repeat(length);
				const padding = /^`|`$|^ .* $/su.test(content) ? ' ' : '';
				const opening = fence + padding;
				this.replace(code.range, opening + content + padding + fence, true, code.range.start + opening.length + before.length + inserted.length);
				return;
			}
		}
		if (code?.kind === 'code_block') {
			const first = code.children[0];
			const last = code.children.at(-1);
			if (first && last && first.range.start <= range.start && range.end <= last.range.end) {
				this.insertCodeBlockText(code.range, { start: first.range.start, end: last.range.end }, range, text);
				return;
			}
		}
		this.replace(range, text.replace(/[\\`*_\[\]<>]/gu, '\\$&'), true);
	}

	private insertCodeBlockText(block: ArkdownRange, body: ArkdownRange, range: ArkdownRange, text: string): void {
		const source = this.model.getValue();
		const opening = /^(`{3,}|~{3,})/u.exec(source.slice(block.start, body.start))?.[0];
		if (!opening) {
			this.replace(range, text, true);
			return;
		}
		const eol = this.model.getEOL();
		const inserted = text.replace(/\r\n?|\n/gu, eol);
		const tail = source.slice(body.end, block.end);
		const closing = /(`{3,}|~{3,})[ \t]*$/u.exec(tail);
		// The trailing newline may be selected. Keep the closing fence on its own line.
		const separator = closing && range.end === body.end && !(inserted || source[range.start - 1]).endsWith('\n') ? eol : '';
		const lineStart = Math.max(body.start, source.lastIndexOf('\n', range.start - 1) + 1);
		const newline = source.indexOf('\n', range.end);
		const lineEnd = newline < 0 ? body.end : Math.min(newline, body.end);
		const changedLines = source.slice(lineStart, range.start) + inserted + source.slice(range.end, lineEnd);
		let length = opening.length;
		for (const [, run] of changedLines.matchAll(/^[ \t>]*(`{3,}|~{3,})[ \t]*\r?$/gmu)) {
			if (run[0] === opening[0]) {
				length = Math.max(length, run.length + 1);
			}
		}
		if (length === opening.length) {
			this.replace(range, inserted + separator, true, range.start + inserted.length);
			return;
		}
		const fence = opening[0].repeat(length);
		const before = fence + source.slice(block.start + opening.length, range.start);
		const closingText = closing ? tail.replace(closing[1], opening[0].repeat(Math.max(length, closing[1].length))) : tail;
		this.replace(block, before + inserted + separator + source.slice(range.end, body.end) + closingText, true, block.start + before.length + inserted.length);
	}

	private findCodeAt(range: ArkdownRange): ArkdownNode | undefined {
		let nodes = this.syntax;
		while (nodes.length) {
			const node = nodes.find(node => node.range.start <= range.start && range.end <= node.range.end);
			if (!node || node.kind === 'code' || node.kind === 'code_block') {
				return node;
			}
			nodes = node.children;
		}
		return undefined;
	}

	private replace(range: ArkdownRange, text: string, focus: boolean, caret?: number | ArkdownRange): void {
		if (this.readOnly) return;
		text = text.replace(/\r\n?|\n/gu, this.model.getEOL());
		const cursor = typeof caret === 'object' ? caret : { start: caret ?? range.start + text.length, end: caret ?? range.start + text.length };
		try {
			const before = this.readSelection();
			const edits = this.runtime.validate(this.model.getValue(), [{ range, text }]);
			if (!edits.length) { this.render(focus); return; }
			const beforeCursor = Selection.fromPositions(this.model.getPositionAt(before.start), this.model.getPositionAt(before.end));
			this.selection = cursor;
			this.model.pushStackElement();
			this.model.pushEditOperations([beforeCursor], edits.map(edit => ({ range: Range.fromPositions(this.model.getPositionAt(edit.range.start), this.model.getPositionAt(edit.range.end)), text: edit.text })), () => [Selection.fromPositions(this.model.getPositionAt(cursor.start), this.model.getPositionAt(cursor.end))]);
			this.model.pushStackElement();
			if (focus) this.focus();
		} catch (error) { this.render(focus); this.onError(error); }
	}

	private ensureSourceEditor(): CodeEditorWidget {
		if (!this.sourceEditor) {
			this.sourceEditor = this._register(this.instantiation.createInstance(CodeEditorWidget, {
				container: this.source, model: this.model, readOnly: this.readOnly,
				ariaLabel: localize({ bundle: 'ash.arkdown', key: 'markdownSource' }, 'Markdown source'),
				wordWrap: this.configuration.getValue('editor.wordWrap'),
				fontSize: this.configuration.getValue('editor.fontSize'),
				fontFamily: this.configuration.getValue('editor.fontFamily'),
			}));
		}
		return this.sourceEditor;
	}

	layout(dimension: IDimension): void { this.sourceEditor?.layout({ width: this.source.clientWidth || dimension.width, height: this.source.clientHeight || dimension.height }); }

	private render(focus: boolean): void {
		try {
			if (this.mode === 'rich') this.renderProse();
		} catch (error) {
			this.mode = 'markdown';
			this.modeChanged.fire(this.mode);
			this.onError(new Error(localize({ bundle: 'ash.arkdown', key: 'arkdownSourceFallback' }, 'The document could not be formatted. Markdown source is available for editing.'), { cause: error }));
		}
		const sourceWasHidden = this.source.hidden;
		this.prose.hidden = this.mode !== 'rich';
		this.source.hidden = this.mode !== 'markdown';
		if (this.mode === 'markdown' && (sourceWasHidden || !this.sourceEditor)) this.ensureSourceEditor().layout({ width: this.source.clientWidth, height: this.source.clientHeight });
		this.setReadOnly(this.readOnly);
		this.renderRemoteHighlights();
		if (focus) this.focus();
		this.selectionChanged.fire();
	}

	private renderProse(): void {
		if (this.renderedVersion === this.model.getVersionId()) return;
		const source = this.model.getValue();
		// Parse before discarding the previous projection; source remains available on failure.
		const nodes = this.projection.parse(source);
		this.syntax = nodes;
		const old = this.renderedRoots;
		if (!old.length) this.prose.replaceChildren();
		const descriptions = nodes.map(node => ({
			key: JSON.stringify(node, (key, value) => key === 'range' ? undefined : value),
			raw: source.slice(node.range.start, node.range.end),
		}));
		const same = (current: number, previous: number): boolean => old[previous]?.key === descriptions[current].key && old[previous].raw === descriptions[current].raw;
		let prefix = 0;
		while (prefix < nodes.length && prefix < old.length && same(prefix, prefix)) prefix++;
		let suffix = 0;
		while (suffix < nodes.length - prefix && suffix < old.length - prefix && same(nodes.length - 1 - suffix, old.length - 1 - suffix)) suffix++;
		this.terminal?.remove();
		this.terminal = undefined;
		for (const root of old.slice(prefix, old.length - suffix)) for (const node of root.dom) node.parentNode?.removeChild(node);
		this.segments.length = 0;
		const next: RenderedRoot[] = [];
		for (let index = 0; index < nodes.length; index++) {
			const node = nodes[index];
			const reused = index < prefix ? old[index] : index >= nodes.length - suffix ? old[old.length - (nodes.length - index)] : undefined;
			if (reused) {
				const delta = node.range.start - reused.range.start;
				if (delta) {
					const shift = (dom: Node): void => {
						const range = this.ranges.get(dom);
						if (range) this.ranges.set(dom, { start: range.start + delta, end: range.end + delta });
						for (const child of Array.from(dom.childNodes)) shift(child);
					};
					for (const dom of reused.dom) shift(dom);
				}
				const segments = delta ? reused.segments.map(segment => ({ text: segment.text, offsets: segment.offsets.map(offset => offset + delta) })) : reused.segments;
				next.push({ ...reused, range: node.range, segments });
				continue;
			}
			const container = this.domNode.ownerDocument.createElement('div');
			const start = this.segments.length;
			this.renderNode(container, node, source);
			const dom = Array.from(container.childNodes);
			const anchor = suffix ? old[old.length - suffix].dom[0] : null;
			for (const child of dom) this.prose.insertBefore(child, anchor);
			next.push({ ...descriptions[index], range: node.range, dom, segments: this.segments.slice(start) });
		}
		this.renderedRoots = next;
		this.segments.length = 0;
		for (const root of next) for (const segment of root.segments) this.segments.push(segment);
		// Keep an editable caret target after atomic blocks and terminal empty paragraphs.
		if (!this.segments.length || /(?:\r?\n){2}$/u.test(source)) {
			this.terminal = h(this.domNode.ownerDocument, 'p');
			this.prose.append(this.terminal);
			this.leaf(this.terminal, '', { start: source.length, end: source.length }, source);
		}
		this.renderedVersion = this.model.getVersionId();
	}

	private renderNode(parent: HTMLElement, node: ArkdownNode, source: string): void {
		if (node.kind === 'code_block') {
			const dropdown = readDocsDropdown(source.slice(node.range.start, node.range.end));
			if (dropdown) {
				const block = h(parent.ownerDocument, 'p', { attributes: { contenteditable: 'false' } });
				const select = h(parent.ownerDocument, 'select', { attributes: { 'data-arkdown-dropdown': '', 'aria-label': dropdown.label } });
				for (const value of dropdown.options) {
					const option = h(parent.ownerDocument, 'option', {}, value);
					select.append(option);
				}
				select.selectedIndex = dropdown.selected;
				this.ranges.set(select, node.range);
				block.append(select);
				parent.append(block);
				return;
			}
		}
		if (node.kind === 'image' && node.destination && /^https?:\/\//iu.test(node.destination)) {
			const image = h(parent.ownerDocument, 'img', { attributes: { src: node.destination, alt: node.children.map(child => child.text ?? '').join(''), contenteditable: 'false', loading: 'lazy', referrerpolicy: 'no-referrer' } });
			this.ranges.set(image, node.range);
			parent.append(image);
			return;
		}
		if (node.text !== undefined) {
			if (node.kind === 'code') {
				const code = h(parent.ownerDocument, 'code'); parent.append(code);
				this.leaf(code, node.text, inlineCodeContent(node.range, source), source, { literal: true });
			} else {
				this.leaf(parent, node.text, node.range, source, { literal: parent.localName === 'pre' });
			}
			return;
		}
		const tags: Record<string, string> = { paragraph: 'p', strong: 'strong', emphasis: 'em', strikethrough: 's', block_quote: 'blockquote', code_block: 'pre', list: node.start === undefined ? 'ul' : 'ol', item: 'li', table: 'table', table_head: 'thead', table_row: 'tr', table_cell: 'td', link: 'a', rule: 'hr', footnote_definition: 'aside' };
		if (node.kind === 'soft_break' || node.kind === 'hard_break') { this.leaf(parent, '\n', node.range, source); return; }
		if (node.kind === 'task_list_marker') {
			const label = node.checked
				? localize({ bundle: 'ash.arkdown', key: 'taskCompleted' }, 'Completed task')
				: localize({ bundle: 'ash.arkdown', key: 'taskIncomplete' }, 'Incomplete task');
			const box = h(this.domNode.ownerDocument, 'span', { attributes: { role: 'img', 'aria-label': label, contenteditable: 'false' } }, node.checked ? '☑ ' : '☐ ');
			parent.append(box); return;
		}
		const tag = node.kind === 'heading' ? `h${Math.max(1, Math.min(6, node.level!))}` : tags[node.kind] ?? 'span';
		const element = this.domNode.ownerDocument.createElement(tag);
		this.ranges.set(element, node.range);
		if (node.kind === 'list' && node.start !== undefined) element.setAttribute('start', String(node.start));
		if (node.kind === 'link' && node.destination && /^(?:https?:|mailto:)/iu.test(node.destination)) element.setAttribute('data-href', node.destination);
		if (node.kind === 'rule') element.contentEditable = 'false';
		parent.append(element);
		if (node.kind === 'table_head') { const row = h(parent.ownerDocument, 'tr'); element.append(row); for (const child of node.children) this.renderNode(row, child, source); }
		else for (const child of node.children) this.renderNode(element, child, source);
		if (node.kind === 'table_cell' && !node.children.length) this.leaf(element, '', { start: node.range.start, end: node.range.start }, source);
		// Markdown parsers omit terminal spaces; retain a DOM caret target for live typing.
		if (node.kind === 'paragraph' || node.kind === 'heading') {
			const start = node.children.at(-1)?.range.end ?? node.range.start;
			const tail = source.slice(start, node.range.end).match(/^[ \t]+(?=\r?\n?$)/u)?.[0];
			if (tail) this.leaf(element, tail, { start, end: start + tail.length }, source);
		}
	}

	private leaf(parent: HTMLElement, text: string, range: ArkdownRange, source: string, options?: { readonly literal: boolean; }): void {
		const raw = source.slice(range.start, range.end);
		const offsets: number[] = [range.start];
		let cursor = 0;
		const entity = raw !== text && /^&[^\s;]+;$/u.test(raw);
		for (let index = 0; index < text.length; index++) {
			if (entity) { offsets.push(index === text.length - 1 ? range.end : range.start); continue; }
			if (!options?.literal && raw[cursor] === '\\' && raw[cursor + 1] === text[index]) cursor++;
			if (raw[cursor] === '\r' && raw[cursor + 1] === '\n' && (text[index] === '\n' || text[index] === ' ')) cursor += 2;
			else { if (raw[cursor] !== text[index]) { const found = raw.indexOf(text[index], cursor); if (found >= 0) cursor = found; } cursor++; }
			offsets.push(Math.min(range.start + cursor, range.end));
		}
		const node = this.domNode.ownerDocument.createTextNode(text);
		parent.append(node);
		this.segments.push({ text: node, offsets });
		this.ranges.set(node, range);
	}

	private containsSelection(): boolean { const selection = this.prose.ownerDocument.defaultView?.getSelection(); return !!selection?.anchorNode && this.prose.contains(selection.anchorNode) && !!selection.focusNode && this.prose.contains(selection.focusNode); }
	private readSelection(): ArkdownRange {
		if (this.mode === 'markdown') {
			const selection = this.sourceEditor?.getSelection();
			return selection ? { start: this.model.getOffsetAt(selection.getStartPosition()), end: this.model.getOffsetAt(selection.getEndPosition()) } : this.selection;
		}
		if (!this.hasFocus() || !this.containsSelection()) return this.selection;
		const selection = this.prose.ownerDocument.defaultView!.getSelection()!;
		const start = this.point(selection.anchorNode!, selection.anchorOffset), end = this.point(selection.focusNode!, selection.focusOffset);
		return { start: Math.min(start, end), end: Math.max(start, end) };
	}
	private point(node: Node, offset: number): number {
		const segment = this.segments.find(segment => segment.text === node);
		if (segment) return segment.offsets[Math.min(offset, segment.offsets.length - 1)];
		const next = node.childNodes[offset];
		if (next) { const found = this.segments.find(segment => next === segment.text || next.contains(segment.text)); if (found) return found.offsets[0]; }
		const contained = this.segments.filter(segment => node.contains(segment.text));
		const last = contained.at(-1);
		return last?.offsets.at(-1) ?? this.ranges.get(node)?.end ?? this.model.getValueLength();
	}
	private restoreSelection(): void {
		const length = this.model.getValueLength();
		this.selection = { start: Math.min(this.selection.start, length), end: Math.min(this.selection.end, length) };
		if (this.mode === 'markdown') {
			this.ensureSourceEditor().setSelection(Selection.fromPositions(this.model.getPositionAt(this.selection.start), this.model.getPositionAt(this.selection.end)));
			return;
		}
		const locate = (offset: number): [Node, number] => {
			for (const segment of this.segments) {
				const index = segment.offsets.findIndex(value => value >= offset);
				if (index >= 0) return [segment.text, index];
			}
			const last = this.segments.at(-1);
			return last ? [last.text, last.text.length] : [this.prose, 0];
		};
		const [start, startOffset] = locate(this.selection.start), [end, endOffset] = locate(this.selection.end);
		this.prose.ownerDocument.defaultView?.getSelection()?.setBaseAndExtent(start, startOffset, end, endOffset);
	}
	hasFocus(): boolean { return this.mode === 'rich' && this.prose.contains(this.prose.ownerDocument.activeElement); }
	override dispose(): void { this.domNode.remove(); super.dispose(); }
}

function inlineCodeContent(range: ArkdownRange, source: string): ArkdownRange & { readonly fenceLength: number; } {
	const fenceLength = source.slice(range.start, range.end).match(/^`+/u)?.[0].length ?? 0;
	let start = range.start + fenceLength;
	let end = range.end - fenceLength;
	if (source[start] === ' ' && source[end - 1] === ' ' && source.slice(start, end).trim()) {
		start++;
		end--;
	}
	return { start, end, fenceLength };
}
