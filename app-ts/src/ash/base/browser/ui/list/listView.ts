import { addDisposableListener, isNode, h } from "../../dom.js";
import { DataTransfers } from "../../dnd.js";
import { Emitter, type Event } from "../../../common/event.js";
import { Disposable, MutableDisposable, type IDisposable, toDisposable } from "../../../common/lifecycle.js";
import { Mimes } from '../../../common/mime.js';
import { isFiniteNumber } from "../../../common/numbers.js";
import { disposableWindowTimeout, scheduleAtNextAnimationFrame } from "../../scheduler.js";
import { observeResize } from "../../observer.js";
import { setAriaAttribute, setRole } from "../aria/aria.js";
import { DndCssClasses, DragAndDropDataKind, type DragAndDropData, type DragAndDropDataKind as DragDataKind } from "../dnd/dnd.js";
import { ScrollableElement } from "../scrollbar/scrollableElement.js";
import { ListDragOverPosition, ListDragTargetSector, type ListAccessibilityProvider, type ListDragAndDrop, type ListDragOverReaction, type ListDragOverPosition as DragOverPosition, type ListScrolling, type ListDragTargetSector as DragTargetSector } from "./list.js";

export interface ListViewOptions<T> {
	readonly ariaLabel?: string;
	readonly role?: "listbox" | "tree";
	readonly scrolling?: ListScrolling;
	readonly domFocusable?: boolean;
	readonly getId?: (item: T) => string;
	/** A fixed height enables viewport virtualization for managed scrolling; omit it for content-sized rows. */
	readonly getHeight?: (item: T) => number;
	readonly dnd?: ListDragAndDrop<T>;
	readonly getDragElements?: (item: T, index: number) => readonly T[];
	readonly accessibilityProvider?: ListAccessibilityProvider<T>;
	readonly renderItem: (item: T, index: number, row: HTMLDivElement) => HTMLElement;
	/** Retains a row only while its ID and item object remain the same. */
	readonly reuseRows?: boolean;
	readonly updateItem?: (item: T, index: number, row: HTMLDivElement) => void;
	/** Releases resources owned by a row before its rendered content is replaced or removed. */
	readonly onDidRemoveRow?: (row: HTMLDivElement) => void;
}

/** Low-level flat row view that owns DOM, sizing, scrolling, and DnD. */
export class ListView<T> extends Disposable {
	readonly element: HTMLDivElement;
	readonly domNode: HTMLDivElement;
	private readonly scrollable: ScrollableElement | undefined;
	private readonly _onDidScroll = this._register(new Emitter<number>());
	private readonly heightOverrides = new Map<string, number>();
	private readonly renderedRows = new Map<string, { readonly item: T; readonly row: HTMLDivElement; readonly index: number }>();
	private _items: readonly T[] = [];
	private itemOffsets: readonly number[] = [0];

	readonly onDidScroll: Event<number> = this._onDidScroll.event;

	constructor(container: HTMLElement, private readonly options: ListViewOptions<T>) {
		super();
		const ownerDocument = container.ownerDocument;
		this.element = h(ownerDocument, "div");
		this.element.className = "ash-list";
		this.element.id = `ash-list-${listSequence++}`;
		setRole(this.element, options.role ?? "listbox");
		if (options.ariaLabel) setAriaAttribute(this.element, "label", options.ariaLabel);
		if (options.domFocusable === true) this.element.tabIndex = 0;
		this.element.style.overflow = options.scrolling === "external" || options.scrolling === "managed" ? "visible" : "auto";
		if (options.scrolling === "managed") {
			if (options.getHeight) this.element.style.position = "relative";
			this.scrollable = this._register(new ScrollableElement(container, { direction: "vertical", tabIndex: -1 }));
			this.scrollable.setContent(this.element);
			this.domNode = this.scrollable.element;
		} else {
			this.scrollable = undefined;
			this.domNode = this.element;
			container.append(this.element);
		}
		this._register(toDisposable(() => this.element.remove()));
		this._register(toDisposable(() => {
			for (const row of this.element.querySelectorAll<HTMLDivElement>(":scope > .ash-list-row")) this.options.onDidRemoveRow?.(row);
		}));
		if (this.scrollable) this._register(this.scrollable.onDidScroll(event => {
			if (this.isVirtualized) this.renderRows();
			this._onDidScroll.fire(event.current.top);
		}));
		else this._register(addDisposableListener(this.element, "scroll", () => this._onDidScroll.fire(this.element.scrollTop)));
		if (this.scrollable) this._register(observeResize([this.domNode], () => {
			this.scrollable?.layout();
			this.renderRows();
		}));
		if (options.dnd) this._register(new ListViewDragAndDrop(this, options.dnd, options.getDragElements ?? ((item) => [item])));
	}

