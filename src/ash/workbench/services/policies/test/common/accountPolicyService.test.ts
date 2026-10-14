import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Emitter, Event } from '../../../../../base/common/event.js';
import type { AccountState, IAccountService } from '../../../../../platform/accounts/common/accountService.js';
import { createDisconnectedGitHubService } from '../../../../../platform/github/browser/appServerGitHubService.js';
import type { GitHubAccount, IGitHubService } from '../../../../../platform/github/common/githubService.js';
import type { JsonValue } from '../../../../../base/common/jsonValue.js';
import { NullLoggerService } from '../../../../../platform/log/common/log.js';
import { AbstractPolicyService, type PolicyDefinition, type PolicyValue } from '../../../../../platform/policy/common/policy.js';
import { MultiplexPolicyService } from '../../../../../platform/policy/common/multiplexPolicyService.js';
import { ConfigurationRegistry } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { PolicyConfiguration } from '../../../../../platform/configuration/common/configurations.js';
import { AccountPolicyService } from '../../common/accountPolicyService.js';
import { ConfigurationService } from '../../../../../platform/configuration/common/configurationService.js';
import { TestConfigurationFiles } from '../../../configuration/test/common/testServices.js';
import { UserDataProfileService } from '../../../userDataProfile/browser/userDataProfileService.js';
import { ChatModelPreferences, LanguageModelsConfigurationService } from '../../../../contrib/chat/browser/languageModelsConfigurationService.js';
import type { IStorageService } from '../../../../../platform/storage/common/storage.js';

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

function githubServices(read: IGitHubService['readManagedSettings'], list: () => Promise<readonly GitHubAccount[]> = async () => [account]): IGitHubService {
	return { ...createDisconnectedGitHubService(), listAccounts: list, readManagedSettings: read };
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
	system.candidate = {};
	await system.updatePolicyDefinitions(binding);
	assert.equal(configuration.configurationModel.getValue('ui.managedFeature'), true);
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
	await source.updatePolicyDefinitions(binding);
	assert.equal(source.getPolicyValue('ManagedFeature'), true);
	raw = null;
	await source.updatePolicyDefinitions(binding);
	assert.equal(source.getPolicyValue('ManagedFeature'), undefined);
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

test('Copilot model policy reaches the real configuration and new-chat consumer, with legacy fallback and withdrawal', async () => {
	using changes = new Emitter<AccountState>();
	let raw: Readonly<Record<string, JsonValue>> = { model: ' anthropic/claude-opus-5-5 ', permissions: { model: 'openai/gpt-6.1-sol' } };
	using source = new AccountPolicyService(accountServices(changes), githubServices(async () => raw), log);
	using files = new TestConfigurationFiles('{"chat.defaultModel":"openai/gpt-6.1-sol"}');
	const profile = new UserDataProfileService();
	using configuration = new ConfigurationService(profile.currentProfile.settingsResource, files, source, log);
	await configuration.initialize();
	using preferences = new LanguageModelsConfigurationService(ChatModelPreferences, configuration,
		{ get: () => undefined, onDidChangeValue: Event.None } as unknown as IStorageService);
	const first = { provider: 'openai', model: 'gpt-6.1-sol' };
	const second = { provider: 'anthropic', model: 'claude-opus-5-5' };
	const catalog = [first, second].map(model => ({ model, displayName: model.model, longContext: null }));
	assert.equal(configuration.inspect('chat.defaultModel').policyValue, 'anthropic/claude-opus-5-5');
	assert.deepEqual(preferences.getDefaultNewChatModel(catalog), second);
	await assert.rejects(configuration.updateValue('chat.defaultModel', 'auto'), /policy/);
	raw = { model: ' ', permissions: { model: 'openai/gpt-6.1-sol' } };
	await source.updatePolicyDefinitions({});
	assert.equal(configuration.inspect('chat.defaultModel').policyValue, 'openai/gpt-6.1-sol');
	raw = {};
	await source.updatePolicyDefinitions({});
	assert.equal(configuration.inspect('chat.defaultModel').policyValue, undefined);
	assert.deepEqual(preferences.getDefaultNewChatModel(catalog), first);
});
