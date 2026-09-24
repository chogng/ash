import assert from 'node:assert/strict';
import { test } from 'mocha';
import type { AppServerProtocolClient } from '../../../app-server/browser/appServerProtocolClient.js';
import { createAppServerMarketplaceApi } from '../../browser/marketplaceApi.js';

test('Marketplace filtered search requires an advertised search contract before sending a request', async () => {
	const calls: unknown[] = [];
	const contracts: Record<string, { version: number }> = {};
	const connection = {
		capabilities: { contracts },
		request: async (definition: { method: string }, params: unknown) => { calls.push([definition.method, params]); return { packages: [] }; },
	} as unknown as AppServerProtocolClient;
	const api = createAppServerMarketplaceApi(connection);
	const params = { query: '', packageType: null, limit: 20, capabilityKind: 'executable' as const, languageId: 'typescriptreact' };
	await assert.rejects(api.search(params), /does not support Marketplace capability and language filters/);
	assert.deepEqual(calls, []);
	await api.search({ ...params, capabilityKind: null, languageId: null });
	contracts.marketplaceSearch = { version: 1 };
	assert.deepEqual(await api.search(params), { packages: [] });
	assert.deepEqual(calls, [
		['marketplace/search', { ...params, capabilityKind: null, languageId: null }],
		['marketplace/search', params],
	]);
});
