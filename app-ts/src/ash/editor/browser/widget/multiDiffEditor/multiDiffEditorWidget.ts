import './style.css';
import '../diffEditor/style.css';
import { addDisposableListener, fragment as createFragment, getWindow, h, isHTMLElement, reset, stopEvent } from '../../../../base/browser/dom.js';
import { FastDomNode } from '../../../../base/browser/fastDomNode.js';
import { appendIcon } from '../../../../base/browser/ui/icon/icon.js';
import { getClientArea } from '../../../../base/browser/dom.js';
import { observeResize } from '../../../../base/browser/observer.js';
import { isNonEmptyArray } from '../../../../base/common/arrays.js';
import { Disposable, type IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { lxiconsLibrary } from '../../../../base/common/lxiconsLibrary.js';
import { isFiniteNumber, isNonNegativeSafeInteger, rot } from '../../../../base/common/numbers.js';
import { type DiffModel } from '../../../common/diff/diffModel.js';
import { type IDimension } from '../../../common/core/2d/dimension.js';
import { LineDiffKind } from '../../../common/diff/lineDiff.js';
import { createBareFontInfoFromRawSettings } from '../../../common/config/fontInfoFromSettings.js';
import { type BareFontInfo, type FontInfo } from '../../../common/config/fontInfo.js';
import { applyFontInfo } from '../../config/domFontInfo.js';
import { FontMeasurements } from '../../config/fontMeasurements.js';
import { computeDiffRowLayout, createDiffEditorRow, diffRowAtOffset, type DiffRowLayout } from '../diffEditor/diffEditorRows.js';
import { localize, onDidChangeNls } from '../../../../nls.js';

const DEFAULT_LINE_HEIGHT = 20;
const DEFAULT_OVERSCAN_ROW_COUNT = 8;
const SECTION_HEADER_HEIGHT = 34;
const SECTION_GAP = 8;
const SECTION_HORIZONTAL_INSET = 18;
const SCROLLBAR_RESERVE = 15;
const STATUS_BODY_HEIGHT = 40;

export interface MultiDiffEditorItem {
	readonly id: string;
	readonly label: string;
	readonly originalLabel?: string;
	readonly modifiedLabel?: string;
	readonly model: DiffModel;
}

export interface MultiDiffEditorWidgetOptions {
	readonly container: HTMLElement;
	readonly items: readonly MultiDiffEditorItem[];
	readonly lineHeight?: number;
	readonly fontFamily?: string;
	readonly fontSize?: number;
	readonly fontLigatures?: boolean;
	readonly showLineNumbers?: boolean;
	readonly showInlineChanges?: boolean;
	readonly loopChanges?: boolean;
	readonly wordWrap?: boolean;
	readonly overscanRowCount?: number;
	readonly ariaLabel?: string;
	/** Populates the dedicated action slot owned by each file header. */
	readonly createItemActions?: (container: HTMLElement, item: MultiDiffEditorItem) => IDisposable;
}

export interface MultiDiffEditorLocation {
	readonly itemId: string;
	readonly rowIndex: number;
}

interface MultiDiffSectionLayout {
	readonly top: number;
	readonly bodyTop: number;
	readonly bodyHeight: number;
	readonly height: number;
	readonly rows: DiffRowLayout;
}

/** Read-only, vertically virtualized presentation of multiple DiffModels. */
export class MultiDiffEditorWidget extends Disposable {
	public readonly domNode: HTMLDivElement;
	private readonly contentDomNode: HTMLDivElement;
	private readonly contentNode: FastDomNode<HTMLDivElement>;
	private readonly accessibilityStatusDomNode: HTMLDivElement;
	private readonly items: readonly MultiDiffEditorItem[];
	private readonly sections: readonly MultiDiffSection[];
	private readonly layouts: MultiDiffSectionLayout[] = [];
	private rowLayouts = new WeakMap<DiffModel, DiffRowLayout>();
	private readonly collapsedItemIds = new Set<string>();
	private readonly lineHeight: number;
	private readonly overscanRowCount: number;
	private readonly showInlineChanges: boolean;
	private readonly loopChanges: boolean;
	private readonly showLineNumbers: boolean;
	private readonly bareFontInfo: BareFontInfo;
	private fontInfo: FontInfo | undefined;
	private configuredWordWrap: boolean;
	private temporaryWordWrap: boolean | undefined;
	private viewportWidth = 0;
	private viewportHeight = 0;
	private activeChange: MultiDiffEditorLocation | undefined;

	constructor(options: MultiDiffEditorWidgetOptions) {
		super();
		validateOptions(options);
		this.items = options.items;
		this.lineHeight = options.lineHeight ?? DEFAULT_LINE_HEIGHT;
		this.overscanRowCount = options.overscanRowCount ?? DEFAULT_OVERSCAN_ROW_COUNT;
		this.showInlineChanges = options.showInlineChanges ?? true;
		this.loopChanges = options.loopChanges ?? true;
		this.showLineNumbers = options.showLineNumbers ?? true;
		this.configuredWordWrap = options.wordWrap ?? false;
		const ownerDocument = options.container.ownerDocument;
		this.domNode = h(ownerDocument, 'div');
		this.domNode.className = 'stanza-multi-diff-editor';
		this.domNode.classList.toggle('word-wrapped', this.wordWrap);
		this.domNode.classList.toggle('hide-line-numbers', options.showLineNumbers === false);
		this.bareFontInfo = createBareFontInfoFromRawSettings({
			fontFamily: options.fontFamily,
			fontSize: options.fontSize,
			fontLigatures: options.fontLigatures,
			lineHeight: this.lineHeight,
		}, getWindow(options.container).devicePixelRatio);
		applyFontInfo(this.domNode, this.bareFontInfo);
		this.domNode.tabIndex = 0;
		this.domNode.setAttribute('role', 'region');
		this.domNode.setAttribute('aria-label', options.ariaLabel ?? `Multi-file diff editor with ${this.items.length} files`);
		this.contentDomNode = h(ownerDocument, 'div');
		this.contentNode = new FastDomNode(this.contentDomNode);
		this.contentNode.setClassName('stanza-multi-diff-editor-content');
		this.accessibilityStatusDomNode = h(ownerDocument, 'div');
		this.accessibilityStatusDomNode.className = 'stanza-multi-diff-editor-accessibility-status';
		this.accessibilityStatusDomNode.setAttribute('aria-live', 'polite');
		this.accessibilityStatusDomNode.setAttribute('aria-atomic', 'true');
		this.sections = this.items.map((item) => this._register(new MultiDiffSection(
			this.contentDomNode,
			item,
			() => this.toggleItem(item.id),
			options.createItemActions,
		)));
		this.domNode.append(this.contentDomNode, this.accessibilityStatusDomNode);
		options.container.append(this.domNode);
		this._register(toDisposable(() => this.domNode.remove()));
		this._register(addDisposableListener(this.domNode, 'scroll', () => this.project()));
		this._register(addDisposableListener(this.domNode, 'keydown', (event) => this.handleKeydown(event)));
		for (let index = 0; index < this.items.length; index += 1) {
			const item = this.items[index]!;
			const section = this.sections[index]!;
			this._register(item.model.onDidChange(() => {
				this.rowLayouts.delete(item.model);
				section.invalidate();
				section.updateIncompleteStatus();
				if (this.activeChange?.itemId === item.id) this.activeChange = undefined;
				this.refreshLayout();
			}));
		}
		this._register(onDidChangeNls(() => {
			for (const section of this.sections) section.updateIncompleteStatus();
		}));
		this._register(observeResize(this.domNode, ([entry]) => {
			if (entry) this.layout({ width: entry.contentRect.width, height: entry.contentRect.height });
		}));
		this.refreshLayout();
		this.layout(getClientArea(this.domNode));
	}

	public get currentChange(): MultiDiffEditorLocation | undefined {
		return this.activeChange;
	}

	public get wordWrap(): boolean {
		return this.temporaryWordWrap ?? this.configuredWordWrap;
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

	private updateWordWrap(): void {
		this.domNode.classList.toggle('word-wrapped', this.wordWrap);
		this.rowLayouts = new WeakMap();
		this.refreshLayout();
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
			this.refreshLayout();
		}
		else this.project(true);
	}

	public toggleItem(itemId: string): boolean {
		const index = this.items.findIndex((item) => item.id === itemId);
		if (index < 0) throw new RangeError(`Unknown multi-diff item '${itemId}'`);
		if (this.collapsedItemIds.has(itemId)) this.collapsedItemIds.delete(itemId);
		else this.collapsedItemIds.add(itemId);
		this.sections[index]!.setCollapsed(this.collapsedItemIds.has(itemId));
		this.refreshLayout();
		return this.collapsedItemIds.has(itemId);
	}

	public nextChange(): MultiDiffEditorLocation | undefined {
		return this.selectRelativeChange(1);
	}

	public previousChange(): MultiDiffEditorLocation | undefined {
		return this.selectRelativeChange(-1);
	}

	public collapseAll(): void {
		let changed = false;
		for (let index = 0; index < this.items.length; index += 1) {
			const item = this.items[index]!;
			if (this.collapsedItemIds.has(item.id)) continue;
			this.collapsedItemIds.add(item.id);
			this.sections[index]!.setCollapsed(true);
			changed = true;
		}
		if (changed) this.refreshLayout();
	}

	public expandAll(): void {
		if (this.collapsedItemIds.size === 0) return;
		this.collapsedItemIds.clear();
		for (const section of this.sections) section.setCollapsed(false);
		this.refreshLayout();
	}

	private refreshLayout(): void {
		let wrapping: { readonly fontInfo: FontInfo; readonly column: number } | undefined;
		if (this.wordWrap) {
			const gutterWidth = this.showLineNumbers ? 52 : 0;
			const cellWidth = Math.max(1, (this.viewportWidth - SECTION_HORIZONTAL_INSET - SCROLLBAR_RESERVE) / 2 - gutterWidth - 1);
			const fontInfo = this.fontInfo ??= FontMeasurements.readFontInfo(getWindow(this.domNode), this.bareFontInfo);
			wrapping = { fontInfo, column: Math.max(1, Math.floor(cellWidth / fontInfo.typicalHalfwidthCharacterWidth)) };
		}
		let top = SECTION_GAP;
		this.layouts.length = 0;
		for (let index = 0; index < this.items.length; index += 1) {
			const item = this.items[index]!;
			const collapsed = this.collapsedItemIds.has(item.id);
			const rowCount = item.model.diff?.rows.length ?? 0;
			let rows = this.rowLayouts.get(item.model);
			if (!rows) {
				rows = computeDiffRowLayout(item.model, this.lineHeight, wrapping);
				this.rowLayouts.set(item.model, rows);
			}
			const bodyHeight = collapsed ? 0 : rowCount > 0 ? rows.offsets[rowCount]! : STATUS_BODY_HEIGHT;
			const height = SECTION_HEADER_HEIGHT + bodyHeight;
			const layout = { top, bodyTop: top + SECTION_HEADER_HEIGHT, bodyHeight, height, rows };
			this.layouts.push(layout);
			this.sections[index]!.layout(layout);
			top += height + SECTION_GAP;
		}
		this.contentNode.setHeight(top);
		this.project(true);
	}

	private selectRelativeChange(delta: -1 | 1): MultiDiffEditorLocation | undefined {
		const changes = this.items.flatMap((item) => item.model.diff?.rows.flatMap((row, rowIndex) =>
			row.kind === LineDiffKind.Unchanged ? [] : [{ itemId: item.id, rowIndex }]) ?? []);
		if (changes.length === 0) {
			this.accessibilityStatusDomNode.textContent = this.items.some((item) => item.model.state.kind === 'loading')
				? 'Computing differences'
				: 'No differences';
			return undefined;
		}
		const currentIndex = this.activeChange
			? changes.findIndex((change) => change.itemId === this.activeChange!.itemId && change.rowIndex === this.activeChange!.rowIndex)
			: -1;
		const selectedIndex = currentIndex < 0
			? delta > 0 ? 0 : changes.length - 1
			: this.loopChanges
				? rot(currentIndex + delta, changes.length)
				: Math.max(0, Math.min(changes.length - 1, currentIndex + delta));
		const location = changes[selectedIndex]!;
		this.revealChange(location);
		const item = this.items.find((candidate) => candidate.id === location.itemId)!;
		this.accessibilityStatusDomNode.textContent = `Change ${selectedIndex + 1} of ${changes.length}, ${item.label}`;
		return location;
	}

	private revealChange(location: MultiDiffEditorLocation): void {
		const itemIndex = this.items.findIndex((item) => item.id === location.itemId);
		if (itemIndex < 0) throw new RangeError(`Unknown multi-diff item '${location.itemId}'`);
		if (this.collapsedItemIds.delete(location.itemId)) {
			this.sections[itemIndex]!.setCollapsed(false);
			this.refreshLayout();
		}
		const rowCount = this.items[itemIndex]!.model.diff?.rows.length ?? 0;
		if (!isNonNegativeSafeInteger(location.rowIndex) || location.rowIndex >= rowCount) {
			throw new RangeError('Multi-diff row index is outside its item');
		}
		this.activeChange = Object.freeze({ ...location });
		const layout = this.layouts[itemIndex]!;
		const rowTop = layout.bodyTop + layout.rows.offsets[location.rowIndex]!;
		const rowBottom = layout.bodyTop + layout.rows.offsets[location.rowIndex + 1]!;
		const viewportBottom = this.domNode.scrollTop + this.viewportHeight;
		if (rowTop < this.domNode.scrollTop) this.domNode.scrollTop = rowTop;
		else if (rowBottom > viewportBottom) this.domNode.scrollTop = Math.max(0, rowBottom - this.viewportHeight);
		this.project(true);
	}

	private handleKeydown(event: KeyboardEvent): void {
		if (event.defaultPrevented || event.isComposing || event.getModifierState('AltGraph')) return;
		if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && event.key.toLowerCase() === 'z') {
			stopEvent(event);
			this.toggleWordWrap();
			return;
		}
		if (event.key !== 'F7' || event.ctrlKey || event.metaKey || event.altKey) return;
		stopEvent(event);
		if (event.shiftKey) this.previousChange();
		else this.nextChange();
	}

	private project(force = false): void {
		const viewportTop = this.domNode.scrollTop;
		const viewportBottom = viewportTop + this.viewportHeight;
		for (let index = 0; index < this.items.length; index += 1) {
			const item = this.items[index]!;
			const section = this.sections[index]!;
			const layout = this.layouts[index]!;
			if (this.collapsedItemIds.has(item.id) || layout.top + layout.height < viewportTop || layout.top > viewportBottom) {
				section.clearRows();
				continue;
			}
			const diff = item.model.diff;
			if (!diff || diff.rows.length === 0) {
				section.showStatus(item.model.state.kind === 'error'
					? `Could not compute differences: ${item.model.state.error.message}`
					: item.model.state.kind === 'loading' ? 'Computing differences…' : 'No differences');
				continue;
			}
			section.showRows();
			const offsets = layout.rows.offsets;
			const firstVisibleRow = diffRowAtOffset(offsets, Math.max(0, viewportTop - layout.bodyTop));
			const startRow = Math.max(0, firstVisibleRow - this.overscanRowCount);
			const lastVisibleOffset = Math.max(0, viewportBottom - layout.bodyTop - 0.001);
			const endRow = Math.min(diff.rows.length, diffRowAtOffset(offsets, lastVisibleOffset) + 1 + this.overscanRowCount);
			section.renderRows(
				startRow,
				endRow,
				this.lineHeight,
				this.activeChange?.itemId === item.id ? this.activeChange.rowIndex : -1,
				this.showInlineChanges,
				layout.rows,
				force,
			);
		}
	}
}

