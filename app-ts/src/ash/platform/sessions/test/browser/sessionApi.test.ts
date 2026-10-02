import assert from 'node:assert/strict';
import { test } from 'mocha';
import type { AppServerProtocolClient } from '../../../app-server/browser/appServerProtocolClient.js';
import type { ModelPreferencesUpdateParams } from '../../../app-server/common/generated/index.js';
import { createAppServerModelApi } from '../../browser/sessionApi.js';

test('Model preferences send a targeted update with the current revision', async () => {
	const writes: ModelPreferencesUpdateParams[] = [];
	const connection = {
		async request(definition: { method: string }, params: ModelPreferencesUpdateParams): Promise<unknown> {
			if (definition.method === 'config/read') { return { revision: 7 }; }
			assert.equal(definition.method, 'model/preferences/update');
			writes.push(params);
			return {};
		},
	} as unknown as AppServerProtocolClient;
	const api = createAppServerModelApi(connection);
	const model = { provider: 'openai', model: 'test-model' };
	await api.setModelPreferences(model, { fast: true });
	await api.setModelPreferences(model, { contextWindow: 1_000_000 });
	await api.setModelPreferences(model, { fast: false });
	assert.deepEqual(writes.map(({ commandId, ...update }) => { assert.ok(commandId); return update; }), [
		{ expectedRevision: 7, model, fast: true },
		{ expectedRevision: 7, model, contextWindow: 1_000_000 },
		{ expectedRevision: 7, model, fast: false },
	]);
	assert.equal(new Set(writes.map(write => write.commandId)).size, 3);
});
