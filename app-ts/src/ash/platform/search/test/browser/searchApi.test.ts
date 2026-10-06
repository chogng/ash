import assert from 'node:assert/strict';
import { test } from 'mocha';
import type { AppServerProtocolClient } from '../../../app-server/browser/appServerProtocolClient.js';
import type { ConfigUpdateParams } from '../../../app-server/common/generated/index.js';
import { createAppServerContentSearchConfigurationApi, createDisconnectedContentSearchConfigurationApi } from '../../browser/searchApi.js';

test('content search configuration saves only the selected backend at the read revision', async () => {
	const writes: ConfigUpdateParams[] = [];
	const connection = {
		async request(definition: { method: string; }, params: ConfigUpdateParams): Promise<unknown> {
			if (definition.method === 'config/read') { return { revision: 7, grepBackend: 'tgrep' }; }
			assert.equal(definition.method, 'config/update');
			writes.push(params);
			return {};
		},
	} as unknown as AppServerProtocolClient;
	const api = createAppServerContentSearchConfigurationApi(connection);
	const snapshot = await api.read();
	assert.deepEqual(snapshot, { revision: 7, engine: 'tgrep' });
	await api.configure('ripgrep', snapshot.revision);
	await api.configure('tgrep', snapshot.revision);
	assert.deepEqual(writes.map(({ commandId, ...write }) => { assert.ok(commandId); return write; }), [
		{ expectedRevision: 7, grepBackend: 'ripgrep' }, { expectedRevision: 7, grepBackend: 'tgrep' },
	]);
	assert.equal(new Set(writes.map(write => write.commandId)).size, 2);
});

test('content search configuration propagates stale revision failures', async () => {
	const failure = new Error('Configuration revision conflict');
	const connection = { request: async () => { throw failure; } } as unknown as AppServerProtocolClient;
	const api = createAppServerContentSearchConfigurationApi(connection);
	await assert.rejects(api.configure('ripgrep', 2), error => error === failure);
});

test('disconnected content search settings cannot read or save backend preferences', async () => {
	const operations: string[] = [];
	const api = createDisconnectedContentSearchConfigurationApi(async operation => {
		operations.push(operation);
		throw new Error('Disconnected');
	});
	await assert.rejects(api.read(), /Disconnected/);
	await assert.rejects(api.configure('ripgrep', 1), /Disconnected/);
	assert.deepEqual(operations, ['contentSearchConfiguration.read', 'contentSearchConfiguration.configure']);
});
