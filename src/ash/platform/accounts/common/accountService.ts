import type { Event } from '../../../base/common/event.js';
import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';

const accountProviderLabels = new Map<string, () => string>();

export function registerAccountProviderLabel(provider: string, label: () => string): void {
	if (accountProviderLabels.has(provider)) throw new Error(`Account provider label already registered: ${provider}`);
	accountProviderLabels.set(provider, label);
}

export function getAccountProviderLabel(provider: string): string | undefined {
	return accountProviderLabels.get(provider)?.();
}

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

/** A provider-reported quota window. Reset timestamps are Unix seconds. */
interface AccountRateLimitWindow {
	readonly usedPercent: number;
	readonly windowSeconds: number;
	readonly resetsAt: number | null;
}

/** Subscription limits are independent of conversation token accounting. Null means not reported. */
export interface AccountRateLimits {
	readonly provider: string;
	readonly accountId: string;
	readonly plan: string | null;
	readonly limits: readonly {
		readonly id: string;
		readonly name: string | null;
		readonly model: string | null;
		readonly allowed: boolean | null;
		readonly limitReached: boolean | null;
		readonly primary: AccountRateLimitWindow | null;
		readonly secondary: AccountRateLimitWindow | null;
	}[];
	readonly credits: {
		readonly hasCredits: boolean;
		readonly unlimited: boolean;
		readonly balance: string | null;
	} | null;
	readonly xai: {
		readonly allowed: boolean | null;
		readonly message: string | null;
		readonly usedPercent: number | null;
		readonly periodType: string | null;
		readonly periodStart: string | null;
		readonly periodEnd: string | null;
		readonly prepaidCents: string | null;
		readonly onDemandEnabled: boolean | null;
		readonly onDemandUsedCents: string | null;
		readonly onDemandCapCents: string | null;
		readonly unifiedBilling: boolean | null;
	} | null;
}

export type AccountLoginMethod =
	| { readonly type: 'openAiChatGptBrowser'; }
	| { readonly type: 'openAiChatGptDeviceCode'; }
	| { readonly type: 'chatGptWebDeviceCode'; }
	| { readonly type: 'chatGptWebCodex'; }
	| { readonly type: 'kimiDeviceCode'; }
	| { readonly type: 'xaiDeviceCode'; }
	| { readonly type: 'bigModelBrowser'; }
	| { readonly type: 'zaiBrowser'; }
	| { readonly type: 'bigModelStartPlanBrowser'; }
	| { readonly type: 'zaiStartPlanBrowser'; }
	| { readonly type: 'gitHubBrowser'; }
	| { readonly type: 'gitHubEnterpriseBrowser'; readonly host: string; };

export type AccountLoginChallenge =
	| { readonly type: 'connected'; readonly loginId: string; }
	| { readonly type: 'browser'; readonly loginId: string; readonly authorizationUrl: string; }
	| { readonly type: 'deviceCode'; readonly loginId: string; readonly verificationUrl: string; readonly userCode: string; };

export type AccountLoginCompletionStatus =
	| { readonly type: 'succeeded'; }
	| { readonly type: 'failed'; readonly failure: { readonly code: string; readonly message: string; }; };

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
	readRateLimits(provider: string, accountId: string, signal?: AbortSignal): Promise<AccountRateLimits>;
	startLogin(method: AccountLoginMethod): Promise<AccountLoginChallenge>;
	cancelLogin(loginId: string): Promise<void>;
	logout(provider: string, accountId?: string): Promise<void>;
}

export const IAccountService = createServiceIdentifier<IAccountService>('accountService');
