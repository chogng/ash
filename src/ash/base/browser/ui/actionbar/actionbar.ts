import './actionbar.css';
import { addDisposableListener, h, isElement, isHTMLElement } from '../../dom.js';
import { DataTransfers, DragAndDropObserver } from '../../dnd.js';
import { ActionRunner, type IAction, type IActionRunner } from '../../../common/actions.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../common/lifecycle.js';
import { rot } from '../../../common/numbers.js';
import { type ActionViewItem, type ActionViewItemOptions, createActionViewItem } from './actionViewItems.js';
import { DndCssClasses } from '../dnd/dnd.js';
import { Emitter, type Event } from '../../../common/event.js';
import { DropdownMenuActionViewItem } from '../dropdown/dropdownMenuActionViewItem.js';
import { disposableWindowTimeout } from '../../scheduler.js';
import { createUuid } from '../../../common/uuid.js';

export type ActionBarOrientation = 'horizontal' | 'vertical';
export type ActionBarDropPosition = 'before' | 'after';

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
	readonly actionRunner?: IActionRunner;
	readonly actions?: readonly IAction[];
	readonly ariaLabel?: string;
	readonly ariaRole?: 'toolbar' | 'tablist';
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

/** Split actions expose this event without making base depend on their platform implementation. */
interface DropdownActionViewItem extends ActionViewItem {
	readonly onDidChangeDropdownVisibility?: Event<boolean>;
}

/**
 * Owns action arrangement and composite-widget keyboard navigation.
 *
 * The optional ARIA role describes the rendered collection. Item providers
 * remain responsible for role-specific item state such as `aria-selected`.
 */
