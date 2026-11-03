import type {
	AccountLoginCancelParams, AccountLoginCancelResult, AccountLoginStartParams, AccountLoginStartResult,
	AccountLogoutParams, AccountLogoutResult, AccountReadResult, AccountRateLimitsReadParams, AccountRateLimitsReadResult,
} from '../../../../../.build/protocol/typescript/index.js';

/** Transport-only account authentication and subscription usage operations. */
export interface IAccountApi {
	read(): Promise<AccountReadResult>;
	readRateLimits(params: AccountRateLimitsReadParams, signal?: AbortSignal): Promise<AccountRateLimitsReadResult>;
	startLogin(params: AccountLoginStartParams): Promise<AccountLoginStartResult>;
	cancelLogin(params: AccountLoginCancelParams): Promise<AccountLoginCancelResult>;
	logout(params: AccountLogoutParams): Promise<AccountLogoutResult>;
}
