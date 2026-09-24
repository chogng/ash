import type { IAction, IActionRunner } from "../common/actions.js";
import type { ResolvedKeybinding } from "../common/keybindings.js";
import type {
	AnchorAlignment,
	AnchorAxisAlignment,
	AnchorPosition,
} from "./ui/contextview/contextview.js";
import type { ActionViewItem } from "./ui/actionbar/actionViewItems.js";
import type { MenuActionViewItemOptions } from "./ui/menu/menu.js";

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
	getActionsContext?(event?: IContextMenuEvent): unknown;
	getCheckedActionsRepresentation?(action: IAction): "radio" | "checkbox";
	getActionViewItem?(
		action: IAction,
		options: MenuActionViewItemOptions,
	): ActionViewItem | undefined;
	getKeyBinding?(action: IAction): ResolvedKeybinding | undefined;
	getMenuClassName?(): string;
	readonly onHide?: (didCancel: boolean) => void;
	readonly actionRunner?: IActionRunner;
	readonly autoSelectFirstItem?: boolean;
	readonly anchorAlignment?: AnchorAlignment;
	readonly anchorAxisAlignment?: AnchorAxisAlignment;
	readonly anchorPosition?: AnchorPosition;
	readonly layer?: number;
}

/**
 * Presents action menus without exposing a platform service dependency.
 *
 * Base controls use this contract to delegate menu policy to the host.
 */
export interface IContextMenuProvider {
	showContextMenu(delegate: IContextMenuDelegate): void;
}
