import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Event } from '../../../../../base/common/event.js';
import { InMemoryConfigurationService } from '../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import type { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { ChatModelPreferences, LanguageModelsConfigurationService } from '../../browser/languageModelsConfigurationService.js';
import { ModelCatalogConfiguration } from '../../common/languageModelsConfiguration.js';
import { TestConfigurationService } from '../../../../services/configuration/test/common/testServices.js';

const first = { provider: 'openai', model: 'gpt-6.1-sol' };
const second = { provider: 'anthropic', model: 'claude-opus-5-5' };
const catalog = [first, second].map(model => ({ model, displayName: model.model, longContext: null }));

test('New chats restore the backend picker choice before legacy manual remembrance', async () => {
	using configuration = new InMemoryConfigurationService();
	using preferences = new LanguageModelsConfigurationService(ChatModelPreferences, configuration,
		{ get: () => 'openai/gpt-6.1-sol', onDidChangeValue: Event.None } as unknown as IStorageService);
	assert.deepEqual(preferences.getDefaultNewChatModel(catalog), first);
	assert.equal(preferences.getDefaultNewChatModel(catalog, null), undefined);
	assert.deepEqual(preferences.getDefaultNewChatModel(catalog, second), second);
});

test('A retired default-model setting cannot override the last picker choice', () => {
	using configuration = new TestConfigurationService({ source: '{"chat.defaultModel":"anthropic/claude-opus-5-5"}' });
	using preferences = new LanguageModelsConfigurationService(ChatModelPreferences, configuration,
		{ get: () => undefined, onDidChangeValue: Event.None } as unknown as IStorageService);
	assert.deepEqual(preferences.getDefaultNewChatModel(catalog, first), first);
});

test('An unavailable saved model remains identifiable instead of silently becoming another model', () => {
	using configuration = new InMemoryConfigurationService();
	using preferences = new LanguageModelsConfigurationService(ChatModelPreferences, configuration,
		{ get: () => 'openai/gpt-6.1-sol', onDidChangeValue: Event.None } as unknown as IStorageService);
	const unavailable = { provider: 'custom-endpoint', model: 'retired' };
	assert.deepEqual(preferences.getDefaultNewChatModel(catalog, unavailable), unavailable);
});


test('Persisted Auto intent inherits the configured backend runtime without replacing it with a manual selection', () => {
	using configuration = new InMemoryConfigurationService();
	using preferences = new LanguageModelsConfigurationService(ChatModelPreferences, configuration,
		{ get: () => 'auto', onDidChangeValue: Event.None } as unknown as IStorageService);
	assert.equal(preferences.getDefaultNewChatModel(catalog, second), undefined);
});


test('Visibility persists across services and provider cleanup preserves other connections', async () => {
	using configuration = new InMemoryConfigurationService();
	const storage = { onDidChangeValue: Event.None } as IStorageService;
	using preferences = new LanguageModelsConfigurationService(ChatModelPreferences, configuration, storage);
	const custom = { provider: 'custom-one', model: 'one' };
	const other = { provider: 'custom-one-extra', model: 'two' };
	await Promise.all([preferences.setModelVisible(custom, true), preferences.setModelVisible(other, true)]);
	using restored = new LanguageModelsConfigurationService(ChatModelPreferences, configuration, storage);
	assert.equal(restored.isModelVisible(custom), true);
	assert.equal(restored.isModelVisible(other), true);
	await preferences.removeProviderPreferences('custom-one');
	assert.equal(restored.isModelVisible(custom), false);
	assert.equal(restored.isModelVisible(other), true);
	assert.deepEqual(configuration.getValue(ModelCatalogConfiguration.hiddenModels), [{ ...other, visible: true }]);
	await restored.setModelVisible(other, false);
	assert.deepEqual(configuration.getValue(ModelCatalogConfiguration.hiddenModels), []);
});