export class ActionBar extends Disposable {
	readonly element: HTMLDivElement;
	private readonly defaultActionRunner = this._register(new ActionRunner());
	private _actionRunner: IActionRunner = this.defaultActionRunner;
	private actionContext: unknown;
	private focusable = true;
	private readonly dropdownVisibilityEmitter = this._register(new Emitter<boolean>());
	readonly onDidChangeDropdownVisibility = this.dropdownVisibilityEmitter.event;
	private readonly entries: ActionBarEntry[] = [];
	private readonly visibleDropdowns = new Set<ActionViewItem>();
	private readonly pointerActivation = this._register(new MutableDisposable<DisposableStore>());
	private pendingActions: { readonly actions: readonly IAction[]; readonly update: boolean; } | undefined;
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
		const element = h(ownerDocument, 'div');
		this.element = element;
		this._register(toDisposable(() => element.remove()));
		element.className = 'ash-action-bar';
		container.append(element);
		this.orientation = options.orientation ?? 'horizontal';
		element.classList.add(this.orientation);
		element.classList.toggle('highlight-toggled', options.highlightToggledItems === true);
		element.setAttribute('role', options.ariaRole ?? 'toolbar');
		element.setAttribute('aria-orientation', this.orientation);
		if (options.ariaLabel) {
			element.setAttribute('aria-label', options.ariaLabel);
		}
		this.actionViewItemProvider = options.actionViewItemProvider;
		this._actionRunner = options.actionRunner ?? this.defaultActionRunner;
		this.actionViewItemOptions = {
			...options.actionViewItemOptions,
			hoverGroupId: options.actionViewItemOptions?.hoverGroupId ?? createUuid(),
		};
		this.dragAndDrop = options.dragAndDrop;
		element.classList.toggle('ash-action-bar-dnd', this.dragAndDrop !== undefined);
		this._register(addDisposableListener(element, 'keydown', (event) => {
			this.handleNavigation(event);
		}));
		this._register(addDisposableListener(element, 'focusin', () => {
			const activeElement = this.element.ownerDocument.activeElement;
			const entry = this.entries.find(
				({ container }) => container.contains(activeElement),
			);
			if (entry?.action.enabled) this._setTabStop(entry.item);
		}));
		// Capture before popup dismissal listeners can queue replacement of a clicked trigger.
		this._register(addDisposableListener(ownerDocument, 'pointerdown', event => this.beginPointerActivation(event), true));
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
		const container = h(this.element.ownerDocument, 'div');
		container.className = 'ash-action-view-item';
		container.classList.toggle('icon', action.icon !== undefined);
		container.dataset.actionId = action.id;
		container.setAttribute('role', 'presentation');
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
		if (this.isDisposed || this.deferActions(actions, false)) return;
		const activeElement = this.element.ownerDocument.activeElement;
		const focusedEntry = this.entries.find(({ container }) => container.contains(activeElement));
		const focusedActionId = focusedEntry?.action.id;
		const focusedControl = focusedEntry ? [...focusedEntry.container.querySelectorAll('button, [tabindex]')].indexOf(activeElement!) : -1;
		// Retained action identities keep their view and DOM through selection and reordering.
		const retained = new Map(this.entries.map(entry => [entry.action, entry]));
		const created = new Set<ActionBarEntry>();
		const next = actions.map(action => {
			const entry = retained.get(action);
			if (entry) {
				retained.delete(action);
				return entry;
			}
			const container = h(this.element.ownerDocument, 'div');
			container.className = 'ash-action-view-item';
			container.classList.toggle('icon', action.icon !== undefined);
			container.dataset.actionId = action.id;
			container.setAttribute('role', 'presentation');
			const createdEntry = this.createEntry(action, container);
			created.add(createdEntry);
			return createdEntry;
		});
		for (const entry of retained.values()) {
			entry.store.dispose();
			entry.container.remove();
		}
		this.entries.splice(0, this.entries.length, ...next);
		for (let index = 0; index < next.length; index += 1) {
			const container = next[index]!.container;
			if (this.element.children[index] !== container) {
				this.element.insertBefore(container, this.element.children[index] ?? null);
			}
		}
		const tabStop = next.find(entry => entry.action.enabled && entry.item === this.tabStop)
			?? next.find(entry => entry.action.enabled);
		// Retained slots already project their Tab state; only new or changed slots need a DOM write.
		for (const entry of next) {
			if (created.has(entry) || (entry.item === this.tabStop) !== (entry === tabStop)) entry.item.setTabbable(this.focusable && entry === tabStop);
		}
		this.tabStop = tabStop?.item;
		if (focusedActionId && this.element.ownerDocument.activeElement !== activeElement) {
			const entry = next.find(({ action }) => action.id === focusedActionId && action.enabled)
				?? next.find(({ action }) => action.enabled);
			if (entry) {
				this._setTabStop(entry.item);
				// Moving a retained container can blur a nested control; restore that control, not the item's default target.
				if (isHTMLElement(activeElement) && entry.container.contains(activeElement)) {
					activeElement.focus();
				} else {
					this.focusEntry(entry, entry.action.id === focusedActionId ? focusedControl : -1);
				}
			}
		}
	}

	/** Updates retained action slots when menu structure and ordering are stable. */
	updateActions(actions: readonly IAction[]): void {
		if (this.isDisposed || this.deferActions(actions, true)) return;
		if (!this.hasMatchingStructure(actions)) {
			this.setActions(actions);
			return;
		}
		const document = this.element.ownerDocument;
		const hadFocus = this.element.contains(document.activeElement);
		let replaced = false;
		for (let index = 0; index < actions.length; index += 1) {
			if (this.entries[index]!.action !== actions[index]) {
				this.replaceEntry(this.entries[index]!, actions[index]!);
				replaced = true;
			}
		}
		if (!replaced) {
			return;
		}
		// An updated action can become disabled without changing the collection's structure.
		const tabStop = this.entries.find(entry => entry.item === this.tabStop && entry.action.enabled)
			?? this.entries.find(entry => entry.action.enabled);
		if (tabStop) {
			this._setTabStop(tabStop.item);
		} else {
			this.tabStop?.setTabbable(false);
			this.tabStop = undefined;
		}
		if (hadFocus && document.activeElement === document.body) {
			tabStop?.item.focus();
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

	/** Returns the rendered width of an action slot, excluding the bar's gap. */
	getItemWidth(index: number): number {
		return this.entries[index]?.container.getBoundingClientRect().width ?? 0;
	}

	get actionRunner(): IActionRunner {
		return this._actionRunner;
	}

	set actionRunner(runner: IActionRunner) {
		this._actionRunner = runner;
		for (const entry of this.entries) entry.item.actionRunner = runner;
	}

	set context(context: unknown) {
		this.actionContext = context;
		for (const entry of this.entries) entry.item.setActionContext(context);
	}

	getAction(indexOrElement: number | HTMLElement): IAction | undefined {
		return typeof indexOrElement === 'number' ? this.entries[indexOrElement]?.action
			: this.entries.find(entry => entry.container.contains(indexOrElement))?.action;
	}

	getItemElement(index: number): HTMLElement | undefined {
		return this.entries[index]?.container;
	}

	length(): number {
		return this.entries.length;
	}

	setFocusable(focusable: boolean): void {
		this.focusable = focusable;
		this.tabStop?.setTabbable(focusable);
	}

	focus(index?: number): void {
		const entry = (index === undefined ? undefined : this.entries[index])
			?? this.entries.find(({ item, action }) => item === this.tabStop && action.enabled)
			?? this.entries.find(({ action }) => action.enabled);
		if (!entry?.action.enabled) return;
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
		if (direction === 'first') {
			targetIndex = 0;
		} else if (direction === 'last') {
			targetIndex = entries.length - 1;
		} else if (currentIndex === -1) {
			targetIndex = direction === 'next' ? 0 : entries.length - 1;
		} else {
			const delta = direction === 'next' ? 1 : -1;
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
		item.setTabbable(this.focusable);
	}

	private clearActions(): void {
		this.pendingActions = undefined;
		for (const entry of this.entries) entry.store.dispose();
		this.entries.length = 0;
		this.visibleDropdowns.clear();
	}

	private deferActions(actions: readonly IAction[], update: boolean): boolean {
		if (this.visibleDropdowns.size > 0 || this.pointerActivation.value) {
			// Entry disposal cancels its popup, including a native OS menu. Keep the
			// displayed action snapshot alive until dismissal and retain only the latest update.
			this.pendingActions = { actions, update };
			return true;
		}
		this.pendingActions = undefined;
		return false;
	}

	private dropdownVisibilityChanged(item: ActionViewItem, visible: boolean): void {
		const wasVisible = this.visibleDropdowns.size > 0;
		if (visible) {
			this.visibleDropdowns.add(item);
		} else {
			this.visibleDropdowns.delete(item);
			this.schedulePendingActions();
		}
		const isVisible = this.visibleDropdowns.size > 0;
		if (wasVisible !== isVisible) this.dropdownVisibilityEmitter.fire(isVisible);
	}

	private schedulePendingActions(): void {
		if (!this.pendingActions) return;
		// Let the menu provider finish its hide callback and focus restoration first.
		queueMicrotask(() => {
			if (this.isDisposed || this.visibleDropdowns.size > 0 || this.pointerActivation.value) return;
			const pending = this.pendingActions;
			if (!pending) return;
			this.pendingActions = undefined;
			if (pending.update) this.updateActions(pending.actions);
			else this.setActions(pending.actions);
		});
	}

	private beginPointerActivation(event: PointerEvent): void {
		if (event.button !== 0 || !event.isPrimary || !isElement(event.target) || !this.element.contains(event.target)) return;
		const control = event.target.closest('button, input, select, textarea, [role="button"], [tabindex]');
		if (!control || !this.element.contains(control) || control.matches(':disabled') || control.getAttribute('aria-disabled') === 'true') return;
		const listeners = new DisposableStore();
		this.pointerActivation.value = listeners;
		const finish = (): void => {
			if (this.pointerActivation.value !== listeners) return;
			this.pointerActivation.clear();
			this.schedulePendingActions();
		};
		const document = this.element.ownerDocument;
		// Outside-pointer dismissal runs before the next button's click. Preserve
		// that button through activation so switching menus does not lose the click.
		listeners.add(addDisposableListener(document, 'click', finish));
		listeners.add(addDisposableListener(document, 'pointercancel', cancellation => {
			if (cancellation.pointerId === event.pointerId) finish();
		}, true));
		listeners.add(addDisposableListener(document, 'pointerup', release => {
			if (release.pointerId !== event.pointerId) return;
			if (!isElement(release.target) || !control.contains(release.target) || !document.defaultView) {
				finish();
				return;
			}
			// Actions may consume click propagation. The task boundary still lets
			// their native click finish before releasing the activation in that case.
			listeners.add(disposableWindowTimeout(document.defaultView, finish, 0));
		}, true));
		if (document.defaultView) listeners.add(addDisposableListener(document.defaultView, 'blur', finish));
	}

	private createEntry(action: IAction, container: HTMLElement): ActionBarEntry {
		const store = new DisposableStore();
		container.draggable = false;
		container.classList.remove(DndCssClasses.Draggable);
		const item: DropdownActionViewItem = store.add(
			this.actionViewItemProvider?.(action, this.actionViewItemOptions) ??
			createActionViewItem(action, this.actionViewItemOptions),
		);
		const visibility = item instanceof DropdownMenuActionViewItem ? item.onDidChangeVisibility : item.onDidChangeDropdownVisibility;
		if (visibility) {
			store.add(visibility(visible => this.dropdownVisibilityChanged(item, visible)));
			store.add(toDisposable(() => this.dropdownVisibilityChanged(item, false)));
		}
		item.actionRunner = this.actionRunner;
		item.setActionContext(this.actionContext);
		item.setHoverGroupId(this.actionViewItemOptions.hoverGroupId);
		item.render(container);
		const entry = { action, container, item, store };
		if (item.draggable) {
			container.draggable = true;
			container.classList.add(DndCssClasses.Draggable);
			store.add(addDisposableListener(container, 'dragstart', (event: DragEvent) => {
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
		if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
		this.dragAndDrop?.onDragStart(entry.action, event);
	}

	private onDragOver(event: DragEvent, duration = 0): void {
		const { entry, position } = this.dropTargetFromEvent(event);
		if (!this.dragAndDrop?.canDrop(event, entry?.action, position)) {
			this.clearDropTarget();
			return;
		}
		if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
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
		if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
		this.dragAndDrop.onDragEnter?.(entry.action, position, event);
	}

	private onEntryDragOver(entry: ActionBarEntry, event: DragEvent, duration: number): void {
		const position = this.dropPositionForEntry(entry, event);
		if (!this.dragAndDrop?.canDrop(event, entry.action, position)) {
			this.clearDropTarget();
			return;
		}
		if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
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
		let container = target?.closest<HTMLElement>('.ash-action-view-item');
		while (container && this.element.contains(container)) {
			const entry = this.entries.find((candidate) => candidate.container === container);
			if (entry) return entry;
			container = container.parentElement?.closest<HTMLElement>('.ash-action-view-item') ?? null;
		}
		return undefined;
	}

	private dropTargetFromEvent(event: DragEvent): { entry: ActionBarEntry | undefined; position: ActionBarDropPosition; } {
		const coordinate = this.orientation === 'horizontal' ? event.clientX : event.clientY;
		let lastLaidOutEntry: ActionBarEntry | undefined;
		for (const entry of this.entries) {
			const rect = entry.container.getBoundingClientRect();
			const start = this.orientation === 'horizontal' ? rect.left : rect.top;
			const extent = this.orientation === 'horizontal' ? rect.width : rect.height;
			if (extent <= 0) continue;
			lastLaidOutEntry = entry;
			if (coordinate < start + extent / 2) return { entry, position: 'before' };
		}
		if (lastLaidOutEntry) return { entry: lastLaidOutEntry, position: 'after' };
		const entry = this.entryFromEvent(event);
		return { entry, position: entry ? 'before' : 'after' };
	}

	private isNoopDrop(entry: ActionBarEntry | undefined, position: ActionBarDropPosition): boolean {
		const sourceIndex = this.draggingEntry ? this.entries.indexOf(this.draggingEntry) : -1;
		if (sourceIndex < 0) return false;
		const targetIndex = entry ? this.entries.indexOf(entry) : this.entries.length;
		const insertionIndex = targetIndex + (entry && position === 'after' ? 1 : 0);
		return insertionIndex === sourceIndex || insertionIndex === sourceIndex + 1;
	}

	private dropPositionForEntry(entry: ActionBarEntry, event: DragEvent): ActionBarDropPosition {
		const rect = entry.container.getBoundingClientRect();
		const offset = this.orientation === 'horizontal' ? event.clientX - rect.left : event.clientY - rect.top;
		const extent = this.orientation === 'horizontal' ? rect.width : rect.height;
		return offset <= extent / 2 ? 'before' : 'after';
	}

	private updateDropTarget(target: HTMLElement | undefined, position: ActionBarDropPosition): void {
		if (this.dropTarget === target && this.dropPosition === position) return;
		this.clearDropTarget();
		if (!target) return;
		this.dropTarget = target;
		this.dropPosition = position;
		target.classList.add(position === 'before' ? DndCssClasses.DropBefore : DndCssClasses.DropAfter);
	}

	private clearDropTarget(): void {
		if (!this.dropTarget || !this.dropPosition) return;
		this.dropTarget.classList.remove(this.dropPosition === 'before' ? DndCssClasses.DropBefore : DndCssClasses.DropAfter);
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
		const activeElement = entry.container.ownerDocument.activeElement;
		const hadFocus = entry.container.contains(activeElement);
		const focusedControl = [...entry.container.querySelectorAll('button, [tabindex]')].indexOf(activeElement!);
		entry.store.dispose();
		entry.container.replaceChildren();
		entry.container.classList.toggle('icon', action.icon !== undefined);
		entry.action = action;
		const replacement = this.createEntry(action, entry.container);
		entry.item = replacement.item;
		entry.store = replacement.store;
		if (wasTabStop) this.tabStop = entry.item;
		entry.item.setTabbable(this.focusable && wasTabStop);
		if (hadFocus && action.enabled) this.focusEntry(entry, focusedControl);
	}

	private focusEntry(entry: ActionBarEntry, controlIndex: number): void {
		// Split actions contain two controls; returning to their dropdown must not
		// silently move keyboard focus to the primary action after a refresh.
		const control = entry.container.querySelectorAll<HTMLElement>('button, [tabindex]')[controlIndex];
		if (control && !control.matches(':disabled') && control.getAttribute('aria-disabled') !== 'true') control.focus();
		else entry.item.focus();
	}

	private navigationDirection(
		key: string,
	): 'first' | 'last' | 'next' | 'previous' | undefined {
		if (key === 'Home') return 'first';
		if (key === 'End') return 'last';
		if (this.orientation === 'horizontal') {
			if (key === 'ArrowRight') return 'next';
			if (key === 'ArrowLeft') return 'previous';
			return undefined;
		}
		if (key === 'ArrowDown') return 'next';
		if (key === 'ArrowUp') return 'previous';
		return undefined;
	}
}
