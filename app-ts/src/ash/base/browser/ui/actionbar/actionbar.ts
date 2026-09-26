import { addDisposableListener, h } from "../../dom.js";
import { DataTransfers, DragAndDropObserver } from "../../dnd.js";
import type { IAction } from "../../../common/actions.js";
import { Disposable, DisposableStore, toDisposable } from "../../../common/lifecycle.js";
import { rot } from "../../../common/numbers.js";
import { type ActionViewItem, type ActionViewItemOptions, createActionViewItem } from "./actionViewItems.js";
import { DndCssClasses } from "../dnd/dnd.js";

export type ActionBarOrientation = "horizontal" | "vertical";
export type ActionBarDropPosition = "before" | "after";

export type ActionViewItemProvider = (
	action: IAction,
	options: ActionViewItemOptions,
) => ActionViewItem | undefined;

/** Optional drag lifecycle for action collections that define their own drop semantics. */
export interface ActionBarDragAndDrop {
	readonly canDrop: (event: DragEvent, target: IAction | undefined, position: ActionBarDropPosition) => boolean;
	readonly onDragStart: (action: IAction, event: DragEvent) => void;
	readonly onDragEnter?: (target: IAction | undefined, position: ActionBarDropPosition, event: DragEvent) => void;
	readonly onDragOver?: (target: IAction | undefined, position: ActionBarDropPosition, event: DragEvent, duration: number) => void;
	readonly onDragLeave?: () => void;
	readonly onDrop: (target: IAction | undefined, position: ActionBarDropPosition, event: DragEvent) => void;
	readonly onDragEnd: () => void;
}

export interface ActionBarOptions {
	readonly actions?: readonly IAction[];
	readonly ariaLabel?: string;
	readonly ariaRole?: "toolbar" | "tablist";
	readonly orientation?: ActionBarOrientation;
	readonly actionViewItemProvider?: ActionViewItemProvider;
	readonly actionViewItemOptions?: ActionViewItemOptions;
	/** Enables drag lifecycle callbacks without changing ordinary toolbar behavior. */
	readonly dragAndDrop?: ActionBarDragAndDrop;
	readonly highlightToggledItems?: boolean;
}

interface ActionBarEntry {
	action: IAction;
	readonly container: HTMLElement;
	item: ActionViewItem;
	store: DisposableStore;
}

/**
 * Owns action arrangement and composite-widget keyboard navigation.
 *
 * The optional ARIA role describes the rendered collection. Item providers
 * remain responsible for role-specific item state such as `aria-selected`.
 */
export class ActionBar extends Disposable {
	readonly element: HTMLDivElement;
	private readonly entries: ActionBarEntry[] = [];
	private readonly actionViewItemProvider: ActionViewItemProvider | undefined;
	private readonly actionViewItemOptions: ActionViewItemOptions;
	private orientation: ActionBarOrientation;
	private readonly dragAndDrop: ActionBarDragAndDrop | undefined;
	private tabStop: ActionViewItem | undefined;
	private dragging = false;
	private draggingEntry: ActionBarEntry | undefined;
	private dropTarget: HTMLElement | undefined;
	private dropPosition: ActionBarDropPosition | undefined;

	constructor(container: HTMLElement, options: ActionBarOptions = {}) {
		super();
		const ownerDocument = container.ownerDocument;
		const element = h(ownerDocument, "div");
		this.element = element;
		this._register(toDisposable(() => element.remove()));
		element.className = "ash-action-bar";
		container.append(element);
		this.orientation = options.orientation ?? "horizontal";
		element.classList.add(this.orientation);
		element.classList.toggle("highlight-toggled", options.highlightToggledItems === true);
		element.setAttribute("role", options.ariaRole ?? "toolbar");
		element.setAttribute("aria-orientation", this.orientation);
		if (options.ariaLabel) {
			element.setAttribute("aria-label", options.ariaLabel);
		}
		this.actionViewItemProvider = options.actionViewItemProvider;
		this.actionViewItemOptions = options.actionViewItemOptions ?? {};
		this.dragAndDrop = options.dragAndDrop;
		element.classList.toggle("ash-action-bar-dnd", this.dragAndDrop !== undefined);
		this._register(addDisposableListener(element, "keydown", (event) => {
			this.handleNavigation(event);
		}));
		this._register(addDisposableListener(element, "focusin", () => {
			const activeElement = this.element.ownerDocument.activeElement;
			const entry = this.entries.find(
				({ container }) => container.contains(activeElement),
			);
			if (entry?.action.enabled) this._setTabStop(entry.item);
		}));
		if (this.dragAndDrop) {
			this._register(new DragAndDropObserver(element, {
				onDragStart: (event) => this.onDragStart(event),
				onDragOver: (event, duration) => {
					if (!this.entryFromEvent(event)) this.onDragOver(event, duration);
				},
				onDragLeave: () => this.onDragLeave(),
				onDrop: (event) => {
					if (!this.entryFromEvent(event)) this.onDrop(event);
				},
				onDragEnd: () => this.endDrag(),
			}));
		}
		this._register(toDisposable(() => this.clearActions()));
		this.setActions(options.actions ?? []);
	}

