import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { IAccessibilityService } from '../../../../../platform/accessibility/common/accessibility.js';
import { IAccountService, type AccountLoginMethod, type AccountLoginChallenge, type AccountLoginCompletion, type AccountState } from '../../../../../platform/accounts/common/accountService.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { ILocalizationService } from '../../../localization/common/localizationService.js';
import { GitHubConnectionService } from '../../browser/gitHubConnectionService.js';

for (const host of ['github.com', 'ghe.example']) {
	test(`GitHub connection handles completion received before login start returns for ${host}`, async () => {
		using disposables = new DisposableStore();
		const services = disposables.add(new InstantiationService());
		const completed = disposables.add(new Emitter<AccountLoginCompletion>());
		const accountState: AccountState = {
			revision: 2n,
			accounts: [{ provider: 'github', accountId: 'octocat', status: 'ready', credentialRevision: 1n }],
		};
		let finishStart: (challenge: AccountLoginChallenge) => void = () => { };
		const startResult = new Promise<AccountLoginChallenge>(resolve => { finishStart = resolve; });
		const methods: AccountLoginMethod[] = [];
		const accounts: IAccountService = {
			onDidChangeAccounts: Event.None,
			onDidCompleteLogin: completed.event,
			read: async () => accountState,
			startLogin: async method => { methods.push(method); return startResult; },
			cancelLogin: async () => { },
			logout: async () => { },
		};
		services.registerInstance(IAccountService, accounts);
		const announcements: string[] = [];
		services.registerInstance(IAccessibilityService, {
			status: (message: string) => { announcements.push(message); },
		} as IAccessibilityService);
		services.registerInstance(IDialogService, {
			showMessage: async () => { throw new Error('Unexpected dialog'); },
		} as unknown as IDialogService);
		services.registerInstance(ILocalizationService, {
			whenReady: Promise.resolve(),
			translate: (_bundle: string, _key: string, fallback: string) => fallback,
		});
		services.registerInstance(ILogService, {
			trace() { }, debug() { }, info() { }, warn() { }, error() { },
		});
		const connection = disposables.add(services.createInstance(GitHubConnectionService));

		const connecting = connection.connect(host);
		completed.fire({ loginId: 'other-login', status: { type: 'succeeded' }, account: accountState });
		completed.fire({ loginId: 'github-login', status: { type: 'succeeded' }, account: accountState });
		finishStart({ type: 'browser', loginId: 'github-login', authorizationUrl: 'https://github.example/authorize' });
		await connecting;

		assert.deepEqual(methods, [host === 'github.com' ? { type: 'gitHubBrowser' } : { type: 'gitHubEnterpriseBrowser', host }]);
		assert.deepEqual({ isConnecting: connection.isConnecting, announcements }, {
			isConnecting: false,
			announcements: ['GitHub account connected.'],
		});
	});

}