	get items(): readonly T[] { return this._items; }

	layout(height: number): void {
		this.domNode.style.height = `${height}px`;
		this.scrollable?.layout();
		this.renderRows();
		this.scrollable?.layout();
	}

	set items(items: readonly T[]) {
		const nextItems = [...items];
		const seen = new Set<string>();
		for (let index = 0; index < nextItems.length; index += 1) {
			const itemId = this.itemId(nextItems[index]!, index);
			if (seen.has(itemId)) throw new TypeError(`Duplicate List item ID: ${itemId}`);
			seen.add(itemId);
		}
		if (!this.options.reuseRows) {
			for (const [itemId, rendered] of [...this.renderedRows]) this.removeRenderedRow(itemId, rendered.row);
		}
		this._items = nextItems;
		this.rebuildItemOffsets();
		this.scrollable?.layout();
		this.renderRows();
		this.scrollable?.layout();
	}

	private renderRows(): void {
		const range = this.renderRange();
		const rows: HTMLDivElement[] = [];
		const retainedIds = new Set<string>();
		for (let index = range.start; index < range.end; index += 1) {
			const item = this._items[index]!;
			const itemId = this.itemId(item, index);
			retainedIds.add(itemId);
			const previous = this.renderedRows.get(itemId);
			const existing = previous;
			let row: HTMLDivElement;
			if (existing?.item === item) {
				row = existing.row;
				row.dataset.index = String(index);
				this.updateAccessibility(row, item);
				this.options.updateItem?.(item, index, row);
			} else {
				if (previous) this.removeRenderedRow(itemId, previous.row);
				row = this.createRow(item, index, itemId);
			}
			if (this.isVirtualized) {
				row.style.position = "absolute";
				row.style.top = `${this.itemOffsets[index]}px`;
				row.style.right = "0";
				row.style.left = "0";
			}
			this.renderedRows.set(itemId, { item, row, index });
			rows.push(row);
		}
		for (const [itemId, rendered] of [...this.renderedRows]) {
			if (!retainedIds.has(itemId)) this.removeRenderedRow(itemId, rendered.row);
		}
		this.element.style.height = this.isVirtualized ? `${this.itemOffsets.at(-1) ?? 0}px` : "";
		let previous: HTMLDivElement | undefined;
		for (const row of rows) {
			const next = previous ? previous.nextSibling : this.element.firstChild;
			if (row !== next) this.element.insertBefore(row, next);
			previous = row;
		}
	}

	private createRow(item: T, index: number, itemId: string): HTMLDivElement {
		const row = h(this.element.ownerDocument, "div");
		row.className = "ash-list-row";
		row.id = `${this.element.id}-item-${encodeURIComponent(itemId)}`;
		row.dataset.index = String(index);
		row.dataset.listId = itemId;
		const height = this.heightOverrides.get(itemId) ?? normalizeHeight(this.options.getHeight?.(item));
		if (height !== undefined) row.style.height = `${height}px`;
		if (this.options.dnd?.getDragURI(item) !== undefined) {
			row.draggable = true;
			row.classList.add(DndCssClasses.Draggable);
		}
		this.updateAccessibility(row, item);
		row.append(this.options.renderItem(item, index, row));
		return row;
	}

	private removeRenderedRow(itemId: string, row: HTMLDivElement): void {
		this.options.onDidRemoveRow?.(row);
		row.remove();
		this.renderedRows.delete(itemId);
	}

	private renderRange(): { readonly start: number; readonly end: number } {
		const scrollable = this.scrollable;
		if (!this.isVirtualized || !scrollable || scrollable.state.height <= 0 || this._items.length === 0) return { start: 0, end: this._items.length };
		const viewport = scrollable.state;
		const start = Math.max(0, this.indexAt(Math.max(0, viewport.top - 200)));
		const end = Math.min(this._items.length, this.indexAt(viewport.top + viewport.height + 200) + 1);
		return { start, end };
	}