class MultiDiffSection extends Disposable {
	public readonly domNode: HTMLElement;
	private readonly headerDomNode: HTMLDivElement;
	private readonly toggleDomNode: HTMLButtonElement;
	private readonly bodyDomNode: HTMLDivElement;
	private readonly rowsDomNode: HTMLDivElement;
	private readonly rowsNode: FastDomNode<HTMLDivElement>;
	private readonly statusDomNode: HTMLDivElement;
	private readonly incompleteStatusDomNode: HTMLSpanElement;
	private renderedStartRow = -1;
	private renderedEndRow = -1;
	private renderedActiveRow = -1;

	constructor(
		container: HTMLElement,
		private readonly item: MultiDiffEditorItem,
		toggle: () => void,
		createItemActions: MultiDiffEditorWidgetOptions['createItemActions'],
	) {
		super();
		const ownerDocument = container.ownerDocument;
		this.domNode = h(ownerDocument, 'section');
		this.domNode.className = 'stanza-multi-diff-editor-section';
		this.domNode.setAttribute('role', 'group');
		this.domNode.setAttribute('aria-label', item.label);
		this.headerDomNode = h(ownerDocument, 'div');
		this.headerDomNode.className = 'stanza-multi-diff-editor-header';
		this.toggleDomNode = h(ownerDocument, 'button');
		this.toggleDomNode.type = 'button';
		this.toggleDomNode.className = 'stanza-multi-diff-editor-header-toggle';
		this.toggleDomNode.setAttribute('aria-expanded', 'true');
		this.toggleDomNode.setAttribute('aria-label', `Collapse ${item.label}`);
		const collapsedIconDomNode = h(ownerDocument, 'span');
		collapsedIconDomNode.className = 'stanza-multi-diff-editor-chevron collapsed-icon';
		appendIcon(lxiconsLibrary.chevronRight, collapsedIconDomNode);
		const expandedIconDomNode = h(ownerDocument, 'span');
		expandedIconDomNode.className = 'stanza-multi-diff-editor-chevron expanded-icon';
		appendIcon(lxiconsLibrary.chevronDown, expandedIconDomNode);
		const titleDomNode = h(ownerDocument, 'span');
		titleDomNode.className = 'stanza-multi-diff-editor-title';
		titleDomNode.textContent = item.label;
		const labelsDomNode = h(ownerDocument, 'span');
		labelsDomNode.className = 'stanza-multi-diff-editor-labels';
		labelsDomNode.textContent = [item.originalLabel, item.modifiedLabel].filter((label) => label !== undefined).join(' ↔ ');
		this.toggleDomNode.append(collapsedIconDomNode, expandedIconDomNode, titleDomNode, labelsDomNode);
		this.headerDomNode.append(this.toggleDomNode);
		this.incompleteStatusDomNode = h(ownerDocument, 'span');
		this.incompleteStatusDomNode.className = 'stanza-multi-diff-editor-incomplete-status';
		this.incompleteStatusDomNode.setAttribute('role', 'status');
		this.incompleteStatusDomNode.setAttribute('aria-live', 'polite');
		this.headerDomNode.append(this.incompleteStatusDomNode);
		this.updateIncompleteStatus();
		if (createItemActions) {
			const actionsDomNode = h(ownerDocument, 'div');
			actionsDomNode.className = 'stanza-multi-diff-editor-file-actions';
			this.headerDomNode.append(actionsDomNode);
			this._register(createItemActions(actionsDomNode, item));
		}
		this.bodyDomNode = h(ownerDocument, 'div');
		this.bodyDomNode.className = 'stanza-multi-diff-editor-body';
		this.rowsDomNode = h(ownerDocument, 'div');
		this.rowsNode = new FastDomNode(this.rowsDomNode);
		this.rowsNode.setClassName('stanza-multi-diff-editor-rows');
		this.statusDomNode = h(ownerDocument, 'div');
		this.statusDomNode.className = 'stanza-multi-diff-editor-status';
		this.bodyDomNode.append(this.rowsDomNode, this.statusDomNode);
		this.domNode.append(this.headerDomNode, this.bodyDomNode);
		container.append(this.domNode);
		this._register(toDisposable(() => this.domNode.remove()));
		this._register(addDisposableListener(this.headerDomNode, 'click', (event) => {
			if ((event.target as Element | null)?.closest('.stanza-multi-diff-editor-file-actions')) return;
			toggle();
		}));
	}

