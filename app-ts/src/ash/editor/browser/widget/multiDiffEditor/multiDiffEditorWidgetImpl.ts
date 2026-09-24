import './style.css';
import './colors.js';
import { addDisposableListener, getClientArea, getWindow, h, stopEvent } from '../../../../base/browser/dom.js';
import { observeResize } from '../../../../base/browser/observer.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { isFiniteNumber, isNonNegativeSafeInteger, rot } from '../../../../base/common/numbers.js';
import { formatNlsMessage, localize, onDidChangeNls } from '../../../../nls.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { createBareFontInfoFromRawSettings } from '../../../common/config/fontInfoFromSettings.js';
import { type FontInfo } from '../../../common/config/fontInfo.js';
import { type IDimension } from '../../../common/core/2d/dimension.js';
import { type DiffModel } from '../../../common/diff/diffModel.js';
import { LineDiffKind } from '../../../common/diff/lineDiff.js';
import { FontMeasurements } from '../../config/fontMeasurements.js';
import { DiffEditorWidget, type DiffEditorWidgetOptions } from '../diffEditor/diffEditorWidget.js';
import { computeDiffRowLayout, type DiffRowLayout } from './compressedVirtualizedScrollLayout.js';
import { CompressedVirtualizedScrollView } from './compressedVirtualizedScrollView.js';
import {
	DiffEditorItemTemplate,
	MULTI_DIFF_HEADER_HEIGHT,
	MULTI_DIFF_HORIZONTAL_INSET,
} from './diffEditorItemTemplate.js';
import { type IDocumentDiffItem } from './model.js';
import { MultiDiffEditorLogger } from './multiDiffEditorLogging.js';
import {
	DEFAULT_LINE_HEIGHT,
	DEFAULT_OVERSCAN_ROW_COUNT,
	validateMultiDiffEditorOptions,
	type IMultiDiffEditorWidgetOptions,
} from './multiDiffEditorOptions.js';
import { MultiDiffEditorViewModel, type MultiDiffEditorLocation, type MultiDiffEditorViewState } from './multiDiffEditorViewModel.js';
import { VirtualizedItemManager } from './virtualizedItemManager.js';

const SECTION_GAP = 8;
const SCROLLBAR_RESERVE = 15;

interface MultiDiffSectionLayout {
	readonly top: number;
	readonly bodyHeight: number;
	readonly height: number;
	readonly rows: DiffRowLayout;
}

/** Owns the DOM, layout, and navigation of a continuous multi-file diff surface. */
export class MultiDiffEditorWidgetImpl extends Disposable {
	public readonly domNode: HTMLDivElement;
	private readonly scrollView: CompressedVirtualizedScrollView<DiffEditorItemTemplate>;
	private readonly accessibilityStatusDomNode: HTMLDivElement;
	private items: readonly IDocumentDiffItem[];
	private readonly itemListeners = this._register(new DisposableStore());
	private readonly sections: VirtualizedItemManager<DiffEditorItemTemplate>;
	private readonly viewModel: MultiDiffEditorViewModel;
	private readonly layouts: MultiDiffSectionLayout[] = [];
	private readonly measuredHeights = new Map<string, number>();
	private readonly editorOptions: Pick<DiffEditorWidgetOptions, 'lineHeight' | 'fontFamily' | 'fontSize' | 'fontLigatures' | 'showLineNumbers' | 'showInlineChanges'>;
	private rowLayouts = new WeakMap<DiffModel, DiffRowLayout>();
	private readonly lineHeight: number;
	private readonly overscanRowCount: number;
	private readonly loopChanges: boolean;
	private readonly showLineNumbers: boolean;
	private readonly fontInfoSettings: ReturnType<typeof createBareFontInfoFromRawSettings>;
	private fontInfo: FontInfo | undefined;
	private configuredWordWrap: boolean;
	private temporaryWordWrap: boolean | undefined;
	private viewportWidth = 0;
	private viewportHeight = 0;
	private syncingEditorScroll = false;
	private layoutRefreshScheduled = false;
	private navigationGeneration = 0;
	private readonly workbenchUIElementFactory: IMultiDiffEditorWidgetOptions['workbenchUIElementFactory'];
	private readonly logger: MultiDiffEditorLogger;
	private readonly navigationAbortController = new AbortController();
	private readonly observedItemIds = new Set<string>();

