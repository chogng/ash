import './media/globalCompositeBar.css';
import { h } from '../../../base/browser/dom.js';
import { ActionBar } from '../../../base/browser/ui/actionbar/actionbar.js';
import type { ActionViewItem, ActionViewItemOptions } from '../../../base/browser/ui/actionbar/actionViewItems.js';
import { DropdownMenuActionViewItem } from '../../../base/browser/ui/dropdown/dropdownMenuActionViewItem.js';
import { AnchorAlignment, AnchorAxisAlignment } from '../../../base/browser/ui/contextview/contextview.js';
import type { IAction } from '../../../base/common/actions.js';
import { Emitter } from '../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import { Lxicon } from '../../../base/common/lxicons.js';
import { getFlatContextMenuActions } from '../../../platform/actions/browser/menuEntryActionViewItem.js';
import { IMenuService, MenuId } from '../../../platform/actions/common/actions.js';
import { IAccountService, type Account, type AccountState } from '../../../platform/accounts/common/accountService.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { IContextMenuService } from '../../../platform/contextview/browser/contextView.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../platform/storage/common/storage.js';
import { IGitHubConnectionService } from '../../services/accounts/common/gitHubConnectionService.js';
import { ILocalizationService } from '../../services/localization/common/localizationService.js';
import { WorkbenchConfiguration, type SideBarLocation } from '../../common/configuration.js';

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
		@IGitHubConnectionService private readonly githubConnection: IGitHubConnectionService,
		@ILocalizationService private readonly localizationService: ILocalizationService,
		@ILogService private readonly logService: ILogService,
		@IStorageService private readonly storageService: IStorageService,
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
			actionViewItemProvider: (action, options) => this.createActionViewItem(action, options),
		}));
		this.renderActions();
		this._register(this.localizationService.onDidChange(() => {
			this.actionBar.element.setAttribute('aria-label', this.label('workbench.activityBarGlobalActions', 'Activity Bar global actions'));
			this.renderActions();
		}));
		this._register(this.storageService.onDidChangeValue(event => {
			if (event.key !== GlobalCompositeBar.accountsVisibilityKey || event.scope !== StorageScope.PROFILE || !event.external) return;
			this.accountsVisible = this.storageService.getBoolean(GlobalCompositeBar.accountsVisibilityKey, StorageScope.PROFILE, true);
			this.renderActions();
		}));
		this._register(this.accountService.onDidChangeAccounts(state => this.updateAccounts(state)));
		void this.accountService.read().then(state => this.updateAccounts(state), error => {
			this.logService.error('activitybar', 'Could not read accounts', error);
		});
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
			...(this.accountsVisible ? [{ id: 'ash.activityBar.accounts', label: accountsLabel, tooltip: accountsLabel, icon: Lxicon.account, enabled: true, run() {} }] : []),
			{ id: 'ash.activityBar.manage', label: manageLabel, tooltip: manageLabel, icon: Lxicon.gear, enabled: true, run() {} },
		];
	}

	createActionViewItem(action: IAction, options: ActionViewItemOptions): ActionViewItem | undefined {
		if (action.id !== 'ash.activityBar.accounts' && action.id !== 'ash.activityBar.manage') return undefined;
		return new DropdownMenuActionViewItem(
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
		const signInLabel = this.label('workbench.signInWithChatGPT', 'Sign in with ChatGPT');
		const githubConnected = this.accounts.some(account => account.provider === 'github');
		const githubLabel = this.githubConnection.isConnecting
			? this.label('workbench.cancelGitHubConnection', 'Cancel GitHub connection')
			: this.label('workbench.connectGitHub', 'Connect GitHub');
		return [
			...this.accounts.map(account => {
				const name = account.displayName ?? account.email ?? account.provider;
				const label = account.provider === 'github'
					? this.localizationService.translate('ash', 'workbench.signOutGitHub', 'Sign out of GitHub ({0})', { '0': name })
					: this.localizationService.translate('ash', 'workbench.signOutAccount', 'Sign out of {0}', { '0': name });
				return { id: `ash.activityBar.signOut.${account.provider}`, label, tooltip: label, enabled: true, run: () => this.accountService.logout(account.provider) };
			}),
			{ id: 'ash.activityBar.signIn', label: signInLabel, tooltip: signInLabel, enabled: true, run: () => this.accountService.startLogin({ type: 'openAiChatGptBrowser' }) },
			...(!githubConnected ? [{ id: 'ash.activityBar.connectGitHub', label: githubLabel, tooltip: githubLabel, enabled: true, run: () => this.githubConnection.isConnecting ? this.githubConnection.cancel() : this.githubConnection.connect() }] : []),
		];
	}

	private label(key: string, fallback: string): string {
		return this.localizationService.translate('ash', key, fallback);
	}
}