	private rebuildItemOffsets(): void {
		const offsets = [0];
		for (let index = 0; index < this._items.length; index += 1) offsets.push(offsets[index]! + this.itemHeight(this._items[index]!, index));
		this.itemOffsets = offsets;
	}

	private updateAccessibility(row: HTMLDivElement, item: T): void {
		const accessibility = this.options.accessibilityProvider;
		setRole(row, accessibility?.getRole?.(item) ?? (this.options.role === "tree" ? "treeitem" : "option"));
		setAriaAttribute(row, "selected", false);
		this.setNumericAria(row, "aria-level", accessibility?.getAriaLevel?.(item));
		this.setNumericAria(row, "aria-setsize", accessibility?.getAriaSetSize?.(item));
		this.setNumericAria(row, "aria-posinset", accessibility?.getAriaPosInSet?.(item));
		const expanded = accessibility?.isExpanded?.(item);
		if (expanded !== undefined) row.setAttribute("aria-expanded", String(expanded));
		else row.removeAttribute("aria-expanded");
		const ariaLabel = accessibility?.getAriaLabel?.(item);
		if (ariaLabel) row.setAttribute("aria-label", ariaLabel);
		else row.removeAttribute("aria-label");
	}

	row(index: number): HTMLElement | undefined {
		const item = this._items[index];
		if (item === undefined) return undefined;
		return this.renderedRows.get(this.itemId(item, index))?.row;
	}

	get scrollTop(): number { return this.scrollable?.state.top ?? this.element.scrollTop; }

	reveal(index: number): void {
		if (!this.scrollable || index < 0 || index >= this._items.length) return;
		if (!this.isVirtualized) {
			const row = this.row(index);
			if (row) this.scrollable.reveal(row);
			return;
		}
		const top = this.getElementTop(index);
		const bottom = top + this.getElementHeight(index);
		const viewport = this.scrollable.state;
		if (top < viewport.top) this.scrollable.scrollTo(viewport.left, top);
		else if (bottom > viewport.top + viewport.height) this.scrollable.scrollTo(viewport.left, bottom - viewport.height);
		this.renderRows();
	}

	get scrollElement(): HTMLElement { return this.scrollable?.scrollableElement ?? this.element; }
	scrollBy(delta: number): void {
		if (this.scrollable) this.scrollable.scrollBy(0, delta);
		else this.element.scrollTop += delta;
	}

	getRowIndex(event: MouseEvent | DragEvent): number | undefined {
		if (!isNode(event.target) || event.target.nodeType !== 1) return undefined;
		const row = (event.target as Element).closest<HTMLElement>(".ash-list-row");
		if (!row || row.parentElement !== this.element) return undefined;
		const index = Number(row.dataset.index);
		return Number.isInteger(index) ? index : undefined;
	}

	updateElementHeight(index: number, height: number | undefined): void {
		const item = this._items[index];
		if (item === undefined) return;
		const id = this.itemId(item, index);
		if (height === undefined) this.heightOverrides.delete(id);
		else {
			const normalized = normalizeHeight(height);
			if (normalized === undefined) throw new RangeError("List row height must be a positive finite number");
			this.heightOverrides.set(id, normalized);
		}
		this.rebuildItemOffsets();
		this.scrollable?.layout();
		this.renderRows();
		this.scrollable?.layout();
		const row = this.row(index);
		if (!row) return;
		const next = this.heightOverrides.get(id) ?? normalizeHeight(this.options.getHeight?.(item));
		if (next === undefined) row.style.removeProperty("height");
		else row.style.height = `${next}px`;
	}

	getElementTop(index: number): number {
		if (!this.isVirtualized) {
			let top = 0;
			for (let current = 0; current < index && current < this._items.length; current += 1) top += this.getElementHeight(current);
			return top;
		}
		return this.itemOffsets[Math.max(0, Math.min(index, this._items.length))] ?? 0;
	}

	getElementHeight(index: number): number {
		const item = this._items[index];
		if (item === undefined) return 0;
		const configured = this.heightOverrides.get(this.itemId(item, index)) ?? normalizeHeight(this.options.getHeight?.(item));
		if (configured !== undefined) return configured;
		const measured = this.row(index)?.getBoundingClientRect().height;
		return measured !== undefined && measured > 0 ? measured : 22;
	}

