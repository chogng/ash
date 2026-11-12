import { addDisposableListener, getWindow, h, scheduleAtNextAnimationFrame } from '../../../../base/browser/dom.js';
import { appendIcon } from '../../../../base/browser/ui/lxicons/lxicon.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { formatNlsMessage, localize } from '../../../../nls.js';
import { type IDimension } from '../../../common/core/2d/dimension.js';
import { type CodeEditorViewState, type CodeEditorWidget } from '../codeEditor/codeEditorWidget.js';
import { DiffEditorWidget } from '../diffEditor/diffEditorWidget.js';
import { type IDocumentDiffItem } from './model.js';
import { type IWorkbenchUIElementFactory } from './workbenchUIElementFactory.js';
import { Range } from '../../../common/core/range.js';
import type { DiffModel } from '../../../common/diff/diffModel.js';
import type { DiffPreviewLayout } from './compressedVirtualizedScrollLayout.js';
import type { IColorTheme } from '../../../../platform/theme/common/themeService.js';
import { resolveSemanticTokenPresentation } from '../../../common/services/semanticTokensStyling.js';
import { resolveSemanticTokenStyling } from '../../../common/services/semanticTokensProviderStyling.js';
import { AccessibleDiffViewer } from '../diffEditor/components/accessibleDiffViewer.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { MultiDiffReviewPreviewContext } from './multiDiffEditorOptions.js';
import type { TrackedRange } from '../../../common/model/trackedRange.js';
import { TrackedRangeStickiness } from '../../../common/model.js';

export const MULTI_DIFF_HEADER_HEIGHT = 34;
export const MULTI_DIFF_HORIZONTAL_INSET = 18;

export interface DiffEditorItemLayout {
	readonly top: number;
	readonly bodyHeight: number;
	readonly height: number;
}

export interface DiffEditorItemViewState {
	readonly original: CodeEditorViewState | null;
	readonly modified: CodeEditorViewState | null;
	readonly preview?: { readonly side: 'original' | 'modified'; readonly range: Range; };
}

/** Owns one mounted file header and its optional editable diff editor. */
export class DiffEditorItemTemplate extends Disposable {
	public readonly domNode: HTMLElement;
	public readonly editorHostDomNode: HTMLDivElement;
	private readonly toggleDomNode: HTMLButtonElement;
	private readonly bodyDomNode: HTMLDivElement;
	private readonly incompleteStatusDomNode: HTMLSpanElement;
	private readonly editorSlot = this._register(new MutableDisposable<IDisposable & { readonly editor: DiffEditorWidget; }>());
	private readonly modelRetention = this._register(new MutableDisposable<IDisposable>());
	private readonly editorListeners = this._register(new DisposableStore());
	private readonly pendingScrollRestore = this._register(new MutableDisposable<IDisposable>());
	private originalState: CodeEditorViewState | null = null;
	private modifiedState: CodeEditorViewState | null = null;
	private editorHeight = 0;
	private editorLayout: IDimension | undefined;
	private layingOutEditor = false;
	private readonly previewSlot = this._register(new MutableDisposable<ReviewPreview>());
	private previewState: DiffEditorItemViewState['preview'];

