import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IAccountService, type AccountState } from '../../../../platform/accounts/common/accountService.js';
import { IGitHubService } from '../../../../platform/github/common/githubService.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IGitHubConnectionService } from '../../../services/accounts/common/gitHubConnectionService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IRemoteAgentService } from '../../../services/remote/common/remoteAgentService.js';
import type { SettingsSectionField, SettingsSectionModel } from '../../preferences/browser/settingsTreeModels.js';
import { IGitHubReviewModel } from './githubReviewModel.js';

/** Read-only account snapshots and transient repository checks; no credentials or cloud settings are copied. */
export class GitHubSettingsModel extends Disposable implements SettingsSectionModel {
	public readonly categoryId = 'github';
	public get title(): string { return localize('github.settings.title', 'Codex review'); }
	public get description(): string { return localize('github.settings.description', 'Use your existing accounts to request and read PR reviews. Confirm official Connector authorization and automatic review settings in Codex.'); }
	public get help(): string { return localize('github.settings.help', 'GitHub and Codex review settings\nUse Tab to choose a GitHub account, enter owner/name, and check repository access. Browse pull requests opens the shared review editor. Ash reuses an existing Codex login for model access. GitHub repository access and official Connector authorization are separate. Manage official Connector opens GitHub; Manage automatic reviews opens Codex settings in your browser. Authorization and automatic review settings must be confirmed there. In the review editor, Request Codex review posts @codex review as your GitHub account. Refresh to read the resulting PR comments and review discussions. Escape closes accessibility help and returns focus.'); }
	private readonly changed = this._register(new Emitter<void>());
	public readonly onDidChange = this.changed.event;
	private readonly readOperation: MutableDisposable<CancellationTokenSource>;
	private accountState: AccountState | undefined;
	private identity: string | undefined;
	private verifiedRepository: string | undefined;
	private repository = '';
	private status = '';
	private isVisible = false;
	private isBusy = false;
	private version = 0;

	constructor(private readonly closeSettings: () => Promise<void>,
		@IAccountService private readonly accounts: IAccountService,
		@IGitHubService private readonly github: IGitHubService,
		@IGitHubReviewModel private readonly review: IGitHubReviewModel,
		@IGitHubConnectionService private readonly connection: IGitHubConnectionService,
		@IEditorService private readonly editors: IEditorService,
		@IOpenerService private readonly opener: IOpenerService,
		@IRemoteAgentService remote: IRemoteAgentService,
	) {
		super();
		this.readOperation = this._register(new MutableDisposable<CancellationTokenSource>());
		// The stack unwinds in reverse order; cancel before the holder disposes the token.
		this._register(toDisposable(() => { this.version++; this.readOperation.value?.cancel(); }));
		this._register(review.onDidChange(() => {
			const selected = review.selectedAccount;
			const identity = selected && `${selected.id}/${selected.credentialRevision}/${selected.status}`;
			if (identity !== this.identity) { this.identity = identity; if (this.readOperation.value || this.verifiedRepository) { this.invalidate(); } }
			if (this.isVisible) { this.changed.fire(); }
		}));
		this._register(accounts.onDidChangeAccounts(state => { this.invalidate(); this.accountState = state; if (this.isVisible) { this.changed.fire(); } }));
		this._register(remote.onDidChangeConnection(() => { this.accountState = undefined; this.invalidate(); if (this.isVisible) { void this.refresh(); } }));
		this._register(remote.onDidChangeConnectionState(state => { if (state !== 'connected') { this.accountState = undefined; this.invalidate(); this.changed.fire(); } else if (this.isVisible) { void this.refresh(); } }));
	}