	indexAt(position: number): number {
		if (this._items.length === 0) return -1;
		if (!this.isVirtualized) {
			let top = 0;
			for (let index = 0; index < this._items.length; index += 1) {
				top += this.getElementHeight(index);
				if (position < top) return index;
			}
			return this._items.length - 1;
		}
		let low = 0;
		let high = this._items.length;
		while (low < high) {
			const middle = Math.floor((low + high) / 2);
			if (this.itemOffsets[middle + 1]! <= position) low = middle + 1;
			else high = middle;
		}
		return Math.min(low, this._items.length - 1);
	}

	private itemHeight(item: T, index: number): number { return this.heightOverrides.get(this.itemId(item, index)) ?? normalizeHeight(this.options.getHeight?.(item)) ?? 22; }
	private get isVirtualized(): boolean { return this.scrollable !== undefined && this.options.getHeight !== undefined; }
	private itemId(item: T, index: number): string { return this.options.getId?.(item) ?? String(index); }
	private setNumericAria(row: HTMLElement, name: string, value: number | undefined): void {
		if (value !== undefined) row.setAttribute(name, String(value));
		else row.removeAttribute(name);
	}
}

interface MutableDragAndDropData<T> extends DragAndDropData<T> {
	update(dataTransfer: DataTransfer | null): void;
}

interface ActiveListDragSession {
	readonly source: object;
	readonly data: DragAndDropData<unknown>;
}

let activeListDragSession: ActiveListDragSession | undefined;

class ListViewDragAndDrop<T> extends Disposable {
	private currentData: MutableDragAndDropData<T> | undefined;
	private canDrop = false;
	private feedbackIndexes: readonly number[] = [];
	private feedbackPosition: DragOverPosition = ListDragOverPosition.Over;
	private sourceRow: HTMLElement | undefined;
	private readonly dragLeave = this._register(new MutableDisposable<IDisposable>());
	private readonly autoScroll = this._register(new MutableDisposable<IDisposable>());
	private dragPointerY: number | undefined;

	constructor(private readonly view: ListView<T>, private readonly dnd: ListDragAndDrop<T>, private readonly getDragElements: (item: T, index: number) => readonly T[]) {
		super();
		this._register(addDisposableListener(view.element, "dragstart", (event: DragEvent) => this.onDragStart(event)));
		this._register(addDisposableListener(view.element, "dragover", (event: DragEvent) => this.onDragOver(event)));
		this._register(addDisposableListener(view.element, "dragleave", (event: DragEvent) => this.onDragLeave(event)));
		this._register(addDisposableListener(view.element, "drop", (event: DragEvent) => this.onDrop(event)));
		this._register(addDisposableListener(view.element, "dragend", (event: DragEvent) => this.onDragEnd(event)));
		this._register(toDisposable(() => {
			this.cancelDragLeave();
			this.stopAutoScroll();
			this.clearFeedback();
			this.clearActiveSession();
		}));
	}

	private onDragStart(event: DragEvent): void {
		const index = this.view.getRowIndex(event);
		if (index === undefined) return;
		const item = this.view.items[index];
		if (item === undefined) return;
		const uri = this.dnd.getDragURI(item);
		if (uri === undefined) return;
		const elements = this.getDragElements(item, index);
		const data = new MutableElementDragAndDropData(DragAndDropDataKind.Internal, elements);
		this.currentData = data;
		activeListDragSession = { source: this, data: data as DragAndDropData<unknown> };
		this.sourceRow = this.view.row(index);
		this.sourceRow?.classList.add(DndCssClasses.Dragging);
		if (event.dataTransfer) {
			event.dataTransfer.effectAllowed = "copyMove";
			event.dataTransfer.setData(Mimes.uriList, uri);
			const label = this.dnd.getDragLabel?.(elements, event);
			if (label) event.dataTransfer.setData(DataTransfers.TEXT, label);
			data.update(event.dataTransfer);
		}
		this.dnd.onDragStart?.(data, event);
	}