	constructor(
		options: IMultiDiffEditorWidgetOptions,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ILogService logService: ILogService,
	) {
		super();
		this.logger = new MultiDiffEditorLogger(logService);
		validateMultiDiffEditorOptions(options);
		this.items = options.model.items;
		this._register(toDisposable(() => this.navigationAbortController.abort()));
		this.viewModel = new MultiDiffEditorViewModel(this.items);
		this.workbenchUIElementFactory = options.workbenchUIElementFactory;
		this.lineHeight = options.lineHeight ?? DEFAULT_LINE_HEIGHT;
		this.overscanRowCount = options.overscanRowCount ?? DEFAULT_OVERSCAN_ROW_COUNT;
		this.loopChanges = options.loopChanges ?? true;
		this.showLineNumbers = options.showLineNumbers ?? true;
		this.configuredWordWrap = options.wordWrap ?? false;
		this.editorOptions = {
			lineHeight: options.lineHeight,
			fontFamily: options.fontFamily,
			fontSize: options.fontSize,
			fontLigatures: options.fontLigatures,
			showLineNumbers: options.showLineNumbers,
			showInlineChanges: options.showInlineChanges,
		};
		this.fontInfoSettings = createBareFontInfoFromRawSettings({
			fontFamily: options.fontFamily,
			fontSize: options.fontSize,
			fontLigatures: options.fontLigatures,
			lineHeight: this.lineHeight,
		}, getWindow(options.container).devicePixelRatio);
		const ownerDocument = options.container.ownerDocument;
		this.scrollView = this._register(new CompressedVirtualizedScrollView(
			options.container,
			(contentDomNode, index) => {
				const item = this.items[index]!;
				const section = new DiffEditorItemTemplate(
					contentDomNode, item, () => this.toggleItem(item.id),
					() => this.activateItem(item.id), this.workbenchUIElementFactory,
				);
				section.setCollapsed(this.viewModel.isCollapsed(item.id));
				section.domNode.classList.toggle('active', this.viewModel.activeChange?.itemId === item.id);
				const state = this.viewModel.getItemViewState(item.id);
				if (state) section.restoreViewState(state.original, state.modified);
				return section;
			},
			(index, section) => {
				this.viewModel.saveItemViewState(this.items[index]!.id, section.saveViewState());
				if (section.domNode.contains(section.domNode.ownerDocument.activeElement)) {
					this.domNode.focus({ preventScroll: true });
				}
			},
		));
		this.domNode = this.scrollView.domNode;
		this.sections = this.scrollView.sections;
		this.domNode.classList.toggle('word-wrapped', this.wordWrap);
		this.domNode.classList.toggle('hide-line-numbers', !this.showLineNumbers);
		this.domNode.tabIndex = 0;
		this.domNode.setAttribute('role', 'region');
		this.domNode.setAttribute('aria-label', options.ariaLabel ?? formatNlsMessage(localize('multiDiffEditor.ariaLabel', 'Multi-file diff editor with {0} files'), { 0: this.items.length }));
		this.accessibilityStatusDomNode = h(ownerDocument, 'div');
		this.accessibilityStatusDomNode.className = 'stanza-multi-diff-editor-accessibility-status';
		this.accessibilityStatusDomNode.setAttribute('aria-live', 'polite');
		this.accessibilityStatusDomNode.setAttribute('aria-atomic', 'true');
		this.domNode.append(this.accessibilityStatusDomNode);
		this._register(addDisposableListener(this.domNode, 'scroll', event => this.handleScroll(event), true));
		this._register(addDisposableListener(this.domNode, 'keydown', event => this.handleKeydown(event), true));
		this.bindItems();
		this._register(options.model.onDidChangeItems(items => {
			this.logger.itemsChanged(items);
			this.scrollView.resetItems();
			this.itemListeners.clear();
			this.items = items;
			this.viewModel.setItems(items);
			this.observedItemIds.clear();
			this.measuredHeights.clear();
			this.rowLayouts = new WeakMap();
			this.layouts.length = 0;
			this.bindItems();
			if (!options.ariaLabel) this.domNode.setAttribute('aria-label', formatNlsMessage(localize('multiDiffEditor.ariaLabel', 'Multi-file diff editor with {0} files'), { 0: items.length }));
			this.refreshLayout();
		}));
		this._register(onDidChangeNls(() => {
			if (!options.ariaLabel) this.domNode.setAttribute('aria-label', formatNlsMessage(localize('multiDiffEditor.ariaLabel', 'Multi-file diff editor with {0} files'), { 0: this.items.length }));
			for (const section of this.sections.values()) section.updateStatus();
		}));
		this._register(observeResize(this.domNode, ([entry]) => {
			if (entry) this.layout({ width: entry.contentRect.width, height: entry.contentRect.height });
		}));
		this.layout(getClientArea(this.domNode));
	}

