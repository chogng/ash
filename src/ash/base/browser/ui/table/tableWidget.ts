import './table.css';
import { addDisposableListener, h } from '../../dom.js';
import { observeElementSize } from '../../observer.js';
import { AnimationFrameScheduler } from '../../scheduler.js';
import { Emitter } from '../../../common/event.js';
import { Disposable, toDisposable } from '../../../common/lifecycle.js';
import { ListView } from '../list/listView.js';
import type { ListScrolling } from '../list/list.js';
import { SplitView } from '../splitview/splitview.js';
import { TableError, type ITableColumn, type ITableEvent, type ITableRenderer, type ITableVirtualDelegate } from './table.js';

export interface ITableOptions<TRow> {
	readonly ariaLabel?: string;
	readonly identityProvider?: { getId(element: TRow): string; };
	readonly accessibilityProvider?: { getAriaLabel(element: TRow): string; };
	readonly scrolling?: ListScrolling;
}

interface RowRecord<T> {
	readonly id: string;
	element: T;
}

interface CellTemplate {
	readonly container: HTMLElement;
	readonly renderer: ITableRenderer<unknown, unknown>;
	readonly data: unknown;
	element: unknown;
}

/** Column layout and grid interaction share one retained ListView row lifecycle. */
export class Table<TRow> extends Disposable {
	public readonly domNode: HTMLElement;
	private readonly header: SplitView;
	private readonly view: ListView<RowRecord<TRow>>;
	private readonly templates = new Map<HTMLElement, CellTemplate[]>();
	private readonly columnWidths: number[] = [];
	private readonly focusChanged = this._register(new Emitter<ITableEvent<TRow>>());
	private readonly selectionChanged = this._register(new Emitter<ITableEvent<TRow>>());
	public readonly onDidChangeFocus = this.focusChanged.event;
	public readonly onDidChangeSelection = this.selectionChanged.event;
	private focusedIndex = -1;
	private selectedIndexes: number[] = [];
	private width = 0;
	private sequence = 0;
	private initializedWidths = false;

