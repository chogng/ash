import { DeferredPromise } from '../../../../base/common/async.js';
import { localize } from '../../../../nls.js';
import type { AccountLoginCompletion, IAccountService } from '../../../../platform/accounts/common/accountService.js';
import type { INotificationService } from '../../../../platform/notification/common/notification.js';
import { type IProgressService, ProgressLocation } from '../../../../platform/progress/common/progress.js';

/** Presents the account owner's device flow, including completion and cancellation. */
export async function signInChatGPT(accounts: IAccountService, notifications: INotificationService, progress: IProgressService): Promise<void> {
	let loginId: string | undefined;
	let cancelled = false;
	const done = new DeferredPromise<AccountLoginCompletion | undefined>();
	// The browser handoff can delay the start response past its completion event.
	const early = new Map<string, AccountLoginCompletion>();
	await progress.withProgress({ location: ProgressLocation.Notification, title: localize('sessions.chatgpt.signIn', 'ChatGPT: Sign In to Ash'), cancellable: true }, async reporter => {
		const listener = accounts.onDidCompleteLogin(completion => {
			if (completion.loginId === loginId) void done.complete(completion);
			else if (loginId === undefined) early.set(completion.loginId, completion);
		});
		try {
			const challenge = await accounts.startLogin({ type: 'chatGptWebDeviceCode' });
			loginId = challenge.loginId;
			if (challenge.type === 'connected') return;
			if (cancelled) {
				await accounts.cancelLogin(loginId);
				return;
			}
			reporter.report({ message: localize('sessions.chatgpt.deviceLogin', 'Complete ChatGPT sign-in in your browser. The verification code has been copied to the clipboard.') });
			const completed = early.get(loginId);
			early.clear();
			if (completed) void done.complete(completed);
			const completion = await done.p;
			if (completion?.status.type === 'failed' && completion.status.failure.code !== 'cancelled') {
				notifications.error(localize('sessions.chatgpt.loginFailed', 'ChatGPT sign-in failed. Try signing in again.'));
			}
		} catch {
			notifications.error(localize('sessions.chatgpt.loginFailed', 'ChatGPT sign-in failed. Try signing in again.'));
		} finally {
			listener.dispose();
			early.clear();
		}
	}, () => {
		cancelled = true;
		if (loginId) void accounts.cancelLogin(loginId).then(() => done.complete(undefined), error => done.error(error));
	});
}