	constructor(
		container: HTMLElement,
		public readonly item: IDocumentDiffItem,
		toggle: () => void,
		activate: () => void,
		workbenchUIElementFactory: IWorkbenchUIElementFactory | undefined,
		private readonly onLayoutChange: (() => void) | undefined,
		private readonly onScrollChange: ((source: CodeEditorWidget) => void) | undefined,
		private readonly releaseEditor: (editor: DiffEditorWidget) => void = editor => editor.dispose(),
		onOpenEditor: ((side: 'original' | 'modified', range: Range) => void) | undefined,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();
		const ownerDocument = container.ownerDocument;
		this.domNode = h(ownerDocument, 'section');
		this.domNode.className = 'stanza-multi-diff-editor-section';
		this.domNode.setAttribute('role', 'group');
		this.domNode.setAttribute('aria-label', item.label);
		const headerDomNode = h(ownerDocument, 'div');
		headerDomNode.className = 'stanza-multi-diff-editor-header';
		this.toggleDomNode = h(ownerDocument, 'button');
		this.toggleDomNode.type = 'button';
		this.toggleDomNode.className = 'stanza-multi-diff-editor-header-toggle';
		this.toggleDomNode.setAttribute('aria-expanded', 'true');
		this.toggleDomNode.setAttribute('aria-keyshortcuts', 'ArrowDown ArrowUp Home End');
		const collapsedIconDomNode = h(ownerDocument, 'span');
		collapsedIconDomNode.className = 'stanza-multi-diff-editor-chevron collapsed-icon';
		appendIcon(Lxicon.chevronRight, collapsedIconDomNode);
		const expandedIconDomNode = h(ownerDocument, 'span');
		expandedIconDomNode.className = 'stanza-multi-diff-editor-chevron expanded-icon';
		appendIcon(Lxicon.chevronDown, expandedIconDomNode);
		const titleDomNode = h(ownerDocument, 'span');
		titleDomNode.className = 'stanza-multi-diff-editor-title';
		if (workbenchUIElementFactory?.createResourceLabel) {
			this._register(workbenchUIElementFactory.createResourceLabel(titleDomNode, item));
		} else {
			titleDomNode.textContent = item.label;
		}
		this.toggleDomNode.append(collapsedIconDomNode, expandedIconDomNode, titleDomNode);
		headerDomNode.append(this.toggleDomNode);
		this.incompleteStatusDomNode = h(ownerDocument, 'span');
		this.incompleteStatusDomNode.className = 'stanza-multi-diff-editor-incomplete-status';
		this.incompleteStatusDomNode.setAttribute('role', 'status');
		this.incompleteStatusDomNode.setAttribute('aria-live', 'polite');
		headerDomNode.append(this.incompleteStatusDomNode);
		if (workbenchUIElementFactory || onOpenEditor) {
			const actionsDomNode = h(ownerDocument, 'div');
			actionsDomNode.className = 'stanza-multi-diff-editor-file-actions';
			headerDomNode.append(actionsDomNode);
			if (onOpenEditor) {
				const open = h(ownerDocument, 'button');
				open.type = 'button';
				open.className = 'ash-diff-review-open';
				open.textContent = localize('multiDiff.preview.open', 'Open Full Editor');
				actionsDomNode.append(open);
				this._register(addDisposableListener(open, 'click', () => {
					const location = this.saveViewState().preview;
					const row = item.model?.diff?.rows.get(item.model.diff.hunks[0]?.rowStart ?? 0);
					const side = location?.side ?? (row?.modifiedLineIndex === undefined ? 'original' : 'modified');
					const line = (side === 'original' ? row?.originalLineIndex : row?.modifiedLineIndex) ?? 0;
					onOpenEditor(side, location?.range ?? new Range(line + 1, 1, line + 1, 1));
				}));
			}
			if (workbenchUIElementFactory) this._register(workbenchUIElementFactory.createItemActions(actionsDomNode, item));
		}
		this.bodyDomNode = h(ownerDocument, 'div');
		this.bodyDomNode.className = 'stanza-multi-diff-editor-body';
		this.editorHostDomNode = h(ownerDocument, 'div');
		this.editorHostDomNode.className = 'stanza-multi-diff-editor-item-editor';
		this.bodyDomNode.append(this.editorHostDomNode);
		this.domNode.append(headerDomNode, this.bodyDomNode);
		container.append(this.domNode);
		this._register(toDisposable(() => this.domNode.remove()));
		this._register(addDisposableListener(this.toggleDomNode, 'click', toggle));
		this._register(addDisposableListener(this.domNode, 'focusin', activate));
		this.updateStatus();
	}

	public get editor(): DiffEditorWidget | undefined {
		return this.editorSlot.value?.editor;
	}

	public isHeaderTarget(target: EventTarget | null): boolean {
		return target === this.toggleDomNode;
	}

	public focusHeader(): void {
		this.toggleDomNode.focus({ preventScroll: true });
	}

