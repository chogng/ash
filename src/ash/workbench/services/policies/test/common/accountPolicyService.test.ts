import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { IAccountService, type AccountState } from '../../../../../platform/accounts/common/accountService.js';
import { createDisconnectedGitHubService } from '../../../../../platform/github/browser/appServerGitHubService.js';
import { GitHubError, GitHubErrorCode, GitHubManagedSettingsReadMode, IGitHubService, type GitHubAccount, type GitHubManagedSettingsSnapshot } from '../../../../../platform/github/common/githubService.js';
import type { CancellationToken } from '../../../../../base/common/cancellation.js';
import type { JsonValue } from '../../../../../base/common/jsonValue.js';
import { ILogService, NullLoggerService } from '../../../../../platform/log/common/log.js';
import type { LogEntry } from '../../../../../platform/log/common/log.js';
import { LogService } from '../../../../../platform/log/common/logServiceImpl.js';
import type { PolicyValue } from '../../../../../base/common/policy.js';
import { AbstractPolicyService, PolicyValueSource, type PolicyDefinition } from '../../../../../platform/policy/common/policy.js';
import { MultiplexPolicyService } from '../../../../../platform/policy/common/multiplexPolicyService.js';
import { ConfigurationRegistry } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { PolicyConfiguration } from '../../../../../platform/configuration/common/configurations.js';
import { AccountPolicyService, type AccountPolicyRefreshState } from '../../common/accountPolicyService.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';

const log = new NullLoggerService();
const account: GitHubAccount = { id: 'first', host: 'github.com', login: 'first', status: 'ready', credentialRevision: 1n };
const binding: Record<string, PolicyDefinition> = { ManagedFeature: { type: 'boolean', managedSettings: { strictPluginOnlyCustomization: { type: 'boolean' } } } };

function accountServices(events: Emitter<AccountState>): IAccountService {
	const unexpected = async (): Promise<never> => { throw new Error('Unexpected account mutation'); };
	return {
		onDidChangeAccounts: events.event, onDidCompleteLogin: Event.None,
		read: async () => ({ revision: 1n, accounts: [] }), startLogin: unexpected, cancelLogin: unexpected, logout: unexpected
	};
}

function githubServices(read: (id: string, token?: CancellationToken) => Promise<Readonly<Record<string, JsonValue>> | null>, list: () => Promise<readonly GitHubAccount[]> = async () => [account]): IGitHubService {
	return {
		...createDisconnectedGitHubService(), listAccounts: list,
		readManagedSettings: async (id, token) => ({ settings: await read(id, token), refresh: { state: 'ready', lastAttemptAt: Date.now(), lastSuccessAt: Date.now() } }),
	};
}

test('Registered account mappings resolve real provider fields and system policy has priority', async () => {
	using changes = new Emitter<AccountState>();
	const ids: string[] = [];
	using accounts = new AccountPolicyService(accountServices(changes), githubServices(async id => { ids.push(id); return { strictPluginOnlyCustomization: true }; }), log);
	class System extends AbstractPolicyService {
		candidate: Record<string, PolicyValue> = { ManagedFeature: false };
		protected async refresh(): Promise<void> { this.accept(this.candidate); }
	}
	using system = new System();
	using policies = new MultiplexPolicyService([system, accounts]);
	const registry = new ConfigurationRegistry();
	registry.registerConfiguration({
		key: 'ui.managedFeature', defaultValue: true, policy: { name: 'ManagedFeature', managedSettings: binding.ManagedFeature!.managedSettings }, parse: value => {
			if (typeof value !== 'boolean') throw new TypeError('Expected boolean');
			return value;
		}
	});
	using configuration = new PolicyConfiguration(registry, policies, log);
	await configuration.initialize();
	assert.deepEqual([configuration.configurationModel.getValue('ui.managedFeature'), accounts.getPolicyValue('ManagedFeature'), ids], [false, true, ['first']]);
	assert.deepEqual([policies.getPolicyValueSource('ManagedFeature'), accounts.getPolicyValueSource('ManagedFeature')], [PolicyValueSource.Device, PolicyValueSource.ServerManagedSettings]);
	system.candidate = {};
	await system.updatePolicyDefinitions(binding);
	assert.equal(configuration.configurationModel.getValue('ui.managedFeature'), true);
	assert.equal(policies.getPolicyValueSource('ManagedFeature'), PolicyValueSource.ServerManagedSettings);
});

