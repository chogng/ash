import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { localizedString } from '../../../../../platform/action/common/action.js';
import { Action2 } from '../../../../../platform/actions/common/actions.js';
import { IAccountService, type Account, type AccountState } from '../../../../../platform/accounts/common/accountService.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IQuickInputService, type IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { IGitHubConnectionService } from '../../../../services/accounts/common/gitHubConnectionService.js';

type AccountPickItem =
	| (IQuickPickItem & { readonly kind: 'account'; readonly account: Account })
	| (IQuickPickItem & { readonly kind: 'add' });

type LoginPickItem = IQuickPickItem & { readonly kind: 'chatgpt' | 'github' };

export class ManageAccountsAction extends Action2 {
	public static readonly ID = 'workbench.action.manageAccounts';

	constructor() {
		super({
			id: ManageAccountsAction.ID,
			title: localizedString('ash', 'workbench.manageAccounts', 'Manage Accounts'),
			f1: true,
		});
	}

	public override async run(accessor: ServicesAccessor): Promise<void> {
		const accounts = accessor.get(IAccountService);
		const notifications = accessor.get(INotificationService);
		let state: AccountState;
		try {
			state = await accounts.read();
		} catch {
			notifications.error(localize({ bundle: 'ash', key: 'workbench.loadAccountsFailed' }, 'Could not load accounts.'));
			return;
		}

		const quickInput = accessor.get(IQuickInputService);
		const github = accessor.get(IGitHubConnectionService);
		const picker = quickInput.createQuickPick<AccountPickItem>();
		const resources = new DisposableStore();
		resources.add(picker);
		picker.placeholder = localize({ bundle: 'ash', key: 'workbench.selectAccount' }, 'Select an account to manage');
		picker.ariaLabel = picker.placeholder;
		const loginItems: LoginPickItem[] = [
			...(!state.accounts.some(account => account.provider === 'chatgpt-subscription' && account.status === 'ready') ? [{
				kind: 'chatgpt' as const,
				label: localize({ bundle: 'ash', key: 'workbench.signInWithChatGPT' }, 'Sign in with ChatGPT'),
			}] : []),
			...(!state.accounts.some(account => account.provider === 'github' && account.status === 'ready') ? [{
				kind: 'github' as const,
				label: github.isConnecting
					? localize({ bundle: 'ash', key: 'workbench.cancelGitHubConnection' }, 'Cancel GitHub connection')
					: localize({ bundle: 'ash', key: 'workbench.connectGitHub' }, 'Connect GitHub'),
			}] : []),
		];
		picker.items = [
			...state.accounts.map(account => ({
				kind: 'account' as const,
				account,
				label: account.displayName ?? account.email ?? account.provider,
				description: account.provider,
			})),
			...(loginItems.length > 0 ? [{ kind: 'add' as const, label: localize({ bundle: 'ash', key: 'workbench.addAccount' }, 'Add account') }] : []),
		];
		resources.add(picker.onDidAccept(item => {
			picker.hide();
			if (item.kind === 'account') {
				showAccountActions(quickInput, accounts, notifications, item.account);
				return;
			}
			showAddAccountActions(quickInput, accounts, github, notifications, loginItems);
		}));
		resources.add(picker.onDidHide(() => resources.dispose()));
		picker.show();
	}
}

function showAddAccountActions(quickInput: IQuickInputService, accounts: IAccountService, github: IGitHubConnectionService, notifications: INotificationService, items: readonly LoginPickItem[]): void {
	const picker = quickInput.createQuickPick<LoginPickItem>();
	const resources = new DisposableStore();
	resources.add(picker);
	picker.placeholder = localize({ bundle: 'ash', key: 'workbench.addAccount' }, 'Add account');
	picker.ariaLabel = picker.placeholder;
	picker.items = items;
	resources.add(picker.onDidAccept(item => {
		picker.hide();
		if (item.kind === 'github') {
			void (github.isConnecting ? github.cancel() : github.connect());
			return;
		}
		void accounts.startLogin({ type: 'openAiChatGptBrowser' }).catch(() => {
			notifications.error(localize({ bundle: 'ash', key: 'workbench.signInFailed' }, 'Could not start ChatGPT sign in.'));
		});
	}));
	resources.add(picker.onDidHide(() => resources.dispose()));
	picker.show();
}

function showAccountActions(quickInput: IQuickInputService, accounts: IAccountService, notifications: INotificationService, account: Account): void {
	const picker = quickInput.createQuickPick<IQuickPickItem>();
	const resources = new DisposableStore();
	resources.add(picker);
	const name = account.displayName ?? account.email ?? account.provider;
	picker.placeholder = localize({ bundle: 'ash', key: 'workbench.manageSelectedAccount' }, 'Manage {0}', name);
	picker.ariaLabel = picker.placeholder;
	picker.items = [{ label: localize({ bundle: 'ash', key: 'workbench.signOutAccount' }, 'Sign out of {0}', name) }];
	resources.add(picker.onDidAccept(() => {
		picker.hide();
		void accounts.logout(account.provider).catch(() => {
			notifications.error(localize({ bundle: 'ash', key: 'workbench.signOutFailed' }, 'Could not sign out of {0}.', name));
		});
	}));
	resources.add(picker.onDidHide(() => resources.dispose()));
	picker.show();
}