	public layout(layout: DiffEditorItemLayout, width: number, viewportHeight: number): IDimension {
		this.domNode.style.height = `${layout.height}px`;
		this.domNode.style.top = `${layout.top}px`;
		this.bodyDomNode.style.height = `${layout.bodyHeight}px`;
		this.editorHeight = Math.min(layout.bodyHeight, Math.max(0, viewportHeight - MULTI_DIFF_HEADER_HEIGHT));
		this.editorHostDomNode.style.height = `${this.editorHeight}px`;
		return this.layoutEditor(width);
	}

	public layoutEditor(width: number): IDimension {
		const size = { width: Math.max(0, width), height: this.editorHeight };
		const editor = this.editor;
		if (!editor) {
			return size;
		}
		// Scrolling moves the file template without resizing its editor viewport.
		if (this.editorLayout?.width === size.width && this.editorLayout.height === size.height) {
			return this.editorLayout;
		}
		this.layingOutEditor = true;
		try {
			editor.layout(size);
			this.editorLayout = size;
		} finally {
			this.layingOutEditor = false;
		}
		return size;
	}

	public renderPreview(model: DiffModel, layout: DiffPreviewLayout, scrollTop: number, lineHeight: number, overscan: number,
		font: { readonly family: string; readonly size: number; readonly ligatures: boolean; }, theme: IColorTheme, showInlineChanges: boolean,
		open: (side: 'original' | 'modified', range: Range) => void, reveal: (row: number) => void, expand: (row: number) => void): void {
		let preview = this.previewSlot.value;
		if (!preview) {
			const cursor = this.modifiedState?.cursorState[0];
			const initial = this.previewState ?? (cursor ? { side: 'modified' as const, range: Range.fromPositions(cursor.selectionStart, cursor.position) } : undefined);
			preview = this.previewSlot.value = this.instantiationService.createInstance(ReviewPreview, this.editorHostDomNode, model, open, reveal, expand, initial);
		}
		preview.render(layout, scrollTop, this.editorHeight, lineHeight, overscan, font, theme, showInlineChanges);
	}

	public revealPreviewRow(row: number, focus: boolean): void {
		this.previewSlot.value?.select(row, 'modified', false, focus);
	}

	public focusPreview(): void { this.previewSlot.value?.focus(); }

	public getAccessibleContent(): string | undefined {
		return this.item.unavailableMessage ?? this.previewSlot.value?.getAccessibleContent();
	}

	public retainModel(): void {
		if (!this.modelRetention.value) this.modelRetention.value = this.item.retain?.();
	}

	public mount(editor: DiffEditorWidget, dimension: IDimension, attachEditor?: (editor: DiffEditorWidget) => IDisposable | undefined): void {
		this.editorListeners.clear();
		this.editorSlot.value = Object.assign(toDisposable(() => this.releaseEditor(editor)), { editor });
		this.editorLayout = dimension;
		if (this.onScrollChange) {
			this.editorListeners.add(editor.originalEditor.onDidScrollChange(() => this.onScrollChange?.(editor.originalEditor)));
			this.editorListeners.add(editor.modifiedEditor.onDidScrollChange(() => this.onScrollChange?.(editor.modifiedEditor)));
		}
		if (this.onLayoutChange) {
			// Hidden-region reveal controls change content height without changing the file model.
			let contentHeight = editor.getContentHeight();
			const updateContentHeight = () => {
				const nextHeight = editor.getContentHeight();
				const changed = contentHeight !== nextHeight;
				contentHeight = nextHeight;
				// The outer viewport owns editor dimensions; its own layout must not schedule another pass.
				if (changed && !this.layingOutEditor) this.onLayoutChange?.();
			};
			this.editorListeners.add(editor.onDidContentSizeChange(updateContentHeight));
		}
		this.restoreEditorState();
		const contribution = attachEditor?.(editor);
		if (contribution) this.editorListeners.add(contribution);
	}

	public unmount(): void {
		if (this.previewSlot.value) this.previewState = this.previewSlot.value.location;
		this.previewSlot.clear();
		const editor = this.editor;
		if (!editor) { this.modelRetention.clear(); return; }
		const state = this.saveViewState();
		this.originalState = state.original;
		this.modifiedState = state.modified;
		this.pendingScrollRestore.clear();
		this.editorListeners.clear();
		this.editorSlot.clear();
		this.modelRetention.clear();
	}

