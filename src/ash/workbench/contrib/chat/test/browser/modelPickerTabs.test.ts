import assert from 'node:assert/strict';
import { test } from 'mocha';
import type { ModelProviderCredentialStatus } from '../../../../services/chat/common/chatService.js';
import type { ModelCatalogEntry } from '../../../../services/chat/common/modelCatalog.js';
import { buildModelPickerDestinations } from '../../browser/widget/input/modelPicker/modelPickerTabs.js';

function entry(provider: string, model: string): ModelCatalogEntry {
	return { model: { provider, model }, displayName: model, longContext: null };
}

function provider(connection: string, name: string): ModelProviderCredentialStatus {
	return {
		connection, provider: 'openai', displayName: name, access: 'apiKey', active: true,
		configured: true, ready: true, apiKeyPolicy: 'required', apiKeyConfigured: true
	};
}

test('Provider destinations preserve catalog order and separate connections offering the same model ID', () => {
	const models = [entry('team-b', 'shared'), entry('openai', 'builtin'), entry('team-a', 'shared'), entry('team-b', 'other')];
	const destinations = buildModelPickerDestinations(models, [provider('team-a', 'Team A'), provider('team-b', 'Team B'), provider('unused', 'Unused')]);
	assert.deepEqual(destinations.map(destination => ({ id: destination.id, label: destination.label, models: destination.models.map(entry => entry.model.model) })), [
		{ id: 'team-b', label: 'Team B', models: ['shared', 'other'] },
		{ id: 'openai', label: 'GPT', models: ['builtin'] },
		{ id: 'team-a', label: 'Team A', models: ['shared'] },
	]);
	assert.equal(destinations[0]!.models[0], models[0]);
});

test('An unknown provider retains its exact ID and an empty catalog retains an actionable destination', () => {
	assert.deepEqual(buildModelPickerDestinations([entry('custom://endpoint', 'shared')], []).map(({ id, label }) => ({ id, label })), [
		{ id: 'custom://endpoint', label: 'custom://endpoint' },
	]);
	assert.deepEqual(buildModelPickerDestinations([], []), [
		{ id: '', label: 'Models', models: [], placeholders: [] },
	]);
});

test('Provider placeholders retain exact connection ownership and disappear when that connection has models', () => {
	const unavailable = { vendor: 'team-a', label: 'Team A', message: 'Set up this connection' };
	const destinations = buildModelPickerDestinations([entry('team-b', 'shared')], [provider('team-a', 'Team A')], [unavailable]);
	assert.deepEqual(destinations.map(({ id, placeholders }) => ({ id, placeholders })), [
		{ id: 'team-b', placeholders: [] }, { id: 'team-a', placeholders: [unavailable] },
	]);
	assert.deepEqual(buildModelPickerDestinations([entry('team-a', 'shared')], [], [unavailable])[0]!.placeholders, []);
});
