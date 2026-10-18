import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { getErrorMessage, isCancellationError } from '../../../../base/common/errors.js';
import { Emitter, type Event } from '../../../../base/common/event.js';
import type { JsonValue } from '../../../../base/common/jsonValue.js';
import { IAccountService, type AccountState } from '../../../../platform/accounts/common/accountService.js';
import { IGitHubService, GitHubError, GitHubErrorCode, type GitHubAccount } from '../../../../platform/github/common/githubService.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { AbstractPolicyService, validatePolicyValues, type PolicyValue } from '../../../../platform/policy/common/policy.js';

export type AccountPolicyRefreshState = {
	readonly scope?: { readonly accountId: string; readonly host: string; readonly credentialRevision: bigint; };
	/** Local start time of the current or most recent attempt. */
	readonly lastAttemptAt?: number;
	/** Last accepted response for this exact scope, including authoritative absence. */
	readonly lastSuccessAt?: number;
} & (
		| { readonly phase: 'idle' | 'refreshing' | 'ready'; }
		| { readonly phase: 'failed'; readonly failure: GitHubErrorCode | 'invalidResponse'; readonly retainsPolicy: boolean; }
	);

/** Window-owned policy refresh; observations do not grant or withhold execution. */
export interface IAccountPolicyService {
	readonly state: AccountPolicyRefreshState;
	readonly onDidChangeState: Event<AccountPolicyRefreshState>;
	/** Fetch the current primary account's policy, joining an existing refresh. */
	refresh(): Promise<void>;
}

export const IAccountPolicyService = createServiceIdentifier<IAccountPolicyService>('accountPolicyService');

/** Account identity and credentials belong to the provider; this service owns only UI policy resolution. */
export class AccountPolicyService extends AbstractPolicyService implements IAccountPolicyService {
	private readonly stateChanges = this._register(new Emitter<AccountPolicyRefreshState>());
	readonly onDidChangeState = this.stateChanges.event;
	private refreshState: AccountPolicyRefreshState = Object.freeze({ phase: 'idle' });
	private readonly retry: RunOnceScheduler;
	private cancellation: CancellationTokenSource | undefined;
	private generation = 0;
	private currentAccount: GitHubAccount | undefined;
	private pending: Promise<void> | undefined;
	constructor(
		@IAccountService private readonly accounts: IAccountService,
		@IGitHubService private readonly github: IGitHubService,
		@ILogService private readonly log: ILogService,
	) {
		super();
		this.retry = this._register(new RunOnceScheduler(() => { void this.refresh(); }, 60000));
		this._register(accounts.onDidChangeAccounts(state => this.onAccountsChanged(state)));
	}

	get state(): AccountPolicyRefreshState { return this.refreshState; }

	private setState(state: AccountPolicyRefreshState): void {
		if (this.stopped) return;
		this.refreshState = Object.freeze(state);
		this.stateChanges.fire(this.refreshState);
	}

	private onAccountsChanged(state: AccountState): void {
		this.generation++;
		this.cancellation?.cancel();
		// Logout revokes policy immediately; no old-account values survive an identity change.
		if (this.currentAccount) {
			const current = state.accounts.find(account => account.provider === 'github' && account.accountId === this.currentAccount!.id && account.status === 'ready');
			if (!current) {
				this.currentAccount = undefined;
				this.accept({});
				this.setState({ phase: 'idle' });
			} else if (current.credentialRevision !== this.currentAccount.credentialRevision) {
				// Keep accepted restrictions for this identity, but never credit a new
				// credential generation with the previous generation's successful read.
				this.currentAccount = { ...this.currentAccount, credentialRevision: current.credentialRevision };
				this.setState({ phase: 'idle', scope: this.scope(this.currentAccount) });
			}
		}
		this.retry.schedule(0);
	}

	public override refresh(): Promise<void> {
		if (this.stopped) return Promise.resolve();
		if (this.pending) return this.pending;
		this.retry.cancel();
		// Publish after installing the shared promise: state listeners may themselves
		// request a refresh, and must join this operation rather than start another.
		this.pending = Promise.resolve().then(async () => {
			while (!this.stopped) {
				const definitions = this.policyDefinitions;
				const generation = this.generation;
				await this.load();
				if (definitions === this.policyDefinitions && generation === this.generation) return;
			}
		}).finally(() => {
			this.pending = undefined;
			if (!this.stopped && !this.retry.isScheduled()) this.retry.schedule(60000);
		});
		return this.pending;
	}

	private scope(account: GitHubAccount): NonNullable<AccountPolicyRefreshState['scope']> {
		return Object.freeze({ accountId: account.id, host: account.host, credentialRevision: account.credentialRevision });
	}