	public get currentChange(): MultiDiffEditorLocation | undefined {
		return this.viewModel.activeChange;
	}

	public get wordWrap(): boolean {
		return this.temporaryWordWrap ?? this.configuredWordWrap;
	}

	public focus(): void {
		const itemId = this.viewModel.activeChange?.itemId ?? this.items[0]?.id;
		const section = this.sections.get(this.items.findIndex(item => item.id === itemId));
		if (section?.editor) section.editor.focus();
		else this.domNode.focus({ preventScroll: true });
	}

	public saveViewState(): MultiDiffEditorViewState {
		for (const section of this.sections.values()) {
			this.viewModel.saveItemViewState(section.item.id, section.saveViewState());
		}
		return this.viewModel.saveViewState(this.scrollView.getLogicalScrollTop());
	}

	public restoreViewState(state: unknown): void {
		const scrollTop = this.viewModel.restoreViewState(state);
		for (const section of this.sections.values()) {
			section.setCollapsed(this.viewModel.isCollapsed(section.item.id));
			const itemState = this.viewModel.getItemViewState(section.item.id);
			section.restoreViewState(itemState?.original ?? null, itemState?.modified ?? null);
		}
		this.refreshLayout();
		this.scrollView.setLogicalScrollTop(scrollTop);
		this.project();
	}

	public setConfiguredWordWrap(enabled: boolean): void {
		this.configuredWordWrap = enabled;
		this.updateWordWrap();
	}

	public toggleWordWrap(): void {
		this.temporaryWordWrap = this.temporaryWordWrap === undefined ? !this.wordWrap : undefined;
		this.updateWordWrap();
		this.accessibilityStatusDomNode.textContent = this.wordWrap
			? localize('wordWrap.enabled', 'Word wrap on')
			: localize('wordWrap.disabled', 'Word wrap off');
	}

	public layout(size: IDimension = getClientArea(this.domNode)): void {
		if (!isFiniteNumber(size.width) || size.width < 0 || !isFiniteNumber(size.height) || size.height < 0) {
			throw new RangeError('Multi-diff editor layout size must be finite and non-negative');
		}
		const widthChanged = this.viewportWidth !== size.width;
		this.viewportWidth = size.width;
		this.viewportHeight = size.height;
		if (widthChanged) {
			this.rowLayouts = new WeakMap();
			this.measuredHeights.clear();
		}
		this.refreshLayout();
	}

	public toggleItem(itemId: string): boolean {
		const index = this.items.findIndex(item => item.id === itemId);
		const collapsed = this.viewModel.toggleItem(itemId);
		this.logger.itemStateChanged(itemId, collapsed ? 'collapsed' : 'expanded');
		this.sections.get(index)?.setCollapsed(collapsed);
		this.refreshLayout();
		return collapsed;
	}

	public nextChange(): Promise<MultiDiffEditorLocation | undefined> {
		return this.selectRelativeChange(1);
	}

