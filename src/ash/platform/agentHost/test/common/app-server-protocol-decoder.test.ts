import assert from 'node:assert/strict';
import { test } from 'mocha';
import {
	AppServerProtocolDecodeError,
	decodeAppServerListenInfo,
	decodeAppServerNotification,
	decodeAppServerRequestParams,
	decodeAppServerResponse,
	decodeAppServerServerRequest,
} from '../../../../../../.build/protocol/typescript/AppServerProtocolDecoder.js';

test('message phases and loop decisions survive the generated notification boundary', () => {
	const params = { sessionId: 'session', threadId: 'thread', durableSequence: 7, update: { type: 'itemDelta', itemId: 'message', turnId: 'turn', delta: { type: 'agentMessagePhase', phase: 'final_answer' } } };
	const notification = { jsonrpc: '2.0', method: 'session/thread/update', params };
	assert.deepEqual(decodeAppServerNotification(notification), notification);
	const decision = { action: 'continue', reason: 'nonterminalMessage', stopReason: { type: 'completed' }, messagePhases: ['partial_answer', null, { other: 'future_phase' }], toolCallCount: 0 };
	const committed = { ...notification, params: { ...params, update: { type: 'committed', event: { type: 'modelResponseEvaluated', threadId: 'thread', turnId: 'turn', sourceThreadSequence: 6, decision } } } };
	assert.deepEqual(decodeAppServerNotification(committed), committed);
	assert.throws(() => decodeAppServerNotification({ ...committed, params: { ...committed.params, update: { ...committed.params.update, event: { ...committed.params.update.event, decision: { ...decision, action: 'unknown' } } } } }), AppServerProtocolDecodeError);
});

test('directory permissions reject unknown enum values at the generated boundary', () => {
	const params = { commandId: 'set-permissions', expectedRevision: 1, path: '/workspace', permissions: ['readFiles'] };
	assert.deepEqual(decodeAppServerRequestParams('config/dirPermissions/set', params), params);
	assert.throws(() => decodeAppServerRequestParams('config/dirPermissions/set', { ...params, permissions: ['futurePermission'] }), AppServerProtocolDecodeError);
});

test('search reads accept optional index diagnostics and validate their counts', () => {
	const result = { searchId: 'search-1', matches: [], nextMatch: 0, completed: true, limitHit: false, error: null, freshness: 'indexed' };
	const response = { jsonrpc: '2.0', id: 1, result };
	assert.deepEqual(decodeAppServerResponse('grep/search/read', response), response);
	const indexed = { ...response, result: { ...result, indexStats: { queryPlan: 'AND(3 trigrams)', rawCandidates: 7, candidates: 2, totalFiles: 50 } } };
	assert.deepEqual(decodeAppServerResponse('grep/search/read', indexed), indexed);
	assert.throws(() => decodeAppServerResponse('grep/search/read', { ...indexed, result: { ...indexed.result, indexStats: { ...indexed.result.indexStats, candidates: '2' } } }), AppServerProtocolDecodeError);
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

test('directory responses validate every entry while accepting unspecified fields', () => {
	const response = {
		jsonrpc: '2.0', id: 12,
		result: { entries: [{ name: 'one.txt', fileType: 'file', extensionData: true }, { name: 'two', fileType: 'directory' }] },
	};
	assert.deepEqual(decodeAppServerResponse('fs/readDirectory', response), response);
	assert.throws(() => decodeAppServerResponse('fs/readDirectory', {
		...response,
		result: { entries: [response.result.entries[0], { name: 'broken', fileType: 'invalid' }] },
	}), AppServerProtocolDecodeError);
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
		params: { threadId: 'thread-1', targetId: 'target-1' },
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
	assert.throws(
		() => decodeAppServerServerRequest({ ...request, params: { targetId: 'target-1' } }),
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

test('trace configuration patches preserve explicit disable and reject malformed intent', () => {
	const params = { commandId: 'trace', expectedRevision: 4, trace: { enabled: true, directory: '/recordings' } };
	assert.deepEqual(decodeAppServerRequestParams('config/update', params), params);
	const reset = { ...params, trace: null };
	assert.deepEqual(decodeAppServerRequestParams('config/update', reset), reset);
	assert.throws(() => decodeAppServerRequestParams('config/update', { ...params, trace: { enabled: 'true', directory: '/recordings' } }), AppServerProtocolDecodeError);
	assert.throws(() => decodeAppServerRequestParams('config/update', { ...params, trace: { ...params.trace, upload: true } }), AppServerProtocolDecodeError);
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

test('Git repository invalidation and tag references cross the generated protocol boundary', () => {
	const notification = { jsonrpc: '2.0', method: 'git/repositoriesChanged', params: {} };
	assert.deepEqual(decodeAppServerNotification(notification), notification);
	const result = { commits: [], references: [{ name: 'reviewed', objectId: 'commit', kind: 'tag', remoteName: null, current: false }], remotes: [], hasMore: false };
	const response = { jsonrpc: '2.0', id: 1, result };
	assert.deepEqual(decodeAppServerResponse('git/graph', response), response);
});

test('Git command and partial index requests accept reviewed intents and reject malformed commands', () => {
	const command = { repositoryId: 'repo', command: { kind: 'continue', operation: 'cherryPick' } };
	assert.deepEqual(decodeAppServerRequestParams('git/command', command), command);
	assert.throws(() => decodeAppServerRequestParams('git/command', { command: { kind: 'exec', arguments: ['reset', '--hard'] } }), AppServerProtocolDecodeError);
	assert.throws(() => decodeAppServerRequestParams('git/command', { command: { kind: 'continue', operation: 'reset' } }), AppServerProtocolDecodeError);
	const selection = { repositoryId: 'repo', path: 'file.txt', comparison: 'unstaged', expectedOriginal: null, expectedModified: 'new\n', selection: { kind: 'lines', start: 1, end: 2 } };
	assert.deepEqual(decodeAppServerRequestParams('git/indexEdit', selection), selection);
	assert.throws(() => decodeAppServerRequestParams('git/indexEdit', { ...selection, selection: { kind: 'lines', start: 0, end: 2 } }), AppServerProtocolDecodeError);
	assert.throws(() => decodeAppServerRequestParams('git/indexEdit', { ...selection, expectedModified: 'x'.repeat(2097153) }), AppServerProtocolDecodeError);
});
