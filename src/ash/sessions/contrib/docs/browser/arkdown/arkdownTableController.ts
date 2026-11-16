import './arkdownTableController.css';
import { addDisposableListener, h } from '../../../../../base/browser/dom.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { status } from '../../../../../base/browser/ui/aria/aria.js';
import { Separator, SubmenuAction, type IAction } from '../../../../../base/common/actions.js';
import type { Icon } from '../../../../../base/common/icon.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../../base/common/lxicons.js';
import { Emitter } from '../../../../../base/common/event.js';
import { localize } from '../../../../../nls.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';

import type { ArkdownNode, ArkdownTableAction, ArkdownTableCellLayout, ArkdownTableColor } from './arkdownRuntime.js';

/** View callbacks keep all table transactions in the editor's source/history owner. */
export interface ArkdownTableHost {
	getNode(table: HTMLTableElement): ArkdownNode | undefined;
	apply(table: HTMLTableElement, action: ArkdownTableAction, target?: { row: number; column: number; }): HTMLTableElement | undefined;
	setCaret(table: HTMLTableElement, row: number, column: number): void;
	beginComposition(table: HTMLTableElement, selection: { top: number; left: number; bottom: number; right: number; }): void;
	blockTarget(table: HTMLTableElement, target: { clientY: number; } | 'previous' | 'next'): ArkdownTableBlockTarget | undefined;
	moveBlock(table: HTMLTableElement, offset: number): HTMLTableElement | undefined;
	canEdit(): boolean;
	onError(error: unknown): void;
}

export interface ArkdownTableBlockTarget { readonly offset: number; readonly left: number; readonly top: number; readonly width: number; }

type Cell = { row: number; column: number; };
type SelectionKind = 'cells' | 'rows' | 'columns' | 'table';
type CellSelection = Cell & { table: HTMLTableElement; bottom: number; right: number; anchor: Cell; focus: Cell; kind: SelectionKind; };
type GripDrag = { kind: 'row' | 'column'; table: HTMLTableElement; pointer: number; x: number; y: number; from: number; to: number; moved: boolean; };
type ResizeDrag = { kind: 'resize'; table: HTMLTableElement; pointer: number; x: number; column: number; width: number; nextWidth: number; direction: number; widths: readonly number[]; styles: readonly (string | null)[]; tableStyle: string | null; };
type CellDrag = { kind: 'cells'; table: HTMLTableElement; pointer: number; anchor: Cell; moved: boolean; };
type TableDrag = { kind: 'table'; table: HTMLTableElement; pointer: number; x: number; y: number; moved: boolean; target?: ArkdownTableBlockTarget; };
const maxClipboardBytes = 2_000_000;
const maxClipboardCells = 8192;
const tableColors: readonly ArkdownTableColor[] = ['gray', 'red', 'orange', 'yellow', 'green', 'blue', 'purple'];

/** Owns transient table selection and handles; Markdown remains the only business state. */
export class ArkdownTableController extends Disposable {
	private readonly layer: HTMLElement;
	private readonly indicator: HTMLElement;
	private readonly rowGrip: Button;
	private readonly columnGrip: Button;
	private readonly tableGrip: Button;
	private readonly tableMenu: Button;
	private readonly addRow: Button;
	private readonly addColumn: Button;
	private readonly resizeButtons = this._register(new DisposableStore());
	private readonly resizeObserver = this._register(new MutableDisposable());
	private resizeHandles: Button[] = [];
	private observedTable: HTMLTableElement | undefined;
	private capturedPointer: { element: HTMLElement; pointer: number; } | undefined;
	private table: HTMLTableElement | undefined;
	private cell: Cell = { row: 0, column: 0 };
	private hoverCell: { table: HTMLTableElement; point: Cell; } | undefined;
	private hoverGrip: 'row' | 'column' | undefined;
	private selection: CellSelection | undefined;
	private drag: GripDrag | ResizeDrag | CellDrag | TableDrag | undefined;
	private menuVisible = false;
	private contextMenuVisible = false;
	private applying = false;
	private skipClick = false;
	private composition = false;
	private suppressDelete = false;
	private readonly selectionChanged = this._register(new Emitter<void>());
	readonly onDidChangeSelection = this.selectionChanged.event;

