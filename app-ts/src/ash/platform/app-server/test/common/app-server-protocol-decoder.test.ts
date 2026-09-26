import assert from 'node:assert/strict';
import { test } from 'mocha';
import {
	AppServerProtocolDecodeError,
	decodeAppServerListenInfo,
	decodeAppServerNotification,
	decodeAppServerRequestParams,
	decodeAppServerResponse,
	decodeAppServerServerRequest,
} from '../../common/generated/AppServerProtocolDecoder.js';

test('directory permissions reject unknown enum values at the generated boundary', () => {
	const params = { commandId: 'set-permissions', expectedRevision: 1, path: '/workspace', permissions: ['readFiles'] };
	assert.deepEqual(decodeAppServerRequestParams('config/dirPermissions/set', params), params);
	assert.throws(() => decodeAppServerRequestParams('config/dirPermissions/set', { ...params, permissions: ['futurePermission'] }), AppServerProtocolDecodeError);
});

test('Agent identity and replacement origins survive the generated RPC boundary', () => {
	const response = {
		jsonrpc: '2.0', id: 1,
		result: {
			agentId: 'agent-1', createdAtUnixMs: 1,
			threads: [{ sessionId: 'session-1', threadId: 'thread-2', origin: { type: 'replacement', sourceThreadId: 'thread-1', sourceSequence: 7 } }],
		},
	};
	assert.deepEqual(decodeAppServerResponse('agent/read', response), response);
	assert.deepEqual(decodeAppServerRequestParams('session/create', { commandId: 'create', title: 'Task', agentId: 'agent-1' }), { commandId: 'create', title: 'Task', agentId: 'agent-1' });
	assert.throws(() => decodeAppServerRequestParams('agent/read', { agentId: '' }), AppServerProtocolDecodeError);
});

test('App Server listen info accepts only the generated loopback record', () => {
	const listenInfo = {
		kind: 'app-server-listen-info',
		version: 1,
		endpoint: 'ws://127.0.0.1:41789',
	};

	assert.deepEqual(decodeAppServerListenInfo(listenInfo), listenInfo);
	assert.throws(
		() => decodeAppServerListenInfo({ ...listenInfo, kind: 'other' }),
		AppServerProtocolDecodeError,
	);
	assert.throws(
		() => decodeAppServerListenInfo({ ...listenInfo, version: 2 }),
		AppServerProtocolDecodeError,
	);
	assert.throws(
		() => decodeAppServerListenInfo({ kind: listenInfo.kind, version: listenInfo.version }),
		(error: unknown) => error instanceof AppServerProtocolDecodeError && error.path === '$.endpoint',
	);
	assert.throws(
		() => decodeAppServerListenInfo({ ...listenInfo, endpoint: 'ws://192.168.1.8:41789' }),
		(error: unknown) => error instanceof AppServerProtocolDecodeError && error.path === '$.endpoint',
	);
	assert.throws(
		() => decodeAppServerListenInfo({ ...listenInfo, token: 'secret' }),
		(error: unknown) => error instanceof AppServerProtocolDecodeError && error.path === '$.token',
	);
});

test('App Server response decoding selects the result schema from its pending method', () => {
	assert.deepEqual(
		decodeAppServerResponse('resource/release', { jsonrpc: '2.0', id: 7, result: null }),
		{ jsonrpc: '2.0', id: 7, result: null },
	);
	assert.throws(
		() => decodeAppServerResponse('resource/release', { jsonrpc: '2.0', id: 7, result: {} }),
		AppServerProtocolDecodeError,
	);
	assert.deepEqual(
		decodeAppServerResponse('resource/release', {
			jsonrpc: '2.0',
			id: 8,
			error: { code: -32013, message: 'Resource not found', data: { kind: 'ResourceNotFound' } },
		}),
		{
			jsonrpc: '2.0',
			id: 8,
			error: { code: -32013, message: 'Resource not found', data: { kind: 'ResourceNotFound' } },
		},
	);
	assert.throws(
		() => decodeAppServerResponse('resource/release', {
			jsonrpc: '2.0',
			id: 9,
			error: { code: -32013, message: 'Resource not found', data: null },
		}),
		AppServerProtocolDecodeError,
	);
});