	public layout(layout: MultiDiffSectionLayout): void {
		this.domNode.style.height = `${layout.height}px`;
		this.domNode.style.top = `${layout.top}px`;
		this.bodyDomNode.style.height = `${layout.bodyHeight}px`;
	}

	public updateIncompleteStatus(): void {
		this.incompleteStatusDomNode.textContent = this.item.model.state.kind === 'ready' && this.item.model.state.quitEarly
			? localize('diffEditor.incompleteShort', 'Diff may be incomplete')
			: '';
	}

	public setCollapsed(collapsed: boolean): void {
		this.domNode.classList.toggle('collapsed', collapsed);
		this.toggleDomNode.setAttribute('aria-expanded', String(!collapsed));
		this.toggleDomNode.setAttribute('aria-label', `${collapsed ? 'Expand' : 'Collapse'} ${this.item.label}`);
		if (collapsed) this.clearRows();
	}

	public invalidate(): void {
		this.renderedStartRow = -1;
		this.renderedEndRow = -1;
		this.renderedActiveRow = -1;
	}

	public showStatus(message: string): void {
		this.clearRows();
		this.rowsDomNode.hidden = true;
		this.statusDomNode.hidden = false;
		this.statusDomNode.textContent = message;
	}

	public showRows(): void {
		this.rowsDomNode.hidden = false;
		this.statusDomNode.hidden = true;
	}

