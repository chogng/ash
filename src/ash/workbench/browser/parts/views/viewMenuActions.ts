import type { IAction } from '../../../../base/common/actions.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { getActionBarActions, getFlatContextMenuActions, type PrimaryAndSecondaryActions } from '../../../../platform/actions/browser/menuEntryActionViewItem.js';
import { IMenuService, type MenuId, type IMenu, type IMenuActionOptions } from '../../../../platform/actions/common/actions.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';

export interface IViewMenuActionsOptions {
	readonly primaryActionGroups?: string[];
}

/** Resolves title and context actions against the scope owned by the hosting view. */
export class ViewMenuActions extends Disposable {
	private readonly titleMenu: IMenu;
	private readonly contextMenu: IMenu | undefined;
	private readonly changed = this._register(new Emitter<void>());
	public readonly onDidChange = this.changed.event;

	constructor(
		public readonly menuId: MenuId,
		contextMenuId: MenuId | undefined,
		private readonly options: IMenuActionOptions | undefined,
		private readonly menuActionsOptions: IViewMenuActionsOptions | undefined,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IMenuService menuService: IMenuService,
	) {
		super();
		this.titleMenu = this._register(menuService.createMenu(menuId, contextKeyService));
		this._register(this.titleMenu.onDidChange(() => this.changed.fire()));
		if (contextMenuId) {
			this.contextMenu = this._register(menuService.createMenu(contextMenuId, contextKeyService));
			this._register(this.contextMenu.onDidChange(() => this.changed.fire()));
		}
	}

	public getPrimaryActions(): IAction[] {
		return this.resolveTitleActions().primary;
	}

	public getSecondaryActions(): IAction[] {
		return this.resolveTitleActions().secondary;
	}

	public getContextMenuActions(): IAction[] {
		return this.contextMenu ? getFlatContextMenuActions(this.contextMenu.getActions(this.options)) : [];
	}

	private resolveTitleActions(): PrimaryAndSecondaryActions {
		return getActionBarActions(this.titleMenu.getActions(this.options), group => group === 'navigation' || this.menuActionsOptions?.primaryActionGroups?.includes(group) === true, undefined, true);
	}
}
