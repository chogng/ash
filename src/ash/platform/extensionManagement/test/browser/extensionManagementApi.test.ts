import assert from 'node:assert/strict';
import { test } from 'mocha';
import type { AppServerProtocolClient } from '../../../agentHost/browser/appServerProtocolClient.js';
import { createAppServerExtensionManagementApi } from '../../browser/extensionManagementApi.js';

test('Extensions filtered search requires an advertised search contract before sending a request', async () => {
	const calls: unknown[] = [];
	const contracts: Record<string, { version: number; }> = {};
	const connection = {
		capabilities: { contracts },
		request: async (definition: { method: string; }, params: unknown) => { calls.push([definition.method, params]); return { packages: [] }; },
	} as unknown as AppServerProtocolClient;
	const api = createAppServerExtensionManagementApi(connection);
	const params = { query: '', packageType: null, limit: 20, capabilityKind: 'executable' as const, languageId: 'typescriptreact' };
	await assert.rejects(api.search(params), /does not support Extensions capability and language filters/);
	assert.deepEqual(calls, []);
	await api.search({ ...params, capabilityKind: null, languageId: null });
	contracts.extensionsSearch = { version: 1 };
	assert.deepEqual(await api.search(params), { packages: [] });
	assert.deepEqual(calls, [
		['extensions/search', { ...params, capabilityKind: null, languageId: null }],
		['extensions/search', params],
	]);
});


test('Extension tool detection requires its capability and requests the current App Server only', async () => {
	const calls: unknown[] = [];
	const contracts: Record<string, { version: number; }> = {};
	const environment = { platform: 'linux', executables: ['python3'] };
	const connection = { capabilities: { contracts }, request: async (definition: { method: string; }, params: unknown) => { calls.push([definition.method, params]); return environment; } } as unknown as AppServerProtocolClient;
	const api = createAppServerExtensionManagementApi(connection);
	assert.deepEqual(await api.recommendationEnvironment(), { platform: 'other', executables: [] });
	assert.deepEqual(calls, []);
	contracts.extensionRecommendations = { version: 1 };
	assert.deepEqual(await api.recommendationEnvironment(), environment);
	assert.deepEqual(calls, [['extensions/recommendations/environment', {}]]);
});
