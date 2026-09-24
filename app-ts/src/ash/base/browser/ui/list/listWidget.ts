import { addDisposableListener, stopEvent } from "../../dom.js";
import { Emitter, type Event } from "../../../common/event.js";
import { Disposable } from "../../../common/lifecycle.js";
import { rot } from "../../../common/numbers.js";
import { setAriaAttribute } from "../aria/aria.js";
import type { ListAccessibilityProvider, ListDragAndDrop, ListScrolling } from "./list.js";
import { ListView } from "./listView.js";

export interface ListOptions<T> {
	readonly ariaLabel?: string;
	readonly role?: "listbox" | "tree";
	readonly scrolling?: ListScrolling;
	readonly loopNavigation?: boolean;
	readonly keyboardNavigation?: boolean;
	readonly focusOnMouseMove?: boolean;
	readonly acceptOnClick?: boolean;
	readonly domFocusable?: boolean;
	readonly getId?: (item: T) => string;
	readonly getHeight?: (item: T) => number;
	readonly dnd?: ListDragAndDrop<T>;
	readonly accessibilityProvider?: ListAccessibilityProvider<T>;
	readonly renderItem: (item: T, index: number, row: HTMLDivElement) => HTMLElement;
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
	private readonly view: ListView<T>;
	private readonly loopNavigation: boolean;
	private readonly _onDidChangeActive = this._register(new Emitter<ListActiveChangeEvent<T>>());
	private readonly _onDidChangeSelection = this._register(new Emitter<ListSelectionChangeEvent<T>>());
	private readonly _onPointer = this._register(new Emitter<ListPointerEvent<T>>());
	private readonly _onDidDoubleClick = this._register(new Emitter<ListPointerEvent<T>>());
	private readonly _onDidAccept = this._register(new Emitter<ListAcceptEvent<T>>());
	private _activeIndex = -1;
	private _selectionIndexes: readonly number[] = [];

	readonly onDidChangeActive: Event<ListActiveChangeEvent<T>> = this._onDidChangeActive.event;
	readonly onDidChangeFocus: Event<ListActiveChangeEvent<T>> = this._onDidChangeActive.event;
	readonly onDidChangeSelection: Event<ListSelectionChangeEvent<T>> = this._onDidChangeSelection.event;
	readonly onPointer: Event<ListPointerEvent<T>> = this._onPointer.event;
	readonly onDidDoubleClick: Event<ListPointerEvent<T>> = this._onDidDoubleClick.event;
	readonly onDidAccept: Event<ListAcceptEvent<T>> = this._onDidAccept.event;
	readonly onDidScroll: Event<number>;

	constructor(container: HTMLElement, private readonly options: ListOptions<T>) {
		super();
		this.loopNavigation = options.loopNavigation ?? true;
		this.view = this._register(new ListView(container, {
			ariaLabel: options.ariaLabel,
			role: options.role,
			scrolling: options.scrolling,
			domFocusable: options.domFocusable,
			getId: options.getId,
			getHeight: options.getHeight,
			dnd: options.dnd,
			getDragElements: (item, index) => this._selectionIndexes.includes(index) ? this.selection : [item],
			accessibilityProvider: options.accessibilityProvider,
			renderItem: options.renderItem,
		}));
		this.element = this.view.element;
		this.onDidScroll = this.view.onDidScroll;
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
		if (options.keyboardNavigation === true) this._register(addDisposableListener(this.element, "keydown", (event: KeyboardEvent) => this.onKeyDown(event)));
	}

	get items(): readonly T[] { return this.view.items; }

	set items(items: readonly T[]) {
		const focusedId = this.activeItem === undefined ? undefined : this.itemId(this.activeItem, this._activeIndex);
		const selectedIds = this._selectionIndexes.map((index) => this.itemId(this.items[index], index));
		this.view.items = items;
		const nextActive = focusedId === undefined ? -1 : this.indexOfId(focusedId);
		this._activeIndex = nextActive >= 0 ? nextActive : this.items.length > 0 ? 0 : -1;
		this._selectionIndexes = selectedIds.map((id) => this.indexOfId(id)).filter((index) => index >= 0);
		this.syncRows();
		const nextFocusedId = this.activeItem === undefined ? undefined : this.itemId(this.activeItem, this._activeIndex);
		const nextSelectedIds = this._selectionIndexes.map((index) => this.itemId(this.items[index], index));
		if (focusedId !== nextFocusedId) this.emitFocus(undefined);
		if (!sameStrings(selectedIds, nextSelectedIds)) this.emitSelection(undefined);
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
		if (sameNumbers(this._selectionIndexes, normalized)) return;
		this._selectionIndexes = normalized;
		this.syncRows();
		this.emitSelection(browserEvent);
	}

	focusNext(browserEvent?: UIEvent): void { this.moveActive(1, browserEvent); }
	focusPrevious(browserEvent?: UIEvent): void { this.moveActive(-1, browserEvent); }
	domFocus(): void { this.element.focus(); }

	acceptActive(browserEvent?: MouseEvent | KeyboardEvent): void {
		const item = this.activeItem;
		if (item !== undefined) this._onDidAccept.fire({ item, index: this._activeIndex, browserEvent });
	}

	row(index: number): HTMLElement | undefined { return this.view.row(index); }
	updateElementHeight(index: number, height: number | undefined): void { this.view.updateElementHeight(index, height); }
	getElementTop(index: number): number { return this.view.getElementTop(index); }
	getElementHeight(index: number): number { return this.view.getElementHeight(index); }
	indexAt(position: number): number { return this.view.indexAt(position); }

	private onClick(event: MouseEvent): void {
		const index = this.view.getRowIndex(event);
		if (index === undefined) return;
		this.domFocus();
		this.setActiveIndex(index, event);
		this.setSelection([index], event);
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
		let index: number | undefined;
		if (event.key === "ArrowDown") index = this.nextIndex(1);
		else if (event.key === "ArrowUp") index = this.nextIndex(-1);
		else if (event.key === "Home") index = this.items.length > 0 ? 0 : undefined;
		else if (event.key === "End") index = this.items.length > 0 ? this.items.length - 1 : undefined;
		if (index === undefined) return;
		stopEvent(event);
		this.setActiveIndex(index, event);
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
		const rows = this.element.querySelectorAll<HTMLElement>(":scope > .ash-list-row");
		rows.forEach((row, index) => {
			const focused = index === this._activeIndex;
			const selected = this._selectionIndexes.includes(index);
			row.classList.toggle("focused", focused);
			row.classList.toggle("is-active", focused);
			row.classList.toggle("selected", selected);
			setAriaAttribute(row, "selected", selected);
		});
		const activeRow = rows[this._activeIndex];
		if (activeRow) {
			this.element.setAttribute("aria-activedescendant", activeRow.id);
			activeRow.scrollIntoView?.({ block: "nearest" });
		} else this.element.removeAttribute("aria-activedescendant");
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

function sameNumbers(left: readonly number[], right: readonly number[]): boolean { return left.length === right.length && left.every((value, index) => value === right[index]); }
function sameStrings(left: readonly string[], right: readonly string[]): boolean { return left.length === right.length && left.every((value, index) => value === right[index]); }
