import assert from 'node:assert/strict';
import { test } from 'mocha';
import type { AppServerProtocolClient } from '../../../agentHost/browser/appServerProtocolClient.js';
import type { ConfigUpdateParams, ModelPreferencesUpdateParams } from '../../../../../../.build/protocol/typescript/index.js';
import { createAppServerModelApi, createAppServerThreadApi } from '../../browser/sessionApi.js';

test('message checkpoints and restoration use the existing typed session protocol', async () => {
	const requests: { method: string; params: unknown; }[] = [];
	const connection = {
		async request(definition: { method: string; }, params: unknown): Promise<unknown> {
			requests.push({ method: definition.method, params });
			return definition.method === 'session/thread/checkpoints'
				? { checkpoints: [] }
				: { type: 'thread', value: { session: { sessionId: 'session' }, threadId: 'restored' } };
		},
	} as unknown as AppServerProtocolClient;
	const api = createAppServerThreadApi(connection);
	assert.deepEqual(await api.checkpoints({ sessionId: 'session', threadId: 'source' }), { checkpoints: [] });
	const result = await api.restoreMessage({ sessionId: 'session', threadId: 'source', itemId: 'message', boundary: 'before', title: 'Restored', commandId: 'restore-command' });
	assert.equal(result.threadId, 'restored');
	assert.deepEqual(requests, [
		{ method: 'session/thread/checkpoints', params: { sessionId: 'session', threadId: 'source' } },
		{ method: 'session/request', params: { sessionId: 'session', commandId: 'restore-command', request: { type: 'restoreMessage', threadId: 'source', itemId: 'message', boundary: 'before', title: 'Restored' } } },
	]);
});

test('Model preferences send a targeted update with the current revision', async () => {
	const writes: ModelPreferencesUpdateParams[] = [];
	const connection = {
		async request(definition: { method: string; }, params: ModelPreferencesUpdateParams): Promise<unknown> {
			if (definition.method === 'config/read') { return { revision: 7 }; }
			assert.equal(definition.method, 'model/preferences/update');
			writes.push(params);
			return {};
		},
	} as unknown as AppServerProtocolClient;
	const api = createAppServerModelApi(connection);
	const model = { provider: 'openai', model: 'test-model' };
	await api.setModelPreferences(model, { acceleration: 'priority' });
	await api.setModelPreferences(model, { longContext: true });
	await api.setModelPreferences(model, { acceleration: null });
	assert.deepEqual(writes.map(({ command_id, ...update }) => { assert.ok(command_id); return update; }), [
		{ expected_revision: 7, model, acceleration: 'priority' },
		{ expected_revision: 7, model, long_context: true },
		{ expected_revision: 7, model, acceleration: null },
	]);
	assert.equal(new Set(writes.map(write => write.command_id)).size, 3);
});

test('Review model saves only independent review settings with the current config revision', async () => {
	const selection = { type: 'explicit', model: { provider: 'openai', model: 'gpt-6-luna' }, connection: 'openai', reasoningEffort: 'low' } as const;
	const writes: ConfigUpdateParams[] = [];
	const connection = {
		async request(definition: { method: string; }, params: ConfigUpdateParams): Promise<unknown> {
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