	private async load(): Promise<void> {
		if (this.stopped) return;
		if (!Object.values(this.policyDefinitions).some(definition => definition.managedSettings)) {
			this.accept({});
			this.setState({ phase: 'idle' });
			return;
		}
		const generation = this.generation;
		const lastAttemptAt = Date.now();
		const cancellation = new CancellationTokenSource();
		this.cancellation?.dispose(true);
		this.cancellation = cancellation;
		try {
			this.setState({ phase: 'refreshing', scope: this.state.scope, lastAttemptAt, lastSuccessAt: this.state.lastSuccessAt });
			if (this.stopped || generation !== this.generation || cancellation.token.isCancellationRequested) return;
			// The provider catalog defines primary-account order; windows never infer it from plan or email.
			const selected = (await this.github.listAccounts(cancellation.token))[0];
			if (this.stopped || generation !== this.generation) return;
			if (!selected || selected.status !== 'ready') {
				this.currentAccount = undefined;
				this.accept({});
				this.setState({ phase: 'idle' });
				return;
			}
			if (selected.id !== this.currentAccount?.id || selected.host !== this.currentAccount?.host) this.accept({});
			const sameScope = selected.id === this.state.scope?.accountId
				&& selected.host === this.state.scope.host
				&& selected.credentialRevision === this.state.scope.credentialRevision;
			this.currentAccount = selected;
			this.setState({ phase: 'refreshing', scope: this.scope(selected), lastAttemptAt, lastSuccessAt: sameScope ? this.state.lastSuccessAt : undefined });
			if (this.stopped || generation !== this.generation || cancellation.token.isCancellationRequested) return;
			const raw = await this.github.readManagedSettings(selected.id, cancellation.token);
			if (this.stopped || cancellation.token.isCancellationRequested || generation !== this.generation) return;
			const managedSettings: Record<string, PolicyValue> = {};
			for (const definition of Object.values(this.policyDefinitions)) {
				for (const [path, schema] of Object.entries(definition.managedSettings ?? {})) {
					const value = raw ? settingAtPath(raw, path) : undefined;
					if (value === undefined) continue;
					if (typeof value !== schema.type || typeof value === 'number' && !Number.isFinite(value)) throw new TypeError(`Invalid managed setting: ${path}`);
					Object.defineProperty(managedSettings, path, { value, enumerable: true, configurable: true });
				}
			}
			const values: Record<string, PolicyValue> = {};
			for (const [name, definition] of Object.entries(this.policyDefinitions)) {
				const paths = Object.keys(definition.managedSettings ?? {});
				if (!paths.some(path => Object.hasOwn(managedSettings, path))) continue;
				const value = definition.value ? definition.value({ managedSettings }) : paths.length === 1 ? managedSettings[paths[0]!] : undefined;
				if (value !== undefined) Object.defineProperty(values, name, { value, enumerable: true });
			}
			this.accept(validatePolicyValues(values, this.policyDefinitions));
			// Value listeners can revoke the account or dispose the window synchronously.
			if (this.stopped || generation !== this.generation || cancellation.token.isCancellationRequested) return;
			this.setState({ phase: 'ready', scope: this.scope(selected), lastAttemptAt, lastSuccessAt: Date.now() });
		} catch (error) {
			if (this.stopped || generation !== this.generation || cancellation.token.isCancellationRequested) return;
			const failure = error instanceof GitHubError ? error.code : error instanceof TypeError ? 'invalidResponse' : GitHubErrorCode.Unavailable;
			this.setState({
				phase: 'failed', scope: this.state.scope, lastAttemptAt, lastSuccessAt: this.state.lastSuccessAt,
				failure, retainsPolicy: Object.keys(this.policyValues).length > 0,
			});
			if (!isCancellationError(error)) this.log.error(getErrorMessage(error));
		} finally {
			cancellation.dispose();
			if (this.cancellation === cancellation) this.cancellation = undefined;
		}
	}
	override dispose(): void { this.cancellation?.dispose(true); super.dispose(); }
}

function settingAtPath(raw: Readonly<Record<string, JsonValue>>, path: string): JsonValue | undefined {
	if (Object.hasOwn(raw, path)) return raw[path];
	let current: JsonValue | undefined = raw as Record<string, JsonValue>;
	for (const key of path.split('.')) {
		if (!current || typeof current !== 'object' || Array.isArray(current) || !Object.hasOwn(current, key)) return undefined;
		current = (current as Readonly<Record<string, JsonValue>>)[key];
	}
	return current;
}
