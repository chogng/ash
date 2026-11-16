import './arkdownEditor.css';
import '../docsColors.js';
import { addDisposableListener, h } from '../../../../../base/browser/dom.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { Checkbox } from '../../../../../base/browser/ui/toggle/toggle.js';
import { Emitter } from '../../../../../base/common/event.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { TrackedRangeStickiness } from '../../../../../editor/common/model.js';
import { Selection } from '../../../../../editor/common/core/selection.js';
import type { TextModel } from '../../../../../editor/common/model/textModel.js';
import { localize } from '../../../../../nls.js';
import { RawContextKey } from '../../../../../platform/contextkey/common/contextkey.js';
import { CodeEditorWidget } from '../../../../../editor/browser/widget/codeEditor/codeEditorWidget.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { type IDimension } from '../../../../../base/browser/dom.js';
import type { ArkdownNode, ArkdownOperation, ArkdownProjection, ArkdownRange, ArkdownRuntime, ArkdownTableAction, ArkdownTableCellLayout, ArkdownTextColor } from './arkdownRuntime.js';
import { ArkdownTableController, type ArkdownTableBlockTarget } from './arkdownTableController.js';
import { formatArkdownInline, formatArkdownTableCells, type ArkdownInlineFormat, type ArkdownTableCellFormat } from './arkdownInlineFormatting.js';
import { ArkdownComments, type DocsCommentDraft } from './arkdownComments.js';
import { DocsCommentState } from '../../common/docsComments.js';
import type { DocsEditorMode } from '../../common/docs.js';
import type { BufferRemoteChange } from '../../../../../workbench/services/collab/common/bufferCollabService.js';
import type { IEditorDecorationsCollection } from '../../../../../editor/common/editorCommon.js';
import { readDocsDropdown, writeDocsDropdown } from '../../common/docsDropdown.js';
import { ArkdownImage } from './arkdownImage.js';
import { readArkdownImageLayout, isArkdownImageSource, readArkdownImageFile, writeArkdownImage, type ArkdownImageSource, type ArkdownImageLayout } from './arkdownImages.js';

const collaboratorColors = ['blue', 'purple', 'green', 'orange', 'red', 'yellow'];

interface Segment { readonly kind: 'text' | 'boundary'; readonly text: Text; readonly offsets: readonly number[]; }
interface RenderedRoot {
	readonly dom: readonly Node[];
	readonly segments: readonly Segment[];
	readonly key: string;
	readonly raw: string;
	/** Reused blocks retain their controls; removed blocks release all control listeners. */
	readonly lifetime: DisposableStore;
	readonly checkboxes: readonly Checkbox[];
	range: ArkdownRange;
}
interface TableComposition { readonly offset: number; readonly top: number; readonly left: number; readonly bottom: number; readonly right: number; }
interface Composition { readonly range: ArkdownRange; readonly version: number; readonly table?: TableComposition; }
export const ArkdownEditorFocused = new RawContextKey<boolean>('arkdownEditorFocus', false);

/** Direct Markdown editing over the Workbench model. DOM and Rust output are
 * projections; only a validated model transaction can change document content. */
export class ArkdownEditor extends Disposable {
	private readonly imageWidgets = new WeakMap<HTMLElement, ArkdownImage>();
	readonly domNode: HTMLElement;
	readonly comments: ArkdownComments;
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
	private indentationCapabilities: { version: number; start: number; end: number; increase?: boolean; decrease?: boolean; } | undefined;
	private composition: Composition | undefined;
	private pendingTableComposition: TableComposition | undefined;
	private skipCompositionInput: string | undefined;
	private readOnly = false;
	private mode: DocsEditorMode;
	private pageWide = false;
	private renderedVersion = -1;
	private parsedVersion = -1;
	private syntax: readonly ArkdownNode[] = [];
	private renderedRoots: RenderedRoot[] = [];
	private readonly rootLifetimes = this._register(new DisposableStore());
	private resetProjection = false;
	private terminal: HTMLElement | undefined;
	private readonly modeChanged = this._register(new Emitter<DocsEditorMode>());
	readonly onDidChangeMode = this.modeChanged.event;
	private readonly selectionChanged = this._register(new Emitter<void>());
	readonly onDidChangeSelection = this.selectionChanged.event;
	private readonly commentRequested = this._register(new Emitter<{ readonly threadId?: string; readonly draft?: DocsCommentDraft; readonly focus?: boolean; }>());
	readonly onDidRequestComment = this.commentRequested.event;
	private activeComment: string | undefined;
	private readonly tables: ArkdownTableController;

