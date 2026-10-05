import type { IDelayedHoverOptions } from "../../../base/browser/ui/hover/hover.js";
import { HoverPosition } from "../../../base/browser/ui/hover/hoverWidget.js";
import { getActivityHoverPosition, type IActivityHoverOptions } from "./compositeBarActions.js";
import './media/globalCompositeBar.css';
import { h } from '../../../base/browser/dom.js';
import { ActionBar } from '../../../base/browser/ui/actionbar/actionbar.js';
import type { ActionViewItem, ActionViewItemOptions } from '../../../base/browser/ui/actionbar/actionViewItems.js';
import { DropdownMenuActionViewItem } from '../../../base/browser/ui/dropdown/dropdownMenuActionViewItem.js';
import { AnchorAlignment, AnchorAxisAlignment } from '../../../base/browser/ui/contextview/contextview.js';
import { Separator, SubmenuAction, type IAction } from '../../../base/common/actions.js';
import { Emitter } from '../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import { Lxicon } from '../../../base/common/lxicons.js';
import { getFlatContextMenuActions } from '../../../platform/actions/browser/menuEntryActionViewItem.js';
import { IMenuService, MenuId } from '../../../platform/actions/common/actions.js';
import { IAccountService, type Account, type AccountState } from '../../../platform/accounts/common/accountService.js';
import { ICommandService } from '../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { IContextMenuService } from '../../../platform/contextview/browser/contextView.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../platform/storage/common/storage.js';
import { IGitHubConnectionService } from '../../services/accounts/common/gitHubConnectionService.js';
import { ILocalizationService } from '../../services/localization/common/localizationService.js';
import { ActivityBarPosition, WorkbenchConfiguration, type SideBarLocation } from '../../common/configuration.js';
import { IRendererHostService, type IRendererHost } from '../../../platform/renderer/common/rendererHost.js';

/** Account and management actions shared by the Activity Bar and title bar. */
export class GlobalCompositeBar extends Disposable {
	private static readonly accountsVisibilityKey = 'workbench.activity.showAccounts';
	public readonly domNode: HTMLDivElement;
	private readonly actionBar: ActionBar;
	private readonly changeActionsEmitter = this._register(new Emitter<void>());
	readonly onDidChangeActions = this.changeActionsEmitter.event;
	private readonly manageMenu;
	private accountsVisible: boolean;
	private accounts: readonly Account[] = [];
	private accountRevision = -1n;

	constructor(
		container: HTMLElement,
		@IMenuService private readonly menuService: IMenuService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IAccountService private readonly accountService: IAccountService,
		@ICommandService private readonly commandService: ICommandService,
		@IGitHubConnectionService private readonly githubConnection: IGitHubConnectionService,
		@ILocalizationService private readonly localizationService: ILocalizationService,
		@ILogService private readonly logService: ILogService,
		@IStorageService private readonly storageService: IStorageService,
		@IRendererHostService private readonly host: IRendererHost,
	) {
		super();
		this.accountsVisible = this.storageService.getBoolean(GlobalCompositeBar.accountsVisibilityKey, StorageScope.PROFILE, true);
		this.domNode = h(container.ownerDocument, 'div');
		this.domNode.className = 'ash-global-composite-bar';
		container.append(this.domNode);
		this._register(toDisposable(() => this.domNode.remove()));
		this.manageMenu = this._register(this.menuService.createMenu(MenuId.GlobalActivity));
		this.actionBar = this._register(new ActionBar(this.domNode, {
			ariaLabel: this.label('workbench.activityBarGlobalActions', 'Activity Bar global actions'),
			orientation: 'vertical',
			actionViewItemProvider: (action, options) => this.createActionViewItem(action, options, {
				position: () => getActivityHoverPosition(ActivityBarPosition.DEFAULT, this.configurationService.getValue<SideBarLocation>(WorkbenchConfiguration.sideBarLocation)),
			}),
		}));
		this.renderActions();
		this._register(this.storageService.onDidChangeValue(event => {
			if (event.key !== GlobalCompositeBar.accountsVisibilityKey || event.scope !== StorageScope.PROFILE || !event.external) return;
			this.accountsVisible = this.storageService.getBoolean(GlobalCompositeBar.accountsVisibilityKey, StorageScope.PROFILE, true);
			this.renderActions();
		}));
		this._register(this.accountService.onDidChangeAccounts(state => this.updateAccounts(state)));
		if (host.hasAppServer) {
			void this.accountService.read().then(state => this.updateAccounts(state), error => {
				this.logService.error('activitybar', 'Could not read accounts', error);
			});
		}
	}

	private updateAccounts(state: AccountState): void {
		if (state.revision < this.accountRevision) return;
		this.accountRevision = state.revision;
		this.accounts = state.accounts;
	}

	private renderActions(): void {
		this.actionBar.setActions(this.getActions());
		this.changeActionsEmitter.fire();
	}

