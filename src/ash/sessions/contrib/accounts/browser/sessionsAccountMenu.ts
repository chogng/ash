import { addDisposableListener } from '../../../../base/browser/dom.js';
import { ActionViewItem, type ActionViewItemOptions } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import type { Button } from '../../../../base/browser/ui/button/button.js';
import { AnchorAlignment, AnchorAxisAlignment, AnchorPosition } from '../../../../base/browser/ui/contextview/contextview.js';
import { HoverPosition } from '../../../../base/browser/ui/hover/hoverWidget.js';
import type { IAction } from '../../../../base/common/actions.js';
import { CancellationTokenSource, type CancellationToken } from '../../../../base/common/cancellation.js';
import { combinedDisposable, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize, localize2 } from '../../../../nls.js';
import type { IActionViewItemService } from '../../../../platform/actions/browser/actionViewItemService.js';
import { Action2, MenusRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hoverService.js';
import { getActivityHoverPosition } from '../../../../workbench/browser/parts/compositeBarActions.js';
import { ActivityBarPosition } from '../../../../workbench/common/configuration.js';
import { OpenSettingsCommandId } from '../../../../workbench/contrib/preferences/common/preferences.js';
import { Menus } from '../../../browser/menus.js';
import { SessionsConfiguration, type SessionsActivityBarLocation } from '../../../common/configuration.js';
import { SessionsActivityBarLocationContext } from '../../../common/contextkeys.js';
import { OPEN_ASH_WINDOW_COMMAND_ID, OPEN_SESSIONS_KEYBOARD_SHORTCUTS_COMMAND_ID } from '../../../common/sessionCommands.js';
import './media/sessionsAccountMenu.css';

const accountsActionId = 'sessions.activity.accounts';
const accountsInTitleBar = SessionsActivityBarLocationContext.isEqualTo(ActivityBarPosition.TOP);
const accountsInSidebar = ContextKeyExpr.and(ContextKeyExpr.has(SessionsActivityBarLocationContext.key), ContextKeyExpr.notEquals(SessionsActivityBarLocationContext.key, ActivityBarPosition.TOP));

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: accountsActionId,
			title: localize2('workbench.accounts', 'Accounts'),
			menu: [
				{ id: Menus.SidebarFooter, group: 'navigation', order: 10, when: accountsInSidebar },
				{ id: Menus.TitleBarAccounts, group: 'navigation', when: accountsInTitleBar },
			],
		});
	}

	// The registered view opens the menu from its own anchor.
	run(): void { }
});

MenusRegistry.appendMenuItems([
	{
		id: Menus.AccountMenu, item: {
			order: 0, command: {
				id: OpenSettingsCommandId, get title() { return localize('workbench.manageSettings', 'Settings'); }, icon: Lxicon.gear,
			}
		}
	},
	{
		id: Menus.AccountMenu, item: {
			order: 1, command: {
				id: 'workbench.action.manageAccounts', get title() { return localize('sessions.settings.account', 'Account'); }, icon: Lxicon.account,
			}
		}
	},
	{
		id: Menus.AccountMenu, item: {
			order: 2, command: {
				id: OPEN_ASH_WINDOW_COMMAND_ID, get title() { return localize('sessions.menu.openIde', 'Open IDE'); }, icon: Lxicon.code,
			}
		}
	},
	{
		id: Menus.AccountMenu, item: {
			order: 3, command: {
				id: OPEN_SESSIONS_KEYBOARD_SHORTCUTS_COMMAND_ID, get title() { return localize('sessions.accountMenu.shortcuts', 'Shortcuts'); }, icon: Lxicon.recordKeys,
			}
		}
	},
]);

/** Sessions account actions shown beside the Activity Bar account button. */
export class SessionsAccountMenu {
	constructor(
		@IContextMenuService private readonly contextMenus: IContextMenuService,
		@IContextKeyService private readonly contextKeys: IContextKeyService,
	) { }

	registerActionViewItems(presentations: IActionViewItemService, showContextMenu: (event: MouseEvent | KeyboardEvent) => void): IDisposable {
		return combinedDisposable(
			presentations.register(Menus.SidebarFooter, accountsActionId, (action, options, instantiation) =>
				instantiation.createInstance(AccountsActionViewItem, action, options, false, this, showContextMenu)),
			presentations.register(Menus.TitleBarAccounts, accountsActionId, (action, options, instantiation) =>
				instantiation.createInstance(AccountsActionViewItem, action, options, true, this, undefined)),
		);
	}