	public saveViewState(): DiffEditorItemViewState {
		if (this.editor && this.previewState) {
			const side = this.editor.originalEditor.hasTextFocus() ? 'original' : 'modified';
			const range = this.editor[side === 'original' ? 'originalEditor' : 'modifiedEditor'].getSelection();
			if (range) this.previewState = { side, range };
		}
		const capture = (control: CodeEditorWidget | undefined, saved: CodeEditorViewState | null): CodeEditorViewState | null => {
			const current = control?.saveViewState() ?? saved;
			return current && saved && this.pendingScrollRestore.value
				? { ...current, viewState: { ...current.viewState, scrollLeft: saved.viewState.scrollLeft } }
				: current;
		};
		return {
			original: capture(this.editor?.originalEditor, this.originalState),
			modified: capture(this.editor?.modifiedEditor, this.modifiedState),
			...((this.previewSlot.value?.location ?? this.previewState) ? { preview: this.previewSlot.value?.location ?? this.previewState } : {}),
		};
	}

	public restoreViewState(original: CodeEditorViewState | null, modified: CodeEditorViewState | null, preview?: DiffEditorItemViewState['preview']): void {
		this.originalState = original;
		this.modifiedState = modified;
		this.previewState = preview;
		this.restoreEditorState();
	}

	private restoreEditorState(): void {
		this.pendingScrollRestore.clear();
		const editor = this.editor;
		if (!editor) return;
		// Resetting to the default cursor would reveal a hidden leading region on every mount.
		if (this.originalState) editor.originalEditor.restoreViewState(this.originalState);
		if (this.modifiedState) editor.modifiedEditor.restoreViewState(this.modifiedState);
		if (this.previewState) editor[this.previewState.side === 'original' ? 'originalEditor' : 'modifiedEditor'].setSelection(this.previewState.range);
		const targets = [[editor.originalEditor, this.originalState], [editor.modifiedEditor, this.modifiedState]] as const;
		if (!targets.some(([control, state]) => state && control.getScrollLeft() !== state.viewState.scrollLeft)) return;
		const pending = new DisposableStore();
		this.pendingScrollRestore.value = pending;
		let restoring = false;
		const restoreHorizontal = () => {
			restoring = true;
			try {
				for (const [control, state] of targets) {
					if (state) control.setScrollLeft(state.viewState.scrollLeft);
				}
			} finally { restoring = false; }
		};
		// A newly attached View has not measured its content width yet. Restore
		// during that first measurement, before paint, then stop tracking the size.
		for (const [control] of targets) {
			pending.add(control.onDidContentSizeChange(event => { if (event.contentWidthChanged) restoreHorizontal(); }));
			pending.add(control.onDidScrollChange(event => { if (event.scrollLeftChanged && !restoring) this.pendingScrollRestore.clear(); }));
		}
		pending.add(scheduleAtNextAnimationFrame(getWindow(this.domNode), () => {
			restoreHorizontal();
			this.pendingScrollRestore.clear();
		}));
	}

	public setCollapsed(collapsed: boolean): void {
		this.domNode.classList.toggle('collapsed', collapsed);
		this.toggleDomNode.setAttribute('aria-expanded', String(!collapsed));
		this.updateToggleLabel(collapsed);
		if (collapsed) this.unmount();
	}