	getActions(): readonly IAction[] {
		const accountsLabel = this.label('workbench.accounts', 'Accounts');
		const manageLabel = this.label('workbench.manage', 'Manage');
		return [
			...(this.accountsVisible && this.host.hasAppServer ? [{ id: 'ash.activityBar.accounts', label: accountsLabel, tooltip: accountsLabel, icon: Lxicon.account, enabled: true, run() {} }] : []),
			{ id: 'ash.activityBar.manage', label: manageLabel, tooltip: manageLabel, icon: Lxicon.gear, enabled: true, run() {} },
		];
	}

	createActionViewItem(action: IAction, options: ActionViewItemOptions, hoverOptions: IActivityHoverOptions = { position: () => HoverPosition.BELOW }): ActionViewItem | undefined {
		if (action.id !== 'ash.activityBar.accounts' && action.id !== 'ash.activityBar.manage') return undefined;
		return new GlobalActivityActionViewItem(hoverOptions,
			action,
			() => action.id === 'ash.activityBar.accounts'
				? this.accountActions()
				: getFlatContextMenuActions(this.manageMenu.getActions()),
			this.contextMenuService,
			options,
			// The title bar renders separate action items; the trigger's owner determines its menu direction.
			(anchor) => this.domNode.contains(anchor)
				? {
					anchorAxisAlignment: AnchorAxisAlignment.Horizontal,
					anchorAlignment: this.configurationService.getValue<SideBarLocation>(WorkbenchConfiguration.sideBarLocation) === 'left' ? AnchorAlignment.Right : AnchorAlignment.Left,
				}
				: { anchorAxisAlignment: AnchorAxisAlignment.Vertical, anchorAlignment: AnchorAlignment.Left },
		);
	}

	getContextMenuActions(): readonly IAction[] {
		const label = this.label('workbench.accounts', 'Accounts');
		return [{
			id: 'ash.activityBar.toggleAccounts', label, tooltip: label, enabled: true, checked: this.accountsVisible,
			run: () => {
				this.accountsVisible = !this.accountsVisible;
				this.storageService.store(GlobalCompositeBar.accountsVisibilityKey, this.accountsVisible, StorageScope.PROFILE, StorageTarget.USER);
				this.renderActions();
			},
		}];
	}

	private accountActions(): readonly IAction[] {
		const manageLabel = this.label('workbench.manageAccounts', 'Manage Accounts');
		const signOutLabel = this.label('workbench.signOut', 'Sign Out');
		const githubConnected = this.accounts.some(account => account.provider === 'github');
		const githubLabel = this.githubConnection.isConnecting
			? this.label('workbench.cancelGitHubConnection', 'Cancel GitHub connection')
			: this.label('workbench.connectGitHub', 'Connect GitHub');
		const accountActions = this.accounts.map(account => {
			const name = account.displayName ?? account.email ?? account.provider;
			const providerName = this.accountProviderName(account.provider);
			const label = this.localizationService.translate('ash', 'workbench.accountWithProvider', '{0} ({1})', { '0': name, '1': providerName });
			return new SubmenuAction(`ash.activityBar.account.${account.provider}`, label, [
				{ id: `ash.activityBar.signOut.${account.provider}`, label: signOutLabel, tooltip: signOutLabel, enabled: true, run: () => this.accountService.logout(account.provider) },
			]);
		});
		return Separator.join(accountActions, [
			{ id: 'ash.activityBar.manageAccounts', label: manageLabel, tooltip: manageLabel, enabled: true, run: () => this.commandService.executeCommand('workbench.action.manageAccounts') },
			...(!githubConnected ? [{ id: 'ash.activityBar.connectGitHub', label: githubLabel, tooltip: githubLabel, enabled: true, run: () => this.githubConnection.isConnecting ? this.githubConnection.cancel() : this.githubConnection.connect() }] : []),
		]);
	}

	private accountProviderName(provider: string): string {
		switch (provider) {
			case 'github': return 'GitHub';
			case 'chatgpt-subscription': return 'ChatGPT';
			case 'kimi-subscription': return 'Kimi';
			case 'xai-subscription': return 'Super Grok';
			case 'bigmodel-coding-plan': return 'BigModel';
			case 'zai-coding-plan': return 'Z.AI';
			case 'bigmodel-start-plan': return 'BigModel Start Plan';
			case 'zai-start-plan': return 'Z.AI Start Plan';
			default: return provider;
		}
	}

	private label(key: string, fallback: string): string {
		return this.localizationService.translate('ash', key, fallback);
	}
}

class GlobalActivityActionViewItem extends DropdownMenuActionViewItem {
	constructor(private readonly hoverOptions: IActivityHoverOptions, ...args: ConstructorParameters<typeof DropdownMenuActionViewItem>) {
		super(...args);
	}

	protected override getHoverOptions(): Pick<IDelayedHoverOptions, 'position'> {
		return { position: { hoverPosition: this.hoverOptions.position() } };
	}
}