	setOrientation(orientation: ActionBarOrientation): void {
		if (this.orientation === orientation) return;
		this.element.classList.replace(this.orientation, orientation);
		this.orientation = orientation;
		this.element.setAttribute('aria-orientation', orientation);
	}

	add(action: IAction): ActionViewItem {
		const container = h(this.element.ownerDocument, "div");
		container.className = "ash-action-view-item";
		container.classList.toggle("icon", action.icon !== undefined);
		container.dataset.actionId = action.id;
		container.setAttribute("role", "presentation");
		const entry = this.createEntry(action, container);
		this.element.append(container);
		this.entries.push(entry);
		if (action.enabled && !this.tabStop) {
			this._setTabStop(entry.item);
		} else {
			entry.item.setTabbable(false);
		}
		return entry.item;
	}

	setActions(actions: readonly IAction[]): void {
		const activeElement = this.element.ownerDocument.activeElement;
		const focusedActionId = this.entries.find(({ container }) => container.contains(activeElement))?.action.id;
		this.clearActions();
		this.tabStop = undefined;
		this.element.replaceChildren();
		for (const action of actions) this.add(action);
		if (focusedActionId) {
			const entry = this.entries.find(({ action }) => action.id === focusedActionId && action.enabled);
			if (entry) {
				this._setTabStop(entry.item);
				entry.item.focus();
			}
		}
	}

	/** Updates retained action slots when menu structure and ordering are stable. */
	updateActions(actions: readonly IAction[]): void {
		if (!this.hasMatchingStructure(actions)) {
			this.setActions(actions);
			return;
		}
		for (let index = 0; index < actions.length; index += 1) {
			this.replaceEntry(this.entries[index]!, actions[index]!);
		}
	}

	/** Selects the action that participates in page-level Tab navigation. */
	setTabStop(actionId: string): void {
		const entry = this.entries.find(
			({ action }) => action.id === actionId && action.enabled,
		);
		if (!entry) {
			throw new RangeError(`Focusable ActionBar item not found: ${actionId}`);
		}
		this._setTabStop(entry.item);
	}

	focus(): void {
		const entry = this.entries.find(({ item, action }) => item === this.tabStop && action.enabled)
			?? this.entries.find(({ action }) => action.enabled);
		if (!entry) return;
		this._setTabStop(entry.item);
		entry.item.focus();
	}

	private handleNavigation(event: KeyboardEvent): void {
		if (
			event.defaultPrevented ||
			event.altKey ||
			event.ctrlKey ||
			event.metaKey ||
			event.shiftKey
		) {
			return;
		}
		const direction = this.navigationDirection(event.key);
		if (direction === undefined) return;
		const entries = this.entries.filter(({ action }) => action.enabled);
		if (entries.length === 0) return;
		const activeElement = this.element.ownerDocument.activeElement;
		const currentIndex = entries.findIndex(
			({ container }) => container.contains(activeElement),
		);
		let targetIndex: number;
		if (direction === "first") {
			targetIndex = 0;
		} else if (direction === "last") {
			targetIndex = entries.length - 1;
		} else if (currentIndex === -1) {
			targetIndex = direction === "next" ? 0 : entries.length - 1;
		} else {
			const delta = direction === "next" ? 1 : -1;
			targetIndex = rot(currentIndex + delta, entries.length);
		}
		const target = entries[targetIndex]!.item;
		this._setTabStop(target);
		target.focus();
		event.preventDefault();
		event.stopPropagation();
	}