	constructor(user: string, container: HTMLElement, private readonly virtualDelegate: ITableVirtualDelegate<TRow>, private readonly columns: readonly ITableColumn<TRow, unknown>[], renderers: readonly ITableRenderer<unknown, unknown>[], private readonly options: ITableOptions<TRow> = {}) {
		super();
		const rendererById = new Map(renderers.map(renderer => [renderer.templateId, renderer]));
		for (const column of columns) {
			if (!rendererById.has(column.templateId)) {
				throw new TableError(user, `Missing renderer: ${column.templateId}`);
			}
		}
		const document = container.ownerDocument;
		this.domNode = h(document, 'div');
		this.domNode.className = 'ash-table';
		this.domNode.tabIndex = 0;
		this.domNode.setAttribute('role', 'grid');
		this.domNode.setAttribute('aria-colcount', String(columns.length));
		if (options.ariaLabel) {
			this.domNode.setAttribute('aria-label', options.ariaLabel);
		}
		container.append(this.domNode);
		this._register(toDisposable(() => this.domNode.remove()));
		const headerContainer = h(document, 'div');
		headerContainer.className = 'ash-table-header';
		headerContainer.setAttribute('role', 'row');
		headerContainer.setAttribute('aria-rowindex', '1');
		headerContainer.style.height = `${virtualDelegate.headerRowHeight}px`;
		this.domNode.append(headerContainer);
		this.header = this._register(new SplitView(headerContainer, 'horizontal'));
		for (const [index, column] of columns.entries()) {
			const label = h(document, 'div');
			label.className = 'ash-table-column-header';
			label.textContent = column.label;
			label.title = column.tooltip ?? column.label;
			label.setAttribute('role', 'columnheader');
			label.setAttribute('aria-colindex', String(index + 1));
			this.header.addView({
				element: label,
				get minimumSize() { return column.minimumWidth ?? 120; },
				get maximumSize() { return column.maximumWidth ?? Number.POSITIVE_INFINITY; },
				onDidChange: column.onDidChangeWidthConstraints ? listener => column.onDidChangeWidthConstraints!(() => listener(undefined)) : undefined,
				layout: size => {
					this.columnWidths[index] = size;
					for (const cells of this.templates.values()) {
						cells[index]!.container.style.width = `${size}px`;
					}
				},
			}, column.weight);
		}
		this.view = this._register(new ListView(this.domNode, {
			role: 'rowgroup',
			scrolling: options.scrolling ?? 'external',
			getId: record => record.id,
			getHeight: record => virtualDelegate.getHeight(record.element),
			accessibilityProvider: { getRole: () => 'row', getAriaLabel: record => options.accessibilityProvider?.getAriaLabel(record.element) },
			reuseRows: true,
			renderItem: (record, index, row) => {
				row.classList.add('ash-table-row');
				const contents = h(document, 'div');
				contents.className = 'ash-table-row-cells';
				contents.setAttribute('role', 'presentation');
				const cells = columns.map((column, columnIndex) => {
					const cell = h(document, 'div');
					cell.className = 'ash-table-cell';
					cell.setAttribute('role', 'gridcell');
					cell.setAttribute('aria-colindex', String(columnIndex + 1));
					cell.tabIndex = -1;
					cell.style.width = `${this.columnWidths[columnIndex]}px`;
					contents.append(cell);
					const renderer = rendererById.get(column.templateId)!;
					return { container: cell, renderer, data: renderer.renderTemplate(cell), element: undefined };
				});
				this.templates.set(row, cells);
				this.renderRow(record, index, row);
				return contents;
			},
			updateItem: (record, index, row) => this.renderRow(record, index, row),
			onDidRemoveRow: row => {
				for (const cell of this.templates.get(row)!) {
					cell.renderer.disposeElement?.(cell.element, Number(row.dataset.index), cell.data);
					cell.renderer.disposeTemplate(cell.data);
				}
				this.templates.delete(row);
			},
		}));
		this.view.domNode.classList.add('ash-table-body');
		this._register(this.view.onDidRenderRows(() => this.updateTraits()));
		this._register(addDisposableListener(this.domNode, 'keydown', event => this.handleKeyDown(event)));
		this._register(addDisposableListener(this.domNode, 'focusin', event => {
			const row = (event.target as HTMLElement).closest<HTMLElement>('.ash-table-row');
			if (row && this.domNode.contains(row)) {
				this.setFocus([Number(row.dataset.index)]);
			}
		}));
		this._register(addDisposableListener(this.domNode, 'click', event => {
			const row = (event.target as HTMLElement).closest<HTMLElement>('.ash-table-row');
			if (!row || !this.domNode.contains(row)) {
				return;
			}
			const index = Number(row.dataset.index);
			this.setFocus([index], event);
			if (!(event.target as HTMLElement).closest('button,input,select,a')) {
				this.setSelection([index], event);
				row.focus();
			}
		}));
		this._register(this.header.onDidSashReset(index => this.resizeColumn(index, columns[index]!.weight / columns.reduce((sum, column) => sum + column.weight, 0) * 100)));
		let observedWidth = 0;
		const resizeLayout = this._register(new AnimationFrameScheduler(document.defaultView!, () => this.layout(undefined, observedWidth)));
		// Column sizing can change horizontal overflow and ancestor heights; write outside resize observation.
		this._register(observeElementSize(this.domNode, size => {
			if (size.width === observedWidth) { return; }
			observedWidth = size.width;
			resizeLayout.schedule();
		}, { box: 'content-box' }));
	}

	public get length(): number { return this.view.items.length; }
	public row(index: number): TRow { return this.view.items[index]!.element; }
	public getColumnLabels(): string[] { return this.columns.map(column => column.label); }
	public getFocus(): number[] { return this.focusedIndex < 0 ? [] : [this.focusedIndex]; }
	public getSelection(): number[] { return [...this.selectedIndexes]; }

	public splice(start: number, deleteCount: number, elements: readonly TRow[] = []): void {
		const activeElement = this.domNode.ownerDocument.activeElement;
		const hadFocus = this.domNode.contains(activeElement);
		const previous = new Map(this.view.items.map(record => [record.id, record]));
		const focusedId = this.view.items[this.focusedIndex]?.id;
		const selectedIds = new Set(this.selectedIndexes.map(index => this.view.items[index]!.id));
		const records = elements.map(element => {
			const id = this.options.identityProvider?.getId(element) ?? String(this.sequence++);
			const record = previous.get(id) ?? { id, element };
			return record;
		});
		// Reconcile values before rendering while retaining each identity's DOM and templates.
		for (const [index, record] of records.entries()) {
			record.element = elements[index]!;
		}
		this.view.splice(start, deleteCount, records);
		const focused = this.view.items.findIndex(record => record.id === focusedId);
		this.setFocus(this.length ? [focused < 0 ? Math.min(Math.max(this.focusedIndex, 0), this.length - 1) : focused] : []);
		this.setSelection(this.view.items.flatMap((record, index) => selectedIds.has(record.id) ? [index] : []));
		this.domNode.setAttribute('aria-rowcount', String(this.length + 1));
		this.updateTraits();
		this.domNode.tabIndex = this.length ? -1 : 0;
		if (hadFocus && !this.domNode.contains(this.domNode.ownerDocument.activeElement)) { this.domFocus(); }
	}

