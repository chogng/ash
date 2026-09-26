import type { ActionBarOrientation, ActionViewItemProvider } from "../../../base/browser/ui/actionbar/actionbar.js";
import type { AnchorPosition } from "../../../base/browser/ui/contextview/contextview.js";
import { ToolBar, type MoreActionsPlacement, type ToolBarPresentation } from "../../../base/browser/ui/toolbar/toolbar.js";
import { SubmenuAction, type IAction } from "../../../base/common/actions.js";
import { Emitter } from "../../../base/common/event.js";
import type { IContextMenuProvider } from "../../../base/browser/contextmenu.js";
import type { IContextKeyService } from "../../contextkey/browser/contextKeyService.js";
import { createActionViewItem, getActionBarActions } from "./menuEntryActionViewItem.js";
import { MenuId, type IMenu, type IMenuActionOptions, type IMenuChangeEvent, type IMenuService } from "../common/actions.js";

export interface IWorkbenchToolBarOptions {
	readonly ariaLabel?: string;
	readonly orientation?: ActionBarOrientation;
	readonly actionViewItemProvider?: ActionViewItemProvider;
	readonly presentation?: ToolBarPresentation;
	readonly highlightToggledItems?: boolean;
	readonly moreActionsPlacement?: MoreActionsPlacement;
	readonly hoverAnchorPosition?: AnchorPosition;
}

/**
 * Adapts platform action representations to the base ToolBar.
 *
 * Callers still own the primary and secondary action lists. Menu-backed
 * population belongs to MenuWorkbenchToolBar.
 */
export class WorkbenchToolBar extends ToolBar {
	constructor(
		container: HTMLElement,
		contextMenuProvider: IContextMenuProvider,
		options: IWorkbenchToolBarOptions = {},
	) {
		super(container, {
			contextMenuProvider,
			ariaLabel: options.ariaLabel,
			orientation: options.orientation,
			presentation: options.presentation,
			highlightToggledItems: options.highlightToggledItems,
			moreActionsPlacement: options.moreActionsPlacement,
			hoverAnchorPosition: options.hoverAnchorPosition,
			actionViewItemProvider: (action, actionViewItemOptions) =>
				options.actionViewItemProvider?.(action, actionViewItemOptions) ??
				createActionViewItem(action, contextMenuProvider, actionViewItemOptions),
		});
	}
}

export interface IMenuWorkbenchToolBarOptions extends IWorkbenchToolBarOptions {
	readonly leadingActions?: readonly IAction[];
	readonly menuOptions?: IMenuActionOptions;
	readonly contextKeyService?: IContextKeyService;
	readonly toolbarOptions?: IToolBarRenderOptions;
}

export interface IToolBarRenderOptions {
	readonly primaryGroup?: string | ((group: string) => boolean);
	readonly shouldInlineSubmenu?: (action: SubmenuAction, group: string, groupSize: number) => boolean;
	readonly useSeparatorsInPrimaryActions?: boolean;
}

/** Keeps a WorkbenchToolBar synchronized with one registered menu location. */
export class MenuWorkbenchToolBar extends WorkbenchToolBar {
	private readonly changeMenuItemsEmitter = this._register(new Emitter<this>());
	readonly onDidChangeMenuItems = this.changeMenuItemsEmitter.event;
	private readonly menuOptions: IMenuActionOptions | undefined;
	private readonly toolbarOptions: IToolBarRenderOptions | undefined;
	private readonly leadingActions: readonly IAction[];
	private readonly menu: IMenu;

	constructor(
		container: HTMLElement,
		menuService: IMenuService,
		contextMenuProvider: IContextMenuProvider,
		menuId: MenuId,
		options: IMenuWorkbenchToolBarOptions = {},
	) {
		super(container, contextMenuProvider, options);
		this.leadingActions = options.leadingActions ?? [];
		this.menuOptions = options.menuOptions;
		this.toolbarOptions = options.toolbarOptions;
		const menu = this._register(menuService.createMenu(menuId, options.contextKeyService));
		this.menu = menu;
		this._register(menu.onDidChange((event) => {
			this.update(event);
			this.changeMenuItemsEmitter.fire(this);
		}));
		this.update();
	}

	refresh(): void {
		this.update();
	}

	override setActions(_primaryActions: readonly IAction[], _secondaryActions: readonly IAction[] = []): never {
		throw new Error("MenuWorkbenchToolBar actions are owned by its MenuId");
	}

	private update(event?: IMenuChangeEvent): void {
		const groups = this.menu.getActions(this.menuOptions);
		const { primary, secondary } = getActionBarActions(
			groups,
			this.toolbarOptions?.primaryGroup,
			this.toolbarOptions?.shouldInlineSubmenu,
			this.toolbarOptions?.useSeparatorsInPrimaryActions,
		);
		const actions = [...this.leadingActions, ...primary];
		const empty = actions.length === 0 && secondary.length === 0;
		this.element.hidden = empty;
		this.element.classList.toggle("empty", empty);
		if (event?.isStructuralChange === false) {
			super.updateActions(actions, secondary);
			return;
		}
		super.setActions(actions, secondary);
	}
}