	public previousChange(): Promise<MultiDiffEditorLocation | undefined> {
		return this.selectRelativeChange(-1);
	}

	/** Waits for the comparisons currently projected into the viewport. */
	public async resolveVisible(): Promise<void> {
		// Each item publishes its own load error in the header; one failed file must not close the whole editor.
		await Promise.allSettled([...this.sections.entries()].flatMap(([index]) => {
			if (this.viewModel.isCollapsed(this.items[index]!.id)) return [];
			return [this.items[index]!.resolve()];
		}));
	}

	public collapseAll(): void {
		if (!this.viewModel.collapseAll()) return;
		for (const section of this.sections.values()) section.setCollapsed(true);
		this.refreshLayout();
	}

	public expandAll(): void {
		if (!this.viewModel.expandAll()) return;
		for (const section of this.sections.values()) section.setCollapsed(false);
		this.refreshLayout();
	}

	private updateWordWrap(): void {
		this.domNode.classList.toggle('word-wrapped', this.wordWrap);
		for (const section of this.sections.values()) section.editor?.setConfiguredWordWrap(this.wordWrap);
		this.rowLayouts = new WeakMap();
		this.measuredHeights.clear();
		this.refreshLayout();
	}

	private activateItem(itemId: string): void {
		for (const section of this.sections.values()) section.domNode.classList.toggle('active', section.item.id === itemId);
	}

	private bindItems(): void {
		for (let index = 0; index < this.items.length; index++) {
			const item = this.items[index]!;
			this.observeModel(index, item.model);
			this.itemListeners.add(item.onDidChange(() => {
				this.observeModel(index, item.model);
				this.sections.get(index)?.updateStatus();
				this.refreshLayout();
			}));
		}
	}

	private observeModel(index: number, model: DiffModel | undefined): void {
		const item = this.items[index]!;
		if (!model || this.observedItemIds.has(item.id)) return;
		this.observedItemIds.add(item.id);
		this.itemListeners.add(model.onDidChange(() => {
			this.logger.itemStateChanged(item.id, model.state.kind);
			this.rowLayouts.delete(model);
			// A pending computation must not shrink and unmount the editor receiving text input.
			if (model.state.kind === 'ready') this.measuredHeights.delete(item.id);
			this.sections.get(index)?.updateStatus();
			if (this.viewModel.activeChange?.itemId === item.id) this.viewModel.activeChange = undefined;
			this.refreshLayout();
		}));
	}

	private refreshLayout(): void {
		const previousLayouts = this.layouts.slice();
		const previousScrollTop = this.scrollView.getLogicalScrollTop();
		let wrapping: { readonly fontInfo: FontInfo; readonly column: number } | undefined;
		if (this.wordWrap) {
			const gutterWidth = this.showLineNumbers ? 52 : 0;
			const cellWidth = Math.max(1, (this.viewportWidth - MULTI_DIFF_HORIZONTAL_INSET - SCROLLBAR_RESERVE - 30) / 2 - gutterWidth);
			const fontInfo = this.fontInfo ??= FontMeasurements.readFontInfo(getWindow(this.domNode), this.fontInfoSettings);
			wrapping = { fontInfo, column: Math.max(1, Math.floor(cellWidth / fontInfo.typicalHalfwidthCharacterWidth)) };
		}
		let top = SECTION_GAP;
		this.layouts.length = 0;
		for (let index = 0; index < this.items.length; index++) {
			const item = this.items[index]!;
			const collapsed = this.viewModel.isCollapsed(item.id);
			const model = item.model;
			let rows = model ? this.rowLayouts.get(model) : undefined;
			if (!rows && model) {
				rows = computeDiffRowLayout(model, this.lineHeight, wrapping);
				this.rowLayouts.set(model, rows);
			}
			rows ??= { offsets: [0] };
			const estimatedHeight = model ? rows.offsets.at(-1) ?? 0 : this.lineHeight * 5;
			const bodyHeight = collapsed ? 0 : Math.max(this.lineHeight, this.measuredHeights.get(item.id) ?? estimatedHeight);
			const height = MULTI_DIFF_HEADER_HEIGHT + bodyHeight;
			const layout = { top, bodyHeight, height, rows };
			this.layouts.push(layout);
			top += height + SECTION_GAP;
		}
		this.scrollView.setLayout(this.layouts, top, this.viewportHeight);
		this.logger.layoutChanged(previousLayouts, this.layouts, previousScrollTop, this.scrollView.getLogicalScrollTop());
		this.project();
	}

