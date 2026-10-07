import { addDisposableListener, getWindow, isHTMLElement, stopEvent } from "../../dom.js";
import { equals } from "../../../common/arrays.js";
import { Emitter, type Event } from "../../../common/event.js";
import { Disposable, MutableDisposable, type IDisposable } from "../../../common/lifecycle.js";
import { disposableWindowTimeout } from '../../scheduler.js';
import { rot } from "../../../common/numbers.js";
import { isMacintosh } from "../../../common/platform.js";
import { setAriaAttribute } from "../aria/aria.js";
import type { IKeyboardNavigationLabelProvider, ListAccessibilityProvider, ListDragAndDrop, ListScrolling } from "./list.js";
import { ListView } from "./listView.js";

export interface ListOptions<T> {
	readonly ariaLabel?: string;
	readonly role?: "listbox" | "tree";
	readonly scrolling?: ListScrolling;
	readonly smoothScrolling?: boolean;
	readonly loopNavigation?: boolean;
	readonly keyboardNavigation?: boolean;
	readonly mouseSupport?: boolean;
	readonly keyboardNavigationLabelProvider?: IKeyboardNavigationLabelProvider<T>;
	readonly multipleSelectionSupport?: boolean;
	readonly focusOnMouseMove?: boolean;
	readonly acceptOnClick?: boolean;
	readonly domFocusable?: boolean;
	readonly getId?: (item: T) => string;
	readonly getHeight?: (item: T) => number;
	readonly dnd?: ListDragAndDrop<T>;
	readonly accessibilityProvider?: ListAccessibilityProvider<T>;
	readonly renderItem: (item: T, index: number, row: HTMLDivElement) => HTMLElement;
	readonly reuseRows?: boolean;
	readonly updateItem?: (item: T, index: number, row: HTMLDivElement, rerender: boolean) => void;
	readonly onDidRemoveRow?: (row: HTMLDivElement) => void;
}

export interface ListActiveChangeEvent<T> {
	readonly item: T | undefined;
	readonly index: number;
	readonly rowId: string | undefined;
	readonly browserEvent?: UIEvent;
}

export interface ListSelectionChangeEvent<T> {
	readonly items: readonly T[];
	readonly indexes: readonly number[];
	readonly browserEvent?: UIEvent;
}

export interface ListPointerEvent<T> {
	readonly item: T;
	readonly index: number;
	readonly browserEvent: MouseEvent;
}

export interface ListAcceptEvent<T> {
	readonly item: T;
	readonly index: number;
	readonly browserEvent: MouseEvent | KeyboardEvent | undefined;
}

/** Selection, focus, keyboard, and pointer semantics over a flat ListView. */
export class List<T> extends Disposable {
	readonly element: HTMLDivElement;
	readonly domNode: HTMLDivElement;
	private readonly view: ListView<T>;
	private readonly loopNavigation: boolean;
	private readonly _onDidChangeActive = this._register(new Emitter<ListActiveChangeEvent<T>>());
	private readonly _onDidChangeSelection = this._register(new Emitter<ListSelectionChangeEvent<T>>());
	private readonly _onPointer = this._register(new Emitter<ListPointerEvent<T>>());
	private readonly _onDidDoubleClick = this._register(new Emitter<ListPointerEvent<T>>());
	private readonly _onDidAccept = this._register(new Emitter<ListAcceptEvent<T>>());
	private _activeIndex = -1;
	private _selectionIndexes: readonly number[] = [];
	private selectionAnchor: number | undefined;
	private navigationPrefix = '';
	private readonly navigationTimer = this._register(new MutableDisposable<IDisposable>());

	readonly onDidChangeActive: Event<ListActiveChangeEvent<T>> = this._onDidChangeActive.event;
	readonly onDidChangeFocus: Event<ListActiveChangeEvent<T>> = this._onDidChangeActive.event;
	readonly onDidChangeSelection: Event<ListSelectionChangeEvent<T>> = this._onDidChangeSelection.event;
	readonly onPointer: Event<ListPointerEvent<T>> = this._onPointer.event;
	readonly onDidDoubleClick: Event<ListPointerEvent<T>> = this._onDidDoubleClick.event;
	readonly onDidAccept: Event<ListAcceptEvent<T>> = this._onDidAccept.event;
	readonly onDidScroll: Event<number>;
	readonly onDidRenderRows: Event<void>;