test('account revisions preserve the full unsigned 64-bit value across the generated boundary', () => {
	const result = {
		revision: '18446744073709551615',
		accounts: [{
			provider: 'openai', accountId: 'account-1', email: null, displayName: null,
			organization: null, plan: null, status: 'ready', credentialRevision: '18446744073709551615',
		}],
	};
	const response = { jsonrpc: '2.0', id: 8, result };
	assert.deepEqual(decodeAppServerResponse('account/read', response), response);
	assert.throws(() => decodeAppServerResponse('account/read', {
		...response,
		result: { ...result, accounts: [{ ...result.accounts[0], credentialRevision: Number.MAX_SAFE_INTEGER + 1 }] },
	}), AppServerProtocolDecodeError);
});

test('App Server notification decoding rejects unknown methods and envelope fields', () => {
	const notification = {
		jsonrpc: '2.0',
		method: 'session/deleted',
		params: { sessionId: 'session-1' },
	};

	assert.deepEqual(decodeAppServerNotification(notification), notification);
	assert.throws(
		() => decodeAppServerNotification({ ...notification, method: 'session/unknown' }),
		AppServerProtocolDecodeError,
	);
	assert.throws(
		() => decodeAppServerNotification({ ...notification, result: null }),
		(error: unknown) => error instanceof AppServerProtocolDecodeError && error.path === '$.result',
	);
});

test('App Server server-request decoding validates method, request ID, and params', () => {
	const request = {
		jsonrpc: '2.0',
		id: 'browser-request-1',
		method: 'browser/close',
		params: { targetId: 'target-1' },
	};

	assert.deepEqual(decodeAppServerServerRequest(request), request);
	assert.throws(
		() => decodeAppServerServerRequest({ ...request, id: Number.MAX_SAFE_INTEGER + 1 }),
		(error: unknown) => error instanceof AppServerProtocolDecodeError && error.path === '$.id',
	);
	assert.throws(
		() => decodeAppServerServerRequest({ ...request, params: {} }),
		AppServerProtocolDecodeError,
	);
});

test('App Server params decoding rejects integers that JSON cannot preserve exactly', () => {
	assert.deepEqual(
		decodeAppServerRequestParams('resource/read', { resourceId: 'resource-1', offset: 0, maxBytes: 1024 }),
		{ resourceId: 'resource-1', offset: 0, maxBytes: 1024 },
	);
	assert.throws(
		() => decodeAppServerRequestParams('resource/read', {
			resourceId: 'resource-1',
			offset: Number.MAX_SAFE_INTEGER + 1,
			maxBytes: 1024,
		}),
		AppServerProtocolDecodeError,
	);
});


test('Feature map keys and queue edits are validated from the generated schema', () => {
	const params = { commandId: 'config', expectedRevision: 0, features: { codeMode: false } };
	assert.deepEqual(decodeAppServerRequestParams('config/update', params), params);
	assert.throws(() => decodeAppServerRequestParams('config/update', {
		...params, features: { code_mode: true },
	}), AppServerProtocolDecodeError);
	assert.throws(() => decodeAppServerRequestParams('queue/edit', {
		sessionId: 'session', threadId: 'thread', commandId: 'message', expectedRevision: -1,
		action: { type: 'pause' },
	}), AppServerProtocolDecodeError);
	assert.deepEqual(decodeAppServerNotification({ jsonrpc: '2.0', method: 'queue/changed', params: {} }), {
		jsonrpc: '2.0', method: 'queue/changed', params: {},
	});
});

test('Memory records and process memory diagnostics use disjoint generated methods', () => {
	const add = {
		commandId: 'memory-add',
		memoryId: 'memory-1',
		scope: { type: 'profile' },
		title: 'Preferred editor',
		body: 'Use Ash for Rust work.',
	};
	assert.deepEqual(decodeAppServerRequestParams('memory/add', add), add);
	assert.throws(
		() => decodeAppServerRequestParams('memory/add', { ...add, memoryId: 'contains space' }),
		AppServerProtocolDecodeError,
	);
	assert.throws(
		() => decodeAppServerRequestParams('memory/add', { ...add, scope: { type: 'profile', extra: true } }),
		AppServerProtocolDecodeError,
	);
	assert.deepEqual(
		decodeAppServerRequestParams('memoryDiagnostics/read', { sessionId: 'diagnostic-1' }),
		{ sessionId: 'diagnostic-1' },
	);
	assert.deepEqual(
		decodeAppServerNotification({
			jsonrpc: '2.0',
			method: 'memory/changed',
			params: { scope: { type: 'profile' }, catalogRevision: 2 },
		}),
		{
			jsonrpc: '2.0',
			method: 'memory/changed',
			params: { scope: { type: 'profile' }, catalogRevision: 2 },
		},
	);
});