	constructor(parent: HTMLElement, private readonly model: TextModel, private readonly runtime: ArkdownRuntime, mode: DocsEditorMode,
		private readonly onError: (error: unknown) => void, private readonly openLink: (url: string) => void,
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@IContextKeyService contextKeys: IContextKeyService,
		@IConfigurationService private readonly configuration: IConfigurationService,
	) {
		super();
		this.projection = this._register(runtime.createProjection());
		this.comments = new ArkdownComments(model, runtime, () => !this.readOnly && !this.composition, () => this.readSelection(), () => this.parseSyntax());
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
		this.tables = this._register(instantiation.createInstance(ArkdownTableController, this.prose, {
			getNode: (table: HTMLTableElement) => this.getTableNode(table),
			apply: (table: HTMLTableElement, action: ArkdownTableAction, target?: { row: number; column: number; }) => this.applyTableAction(table, action, target),
			setCaret: (table: HTMLTableElement, row: number, column: number) => this.setTableCaret(table, row, column),
			canEdit: () => !this.readOnly && !this.composition && this.mode === 'rich',
			beginComposition: (table: HTMLTableElement, rectangle: Omit<TableComposition, 'offset'>) => {
				const node = this.getTableNode(table);
				if (!node) return;
				this.pendingTableComposition = { offset: node.range.start, ...rectangle };
				this.setTableCaret(table, rectangle.top, rectangle.left);
			},
			blockTarget: (table: HTMLTableElement, target: { clientY: number; } | 'previous' | 'next') => this.tableBlockTarget(table, target),
			moveBlock: (table: HTMLTableElement, offset: number) => this.moveTableBlock(table, offset),
			onError,
		}));
		this._register(this.tables.onDidChangeSelection(() => this.selectionChanged.fire()));
		this._register(addDisposableListener(this.prose, 'beforeinput', event => this.beforeInput(event as InputEvent)));
		// Native drops must not mutate the projection outside a model transaction.
		this._register(addDisposableListener(this.prose, 'dragover', event => {
			if (event.dataTransfer?.types.includes('Files') && !this.readOnly) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; }
		}));
		this._register(addDisposableListener(this.prose, 'drop', event => {
			event.preventDefault();
			const files = [...(event.dataTransfer?.files ?? [])];
			if (!files.length || this.readOnly) return;
			const caret = document.caretRangeFromPoint(event.clientX, event.clientY);
			if (caret && this.prose.contains(caret.startContainer)) {
				const offset = this.point(caret.startContainer, caret.startOffset);
				this.selection = { start: offset, end: offset };
				this.prose.focus(); this.restoreSelection();
			}
			void this.insertImages(() => Promise.all(files.map(readArkdownImageFile))).catch(this.onError);
		}));
		this._register(addDisposableListener(this.prose, 'compositionstart', () => {
			this.renderedVersion = -1;
			this.resetProjection = true;
			this.composition = { range: this.readSelection(), version: model.getVersionId(), table: this.pendingTableComposition };
			this.pendingTableComposition = undefined;
		}));
		this._register(addDisposableListener(this.prose, 'compositionend', event => this.finishComposition((event as CompositionEvent).data)));
		this._register(addDisposableListener(this.prose, 'paste', event => {
			event.preventDefault();
			if (!this.readOnly) {
				const files = [...((event as ClipboardEvent).clipboardData?.files ?? [])];
				if (files.length) { void this.insertImages(() => Promise.all(files.map(readArkdownImageFile))).catch(this.onError); return; }
				this.insertText(this.readSelection(), (event as ClipboardEvent).clipboardData?.getData('text/plain') ?? '');
			}
		}));
		this._register(addDisposableListener(this.prose, 'cut', event => {
			if (this.readOnly) return;
			if (this.selectedImage) { event.preventDefault(); void this.selectedImage.cut().catch(this.onError); return; }
			const range = this.readSelection();
			if (range.start === range.end) return;
			event.preventDefault();
			(event as ClipboardEvent).clipboardData?.setData('text/plain', document.defaultView?.getSelection()?.toString() ?? '');
			this.replace(range, '', true);
		}));
		this._register(addDisposableListener(this.prose, 'copy', event => { if (this.selectedImage) { event.preventDefault(); void this.selectedImage.copy().catch(this.onError); } }));
		this._register(addDisposableListener(this.prose, 'click', event => {
			const link = (event.target as Element).closest?.('a[data-href]');
			if (link && (event.ctrlKey || event.metaKey)) { event.preventDefault(); this.openLink(link.getAttribute('data-href')!); }
			const id = (event.target as Element).closest<HTMLElement>('[data-comment-id]')?.dataset.commentId;
			if (id && this.comments.snapshot.threads.some(thread => thread.id === id)) this.commentRequested.fire({ threadId: id });
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
		const changed = this.readOnly !== value;
		this.readOnly = value;
		this.prose.contentEditable = String(!value);
		this.prose.setAttribute('aria-readonly', String(value));
		this.sourceEditor?.updateOptions({ readOnly: value });
		for (const select of this.prose.querySelectorAll<HTMLSelectElement>('select[data-arkdown-dropdown]')) select.disabled = value;
		for (const root of this.renderedRoots) for (const checkbox of root.checkboxes) checkbox.enabled = !value;
		for (const image of this.prose.querySelectorAll<HTMLElement>('.ash-arkdown-image')) this.imageWidgets.get(image)?.update();
		if (changed) this.tables.update();
	}
	setMode(mode: DocsEditorMode): void { this.tables.close(); this.selection = this.readSelection(); this.mode = mode; this.render(false); this.modeChanged.fire(this.mode); this.focus(); }
	getMode(): DocsEditorMode { return this.mode; }
	get selectedImage(): ArkdownImage | undefined {
		const frame = this.prose.querySelector<HTMLElement>('.ash-arkdown-image.selected');
		const range = frame && this.ranges.get(frame);
		return frame && range?.start === this.selection.start && range.end === this.selection.end ? this.imageWidgets.get(frame) : undefined;
	}
	get isPageWide(): boolean { return this.pageWide; }
	togglePageWidth(): void {
		this.pageWide = !this.pageWide;
		this.prose.classList.toggle('wide', this.pageWide);
		this.selectionChanged.fire();
	}
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
			if (node.nodeName === 'INPUT' && (node as HTMLInputElement).type === 'checkbox') return (node as HTMLInputElement).checked ? '[x] ' : '[ ] ';
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
	selectAll(): void {
		this.tables.close();
		if (this.mode === 'rich') this.prose.focus({ preventScroll: true });
		this.selection = { start: 0, end: this.model.getValueLength() }; this.restoreSelection();
	}
	undo(): void { if (!this.readOnly && !this.composition) { this.tables.close(); this.model.undo(); } }
	redo(): void { if (!this.readOnly && !this.composition) { this.tables.close(); this.model.redo(); } }
	getSelectedText(): string {
		if (this.tables.hasCellSelection) return this.tables.getSelectedText() ?? '';
		const range = this.readSelection(); return this.model.getValue().slice(range.start, range.end);
	}
	captureCommentSelection(): DocsCommentDraft | undefined {
		if (this.mode !== 'rich' || this.tables.hasCellSelection) return undefined;
		return this.comments.capture(this.readSelection(), this.prose.ownerDocument.defaultView?.getSelection()?.toString() ?? '');
	}
	requestComment(): void {
		if (this.tables.hasCellSelection) { this.commentRequested.fire({ focus: true }); return; }
		const range = this.readSelection();
		const id = range.start === range.end ? [...this.comments.snapshot.anchors].find(([, anchor]) => anchor.range.start <= range.start && anchor.range.end >= range.end)?.[0] : undefined;
		this.commentRequested.fire(id ? { threadId: id, focus: true } : { draft: this.captureCommentSelection(), focus: true });
	}
	setActiveComment(id: string | undefined): void {
		this.activeComment = id;
		const open = new Set(this.comments.snapshot.threads.filter(thread => thread.state === DocsCommentState.Open).map(thread => thread.id));
		for (const anchor of this.prose.querySelectorAll<HTMLElement>('[data-comment-id]')) {
			anchor.classList.toggle('ash-arkdown-comment', open.has(anchor.dataset.commentId!));
			anchor.classList.toggle('ash-arkdown-comment-active', anchor.dataset.commentId === id);
		}
	}
	revealComment(id: string): void {
		const anchor = this.comments.snapshot.anchors.get(id);
		if (!anchor) return;
		if (this.mode !== 'rich') this.setMode('rich');
		this.setActiveComment(id);
		this.prose.querySelector<HTMLElement>(`[data-comment-id="${id}"]`)?.scrollIntoView({ block: 'nearest' });
	}
	/** Viewport geometry for a live rich-text selection; the editor retains ownership of its DOM. */
	getSelectionBounds(): DOMRect | undefined {
		const selection = this.prose.ownerDocument.defaultView?.getSelection();
		if (this.mode !== 'rich' || this.readOnly || this.composition) return undefined;
		if (this.selectedImage) {
			const bounds = this.selectedImage.domNode.getBoundingClientRect(), viewport = this.prose.getBoundingClientRect();
			return bounds.bottom > viewport.top && bounds.top < viewport.bottom ? bounds : undefined;
		}
		if (this.tables.hasCellSelection) return this.tables.getSelectionBounds();
		if (!this.containsSelection() || !selection?.rangeCount || selection.isCollapsed || !selection.toString().trim()) return undefined;
		const selected = selection.getRangeAt(0), source = this.readSelection(), rectangles: DOMRect[] = [];
		// A cross-block DOM range can include checkbox and block rectangles. Use
		// its selected text fragments to anchor the toolbar to the visible words.
		for (const segment of this.segments) {
			if (segment.kind !== 'text' || !segment.text.length || segment.offsets[0] > source.end || segment.offsets.at(-1)! < source.start || !selected.intersectsNode(segment.text)) continue;
			const start = selected.startContainer === segment.text ? selected.startOffset : 0;
			const end = selected.endContainer === segment.text ? selected.endOffset : segment.text.length;
			if (start === end) continue;
			const fragment = this.prose.ownerDocument.createRange();
			fragment.setStart(segment.text, start); fragment.setEnd(segment.text, end);
			for (const rectangle of fragment.getClientRects()) if (rectangle.width && rectangle.height) rectangles.push(rectangle);
		}
		if (!rectangles.length) return undefined;
		const bounds = { left: Math.min(...rectangles.map(rectangle => rectangle.left)), right: Math.max(...rectangles.map(rectangle => rectangle.right)), top: Math.min(...rectangles.map(rectangle => rectangle.top)), bottom: Math.max(...rectangles.map(rectangle => rectangle.bottom)) };
		const viewport = this.prose.getBoundingClientRect();
		const left = Math.max(bounds.left, viewport.left), right = Math.min(bounds.right, viewport.right);
		const top = Math.max(bounds.top, viewport.top), bottom = Math.min(bounds.bottom, viewport.bottom);
		if (right <= left || bottom <= top) return undefined;
		return new DOMRect(left, top, right - left, bottom - top);
	}
	get hasTableSelection(): boolean { return this.tables.hasCellSelection; }
	getSelectionFormatting(): { readonly bold: boolean; readonly italic: boolean; readonly strikethrough: boolean; readonly code: boolean; readonly underline: boolean; readonly highlight: boolean; readonly mixedHighlight: boolean; readonly textColor: ArkdownTextColor | 'mixed' | undefined; readonly heading: number; readonly list?: 'bullet' | 'ordered' | 'task'; } {
		const cells = this.tables.selectedCells;
		const range = cells.length ? { start: cells[0].range.start, end: cells.at(-1)!.range.end } : this.readSelection();
		type Format = { bold: boolean; italic: boolean; strikethrough: boolean; code: boolean; underline: boolean; highlight: boolean; color?: ArkdownTextColor; heading: number; list?: 'bullet' | 'ordered' | 'task'; };
		const initial: Format = { bold: false, italic: false, strikethrough: false, code: false, underline: false, highlight: false, heading: 0 };
		const marks: Format[] = [];
		const metadata = this.comments.snapshot.metadataRanges;
		let caret = initial;
		const visit = (nodes: readonly ArkdownNode[], inherited: Format): void => {
			for (const node of nodes) {
				if (node.range.start > range.end || node.range.end < range.start
					|| (range.start !== range.end && (node.range.start === range.end || node.range.end === range.start))) continue;
				if (node.kind === 'code_block' && metadata.some(value => value.start === node.range.start)) continue;
				const state = { ...inherited };
				if (node.kind === 'strong') state.bold = true;
				if (node.kind === 'emphasis') state.italic = true;
				if (node.kind === 'strikethrough') state.strikethrough = true;
				if (node.kind === 'code') state.code = true;
				if (node.kind === 'underline') state.underline = true;
				if (node.kind === 'highlight') state.highlight = true;
				if (node.kind === 'text_color') state.color = node.color;
				if (node.kind === 'heading') state.heading = node.level ?? 0;
				if (node.kind === 'list') state.list = node.start === undefined ? 'bullet' : 'ordered';
				if (node.kind === 'item' && this.taskMarker(node)) state.list = 'task';
				if (range.start === range.end) caret = state;
				if (node.kind === 'image' || node.kind === 'raw_html') continue;
				if (node.children.length) visit(node.children, state);
				else if (node.text !== undefined && (!cells.length || node.text.length > 0)) marks.push(state);
			}
		};
		if (this.mode === 'rich') visit(cells.length ? cells : this.syntax, initial);
		const states = marks.length ? marks : [caret];
		return {
			bold: states.every(state => state.bold), italic: states.every(state => state.italic),
			strikethrough: states.every(state => state.strikethrough), code: states.every(state => state.code),
			heading: states.every(state => state.heading === states[0].heading) ? states[0].heading : 0,
			// Item-derived state remains meaningful when a selection spans siblings.
			list: states.every(state => state.list === states[0].list) ? states[0].list : undefined,
			underline: states.every(state => state.underline), highlight: states.every(state => state.highlight),
			mixedHighlight: states.some(state => state.highlight) && states.some(state => !state.highlight),
			textColor: states.every(state => state.color === states[0].color) ? states[0].color : 'mixed',
		};
	}
	setTextColor(color: ArkdownTextColor | undefined): void { this.setInlineFormat({ kind: 'text_color', color }); }
	setHighlight(active: boolean): void { this.setInlineFormat({ kind: 'highlight', active }); }
	toggleUnderline(): void { this.setInlineFormat({ kind: 'underline', active: !this.getSelectionFormatting().underline }); }
	private setInlineFormat(format: ArkdownInlineFormat): void {
		if (this.readOnly || this.composition || this.mode !== 'rich') return;
		if (this.tables.hasCellSelection) { this.formatTableSelection(format); return; }
		const edit = formatArkdownInline(this.model.getValue(), this.syntax, this.readSelection(), format);
		if (edit) this.replace(edit.range, edit.text, true, edit.selection);
	}
	canIndentList(direction: 'increase' | 'decrease'): boolean {
		if (this.readOnly || this.composition || this.mode !== 'rich' || this.tables.hasCellSelection) return false;
		const range = this.readSelection();
		const version = this.model.getVersionId();
		// Scrolling and menu placement do not need to repeat source-level proposals.
		if (this.indentationCapabilities?.version !== version || this.indentationCapabilities.start !== range.start || this.indentationCapabilities.end !== range.end) {
			this.indentationCapabilities = { version, ...range };
		}
		const cached = this.indentationCapabilities[direction];
		if (cached !== undefined) return cached;
		let enabled = false;
		try { enabled = this.runtime.operation(this.model.getValue(), { kind: 'indent_list', offset: range.start, end: range.end, direction }).length > 0; }
		catch { /* Unsupported list structures keep the command disabled. */ }
		return this.indentationCapabilities[direction] = enabled;
	}
	indentList(direction: 'increase' | 'decrease'): void {
		const range = this.readSelection();
		this.structure({ kind: 'indent_list', offset: range.start, end: range.end, direction });
	}
	setHeading(level: number): void { if (!this.tables.hasCellSelection) this.structure({ kind: 'set_heading', offset: this.readSelection().start, level }); }
	setListKind(list: 'bullet' | 'ordered' | 'task'): void { if (!this.tables.hasCellSelection) this.structure({ kind: 'set_list_kind', offset: this.readSelection().start, list }); }
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

	/** File decoding can outlive typing. A model-owned marker tracks the insertion
	 * boundary without keeping a second document or writing to a different editor. */
	async insertImages(read: () => Promise<readonly ArkdownImageSource[] | undefined>): Promise<void> {
		if (this.readOnly || this.composition || this.mode !== 'rich' || this.tables.hasCellSelection) return;
		const range = this.readSelection();
		const offset = this.parseSyntax().find(node => node.range.start <= range.end && node.range.end >= range.end)?.range.end ?? range.end;
		const position = this.model.getPositionAt(offset);
		const [marker] = this.model.deltaDecorations([], [{ range: Range.fromPositions(position), options: { description: 'arkdown-image-insertion', stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges } }]);
		try {
			const images = await read();
			if (!images?.length || this.isDisposed || this.readOnly || this.composition || this.mode !== 'rich') return;
			const target = this.model.getDecorationRange(marker);
			if (!target) return;
			const insertAt = this.model.getOffsetAt(target.getStartPosition());
			const before = this.model.getValue().slice(0, insertAt);
			const prefix = !before || /(?:\r?\n){2}$/u.test(before) ? '' : before.endsWith('\n') ? '\n' : '\n\n';
			const markdown = images.map(image => writeArkdownImage(image)).join('\n\n');
			this.replace({ start: insertAt, end: insertAt }, prefix + markdown + '\n\n', true);
		} finally { if (!this.model.isDisposed()) this.model.deltaDecorations([marker], []); }
	}

	format(mark: '**' | '_' | '~~' | '`'): void {
		if (this.readOnly || this.composition) return;
		if (this.tables.hasCellSelection) {
			const state = this.getSelectionFormatting();
			const kind = { '**': 'strong', '_': 'emphasis', '~~': 'strikethrough', '`': 'code' } as const;
			const active = { '**': state.bold, '_': state.italic, '~~': state.strikethrough, '`': state.code };
			this.formatTableSelection({ kind: kind[mark], active: !active[mark] });
			return;
		}
		const range = this.readSelection();
		const text = this.model.getValue();
		if (mark === '`') {
			const findCode = (nodes: readonly ArkdownNode[]): ArkdownNode | undefined => {
				for (const node of nodes) {
					if (node.range.start > range.start || node.range.end < range.end) continue;
					if (node.kind === 'code') return node;
					const found = findCode(node.children);
					if (found) return found;
				}
				return undefined;
			};
			const code = findCode(this.syntax);
			if (code?.text !== undefined) {
				const plain = escapeProseText(code.text);
				this.replace(code.range, plain, true, { start: code.range.start, end: code.range.start + plain.length });
				return;
			}
		}
		if (range.start === range.end) {
			// Empty emphasis has no editable text node. Select a valid snippet label
			// so the next input replaces it, as in the Markdown editor's format snippets.
			const label = mark === '**' ? localize({ bundle: 'ash.arkdown', key: 'bold' }, 'Bold')
				: mark === '_' ? localize({ bundle: 'ash.arkdown', key: 'italic' }, 'Italic')
					: mark === '~~' ? localize({ bundle: 'ash.docs', key: 'strikethrough' }, 'Strikethrough')
						: localize({ bundle: 'ash.docs', key: 'inlineCode' }, 'Inline code');
			this.replace(range, mark + label + mark, true, { start: range.start + mark.length, end: range.start + mark.length + label.length });
			return;
		}
		if (text.slice(range.start - mark.length, range.start) === mark && text.slice(range.end, range.end + mark.length) === mark) {
			this.replace({ start: range.start - mark.length, end: range.end + mark.length }, text.slice(range.start, range.end), true, { start: range.start - mark.length, end: range.end - mark.length });
		} else {
			// Code spans choose a delimiter longer than any backtick run in the text.
			const content = mark === '`' && this.mode === 'rich' && this.containsSelection()
				? this.prose.ownerDocument.defaultView!.getSelection()!.toString()
				: text.slice(range.start, range.end);
			const longestFence = mark === '`' ? Array.from(content.matchAll(/`+/gu)).reduce((length, match) => Math.max(length, match[0].length), 0) : 0;
			const delimiter = mark === '`' ? '`'.repeat(longestFence + 1) : mark;
			const padding = mark === '`' && (/^`|`$/u.test(content) || (/^ .* $/u.test(content) && content.trim())) ? ' ' : '';
			const prefix = delimiter + padding;
			this.replace(range, prefix + content + padding + delimiter, true, { start: range.start + prefix.length, end: range.start + prefix.length + content.length });
		}
	}

	setLink(url: string): void {
		if (this.readOnly || this.composition || this.tables.hasCellSelection) return;
		const range = this.readSelection();
		if (range.start === range.end) return;
		const text = this.model.getValue().slice(range.start, range.end);
		this.replace(range, `[${text}](<${url}>)`, true, { start: range.start + 1, end: range.end + 1 });
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
		const cell = this.activeTableCell();
		const cellSegments = cell ? this.segments.filter(segment => cell.element.contains(segment.text)) : [];
		const start = cellSegments[0]?.offsets[0], end = cellSegments.at(-1)?.offsets.at(-1);
		switch (event.inputType) {
			case 'insertText': case 'insertReplacementText': this.insertText(range, event.data ?? ''); break;
			case 'insertParagraph': if (cell) this.insertText(range, '\n'); else this.replace(range, '\n\n', true); break;
			case 'insertLineBreak': if (cell) this.insertText(range, '\n'); else this.replace(range, '  \n', true); break;
			case 'deleteContentBackward': case 'deleteContentForward':
				if (range.start === range.end) {
					if (cell?.node.tableCellMissing) break;
					range = event.inputType === 'deleteContentBackward'
						? { start: Math.max(start ?? 0, this.runtime.grapheme(this.model.getValue(), range.start, 'previous')), end: range.end }
						: { start: range.start, end: Math.min(end ?? this.model.getValueLength(), this.runtime.grapheme(this.model.getValue(), range.end, 'next')) };
				}
				this.replace(range, '', true); break;
			case 'deleteWordBackward': case 'deleteWordForward': case 'deleteSoftLineBackward': case 'deleteSoftLineForward': case 'deleteHardLineBackward': case 'deleteHardLineForward': {
				const target = event.getTargetRanges()[0];
				if (target) this.replace({ start: Math.max(start ?? 0, this.point(target.startContainer, target.startOffset)), end: Math.min(end ?? this.model.getValueLength(), this.point(target.endContainer, target.endOffset)) }, '', true);
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
		if ((event.ctrlKey || event.metaKey) && event.altKey && !event.shiftKey && event.code === 'KeyM') {
			event.preventDefault(); event.stopPropagation(); this.requestComment(); return;
		}
		if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key === 'Enter') {
			const offset = this.ranges.get(event.target as Node)?.start ?? this.readSelection().start;
			let marker: ArkdownNode | undefined;
			const visit = (nodes: readonly ArkdownNode[]): void => {
				for (const node of nodes) {
					if (node.range.start > offset || node.range.end < offset) continue;
					if (node.kind === 'item') marker = this.taskMarker(node) ?? marker;
					visit(node.children);
				}
			};
			visit(this.syntax);
			if (marker) {
				event.preventDefault(); event.stopPropagation();
				this.structure({ kind: 'set_task_checked', offset: marker.range.start, checked: !marker.checked });
				return;
			}
		}
		if (event.key === 'Tab' && event.target === this.prose && !event.ctrlKey && !event.metaKey && !event.altKey) {
			if (this.tableTab(event.shiftKey)) { event.preventDefault(); event.stopPropagation(); return; }
			const direction = event.shiftKey ? 'decrease' : 'increase';
			if (this.canIndentList(direction)) { event.preventDefault(); event.stopPropagation(); this.indentList(direction); return; }
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
		if (!['a', 'z', 'y', 'b', 'i', 'u'].includes(key)) return;
		event.preventDefault(); event.stopPropagation();
		if (key === 'a') { this.selectAll(); return; }
		if (this.readOnly) return;
		if (key === 'z') { if (event.shiftKey) this.model.redo(); else this.model.undo(); }
		else if (key === 'y') this.model.redo();
		else if (key === 'u') this.toggleUnderline();
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
			const map = (offset: number): number => {
				let delta = 0;
				for (const edit of edits) {
					if (edit.range.end <= offset) delta += edit.text.length - (edit.range.end - edit.range.start);
					else if (edit.range.start <= offset) return edit.range.start + delta + edit.text.length;
				}
				return offset + delta;
			};
			const after = operation.kind === 'set_task_checked' ? before : ['indent_list', 'set_list_kind', 'set_heading'].includes(operation.kind)
				? { start: map(before.start), end: map(before.end) } : { start: caret, end: caret };
			this.model.pushEditOperations([Selection.fromPositions(this.model.getPositionAt(before.start), this.model.getPositionAt(before.end))], edits.map(edit => ({ range: Range.fromPositions(this.model.getPositionAt(edit.range.start), this.model.getPositionAt(edit.range.end)), text: edit.text })), () => [Selection.fromPositions(this.model.getPositionAt(after.start), this.model.getPositionAt(after.end))]);
			this.model.pushStackElement();
			this.focus();
		} catch (error) { this.onError(new Error(localize({ bundle: 'ash.arkdown', key: 'structureUnavailable' }, 'This structure cannot be changed here. Use Markdown source to edit nested blocks or Setext headings.'), { cause: error })); }
	}

	private tableTab(backwards: boolean): boolean {
		const active = this.activeTableCell();
		if (!active) return false;
		const table = this.getTableNode(active.table);
		if (!table) return false;
		const cells = [...active.table.querySelectorAll<HTMLTableCellElement>('td[data-row], th[data-row]')].filter(cell => !cell.hidden);
		const current = cells.indexOf(active.element);
		if (current < 0) return false;
		const target = cells[current + (backwards ? -1 : 1)];
		if (target) {
			this.setTableCaret(active.table, Number(target.dataset.row), Number(target.dataset.column));
			return true;
		}
		if (backwards || this.readOnly) return false;
		// Legacy append preserves the table's original Markdown spelling. The
		// logical row coordinate also distinguishes virtual cells with equal offsets.
		this.structure({ kind: 'insert_table_row', offset: active.node.range.start });
		const next = [...this.prose.querySelectorAll('table')].find(element => this.ranges.get(element)?.start === table.range.start);
		if (next) this.setTableCaret(next, table.children.length, 0);
		return true;
	}

	private getTableNode(table: HTMLTableElement): ArkdownNode | undefined {
		if (!this.prose.contains(table)) return undefined;
		const range = this.ranges.get(table);
		const find = (nodes: readonly ArkdownNode[]): ArkdownNode | undefined => {
			for (const node of nodes) {
				if (node.kind === 'table' && node.range.start === range?.start) return node;
				const nested = find(node.children);
				if (nested) return nested;
			}
			return undefined;
		};
		return find(this.parseSyntax());
	}

	private activeTableCell(): { table: HTMLTableElement; element: HTMLTableCellElement; node: ArkdownNode; row: number; column: number; } | undefined {
		const focus = this.prose.ownerDocument.defaultView?.getSelection()?.focusNode;
		const element = (focus?.nodeType === Node.ELEMENT_NODE ? focus as Element : focus?.parentElement)?.closest<HTMLTableCellElement>('td[data-row], th[data-row]');
		const table = element?.closest('table');
		if (!element || !table || !this.prose.contains(table)) return undefined;
		const row = Number(element.dataset.row), column = Number(element.dataset.column);
		const node = this.getTableNode(table)?.children[row]?.children[column];
		return node ? { table, element, node, row, column } : undefined;
	}

	private applyTableAction(table: HTMLTableElement, action: ArkdownTableAction, target = { row: 0, column: 0 }): HTMLTableElement | undefined {
		if (this.readOnly || this.composition || this.mode !== 'rich') return table;
		const node = this.getTableNode(table);
		if (!node) return undefined;
		try {
			const edits = this.runtime.operation(this.model.getValue(), { kind: 'table', offset: node.range.start, action });
			if (!edits.length) return table;
			const before = this.readSelection();
			this.model.pushStackElement();
			this.model.pushEditOperations([Selection.fromPositions(this.model.getPositionAt(before.start), this.model.getPositionAt(before.end))], edits.map(edit => ({ range: Range.fromPositions(this.model.getPositionAt(edit.range.start), this.model.getPositionAt(edit.range.end)), text: edit.text })), () => [Selection.fromPositions(this.model.getPositionAt(Math.min(node.range.start, this.model.getValueLength())))]);
			this.model.pushStackElement();
			const next = [...this.prose.querySelectorAll('table')].find(element => this.ranges.get(element)?.start === node.range.start);
			if (next) this.setTableCaret(next, target.row, target.column);
			else this.focus();
			return next;
		} catch (error) {
			this.onError(new Error(localize({ bundle: 'ash.docs', key: 'tableChangeFailed' }, 'The table could not be changed.'), { cause: error }));
			return table;
		}
	}

	private formatTableSelection(format: ArkdownTableCellFormat): void {
		this.tables.applyToSelectedCells((table, cells) => {
			const node = this.getTableNode(table);
			if (!node) return undefined;
			const source = this.model.getValue();
			const edits = this.runtime.validate(source, formatArkdownTableCells(source, cells, format));
			if (!edits.length) return table;
			const before = Selection.fromPositions(this.model.getPositionAt(cells[0].range.start), this.model.getPositionAt(cells.at(-1)!.range.end));
			this.model.pushStackElement();
			this.model.pushEditOperations([before], edits.map(edit => ({ range: Range.fromPositions(this.model.getPositionAt(edit.range.start), this.model.getPositionAt(edit.range.end)), text: edit.text })), () => [Selection.fromPositions(this.model.getPositionAt(node.range.start))]);
			this.model.pushStackElement();
			return [...this.prose.querySelectorAll('table')].find(element => this.ranges.get(element)?.start === node.range.start);
		});
	}

	private tableBlockTarget(table: HTMLTableElement, target: { clientY: number; } | 'previous' | 'next'): ArkdownTableBlockTarget | undefined {
		const node = this.getTableNode(table);
		if (!node || !this.parseSyntax().some(root => root.kind === 'table' && root.range.start === node.range.start)) return undefined;
		const blocks = this.renderedRoots.flatMap(root => {
			const elements = root.dom.filter((element): element is HTMLElement => element instanceof this.prose.ownerDocument.defaultView!.HTMLElement);
			const bounds = elements.map(element => element.getBoundingClientRect()).filter(bounds => bounds.height > 0);
			return bounds.length ? [{ range: root.range, top: Math.min(...bounds.map(bounds => bounds.top)), bottom: Math.max(...bounds.map(bounds => bounds.bottom)) }] : [];
		});
		const current = blocks.findIndex(block => block.range.start === node.range.start);
		if (current < 0) return undefined;
		let block = blocks[current], after = false;
		if (typeof target === 'string') {
			const sibling = blocks[current + (target === 'previous' ? -1 : 1)];
			if (!sibling) return undefined;
			block = sibling; after = target === 'next';
		} else {
			block = blocks.find(block => target.clientY < (block.top + block.bottom) / 2) ?? blocks[blocks.length - 1];
			after = target.clientY >= (block.top + block.bottom) / 2;
		}
		const offset = after ? block.range.end : block.range.start;
		if (offset >= node.range.start && offset <= node.range.end) return undefined;
		const bounds = this.prose.getBoundingClientRect();
		return { offset, left: bounds.left, top: after ? block.bottom : block.top, width: bounds.width };
	}

	private moveTableBlock(table: HTMLTableElement, offset: number): HTMLTableElement | undefined {
		if (this.readOnly || this.composition || this.mode !== 'rich') return table;
		const node = this.getTableNode(table);
		if (!node || (offset >= node.range.start && offset <= node.range.end)) return table;
		try {
			const source = this.model.getValue(), raw = source.slice(node.range.start, node.range.end), eol = this.model.getEOL();
			const before = source.slice(0, offset), after = source.slice(offset);
			// Block separators belong to the insertion boundary. Keep the table's
			// exact source, including its layout and comment anchors, intact.
			const prefix = !before || before.endsWith(eol + eol) ? '' : before.endsWith(eol) ? eol : eol + eol;
			const suffix = !after || raw.endsWith(eol + eol) || (raw.endsWith(eol) && after.startsWith(eol)) ? '' : raw.endsWith(eol) || after.startsWith(eol) ? eol : eol + eol;
			const edits = this.runtime.validate(source, [{ range: node.range, text: '' }, { range: { start: offset, end: offset }, text: prefix + raw + suffix }]);
			const start = offset + prefix.length - (offset > node.range.end ? raw.length : 0);
			this.model.pushStackElement();
			this.model.pushEditOperations([Selection.fromPositions(this.model.getPositionAt(node.range.start))], edits.map(edit => ({ range: Range.fromPositions(this.model.getPositionAt(edit.range.start), this.model.getPositionAt(edit.range.end)), text: edit.text })), () => [Selection.fromPositions(this.model.getPositionAt(start))]);
			this.model.pushStackElement();
			const next = [...this.prose.querySelectorAll('table')].find(element => this.ranges.get(element)?.start === start);
			if (next) this.setTableCaret(next, 0, 0);
			return next;
		} catch (error) {
			this.onError(new Error(localize({ bundle: 'ash.docs', key: 'tableChangeFailed' }, 'The table could not be changed.'), { cause: error }));
			return table;
		}
	}

	private setTableCaret(table: HTMLTableElement, row: number, column: number): void {
		const node = this.getTableNode(table);
		if (!node) return;
		row = Math.max(0, Math.min(row, node.children.length - 1));
		column = Math.max(0, Math.min(column, (node.children[0]?.children.length ?? 1) - 1));
		const merged = node.tableLayout?.cells.find(cell => row >= cell.row && row < cell.row + cell.rowspan && column >= cell.column && column < cell.column + cell.colspan);
		const cell = table.querySelector<HTMLElement>(`[data-row="${merged?.row ?? row}"][data-column="${merged?.column ?? column}"]`);
		const segment = cell && this.segments.find(value => cell.contains(value.text));
		if (!segment) return;
		this.selection = { start: segment.offsets[0], end: segment.offsets[0] };
		this.prose.focus({ preventScroll: true });
		this.prose.ownerDocument.defaultView?.getSelection()?.setBaseAndExtent(segment.text, 0, segment.text, 0);
		cell?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
		this.selectionChanged.fire();
	}

	private finishComposition(text: string): void {
		const composition = this.composition;
		this.composition = undefined;
		if (!composition) return;
		if (composition.version !== this.model.getVersionId() || this.readOnly || !text) { this.render(this.hasFocus()); return; }
		this.skipCompositionInput = text;
		if (composition.table) {
			const rectangle = composition.table;
			const table = [...this.prose.querySelectorAll('table')].find(element => this.ranges.get(element)?.start === rectangle.offset);
			if (!table) { this.render(this.hasFocus()); return; }
			// IME cancellation never clears a rectangle, and a committed composition
			// replaces it through one source transaction and one undo entry.
			const values = Array.from({ length: rectangle.bottom - rectangle.top + 1 }, (_, row) => Array.from({ length: rectangle.right - rectangle.left + 1 }, (_, column) => row === 0 && column === 0 ? text : ''));
			this.applyTableAction(table, { kind: 'paste_cells', row: rectangle.top, column: rectangle.left, values }, { row: rectangle.top, column: rectangle.left });
			return;
		}
		this.insertText(composition.range, text);
	}

	private insertText(range: ArkdownRange, text: string): void {
		const cell = this.activeTableCell();
		if (cell?.node.tableCellMissing && range.start === range.end) {
			this.applyTableAction(cell.table, { kind: 'paste_cells', row: cell.row, column: cell.column, values: [[text]] }, cell);
			return;
		}
		const code = this.findCodeAt(range);
		if (cell && range.start >= cell.node.range.start && range.end <= cell.node.range.end && code?.kind !== 'code') {
			const escaped = escapeProseText(text).replace(/&/gu, '&amp;').replace(/\|/gu, '\\|').replace(/\r\n?|\n/gu, '&#10;').replace(/\t/gu, '&#9;');
			this.replace(range, escaped, true);
			return;
		}
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
		this.replace(range, escapeProseText(text), true);
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

	layout(dimension: IDimension): void { this.sourceEditor?.layout({ width: this.source.clientWidth || dimension.width, height: this.source.clientHeight || dimension.height }); this.tables.update(); }

	private render(focus: boolean): void {
		try {
			if (this.mode === 'rich') this.renderProse();
		} catch (error) {
			this.resetProjection = true;
			this.mode = 'markdown';
			this.modeChanged.fire(this.mode);
			this.onError(new Error(localize({ bundle: 'ash.arkdown', key: 'arkdownSourceFallback' }, 'The document could not be formatted. Markdown source is available for editing.'), { cause: error }));
		}
		const sourceWasHidden = this.source.hidden;
		this.prose.hidden = this.mode !== 'rich';
		this.source.hidden = this.mode !== 'markdown';
		if (this.mode === 'markdown' && (sourceWasHidden || !this.sourceEditor)) this.ensureSourceEditor().layout({ width: this.source.clientWidth, height: this.source.clientHeight });
		this.setReadOnly(this.readOnly);
		this.setActiveComment(this.activeComment);
		this.renderRemoteHighlights();
		if (this.mode === 'rich') this.tables.update();
		else this.tables.close();
		if (focus) this.focus();
		this.selectionChanged.fire();
	}

	private renderProse(): void {
		if (this.renderedVersion === this.model.getVersionId()) return;
		const source = this.model.getValue();
		// Parse before discarding the previous projection; source remains available on failure.
		const nodes = this.parseSyntax();
		if (this.resetProjection) {
			this.rootLifetimes.clear();
			this.renderedRoots = [];
			this.resetProjection = false;
		}
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
		for (const root of old.slice(prefix, old.length - suffix)) {
			this.rootLifetimes.delete(root.lifetime);
			// DisposableStore.delete transfers ownership; removed projections must
			// release their listeners before a retained menu can run an old action.
			root.lifetime.dispose();
			for (const node of root.dom) node.parentNode?.removeChild(node);
		}
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
				const segments = delta ? reused.segments.map(segment => ({ ...segment, offsets: segment.offsets.map(offset => offset + delta) })) : reused.segments;
				next.push({ ...reused, range: node.range, segments });
				continue;
			}
			const container = this.domNode.ownerDocument.createElement('div');
			const start = this.segments.length;
			const lifetime = this.rootLifetimes.add(new DisposableStore());
			const checkboxes: Checkbox[] = [];
			try { this.renderNode(container, node, source, lifetime, checkboxes); }
			catch (error) { this.rootLifetimes.delete(lifetime); lifetime.dispose(); throw error; }
			const dom = Array.from(container.childNodes);
			const anchor = suffix ? old[old.length - suffix].dom[0] : null;
			for (const child of dom) this.prose.insertBefore(child, anchor);
			next.push({ ...descriptions[index], range: node.range, dom, segments: this.segments.slice(start), lifetime, checkboxes });
		}
		this.renderedRoots = next;
		this.segments.length = 0;
		for (const root of next) for (const segment of root.segments) this.segments.push(segment);
		// Keep an editable caret target after atomic blocks and terminal empty paragraphs.
		const metadata = this.comments.snapshot.trailingMetadataStart;
		if (!this.segments.some(segment => segment.kind === 'text') || /(?:\r?\n){2}$/u.test(source) || metadata !== undefined) {
			this.terminal = h(this.domNode.ownerDocument, 'p');
			const offset = metadata !== undefined ? Math.max(0, metadata - this.model.getEOL().length) : source.length;
			const data = metadata === undefined ? null : [...this.prose.querySelectorAll('.ash-arkdown-comments-data')].find(node => this.ranges.get(node)?.start === metadata) ?? null;
			this.prose.insertBefore(this.terminal, data);
			this.leaf(this.terminal, '', { start: offset, end: offset }, source);
		}
		this.renderedVersion = this.model.getVersionId();
	}

	private parseSyntax(): readonly ArkdownNode[] {
		if (this.parsedVersion !== this.model.getVersionId()) {
			this.syntax = this.projection.parse(this.model.getValue());
			this.parsedVersion = this.model.getVersionId();
		}
		return this.syntax;
	}

	private renderNode(parent: HTMLElement, node: ArkdownNode, source: string, lifetime: DisposableStore, checkboxes: Checkbox[]): void {
		if (node.kind === 'table') {
			this.renderTable(parent, node, source, lifetime, checkboxes);
			return;
		}
		const marker = node.kind === 'item' ? this.taskMarker(node) : undefined;
		if (marker) {
			this.renderTaskItem(parent, node, marker, source, lifetime, checkboxes);
			return;
		}
		if (node.kind === 'code_block') {
			if (this.comments.snapshot.metadataRanges.some(range => range.start === node.range.start)) {
				const metadata = h(parent.ownerDocument, 'span', { className: 'ash-arkdown-comments-data', attributes: { hidden: '', contenteditable: 'false' } });
				this.ranges.set(metadata, node.range);
				parent.append(metadata);
				return;
			}
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
				this.atomic(parent, block, node.range, source);
				return;
			}
		}
		if (node.kind === 'image' && node.destination && isArkdownImageSource(node.destination)) {
			const description = (children: readonly ArkdownNode[]): string => children.map(child => child.text ?? description(child.children)).join('');
			const layout = readArkdownImageLayout(node.title);
			const data = { source: node.destination, description: description(node.children), title: layout.title };
			const image: ArkdownImage = lifetime.add(this.instantiation.createInstance(ArkdownImage, parent, data.source, data.description, layout, {
				canEdit: () => !this.readOnly && !this.composition && this.mode === 'rich',
				select: () => {
					const range = this.ranges.get(image.domNode); if (!range) return;
					this.tables.close(); this.selection = range;
					const selection = parent.ownerDocument.createRange(); selection.selectNode(image.domNode);
					const native = parent.ownerDocument.defaultView!.getSelection()!; native.removeAllRanges(); native.addRange(selection);
					this.selectionChanged.fire();
				},
				leave: () => { const range = this.ranges.get(image.domNode); if (range) { this.selection = { start: range.end, end: range.end }; this.focus(); this.restoreSelection(); } },
				change: (nextLayout: ArkdownImageLayout, nextDescription?: string) => {
					const range = this.ranges.get(image.domNode); if (!range) return;
					this.replace(range, writeArkdownImage({ ...data, description: nextDescription ?? data.description }, nextLayout), true);
					for (const frame of this.prose.querySelectorAll<HTMLElement>('.ash-arkdown-image')) if (this.ranges.get(frame)?.start === range.start) { this.imageWidgets.get(frame)?.focus(); break; }
				},
				remove: () => { const range = this.ranges.get(image.domNode); if (range) this.replace(range, '', true); },
				onError: this.onError,
				changed: () => this.selectionChanged.fire(),
			}));
			this.imageWidgets.set(image.domNode, image);
			// The widget's frame is the atomic source range, including its resize title.
			image.domNode.remove(); this.atomic(parent, image.domNode, node.range, source);
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
		const tags: Record<string, string> = { paragraph: 'p', strong: 'strong', emphasis: 'em', strikethrough: 's', underline: 'u', highlight: 'mark', block_quote: 'blockquote', code_block: 'pre', list: node.start === undefined ? 'ul' : 'ol', item: 'li', table: 'table', table_head: 'thead', table_row: 'tr', table_cell: 'td', link: 'a', rule: 'hr', footnote_definition: 'aside' };
		if (node.kind === 'soft_break' || node.kind === 'hard_break') { this.leaf(parent, '\n', node.range, source); return; }
		if (node.kind === 'task_list_marker') return;
		const header = node.kind === 'table_cell' && parent.dataset.tableHeader === 'true';
		const tag = node.kind === 'heading' ? `h${Math.max(1, Math.min(6, node.level!))}` : header ? 'th' : tags[node.kind] ?? 'span';
		const element = this.domNode.ownerDocument.createElement(tag);
		this.ranges.set(element, node.range);
		if (header) element.setAttribute('scope', 'col');
		if (node.kind === 'text_color' && node.color) element.classList.add(`ash-arkdown-text-${node.color}`);
		if (node.kind === 'comment' && node.threadId) element.dataset.commentId = node.threadId;
		if (node.kind === 'list' && node.start !== undefined) element.setAttribute('start', String(node.start));
		if (node.kind === 'list' && node.children.length && node.children.every(child => this.taskMarker(child))) element.classList.add('ash-arkdown-task-list');
		if (node.kind === 'link' && node.destination && /^(?:https?:|mailto:)/iu.test(node.destination)) element.setAttribute('data-href', node.destination);
		if (node.kind === 'rule') element.contentEditable = 'false';
		parent.append(element);
		if (node.kind === 'table_head') { const row = h(parent.ownerDocument, 'tr'); element.append(row); for (const child of node.children) this.renderNode(row, child, source, lifetime, checkboxes); }
		else for (const child of node.children) this.renderNode(element, child, source, lifetime, checkboxes);
		if (node.kind === 'table_cell' && !node.children.length) {
			this.leaf(element, '', { start: node.range.start, end: node.range.start }, source);
			// Empty cells still need a native line box for a visible caret and a
			// full-height row. The break is a projection placeholder, never source.
			element.append(this.domNode.ownerDocument.createElement('br'));
		}
		// Markdown parsers omit terminal spaces; retain a DOM caret target for live typing.
		if (node.kind === 'paragraph' || node.kind === 'heading') {
			const start = node.children.at(-1)?.range.end ?? node.range.start;
			const tail = source.slice(start, node.range.end).match(/^[ \t]+(?=\r?\n?$)/u)?.[0];
			if (tail) this.leaf(element, tail, { start, end: start + tail.length }, source);
		}
	}

	private renderTable(parent: HTMLElement, node: ArkdownNode, source: string, lifetime: DisposableStore, checkboxes: Checkbox[]): void {
		const document = parent.ownerDocument;
		const scroll = h(document, 'div', { className: 'ash-arkdown-table' });
		const table = h(document, 'table');
		this.ranges.set(scroll, node.range);
		this.ranges.set(table, node.range);
		const columns = node.children[0]?.children.length ?? 0;
		const widths = node.tableLayout?.widths ?? [];
		const { attributes, covered } = mapTableCells(node);
		const colgroup = h(document, 'colgroup');
		for (let column = 0; column < columns; column++) {
			const col = h(document, 'col');
			if (widths[column]) col.style.width = `${widths[column]}px`;
			colgroup.append(col);
		}
		table.append(colgroup);
		// A single row group lets merged cells span the visible header boundary.
		// Native th/scope semantics still identify an enabled header row.
		const body = h(document, 'tbody');
		this.ranges.set(body, node.range);
		table.append(body);
		for (const [rowIndex, row] of node.children.entries()) {
			const tr = h(document, 'tr');
			tr.dataset.tableHeader = String(rowIndex === 0 && node.tableLayout?.header !== false);
			this.ranges.set(tr, row.range);
			body.append(tr);
			for (const [column, cell] of row.children.entries()) {
				this.renderNode(tr, cell, source, lifetime, checkboxes);
				const element = tr.lastElementChild as HTMLTableCellElement;
				element.dataset.row = String(rowIndex);
				element.dataset.column = String(column);
				const layout = attributes.get(rowIndex * columns + column);
				if (layout) {
					element.rowSpan = layout.rowspan;
					element.colSpan = layout.colspan;
					if (layout.color) element.classList.add(`ash-arkdown-cell-${layout.color}`);
				}
				// Covered source cells retain their text maps for whole-document edits,
				// while only the owning merged cell participates in native table layout.
				element.hidden = covered.has(rowIndex * columns + column);
				if (widths[column]) element.style.maxWidth = 'none';
				const alignment = node.alignments?.[column];
				if (alignment && alignment !== 'none') element.style.textAlign = alignment;
			}
		}
		scroll.append(table);
		parent.append(scroll);
	}

	private taskMarker(node: ArkdownNode): ArkdownNode | undefined {
		return node.children.find(child => child.kind === 'task_list_marker')
			?? node.children.find(child => child.kind === 'paragraph')?.children.find(child => child.kind === 'task_list_marker');
	}

	private renderTaskItem(parent: HTMLElement, node: ArkdownNode, marker: ArkdownNode, source: string, lifetime: DisposableStore, checkboxes: Checkbox[]): void {
		const document = parent.ownerDocument;
		const item = h(document, 'li', { className: 'ash-arkdown-task-item' });
		item.classList.toggle('completed', !!marker.checked);
		this.ranges.set(item, node.range);
		const text = (node: ArkdownNode): string => node.kind === 'list' ? '' : node.text ?? node.children.map(text).join('');
		const name = node.children.map(text).join('').trim();
		const checkbox = lifetime.add(new Checkbox(item, {
			checked: !!marker.checked, disabled: this.readOnly,
			ariaLabel: name ? localize({ bundle: 'ash.arkdown', key: 'taskCheckbox' }, 'Task: {0}', name) : localize({ bundle: 'ash.arkdown', key: 'emptyTask' }, 'Empty task'),
		}));
		checkbox.element.classList.add('ash-arkdown-task-checkbox');
		checkbox.element.contentEditable = 'false';
		checkbox.input.setAttribute('aria-keyshortcuts', 'Control+Enter Meta+Enter');
		this.ranges.set(checkbox.input, marker.range);
		checkboxes.push(checkbox);
		// Pointer clicks retain the text caret; keyboard activation returns to the replacement control.
		lifetime.add(addDisposableListener(checkbox.element, 'mousedown', event => event.preventDefault()));
		lifetime.add(checkbox.onDidChange(checked => {
			const range = this.ranges.get(checkbox.input)!;
			const focused = document.activeElement === checkbox.input;
			checkbox.checked = !!marker.checked;
			this.structure({ kind: 'set_task_checked', offset: range.start, checked });
			if (focused) {
				for (const root of this.renderedRoots) {
					root.checkboxes.find(control => this.ranges.get(control.input)?.start === range.start)?.focus();
				}
			}
		}));
		const content = h(document, 'div', { className: 'ash-arkdown-task-content' });
		item.append(content);
		parent.append(item);
		// Tight Markdown lists omit paragraph nodes. Give their inline content the same row as loose lists.
		const loose = node.children.some(child => child.kind === 'paragraph');
		const paragraph = loose ? undefined : h(document, 'p');
		if (paragraph) content.append(paragraph);
		const start = this.segments.length;
		for (const child of node.children) {
			const block = ['paragraph', 'list', 'code_block', 'block_quote', 'table', 'rule', 'heading'].includes(child.kind);
			this.renderNode(block ? content : paragraph ?? content, child, source, lifetime, checkboxes);
		}
		const target = paragraph ?? content.querySelector('p') ?? h(document, 'p');
		if (!target.parentNode) content.prepend(target);
		if (!this.segments.slice(start).some(segment => target.contains(segment.text))) {
			let caret = marker.range.end;
			while (source[caret] === ' ' || source[caret] === '\t') caret++;
			this.leaf(target, '', { start: caret, end: caret }, source);
		}
	}

	private atomic(parent: HTMLElement, element: HTMLElement, range: ArkdownRange, source: string): void {
		// Empty text boundaries let source positions round-trip around controls
		// without placing a caret inside their non-editable DOM.
		this.leaf(parent, '', { start: range.start, end: range.start }, source, { kind: 'boundary' });
		this.ranges.set(element, range);
		parent.append(element);
		this.leaf(parent, '', { start: range.end, end: range.end }, source, { kind: 'boundary' });
	}

	private leaf(parent: HTMLElement, text: string, range: ArkdownRange, source: string, options?: { readonly literal?: boolean; readonly kind?: Segment['kind']; }): void {
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
		this.segments.push({ kind: options?.kind ?? 'text', text: node, offsets });
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
		if (node === this.prose) {
			if (offset === 0) return 0;
			if (offset === node.childNodes.length) return this.model.getValueLength();
			const range = this.ranges.get(node.childNodes[offset]);
			if (range) return range.start;
		}
		const segment = this.segments.find(segment => segment.text === node);
		if (segment) return segment.offsets[Math.min(offset, segment.offsets.length - 1)];
		const next = node.childNodes[offset];
		if (next) {
			const range = this.ranges.get(next);
			if (range && next.nodeType === Node.ELEMENT_NODE && (next as Element).getAttribute('contenteditable') === 'false') return range.start;
			const found = this.segments.find(segment => next === segment.text || next.contains(segment.text)); if (found) return found.offsets[0];
		}
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
		if (length > 0 && this.selection.start === 0 && this.selection.end === length) {
			// A document selection includes hidden Markdown delimiters and atomic
			// blocks; text-leaf endpoints would silently narrow that source range.
			this.prose.ownerDocument.defaultView?.getSelection()?.setBaseAndExtent(this.prose, 0, this.prose, this.prose.childNodes.length);
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
		// Restoring a DOM caret does not reveal it in the table's nested scroll lane.
		if (this.selection.start === this.selection.end && this.hasFocus()) end.parentElement?.closest('td, th')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
	}
	hasFocus(): boolean { return this.mode === 'rich' && this.prose.contains(this.prose.ownerDocument.activeElement); }
	override dispose(): void { this.domNode.remove(); super.dispose(); }
}

function mapTableCells(node: ArkdownNode): { attributes: ReadonlyMap<number, ArkdownTableCellLayout>; covered: ReadonlySet<number>; } {
	const columns = node.alignments?.length ?? node.children[0]?.children.length ?? 0;
	const attributes = new Map<number, ArkdownTableCellLayout>(), covered = new Set<number>();
	for (const cell of node.tableLayout?.cells ?? []) {
		const owner = cell.row * columns + cell.column;
		attributes.set(owner, cell);
		for (let row = cell.row; row < cell.row + cell.rowspan; row++) for (let column = cell.column; column < cell.column + cell.colspan; column++) {
			const index = row * columns + column;
			if (index !== owner) covered.add(index);
		}
	}
	return { attributes, covered };
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

function escapeProseText(text: string): string { return text.replace(/[\\`*_\[\]<>]/gu, '\\$&'); }