	private onDragOver(event: DragEvent): void {
		this.cancelDragLeave();
		const data = this.resolveDragData(event.dataTransfer);
		const index = this.view.getRowIndex(event);
		const target = index === undefined ? undefined : this.view.items[index];
		const sector = this.targetSector(event, index);
		const result = this.dnd.onDragOver(data, target, index, sector, event);
		const reaction: ListDragOverReaction = typeof result === "boolean" ? { accept: result } : result;
		this.canDrop = reaction.accept;
		if (!reaction.accept) {
			this.clearFeedback();
			this.stopAutoScroll();
			return;
		}
		event.preventDefault();
		if (event.dataTransfer) event.dataTransfer.dropEffect = reaction.effect ?? "move";
		this.applyFeedback(reaction.feedback ?? (index === undefined ? [-1] : [index]), reaction.position ?? ListDragOverPosition.Over);
		this.updateAutoScroll(event);
	}

	private onDragLeave(event: DragEvent): void {
		this.cancelDragLeave();
		const ownerWindow = this.view.element.ownerDocument.defaultView;
		if (!ownerWindow) {
			this.finishDragLeave(event);
			return;
		}
		this.dragLeave.value = disposableWindowTimeout(ownerWindow, () => {
			this.dragLeave.clear();
			this.finishDragLeave(event);
		}, 100);
	}

	private finishDragLeave(event: DragEvent): void {
		const data = this.currentData;
		if (data) {
			const index = this.view.getRowIndex(event);
			this.dnd.onDragLeave?.(data, index === undefined ? undefined : this.view.items[index], index, event);
		}
		this.canDrop = false;
		this.currentData = this.sourceRow ? this.currentData : undefined;
		this.clearFeedback();
		this.stopAutoScroll();
	}

	private onDrop(event: DragEvent): void {
		this.cancelDragLeave();
		const data = this.currentData;
		if (!this.canDrop || !data) {
			this.resetDropTarget();
			return;
		}
		event.preventDefault();
		data.update(event.dataTransfer);
		const index = this.view.getRowIndex(event);
		this.dnd.drop(data, index === undefined ? undefined : this.view.items[index], index, this.targetSector(event, index), event);
		this.resetDropTarget();
		activeListDragSession = undefined;
	}

	private onDragEnd(event: DragEvent): void {
		const wasSource = this.sourceRow !== undefined;
		this.cancelDragLeave();
		this.resetDropTarget();
		this.sourceRow?.classList.remove(DndCssClasses.Dragging);
		this.sourceRow = undefined;
		this.clearActiveSession();
		if (wasSource) this.dnd.onDragEnd?.(event);
	}

	private resolveDragData(dataTransfer: DataTransfer | null): MutableDragAndDropData<T> {
		if (!this.currentData) {
			const active = activeListDragSession;
			this.currentData = active
				? new MutableElementDragAndDropData(DragAndDropDataKind.External, active.data.elements as readonly T[], active.data.types, active.data.files)
				: new MutableNativeDragAndDropData<T>();
		}
		this.currentData.update(dataTransfer);
		return this.currentData;
	}

	private targetSector(event: DragEvent, index: number | undefined): DragTargetSector | undefined {
		if (index === undefined) return undefined;
		const row = this.view.row(index);
		if (!row) return undefined;
		const rect = row.getBoundingClientRect();
		if (!(rect.height > 0) || !Number.isFinite(event.clientY)) return ListDragTargetSector.CenterTop;
		const relative = Math.max(0, Math.min(0.999, (event.clientY - rect.top) / rect.height));
		if (relative < 0.25) return ListDragTargetSector.Top;
		if (relative < 0.5) return ListDragTargetSector.CenterTop;
		if (relative < 0.75) return ListDragTargetSector.CenterBottom;
		return ListDragTargetSector.Bottom;
	}

	private applyFeedback(indexes: readonly number[], position: DragOverPosition): void {
		const length = this.view.items.length;
		let normalized = [...new Set(indexes)].filter((index) => index >= -1 && index < length).sort((left, right) => left - right);
		if (normalized.includes(-1)) normalized = [-1];
		if (normalized.length > 1 && position !== ListDragOverPosition.Over) throw new TypeError("Multiple List drag feedback rows require the over position");
		if (position === ListDragOverPosition.After && normalized.length === 1 && normalized[0] !== -1 && normalized[0]! < length - 1) {
			normalized = [normalized[0]! + 1];
			position = ListDragOverPosition.Before;
		}
		if (sameFeedback(this.feedbackIndexes, normalized) && this.feedbackPosition === position) return;
		this.clearFeedback();
		this.feedbackIndexes = normalized;
		this.feedbackPosition = position;
		const className = feedbackClass(position);
		for (const index of normalized) {
			const target = index === -1 ? this.view.element : this.view.row(index);
			target?.classList.add(className);
			if (position === ListDragOverPosition.Over) target?.classList.add("drag-over");
		}
	}

