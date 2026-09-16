import type { AccountDto, AccountLoginCompleted, AccountReadResult, AccountUpdated } from '../../../../platform/app-server/common/generated/index.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import type { IAccountApi } from '../../../../platform/accounts/common/accountApi.js';
import type { Account, AccountLoginChallenge, AccountLoginCompletion, AccountLoginMethod, AccountState, IAccountService } from '../../../../platform/accounts/common/accountService.js';
import type { IServerEventApi } from '../../../../platform/app-server/common/appServerApi.js';

export class AppServerAccountService extends Disposable implements IAccountService {
	private readonly _onDidChangeAccounts = this._register(new Emitter<AccountState>());
	readonly onDidChangeAccounts = this._onDidChangeAccounts.event;
	private readonly _onDidCompleteLogin = this._register(new Emitter<AccountLoginCompletion>());
	readonly onDidCompleteLogin = this._onDidCompleteLogin.event;

	constructor(private readonly api: IAccountApi, events: IServerEventApi) {
		super();
		const subscription = events.subscribe(event => {
			if (event.method === 'account/updated') {
				this._onDidChangeAccounts.fire(accountState((event.params as AccountUpdated).account));
			} else if (event.method === 'account/login/completed') {
				const completion = accountLoginCompletion(event.params as AccountLoginCompleted);
				this._onDidCompleteLogin.fire(completion);
				this._onDidChangeAccounts.fire(completion.account);
			}
		});
		this._register(toDisposable(() => subscription.dispose()));
	}

	async read(): Promise<AccountState> {
		return accountState(await this.api.read());
	}

	async startLogin(method: AccountLoginMethod): Promise<AccountLoginChallenge> {
		const started = await this.api.startLogin({ method });
		if (started.type === 'connected') {
			return { type: 'connected', loginId: started.loginId };
		}
		return started.type === 'browser'
			? { type: 'browser', loginId: started.loginId, authorizationUrl: started.authorizationUrl }
			: { type: 'deviceCode', loginId: started.loginId, verificationUrl: started.verificationUrl, userCode: started.userCode };
	}

	async cancelLogin(loginId: string): Promise<void> {
		await this.api.cancelLogin({ loginId });
	}

	async logout(provider: string): Promise<void> {
		await this.api.logout({ provider });
	}
}

function accountState(value: AccountReadResult): AccountState {
	return { revision: BigInt(value.revision), accounts: value.accounts.map(account) };
}

function account(value: AccountDto): Account {
	return {
		provider: value.provider,
		accountId: value.accountId,
		...(value.email === null ? {} : { email: value.email }),
		...(value.displayName === null ? {} : { displayName: value.displayName }),
		...(value.organization === null ? {} : { organization: value.organization }),
		...(value.plan === null ? {} : { plan: value.plan }),
		status: value.status,
		credentialRevision: BigInt(value.credentialRevision),
	};
}

function accountLoginCompletion(value: AccountLoginCompleted): AccountLoginCompletion {
	return {
		loginId: value.loginId,
		status: value.status.type === 'succeeded'
			? { type: 'succeeded' }
			: { type: 'failed', failure: { ...value.status.failure } },
		account: accountState(value.account),
	};
}