test('Account read failures and malformed replacements retain policy, while authoritative absence removes it', async () => {
	using changes = new Emitter<AccountState>();
	let raw: Readonly<Record<string, JsonValue>> | null | Error = { strictPluginOnlyCustomization: true };
	using source = new AccountPolicyService(accountServices(changes), githubServices(async () => { if (raw instanceof Error) throw raw; return raw; }), log);
	await source.updatePolicyDefinitions(binding);
	raw = new Error('Network failed');
	await source.updatePolicyDefinitions(binding);
	assert.equal(source.getPolicyValue('ManagedFeature'), true);
	raw = { strictPluginOnlyCustomization: 'invalid' };
	await source.refresh({ retryManagedSettings: true });
	assert.equal(source.getPolicyValue('ManagedFeature'), true);
	raw = null;
	await source.refresh({ retryManagedSettings: true });
	assert.equal(source.getPolicyValue('ManagedFeature'), undefined);
});

test('Failed account discovery suppresses automatic requests until explicit retry or a GitHub account change', async () => {
	using changes = new Emitter<AccountState>();
	const entries: LogEntry[] = [];
	using logger = new LogService({ sinks: [{ log: entry => entries.push(entry) }] });
	const failure = new GitHubError(GitHubErrorCode.Unavailable);
	let unavailable = true;
	let attempts = 0;
	using source = new AccountPolicyService(accountServices(changes), githubServices(async () => ({}), async () => {
		attempts++;
		if (unavailable) throw failure;
		return [account];
	}), logger);
	await source.updatePolicyDefinitions(binding);
	const failed = source.state;
	await source.refresh();
	await source.updatePolicyDefinitions(binding);
	changes.fire({ revision: 2n, accounts: [{ provider: 'chatgpt-subscription', accountId: 'model', status: 'ready', credentialRevision: 1n }] });
	await source.refresh();
	assert.equal(attempts, 1);
	assert.equal(source.state, failed);
	assert.equal(entries.length, 1);
	assert.equal(entries[0]!.category, 'accountPolicy');
	assert.equal(entries[0]!.message, 'Could not refresh managed account settings unavailable');
	assert.equal(entries[0]!.error, failure);
	await source.refresh({ retryManagedSettings: true });
	assert.equal(attempts, 2);
	unavailable = false;
	changes.fire({ revision: 3n, accounts: [{ provider: 'github', accountId: 'first', status: 'ready', credentialRevision: 1n }] });
	await source.refresh();
	assert.equal(attempts, 3);
	assert.equal(source.state.phase, 'ready');
});

test('Windows project the same backend failure, retained settings and timestamps and forward explicit retry', async () => {
	using changes = new Emitter<AccountState>();
	let snapshot: GitHubManagedSettingsSnapshot = {
		settings: { strictPluginOnlyCustomization: true },
		refresh: { state: 'failed', lastAttemptAt: 200, lastSuccessAt: 100, failure: GitHubErrorCode.ManagedSettingsUpdateRequired },
	};
	const modes: (GitHubManagedSettingsReadMode | undefined)[] = [];
	const github: IGitHubService = {
		...githubServices(async () => ({})),
		readManagedSettings: async (_id, _token, mode) => { modes.push(mode); return snapshot; },
	};
	using first = new AccountPolicyService(accountServices(changes), github, log);
	using second = new AccountPolicyService(accountServices(changes), github, log);
	await first.updatePolicyDefinitions(binding);
	await second.updatePolicyDefinitions(binding);
	assert.deepEqual(first.state, second.state);
	assert.deepEqual(first.state, {
		phase: 'failed', scope: { accountId: 'first', host: 'github.com', credentialRevision: 1n },
		lastAttemptAt: 200, lastSuccessAt: 100, failure: GitHubErrorCode.ManagedSettingsUpdateRequired, retainsPolicy: true,
	});
	assert.deepEqual([first.getPolicyValue('ManagedFeature'), second.getPolicyValue('ManagedFeature')], [true, true]);
	snapshot = { settings: null, refresh: { state: 'ready', lastAttemptAt: 300, lastSuccessAt: 400 } };
	await first.refresh({ retryManagedSettings: true });
	await second.refresh();
	assert.deepEqual(modes, [GitHubManagedSettingsReadMode.Automatic, GitHubManagedSettingsReadMode.Automatic, GitHubManagedSettingsReadMode.Retry, GitHubManagedSettingsReadMode.Automatic]);
	assert.deepEqual(first.state, second.state);
	assert.equal(first.state.lastSuccessAt, 400);
	assert.deepEqual([first.getPolicyValue('ManagedFeature'), second.getPolicyValue('ManagedFeature')], [undefined, undefined]);
});

