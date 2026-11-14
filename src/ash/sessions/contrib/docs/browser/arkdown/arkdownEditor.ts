import './arkdownEditor.css';
import { addDisposableListener, h } from '../../../../../base/browser/dom.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
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
		this.prose.tabIndex = 0;
		ArkdownEditorFocused.bindTo(this._register(contextKeys.createScoped(this.prose))).set(true);
		this.domNode.append(this.prose, this.source);
		parent.append(this.domNode);
		this._register(addDisposableListener(this.prose, 'beforeinput', event => this.beforeInput(event as InputEvent)));
		// Native drops must not mutate the projection outside a model transaction.
		this._register(addDisposableListener(this.prose, 'drop', event => event.preventDefault()));
		this._register(addDisposableListener(this.prose, 'compositionstart', () => { this.renderedVersion = -1; this.renderedRoots = []; this.composition = { range: this.readSelection(), version: model.getVersionId() }; }));
		this._register(addDisposableListener(this.prose, 'compositionend', event => this.finishComposition((event as CompositionEvent).data)));
		this._register(addDisposableListener(this.prose, 'paste', event => {
			event.preventDefault();
			if (!this.readOnly) this.replace(this.readSelection(), this.inlineText((event as ClipboardEvent).clipboardData?.getData('text/plain') ?? ''), true);
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
		this._register(addDisposableListener(document, 'selectionchange', () => { if (!this.composition && this.hasFocus() && this.containsSelection()) this.selection = this.readSelection(); }));
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

	setReadOnly(value: boolean): void { this.readOnly = value; this.prose.contentEditable = String(!value); this.prose.setAttribute('aria-readonly', String(value)); this.sourceEditor?.updateOptions({ readOnly: value }); }
	setMode(mode: DocsEditorMode): void { this.selection = this.readSelection(); this.mode = mode; this.render(false); this.modeChanged.fire(this.mode); this.focus(); }
	getMode(): DocsEditorMode { return this.mode; }
	focus(): void { if (this.mode === 'rich') this.prose.focus(); else this.ensureSourceEditor().focus(); this.restoreSelection(); }
	getText(): string { return this.model.getValue(); }
	getAccessibleText(): string { return this.mode === 'markdown' ? this.model.getValue() : this.prose.innerText; }
	getPlainText(): string {
		this.renderProse();
		// innerText depends on visibility; exports also work while source mode hides prose.
		const read = (node: Node): string => {
			if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
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
			case 'insertText': case 'insertReplacementText': this.replace(range, this.inlineText(event.data ?? ''), true); break;
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
		this.replace(composition.range, this.inlineText(text), true);
	}

	private inlineText(text: string): string { return text.replace(/[\\`*_\[\]<>]/gu, '\\$&').replace(/\r\n?/gu, '\n'); }
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

	layout(dimension: IDimension): void { this.sourceEditor?.layout(dimension); }

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
		if (this.mode === 'markdown' && (sourceWasHidden || !this.sourceEditor)) this.ensureSourceEditor().layout({ width: this.domNode.clientWidth, height: this.domNode.clientHeight });
		this.setReadOnly(this.readOnly);
		if (focus) this.focus();
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
		if (node.text !== undefined) {
			if (node.kind === 'code') {
				const code = h(parent.ownerDocument, 'code'); parent.append(code);
				const raw = source.slice(node.range.start, node.range.end);
				const fence = raw.match(/^`+/u)?.[0].length ?? 0;
				let start = node.range.start + fence, end = node.range.end - fence;
				if (source[start] === ' ' && source[end - 1] === ' ' && source.slice(start, end).trim()) { start++; end--; }
				this.leaf(code, node.text, { start, end }, source);
			} else this.leaf(parent, node.text, node.range, source);
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

	private leaf(parent: HTMLElement, text: string, range: ArkdownRange, source: string): void {
		const raw = source.slice(range.start, range.end);
		const offsets: number[] = [range.start];
		let cursor = 0;
		const entity = raw !== text && /^&[^\s;]+;$/u.test(raw);
		for (let index = 0; index < text.length; index++) {
			if (entity) { offsets.push(index === text.length - 1 ? range.end : range.start); continue; }
			if (raw[cursor] === '\\' && raw[cursor + 1] === text[index]) cursor++;
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
