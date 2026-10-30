import assert from 'assert';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import type { AccountLoginChallenge, AccountLoginCompletion, IAccountService } from '../../../../../platform/accounts/common/accountService.js';
import type { INotificationService } from '../../../../../platform/notification/common/notification.js';
import type { IProgressService } from '../../../../../platform/progress/common/progress.js';
import { signInChatGPT } from '../../browser/chatGPTLogin.js';

function fixture() {
	const completions = new Emitter<AccountLoginCompletion>();
	const started = new DeferredPromise<AccountLoginChallenge>();
	const cancelled: string[] = [], errors: string[] = [];
	let cancel: (() => void) | undefined;
	const accounts: IAccountService = {
		onDidCompleteLogin: completions.event, onDidChangeAccounts: Event.None,
		read: async () => ({ revision: 0n, accounts: [] }), logout: async () => { },
		startLogin: async method => { assert.deepEqual(method, { type: 'chatGptWebDeviceCode' }); return started.p; },
		cancelLogin: async id => { cancelled.push(id); },
	};
	const progress: IProgressService = { withProgress: async (_options, task, onCancel) => { cancel = onCancel; return task({ report() { } }); } };
	const notifications = { error: (message: string) => errors.push(message) } as unknown as INotificationService;
	const challenge: AccountLoginChallenge = { type: 'deviceCode', loginId: 'login-1', userCode: 'TEST-CODE', verificationUrl: 'https://auth.openai.com/codex/device' };
	const complete = (status: AccountLoginCompletion['status'], loginId = challenge.loginId) => completions.fire({ loginId, status, account: { revision: 1n, accounts: [] } });
	const run = signInChatGPT(accounts, notifications, progress);
	return { completions, started, cancelled, errors, challenge, complete, cancel: () => cancel!(), run };
}

suite('ChatGPT login presentation', () => {
	test('failed login start closes progress and displays localized guidance', async () => {
		const f = fixture();
		try {
			await f.started.error(new Error('private provider failure'));
			await f.run;
			assert.equal(f.errors.length, 1);
			assert.ok(!f.errors[0].includes('private provider failure'));
		} finally { f.completions.dispose(); }
	});

	test('observes completion that arrives before the browser handoff returns', async () => {
		const f = fixture();
		try {
			f.complete({ type: 'succeeded' });
			await f.started.complete(f.challenge);
			await f.run;
			assert.deepEqual(f.errors, []);
			assert.deepEqual(f.cancelled, []);
		} finally { f.completions.dispose(); }
	});

	test('cancellation during browser handoff cancels the exact owner login once', async () => {
		const f = fixture();
		try {
			f.cancel();
			await f.started.complete(f.challenge);
			await f.run;
			assert.deepEqual(f.cancelled, ['login-1']);
		} finally { f.completions.dispose(); }
	});

	test('active cancellation settles progress and retires the completion listener', async () => {
		const f = fixture();
		try {
			await f.started.complete(f.challenge);
			await Promise.resolve();
			f.cancel();
			await f.run;
			f.complete({ type: 'failed', failure: { code: 'late', message: 'late' } });
			assert.deepEqual(f.cancelled, ['login-1']);
			assert.deepEqual(f.errors, []);
		} finally { f.completions.dispose(); }
	});

	test('ignores other login completions and sanitizes an owner failure', async () => {
		const f = fixture();
		try {
			f.complete({ type: 'succeeded' }, 'other-login');
			await f.started.complete(f.challenge);
			await Promise.resolve();
			f.complete({ type: 'failed', failure: { code: 'oauth', message: 'provider-detail' } });
			await f.run;
			assert.equal(f.errors.length, 1);
			assert.ok(!f.errors[0].includes('provider-detail'));
		} finally { f.completions.dispose(); }
	});

	test('source changes end progress without reporting cancelled login as a failure', async () => {
		const f = fixture();
		try {
			f.complete({ type: 'failed', failure: { code: 'cancelled', message: 'source changed' } });
			await f.started.complete(f.challenge);
			await f.run;
			assert.deepEqual(f.errors, []);
		} finally { f.completions.dispose(); }
	});
});