	private _setTabStop(item: ActionViewItem): void {
		if (item === this.tabStop) return;
		this.tabStop?.setTabbable(false);
		this.tabStop = item;
		item.setTabbable(true);
	}

	private clearActions(): void {
		for (const entry of this.entries) entry.store.dispose();
		this.entries.length = 0;
	}

	private createEntry(action: IAction, container: HTMLElement): ActionBarEntry {
		const store = new DisposableStore();
		container.draggable = false;
		container.classList.remove(DndCssClasses.Draggable);
		const item = store.add(
			this.actionViewItemProvider?.(action, this.actionViewItemOptions) ??
				createActionViewItem(action, this.actionViewItemOptions),
		);
		item.render(container);
		const entry = { action, container, item, store };
		if (item.draggable) {
			container.draggable = true;
			container.classList.add(DndCssClasses.Draggable);
			store.add(addDisposableListener(container, "dragstart", (event: DragEvent) => {
				event.dataTransfer?.setData(DataTransfers.TEXT, action.label);
			}));
		}
		if (this.dragAndDrop) {
			store.add(new DragAndDropObserver(container, {
				onDragEnter: (event) => this.onEntryDragEnter(entry, event),
				onDragOver: (event, duration) => this.onEntryDragOver(entry, event, duration),
				onDragLeave: () => this.clearDropTarget(),
				onDrop: (event) => this.onEntryDrop(entry, event),
			}));
		}
		return entry;
	}

	private onDragStart(event: DragEvent): void {
		const entry = this.entryFromEvent(event);
		if (!entry?.item.draggable) return;
		this.dragging = true;
		this.draggingEntry = entry;
		entry.container.classList.add(DndCssClasses.Dragging);
		if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
		this.dragAndDrop?.onDragStart(entry.action, event);
	}

	private onDragOver(event: DragEvent, duration = 0): void {
		const { entry, position } = this.dropTargetFromEvent(event);
		if (!this.dragAndDrop?.canDrop(event, entry?.action, position)) {
			this.clearDropTarget();
			return;
		}
		if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
		if (this.isNoopDrop(entry, position)) {
			this.clearDropTarget();
			return;
		}
		this.updateDropTarget(entry?.container, position);
		this.dragAndDrop.onDragOver?.(entry?.action, position, event, duration);
	}

	private onDrop(event: DragEvent): void {
		const { entry, position } = this.dropTargetFromEvent(event);
		if (!this.dragAndDrop?.canDrop(event, entry?.action, position)) return;
		if (this.isNoopDrop(entry, position)) {
			this.endDrag();
			return;
		}
		this.clearDropTarget();
		this.dragAndDrop.onDrop(entry?.action, position, event);
		this.endDrag();
	}

	private onEntryDragEnter(entry: ActionBarEntry, event: DragEvent): void {
		const position = this.dropPositionForEntry(entry, event);
		if (!this.dragAndDrop?.canDrop(event, entry.action, position)) return;
		if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
		this.dragAndDrop.onDragEnter?.(entry.action, position, event);
	}

	private onEntryDragOver(entry: ActionBarEntry, event: DragEvent, duration: number): void {
		const position = this.dropPositionForEntry(entry, event);
		if (!this.dragAndDrop?.canDrop(event, entry.action, position)) {
			this.clearDropTarget();
			return;
		}
		if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
		if (this.isNoopDrop(entry, position)) {
			this.clearDropTarget();
			return;
		}
		this.updateDropTarget(entry.container, position);
		this.dragAndDrop.onDragOver?.(entry.action, position, event, duration);
	}

	private onEntryDrop(entry: ActionBarEntry, event: DragEvent): void {
		const position = this.dropPositionForEntry(entry, event);
		if (!this.dragAndDrop?.canDrop(event, entry.action, position)) return;
		if (this.isNoopDrop(entry, position)) {
			this.endDrag();
			return;
		}
		this.clearDropTarget();
		this.dragAndDrop.onDrop(entry.action, position, event);
		this.endDrag();
	}

	private endDrag(): void {
		const wasDragging = this.dragging;
		this.dragging = false;
		this.draggingEntry = undefined;
		const dragged = this.element.querySelector<HTMLElement>(`.${DndCssClasses.Dragging}`);
		dragged?.classList.remove(DndCssClasses.Dragging);
		this.clearDropTarget();
		if (wasDragging) this.dragAndDrop?.onDragEnd();
	}