	constructor(
		private readonly prose: HTMLElement,
		private readonly host: ArkdownTableHost,
		@IContextMenuService private readonly menus: IContextMenuService,
		@IDialogService private readonly dialogs: IDialogService,
		@IClipboardService private readonly clipboard: IClipboardService,
	) {
		super();
		const document = prose.ownerDocument;
		this.layer = h(document, 'div', { className: 'ash-arkdown-table-controls', attributes: { contenteditable: 'false', role: 'group', 'aria-label': localize({ bundle: 'ash.docs', key: 'tableControls' }, 'Table controls') } });
		this.layer.hidden = true;
		prose.parentElement!.append(this.layer);
		this.indicator = h(document, 'div', { className: 'ash-arkdown-table-drop', attributes: { 'aria-hidden': 'true' } });
		this.indicator.hidden = true;
		this.layer.append(this.indicator);
		this._register(toDisposable(() => this.layer.remove()));
		const button = (className: string, label: string, icon: Icon | undefined, run: () => void): Button => {
			const control = this._register(new Button(this.layer, { label: icon ? label : '', ariaLabel: label, icon, iconOnly: true, presentation: 'quiet', title: label, onClick: () => { if (!this.skipClick) run(); this.skipClick = false; } }));
			control.domNode.classList.add(className);
			control.domNode.contentEditable = 'false';
			this._register(addDisposableListener(control.domNode, 'pointerdown', event => { event.preventDefault(); event.stopPropagation(); }));
			return control;
		};
		this.rowGrip = button('ash-arkdown-table-row-grip', localize({ bundle: 'ash.docs', key: 'tableRowOptions' }, 'Row options'), undefined, () => this.gripMenu('rows', this.rowGrip));
		this.columnGrip = button('ash-arkdown-table-column-grip', localize({ bundle: 'ash.docs', key: 'tableColumnOptions' }, 'Column options'), undefined, () => this.gripMenu('columns', this.columnGrip));
		this.rowGrip.setTitle(localize({ bundle: 'ash.docs', key: 'tableRowOptionsHint' }, 'Click for row options · drag to move'));
		this.columnGrip.setTitle(localize({ bundle: 'ash.docs', key: 'tableColumnOptionsHint' }, 'Click for column options · drag to move'));
		this.tableGrip = button('ash-arkdown-table-select', localize({ bundle: 'ash.docs', key: 'tableSelect' }, 'Select table'), undefined, () => {
			if (!this.table) return;
			const size = this.dimensions(this.table);
			this.select(this.table, { row: 0, column: 0 }, { row: size.rows - 1, column: size.columns - 1 }, 'table');
			this.prose.focus({ preventScroll: true });
		});
		this.tableGrip.setTitle(localize({ bundle: 'ash.docs', key: 'tableSelectHint' }, 'Click to select table · drag to move · Alt+Up/Down moves between blocks'));
		this.tableMenu = button('ash-arkdown-table-menu', localize({ bundle: 'ash.docs', key: 'tableOptions' }, 'Table options'), Lxicon.ellipsis, () => {
			if (!this.table) return;
			if (!this.selection) this.select(this.table, this.cell, this.cell);
			this.showMenu(this.tableMenu.domNode);
		});
		for (const control of [this.rowGrip, this.columnGrip, this.tableMenu]) control.domNode.setAttribute('aria-haspopup', 'menu');
		for (const [control, kind] of [[this.rowGrip, 'row'], [this.columnGrip, 'column']] as const) {
			this._register(addDisposableListener(control.domNode, 'pointerenter', () => { this.hoverGrip = kind; this.paintSelection(); }));
			this._register(addDisposableListener(control.domNode, 'pointerleave', () => { this.hoverGrip = undefined; this.paintSelection(); }));
		}
		this.addRow = button('ash-arkdown-table-add-row', localize({ bundle: 'ash.docs', key: 'tableAddRow' }, 'Add row'), Lxicon.add, () => {
			if (this.table) { const index = this.dimensions(this.table).rows; this.execute({ kind: 'insert_row', index }, { row: index, column: this.cell.column }); }
		});
		this.addColumn = button('ash-arkdown-table-add-column', localize({ bundle: 'ash.docs', key: 'tableAddColumn' }, 'Add column'), Lxicon.add, () => {
			if (this.table) { const index = this.dimensions(this.table).columns; this.execute({ kind: 'insert_column', index }, { row: this.cell.row, column: index }); }
		});
		this._register(addDisposableListener(this.rowGrip.domNode, 'pointerdown', event => this.startGrip(event, 'row')));
		this._register(addDisposableListener(this.columnGrip.domNode, 'pointerdown', event => this.startGrip(event, 'column')));
		this._register(addDisposableListener(this.tableGrip.domNode, 'pointerdown', event => {
			if (event.button !== 0 || !this.table || !this.host.canEdit()) return;
			this.skipClick = false;
			this.drag = { kind: 'table', table: this.table, pointer: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
			this.capturePointer(event);
		}));
		this._register(addDisposableListener(prose, 'pointerdown', event => this.pointerDown(event), true));
		this._register(addDisposableListener(prose, 'click', event => {
			if (event.detail !== 3 || event.button !== 0) return;
			const cell = this.eventCell(event.target);
			if (!cell) return;
			event.preventDefault(); event.stopImmediatePropagation();
			this.select(cell.table, cell.point, cell.point);
			this.prose.focus({ preventScroll: true });
		}, true));
		this._register(addDisposableListener(document, 'pointermove', event => this.pointerMove(event), true));
		this._register(addDisposableListener(document, 'pointerup', event => this.pointerUp(event), true));
		this._register(addDisposableListener(document, 'pointercancel', () => this.cancelDrag(), true));
		this._register(addDisposableListener(document, 'pointerdown', event => {
			const controls = (event.target as Element).closest?.('[data-arkdown-selection-controls]');
			if (this.layer.contains(event.target as Node) || prose.contains(event.target as Node) || this.contextMenuVisible || controls?.parentElement?.contains(prose)) return;
			this.close();
		}, true));
		this._register(menus.onDidShowContextMenu(() => { this.contextMenuVisible = true; }));
		this._register(menus.onDidHideContextMenu(() => { this.contextMenuVisible = false; }));
		this._register(addDisposableListener(document, 'keydown', event => {
			if (event.key === 'Escape' && this.drag) { event.preventDefault(); event.stopPropagation(); this.cancelDrag(); }
			if (this.suppressDelete && (event.key === 'Delete' || event.key === 'Backspace')) { event.preventDefault(); event.stopImmediatePropagation(); return; }
			if (this.menuVisible && (this.selection?.kind === 'rows' || this.selection?.kind === 'columns') && (event.key === 'Delete' || event.key === 'Backspace')) {
				event.preventDefault(); event.stopImmediatePropagation();
				if (!event.repeat && this.host.canEdit()) { this.suppressDelete = true; this.menus.hideContextMenu(); this.deleteSelection(); }
			}
		}, true));
		this._register(addDisposableListener(document, 'keyup', event => { if (event.key === 'Delete' || event.key === 'Backspace') this.suppressDelete = false; }, true));
		this._register(addDisposableListener(prose, 'keydown', event => this.keydown(event), true));
		this._register(addDisposableListener(this.layer, 'keydown', event => this.keydown(event), true));
		this._register(addDisposableListener(prose, 'beforeinput', event => this.beforeInput(event as InputEvent), true));
		this._register(addDisposableListener(prose, 'compositionstart', () => {
			if (!this.selection || !this.host.canEdit()) return;
			this.composition = true;
			// The editor defers replacement until compositionend, so cancellation preserves the grid.
			this.host.beginComposition(this.selection.table, this.rectangle(this.selection));
			this.clearSelection();
		}, true));
		this._register(addDisposableListener(prose, 'compositionend', () => { this.composition = false; }, true));
		this._register(addDisposableListener(prose, 'copy', event => this.copyEvent(event as ClipboardEvent, false), true));
		this._register(addDisposableListener(prose, 'cut', event => this.copyEvent(event as ClipboardEvent, true), true));
		this._register(addDisposableListener(prose, 'paste', event => this.pasteEvent(event as ClipboardEvent), true));
		this._register(addDisposableListener(prose, 'contextmenu', event => {
			const cell = this.eventCell(event.target);
			if (!cell) return;
			event.preventDefault(); event.stopImmediatePropagation();
			this.activate(cell.table, cell.point);
			if (!this.contains(this.selection, cell.table, cell.point)) this.select(cell.table, cell.point, cell.point);
			this.showMenu({ x: event.clientX, y: event.clientY, targetWindow: document.defaultView! });
		}, true));
		this._register(addDisposableListener(document, 'selectionchange', () => {
			if (this.applying || this.drag || this.composition || this.contextMenuVisible) return;
			// Focusing contenteditable after removing its native range can create a
			// caret on the prose root. The explicit cell rectangle still owns selection.
			if (this.selection) { this.update(); return; }
			const cell = this.caretCell();
			if (cell) this.activate(cell.table, cell.point);
			else if (this.prose.contains(document.defaultView!.getSelection()?.focusNode ?? null)) this.close();
			this.update();
		}));
		this._register(addDisposableListener(document, 'focusin', () => this.update()));
		this._register(addDisposableListener(document, 'scroll', () => this.update(), true));
		this._register(addDisposableListener(document.defaultView!, 'resize', () => this.update()));
		this._register(addDisposableListener(document.defaultView!, 'blur', () => { this.suppressDelete = false; this.cancelDrag(); }));
		this._register(toDisposable(() => this.close()));
	}

	get hasCellSelection(): boolean { return !!this.selection; }
	getSelectedText(): string | undefined { return this.selection ? this.copyData(this.selection).text : undefined; }

	get selectedCells(): readonly ArkdownNode[] {
		const selection = this.selection, node = selection && this.host.getNode(selection.table);
		if (!selection || !node) return [];
		return [...selection.table.querySelectorAll<HTMLTableCellElement>('.ash-arkdown-cell-selected')]
			.filter(cell => !cell.hidden).map(cell => node.children[Number(cell.dataset.row)]?.children[Number(cell.dataset.column)]).filter((cell): cell is ArkdownNode => !!cell);
	}

	getSelectionBounds(): DOMRect | undefined {
		const selection = this.selection;
		if (!selection?.table.isConnected) return undefined;
		const cells = [...selection.table.querySelectorAll<HTMLElement>('.ash-arkdown-cell-selected')].filter(cell => !cell.hidden);
		if (!cells.length) return undefined;
		const bounds = cells.map(cell => cell.getBoundingClientRect()), viewport = this.prose.getBoundingClientRect(), lane = selection.table.parentElement!.getBoundingClientRect();
		const left = Math.max(viewport.left, lane.left, Math.min(...bounds.map(cell => cell.left)));
		const right = Math.min(viewport.right, lane.right, Math.max(...bounds.map(cell => cell.right)));
		const top = Math.max(viewport.top, Math.min(...bounds.map(cell => cell.top))), bottom = Math.min(viewport.bottom, Math.max(...bounds.map(cell => cell.bottom)));
		return right > left && bottom > top ? new DOMRect(left, top, right - left, bottom - top) : undefined;
	}

	/** The editor commits cell formats; only the transient rectangle is restored here. */
	applyToSelectedCells(change: (table: HTMLTableElement, cells: readonly ArkdownNode[]) => HTMLTableElement | undefined): void {
		const selection = this.selection;
		if (!selection || !this.host.canEdit()) return;
		try {
			this.applying = true;
			const table = change(selection.table, this.selectedCells);
			if (table) {
				this.table = table; this.selection = { ...selection, table };
				this.prose.ownerDocument.defaultView!.getSelection()?.removeAllRanges();
				this.prose.focus({ preventScroll: true });
			} else this.clearSelection();
		} catch (error) { this.host.onError(error); }
		finally { this.applying = false; this.update(); this.selectionChanged.fire(); }
	}

	update(): void {
		if (this.isDisposed || this.applying) return;
		if (!this.table?.isConnected || !this.prose.contains(this.table) || this.prose.hidden) {
			this.clearSelection(); this.table = undefined; this.layer.hidden = true; this.cancelDrag(); return;
		}
		const table = this.table, node = this.host.getNode(table);
		if (!node) { this.close(); return; }
		if (!this.host.canEdit()) { this.layer.hidden = true; return; }
		this.observeTable(table);
		const size = this.dimensions(table);
		this.cell = { row: Math.min(this.cell.row, size.rows - 1), column: Math.min(this.cell.column, size.columns - 1) };
		this.layer.hidden = false;
		const bounds = table.getBoundingClientRect(), viewport = this.prose.getBoundingClientRect(), lane = table.parentElement!.getBoundingClientRect();
		const left = Math.max(bounds.left, lane.left, viewport.left), right = Math.min(bounds.right, lane.right, viewport.right);
		const top = Math.max(bounds.top, viewport.top), bottom = Math.min(bounds.bottom, viewport.bottom);
		if (right <= left || bottom <= top) { this.layer.hidden = true; return; }
		const active = this.cellElement(table, this.cell.row, this.cell.column);
		const cellBounds = active?.getBoundingClientRect() ?? bounds;
		const rtl = this.prose.ownerDocument.defaultView!.getComputedStyle(table).direction === 'rtl';
		this.layer.classList.toggle('rtl', rtl);
		this.position(this.tableGrip, rtl ? Math.min(viewport.right - 28, right + 18) : Math.max(viewport.left + 2, left - 44), top, 26, 26);
		this.position(this.rowGrip, rtl ? right - 7 : left - 7, Math.max(top + 12, Math.min(bottom - 12, cellBounds.top + cellBounds.height / 2)) - 12, 14, 24);
		this.position(this.columnGrip, Math.max(left + 12, Math.min(right - 12, cellBounds.left + cellBounds.width / 2)) - 12, top - 7, 24, 14);
		const outsideMenu = rtl ? left - 50 >= viewport.left : right + 50 <= viewport.right;
		let menuLeft = outsideMenu ? right + 22 : right - 34;
		if (rtl) menuLeft = outsideMenu ? left - 50 : left + 6;
		this.position(this.tableMenu, menuLeft, top + (outsideMenu ? 0 : 6), 28, 28);
		this.rowGrip.checked = this.selection?.kind === 'rows';
		this.columnGrip.checked = this.selection?.kind === 'columns';
		this.tableGrip.checked = this.selection?.kind === 'table';
		this.rowGrip.domNode.setAttribute('aria-label', localize({ bundle: 'ash.docs', key: 'tableRowNumberOptions' }, 'Row {0} options', this.cell.row + 1));
		this.columnGrip.domNode.setAttribute('aria-label', localize({ bundle: 'ash.docs', key: 'tableColumnNumberOptions' }, 'Column {0} options', this.cell.column + 1));
		const hovered = this.hoverCell?.table === table ? this.hoverCell.point : undefined;
		const hoveredCell = hovered && this.cellElement(table, hovered.row, hovered.column);
		this.addRow.hidden = !hovered || hovered.row + (hoveredCell?.rowSpan ?? 1) < size.rows || bounds.bottom > viewport.bottom - 18;
		this.addColumn.hidden = !hovered || hovered.column + (hoveredCell?.colSpan ?? 1) < size.columns || (rtl ? bounds.left < Math.max(lane.left, viewport.left) - 1 : bounds.right > Math.min(lane.right, viewport.right) + 1);
		this.position(this.addRow, left, bounds.bottom, right - left, 18);
		this.position(this.addColumn, rtl ? bounds.left - 18 : bounds.right, top, 18, bottom - top);
		this.ensureResizeHandles(size.columns);
		for (let column = 0; column < this.resizeHandles.length; column++) {
			const button = this.resizeHandles[column], edge = this.columnBounds(table, column).right;
			// A logical column edge can pass through the middle of a merged cell.
			// Keep its pointer target on a real boundary, away from merged text.
			const boundary = [...table.querySelectorAll<HTMLTableCellElement>('td[data-column], th[data-column]')].find(cell => !cell.hidden && Number(cell.dataset.column) + cell.colSpan - 1 === column && cell.getBoundingClientRect().bottom > top && cell.getBoundingClientRect().top < bottom);
			button.hidden = !boundary || !this.host.canEdit() || edge < left || edge > right + 1;
			button.domNode.setAttribute('aria-valuenow', String(Math.round(this.columnBounds(table, column).width)));
			const row = boundary?.getBoundingClientRect();
			this.position(button, edge - 4, Math.max(top, row?.top ?? top), 8, Math.min(bottom, row?.bottom ?? bottom) - Math.max(top, row?.top ?? top));
		}
		this.paintSelection();
	}

	close(): void {
		this.cancelDrag();
		this.clearSelection();
		this.table = undefined;
		this.hoverCell = undefined;
		this.resizeObserver.clear();
		this.observedTable = undefined;
		this.layer.hidden = true;
		if (this.menuVisible) this.menus.hideContextMenu();
	}

	private dimensions(table: HTMLTableElement): { rows: number; columns: number; } {
		const node = this.host.getNode(table);
		return { rows: node?.children.length ?? 0, columns: node?.alignments?.length ?? node?.children[0]?.children.length ?? 0 };
	}

	private activate(table: HTMLTableElement, cell: Cell): void {
		if (this.table !== table) {
			this.clearSelection();
			this.table = table;
			this.observeTable(table);
		}
		this.cell = cell;
		this.update();
	}

	private observeTable(table: HTMLTableElement): void {
		if (this.observedTable === table) return;
		this.resizeObserver.clear(); this.observedTable = table;
		const Observer = this.prose.ownerDocument.defaultView!.ResizeObserver;
		if (Observer) {
			const observer = new Observer(() => this.update());
			observer.observe(table); observer.observe(this.prose);
			this.resizeObserver.value = toDisposable(() => observer.disconnect());
		}
	}

	private eventCell(target: EventTarget | null): { table: HTMLTableElement; element: HTMLTableCellElement; point: Cell; } | undefined {
		const element = (target as Element | null)?.closest?.<HTMLTableCellElement>('td[data-row][data-column], th[data-row][data-column]');
		const table = element?.closest('table');
		if (!element || !table || !this.prose.contains(table)) return undefined;
		return { table, element, point: { row: Number(element.dataset.row), column: Number(element.dataset.column) } };
	}

	private caretCell(): ReturnType<ArkdownTableController['eventCell']> {
		const selection = this.prose.ownerDocument.defaultView!.getSelection();
		return this.eventCell(selection?.focusNode?.nodeType === 1 ? selection.focusNode : selection?.focusNode?.parentElement ?? null);
	}

	private cellElement(table: HTMLTableElement, row: number, column: number): HTMLTableCellElement | undefined {
		return Array.from(table.querySelectorAll<HTMLTableCellElement>('td[data-row], th[data-row]')).find(cell => {
			if (cell.hidden) return false;
			const startRow = Number(cell.dataset.row), startColumn = Number(cell.dataset.column);
			return row >= startRow && row < startRow + cell.rowSpan && column >= startColumn && column < startColumn + cell.colSpan;
		});
	}

	private select(table: HTMLTableElement, anchor: Cell, focus: Cell, kind: SelectionKind = 'cells'): void {
		this.table = table;
		const size = this.dimensions(table);
		const clamp = (cell: Cell): Cell => ({ row: Math.max(0, Math.min(cell.row, size.rows - 1)), column: Math.max(0, Math.min(cell.column, size.columns - 1)) });
		anchor = clamp(anchor); focus = clamp(focus);
		if (this.selection?.table === table && this.selection.kind === kind && this.selection.anchor.row === anchor.row && this.selection.anchor.column === anchor.column && this.selection.focus.row === focus.row && this.selection.focus.column === focus.column) return;
		let row = Math.min(anchor.row, focus.row), column = Math.min(anchor.column, focus.column), bottom = Math.max(anchor.row, focus.row), right = Math.max(anchor.column, focus.column);
		// A merged cell is atomic: extend the rectangle until every intersecting span is included.
		for (let changed = true; changed;) {
			changed = false;
			for (const cell of table.querySelectorAll<HTMLTableCellElement>('td[data-row], th[data-row]')) {
				if (cell.hidden) continue;
				const r = Number(cell.dataset.row), c = Number(cell.dataset.column), endRow = r + cell.rowSpan - 1, endColumn = c + cell.colSpan - 1;
				if (r > bottom || endRow < row || c > right || endColumn < column) continue;
				if (r < row || c < column || endRow > bottom || endColumn > right) { row = Math.min(row, r); column = Math.min(column, c); bottom = Math.max(bottom, endRow); right = Math.max(right, endColumn); changed = true; }
			}
		}
		this.selection = { table, row, column, bottom, right, anchor, focus, kind };
		this.prose.ownerDocument.defaultView!.getSelection()?.removeAllRanges();
		this.paintSelection();
		status(localize({ bundle: 'ash.docs', key: 'tableSelectionAnnouncement' }, 'Selected {0} rows and {1} columns.', bottom - row + 1, right - column + 1));
		this.update();
		this.selectionChanged.fire();
	}

	private paintSelection(): void {
		for (const element of this.prose.querySelectorAll('.ash-arkdown-cell-selected')) element.classList.remove('ash-arkdown-cell-selected');
		for (const element of this.prose.querySelectorAll('.ash-arkdown-cell-hover-row, .ash-arkdown-cell-hover-column')) element.classList.remove('ash-arkdown-cell-hover-row', 'ash-arkdown-cell-hover-column');
		if (this.hoverGrip && this.table) {
			for (const cell of this.table.querySelectorAll<HTMLTableCellElement>('td[data-row], th[data-row]')) {
				const row = Number(cell.dataset.row), column = Number(cell.dataset.column);
				const intersects = this.hoverGrip === 'row' ? row <= this.cell.row && row + cell.rowSpan > this.cell.row : column <= this.cell.column && column + cell.colSpan > this.cell.column;
				cell.classList.toggle(`ash-arkdown-cell-hover-${this.hoverGrip}`, !cell.hidden && intersects);
			}
		}
		const selection = this.selection;
		if (!selection) return;
		for (const cell of selection.table.querySelectorAll<HTMLTableCellElement>('td[data-row], th[data-row]')) {
			if (cell.hidden) continue;
			const row = Number(cell.dataset.row), column = Number(cell.dataset.column);
			cell.classList.toggle('ash-arkdown-cell-selected', row <= selection.bottom && row + cell.rowSpan > selection.row && column <= selection.right && column + cell.colSpan > selection.column);
		}
	}

	private clearSelection(): void {
		const changed = !!this.selection;
		this.selection = undefined;
		for (const cell of this.prose.querySelectorAll('.ash-arkdown-cell-selected')) cell.classList.remove('ash-arkdown-cell-selected');
		if (changed) this.selectionChanged.fire();
	}

	private rectangle(selection: CellSelection): { top: number; left: number; bottom: number; right: number; } {
		return { top: selection.row, left: selection.column, bottom: selection.bottom, right: selection.right };
	}

	private contains(selection: CellSelection | undefined, table: HTMLTableElement, point: Cell): boolean {
		return selection?.table === table && point.row >= selection.row && point.row <= selection.bottom && point.column >= selection.column && point.column <= selection.right;
	}

	private pointerDown(event: PointerEvent): void {
		if (event.button !== 0) return;
		this.skipClick = false;
		this.hoverCell = undefined;
		const cell = this.eventCell(event.target);
		if (!cell) { this.close(); return; }
		const caret = this.caretCell();
		const anchor = this.selection?.table === cell.table ? this.selection.anchor : caret?.table === cell.table ? caret.point : cell.point;
		this.activate(cell.table, cell.point);
		if (event.shiftKey) {
			event.preventDefault(); event.stopImmediatePropagation();
			this.select(cell.table, anchor, cell.point);
			this.prose.focus({ preventScroll: true });
		} else this.clearSelection();
		this.drag = { kind: 'cells', table: cell.table, anchor: event.shiftKey ? anchor : cell.point, pointer: event.pointerId, moved: event.shiftKey };
	}

	private pointerMove(event: PointerEvent): void {
		const drag = this.drag;
		if (!drag) {
			const cell = this.eventCell(event.target);
			if (cell && !this.menuVisible) {
				this.hoverCell = event.buttons & 1 ? undefined : { table: cell.table, point: cell.point };
				this.activate(cell.table, cell.point);
			} else if (!this.addRow.domNode.contains(event.target as Node) && !this.addColumn.domNode.contains(event.target as Node)) {
				this.hoverCell = undefined;
				this.update();
			}
			return;
		}
		if (event.pointerId !== drag.pointer) return;
		if (!drag.table.isConnected) { this.cancelDrag(); return; }
		if (drag.kind === 'resize') {
			event.preventDefault();
			drag.nextWidth = Math.round(Math.max(48, Math.min(4000, drag.width + (event.clientX - drag.x) * drag.direction)));
			const columns = Array.from(drag.table.querySelectorAll<HTMLTableColElement>('colgroup > col'));
			for (let index = 0; index < columns.length; index++) columns[index].style.width = `${index === drag.column ? drag.nextWidth : drag.widths[index]}px`;
			drag.table.style.width = `${drag.widths.reduce((total, width, index) => total + (index === drag.column ? drag.nextWidth : width), 0)}px`;
			this.update();
			return;
		}
		if (drag.kind === 'cells') {
			const element = this.prose.ownerDocument.elementFromPoint(event.clientX, event.clientY), cell = this.eventCell(element);
			if (!cell || cell.table !== drag.table || (!drag.moved && cell.point.row === drag.anchor.row && cell.point.column === drag.anchor.column)) return;
			event.preventDefault(); drag.moved = true;
			this.prose.classList.add('ash-arkdown-table-selecting');
			this.select(drag.table, drag.anchor, cell.point);
			return;
		}
		if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) <= 5) return;
		event.preventDefault(); drag.moved = true; this.skipClick = true;
		if (drag.kind === 'table') {
			this.tableGrip.domNode.classList.add('dragging');
			drag.table.classList.add('ash-arkdown-table-moving');
			drag.target = this.host.blockTarget(drag.table, { clientY: event.clientY });
			this.indicator.hidden = !drag.target;
			if (drag.target) Object.assign(this.indicator.style, { left: `${drag.target.left}px`, top: `${drag.target.top}px`, width: `${drag.target.width}px`, height: '4px' });
			return;
		}
		(drag.kind === 'row' ? this.rowGrip : this.columnGrip).domNode.classList.add('dragging');
		for (const cell of drag.table.querySelectorAll<HTMLTableCellElement>('td[data-row], th[data-row]')) {
			cell.classList.toggle('ash-arkdown-table-moving', drag.kind === 'row' ? Number(cell.dataset.row) === drag.from : Number(cell.dataset.column) === drag.from);
		}
		const size = this.dimensions(drag.table), count = drag.kind === 'row' ? size.rows : size.columns;
		let slot = count;
		for (let index = 0; index < count; index++) {
			const bounds = drag.kind === 'row' ? this.rowBounds(drag.table, index) : this.columnBounds(drag.table, index);
			if ((drag.kind === 'row' ? event.clientY : event.clientX) < (drag.kind === 'row' ? bounds.top + bounds.height / 2 : bounds.left + bounds.width / 2)) { slot = index; break; }
		}
		if (drag.kind === 'row' && this.host.getNode(drag.table)?.tableLayout?.header) slot = Math.max(1, slot);
		drag.to = Math.max(0, Math.min(count - 1, slot > drag.from ? slot - 1 : slot));
		const bounds = drag.table.getBoundingClientRect(), edge = slot === count ? bounds : drag.kind === 'row' ? this.rowBounds(drag.table, slot) : this.columnBounds(drag.table, slot);
		Object.assign(this.indicator.style, drag.kind === 'row'
			? { left: `${bounds.left}px`, top: `${slot === count ? bounds.bottom : edge.top}px`, width: `${bounds.width}px`, height: '4px' }
			: { left: `${slot === count ? bounds.right : edge.left}px`, top: `${bounds.top}px`, width: '4px', height: `${bounds.height}px` });
		this.indicator.hidden = false;
	}

	private pointerUp(event: PointerEvent): void {
		const drag = this.drag;
		if (!drag || drag.pointer !== event.pointerId) return;
		this.drag = undefined;
		this.releasePointer();
		this.prose.classList.remove('ash-arkdown-table-selecting');
		this.indicator.hidden = true;
		this.clearMoving();
		if (drag.kind === 'resize') {
			this.restoreResize(drag);
			this.execute({ kind: 'set_column_width', column: drag.column, width: drag.nextWidth }, this.cell);
		} else if (drag.kind === 'table') {
			if (drag.moved && drag.target) this.moveBlock(drag.table, drag.target.offset);
		} else if (drag.kind !== 'cells' && drag.moved && drag.to !== drag.from) {
			this.execute({ kind: drag.kind === 'row' ? 'move_row' : 'move_column', from: drag.from, to: drag.to }, drag.kind === 'row' ? { row: drag.to, column: this.cell.column } : { row: this.cell.row, column: drag.to });
		}
		this.update();
	}

	private startGrip(event: PointerEvent, kind: 'row' | 'column'): void {
		if (event.button !== 0 || !this.table || !this.host.canEdit()) return;
		this.skipClick = false;
		const node = this.host.getNode(this.table), index = kind === 'row' ? this.cell.row : this.cell.column;
		if ((kind === 'row' && node?.tableLayout?.header && index === 0) || node?.tableLayout?.cells.some(cell => cell.rowspan > 1 || cell.colspan > 1)) return;
		this.drag = { kind, table: this.table, pointer: event.pointerId, x: event.clientX, y: event.clientY, from: index, to: index, moved: false };
		this.capturePointer(event);
	}

	private cancelDrag(): void {
		if (this.drag?.kind === 'resize') this.restoreResize(this.drag);
		if (this.drag && this.drag.kind !== 'cells') this.skipClick = true;
		this.drag = undefined;
		this.releasePointer();
		this.indicator.hidden = true;
		this.prose.classList.remove('ash-arkdown-table-selecting');
		this.clearMoving();
	}
	private clearMoving(): void {
		for (const cell of this.prose.querySelectorAll('.ash-arkdown-table-moving')) cell.classList.remove('ash-arkdown-table-moving');
		for (const control of [this.rowGrip, this.columnGrip, this.tableGrip]) control.domNode.classList.remove('dragging');
	}
	private capturePointer(event: PointerEvent): void {
		const element = event.currentTarget as HTMLElement;
		if (element.setPointerCapture && element.isConnected) {
			try { element.setPointerCapture(event.pointerId); this.capturedPointer = { element, pointer: event.pointerId }; }
			catch { /* Synthetic events may not own a live browser pointer. */ }
		}
	}
	private releasePointer(): void {
		const capture = this.capturedPointer; this.capturedPointer = undefined;
		if (capture?.element.hasPointerCapture(capture.pointer)) capture.element.releasePointerCapture(capture.pointer);
	}

	private ensureResizeHandles(count: number): void {
		if (this.resizeHandles.length === count) return;
		this.resizeButtons.clear(); this.resizeHandles = [];
		for (let column = 0; column < count; column++) {
			const label = localize({ bundle: 'ash.docs', key: 'tableResizeColumn' }, 'Resize column {0}', column + 1);
			const control = this.resizeButtons.add(new Button(this.layer, { label: '', ariaLabel: label, title: label, iconOnly: true, presentation: 'quiet' }));
			control.domNode.classList.add('ash-arkdown-table-resize');
			control.domNode.setAttribute('role', 'separator');
			control.domNode.setAttribute('aria-orientation', 'vertical');
			control.domNode.setAttribute('aria-valuemin', '48');
			control.domNode.setAttribute('aria-valuemax', '4000');
			this.resizeHandles.push(control);
			this.resizeButtons.add(addDisposableListener(control.domNode, 'pointerdown', event => {
				if (!this.table || !this.host.canEdit() || event.button !== 0) return;
				this.skipClick = false;
				event.preventDefault(); event.stopPropagation();
				const width = this.columnBounds(this.table, column).width;
				this.drag = { kind: 'resize', table: this.table, pointer: event.pointerId, x: event.clientX, column, width, nextWidth: width, direction: this.prose.ownerDocument.defaultView!.getComputedStyle(this.table).direction === 'rtl' ? -1 : 1, widths: Array.from({ length: this.dimensions(this.table).columns }, (_, index) => this.columnBounds(this.table!, index).width), styles: Array.from(this.table.querySelectorAll('colgroup > col'), col => col.getAttribute('style')), tableStyle: this.table.getAttribute('style') };
				this.capturePointer(event);
			}));
			this.resizeButtons.add(addDisposableListener(control.domNode, 'dblclick', event => { event.preventDefault(); this.execute({ kind: 'set_column_width', column, width: 0 }); }));
			this.resizeButtons.add(addDisposableListener(control.domNode, 'keydown', event => {
				if (event.key === 'Enter' && this.table) {
					event.preventDefault(); event.stopImmediatePropagation(); this.cell = { ...this.cell, column }; this.showMenu(control.domNode); return;
				}
				if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
				if (!this.table || !this.host.canEdit()) return;
				event.preventDefault(); event.stopImmediatePropagation();
				this.execute({ kind: 'set_column_width', column, width: Math.max(48, Math.min(4000, Math.round(this.columnBounds(this.table, column).width + (event.key === 'ArrowRight' ? 1 : -1) * (event.shiftKey ? 16 : 8)))) });
				this.resizeHandles[column]?.focus();
			}));
		}
	}

	private restoreResize(drag: ResizeDrag): void {
		for (const [index, column] of Array.from(drag.table.querySelectorAll('colgroup > col')).entries()) this.restoreStyle(column, drag.styles[index] ?? null);
		this.restoreStyle(drag.table, drag.tableStyle);
	}
	private restoreStyle(element: Element, value: string | null): void { if (value === null) element.removeAttribute('style'); else element.setAttribute('style', value); }
	private position(button: Button, x: number, y: number, width: number, height: number): void {
		Object.assign(button.domNode.style, { left: `${x}px`, top: `${y}px`, width: `${Math.max(0, width)}px`, height: `${Math.max(0, height)}px` });
	}
	private rowBounds(table: HTMLTableElement, row: number): DOMRect { return table.rows[row]?.getBoundingClientRect() ?? table.getBoundingClientRect(); }
	private columnBounds(table: HTMLTableElement, column: number): DOMRect {
		const col = table.querySelectorAll('colgroup > col')[column];
		if (col) { const bounds = col.getBoundingClientRect(); if (bounds.width) return bounds; }
		const cell = this.cellElement(table, 0, column), bounds = cell?.getBoundingClientRect() ?? table.getBoundingClientRect();
		const width = bounds.width / (cell?.colSpan ?? 1), left = bounds.left + (column - Number(cell?.dataset.column ?? column)) * width;
		return new DOMRect(left, bounds.top, width, bounds.height);
	}

	private gripMenu(kind: 'rows' | 'columns', button: Button): void {
		if (!this.table) return;
		const size = this.dimensions(this.table);
		const current = this.selection;
		if (current?.kind !== kind || !this.contains(current, this.table, this.cell)) {
			this.select(this.table, kind === 'rows' ? { row: this.cell.row, column: 0 } : { row: 0, column: this.cell.column }, kind === 'rows' ? { row: this.cell.row, column: size.columns - 1 } : { row: size.rows - 1, column: this.cell.column }, kind);
		}
		this.showMenu(button.domNode, kind);
	}

	private keydown(event: KeyboardEvent): void {
		if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && (event.target as Element).classList.contains('ash-arkdown-table-resize')) return;
		if (event.altKey && event.key === 'F10' && this.table) { event.preventDefault(); event.stopImmediatePropagation(); this.rowGrip.focus(); return; }
		if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown') && this.table && this.tableGrip.domNode.contains(event.target as Node)) {
			event.preventDefault(); event.stopImmediatePropagation();
			const target = this.host.blockTarget(this.table, event.key === 'ArrowUp' ? 'previous' : 'next');
			if (target && this.host.canEdit()) { this.moveBlock(this.table, target.offset); this.tableGrip.focus(); }
			return;
		}
		if ((event.key === 'F10' && event.shiftKey) || event.key === 'ContextMenu') {
			const cell = this.caretCell();
			if (cell) this.activate(cell.table, cell.point);
			if (!this.table) return;
			event.preventDefault(); event.stopImmediatePropagation();
			if (!this.selection) this.select(this.table, this.cell, this.cell);
			this.showMenu(this.cellElement(this.table, this.cell.row, this.cell.column) ?? this.table);
			return;
		}
		if (event.key === 'Escape' && this.selection) {
			event.preventDefault(); event.stopImmediatePropagation();
			const selection = this.selection; this.clearSelection(); this.host.setCaret(selection.table, selection.row, selection.column); this.update(); return;
		}
		if ((event.ctrlKey || event.metaKey) && ['a', 'z', 'y'].includes(event.key.toLowerCase())) { this.clearSelection(); return; }
		if (event.key === 'Tab' && this.selection && this.prose.contains(event.target as Node)) {
			const selection = this.selection; this.clearSelection(); this.host.setCaret(selection.table, selection.focus.row, selection.focus.column);
			return;
		}
		const arrow = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key);
		if (arrow && event.shiftKey && !this.selection) {
			const cell = this.caretCell();
			if (cell && this.atCellEdge(cell.element, event.key)) this.select(cell.table, cell.point, cell.point);
		}
		if (arrow && this.selection) {
			event.preventDefault(); event.stopImmediatePropagation();
			const current = this.selection, size = this.dimensions(current.table), next = { row: Math.max(0, Math.min(size.rows - 1, current.focus.row + (event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0))), column: Math.max(0, Math.min(size.columns - 1, current.focus.column + (event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0))) };
			if (event.shiftKey) this.select(current.table, current.anchor, next);
			else { this.clearSelection(); this.host.setCaret(current.table, next.row, next.column); }
			this.cellElement(current.table, next.row, next.column)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
			return;
		}
		if ((event.key === 'Delete' || event.key === 'Backspace') && this.selection) {
			event.preventDefault(); event.stopImmediatePropagation();
			if (!event.repeat && this.host.canEdit()) { this.suppressDelete = true; this.deleteSelection(); }
		}
	}

	private atCellEdge(cell: HTMLTableCellElement, key: string): boolean {
		const selection = this.prose.ownerDocument.defaultView!.getSelection();
		if (!selection?.isCollapsed || !selection.rangeCount || !cell.contains(selection.focusNode)) return false;
		const caret = selection.getRangeAt(0), before = cell.ownerDocument.createRange(); before.selectNodeContents(cell); before.setEnd(caret.endContainer, caret.endOffset);
		if (key === 'ArrowLeft') return before.toString().length === 0;
		if (key === 'ArrowRight') return before.toString().length === cell.textContent?.length;
		const bounds = caret.getBoundingClientRect(), content = cell.getBoundingClientRect(), line = parseFloat(cell.ownerDocument.defaultView!.getComputedStyle(cell).lineHeight) || 20;
		return key === 'ArrowUp' ? bounds.top - content.top < line : content.bottom - bounds.bottom < line;
	}

	private beforeInput(event: InputEvent): void {
		if (!this.selection || this.composition) return;
		if (!this.host.canEdit()) { event.preventDefault(); event.stopImmediatePropagation(); return; }
		if (event.inputType.startsWith('delete')) { event.preventDefault(); event.stopImmediatePropagation(); this.deleteSelection(); return; }
		if (event.inputType === 'insertParagraph' || event.inputType === 'insertLineBreak') {
			event.preventDefault(); event.stopImmediatePropagation(); this.replaceSelection([['\n']], false); return;
		}
		if (event.inputType.startsWith('insert') && event.data !== null) {
			event.preventDefault(); event.stopImmediatePropagation(); this.replaceSelection([[event.data]], false);
		}
	}

	private deleteSelection(): void {
		const selection = this.selection;
		if (!selection) return;
		const size = this.dimensions(selection.table);
		const action: ArkdownTableAction = selection.kind === 'table' || (selection.row === 0 && selection.bottom === size.rows - 1 && selection.column === 0 && selection.right === size.columns - 1)
			? { kind: 'delete_table' }
			: selection.kind === 'rows' || (selection.column === 0 && selection.right === size.columns - 1) ? { kind: 'delete_rows', from: selection.row, to: selection.bottom }
				: selection.kind === 'columns' || (selection.row === 0 && selection.bottom === size.rows - 1) ? { kind: 'delete_columns', from: selection.column, to: selection.right }
					: { kind: 'clear_cells', ...this.rectangle(selection) };
		this.execute(action, { row: selection.row, column: selection.column }, false);
		this.clearSelection();
	}

	private replaceSelection(values: readonly (readonly string[])[], tile: boolean, cells?: readonly ArkdownTableCellLayout[]): void {
		const table = this.selection?.table ?? this.table;
		if (!table) return;
		const selection = this.selection, start = selection ? { row: selection.row, column: selection.column } : this.cell;
		if (selection && (selection.bottom > selection.row || selection.right > selection.column)) {
			const height = selection.bottom - selection.row + 1, width = selection.right - selection.column + 1, sourceHeight = values.length, sourceWidth = values[0]?.length || 1;
			values = Array.from({ length: height }, (_, row) => Array.from({ length: width }, (_, column) => tile ? values[row % sourceHeight]?.[column % sourceWidth] ?? '' : row === 0 && column === 0 ? values[0]?.[0] ?? '' : ''));
			if (tile && cells) {
				const repeated: ArkdownTableCellLayout[] = [];
				for (let r = 0; r < height; r += sourceHeight) for (let c = 0; c < width; c += sourceWidth) for (const cell of cells) {
					const row = r + cell.row, column = c + cell.column;
					if (row < height && column < width) repeated.push({ ...cell, row, column, rowspan: Math.min(cell.rowspan, height - row), colspan: Math.min(cell.colspan, width - column) });
				}
				cells = repeated;
			} else if (!tile) {
				cells = this.host.getNode(table)?.tableLayout?.cells.filter(cell => cell.row >= start.row && cell.column >= start.column && cell.row + cell.rowspan <= start.row + height && cell.column + cell.colspan <= start.column + width).map(cell => ({ ...cell, row: cell.row - start.row, column: cell.column - start.column }));
			}
		}
		this.execute({ kind: 'paste_cells', row: start.row, column: start.column, values, ...(cells ? { cells } : {}) }, start, false);
		this.clearSelection();
	}

	private copyEvent(event: ClipboardEvent, cut: boolean): void {
		if (!this.selection) return;
		event.preventDefault(); event.stopImmediatePropagation();
		const data = this.copyData(this.selection);
		event.clipboardData?.setData('text/plain', data.text); event.clipboardData?.setData('text/html', data.html);
		if (cut && this.host.canEdit()) this.execute({ kind: 'clear_cells', ...this.rectangle(this.selection) });
	}

	private copyData(selection: CellSelection): { text: string; html: string; } {
		const table = selection.table.ownerDocument.createElement('table'), rows: string[][] = [];
		const layout = this.host.getNode(selection.table)?.tableLayout;
		for (let row = selection.row; row <= selection.bottom; row++) {
			const tr = table.insertRow(), text: string[] = [];
			for (let column = selection.column; column <= selection.right; column++) {
				const source = this.cellElement(selection.table, row, column), value = source && Number(source.dataset.row) === row && Number(source.dataset.column) === column ? source.textContent ?? '' : '';
				if (!source || (Number(source.dataset.row) === row && Number(source.dataset.column) === column)) {
					const cell = source?.tagName === 'TH' ? tr.appendChild(table.ownerDocument.createElement('th')) : tr.insertCell(); cell.textContent = value;
					if (source) { cell.colSpan = Math.min(source.colSpan, selection.right - column + 1); cell.rowSpan = Math.min(source.rowSpan, selection.bottom - row + 1); }
					const color = layout?.cells.find(cell => cell.row === row && cell.column === column)?.color;
					if (color) cell.setAttribute('data-ash-table-color', color);
				}
				text.push(value.replace(/\t/gu, ' ').replace(/\r?\n/gu, ' '));
			}
			rows.push(text);
		}
		return { text: rows.map(row => row.join('\t')).join('\n'), html: table.outerHTML };
	}

	private pasteEvent(event: ClipboardEvent): void {
		if (!this.host.canEdit()) { if (this.selection) { event.preventDefault(); event.stopImmediatePropagation(); } return; }
		const cell = this.caretCell(); if (!this.selection && cell) this.activate(cell.table, cell.point);
		if (!this.table) return;
		const data = event.clipboardData, text = data?.getData('text/plain') ?? '', html = data?.getData('text/html') ?? '';
		if (!this.selection && !text.includes('\t') && !/<table[\s>]/iu.test(html)) return;
		event.preventDefault(); event.stopImmediatePropagation();
		try {
			if (text.length > maxClipboardBytes || html.length > maxClipboardBytes) throw new Error(localize({ bundle: 'ash.docs', key: 'tablePasteTooLarge' }, 'The pasted table is too large.'));
			let values: string[][] | undefined;
			let cells: ArkdownTableCellLayout[] | undefined;
			if (/<table[\s>]/iu.test(html)) {
				const template = this.prose.ownerDocument.createElement('template'); template.innerHTML = html;
				const table = template.content.querySelector('table');
				if (table) {
					values = []; cells = [];
					for (const [row, tr] of Array.from(table.rows).entries()) {
						values[row] ??= []; let column = 0;
						for (const cell of Array.from(tr.cells)) {
							while (values[row][column] !== undefined) column++;
							const rowspan = cell.rowSpan === 0 ? Math.max(1, table.rows.length - row) : cell.rowSpan, colspan = cell.colSpan;
							if ((row + rowspan) * (column + colspan) > maxClipboardCells) throw new Error(localize({ bundle: 'ash.docs', key: 'tablePasteTooLarge' }, 'The pasted table is too large.'));
							for (let r = 0; r < rowspan; r++) { values[row + r] ??= []; for (let c = 0; c < colspan; c++) values[row + r][column + c] = r === 0 && c === 0 ? cell.textContent ?? '' : ''; }
							const rawColor = cell.getAttribute('data-ash-table-color'), color = tableColors.find(color => color === rawColor);
							if (rowspan > 1 || colspan > 1 || color) cells.push({ row, column, rowspan, colspan, ...(color ? { color } : {}) });
							column += colspan;
						}
					}
				}
			}
			values ??= text.includes('\t') ? text.replace(/\r\n?/gu, '\n').replace(/\n$/u, '').split('\n').map(row => row.split('\t')) : [[text]];
			const width = Math.max(1, ...values.map(row => row.length));
			if (values.length * width > maxClipboardCells) throw new Error(localize({ bundle: 'ash.docs', key: 'tablePasteTooLarge' }, 'The pasted table is too large.'));
			this.replaceSelection(values.map(row => Array.from({ length: width }, (_, index) => row[index] ?? '')), text.includes('\t') || !!values && /<table[\s>]/iu.test(html), cells);
		} catch (error) { this.host.onError(error); }
	}

	private execute(action: ArkdownTableAction, target = this.cell, preserve = true): void {
		if (!this.table || !this.host.canEdit()) return;
		const old = this.selection;
		try {
			this.applying = true;
			const table = this.host.apply(this.table, action, target);
			this.table = table;
			this.cell = target;
			const retain = ['set_column_width', 'set_column_alignment', 'set_cell_color', 'clear_cells', 'toggle_header', 'merge_cells', 'split_cell'].includes(action.kind);
			if (old && table && preserve && retain) this.selection = { ...old, table };
			else this.clearSelection();
			if (!table) this.layer.hidden = true;
		} catch (error) { this.host.onError(error); }
		finally { this.applying = false; this.update(); }
	}

	private moveBlock(table: HTMLTableElement, offset: number): void {
		if (!this.host.canEdit()) return;
		try {
			this.applying = true;
			this.clearSelection();
			this.table = this.host.moveBlock(table, offset);
			this.cell = { row: 0, column: 0 };
		} catch (error) { this.host.onError(error); }
		finally { this.applying = false; this.update(); }
	}

	private showMenu(anchor: Element | { x: number; y: number; targetWindow: Window; }, kind?: 'rows' | 'columns'): void {
		if (!this.table) return;
		this.menuVisible = true;
		this.hoverCell = undefined;
		const button = [this.rowGrip, this.columnGrip, this.tableMenu].find(button => button.domNode === anchor);
		button?.domNode.setAttribute('aria-expanded', 'true');
		this.update();
		this.menus.showContextMenu({
			getAnchor: () => anchor, getActions: () => {
				const actions = this.actions();
				if (!kind) return actions;
				const ids = kind === 'rows' ? ['insertRowAbove', 'insertRowBelow', 'deleteRows'] : ['insertColumnLeft', 'insertColumnRight', 'width', 'deleteColumns'];
				return actions.filter(action => ids.some(id => action.id === `sessions.docs.table.${id}`));
			}, getMenuClassName: () => 'ash-docs-format-menu ash-docs-table-menu', submenuClassName: 'ash-docs-format-menu ash-docs-table-menu',
			iconPlacement: 'leading-with-trailing-check', autoSelectFirstItem: true,
			onHide: cancelled => {
				this.menuVisible = false;
				button?.domNode.setAttribute('aria-expanded', 'false');
				if (cancelled && this.selection?.kind === 'cells' && this.selection.row === this.selection.bottom && this.selection.column === this.selection.right) this.clearSelection();
				if (this.table?.isConnected) { this.prose.focus({ preventScroll: true }); if (!this.selection) this.host.setCaret(this.table, this.cell.row, this.cell.column); this.update(); }
			},
		});
	}

	private actions(): readonly IAction[] {
		const table = this.table;
		if (!table) return [];
		const node = this.host.getNode(table), size = this.dimensions(table), selection = this.selection;
		const row = selection?.row ?? this.cell.row, column = selection?.column ?? this.cell.column, bottom = selection?.bottom ?? row, right = selection?.right ?? column;
		const rect = { top: row, left: column, bottom, right }, editable = this.host.canEdit();
		const action = (id: string, label: string, operation: ArkdownTableAction, icon?: Icon, enabled = editable, checked?: boolean): IAction => ({ id: `sessions.docs.table.${id}`, label, tooltip: label, icon, enabled, checked, run: () => { this.execute(operation); } });
		const command = (id: string, label: string, run: () => unknown, icon?: Icon, enabled = editable): IAction => ({ id: `sessions.docs.table.${id}`, label, tooltip: label, icon, enabled, run: async () => { try { await run(); } catch (error) { this.host.onError(error); } } });
		const merged = node?.tableLayout?.cells.some(cell => cell.rowspan > 1 || cell.colspan > 1);
		const minRow = node?.tableLayout?.header ? 1 : 0;
		const moves = [
			action('moveRowUp', localize({ bundle: 'ash.docs', key: 'tableMoveRowUp' }, 'Move row up'), { kind: 'move_row', from: row, to: row - 1 }, Lxicon.arrowUp, editable && row > minRow && row === bottom && !merged),
			action('moveRowDown', localize({ bundle: 'ash.docs', key: 'tableMoveRowDown' }, 'Move row down'), { kind: 'move_row', from: row, to: row + 1 }, Lxicon.arrowDown, editable && row >= minRow && row === bottom && row < size.rows - 1 && !merged),
			action('moveColumnLeft', localize({ bundle: 'ash.docs', key: 'tableMoveColumnLeft' }, 'Move column left'), { kind: 'move_column', from: column, to: column - 1 }, Lxicon.arrowLeft, editable && column > 0 && column === right && !merged),
			action('moveColumnRight', localize({ bundle: 'ash.docs', key: 'tableMoveColumnRight' }, 'Move column right'), { kind: 'move_column', from: column, to: column + 1 }, Lxicon.arrowRight, editable && column < size.columns - 1 && column === right && !merged),
		];
		const widths = [
			{ width: 112, label: localize({ bundle: 'ash.docs', key: 'tableWidthNarrow' }, 'Narrow') },
			{ width: 224, label: localize({ bundle: 'ash.docs', key: 'tableWidthMedium' }, 'Medium') },
			{ width: 336, label: localize({ bundle: 'ash.docs', key: 'tableWidthWide' }, 'Wide') },
			{ width: 672, label: localize({ bundle: 'ash.docs', key: 'tableWidthExtraWide' }, 'Extra wide') },
			{ width: 0, label: localize({ bundle: 'ash.docs', key: 'tableWidthAuto' }, 'Auto') },
		].map(preset => action(`width${preset.width}`, preset.label, { kind: 'set_column_width', column, end_column: right, width: preset.width }, undefined, editable, Array.from({ length: right - column + 1 }, (_, index) => node?.tableLayout?.widths[column + index] ?? 0).every(value => value === preset.width)));
		widths.push(command('widthCustom', localize({ bundle: 'ash.docs', key: 'tableWidthCustom' }, 'Custom width…'), async () => {
			const result = await this.dialogs.input({ title: localize({ bundle: 'ash.docs', key: 'tableColumnWidth' }, 'Column width'), message: localize({ bundle: 'ash.docs', key: 'tableWidthPrompt' }, 'Enter a width from 48 to 4000 pixels.'), inputs: [{ value: String(Math.round(this.columnBounds(table, column).width)) }] });
			if (!result.confirmed || this.isDisposed || this.table !== table || !this.host.canEdit()) return;
			const value = Number(result.values?.[0]);
			if (!Number.isInteger(value) || value < 48 || value > 4000) { this.host.onError(new Error(localize({ bundle: 'ash.docs', key: 'tableInvalidWidth' }, 'Enter a whole number from 48 to 4000.'))); return; }
			this.execute({ kind: 'set_column_width', column, end_column: right, width: value });
		}));
		const colors: readonly { color?: ArkdownTableColor; label: string; }[] = [
			{ label: localize({ bundle: 'ash.docs', key: 'tableColorNone' }, 'None') },
			{ color: 'gray', label: localize({ bundle: 'ash.docs', key: 'tableColorGray' }, 'Gray') },
			{ color: 'red', label: localize({ bundle: 'ash.docs', key: 'red' }, 'Red') },
			{ color: 'orange', label: localize({ bundle: 'ash.docs', key: 'tableColorOrange' }, 'Orange') },
			{ color: 'yellow', label: localize({ bundle: 'ash.docs', key: 'yellow' }, 'Yellow') },
			{ color: 'green', label: localize({ bundle: 'ash.docs', key: 'green' }, 'Green') },
			{ color: 'blue', label: localize({ bundle: 'ash.docs', key: 'tableColorBlue' }, 'Blue') },
			{ color: 'purple', label: localize({ bundle: 'ash.docs', key: 'purple' }, 'Purple') },
		];
		const cell = this.cellElement(table, row, column), canSplit = !!cell && (cell.colSpan > 1 || cell.rowSpan > 1);
		const selectedColors: (ArkdownTableColor | undefined)[] = [];
		for (let r = row; r <= bottom; r++) for (let c = column; c <= right; c++) {
			const owner = this.cellElement(table, r, c);
			selectedColors.push(node?.tableLayout?.cells.find(cell => cell.row === Number(owner?.dataset.row ?? r) && cell.column === Number(owner?.dataset.column ?? c))?.color);
		}
		return [
			command('copy', localize({ bundle: 'ash.docs', key: 'tableCopyCells' }, 'Copy cells'), async () => {
				const data = this.copyData(selection ?? { table, row, column, bottom, right, anchor: { row, column }, focus: { row: bottom, column: right }, kind: 'cells' });
				try { if (this.clipboard.writeTextWithHtml) await this.clipboard.writeTextWithHtml(data.text, Promise.resolve(data.html)); else await this.clipboard.writeText(data.text); }
				catch (error) { this.host.onError(error); }
			}, Lxicon.copy, true),
			new Separator(),
			action('insertRowAbove', localize({ bundle: 'ash.docs', key: 'tableInsertRowAbove' }, 'Insert row above'), { kind: 'insert_row', index: row }, Lxicon.add),
			action('insertRowBelow', localize({ bundle: 'ash.docs', key: 'tableInsertRowBelow' }, 'Insert row below'), { kind: 'insert_row', index: bottom + 1 }, Lxicon.add),
			action('insertColumnLeft', localize({ bundle: 'ash.docs', key: 'tableInsertColumnLeft' }, 'Insert column left'), { kind: 'insert_column', index: column }, Lxicon.add),
			action('insertColumnRight', localize({ bundle: 'ash.docs', key: 'tableInsertColumnRight' }, 'Insert column right'), { kind: 'insert_column', index: right + 1 }, Lxicon.add),
			new SubmenuAction('sessions.docs.table.move', localize({ bundle: 'ash.docs', key: 'tableMove' }, 'Move row or column'), moves, Lxicon.arrowSwap),
			new SubmenuAction('sessions.docs.table.width', localize({ bundle: 'ash.docs', key: 'tableSetColumnWidth' }, 'Set column width'), widths, Lxicon.arrowSwap),
			new Separator(),
			action('sortAscending', localize({ bundle: 'ash.docs', key: 'tableSortAscending' }, 'Sort column ascending'), { kind: 'sort_column', column, direction: 'ascending' }, Lxicon.arrowUp, editable && size.rows > (node?.tableLayout?.header ? 2 : 1) && !merged),
			action('sortDescending', localize({ bundle: 'ash.docs', key: 'tableSortDescending' }, 'Sort column descending'), { kind: 'sort_column', column, direction: 'descending' }, Lxicon.arrowDown, editable && size.rows > (node?.tableLayout?.header ? 2 : 1) && !merged),
			new Separator(),
			...(['left', 'center', 'right'] as const).map(alignment => action(`align${alignment}`, alignment === 'left' ? localize({ bundle: 'ash.docs', key: 'tableAlignLeft' }, 'Align left') : alignment === 'center' ? localize({ bundle: 'ash.docs', key: 'tableAlignCenter' }, 'Align center') : localize({ bundle: 'ash.docs', key: 'tableAlignRight' }, 'Align right'), { kind: 'set_column_alignment', from: column, to: right, alignment }, { left: Lxicon.alignLeft, center: Lxicon.alignCenter, right: Lxicon.alignRight }[alignment], editable, node?.alignments?.slice(column, right + 1).every(value => value === alignment))),
			new SubmenuAction('sessions.docs.table.color', localize({ bundle: 'ash.docs', key: 'tableCellColor' }, 'Cell color'), colors.map(({ color, label }) => ({ ...action(`color${color ?? 'none'}`, label, { kind: 'set_cell_color', ...rect, color }, color ? Lxicon.primitiveSquareFilled : Lxicon.primitiveSquare, editable, selectedColors.every(value => value === color)), iconColor: color ? `var(--ash-sessions-docs-cell${color[0].toUpperCase()}${color.slice(1)})` : undefined })), Lxicon.symbolColor),
			action('merge', localize({ bundle: 'ash.docs', key: 'tableMergeCells' }, 'Merge cells'), { kind: 'merge_cells', ...rect }, Lxicon.sheets, editable && (bottom > row || right > column)),
			action('split', localize({ bundle: 'ash.docs', key: 'tableSplitCell' }, 'Split cell'), { kind: 'split_cell', row, column }, Lxicon.splitHorizontal, editable && canSplit),
			action('header', localize({ bundle: 'ash.docs', key: 'tableHeaderRow' }, 'Header row'), { kind: 'toggle_header' }, Lxicon.sheets, editable, node?.tableLayout?.header ?? true),
			new Separator(),
			action('deleteRows', localize({ bundle: 'ash.docs', key: 'tableDeleteRow' }, 'Delete row'), { kind: 'delete_rows', from: row, to: bottom }, Lxicon.trash),
			action('deleteColumns', localize({ bundle: 'ash.docs', key: 'tableDeleteColumn' }, 'Delete column'), { kind: 'delete_columns', from: column, to: right }, Lxicon.trash),
			action('deleteTable', localize({ bundle: 'ash.docs', key: 'tableDeleteTable' }, 'Delete table'), { kind: 'delete_table' }, Lxicon.trash),
		];
	}
}