test('Logout cancels pending policy reads and prevents a late response from restoring restrictions', async () => {
	using changes = new Emitter<AccountState>();
	let release!: () => void;
	let entered!: () => void;
	const started = new Promise<void>(resolve => { entered = resolve; });
	const gate = new Promise<void>(resolve => { release = resolve; });
	let selected: readonly GitHubAccount[] = [account];
	using source = new AccountPolicyService(accountServices(changes), githubServices(async () => { entered(); await gate; return { strictPluginOnlyCustomization: true }; }, async () => selected), log);
	const loading = source.updatePolicyDefinitions(binding);
	await started;
	selected = [];
	changes.fire({ revision: 2n, accounts: [] });
	release();
	await loading;
	assert.equal(source.getPolicyValue('ManagedFeature'), undefined);
});

test('Account callbacks see only declared fields and missing fields do not create default restrictions', async () => {
	using changes = new Emitter<AccountState>();
	let raw: Readonly<Record<string, JsonValue>> = { permissions: { disableBypassPermissionsMode: 'disable' }, unrequested: true };
	using source = new AccountPolicyService(accountServices(changes), githubServices(async () => raw), log);
	const definitions: Record<string, PolicyDefinition> = {
		ManagedFeature: {
			type: 'boolean', managedSettings: { 'permissions.disableBypassPermissionsMode': { type: 'string' } }, value: data => {
				assert.equal(data.managedSettings?.unrequested, undefined);
				return data.managedSettings?.['permissions.disableBypassPermissionsMode'] === 'disable';
			}
		}
	};
	await source.updatePolicyDefinitions(definitions);
	assert.equal(source.getPolicyValue('ManagedFeature'), true);
	raw = {};
	await source.updatePolicyDefinitions(definitions);
	assert.equal(source.getPolicyValue('ManagedFeature'), undefined);
});

test('Explicit refresh exposes cold failure, joins in-flight requests, retains old values and recovers on withdrawal', async () => {
	using changes = new Emitter<AccountState>();
	let calls = 0;
	let raw: Readonly<Record<string, JsonValue>> | null | Error = new GitHubError(GitHubErrorCode.Unavailable);
	let release: (() => void) | undefined;
	let entered: (() => void) | undefined;
	let gate: Promise<void> | undefined;
	using source = new AccountPolicyService(accountServices(changes), githubServices(async () => {
		calls++;
		entered?.();
		await gate;
		if (raw instanceof Error) throw raw;
		return raw;
	}), log);
	const states: AccountPolicyRefreshState[] = [];
	using listener = source.onDidChangeState(state => states.push(state));
	const state = (): AccountPolicyRefreshState => source.state;
	assert.equal(state().phase, 'idle');
	await source.updatePolicyDefinitions(binding);
	assert.equal(state().phase, 'failed');
	assert.equal(state().lastSuccessAt, undefined);
	assert.equal(source.getPolicyValue('ManagedFeature'), undefined);

	raw = { strictPluginOnlyCustomization: true };
	gate = new Promise<void>(resolve => { release = resolve; });
	const started = new Promise<void>(resolve => { entered = resolve; });
	const retry = source.refresh({ retryManagedSettings: true });
	await started;
	assert.equal(state().phase, 'refreshing');
	assert.equal(source.refresh(), retry);
	assert.equal(calls, 2);
	release!();
	await retry;
	assert.equal(state().phase, 'ready');
	assert.equal(source.getPolicyValue('ManagedFeature'), true);
	const success = state().lastSuccessAt;
	assert.equal(typeof success, 'number');

	raw = new GitHubError(GitHubErrorCode.ManagedSettingsUpdateRequired);
	await source.refresh({ retryManagedSettings: true });
	assert.deepEqual(state(), {
		phase: 'failed', failure: GitHubErrorCode.ManagedSettingsUpdateRequired,
		retainsPolicy: true,
		scope: { accountId: 'first', host: 'github.com', credentialRevision: 1n },
		lastAttemptAt: state().lastAttemptAt, lastSuccessAt: success,
	});
	assert.equal(source.getPolicyValue('ManagedFeature'), true);
	raw = null;
	await source.refresh({ retryManagedSettings: true });
	assert.equal(state().phase, 'ready');
	assert.equal(source.getPolicyValue('ManagedFeature'), undefined);
	assert.ok(states.some(state => state.phase === 'failed' && state.lastSuccessAt === undefined));
	assert.ok(states.some(state => state.phase === 'failed' && state.lastSuccessAt === success));
});

