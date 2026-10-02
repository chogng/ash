import assert from 'node:assert/strict';
import { test } from 'mocha';
import type { AppServerProtocolClient } from '../../../app-server/browser/appServerProtocolClient.js';
import type { ProviderConfigDto } from '../../../app-server/common/generated/index.js';
import { createAppServerModelApi } from '../../browser/sessionApi.js';

function fixture(providers: Record<string, ProviderConfigDto>) {
	const writes: { expectedRevision: string; config: ProviderConfigDto }[] = [];
	const connection = {
		async request(definition: { method: string }, params: { expectedRevision: string; config: ProviderConfigDto }): Promise<unknown> {
			if (definition.method === 'config/read') { return { revision: 'revision-1', providers }; }
			assert.equal(definition.method, 'provider/configure');
			writes.push(params);
			providers[params.config.provider] = params.config;
			return {};
		},
	} as unknown as AppServerProtocolClient;
	return { api: createAppServerModelApi(connection), writes };
}

test('Model preferences retain the active connection, other models and compaction settings', async () => {
	const config: ProviderConfigDto = {
		connection: 'chatgpt-subscription', provider: 'openai', maxOutputTokens: 24_000,
		fastModels: ['another-model'],
		modelContext: { 'test-model': { contextWindow: 272_000, autoCompactTokenLimit: 200_000 }, 'another-model': { contextWindow: 128_000 } },
	};
	const { api, writes } = fixture({ openai: config });
	const model = { provider: 'openai', model: 'test-model' };
	await api.setModelPreferences(model, { fast: true });
	await api.setModelPreferences(model, { contextWindow: 1_000_000 });
	await api.setModelPreferences(model, { fast: false });
	assert.deepEqual(writes.map(({ expectedRevision, config }) => ({ expectedRevision, config })), [
		{ expectedRevision: 'revision-1', config: { ...config, fastModels: ['another-model', 'test-model'] } },
		{ expectedRevision: 'revision-1', config: { ...config, fastModels: ['another-model', 'test-model'], modelContext: { ...config.modelContext, 'test-model': { contextWindow: 1_000_000, autoCompactTokenLimit: 200_000 } } } },
		{ expectedRevision: 'revision-1', config: { ...config, modelContext: { ...config.modelContext, 'test-model': { contextWindow: 1_000_000, autoCompactTokenLimit: 200_000 } } } },
	]);
	assert.deepEqual(await api.listFastModels(), [{ provider: 'openai', model: 'another-model' }]);
});

test('Model preferences configure the built-in API connection before account setup', async () => {
	const { api, writes } = fixture({});
	await api.setModelPreferences({ provider: 'openai', model: 'test-model' }, { contextWindow: 1_000_000 });
	assert.deepEqual(writes[0].config, { connection: 'openai', provider: 'openai', fastModels: [], modelContext: { 'test-model': { contextWindow: 1_000_000 } } });
});