	public updateStatus(): void {
		if ((this.item.binary || this.item.unavailableMessage) && !this.editorHostDomNode.classList.contains('comparison-unavailable')) {
			this.editorHostDomNode.classList.add('comparison-unavailable');
			this.editorHostDomNode.classList.toggle('binary', this.item.binary === true);
			this.editorHostDomNode.tabIndex = 0;
			this.editorHostDomNode.setAttribute('role', 'group');
			this.editorHostDomNode.setAttribute('aria-label', this.item.label);
			this.editorHostDomNode.textContent = this.item.unavailableMessage ?? localize('multiDiffEditor.binary', 'Binary file changed. Text comparison is unavailable.');
			if (this.item.unavailableMessage) {
				this.toggleDomNode.setAttribute('aria-description', this.item.unavailableMessage);
				this.editorHostDomNode.setAttribute('aria-description', this.item.unavailableMessage);
			}
		}
		this.updateToggleLabel(this.domNode.classList.contains('collapsed'));
		const model = this.item.model;
		if (this.item.state === 'error') {
			this.incompleteStatusDomNode.textContent = formatNlsMessage(localize('multiDiffEditor.loadError', 'Could not load {0}'), { 0: this.item.label });
			return;
		}
		if (this.item.state === 'loading') {
			this.incompleteStatusDomNode.textContent = localize('multiDiffEditor.loading', 'Loading comparison');
			return;
		}
		if (model?.state.kind === 'error') {
			this.incompleteStatusDomNode.textContent = formatNlsMessage(localize('diffEditor.error', 'Could not compute differences: {0}'), { 0: model.state.error.message });
			return;
		}
		if (model?.state.kind === 'loading') {
			this.incompleteStatusDomNode.textContent = localize('diffEditor.computing', 'Computing differences');
			return;
		}
		this.incompleteStatusDomNode.textContent = model?.state.kind === 'ready' && model.state.quitEarly
			? localize('diffEditor.incompleteShort', 'Diff may be incomplete')
			: '';
	}

	private updateToggleLabel(collapsed: boolean): void {
		this.toggleDomNode.setAttribute('aria-label', formatNlsMessage(collapsed
			? localize('multiDiffEditor.expandItem', 'Expand {0}')
			: localize('multiDiffEditor.collapseItem', 'Collapse {0}'), { 0: this.item.label }));
	}
}

/** Read-only DOM projection. Text, syntax, history and persistence remain model-owned. */
class ReviewPreview extends Disposable {
	private readonly domNode: HTMLDivElement;
	private readonly columns: readonly HTMLDivElement[];
	private readonly rows = new Map<number, readonly HTMLElement[]>();
	private readonly accessibleViewer = this._register(new MutableDisposable<AccessibleDiffViewer>());
	private selected: DiffEditorItemViewState['preview'];
	private selectionAnchor: TrackedRange | undefined;
	private anchorLine = 1;
	private caretLine = 1;
	private revision = -1;
	private diff: DiffModel['diff'];
	private theme: IColorTheme | undefined;
	private inlineChanges = true;
	private layout: DiffPreviewLayout | undefined;

