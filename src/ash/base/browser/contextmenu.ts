import type { IAction, IActionRunner } from '../common/actions.js';
import type { CancellationToken } from '../common/cancellation.js';
import type { ResolvedKeybinding } from '../common/keybindings.js';
import { toDisposable, type IDisposable } from '../common/lifecycle.js';
import type {
	AnchorAlignment,
	AnchorAxisAlignment,
	AnchorPosition,
	ContextViewHideReason,
} from './ui/contextview/contextview.js';
import type { ActionViewItem } from './ui/actionbar/actionViewItems.js';
import type { IMenuOptions, MenuActionViewItemOptions } from './ui/menu/menu.js';

export interface IContextMenuPoint {
	readonly x: number;
	readonly y: number;
	/** Window whose viewport owns these coordinates. */
	readonly targetWindow?: Window;
}

export type ContextMenuAnchor = Element | IContextMenuPoint;

export interface IContextMenuEvent {
	readonly shiftKey?: boolean;
	readonly ctrlKey?: boolean;
	readonly altKey?: boolean;
	readonly metaKey?: boolean;
}

/** Complete rendering request understood by a context-menu host. */
export interface IContextMenuDelegate {
	getAnchor(): ContextMenuAnchor;
	getActions(): readonly IAction[];
	/** The UI element the menu acts on, independent of the anchor used for positioning. */
	readonly menuTarget?: {
		readonly element: HTMLElement;
		/** Resolves the initiating control, if it presents this menu with aria-expanded. */
		readonly getExpandedTrigger?: () => HTMLElement | null | undefined;
	};
	/** Desktop can place a non-modal menu above an embedded native view. */
	readonly useNativeWindow?: boolean;
	/** Host may measure and present its native surface before the menu takes focus. */
	readonly onDidRenderMenu?: (root: HTMLElement) => void | Promise<void>;
	/** Runtime-owned mount for the menu and its submenus in a separate document. */
	readonly contextViewContainer?: HTMLElement;
	/** Element that should own the browser menu's isolated DOM and styles. */
	readonly domForShadowRoot?: HTMLElement;
	getActionsContext?(event?: IContextMenuEvent): unknown;
	getCheckedActionsRepresentation?(action: IAction): 'radio' | 'checkbox';
	getActionViewItem?(
		action: IAction,
		options: MenuActionViewItemOptions,
	): ActionViewItem | undefined;
	getKeyBinding?(action: IAction): ResolvedKeybinding | undefined;
	/** Applies caller-owned styling and selects browser rendering on Desktop. */
	getMenuClassName?(): string;
	/** Caller-owned styling applied to every submenu of this popup. */
	readonly submenuClassName?: string;
	/** Use the browser menu's trailing icon column for this menu and its submenus. */
	readonly iconPlacement?: IMenuOptions['iconPlacement'];
	/** Browser menus also report how the popup closed. */
	readonly onHide?: (didCancel: boolean, reason?: ContextViewHideReason) => void;
	/** Cancels only this presentation; an action that has already started still completes. */
	readonly cancellationToken?: CancellationToken;
	readonly actionRunner?: IActionRunner;
	/** Selects the first enabled action on opening; otherwise only the menu receives focus. */
	readonly autoSelectFirstItem?: boolean;
	readonly anchorAlignment?: AnchorAlignment;
	readonly anchorAxisAlignment?: AnchorAxisAlignment;
	readonly anchorPosition?: AnchorPosition;
	/** Space between the trigger and a browser-rendered menu. */
	readonly gap?: number;
	readonly layer?: number;
	readonly openSubmenusImmediatelyOnHover?: boolean;
}

/**
 * Presents action menus without exposing a platform service dependency.
 *
 * Base controls use this contract to delegate menu policy to the host.
 */
export interface IContextMenuProvider {
	showContextMenu(delegate: IContextMenuDelegate): void;
}

export const contextMenuTargetClass = 'ash-context-menu-target';
type MenuTrigger = () => HTMLElement | null | undefined;
const targetReferences = new WeakMap<HTMLElement, Set<MenuTrigger>>();

/** Reads the menu state when its initiating control is rendered again. */
export function isContextMenuTriggerExpanded(element: HTMLElement, trigger: HTMLElement): boolean {
	const references = targetReferences.get(element);
	if (!references) return false;
	for (const getTrigger of references) {
		if (getTrigger() === trigger) return true;
	}
	return false;
}

/** Owns the visual target and expanded state for one menu presentation. */
export function showContextMenuTarget(target: NonNullable<IContextMenuDelegate['menuTarget']>): IDisposable {
	const { element, getExpandedTrigger } = target;
	const getTrigger = () => getExpandedTrigger?.();
	const trigger = getTrigger();
	const references = targetReferences.get(element) ?? new Set<MenuTrigger>();
	references.add(getTrigger);
	targetReferences.set(element, references);
	element.classList.add(contextMenuTargetClass);
	trigger?.setAttribute('aria-expanded', 'true');
	return toDisposable(() => {
		// An asynchronous native close can arrive after a successor marks the same target.
		references.delete(getTrigger);
		if (references.size === 0) {
			targetReferences.delete(element);
			element.classList.remove(contextMenuTargetClass);
		}
		const currentTrigger = getTrigger();
		if (trigger && trigger !== currentTrigger) {
			trigger.setAttribute('aria-expanded', String(isContextMenuTriggerExpanded(element, trigger)));
		}
		if (currentTrigger) {
			currentTrigger.setAttribute('aria-expanded', String(isContextMenuTriggerExpanded(element, currentTrigger)));
		}
	});
}