	public get fields(): readonly SettingsSectionField[] {
		const codex = this.accountState?.accounts.find(account => account.provider === 'chatgpt-subscription');
		const codexStatus = !this.accountState ? localize('github.settings.codexUnknown', 'Codex login status is unavailable. Connect to App Server and refresh accounts.') : codex?.status === 'ready'
			? localize('github.settings.codexReady', 'Existing Codex login available for model access: {0}.', codex.displayName ?? codex.email ?? codex.accountId)
			: localize('github.settings.codexUnavailable', 'No valid reused Codex login detected. Sign in with Codex, then refresh. PR review requests use your GitHub account; the official Connector runs the review.');
		return [
			{ id: 'codex', kind: 'status', text: codexStatus },
			{ id: 'account', kind: 'select', label: localize('github.settings.account', 'GitHub account'), value: this.review.selectedAccount?.id, options: this.review.accounts.map(account => ({ value: account.id, label: `${account.login}@${account.host}` })), enabled: !this.isBusy, setValue: value => this.review.selectAccount(value) },
			{ id: 'repository', kind: 'text', label: localize('github.settings.repository', 'Repository (owner/name)'), value: this.repository, placeholder: 'owner/repo', enabled: !this.isBusy, setValue: value => { this.repository = value; this.invalidate(); this.changed.fire(); } },
			{ id: 'refresh', kind: 'action', label: localize('github.settings.refresh', 'Refresh accounts'), enabled: !this.isBusy, run: () => this.refresh() },
			{ id: 'connect', kind: 'action', label: localize('github.settings.connect', 'Connect GitHub'), enabled: !this.isBusy && !this.connection.isConnecting, run: () => this.perform(async () => { await this.connection.connect(); await this.refresh(); }) },
			{ id: 'check', kind: 'action', label: localize('github.settings.check', 'Check repository access'), enabled: !this.isBusy && this.review.selectedAccount?.status === 'ready' && !!this.accountState, run: () => this.checkRepository() },
			{
				id: 'browse', kind: 'action', label: localize('github.settings.browse', 'Browse pull requests'), enabled: !this.isBusy && !!this.verifiedRepository, run: () => this.perform(async () => {
					const account = this.review.selectedAccount; const repository = this.verifiedRepository;
					if (!account || !repository) { return; }
					const resource = URI.from({ scheme: 'ash-github', authority: account.host, path: `/${repository}`, query: new URLSearchParams({ account: account.id }).toString() });
					await this.closeSettings(); await this.editors.openEditor({ resource, label: repository, readOnly: true, showBreadcrumbs: false });
				})
			},
			{ id: 'connector', kind: 'action', label: localize('github.settings.connector', 'Manage official Connector'), enabled: true, run: () => this.perform(async () => { await this.opener.open(URI.parse('https://github.com/apps/chatgpt-codex-connector'), { openExternal: true }); }) },
			{ id: 'automatic', kind: 'action', label: localize('github.settings.automatic', 'Manage automatic reviews'), enabled: true, run: () => this.perform(async () => { await this.opener.open(URI.parse('https://app.chatgpt.com/settings/code-review'), { openExternal: true }); }) },
			{ id: 'status', kind: 'status', text: this.isBusy ? localize('github.settings.loading', 'Reading GitHub account and repository information…') : this.status },
		];
	}

	public setVisible(visible: boolean): void {
		if (this.isVisible === visible) { return; }
		this.isVisible = visible;
		if (visible) {
			const repository = this.review.repository;
			if (!this.repository && repository) { this.repository = `${repository.owner}/${repository.name}`; }
			void this.refresh();
		} else { this.invalidate(); }
	}

	private invalidate(): void { this.version++; this.readOperation.value?.cancel(); this.readOperation.clear(); this.isBusy = false; this.verifiedRepository = undefined; this.status = ''; }

	private async refresh(): Promise<void> {
		this.invalidate(); const version = this.version; this.isBusy = true; this.changed.fire();
		try {
			const [state] = await Promise.all([this.accounts.read(), this.review.initialize().then(() => this.review.refreshAccounts())]);
			if (this.isDisposed || !this.isVisible || version !== this.version) { return; }
			this.accountState = state;
		} catch {
			if (this.isDisposed || version !== this.version) { return; }
			this.accountState = undefined; this.status = localize('github.settings.readFailed', 'Could not read accounts. Connect to App Server and refresh.');
		} finally { if (!this.isDisposed && version === this.version) { this.isBusy = false; this.changed.fire(); } }
	}

	private async checkRepository(): Promise<void> {
		const account = this.review.selectedAccount; const parts = this.repository.trim().split('/');
		if (this.isBusy || !account || account.status !== 'ready' || parts.length !== 2 || parts.some(part => !/^[\w.-]+$/.test(part) || part === '.' || part === '..')) {
			this.status = localize('github.settings.invalidRepository', 'Choose a ready GitHub account and enter a repository as owner/name.'); this.changed.fire(); return;
		}
		this.invalidate(); const version = this.version;
		const operation = new CancellationTokenSource(); this.readOperation.value = operation; this.isBusy = true; this.changed.fire();
		try {
			const repository = await this.github.readRepository({ host: account.host, accountId: account.id, owner: parts[0]!, name: parts[1]! }, operation.token);
			if (this.isDisposed || operation.token.isCancellationRequested || version !== this.version) { return; }
			this.verifiedRepository = parts.join('/'); this.status = localize('github.settings.verified', 'Ash can access {0}. Official Connector authorization and automatic reviews are unconfirmed; check the official management pages.', repository.fullName);
		} catch {
			if (this.isDisposed || operation.token.isCancellationRequested || version !== this.version) { return; }
			this.status = localize('github.settings.checkFailed', 'Could not access this repository. Check its name and GitHub account permissions.');
		} finally { if (!this.isDisposed && version === this.version) { this.isBusy = false; this.readOperation.clear(); this.changed.fire(); } }
	}

	private async perform(work: () => Promise<void>): Promise<void> {
		try { await work(); } catch { if (!this.isDisposed) { this.status = localize('github.settings.actionFailed', 'Could not complete this action. Refresh accounts or try opening the management page again.'); this.changed.fire(); } }
	}
}