	private entryFromEvent(event: DragEvent): ActionBarEntry | undefined {
		const target = event.target as Element | null;
		let container = target?.closest<HTMLElement>(".ash-action-view-item");
		while (container && this.element.contains(container)) {
			const entry = this.entries.find((candidate) => candidate.container === container);
			if (entry) return entry;
			container = container.parentElement?.closest<HTMLElement>(".ash-action-view-item") ?? null;
		}
		return undefined;
	}

	private dropTargetFromEvent(event: DragEvent): { entry: ActionBarEntry | undefined; position: ActionBarDropPosition } {
		const coordinate = this.orientation === "horizontal" ? event.clientX : event.clientY;
		let lastLaidOutEntry: ActionBarEntry | undefined;
		for (const entry of this.entries) {
			const rect = entry.container.getBoundingClientRect();
			const start = this.orientation === "horizontal" ? rect.left : rect.top;
			const extent = this.orientation === "horizontal" ? rect.width : rect.height;
			if (extent <= 0) continue;
			lastLaidOutEntry = entry;
			if (coordinate < start + extent / 2) return { entry, position: "before" };
		}
		if (lastLaidOutEntry) return { entry: lastLaidOutEntry, position: "after" };
		const entry = this.entryFromEvent(event);
		return { entry, position: entry ? "before" : "after" };
	}

	private isNoopDrop(entry: ActionBarEntry | undefined, position: ActionBarDropPosition): boolean {
		const sourceIndex = this.draggingEntry ? this.entries.indexOf(this.draggingEntry) : -1;
		if (sourceIndex < 0) return false;
		const targetIndex = entry ? this.entries.indexOf(entry) : this.entries.length;
		const insertionIndex = targetIndex + (entry && position === "after" ? 1 : 0);
		return insertionIndex === sourceIndex || insertionIndex === sourceIndex + 1;
	}

	private dropPositionForEntry(entry: ActionBarEntry, event: DragEvent): ActionBarDropPosition {
		const rect = entry.container.getBoundingClientRect();
		const offset = this.orientation === "horizontal" ? event.clientX - rect.left : event.clientY - rect.top;
		const extent = this.orientation === "horizontal" ? rect.width : rect.height;
		return offset <= extent / 2 ? "before" : "after";
	}

	private updateDropTarget(target: HTMLElement | undefined, position: ActionBarDropPosition): void {
		if (this.dropTarget === target && this.dropPosition === position) return;
		this.clearDropTarget();
		if (!target) return;
		this.dropTarget = target;
		this.dropPosition = position;
		target.classList.add(position === "before" ? DndCssClasses.DropBefore : DndCssClasses.DropAfter);
	}

	private clearDropTarget(): void {
		if (!this.dropTarget || !this.dropPosition) return;
		this.dropTarget.classList.remove(this.dropPosition === "before" ? DndCssClasses.DropBefore : DndCssClasses.DropAfter);
		this.dropTarget = undefined;
		this.dropPosition = undefined;
	}

	private onDragLeave(): void {
		this.clearDropTarget();
		this.dragAndDrop?.onDragLeave?.();
	}

	private hasMatchingStructure(actions: readonly IAction[]): boolean {
		return actions.length === this.entries.length && actions.every(
			(action, index) => action.id === this.entries[index]?.action.id,
		);
	}

	private replaceEntry(entry: ActionBarEntry, action: IAction): void {
		const wasTabStop = entry.item === this.tabStop;
		const hadFocus = entry.container.contains(entry.container.ownerDocument.activeElement);
		entry.store.dispose();
		entry.container.replaceChildren();
		entry.container.classList.toggle("icon", action.icon !== undefined);
		entry.action = action;
		const replacement = this.createEntry(action, entry.container);
		entry.item = replacement.item;
		entry.store = replacement.store;
		if (wasTabStop) this.tabStop = entry.item;
		entry.item.setTabbable(wasTabStop);
		if (hadFocus && action.enabled) entry.item.focus();
	}

	private navigationDirection(
		key: string,
	): "first" | "last" | "next" | "previous" | undefined {
		if (key === "Home") return "first";
		if (key === "End") return "last";
		if (this.orientation === "horizontal") {
			if (key === "ArrowRight") return "next";
			if (key === "ArrowLeft") return "previous";
			return undefined;
		}
		if (key === "ArrowDown") return "next";
		if (key === "ArrowUp") return "previous";
		return undefined;
	}
}
