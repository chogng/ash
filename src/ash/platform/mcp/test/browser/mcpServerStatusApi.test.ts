import assert from 'node:assert/strict';
import { test } from 'mocha';
import type { AppServerProtocolClient } from '../../../agentHost/browser/appServerProtocolClient.js';
import {
	createAppServerMcpServerStatusApi,
	createDisconnectedMcpServerStatusApi,
} from '../../browser/mcpServerStatusApi.js';

test('MCP status reads the backend identity and diagnostics without exposing transport configuration', async () => {
	const requests: unknown[] = [];
	const state = { status: 'unavailable', reason: 'Connection refused' };
	const connection = {
		capabilities: { mcp: true },
		request: async (definition: { method: string }, params: unknown) => {
			requests.push([definition.method, params]);
			return {
				catalogGeneration: 9,
				servers: [
					{
						id: 'configured',
						displayName: 'Configured server',
						httpOrigin: 'https://example.com',
						state,
						catalogGeneration: 8,
						connectionGeneration: null,
						toolCount: 0,
						transport: { url: 'https://example.com/private', bearer: 'secret' },
					},
				],
			};
		},
	} as unknown as AppServerProtocolClient;
	const api = createAppServerMcpServerStatusApi(connection);
	assert.equal(api.isAvailable, true);
	assert.deepEqual(await api.read(), {
		catalogGeneration: 9,
		servers: [
			{
				id: 'configured',
				displayName: 'Configured server',
				httpOrigin: 'https://example.com',
				state: { status: 'unavailable', reason: 'Connection refused' },
				catalogGeneration: 8,
				connectionGeneration: null,
				toolCount: 0,
			},
		],
	});
	assert.deepEqual(requests, [['mcp/server/status', {}]]);
});

test('Unsupported and disconnected MCP status never issue an RPC or return an empty successful snapshot', async () => {
	const connection = {
		capabilities: { mcp: false },
		request: async () => {
			assert.fail('Unsupported MCP status must not send a request');
		},
	} as unknown as AppServerProtocolClient;
	const api = createAppServerMcpServerStatusApi(connection);
	assert.equal(api.isAvailable, false);
	await assert.rejects(api.read(), /MCP server status is unavailable/);
	const disconnected = createDisconnectedMcpServerStatusApi(async operation => {
		throw new Error(operation);
	});
	assert.equal(disconnected.isAvailable, false);
	await assert.rejects(disconnected.read(), /mcpServerStatus.read/);
});