test('Refresh scope and success timestamps do not cross credential, host or account changes', async () => {
	using changes = new Emitter<AccountState>();
	let selected = account;
	let raw: Readonly<Record<string, JsonValue>> | Error = { strictPluginOnlyCustomization: true };
	using source = new AccountPolicyService(accountServices(changes), githubServices(async () => {
		if (raw instanceof Error) throw raw;
		return raw;
	}, async () => [selected]), log);
	await source.updatePolicyDefinitions(binding);
	assert.equal(typeof source.state.lastSuccessAt, 'number');
	raw = new GitHubError(GitHubErrorCode.AuthenticationRequired);
	selected = { ...account, credentialRevision: 2n };
	changes.fire({ revision: 2n, accounts: [{ provider: 'github', accountId: selected.id, status: 'ready', credentialRevision: 2n }] });
	await source.refresh();
	assert.equal(source.state.lastSuccessAt, undefined);
	assert.equal(source.state.scope?.credentialRevision, 2n);
	assert.equal(source.getPolicyValue('ManagedFeature'), true);
	for (const next of [{ ...selected, host: 'enterprise.example' }, { ...selected, id: 'second' }]) {
		selected = next;
		await source.refresh();
		assert.equal(source.state.lastSuccessAt, undefined);
		assert.equal(source.state.scope?.host, next.host);
		assert.equal(source.state.scope?.accountId, next.id);
		assert.equal(source.getPolicyValue('ManagedFeature'), undefined);
	}
});

test('Superseding account events complete the new refresh and disposed owners publish no late state', async () => {
	using changes = new Emitter<AccountState>();
	let selected = account;
	let release!: () => void;
	let entered!: () => void;
	const started = new Promise<void>(resolve => { entered = resolve; });
	const held = new Promise<void>(resolve => { release = resolve; });
	let calls = 0;
	using source = new AccountPolicyService(accountServices(changes), githubServices(async () => {
		if (++calls === 1) { entered(); await held; }
		return { strictPluginOnlyCustomization: selected.id === 'second' };
	}, async () => [selected]), log);
	let notifications = 0;
	using listener = source.onDidChangeState(() => { notifications++; });
	const initial = source.updatePolicyDefinitions(binding);
	await started;
	selected = { ...account, id: 'second' };
	changes.fire({ revision: 2n, accounts: [{ provider: 'github', accountId: 'second', status: 'ready', credentialRevision: 1n }] });
	release();
	await initial;
	assert.equal(calls, 2);
	assert.equal(source.state.phase, 'ready');
	assert.equal(source.state.scope?.accountId, 'second');
	assert.equal(source.getPolicyValue('ManagedFeature'), true);
	source.dispose();
	const before = notifications;
	await source.refresh();
	changes.fire({ revision: 3n, accounts: [] });
	assert.equal(notifications, before);
});

test('DI requires the provider and state observers can reenter refresh without duplicating requests', async () => {
	using services = new InstantiationService();
	using changes = new Emitter<AccountState>();
	services.registerInstance(IAccountService, accountServices(changes));
	services.registerInstance(ILogService, log);
	assert.throws(() => services.createInstance(AccountPolicyService), /Unknown service.*githubService/);
	let calls = 0;
	services.registerInstance(IGitHubService, githubServices(async () => { calls++; return {}; }));
	using source = services.createInstance(AccountPolicyService);
	using listener = source.onDidChangeState(state => { if (state.phase === 'refreshing') void source.refresh(); });
	await source.updatePolicyDefinitions(binding);
	assert.equal(calls, 1);
	assert.equal(source.state.phase, 'ready');
});

test('Disposal cancels an in-flight retry without publishing its late success', async () => {
	using changes = new Emitter<AccountState>();
	let release!: () => void;
	let entered!: () => void;
	const started = new Promise<void>(resolve => { entered = resolve; });
	const gate = new Promise<void>(resolve => { release = resolve; });
	let token: import('../../../../../base/common/cancellation.js').CancellationToken | undefined;
	using source = new AccountPolicyService(accountServices(changes), githubServices(async (_id, cancellation) => {
		token = cancellation;
		entered();
		await gate;
		return { strictPluginOnlyCustomization: true };
	}), log);
	let notifications = 0;
	using listener = source.onDidChangeState(() => { notifications++; });
	const pending = source.updatePolicyDefinitions(binding);
	await started;
	source.dispose();
	assert.equal(token?.isCancellationRequested, true);
	const before = notifications;
	release();
	await pending;
	assert.equal(notifications, before);
	assert.equal(source.getPolicyValue('ManagedFeature'), undefined);
});

test('State observers can dispose the owner before a request starts', async () => {
	using changes = new Emitter<AccountState>();
	let calls = 0;
	using source = new AccountPolicyService(accountServices(changes), githubServices(async () => {
		calls++;
		return { strictPluginOnlyCustomization: true };
	}, async () => { calls++; return [account]; }), log);
	using listener = source.onDidChangeState(state => {
		if (state.phase === 'refreshing') source.dispose();
	});
	await source.updatePolicyDefinitions(binding);
	assert.equal(calls, 0);
	assert.equal(source.getPolicyValue('ManagedFeature'), undefined);
});
