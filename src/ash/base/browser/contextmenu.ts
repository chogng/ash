import type { IAction, IActionRunner } from '../common/actions.js';
import type { CancellationToken } from '../common/cancellation.js';
import type { ResolvedKeybinding } from '../common/keybindings.js';
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
	/** Desktop can place a non-modal menu above an embedded native view. */
	readonly useNativeWindow?: boolean;
	/** Host may measure the mounted presentation root to size its native surface. */
	readonly onDidRenderMenu?: (root: HTMLElement) => void;
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