	private clearFeedback(): void {
		const className = feedbackClass(this.feedbackPosition);
		for (const index of this.feedbackIndexes) {
			const target = index === -1 ? this.view.element : this.view.row(index);
			target?.classList.remove(className, "drag-over");
		}
		this.feedbackIndexes = [];
		this.feedbackPosition = ListDragOverPosition.Over;
	}

	private resetDropTarget(): void {
		this.canDrop = false;
		this.currentData = this.sourceRow ? this.currentData : undefined;
		this.clearFeedback();
		this.stopAutoScroll();
	}

	private updateAutoScroll(event: DragEvent): void {
		this.dragPointerY = event.clientY;
		if (!Number.isFinite(this.dragPointerY) || this.autoScroll.value) return;
		this.scheduleAutoScroll();
	}

	private scheduleAutoScroll(): void {
		const ownerWindow = this.view.element.ownerDocument.defaultView;
		if (!ownerWindow) return;
		const callback = () => {
			this.autoScroll.clear();
			const pointerY = this.dragPointerY;
			const element = this.view.scrollElement;
			const rect = element.getBoundingClientRect();
			if (pointerY === undefined || !(rect.height > 0) || element.scrollHeight <= element.clientHeight) return;
			const edge = Math.min(35, rect.height / 2);
			const topDistance = pointerY - rect.top;
			const bottomDistance = rect.bottom - pointerY;
			const delta = topDistance < edge ? -Math.max(1, Math.ceil((edge - topDistance) * 0.4)) : bottomDistance < edge ? Math.max(1, Math.ceil((edge - bottomDistance) * 0.4)) : 0;
			if (delta === 0) return;
			this.view.scrollBy(Math.max(-14, Math.min(14, delta)));
			this.scheduleAutoScroll();
		};
		this.autoScroll.value = scheduleAtNextAnimationFrame(ownerWindow, callback);
	}

	private stopAutoScroll(): void {
		this.autoScroll.clear();
		this.dragPointerY = undefined;
	}

	private cancelDragLeave(): void {
		this.dragLeave.clear();
	}

	private clearActiveSession(): void { if (activeListDragSession?.source === this) activeListDragSession = undefined; }
}

class MutableElementDragAndDropData<T> implements MutableDragAndDropData<T> {
	readonly elements: readonly T[];
	readonly types: string[];
	readonly files: File[];

	constructor(readonly kind: DragDataKind, elements: readonly T[], types: readonly string[] = [], files: readonly File[] = []) {
		this.elements = [...elements];
		this.types = [...types];
		this.files = [...files];
	}

	update(dataTransfer: DataTransfer | null): void {
		if (!dataTransfer) return;
		this.types.splice(0, this.types.length, ...Array.from(dataTransfer.types ?? []));
		this.files.splice(0, this.files.length, ...Array.from(dataTransfer.files ?? []));
	}
}

class MutableNativeDragAndDropData<T> implements MutableDragAndDropData<T> {
	readonly kind = DragAndDropDataKind.Native;
	readonly elements: readonly T[] = [];
	readonly types: string[] = [];
	readonly files: File[] = [];

	update(dataTransfer: DataTransfer | null): void {
		if (!dataTransfer) return;
		this.types.splice(0, this.types.length, ...Array.from(dataTransfer.types ?? []));
		this.files.splice(0, this.files.length, ...Array.from(dataTransfer.files ?? []));
	}
}

function feedbackClass(position: DragOverPosition): string {
	if (position === ListDragOverPosition.Before) return DndCssClasses.DropBefore;
	if (position === ListDragOverPosition.After) return DndCssClasses.DropAfter;
	return DndCssClasses.DropTarget;
}

function normalizeHeight(value: number | undefined): number | undefined { return isFiniteNumber(value) && value > 0 ? value : undefined; }
function sameFeedback(left: readonly number[], right: readonly number[]): boolean { return left.length === right.length && left.every((value, index) => value === right[index]); }

let listSequence = 1;