	constructor(container: HTMLElement, private readonly model: DiffModel,
		private readonly open: (side: 'original' | 'modified', range: Range) => void,
		private readonly reveal: (row: number) => void, private readonly expand: (row: number) => void,
		initial: DiffEditorItemViewState['preview'],
		@IContextKeyService contextKeyService: IContextKeyService) {
		super();
		// The TextModel owns tracked handles; this view releases its lease early.
		this._register(toDisposable(() => this.selectionAnchor?.dispose()));
		if (initial) this.setSelection(initial.side, initial.range);
		this.anchorLine = initial?.range.startLineNumber ?? 1;
		this.caretLine = initial?.range.endLineNumber ?? 1;
		this.domNode = h(container.ownerDocument, 'div');
		this.domNode.className = 'ash-diff-review-preview';
		this.domNode.tabIndex = 0;
		this.domNode.setAttribute('role', 'group');
		const context = this._register(contextKeyService.createScoped(this.domNode));
		MultiDiffReviewPreviewContext.bindTo(context).set(true);
		this.domNode.setAttribute('aria-label', localize('multiDiff.preview.label', 'Read-only diff review. Use arrow keys to choose a line, Shift to extend selection, and Enter to open the full editor.'));
		this.columns = (['original', 'modified'] as const).map(side => {
			const column = h(container.ownerDocument, 'div');
			column.className = `ash-diff-review-column ${side}`;
			this.domNode.append(column);
			const source = model[side];
			const attached = source.onBeforeAttached();
			this._register(toDisposable(() => source.onBeforeDetached(attached)));
			this._register(source.tokenization.onDidChange(() => { this.revision = -1; this.onTokensChanged?.(); }));
			this.attachments.push(attached);
			return column;
		});
		container.append(this.domNode);
		this._register(toDisposable(() => this.domNode.remove()));
		this._register(addDisposableListener<MouseEvent>(this.domNode, 'click', event => {
			const target = event.target as HTMLElement;
			const row = target.closest<HTMLElement>('[data-review-row]');
			if (!row) return;
			const index = Number(row.dataset.reviewRow);
			if (row.classList.contains('hidden-region')) { this.expand(index); return; }
			this.select(index, row.closest('.original') ? 'original' : 'modified', event.shiftKey, false);
		}));
		this._register(addDisposableListener<MouseEvent>(this.domNode, 'dblclick', event => {
			if ((event.target as HTMLElement).closest('.ash-diff-review-number')) this.openSelection();
		}));
		this._register(addDisposableListener<ClipboardEvent>(this.domNode, 'copy', event => {
			// Model-based line selection also copies text from rows outside the DOM window.
			this.captureTextSelection();
			const location = this.location;
			if (!location) return;
			event.clipboardData?.setData('text/plain', this.model[location.side].getValueInRange(location.range));
			event.preventDefault();
		}));
		this._register(addDisposableListener(this.domNode.ownerDocument, 'selectionchange', () => this.captureTextSelection()));
		this._register(addDisposableListener<KeyboardEvent>(this.domNode, 'keydown', event => {
			if (event.defaultPrevented || event.isComposing || event.altKey) return;
			if (event.key === 'Enter') { event.preventDefault(); this.openSelection(); return; }
			if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
				event.preventDefault();
				const side = this.selected?.side ?? 'modified';
				this.setSelection(side, this.model[side].getFullModelRange());
				getWindow(this.domNode).getSelection()?.removeAllRanges();
				this.updateSelection();
				return;
			}
			if (event.ctrlKey || event.metaKey || !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
			event.preventDefault();
			const side = event.key === 'ArrowLeft' ? 'original' : event.key === 'ArrowRight' ? 'modified' : this.selected?.side ?? 'modified';
			const line = this.caretLine;
			const next = Math.max(1, Math.min(this.model[side].lineCount, line + (event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0)));
			const rows = this.model.diff?.rows;
			if (!rows) return;
			// Source line numbers are monotone in the aligned projection.
			let low = 0;
			let high = rows.length;
			while (low < high) {
				const middle = (low + high) >>> 1;
				let probe = middle;
				let value: number | undefined;
				while (probe < high) {
					const row = rows.get(probe)!;
					value = side === 'original' ? row.originalLineIndex : row.modifiedLineIndex;
					if (value !== undefined) break;
					probe++;
				}
				if (value === undefined) { high = middle; continue; }
				if (value < next - 1) low = probe + 1;
				else high = middle;
			}
			while (low < rows.length - 1 && rows.get(low)![side === 'original' ? 'originalLineIndex' : 'modifiedLineIndex'] === undefined) low++;
			this.select(Math.min(low, rows.length - 1), side, event.shiftKey, false);
			this.reveal(Math.min(low, rows.length - 1));
		}));
	}

	private readonly attachments: ReturnType<DiffModel['original']['onBeforeAttached']>[] = [];
	private onTokensChanged: (() => void) | undefined;
	public get location(): DiffEditorItemViewState['preview'] {
		return this.selected && this.selectionAnchor ? { side: this.selected.side, range: this.selectionAnchor.range } : this.selected;
	}
	public focus(): void { this.domNode.focus({ preventScroll: true }); }

	public select(rowIndex: number, preferred: 'original' | 'modified', extend: boolean, focus: boolean): void {
		const row = this.model.diff?.rows.get(rowIndex);
		if (!row) return;
		const side = row[preferred === 'original' ? 'originalLineIndex' : 'modifiedLineIndex'] !== undefined ? preferred : preferred === 'original' ? 'modified' : 'original';
		const line = (side === 'original' ? row.originalLineIndex : row.modifiedLineIndex)! + 1;
		this.caretLine = line;
		if (!extend || this.selected?.side !== side) this.anchorLine = line;
		const start = Math.min(this.anchorLine, line);
		const end = Math.max(this.anchorLine, line);
		this.setSelection(side, new Range(start, 1, end, this.model[side].getLineMaxColumn(end)));
		this.updateSelection();
		if (focus) this.domNode.focus({ preventScroll: true });
	}