	public show(anchor: HTMLElement, autoSelectFirstItem = false, cancellationToken?: CancellationToken): void {
		const rail = anchor.closest<HTMLElement>('[data-activity-bar-side]')?.dataset.activityBarSide;
		const footer = rail ? undefined : anchor.closest('.ash-sessions-sidebar-footer');
		// The popup restores this trigger before an action opens a dialog.
		anchor.focus();
		anchor.classList.add('active');
		anchor.setAttribute('aria-expanded', 'true');
		this.contextMenus.showContextMenu({
			getAnchor: () => footer ?? anchor,
			anchorAlignment: rail ? AnchorAlignment.Right : footer ? AnchorAlignment.Center : undefined,
			anchorAxisAlignment: rail ? AnchorAxisAlignment.Horizontal : undefined,
			anchorPosition: rail === 'left' ? AnchorPosition.Below : rail || footer ? AnchorPosition.Above : undefined,
			menuId: Menus.AccountMenu,
			contextKeyService: this.contextKeys.getContextKeyService(anchor),
			getMenuClassName: () => rail ? 'ash-sessions-account-menu ash-sessions-rail-account-menu' : footer ? 'ash-sessions-account-menu ash-sessions-sidebar-account-menu' : 'ash-sessions-account-menu',
			autoSelectFirstItem,
			cancellationToken,
			onHide: () => {
				anchor.classList.remove('active');
				anchor.setAttribute('aria-expanded', 'false');
			},
		});
	}
}

class AccountsActionViewItem extends ActionViewItem {
	private button!: Button;

	constructor(
		action: IAction,
		private readonly options: ActionViewItemOptions,
		private readonly inTitleBar: boolean,
		private readonly menu: SessionsAccountMenu,
		private readonly showContextMenu: ((event: MouseEvent | KeyboardEvent) => void) | undefined,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IHoverService private readonly hover: IHoverService,
	) { super(action, options); }

	override render(container: HTMLElement): void {
		const location = this.configuration.getValue<SessionsActivityBarLocation>(SessionsConfiguration.activityBarLocation);
		const side = location === 'left' || location === 'right' ? location : undefined;
		const anchorLifetime = new CancellationTokenSource();
		const button = this.button = this.createButton(container, {
			label: this.action.label,
			icon: Lxicon.account,
			iconOnly: this.inTitleBar || !!side,
			onClick: event => this.menu.show(button.domNode, event.detail === 0, anchorLifetime.token),
		});
		// The visible menu can be positioned relative to the footer, which outlives this button.
		this._register(toDisposable(() => anchorLifetime.dispose(true)));
		if (this.inTitleBar) {
			container.classList.add('icon');
		} else {
			container.classList.add('ash-sessions-activity-bottom');
			container.classList.toggle('labeled', !side);
			button.domNode.classList.add('ash-sessions-activity-item');
		}
		button.domNode.setAttribute('aria-haspopup', 'menu');
		button.domNode.setAttribute('aria-expanded', 'false');
		this._register(this.hover.setupDelayedHover(button.domNode, () => {
			const location = this.configuration.getValue<SessionsActivityBarLocation>(SessionsConfiguration.activityBarLocation);
			const hoverPosition = location === 'left' || location === 'right'
				? getActivityHoverPosition(ActivityBarPosition.DEFAULT, location)
				: getActivityHoverPosition(location, 'left');
			return {
				content: this.action.label,
				position: { hoverPosition: this.inTitleBar ? HoverPosition.BELOW : hoverPosition },
			};
		}, { groupId: this.options.hoverGroupId }));
		const showContextMenu = this.showContextMenu;
		if (showContextMenu) {
			this._register(addDisposableListener(button.domNode, 'contextmenu', showContextMenu));
			this._register(addDisposableListener(button.domNode, 'keydown', event => {
				if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) showContextMenu(event);
			}));
		}
	}

	override focus(): void { this.button.focus(); }
	override setTabbable(tabbable: boolean): void { this.button.domNode.tabIndex = tabbable ? 0 : -1; }
}
