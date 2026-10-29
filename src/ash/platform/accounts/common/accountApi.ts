import type { AccountLoginCancelParams, AccountLoginCancelResult, AccountLoginStartParams, AccountLoginStartResult, AccountLogoutParams, AccountLogoutResult, AccountReadResult } from '../../../../../.build/protocol/typescript/index.js';

/** Transport-only account authentication operations. */
export interface IAccountApi {
	read(): Promise<AccountReadResult>;
	startLogin(params: AccountLoginStartParams): Promise<AccountLoginStartResult>;
	cancelLogin(params: AccountLoginCancelParams): Promise<AccountLoginCancelResult>;
	logout(params: AccountLogoutParams): Promise<AccountLogoutResult>;
}
