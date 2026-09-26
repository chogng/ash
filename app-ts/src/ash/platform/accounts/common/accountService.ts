import type { Event } from '../../../base/common/event.js';
import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';

export type AccountStatus = 'ready' | 'reauthenticationRequired' | 'unavailable';

export interface Account {
	readonly provider: string;
	readonly accountId: string;
	readonly email?: string;
	readonly displayName?: string;
	readonly organization?: string;
	readonly plan?: string;
	readonly status: AccountStatus;
	readonly credentialRevision: bigint;
}

export interface AccountState {
	readonly revision: bigint;
	readonly accounts: readonly Account[];
}

export type AccountLoginMethod =
	| { readonly type: 'openAiChatGptBrowser' }
	| { readonly type: 'openAiChatGptDeviceCode' }
	| { readonly type: 'kimiDeviceCode' }
	| { readonly type: 'xaiDeviceCode' }
	| { readonly type: 'gitHubBrowser' };

export type AccountLoginChallenge =
	| { readonly type: 'connected'; readonly loginId: string }
	| { readonly type: 'browser'; readonly loginId: string; readonly authorizationUrl: string }
	| { readonly type: 'deviceCode'; readonly loginId: string; readonly verificationUrl: string; readonly userCode: string };

export type AccountLoginCompletionStatus =
	| { readonly type: 'succeeded' }
	| { readonly type: 'failed'; readonly failure: { readonly code: string; readonly message: string } };

export interface AccountLoginCompletion {
	readonly loginId: string;
	readonly status: AccountLoginCompletionStatus;
	readonly account: AccountState;
}

/** Frontend account state and provider-scoped authentication commands. */
export interface IAccountService {
	readonly onDidChangeAccounts: Event<AccountState>;
	readonly onDidCompleteLogin: Event<AccountLoginCompletion>;
	read(): Promise<AccountState>;
	startLogin(method: AccountLoginMethod): Promise<AccountLoginChallenge>;
	cancelLogin(loginId: string): Promise<void>;
	logout(provider: string): Promise<void>;
}

export const IAccountService = createServiceIdentifier<IAccountService>('accountService');