	public render(layout: DiffPreviewLayout, scrollTop: number, height: number, lineHeight: number, overscan: number,
		font: { readonly family: string; readonly size: number; readonly ligatures: boolean; }, theme: IColorTheme, inlineChanges: boolean): void {
		if (!this.model.diff) return;
		// The sticky host itself moves up at the end of the file. Its internal
		// viewport must stop there, otherwise both offsets scroll the same rows away.
		scrollTop = Math.min(scrollTop, Math.max(0, layout.height - height));
		this.onTokensChanged = () => this.render(layout, scrollTop, height, lineHeight, overscan, font, theme, inlineChanges);
		this.domNode.style.setProperty('--ash-review-line-height', `${lineHeight}px`);
		this.domNode.style.setProperty('--ash-review-font-family', font.family);
		this.domNode.style.setProperty('--ash-review-font-size', `${font.size}px`);
		this.domNode.classList.toggle('ligatures', font.ligatures);
		if (this.layout !== layout || this.diff !== this.model.diff || this.revision !== this.model.modified.version || this.theme !== theme || this.inlineChanges !== inlineChanges) {
			for (const nodes of this.rows.values()) for (const node of nodes) node.remove();
			this.rows.clear();
			this.revision = this.model.modified.version;
			this.diff = this.model.diff;
			this.theme = theme;
			this.inlineChanges = inlineChanges;
		}
		this.layout = layout;
		const visible = layout.getVisibleRows(Math.max(0, scrollTop - overscan), height + overscan * 2);
		const desired = new Set(visible.map(row => row.rowIndex));
		for (const [index, nodes] of this.rows) {
			if (!desired.has(index)) { for (const node of nodes) node.remove(); this.rows.delete(index); }
		}
		for (const row of visible) {
			let nodes = this.rows.get(row.rowIndex);
			if (!nodes) {
				nodes = this.columns.map((column, side) => {
					const node = row.hiddenCount ? h(column.ownerDocument, 'button') : this.renderLine(row.rowIndex, side === 0 ? 'original' : 'modified', theme);
					node.classList.add('ash-diff-review-row');
					node.dataset.reviewRow = String(row.rowIndex);
					if (row.hiddenCount) {
						(node as HTMLButtonElement).type = 'button';
						node.classList.add('hidden-region');
						node.textContent = localize('multiDiff.preview.hidden', 'Show {0} unchanged lines', row.hiddenCount);
					}
					column.append(node);
					return node;
				});
				this.rows.set(row.rowIndex, nodes);
			}
			for (const node of nodes) {
				node.style.top = `${row.top - scrollTop}px`;
				node.style.height = `${row.height}px`;
			}
		}
		// Backward scrolling prepends source rows. Keep native selection and the
		// accessibility tree in the same order as their absolute visual positions.
		for (const [side, column] of this.columns.entries()) {
			let next: HTMLElement | null = null;
			for (let index = visible.length - 1; index >= 0; index--) {
				const node = this.rows.get(visible[index]!.rowIndex)![side]!;
				if (node.nextSibling !== next) column.insertBefore(node, next);
				next = node;
			}
		}
		for (const [side, attached] of this.attachments.entries()) {
			const lines = visible.filter(row => !row.hiddenCount).flatMap(row => {
				const value = this.model.diff?.rows.get(row.rowIndex);
				const line = side === 0 ? value?.originalLineIndex : value?.modifiedLineIndex;
				return line === undefined ? [] : [{ startLineNumber: line + 1, endLineNumber: line + 1 }];
			});
			attached.setVisibleLines(lines, false);
		}
		this.updateSelection();
	}

