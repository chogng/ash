import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Event } from '../../../../../base/common/event.js';
import { InMemoryConfigurationService } from '../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import type { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { ChatModelPreferences, LanguageModelsConfigurationService } from '../../browser/languageModelsConfigurationService.js';
import { ModelCatalogConfiguration } from '../../common/languageModelsConfiguration.js';

const first = { provider: 'openai', model: 'gpt-6.1-sol' };
const second = { provider: 'anthropic', model: 'claude-opus-5-5' };
const catalog = [first, second].map(model => ({ model, displayName: model.model, longContext: null }));

test('Backend model defaults replace legacy manual remembrance while an explicit new-chat setting retains priority', async () => {
	using configuration = new InMemoryConfigurationService();
	using preferences = new LanguageModelsConfigurationService(ChatModelPreferences, configuration,
		{ get: () => 'openai/gpt-6.1-sol', onDidChangeValue: Event.None } as unknown as IStorageService);
	assert.deepEqual(preferences.getDefaultNewChatModel(catalog), first);
	assert.equal(preferences.getDefaultNewChatModel(catalog, null), undefined);
	assert.deepEqual(preferences.getDefaultNewChatModel(catalog, second), second);
	await configuration.updateValue(ModelCatalogConfiguration.defaultModel, 'openai/gpt-6.1-sol');
	assert.deepEqual(preferences.getDefaultNewChatModel(catalog, second), first);
	await configuration.updateValue(ModelCatalogConfiguration.defaultModel, 'auto');
	assert.equal(preferences.getDefaultNewChatModel(catalog, second), undefined);
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
