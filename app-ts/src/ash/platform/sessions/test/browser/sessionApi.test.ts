import assert from 'node:assert/strict';
import { test } from 'mocha';
import type { AppServerProtocolClient } from '../../../app-server/browser/appServerProtocolClient.js';
import type { ConfigUpdateParams, ModelPreferencesUpdateParams } from '../../../app-server/common/generated/index.js';
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

test('Review model saves only independent review settings with the current config revision', async () => {
	const selection = { type: 'explicit', model: { provider: 'openai', model: 'gpt-6-luna' }, connection: 'openai', reasoningEffort: 'low' } as const;
	const writes: ConfigUpdateParams[] = [];
	const connection = {
		async request(definition: { method: string }, params: ConfigUpdateParams): Promise<unknown> {
			if (definition.method === 'config/read') return { revision: 9, approvalReviewModel: selection, model: { provider: 'openai', model: 'gpt-6-astra' } };
			assert.equal(definition.method, 'config/update');
			writes.push(params);
			return {};
		},
	} as unknown as AppServerProtocolClient;
	const api = createAppServerModelApi(connection);
	assert.deepEqual(await api.readApprovalReviewModel(), selection);
	await api.setApprovalReviewModel(selection);
	await api.setApprovalReviewModel({ type: 'automatic' });
	assert.deepEqual(writes.map(({ commandId, ...write }) => { assert.ok(commandId); return write; }), [
		{ expectedRevision: 9, approvalReviewModel: selection },
		{ expectedRevision: 9, approvalReviewModel: { type: 'automatic' } },
	]);
});
