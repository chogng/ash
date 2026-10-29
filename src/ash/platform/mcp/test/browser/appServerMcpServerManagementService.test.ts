import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Emitter } from '../../../../base/common/event.js';
import { AppServerRemoteError } from '../../../agentHost/common/appServerError.js';
import type { AppServerProtocolClient } from '../../../agentHost/browser/appServerProtocolClient.js';
import {
	AppServerMcpServerManagementService,
	createDisconnectedMcpServerManagementService,
} from '../../browser/appServerMcpServerManagementService.js';
import type { McpServerConfiguration } from '../../common/mcpServerManagementService.js';

test('MCP management writes the reviewed revision, preserves transport and credential references, and invalidates snapshots', async () => {
	using notifications = new Emitter<{ method: string }>();
	using states = new Emitter<void>();
	const requests: { method: string; params: unknown }[] = [];
	const configured: McpServerConfiguration = {
		id: 'user:mcp:local',
		displayName: 'Local server',
		transport: { type: 'stdio', command: '/bin/server', args: ['--path', 'a b'] },
		credential: { type: 'reference', credentialRef: 'stored-token' },
		enablement: 'disabled',
	};
	const connection = {
		capabilities: { mcp: true },
		onNotification: notifications.event,
		onStateChange: states.event,
		request: async (definition: { method: string }, params: unknown) => {
			requests.push({ method: definition.method, params });
			return definition.method === 'config/read'
				? { revision: 7, mcpServers: { [configured.id]: { ...configured, secret: 'never expose' } } }
				: { revision: 8 };
		},
	} as unknown as AppServerProtocolClient;
	using service = new AppServerMcpServerManagementService(connection);
	let changes = 0;
	using listener = service.onDidChange(() => changes++);
	assert.deepEqual(await service.readConfiguration(), { revision: 7, servers: [configured] });
	await service.save(configured, 7);
	await service.setEnablement(configured.id, true, 8);
	await service.connect(configured.id);
	await service.disconnect(configured.id);
	await service.remove(configured.id, 9);
	assert.equal(changes, 5);
	const writes = requests.filter(request => request.method !== 'config/read');
	assert.deepEqual(
		writes.map(request => {
			const { commandId, ...params } = request.params as Record<string, unknown>;
			if (['mcp/server/upsert', 'mcp/server/enablement/set', 'mcp/server/remove'].includes(request.method)) {
				assert.equal(typeof commandId, 'string');
			} else {
				assert.equal(commandId, undefined);
			}
			return { method: request.method, params };
		}),
		[
			{ method: 'mcp/server/upsert', params: { server: configured, expectedRevision: 7 } },
			{
				method: 'mcp/server/enablement/set',
				params: { serverId: configured.id, enablement: 'enabled', expectedRevision: 8 },
			},
			{ method: 'mcp/server/connect', params: { serverId: configured.id } },
			{ method: 'mcp/server/disconnect', params: { serverId: configured.id } },
			{ method: 'mcp/server/remove', params: { serverId: configured.id, expectedRevision: 9 } },
		],
	);
	assert.equal(
		new Set(
			writes
				.filter(request => (request.params as Record<string, unknown>).commandId)
				.map(request => (request.params as Record<string, unknown>).commandId),
		).size,
		3,
	);
	notifications.fire({ method: 'config/changed' });
	states.fire();
	assert.equal(changes, 7);
	service.dispose();
	assert.equal(notifications.hasListeners(), false);
	assert.equal(states.hasListeners(), false);
});

test('MCP revision conflicts are localized and invalidate snapshots without retrying', async () => {
	using notifications = new Emitter<{ method: string }>();
	using states = new Emitter<void>();
	let calls = 0;
	using service = new AppServerMcpServerManagementService({
		capabilities: { mcp: true },
		onNotification: notifications.event,
		onStateChange: states.event,
		request: async () => {
			calls++;
			throw new AppServerRemoteError(-32031, 'opaque backend message', { kind: 'ConfigRevisionConflict' });
		},
	} as unknown as AppServerProtocolClient);
	let changes = 0;
	using listener = service.onDidChange(() => changes++);
	await assert.rejects(service.remove('user:mcp:local', 7), /MCP configuration changed/);
	assert.equal(calls, 1);
	assert.equal(changes, 1);
});

test('Unsupported and disconnected MCP management rejects every operation without sending RPCs', async () => {
	using notifications = new Emitter<{ method: string }>();
	using states = new Emitter<void>();
	using unsupported = new AppServerMcpServerManagementService({
		capabilities: { mcp: false },
		onNotification: notifications.event,
		onStateChange: states.event,
		request: async () => {
			assert.fail('Unsupported management must not send RPCs');
		},
	} as unknown as AppServerProtocolClient);
	using disconnected = createDisconnectedMcpServerManagementService(async operation => {
		throw new Error(operation);
	});
	const server: McpServerConfiguration = {
		id: 'user:mcp:http',
		displayName: 'HTTP server',
		transport: { type: 'streamableHttp', url: 'https://example.com/mcp' },
		credential: { type: 'unauthenticated' },
		enablement: 'disabled',
	};
	for (const service of [unsupported, disconnected]) {
		assert.equal(service.isAvailable, false);
		for (const operation of [
			() => service.readConfiguration(),
			() => service.save(server, 1),
			() => service.remove(server.id, 1),
			() => service.setEnablement(server.id, true, 1),
			() => service.connect(server.id),
			() => service.disconnect(server.id),
		]) {
			await assert.rejects(operation);
		}
	}
});

