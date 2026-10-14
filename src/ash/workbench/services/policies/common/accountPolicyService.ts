import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { getErrorMessage, isCancellationError } from '../../../../base/common/errors.js';
import type { JsonValue } from '../../../../base/common/jsonValue.js';
import type { IAccountService, AccountState } from '../../../../platform/accounts/common/accountService.js';
import type { IGitHubService, GitHubAccount } from '../../../../platform/github/common/githubService.js';
import type { ILogService } from '../../../../platform/log/common/log.js';
import { AbstractPolicyService, validatePolicyValues, type PolicyValue } from '../../../../platform/policy/common/policy.js';

/** Account identity and credentials belong to the provider; this service owns only UI policy resolution. */
export class AccountPolicyService extends AbstractPolicyService {
	private readonly retry: RunOnceScheduler;
	private cancellation: CancellationTokenSource | undefined;
	private generation = 0;
	private currentAccount: GitHubAccount | undefined;
	private pending: Promise<void> | undefined;
	constructor(private readonly accounts: IAccountService, private readonly github: IGitHubService, private readonly log: ILogService) {
		super();
		this.retry = this._register(new RunOnceScheduler(() => { void this.refresh(); }, 60000));
		this._register(accounts.onDidChangeAccounts(state => this.onAccountsChanged(state)));
	}
	private onAccountsChanged(state: AccountState): void {
		this.generation++;
		this.cancellation?.cancel();
		// Logout revokes policy immediately; no old-account values survive an identity change.
		if (this.currentAccount && !state.accounts.some(account => account.provider === 'github' && account.accountId === this.currentAccount!.id && account.status === 'ready')) {
			this.currentAccount = undefined;
			this.accept({});
		}
		this.retry.schedule(0);
	}
	protected refresh(): Promise<void> {
		if (this.pending) return this.pending;
		this.pending = (async () => {
			while (!this.stopped) {
				const definitions = this.policyDefinitions;
				await this.load();
				if (definitions === this.policyDefinitions) return;
			}
		})().finally(() => { this.pending = undefined; });
		return this.pending;
	}
	private async load(): Promise<void> {
		if (this.stopped) return;
		if (!Object.values(this.policyDefinitions).some(definition => definition.managedSettings)) { this.accept({}); return; }
		const generation = this.generation;
		const cancellation = new CancellationTokenSource();
		this.cancellation?.dispose(true);
		this.cancellation = cancellation;
		try {
			// The provider catalog defines primary-account order; windows never infer it from plan or email.
			const selected = (await this.github.listAccounts(cancellation.token))[0];
			if (this.stopped || generation !== this.generation) return;
			if (!selected || selected.status !== 'ready') { this.currentAccount = undefined; this.accept({}); return; }
			if (selected.id !== this.currentAccount?.id || selected.host !== this.currentAccount?.host) this.accept({});
			this.currentAccount = selected;
			const raw = await this.github.readManagedSettings(selected.id, cancellation.token);
			if (this.stopped || cancellation.token.isCancellationRequested || generation !== this.generation) return;
			if (raw === null) { this.accept({}); return; }
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
		} catch (error) {
			if (!this.stopped && !isCancellationError(error) && !cancellation.token.isCancellationRequested) this.log.error(getErrorMessage(error));
		} finally {
			cancellation.dispose();
			if (this.cancellation === cancellation) this.cancellation = undefined;
			if (!this.stopped) this.retry.schedule(generation === this.generation ? 60000 : 0);
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
