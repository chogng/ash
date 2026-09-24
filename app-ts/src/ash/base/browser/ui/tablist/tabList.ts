import "./tablist.css";
import { addDisposableListener } from "../../dom.js";
import type { Icon } from "../../../common/icon.js";
import type { IAction } from "../../../common/actions.js";
import { Disposable } from "../../../common/lifecycle.js";
import { ActionBar, type ActionBarDragAndDrop, type ActionBarDropPosition, type ActionBarOrientation } from "../actionbar/actionbar.js";
import { ScrollableElement } from "../scrollbar/scrollableElement.js";
import { TabAction, TabActionViewItem } from "./tabActionViewItem.js";

export { TAB_CLOSE_ACTION_ID } from "./tabActionViewItem.js";

/** Accessible actions rendered after one Tab's label content. */
export interface TabListActions {
	readonly ariaLabel: string;
	readonly items: readonly IAction[];
}

/** One selectable content identity rendered by a TabList. */
export interface TabListItem<T> {
	readonly id: string;
	readonly value: T;
	readonly label: string;
	readonly description?: string;
	readonly ariaLabel?: string;
	readonly tooltip?: string;
	readonly icon?: Icon;
	readonly state?: string;
	/** Presents transient preview content without changing tab selection semantics. */
	readonly preview?: boolean;
	readonly tabId: string;
	readonly panelId?: string;
	readonly actions?: TabListActions;
}

/** Named visual presentation for the ActionBar and tabs rendered by a TabList. */
export type TabListPresentation = "flush" | "inset";
export type TabListDropPosition = ActionBarDropPosition;

/** Drag callbacks for a tab list; the caller owns payload and mutation semantics. */
export interface TabListDragAndDrop<T> {
	readonly canDrop: (event: DragEvent, target: T | undefined, position: TabListDropPosition) => boolean;
	readonly onDragStart: (value: T, event: DragEvent) => void;
	readonly onDragEnter?: (target: T | undefined, position: TabListDropPosition, event: DragEvent) => void;
	readonly onDragOver?: (target: T | undefined, position: TabListDropPosition, event: DragEvent, duration: number) => void;
	readonly onDragLeave?: () => void;
	readonly onDrop: (target: T | undefined, position: TabListDropPosition, event: DragEvent) => void;
	readonly onDragEnd: () => void;
}

/** Construction inputs for a manually activated TabList. */
export interface TabListOptions<T> {
	readonly ariaLabel: string;
	readonly presentation?: TabListPresentation;
	readonly orientation?: ActionBarOrientation;
	readonly onActivate: (value: T) => void;
	readonly onClose?: (value: T) => void;
	readonly closeActionIcon?: Icon;
	/** Makes tab items native drag sources without defining any drop behavior. */
	readonly draggable?: boolean;
	readonly dragAndDrop?: TabListDragAndDrop<T>;
}

/**
 * Domain-neutral tab semantics built on the shared roving-focus engine.
 *
 * Arrow keys move focus without changing selection. Callers own content
 * activation and panel lifetimes, then provide the resulting selected ID.
 */
export class TabList<T> extends Disposable {
	readonly element: HTMLDivElement;
	private readonly actionBar: ActionBar;
	private readonly scrollable: ScrollableElement;
	private readonly activate: (value: T) => void;
	private presentation: TabListPresentation;

	constructor(container: HTMLElement, options: TabListOptions<T>) {
		super();
		this.activate = options.onActivate;
		const onClose = options.onClose;
		const closeActionIcon = options.closeActionIcon;
		const presentation = options.presentation ?? "flush";
		this.presentation = presentation;
		const orientation = options.orientation ?? "horizontal";
		const dragAndDrop = options.dragAndDrop;
		const actionBarDragAndDrop: ActionBarDragAndDrop | undefined = dragAndDrop
			? {
				canDrop: (event, action, position) => dragAndDrop.canDrop(event, action instanceof TabAction ? action.tab.value : undefined, position),
				onDragStart: (action, event) => {
					if (action instanceof TabAction) dragAndDrop.onDragStart(action.tab.value, event);
				},
				onDragEnter: (action, position, event) => {
					dragAndDrop.onDragEnter?.(action instanceof TabAction ? action.tab.value : undefined, position, event);
				},
				onDragOver: (action, position, event, duration) => {
					dragAndDrop.onDragOver?.(action instanceof TabAction ? action.tab.value : undefined, position, event, duration);
				},
				onDragLeave: () => dragAndDrop.onDragLeave?.(),
				onDrop: (action, position, event) => {
					dragAndDrop.onDrop(action instanceof TabAction ? action.tab.value : undefined, position, event);
				},
				onDragEnd: () => dragAndDrop.onDragEnd(),
			}
			: undefined;
		const scrollableOptions = orientation === "vertical"
			? { direction: "vertical" as const, vertical: "auto" as const, tabIndex: -1, wheel: { consume: "when-scrolling" as const } }
			: { direction: "horizontal" as const, horizontal: "auto" as const, tabIndex: -1, wheel: { consume: "when-scrolling" as const } };
		this.scrollable = this._register(new ScrollableElement(container, scrollableOptions));
		this.actionBar = this._register(new ActionBar(this.scrollable.contentElement, {
			ariaLabel: options.ariaLabel,
			ariaRole: "tablist",
			orientation,
			dragAndDrop: actionBarDragAndDrop,
			actionViewItemProvider: (action) => {
				if (!(action instanceof TabAction)) {
					throw new TypeError(`Unsupported TabList action: ${action.id}`);
				}
				return new TabActionViewItem(action, onClose, closeActionIcon, options.draggable === true);
			},
		}));
		this.scrollable.element.classList.add("ash-tab-list");
		this.scrollable.element.classList.add(`ash-tab-list-${presentation}`);
		this.scrollable.contentElement.classList.add(
			"ash-tab-list-scroll-content",
		);
		this.element = this.scrollable.element;
	}

	setPresentation(presentation: TabListPresentation): void {
		if (this.presentation === presentation) return;
		this.element.classList.remove(`ash-tab-list-${this.presentation}`);
		this.presentation = presentation;
		this.element.classList.add(`ash-tab-list-${presentation}`);
	}

	setTabs(
		tabs: readonly TabListItem<T>[],
		selectedId: string | undefined,
	): void {
		const ids = new Set<string>();
		const tabIds = new Set<string>();
		for (const tab of tabs) {
			if (ids.has(tab.id)) {
				throw new TypeError(`Duplicate TabList item ID: ${tab.id}`);
			}
			if (tabIds.has(tab.tabId)) {
				throw new TypeError(`Duplicate TabList DOM ID: ${tab.tabId}`);
			}
			ids.add(tab.id);
			tabIds.add(tab.tabId);
		}
		if (selectedId !== undefined && !ids.has(selectedId)) {
			throw new RangeError(`Selected TabList item is not available: ${selectedId}`);
		}
		this.actionBar.setActions(tabs.map((tab) => new TabAction(
			tab,
			tab.id === selectedId,
			this.activate,
		)));
		if (selectedId !== undefined) this.actionBar.setTabStop(selectedId);
		this.scrollable.layout();
		if (selectedId !== undefined) {
			const selectedTab = [...this.actionBar.element.querySelectorAll<HTMLElement>(".ash-tab")]
				.find((element) => element.dataset.actionId === selectedId);
			if (selectedTab) this.scrollable.reveal(selectedTab);
		}
	}
}