	/** Mount editors only around the viewport; file models remain owned by the caller. */
	private project(): void {
		const viewportTop = this.scrollView.getLogicalScrollTop();
		const overscan = this.overscanRowCount * this.lineHeight;
		const { start, end } = this.scrollView.project(overscan);
		for (let index = start; index < end; index++) {
			const item = this.items[index]!;
			const section = this.sections.get(index)!;
			const layout = this.layouts[index]!;
			const rendered = this.scrollView.renderedRange(layout, overscan);
			section.layout(this.scrollView.isCompressed
				? { top: rendered.top, height: rendered.height, bodyHeight: Math.max(0, rendered.height - MULTI_DIFF_HEADER_HEIGHT) }
				: layout, this.viewportWidth, this.viewportHeight);
			if (this.viewModel.isCollapsed(item.id)) {
				section.unmount();
				continue;
			}
			if (!item.model) {
				if (item.state === 'unresolved') void item.resolve().catch(() => undefined);
				continue;
			}
			if (!section.editor) {
				section.mount(this.instantiationService.createInstance(DiffEditorWidget, {
					container: section.editorHostDomNode,
					model: item.model,
					originalAriaLabel: item.originalLabel,
					modifiedAriaLabel: item.modifiedLabel,
					readOnly: item.readOnly,
					scrollBeyondLastLine: false,
					wordWrap: this.wordWrap,
					...this.editorOptions,
				}));
				section.layoutEditor(this.viewportWidth);
			}
			const editor = section.editor!;
			const contentHeight = Math.max(editor.originalEditor.getContentHeight(), editor.modifiedEditor.getContentHeight());
			if (contentHeight > 0 && Math.abs(contentHeight - (this.measuredHeights.get(item.id) ?? layout.bodyHeight)) > 1) {
				this.measuredHeights.set(item.id, contentHeight);
				this.scheduleLayoutRefresh();
			}
			const desiredScroll = Math.max(0, viewportTop - layout.top);
			this.syncingEditorScroll = true;
			try {
				if (editor.originalEditor.getScrollTop() !== desiredScroll) editor.originalEditor.setScrollTop(desiredScroll);
				if (editor.modifiedEditor.getScrollTop() !== desiredScroll) editor.modifiedEditor.setScrollTop(desiredScroll);
			} finally {
				this.syncingEditorScroll = false;
			}
			if (this.viewModel.activeChange?.itemId === item.id && editor.currentChangeRow !== this.viewModel.activeChange.rowIndex) {
				editor.revealChangeRow(this.viewModel.activeChange.rowIndex, false);
			}
		}
	}

	private scheduleLayoutRefresh(): void {
		if (this.layoutRefreshScheduled) return;
		this.layoutRefreshScheduled = true;
		queueMicrotask(() => {
			this.layoutRefreshScheduled = false;
			if (!this.isDisposed) this.refreshLayout();
		});
	}