	constructor(container: HTMLElement, private readonly options: ListOptions<T>) {
		super();
		this.loopNavigation = options.loopNavigation ?? true;
		this.view = this._register(new ListView(container, {
			ariaLabel: options.ariaLabel,
			role: options.role,
			scrolling: options.scrolling,
			smoothScrolling: options.smoothScrolling,
			domFocusable: options.domFocusable,
			getId: options.getId,
			getHeight: options.getHeight,
			dnd: options.dnd,
			getDragElements: (item, index) => this._selectionIndexes.includes(index) ? this.selection : [item],
			accessibilityProvider: options.accessibilityProvider,
			renderItem: (item, index, row) => {
				const contents = options.renderItem(item, index, row);
				this.updateRowState(row, index);
				return contents;
			},
			reuseRows: options.reuseRows,
			updateItem: (item, index, row, rerender) => {
				options.updateItem?.(item, index, row, rerender);
				this.updateRowState(row, index);
			},
			onDidRemoveRow: options.onDidRemoveRow,
		}));
		this.element = this.view.element;
		this.domNode = this.view.domNode;
		if (options.multipleSelectionSupport) this.element.setAttribute("aria-multiselectable", "true");
		this.onDidScroll = this.view.onDidScroll;
		this.onDidRenderRows = this.view.onDidRenderRows;
		this._register(this.view.onDidRenderRows(() => this.syncActiveDescendant()));
		if (options.mouseSupport !== false) {
			this._register(addDisposableListener(this.element, "mousemove", (event: MouseEvent) => {
				if (options.focusOnMouseMove === false) return;
				const index = this.view.getRowIndex(event);
				if (index !== undefined) this.setActiveIndex(index, event);
			}));
			this._register(addDisposableListener(this.element, "mousedown", (event: MouseEvent) => {
				if (this.view.getRowIndex(event) !== undefined) stopEvent(event);
			}));
			this._register(addDisposableListener(this.element, "click", (event: MouseEvent) => this.onClick(event)));
			this._register(addDisposableListener(this.element, "auxclick", (event: MouseEvent) => this.onAuxClick(event)));
			this._register(addDisposableListener(this.element, "dblclick", (event: MouseEvent) => this.onDoubleClick(event)));
		}
		if (options.keyboardNavigation === true) this._register(addDisposableListener(this.element, "keydown", (event: KeyboardEvent) => this.onKeyDown(event)));
		this._register(addDisposableListener(this.element, 'focusout', () => this.resetNavigationPrefix()));
	}

	updateOptions(options: Pick<ListOptions<T>, "smoothScrolling">): void { this.view.updateOptions(options); }

	get items(): readonly T[] { return this.view.items; }
	clearRetainedRows(): void { this.view.clearRetainedRows(); }
	layout(height: number): void { this.view.layout(height); }

	set items(items: readonly T[]) {
		this.splice(0, this.items.length, items);
	}

	splice(start: number, deleteCount: number, elements: readonly T[] = []): void {
		const focusedId = this.activeItem === undefined ? undefined : this.itemId(this.activeItem, this._activeIndex);
		const selectedIds = this._selectionIndexes.map((index) => this.itemId(this.items[index], index));
		const anchorId = this.selectionAnchor === undefined ? undefined : this.itemId(this.items[this.selectionAnchor], this.selectionAnchor);

		this.view.splice(start, deleteCount, elements);
		const nextActive = focusedId === undefined ? -1 : this.indexOfId(focusedId);
		if (nextActive >= 0) {
			this._activeIndex = nextActive;
		} else {
			this._activeIndex = this.items.length > 0 && (this.options.mouseSupport !== false || this.options.keyboardNavigation === true) ? 0 : -1;
		}
		this._selectionIndexes = selectedIds.map((id) => this.indexOfId(id)).filter((index) => index >= 0);
		const nextAnchor = anchorId === undefined ? -1 : this.indexOfId(anchorId);
		this.selectionAnchor = nextAnchor >= 0 ? nextAnchor : undefined;
		this.syncRows();

		const nextFocusedId = this.activeItem === undefined ? undefined : this.itemId(this.activeItem, this._activeIndex);
		const nextSelectedIds = this._selectionIndexes.map((index) => this.itemId(this.items[index], index));
		if (focusedId !== nextFocusedId) {
			this.emitFocus(undefined);
		}
		if (!equals(selectedIds, nextSelectedIds)) {
			this.emitSelection(undefined);
		}
	}

	get activeIndex(): number { return this._activeIndex; }
	get activeItem(): T | undefined { return this.items[this._activeIndex]; }
	get selection(): readonly T[] { return this._selectionIndexes.map((index) => this.items[index]!).filter((item) => item !== undefined); }

	setActiveIndex(index: number, browserEvent?: UIEvent): void {
		if (!Number.isInteger(index) || index < 0 || index >= this.items.length || this._activeIndex === index) return;
		this._activeIndex = index;
		this.syncRows();
		this.emitFocus(browserEvent);
	}