	private renderLine(index: number, side: 'original' | 'modified', theme: IColorTheme): HTMLElement {
		const row = this.model.diff!.rows.get(index)!;
		const source = this.model[side];
		const line = side === 'original' ? row.originalLineIndex : row.modifiedLineIndex;
		const node = h(this.domNode.ownerDocument, 'div');
		node.className = row.kind;
		if (line === undefined) { node.classList.add('empty'); return node; }
		const number = h(node.ownerDocument, 'span');
		number.className = 'ash-diff-review-number';
		number.setAttribute('aria-hidden', 'true');
		number.textContent = String(line + 1);
		const text = h(node.ownerDocument, 'span');
		text.className = 'ash-diff-review-text stanza-editor-line-text';
		text.dataset.reviewLine = String(line + 1);
		text.style.tabSize = String(source.getOptions().tabSize);
		const content = source.getLineContent(line + 1);
		const tokens = source.tokenization.getLanguageTokens(line);
		const changes = this.inlineChanges ? side === 'original' ? row.originalChanges : row.modifiedChanges : [];
		const boundaries = [...new Set([0, content.length, ...tokens.flatMap(token => [token.range.startColumn - 1, token.range.endColumn - 1]), ...changes.flatMap(range => [range.startColumn, range.endColumn])])].sort((a, b) => a - b);
		for (let i = 1; i < boundaries.length; i++) {
			const start = boundaries[i - 1]!;
			const end = boundaries[i]!;
			const span = h(node.ownerDocument, 'span');
			span.textContent = content.slice(start, end);
			const token = tokens.find(token => token.range.startColumn - 1 <= start && token.range.endColumn - 1 >= end);
			if (token) {
				const styling = resolveSemanticTokenStyling(token);
				if (styling.presentation) span.classList.add(styling.presentation);
				const presentation = resolveSemanticTokenPresentation({ startColumn: start, endColumn: end, ...styling, syntaxPresentation: token.presentation }, theme, false);
				if (presentation.foreground) span.style.setProperty('--ash-review-token-color', presentation.foreground);
				if (presentation.fontStyle) for (const style of presentation.fontStyle) span.classList.add(style);
			}
			if (changes.some(range => range.startColumn <= start && range.endColumn >= end)) span.classList.add('changed-text');
			text.append(span);
		}
		node.append(number, text);
		return node;
	}

	private updateSelection(): void {
		this.selected = this.location;
		for (const [index, nodes] of this.rows) {
			const row = this.model.diff?.rows.get(index);
			for (const [side, node] of nodes.entries()) {
				const line = side === 0 ? row?.originalLineIndex : row?.modifiedLineIndex;
				node.classList.toggle('selected', line !== undefined && this.selected?.side === (side === 0 ? 'original' : 'modified')
					&& line + 1 >= this.selected.range.startLineNumber && line + 1 <= this.selected.range.endLineNumber);
			}
		}
	}

	private openSelection(): void {
		if (!this.selected) this.select(this.layout?.getVisibleRows(0, 1)[0]?.rowIndex ?? 0, 'modified', false, false);
		const location = this.location;
		if (location) this.open(location.side, location.range);
	}

	private setSelection(side: 'original' | 'modified', range: Range): void {
		const source = this.model[side];
		const valid = source.validateRange(range);
		this.selected = { side, range: valid };
		this.selectionAnchor?.dispose();
		this.selectionAnchor = source.trackRange(valid, TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges);
	}

	private captureTextSelection(): void {
		const selection = getWindow(this.domNode).getSelection();
		if (!selection || selection.isCollapsed || !selection.anchorNode || !selection.focusNode) return;
		const point = (node: Node, offset: number) => {
			const text = (node.nodeType === 1 ? node as Element : node.parentElement)?.closest<HTMLElement>('.ash-diff-review-text');
			if (!text || !this.domNode.contains(text)) return undefined;
			const range = text.ownerDocument.createRange();
			range.selectNodeContents(text);
			range.setEnd(node, offset);
			return { side: text.closest('.original') ? 'original' as const : 'modified' as const, line: Number(text.dataset.reviewLine), column: range.toString().length + 1 };
		};
		const anchor = point(selection.anchorNode, selection.anchorOffset);
		const focus = point(selection.focusNode, selection.focusOffset);
		if (!anchor || !focus || anchor.side !== focus.side) return;
		const [start, end] = anchor.line < focus.line || anchor.line === focus.line && anchor.column <= focus.column ? [anchor, focus] : [focus, anchor];
		this.setSelection(anchor.side, new Range(start.line, start.column, end.line, end.column));
		this.anchorLine = anchor.line;
		this.caretLine = focus.line;
	}

	public getAccessibleContent(): string {
		if (!this.accessibleViewer.value) this.accessibleViewer.value = new AccessibleDiffViewer(this.domNode, this.model, () => this.model.diff, () => undefined, () => { }, () => this.domNode.focus());
		return this.accessibleViewer.value.getAccessibleContent();
	}
}