test('MCP browser login completes on the same connection and forwards the issuer, then signs out locally', async () => {
	using notifications = new Emitter<{ method: string }>();
	using states = new Emitter<void>();
	const calls: Array<[string, unknown]> = [];
	const resources: string[] = [];
	using service = new AppServerMcpServerManagementService(
		{
			capabilities: { mcp: true, mcpOAuth: true },
			state: 'ready',
			onNotification: notifications.event,
			onStateChange: states.event,
			request: async (definition: { method: string }, params: unknown) => {
				calls.push([definition.method, params]);
				if (definition.method === 'config/read') {
					return {
						revision: 1,
						mcpServers: {
							'user:mcp:test': {
								id: 'user:mcp:test',
								displayName: 'Test',
								transport: { type: 'streamableHttp', url: 'https://mcp.test/rpc' },
								credential: { type: 'unauthenticated' },
								enablement: 'enabled',
							},
						},
					};
				}
				return definition.method === 'mcp/oauth/start'
					? { flowId: 'flow', authorizationUrl: 'https://issuer.test/authorize' }
					: { serverId: 'user:mcp:test' };
			},
		} as unknown as AppServerProtocolClient,
		{
			externalOpener: {
				openExternal: async () => {
					resources.push('open');
					return true;
				},
			},
			clipboardService: {} as never,
			callbackHost: {
				listen: async () => ({ id: 'callback', redirectUri: 'http://127.0.0.1:3333/callback' }),
				wait: async () => ({ state: 'state', code: 'code', issuer: 'https://issuer.test' }),
				close: async id => {
					resources.push(`close:${id}`);
				},
			},
		},
	);
	await service.login('user:mcp:test');
	await service.logout('user:mcp:test');
	assert.deepEqual(calls, [
		['config/read', {}],
		[
			'mcp/oauth/start',
			{
				serverId: 'user:mcp:test',
				redirectUri: 'http://127.0.0.1:3333/callback',
				clientId: undefined,
				clientMetadataUrl: undefined,
				scopes: [],
			},
		],
		[
			'mcp/oauth/complete',
			{ flowId: 'flow', state: 'state', authorizationCode: 'code', issuer: 'https://issuer.test' },
		],
		['mcp/oauth/logout', { serverId: 'user:mcp:test' }],
	]);
	assert.deepEqual(resources, ['open', 'close:callback']);
});

test('Cancelling MCP sign-in closes the callback and cancels the backend flow without completing it', async () => {
	using notifications = new Emitter<{ method: string }>();
	using states = new Emitter<void>();
	const calls: string[] = [];
	const controller = new AbortController();
	let waiting!: () => void;
	const startedWaiting = new Promise<void>(resolve => {
		waiting = resolve;
	});
	let rejectCallback!: (reason: Error) => void;
	const callback = new Promise<{ state: string; code: string }>((_, reject) => {
		rejectCallback = reject;
	});
	using service = new AppServerMcpServerManagementService(
		{
			capabilities: { mcp: true, mcpOAuth: true },
			state: 'ready',
			onNotification: notifications.event,
			onStateChange: states.event,
			request: async (definition: { method: string }) => {
				calls.push(definition.method);
				if (definition.method === 'config/read') {
					return {
						revision: 1,
						mcpServers: {
							'user:mcp:test': {
								id: 'user:mcp:test',
								displayName: 'Test',
								transport: { type: 'streamableHttp', url: 'https://mcp.test/rpc' },
								credential: { type: 'unauthenticated' },
								enablement: 'enabled',
							},
						},
					};
				}
				return { flowId: 'flow', authorizationUrl: 'https://issuer.test/authorize' };
			},
		} as unknown as AppServerProtocolClient,
		{
			externalOpener: { openExternal: async () => true },
			clipboardService: {} as never,
			callbackHost: {
				listen: async () => ({ id: 'callback', redirectUri: 'http://127.0.0.1:3333/callback' }),
				wait: () => {
					waiting();
					return callback;
				},
				close: async () => {
					rejectCallback(new Error('Closed'));
				},
			},
		},
	);
	const login = service.login('user:mcp:test', {}, controller.signal);
	const rejected = assert.rejects(login, /cancelled/);
	await startedWaiting;
	controller.abort();
	await rejected;
	assert.deepEqual(calls, ['config/read', 'mcp/oauth/start', 'mcp/oauth/cancel']);
});