	private async selectRelativeChange(delta: -1 | 1): Promise<MultiDiffEditorLocation | undefined> {
		if (this.items.length === 0) {
			this.accessibilityStatusDomNode.textContent = localize('diffEditor.noChanges', 'No differences');
			return undefined;
		}
		const generation = ++this.navigationGeneration;
		const active = this.viewModel.activeChange;
		const activeIndex = active ? this.items.findIndex(item => item.id === active.itemId) : -1;
		const firstIndex = activeIndex >= 0 ? activeIndex : delta > 0 ? 0 : this.items.length - 1;
		const maxSteps = active && this.loopChanges ? this.items.length + 1 : this.items.length;
		for (let step = 0; step < maxSteps; step++) {
			const rawIndex = firstIndex + step * delta;
			if (!this.loopChanges && (rawIndex < 0 || rawIndex >= this.items.length)) break;
			const index = rot(rawIndex, this.items.length);
			const item = this.items[index]!;
			let model: DiffModel;
			try {
				model = await item.resolve();
				await this.waitForReady(model);
			} catch {
				if (!this.isDisposed && generation === this.navigationGeneration) {
					this.accessibilityStatusDomNode.textContent = formatNlsMessage(localize('multiDiffEditor.loadError', 'Could not load {0}'), { 0: item.label });
				}
				return undefined;
			}
			if (this.isDisposed || generation !== this.navigationGeneration) return undefined;
			const rows = model.diff!.rows;
			const firstRow = step === 0 && activeIndex === index
				? active!.rowIndex + delta
				: delta > 0 ? 0 : rows.length - 1;
			for (let rowIndex = firstRow; rowIndex >= 0 && rowIndex < rows.length; rowIndex += delta) {
				if (rows[rowIndex]!.kind === LineDiffKind.Unchanged) continue;
				const location = { itemId: item.id, rowIndex };
				this.revealChange(location);
				this.announceChange(location);
				return location;
			}
		}
		if (active && !this.loopChanges) return active;
		this.accessibilityStatusDomNode.textContent = localize('diffEditor.noChanges', 'No differences');
		return undefined;
	}

	private waitForReady(model: DiffModel): Promise<void> {
		if (model.state.kind === 'ready') return Promise.resolve();
		if (model.state.kind === 'error') return Promise.reject(model.state.error);
		const signal = this.navigationAbortController.signal;
		return new Promise<void>((resolve, reject) => {
			const listener = model.onDidChange(state => {
				if (state.kind === 'loading') return;
				cleanup();
				if (state.kind === 'error') reject(state.error);
				else resolve();
			});
			const abort = (): void => {
				cleanup();
				reject(new Error('Multi-diff editor was disposed'));
			};
			const cleanup = (): void => {
				listener.dispose();
				signal.removeEventListener('abort', abort);
			};
			signal.addEventListener('abort', abort, { once: true });
			if (signal.aborted) abort();
		});
	}

	private announceChange(location: MultiDiffEditorLocation): void {
		const item = this.items.find(candidate => candidate.id === location.itemId)!;
		if (this.items.every(candidate => candidate.model?.state.kind === 'ready')) {
			const changes = this.items.flatMap(candidate => candidate.model!.diff!.rows.flatMap((row, rowIndex) =>
				row.kind === LineDiffKind.Unchanged ? [] : [{ itemId: candidate.id, rowIndex }]));
			const selectedIndex = changes.findIndex(change => change.itemId === location.itemId && change.rowIndex === location.rowIndex);
			this.accessibilityStatusDomNode.textContent = formatNlsMessage(localize('multiDiffEditor.changeLocation', 'Change {0} of {1}, {2}'), { 0: selectedIndex + 1, 1: changes.length, 2: item.label });
			return;
		}
		this.accessibilityStatusDomNode.textContent = formatNlsMessage(localize('multiDiffEditor.changeInFile', 'Change in {0}'), { 0: item.label });
	}

