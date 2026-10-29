import './tablist.css';
import { addDisposableListener, getActiveElement } from '../../dom.js';
import { AnimationFrameScheduler } from '../../scheduler.js';
import type { Icon } from '../../../common/icon.js';
import type { IAction } from '../../../common/actions.js';
import { Disposable, toDisposable, type IDisposable } from '../../../common/lifecycle.js';
import {
	ActionBar,
	type ActionBarDragAndDrop,
	type ActionBarDropPosition,
	type ActionBarOrientation,
} from '../actionbar/actionbar.js';
import { ScrollableElement } from '../scrollbar/scrollableElement.js';
import type { ScrollableElementUpdateOptions } from '../scrollbar/scrollableElementOptions.js';
import { TabAction, TabActionViewItem } from './tabActionViewItem.js';

export { TAB_CLOSE_ACTION_ID } from './tabActionViewItem.js';

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
	readonly ariaDescription?: string;
	readonly tooltip?: string;
	/** Host-resolved close tooltip, including its configured shortcut when available. */
	readonly closeActionTooltip?: string;
	readonly icon?: Icon;
	/** Creates a custom label once per item identity; the caller updates it and the view owns its lifetime. */
	readonly renderLabel?: (container: HTMLElement) => IDisposable;
	readonly state?: string;
	/** Presents transient preview content without changing tab selection semantics. */
	readonly preview?: boolean;
	readonly tabId: string;
	readonly panelId?: string;
	readonly actions?: TabListActions;
	/** Replaces the default close button with an actual action; Delete still invokes onClose. */
	readonly primaryAction?: IAction;
}

/** Flush and inset serve document tabs; navigation and underline fit page categories to their labels. */
export type TabListPresentation = 'flush' | 'inset' | 'navigation' | 'underline';
/** Fit preserves labels; shrink shares available space; fixed shares bounded equal widths. */
export type TabListSizing =
	| { readonly mode: 'fit' | 'shrink' }
	| { readonly mode: 'fixed'; readonly minWidth: number; readonly maxWidth: number };
export type TabListDropPosition = ActionBarDropPosition;

/** Drag callbacks for a tab list; the caller owns payload and mutation semantics. */
export interface TabListDragAndDrop<T> {
	readonly canDrop: (event: DragEvent, target: T | undefined, position: TabListDropPosition) => boolean;
	readonly onDragStart: (value: T, event: DragEvent) => void;
	readonly onDragEnter?: (target: T | undefined, position: TabListDropPosition, event: DragEvent) => void;
	readonly onDragOver?: (
		target: T | undefined,
		position: TabListDropPosition,
		event: DragEvent,
		duration: number,
	) => void;
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
	/** Returns true when a modifier selection consumed the activation. */
	readonly onSelect?: (value: T, event: MouseEvent | KeyboardEvent) => boolean;
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
	readonly scrollableElement: HTMLDivElement;
	private readonly actionBar: ActionBar;
	private readonly actions = new Map<string, TabAction<T>>();
	private readonly views = new Map<string, TabActionViewItem<T>>();
	private readonly scrollable: ScrollableElement;
	private readonly activate: (value: T) => void;
	private readonly select: ((value: T, event: MouseEvent | KeyboardEvent) => boolean) | undefined;
	private presentation: TabListPresentation;
	private readonly layoutScheduler: AnimationFrameScheduler;
	private selectedTab: HTMLElement | undefined;