	setSelection(indexes: readonly number[], browserEvent?: UIEvent): void {
		const normalized = [...new Set(indexes)].filter((index) => Number.isInteger(index) && index >= 0 && index < this.items.length);
		if (equals(this._selectionIndexes, normalized)) {
			return;
		}
		this._selectionIndexes = normalized;
		this.selectionAnchor ??= normalized[0];
		this.syncRows();
		this.emitSelection(browserEvent);
	}

	focusNext(browserEvent?: UIEvent): void { this.moveActive(1, browserEvent); }
	focusPrevious(browserEvent?: UIEvent): void { this.moveActive(-1, browserEvent); }
	async focusNextPage(browserEvent?: UIEvent): Promise<void> {
		const index = this.pageIndex(1);
		if (index !== undefined) this.setActiveIndex(index, browserEvent);
	}
	async focusPreviousPage(browserEvent?: UIEvent): Promise<void> {
		const index = this.pageIndex(-1);
		if (index !== undefined) this.setActiveIndex(index, browserEvent);
	}
	domFocus(): void { this.element.focus(); }

	acceptActive(browserEvent?: MouseEvent | KeyboardEvent): void {
		const item = this.activeItem;
		if (item !== undefined) this._onDidAccept.fire({ item, index: this._activeIndex, browserEvent });
	}

	row(index: number): HTMLElement | undefined { return this.view.row(index); }
	rerender(index: number): void { this.view.rerender(index); }
	updateElementHeight(index: number, height: number | undefined): void { this.view.updateElementHeight(index, height); }
	getElementTop(index: number): number { return this.view.getElementTop(index); }
	getElementHeight(index: number): number { return this.view.getElementHeight(index); }
	indexAt(position: number): number { return this.view.indexAt(position); }
	get scrollTop(): number { return this.view.scrollTop; }

	private onClick(event: MouseEvent): void {
		const index = this.view.getRowIndex(event);
		if (index === undefined) return;
		this.domFocus();
		this.selectFromInput(index, event);
		this.setActiveIndex(index, event);
		this._onPointer.fire({ item: this.items[index]!, index, browserEvent: event });
		if (this.options.acceptOnClick !== false) this.acceptActive(event);
	}

	private onAuxClick(event: MouseEvent): void {
		if (event.button !== 1) return;
		const index = this.view.getRowIndex(event);
		if (index === undefined) return;
		this.setActiveIndex(index, event);
		this.setSelection([index], event);
		this._onPointer.fire({ item: this.items[index]!, index, browserEvent: event });
	}

	private onDoubleClick(event: MouseEvent): void {
		const index = this.view.getRowIndex(event);
		if (index !== undefined) this._onDidDoubleClick.fire({ item: this.items[index]!, index, browserEvent: event });
	}

