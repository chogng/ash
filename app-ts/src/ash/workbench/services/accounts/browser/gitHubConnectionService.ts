import { Disposable } from '../../../../base/common/lifecycle.js';
import { IAccountService, type AccountLoginCompletion } from '../../../../platform/accounts/common/accountService.js';
import { AppServerRemoteError } from '../../../../platform/app-server/common/appServerError.js';
import { IAccessibilityService } from '../../../../platform/accessibility/common/accessibility.js';
import { DialogSeverity, IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ILocalizationService } from '../../localization/common/localizationService.js';
import type { IGitHubConnectionService } from '../common/gitHubConnectionService.js';

/** Coordinates one GitHub login across the Welcome editor and account menu. */
export class GitHubConnectionService extends Disposable implements IGitHubConnectionService {
	private isStarting = false;
	private cancelRequested = false;
	private loginId: string | undefined;

	constructor(
		@IAccountService private readonly accounts: IAccountService,
		@IDialogService private readonly dialogs: IDialogService,
		@IAccessibilityService private readonly accessibility: IAccessibilityService,
		@ILocalizationService private readonly localization: ILocalizationService,
		@ILogService private readonly log: ILogService,
	) {
		super();
		this._register(this.accounts.onDidCompleteLogin(completion => this.complete(completion)));
	}

	get isConnecting(): boolean {
		return this.isStarting || this.loginId !== undefined;
	}

	async connect(): Promise<void> {
		if (this.isConnecting) return;
		this.isStarting = true;
		this.cancelRequested = false;
		try {
			const challenge = await this.accounts.startLogin({ type: 'gitHubBrowser' });
			this.isStarting = false;
			if (this.cancelRequested) {
				this.cancelRequested = false;
				if (challenge.type !== 'connected') await this.accounts.cancelLogin(challenge.loginId);
				return;
			}
			if (challenge.type === 'connected') {
				this.showMessage(DialogSeverity.Info, this.label('account.githubAlreadyConnected', 'GitHub is already connected.'));
				return;
			}
			if (challenge.type !== 'browser') throw new Error('GitHub browser login returned a different challenge');
			this.loginId = challenge.loginId;
			this.accessibility.status(this.label('account.githubAuthorizeInBrowser', 'Authorize Ash in your browser to connect GitHub.'));
		} catch (error) {
			this.isStarting = false;
			if (this.cancelRequested) {
				this.cancelRequested = false;
				return;
			}
			this.showError(error);
		}
	}

	async cancel(): Promise<void> {
		if (this.isStarting) {
			this.cancelRequested = true;
			return;
		}
		const loginId = this.loginId;
		this.loginId = undefined;
		if (loginId) await this.accounts.cancelLogin(loginId);
	}

	private complete(completion: AccountLoginCompletion): void {
		if (completion.loginId !== this.loginId) return;
		this.loginId = undefined;
		if (completion.status.type === 'succeeded') {
			this.accessibility.status(this.label('account.githubConnected', 'GitHub account connected.'));
		} else {
			this.showMessage(DialogSeverity.Error, this.label('account.githubConnectionFailed', 'Could not connect GitHub. Try again.'));
		}
	}

	private showError(error: unknown): void {
		this.showMessage(DialogSeverity.Error, error instanceof AppServerRemoteError && error.errorName === 'AccountUnavailable'
			? this.label('account.githubUnavailable', 'GitHub connection is unavailable. Check this build’s GitHub configuration.')
			: this.label('account.githubConnectionFailed', 'Could not connect GitHub. Try again.'));
	}

	private showMessage(severity: DialogSeverity, message: string): void {
		void this.dialogs.showMessage({
			title: this.label('workbench.connectGitHub', 'Connect GitHub'),
			message,
			severity,
		}).catch(error => this.log.error('github', 'Could not show GitHub connection dialog', error));
	}

	private label(key: string, fallback: string): string {
		return this.localization.translate('ash', key, fallback);
	}

	protected override disposeCore(): void {
		const loginId = this.loginId;
		this.loginId = undefined;
		if (loginId) void this.accounts.cancelLogin(loginId).catch(error => this.log.error('github', 'Could not cancel GitHub login', error));
		super.disposeCore();
	}
}