	public renderRows(startRow: number, endRow: number, lineHeight: number, activeRow: number, showInlineChanges: boolean, layout: DiffRowLayout, force: boolean): void {
		if (!force && startRow === this.renderedStartRow && endRow === this.renderedEndRow && activeRow === this.renderedActiveRow) return;
		const rows = this.item.model.diff?.rows ?? [];
		const fragment = createFragment(this.domNode.ownerDocument);
		for (let rowIndex = startRow; rowIndex < endRow; rowIndex += 1) {
			fragment.append(createDiffEditorRow(
				this.domNode.ownerDocument, rows[rowIndex]!, this.item.model, lineHeight,
				rowIndex === activeRow, showInlineChanges, layout.wrappedRows[rowIndex],
			));
		}
		this.rowsNode.setTop(layout.offsets[startRow] ?? 0);
		reset(this.rowsDomNode, fragment);
		this.renderedStartRow = startRow;
		this.renderedEndRow = endRow;
		this.renderedActiveRow = activeRow;
	}

	public clearRows(): void {
		if (this.rowsDomNode.childElementCount > 0) reset(this.rowsDomNode);
		this.invalidate();
	}
}

function validateOptions(options: MultiDiffEditorWidgetOptions): void {
	if (!options || typeof options !== 'object' || !isHTMLElement(options.container)) {
		throw new TypeError('Multi-diff editor widget requires a browser container');
	}
	if (!isNonEmptyArray(options.items)) {
		throw new TypeError('Multi-diff editor widget requires at least one item');
	}
	const ids = new Set<string>();
	for (const item of options.items) {
		if (!item || typeof item !== 'object' || typeof item.id !== 'string' || item.id.length === 0 || typeof item.label !== 'string' || item.label.trim().length === 0 || !item.model || typeof item.model !== 'object') {
			throw new TypeError('Multi-diff editor items require a unique ID, label, and DiffModel');
		}
		if (ids.has(item.id)) throw new TypeError(`Duplicate multi-diff item ID '${item.id}'`);
		ids.add(item.id);
	}
	const lineHeight = options.lineHeight ?? DEFAULT_LINE_HEIGHT;
	const overscanRowCount = options.overscanRowCount ?? DEFAULT_OVERSCAN_ROW_COUNT;
	if (!isFiniteNumber(lineHeight) || lineHeight <= 0) throw new RangeError('Multi-diff editor line height must be positive and finite');
	if (!isNonNegativeSafeInteger(overscanRowCount)) throw new RangeError('Multi-diff editor overscan row count must be a non-negative safe integer');
	if (options.fontFamily !== undefined && (typeof options.fontFamily !== 'string' || !options.fontFamily.trim())) throw new TypeError('Multi-diff editor font family must be a non-empty string');
	if (options.fontSize !== undefined && (!isFiniteNumber(options.fontSize) || options.fontSize <= 0)) throw new RangeError('Multi-diff editor font size must be positive and finite');
	for (const [name, value] of [
		['fontLigatures', options.fontLigatures],
		['showLineNumbers', options.showLineNumbers],
		['showInlineChanges', options.showInlineChanges],
		['loopChanges', options.loopChanges],
		['wordWrap', options.wordWrap],
	] as const) {
		if (value !== undefined && typeof value !== 'boolean') throw new TypeError(`Multi-diff editor option '${name}' must be boolean`);
	}
	if (options.ariaLabel !== undefined && (typeof options.ariaLabel !== 'string' || options.ariaLabel.trim().length === 0)) throw new TypeError('Multi-diff editor ARIA label must be a non-empty string');
	if (options.createItemActions !== undefined && typeof options.createItemActions !== 'function') throw new TypeError('Multi-diff editor item actions must be created by a function');
	const ownerWindow = getWindow(options.container);
	if (options.container.ownerDocument.defaultView !== ownerWindow) throw new Error('Multi-diff editor container must belong to its owner window');
}