	public rerender(): void {
		for (let index = 0; index < this.length; index++) {
			this.view.rerender(index);
		}
	}

	public layout(height?: number, width = this.domNode.clientWidth): void {
		this.width = Math.max(width, this.columns.reduce((sum, column) => sum + (column.minimumWidth ?? 120), 0));
		this.header.element.style.width = `${this.width}px`;
		this.view.domNode.style.width = `${this.width}px`;
		this.header.layout(this.width, this.virtualDelegate.headerRowHeight);
		if (!this.initializedWidths && width > 0) {
			this.initializedWidths = true;
			const totalWeight = this.columns.reduce((sum, column) => sum + column.weight, 0);
			for (const [index, column] of this.columns.entries()) { this.resizeColumn(index, column.weight / totalWeight * 100); }
		}
		if (height !== undefined) {
			this.view.layout(Math.max(0, height - this.virtualDelegate.headerRowHeight));
		}
	}

	public resizeColumn(index: number, percentage: number): void {
		this.header.resizeView(index, this.width * percentage / 100);
	}

	public setFocus(indexes: number[], browserEvent?: UIEvent): void {
		const index = indexes[0] ?? -1;
		if (index === this.focusedIndex) {
			return;
		}
		this.focusedIndex = index;
		this.updateTraits();
		this.focusChanged.fire({ indexes: this.getFocus(), elements: index < 0 ? [] : [this.row(index)], browserEvent });
	}

	public setSelection(indexes: number[], browserEvent?: UIEvent): void {
		if (indexes.length === this.selectedIndexes.length && indexes.every((index, position) => index === this.selectedIndexes[position])) {
			return;
		}
		this.selectedIndexes = [...indexes];
		this.updateTraits();
		this.selectionChanged.fire({ indexes: this.getSelection(), elements: indexes.map(index => this.row(index)), browserEvent });
	}

	public domFocus(): void {
		if (this.focusedIndex < 0 && this.length) { this.setFocus([0]); }
		(this.view.row(this.focusedIndex) ?? this.domNode).focus();
	}

	private renderRow(record: RowRecord<TRow>, index: number, row: HTMLElement): void {
		row.setAttribute('aria-rowindex', String(index + 2));
		for (const [columnIndex, cell] of this.templates.get(row)!.entries()) {
			cell.element = this.columns[columnIndex]!.project(record.element);
			cell.renderer.renderElement(cell.element, index, cell.data);
		}
	}

	private updateTraits(): void {
		for (const row of this.templates.keys()) {
			const index = Number(row.dataset.index);
			row.tabIndex = index === this.focusedIndex ? 0 : -1;
			row.classList.toggle('focused', index === this.focusedIndex);
			row.classList.toggle('selected', this.selectedIndexes.includes(index));
			row.setAttribute('aria-selected', String(this.selectedIndexes.includes(index)));
		}
	}

	private handleKeyDown(event: KeyboardEvent): void {
		const target = event.target as HTMLElement;
		if (target.closest('input,textarea,select') || !target.closest('.ash-table-row')) {
			return;
		}
		const column = target.closest<HTMLElement>('.ash-table-cell');
		const columnIndex = column ? Number(column.getAttribute('aria-colindex')) - 1 : -1;
		let next = this.focusedIndex;
		switch (event.key) {
			case 'ArrowDown': next = Math.min(next + 1, this.length - 1); break;
			case 'ArrowUp': next = Math.max(next - 1, 0); break;
			case 'Home': next = 0; break;
			case 'End': next = this.length - 1; break;
			case 'ArrowLeft':
			case 'ArrowRight': {
				const cells = this.templates.get(this.view.row(next)!)!;
				const index = Math.max(0, Math.min(columnIndex + (event.key === 'ArrowLeft' ? -1 : 1), cells.length - 1));
				cells[index]!.container.focus();
				event.preventDefault();
				return;
			}
			case 'Enter':
			case ' ': {
				if (target.closest('button,a')) {
					return;
				}
				this.setSelection([next], event);
				event.preventDefault();
				return;
			}
			default: return;
		}
		event.preventDefault();
		this.setFocus([next], event);
		this.view.reveal(next);
		const row = this.view.row(next)!;
		if (columnIndex < 0) {
			row.focus();
		} else {
			this.templates.get(row)![columnIndex]!.container.focus();
		}
	}
}
