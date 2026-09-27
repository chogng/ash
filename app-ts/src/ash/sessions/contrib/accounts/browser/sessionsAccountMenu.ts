import { Separator, type IAction } from '../../../../base/common/actions.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import type { Account, AccountState, IAccountService } from '../../../../platform/accounts/common/accountService.js';
import type { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import type { SessionsPreferences } from '../../preferences/browser/sessionsPreferences.js';

/** Sessions account actions shown beside the Activity Bar account button. */
export class SessionsAccountMenu extends Disposable {
	private accountsSnapshot: readonly Account[] = [];
	private revision = -1n;
	private loadFailed = false;

	constructor(
		private readonly accounts: IAccountService,
		private readonly contextMenus: IContextMenuService,
		private readonly preferences: SessionsPreferences,
	) {
		super();
		this._register(this.accounts.onDidChangeAccounts(state => this.updateAccounts(state)));
		void this.accounts.read().then(state => this.updateAccounts(state), () => { this.loadFailed = true; });
	}

	public show(anchor: HTMLElement): void {
		const accountActions: IAction[] = this.accountsSnapshot.map(account => {
			const name = account.displayName ?? account.email ?? account.provider;
			const label = account.plan
				? localize('sessions.account.nameAndPlan', '{0} · {1}', name, account.plan)
				: name;
			return { id: `ash.sessions.account.${account.provider}`, label, tooltip: label, enabled: false, run() {} };
		});
		const settingsLabel = localize('workbench.manageSettings', 'Settings');
		const signInLabel = localize('workbench.signInWithChatGPT', 'Sign in with ChatGPT');
		if (this.loadFailed) {
			const label = localize('sessions.account.unavailable', 'Accounts unavailable');
			accountActions.push({ id: 'ash.sessions.accountsUnavailable', label, tooltip: label, enabled: false, run() {} });
		}
		const actions = Separator.join(accountActions, [
			{ id: 'ash.sessions.settings', label: settingsLabel, tooltip: settingsLabel, enabled: true, run: () => this.preferences.open() },
			...(this.revision >= 0n && !this.accountsSnapshot.some(account => account.provider === 'openai') ? [{
				id: 'ash.sessions.signIn', label: signInLabel, tooltip: signInLabel, enabled: true,
				run: () => this.accounts.startLogin({ type: 'openAiChatGptBrowser' as const }),
			}] : []),
			...this.accountsSnapshot.map(account => {
				const name = account.displayName ?? account.email ?? account.provider;
				const label = account.provider === 'github'
					? localize('workbench.signOutGitHub', 'Sign out of GitHub ({0})', name)
					: localize('workbench.signOutAccount', 'Sign out of {0}', name);
				return {
					id: `ash.sessions.signOut.${account.provider}`,
					label,
					tooltip: label,
					enabled: true,
					run: () => this.accounts.logout(account.provider),
				};
			}),
		]);
		anchor.setAttribute('aria-expanded', 'true');
		this.contextMenus.showContextMenu({
			getAnchor: () => anchor,
			getActions: () => actions,
			onHide: () => anchor.setAttribute('aria-expanded', 'false'),
		});
	}

	private updateAccounts(state: AccountState): void {
		if (state.revision < this.revision) return;
		this.revision = state.revision;
		this.accountsSnapshot = state.accounts;
		this.loadFailed = false;
	}
}