	constructor(container: HTMLElement, options: TabListOptions<T>) {
		super();
		this._register(
			toDisposable(() => {
				this.actions.clear();
				this.views.clear();
			}),
		);
		this.activate = options.onActivate;
		this.select = options.onSelect;
		const onClose = options.onClose;
		const closeActionIcon = options.closeActionIcon;
		const presentation = options.presentation ?? 'flush';
		this.presentation = presentation;
		const orientation = options.orientation ?? 'horizontal';
		const dragAndDrop = options.dragAndDrop;
		const actionBarDragAndDrop: ActionBarDragAndDrop | undefined = dragAndDrop
			? {
					canDrop: (event, action, position) =>
						dragAndDrop.canDrop(
							event,
							action instanceof TabAction ? action.tab.value : undefined,
							position,
						),
					onDragStart: (action, event) => {
						if (action instanceof TabAction) dragAndDrop.onDragStart(action.tab.value, event);
					},
					onDragEnter: (action, position, event) => {
						dragAndDrop.onDragEnter?.(
							action instanceof TabAction ? action.tab.value : undefined,
							position,
							event,
						);
					},
					onDragOver: (action, position, event, duration) => {
						dragAndDrop.onDragOver?.(
							action instanceof TabAction ? action.tab.value : undefined,
							position,
							event,
							duration,
						);
					},
					onDragLeave: () => dragAndDrop.onDragLeave?.(),
					onDrop: (action, position, event) => {
						dragAndDrop.onDrop(action instanceof TabAction ? action.tab.value : undefined, position, event);
					},
					onDragEnd: () => dragAndDrop.onDragEnd(),
				}
			: undefined;
		const scrollableOptions =
			orientation === 'vertical'
				? {
						direction: 'vertical' as const,
						vertical: 'auto' as const,
						tabIndex: -1,
						wheel: { consume: 'when-scrolling' as const },
					}
				: {
						direction: 'horizontal' as const,
						horizontal: 'auto' as const,
						tabIndex: -1,
						wheel: { consume: 'when-scrolling' as const },
					};
		this.scrollable = this._register(new ScrollableElement(container, scrollableOptions));
		this.actionBar = this._register(
			new ActionBar(this.scrollable.contentElement, {
				ariaLabel: options.ariaLabel,
				ariaRole: 'tablist',
				orientation,
				dragAndDrop: actionBarDragAndDrop,
				actionViewItemProvider: action => {
					if (!(action instanceof TabAction)) {
						throw new TypeError(`Unsupported TabList action: ${action.id}`);
					}
					const view = new TabActionViewItem<T>(action, onClose, closeActionIcon, options.draggable === true);
					this.views.set(action.id, view);
					return view;
				},
			}),
		);
		this.scrollable.element.classList.add('ash-tab-list');
		this.scrollable.element.classList.add(`ash-tab-list-${presentation}`);
		this.scrollable.contentElement.classList.add('ash-tab-list-scroll-content');
		this.element = this.scrollable.element;
		this.scrollableElement = this.scrollable.scrollableElement;
		this.layoutScheduler = this._register(
			new AnimationFrameScheduler(container.ownerDocument.defaultView!, () => {
				// Refreshes must keep a manually focused tab visible even when it is not selected.
				const focusedTab = getActiveElement(this.element.ownerDocument)?.closest<HTMLElement>('.ash-tab');
				const revealTab =
					focusedTab && this.actionBar.element.contains(focusedTab) ? focusedTab : this.selectedTab;
				if (revealTab?.isConnected) {
					this.scrollable.reveal(revealTab);
				} else {
					this.scrollable.layout();
				}
			}),
		);
		if (this.select) this.actionBar.element.setAttribute('aria-multiselectable', 'true');
		// Keyboard focus may move without changing the selected tab. Reveal the
		// focused item through the shared scrollbar so both states stay accessible.
		let pointerActivation = false;
		this._register(
			addDisposableListener(
				this.actionBar.element,
				'pointerdown',
				() => {
					pointerActivation = true;
				},
				true,
			),
		);
		this._register(
			addDisposableListener(this.actionBar.element.ownerDocument, 'pointerup', () => {
				pointerActivation = false;
			}),
		);
		this._register(
			addDisposableListener(this.actionBar.element.ownerDocument, 'pointercancel', () => {
				pointerActivation = false;
			}),
		);
		this._register(
			addDisposableListener(this.actionBar.element, 'focusin', event => {
				const target = event.target as HTMLElement;
				// Moving the pressed tab before pointerup prevents its click from completing.
				if (pointerActivation || target.getAttribute('role') !== 'tab') return;
				const tab = target.closest<HTMLElement>('.ash-tab');
				if (tab) {
					this.layoutScheduler.cancel();
					this.scrollable.reveal(tab);
				}
			}),
		);
	}

	public get onDidScroll(): ScrollableElement['onDidScroll'] {
		return this.scrollable.onDidScroll;
	}

	public updateScrollbarOptions(options: ScrollableElementUpdateOptions): void {
		this.scrollable.updateOptions(options);
	}

	setPresentation(presentation: TabListPresentation): void {
		if (this.presentation === presentation) return;
		this.element.classList.remove(`ash-tab-list-${this.presentation}`);
		this.presentation = presentation;
		this.element.classList.add(`ash-tab-list-${presentation}`);
	}

	setSizing(sizing: TabListSizing): void {
		for (const mode of ['fit', 'shrink', 'fixed']) {
			this.element.classList.toggle(`ash-tab-list-sizing-${mode}`, sizing.mode === mode);
		}
		if (sizing.mode === 'fixed') {
			this.element.style.setProperty('--ash-tab-list-fixed-min-width', `${sizing.minWidth}px`);
			this.element.style.setProperty('--ash-tab-list-fixed-max-width', `${sizing.maxWidth}px`);
		} else {
			this.element.style.removeProperty('--ash-tab-list-fixed-min-width');
			this.element.style.removeProperty('--ash-tab-list-fixed-max-width');
		}
	}

	setTabs(tabs: readonly TabListItem<T>[], selectedId: string | undefined, selectedIds?: ReadonlySet<string>): void {
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
		const document = this.element.ownerDocument;
		const hadFocus = this.actionBar.element.contains(getActiveElement(document));
		const actions = tabs.map(tab => {
			let action = this.actions.get(tab.id);
			const checked = tab.id === selectedId;
			const selected = selectedIds?.has(tab.id) ?? checked;
			if (action) {
				action.tab = tab;
				action.checked = checked;
				action.selected = selected;
				this.views.get(tab.id)!.update();
			} else {
				action = new TabAction(tab, checked, selected, this.activate, this.select);
				this.actions.set(tab.id, action);
			}
			return action;
		});
		// TabAction identities are retained and always enabled; reconcile the DOM only when order or membership changes.
		this.actionBar.updateActions(actions);
		for (const id of this.actions.keys()) {
			if (!ids.has(id)) {
				this.actions.delete(id);
				this.views.delete(id);
			}
		}
		const activeElement = getActiveElement(document);
		if (!this.actionBar.element.contains(activeElement)) {
			if (selectedId !== undefined) {
				this.actionBar.setTabStop(selectedId);
			}
			// Removing a focused tab leaves focus on the body. Respect any explicit focus transfer by the host.
			if (hadFocus && activeElement === document.body) {
				this.actionBar.focus();
			}
		}
		this.selectedTab = selectedId === undefined ? undefined : this.views.get(selectedId)!.domNode;
		this.layoutScheduler.schedule();
	}
}
