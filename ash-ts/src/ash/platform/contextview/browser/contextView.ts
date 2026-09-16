import type {
	IContextMenuDelegate,
	IContextMenuProvider,
} from "../../../base/browser/contextmenu.js";
import type {
	IContextViewProvider,
} from "../../../base/browser/ui/contextview/contextview.js";
import type { IAction } from "../../../base/common/actions.js";
import type { Event } from "../../../base/common/event.js";
import type {
	IMenuActionOptions,
	MenuId,
} from "../../actions/common/actions.js";
import type { IContextKeyService } from "../../contextkey/browser/contextKeyService.js";
import {
	createServiceIdentifier,
} from "../../instantiation/common/instantiation.js";

/**
 * Provides the shared transient-view host for one Workbench container.
 *
 * Consumers use the provider contract while the Workbench owns where browser
 * overlays are mounted and which platform, theme, and typography they inherit.
 */
export interface IContextViewService extends IContextViewProvider {
	readonly container: HTMLElement;
}

export const IContextViewService =
	createServiceIdentifier<IContextViewService>("contextViewService");

/** A menu contribution request with optional actions prepended by the caller. */
export type IContextMenuMenuDelegate = {
	readonly menuId?: MenuId;
	readonly menuActionOptions?: IMenuActionOptions;
	readonly contextKeyService?: IContextKeyService;
	getActions?(): readonly IAction[];
} & Omit<IContextMenuDelegate, "getActions">;

/** Window-scoped context-menu service. */
export interface IContextMenuService extends IContextMenuProvider {
	readonly onDidShowContextMenu: Event<void>;
	readonly onDidHideContextMenu: Event<void>;

	showContextMenu(
		delegate: IContextMenuDelegate | IContextMenuMenuDelegate,
	): void;
	hideContextMenu(): void;
}

export const IContextMenuService =
	createServiceIdentifier<IContextMenuService>("contextMenuService");