	private revealChange(location: MultiDiffEditorLocation): void {
		const itemIndex = this.items.findIndex(item => item.id === location.itemId);
		if (itemIndex < 0) throw new RangeError(`Unknown multi-diff item '${location.itemId}'`);
		const item = this.items[itemIndex]!;
		const model = item.model;
		if (!isNonNegativeSafeInteger(location.rowIndex) || model?.diff?.rows[location.rowIndex]?.kind === LineDiffKind.Unchanged || !model?.diff?.rows[location.rowIndex]) {
			throw new RangeError('Multi-diff change row is outside its item');
		}
		const previous = this.viewModel.activeChange;
		if (previous) this.sections.get(this.items.findIndex(item => item.id === previous.itemId))?.editor?.clearActiveChange();
		if (this.viewModel.expand(location.itemId)) {
			this.sections.get(itemIndex)?.setCollapsed(false);
			this.refreshLayout();
		}
		this.viewModel.activeChange = Object.freeze({ ...location });
		const layout = this.layouts[itemIndex]!;
		const rowTop = layout.top + layout.rows.offsets[location.rowIndex]!;
		const rowBottom = layout.top + layout.rows.offsets[location.rowIndex + 1]!;
		const editorViewportHeight = Math.max(1, this.viewportHeight - MULTI_DIFF_HEADER_HEIGHT);
		const scrollTop = this.scrollView.getLogicalScrollTop();
		if (rowTop < scrollTop) this.scrollView.setLogicalScrollTop(rowTop);
		else if (rowBottom > scrollTop + editorViewportHeight) this.scrollView.setLogicalScrollTop(Math.max(0, rowBottom - editorViewportHeight));
		this.project();
		const editor = this.sections.get(itemIndex)?.editor;
		if (editor) {
			editor.revealChangeRow(location.rowIndex, false);
			const row = model.diff.rows[location.rowIndex]!;
			if (row.modifiedLineIndex !== undefined) editor.modifiedEditor.focus();
			else editor.originalEditor.focus();
		}
	}

	private handleScroll(event: Event): void {
		if (event.target === this.domNode) {
			this.project();
			return;
		}
		if (this.syncingEditorScroll) return;
		const target = event.target as Node;
		const index = [...this.sections.entries()].find(([_, section]) => section.editor?.element.contains(target))?.[0] ?? -1;
		if (index < 0) return;
		const editor = this.sections.get(index)!.editor!;
		const source = editor.originalEditor.getDomNode().contains(target) ? editor.originalEditor : editor.modifiedEditor;
		const desiredScroll = this.layouts[index]!.top + source.getScrollTop();
		if (Math.abs(this.scrollView.getLogicalScrollTop() - desiredScroll) > 1) this.scrollView.setLogicalScrollTop(desiredScroll);
	}

	private handleKeydown(event: KeyboardEvent): void {
		if (event.defaultPrevented || event.isComposing || event.getModifierState('AltGraph')) return;
		if (!event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
			const current = [...this.sections.entries()].find(([_, section]) => section.isHeaderTarget(event.target))?.[0];
			if (current !== undefined && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
				stopEvent(event);
				const target = event.key === 'Home' ? 0
					: event.key === 'End' ? this.items.length - 1
						: Math.max(0, Math.min(this.items.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1)));
				if (target !== current) {
					this.scrollView.setLogicalScrollTop(this.layouts[target]!.top);
					this.project();
					this.sections.get(target)?.focusHeader();
				}
				return;
			}
		}
		if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && event.key.toLowerCase() === 'z') {
			stopEvent(event);
			this.toggleWordWrap();
			return;
		}
		if (event.target === this.domNode && this.scrollView.isCompressed && !event.altKey && !event.ctrlKey && !event.metaKey) {
			// The focused outer region must navigate by logical lines and pages, even when DOM height is capped.
			let distance: number | undefined;
			if (event.key === ' ') distance = event.shiftKey ? -this.viewportHeight : this.viewportHeight;
			else if (!event.shiftKey) {
				switch (event.key) {
					case 'ArrowDown': distance = this.lineHeight; break;
					case 'ArrowUp': distance = -this.lineHeight; break;
					case 'PageDown': distance = this.viewportHeight; break;
					case 'PageUp': distance = -this.viewportHeight; break;
				}
			}
			if (distance !== undefined) {
				stopEvent(event);
				this.scrollView.setLogicalScrollTop(this.scrollView.getLogicalScrollTop() + distance);
				return;
			}
		}
		if (event.key !== 'F7' || event.ctrlKey || event.metaKey || event.altKey) return;
		stopEvent(event);
		if (event.shiftKey) this.previousChange();
		else this.nextChange();
	}
}
