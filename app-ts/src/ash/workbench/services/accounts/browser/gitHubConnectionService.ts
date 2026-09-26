import { Disposable } from '../../../../base/common/lifecycle.js';
import { IAccountService, type AccountLoginCompletion } from '../../../../platform/accounts/common/accountService.js';
import { AppServerRemoteError } from '../../../../platform/app-server/common/appServerError.js';
import { IAccessibilityService } from '../../../../platform/accessibility/common/accessibility.js';
import { DialogResult, DialogSeverity, IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IDialogsModel, type IDialogHandle } from '../../../common/dialogs.js';
import { ILocalizationService } from '../../localization/common/localizationService.js';
import type { IGitHubConnectionService } from '../common/gitHubConnectionService.js';

/** Coordinates one GitHub login across the Welcome editor and account menu. */
export class GitHubConnectionService extends Disposable implements IGitHubConnectionService {
	private isStarting = false;
	private loginId: string | undefined;
	private authorizationDialog: IDialogHandle | undefined;

	constructor(
		@IAccountService private readonly accounts: IAccountService,
		@IDialogsModel private readonly dialogsModel: IDialogsModel,
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
		try {
			const challenge = await this.accounts.startLogin({ type: 'gitHubDeviceCode' });
			this.isStarting = false;
			if (challenge.type === 'connected') {
				this.showMessage(DialogSeverity.Info, this.label('account.githubAlreadyConnected', 'GitHub is already connected.'));
				return;
			}
			this.loginId = challenge.loginId;
			if (challenge.type === 'deviceCode') this.showAuthorizationDialog(challenge.userCode);
		} catch (error) {
			this.isStarting = false;
			this.showError(error);
		}
	}

	private showAuthorizationDialog(userCode: string): void {
		const dialog = this.dialogsModel.show({
			kind: 'confirmation',
			title: this.label('workbench.connectGitHub', 'Connect GitHub'),
			message: this.localization.translate('ash', 'account.githubEnterCode', 'Enter code {0} on GitHub', { '0': userCode }),
			detail: this.label('account.githubAuthorizationDetail', 'The code was copied to your clipboard. Finish authorization in your browser; Ash will connect automatically.'),
			primaryButton: this.label('account.githubContinueInBrowser', 'Continue in browser'),
			cancelButton: this.label('dialog.cancel', 'Cancel'),
		});
		this.authorizationDialog = dialog;
		void dialog.result.then(result => {
			if (this.authorizationDialog !== dialog) return;
			this.authorizationDialog = undefined;
			if (result.button !== DialogResult.Cancel) return;
			const loginId = this.loginId;
			this.loginId = undefined;
			if (loginId) void this.accounts.cancelLogin(loginId).catch(error => this.log.error('github', 'Could not cancel GitHub login', error));
		}, error => this.log.error('github', 'Could not show GitHub authorization dialog', error));
	}

	private complete(completion: AccountLoginCompletion): void {
		if (completion.loginId !== this.loginId) return;
		this.loginId = undefined;
		const dialog = this.authorizationDialog;
		this.authorizationDialog = undefined;
		dialog?.item.close({ button: DialogResult.Primary });
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
		const dialog = this.authorizationDialog;
		this.authorizationDialog = undefined;
		dialog?.item.cancel();
		const loginId = this.loginId;
		this.loginId = undefined;
		if (loginId) void this.accounts.cancelLogin(loginId).catch(error => this.log.error('github', 'Could not cancel GitHub login', error));
		super.disposeCore();
	}
}