	private onKeyDown(event: KeyboardEvent): void {
		if (event.defaultPrevented || event.isComposing) return;
		if (isHTMLElement(event.target) && event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
		let index: number | undefined;
		switch (event.key) {
			case "ArrowDown":
				index = this.nextIndex(1);
				break;
			case "ArrowUp":
				index = this.nextIndex(-1);
				break;
			case "Home":
				index = this.items.length > 0 ? 0 : undefined;
				break;
			case "End":
				index = this.items.length > 0 ? this.items.length - 1 : undefined;
				break;
			case 'PageDown':
				index = this.pageIndex(1);
				break;
			case 'PageUp':
				index = this.pageIndex(-1);
				break;
			default:
				this.navigateByLabel(event);
				return;
		}
		if (index === undefined) {
			return;
		}
		stopEvent(event);
		// Wheel scrolling may hide the focused row without changing its logical index.
		if (index === this._activeIndex) {
			this.view.reveal(index);
		}
		this.selectFromInput(index, event);
		this.setActiveIndex(index, event);
	}

	private pageIndex(direction: 1 | -1): number | undefined {
		if (this.items.length === 0) return undefined;
		const current = Math.max(0, this._activeIndex);
		const pageHeight = this.view.renderHeight;
		const pageEdge = (): number => {
			const position = this.view.scrollTop + (direction === 1 ? pageHeight : 0);
			let index = this.view.indexAt(position);
			if (direction === 1 && this.view.getElementTop(index) + this.view.getElementHeight(index) > position) index--;
			if (direction === -1 && this.view.getElementTop(index) < position) index++;
			return Math.max(0, Math.min(index, this.items.length - 1));
		};
		const edge = pageEdge();
		if (direction === 1 ? current < edge : current > edge) return edge;
		// First reach the visible page edge; a repeated press scrolls to the next page.
		this.view.scrollBy(direction * pageHeight);
		return pageEdge();
	}

	private navigateByLabel(event: KeyboardEvent): void {
		const provider = this.options.keyboardNavigationLabelProvider;
		if (!provider || event.altKey || event.ctrlKey || event.metaKey || event.key.length !== 1 || event.key === ' ') return;
		const character = event.key.toLocaleLowerCase();
		const cycling = this.navigationPrefix === character;
		const start = !this.navigationPrefix || cycling ? this._activeIndex + 1 : this._activeIndex;
		this.navigationPrefix = cycling ? character : this.navigationPrefix + character;
		this.navigationTimer.value = disposableWindowTimeout(getWindow(this.element), () => this.resetNavigationPrefix(), 800);
		for (let offset = 0; offset < this.items.length; offset++) {
			const index = rot(start + offset, this.items.length);
			const label = provider.getKeyboardNavigationLabel(this.items[index]!);
			const labels = Array.isArray(label) ? label : [label];
			if (!labels.some(value => value === undefined || value.toString()?.toLocaleLowerCase().startsWith(this.navigationPrefix))) continue;
			stopEvent(event);
			this.setActiveIndex(index, event);
			return;
		}
	}

	private resetNavigationPrefix(): void {
		this.navigationTimer.clear();
		this.navigationPrefix = '';
	}

	private selectFromInput(index: number, event: MouseEvent | KeyboardEvent): void {
		if (this.options.multipleSelectionSupport && event.shiftKey) {
			this.selectionAnchor ??= this._activeIndex >= 0 ? this._activeIndex : index;
			const start = Math.min(this.selectionAnchor, index);
			const end = Math.max(this.selectionAnchor, index);
			this.setSelection(Array.from({ length: end - start + 1 }, (_, offset) => start + offset), event);
			return;
		}
		this.selectionAnchor = index;
		const toggleSelection = isMacintosh ? event.metaKey : event.ctrlKey;
		if (this.options.multipleSelectionSupport && toggleSelection) {
			if (event.type === "click") {
				const indexes = this._selectionIndexes.includes(index)
					? this._selectionIndexes.filter(selected => selected !== index)
					: [...this._selectionIndexes, index];
				this.setSelection(indexes, event);
			}
			return;
		}
		this.setSelection([index], event);
	}

	private moveActive(delta: number, browserEvent?: UIEvent): void {
		const next = this.nextIndex(delta);
		if (next !== undefined) this.setActiveIndex(next, browserEvent);
	}

	private nextIndex(delta: number): number | undefined {
		const length = this.items.length;
		if (length === 0) return undefined;
		const candidate = this._activeIndex + delta;
		return this.loopNavigation ? rot(candidate, length) : Math.max(0, Math.min(candidate, length - 1));
	}

	private syncRows(): void {
		// Logical focus survives virtualized rows leaving the DOM during scrolling.
		this.element.classList.toggle("has-focused-item", this.activeItem !== undefined);
		this.view.reveal(this._activeIndex);
		const rows = this.element.querySelectorAll<HTMLElement>(":scope > .ash-list-row");
		rows.forEach((row) => {
			const index = Number(row.dataset.index);
			this.updateRowState(row, index);
		});
		this.syncActiveDescendant();
		const activeRow = this.view.row(this._activeIndex);
		if (activeRow && this.options.scrolling !== "managed") activeRow.scrollIntoView?.({ block: "nearest" });
	}

	private syncActiveDescendant(): void {
		const activeRow = this.view.row(this._activeIndex);
		if (this.element.getAttribute("aria-activedescendant") === (activeRow?.id ?? null)) return;
		if (activeRow) this.element.setAttribute("aria-activedescendant", activeRow.id);
		else this.element.removeAttribute("aria-activedescendant");
	}

	private updateRowState(row: HTMLElement, index: number): void {
		const focused = index === this._activeIndex;
		const selected = this._selectionIndexes.includes(index);
		row.classList.toggle("focused", focused);
		row.classList.toggle("is-active", focused);
		row.classList.toggle("selected", selected);
		setAriaAttribute(row, "selected", selected);
	}

	private emitFocus(browserEvent?: UIEvent): void {
		this._onDidChangeActive.fire({ item: this.activeItem, index: this._activeIndex, rowId: this.row(this._activeIndex)?.id, browserEvent });
	}

	private emitSelection(browserEvent?: UIEvent): void {
		this._onDidChangeSelection.fire({ items: this.selection, indexes: this._selectionIndexes, browserEvent });
	}

	private itemId(item: T | undefined, index: number): string { return item === undefined ? String(index) : this.options.getId?.(item) ?? String(index); }
	private indexOfId(id: string): number { return this.items.findIndex((item, index) => this.itemId(item, index) === id); }
}
