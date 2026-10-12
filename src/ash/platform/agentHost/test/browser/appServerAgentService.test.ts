import assert from 'node:assert/strict';
import { test } from 'mocha';
import type { AppServerProtocolClient } from '../../browser/appServerProtocolClient.js';
import { createAppServerAgentThreadService, createAppServerAgentSessionService, createAppServerAgentTurnService } from '../../browser/appServerAgentService.js';

test('message checkpoints and restoration use the existing typed session protocol', async () => {
	const requests: { method: string; params: unknown; }[] = [];
	const connection = {
		async request(definition: { method: string; }, params: unknown): Promise<unknown> {
			requests.push({ method: definition.method, params });
			return definition.method === 'session/thread/checkpoints'
				? {
					checkpoints: [
						{
							itemId: 'git-message',
							turnId: 'turn',
							sourceThreadId: 'source',
							workspace: { type: 'git', sourceDirId: 'dir', repositories: [] }
						},
						{
							itemId: 'no-files',
							turnId: 'turn',
							sourceThreadId: 'source',
							workspace: { type: 'noFiles' }
						},
						{
							itemId: 'unavailable',
							turnId: 'turn',
							sourceThreadId: 'source',
							workspace: { type: 'unavailable', reason: 'No Git snapshot' }
						}
					]
				}
				: { type: 'thread', value: { session: { sessionId: 'session' }, threadId: 'restored' } };
		}
	} as unknown as AppServerProtocolClient;
	const api = createAppServerAgentThreadService(connection);
	assert.deepEqual(await api.checkpoints({ sessionId: 'session', threadId: 'source' }), [
		{ itemId: 'git-message', turnId: 'turn', sourceThreadId: 'source', files: 'git' },
		{ itemId: 'no-files', turnId: 'turn', sourceThreadId: 'source', files: 'noFiles' },
		{
			itemId: 'unavailable',
			turnId: 'turn',
			sourceThreadId: 'source',
			files: 'unavailable',
			unavailableReason: 'No Git snapshot'
		}
	]);
	const result = await api.restoreMessage({
		sessionId: 'session',
		threadId: 'source',
		itemId: 'message',
		boundary: 'before',
		title: 'Restored',
		commandId: 'restore-command'
	});
	assert.equal(result.threadId, 'restored');
	assert.deepEqual(requests, [
		{ method: 'session/thread/checkpoints', params: { sessionId: 'session', threadId: 'source' } },
		{
			method: 'session/request',
			params: {
				sessionId: 'session',
				commandId: 'restore-command',
				request: {
					type: 'restoreMessage',
					threadId: 'source',
					itemId: 'message',
					boundary: 'before',
					title: 'Restored'
				}
			}
		}
	]);
});


test('Session catalog and subscriptions share the Agent domain snapshot boundary', async () => {
	const session = {
		sessionId: 'session', title: 'Task', status: 'active' as const,
		executionTarget: { type: 'local' as const, root: '/workspace' },
		model: { provider: 'openai', model: 'test' },
		manager: { status: 'working' as const, statusChangedAtUnixMs: 4 }, threads: [],
	};
	const requests: string[] = [];
	const service = createAppServerAgentSessionService({
		async request(definition: { method: string; }): Promise<unknown> {
			requests.push(definition.method);
			if (definition.method === 'session/list' || definition.method === 'session/catalog/subscribe') return { sessions: [session] };
			return { session, agentTree: { roots: [] }, threadProjections: [] };
		},
	} as unknown as AppServerProtocolClient);
	const read = await service.read({ sessionId: 'session' });
	assert.deepEqual(read, { session, agentTree: { roots: [] } });
	assert.notEqual(read.session, session);
	assert.notEqual(read.session.manager, session.manager);
	assert.notEqual(read.session.model, session.model);
	assert.deepEqual(await service.list(), { sessions: [read.session] });
	assert.deepEqual(await service.subscribeCatalog(), { sessions: [read.session] });
	assert.deepEqual(await service.subscribe({ sessionId: 'session' }), { ...read, threadSnapshots: [] });
	assert.deepEqual(requests, ['session/read', 'session/list', 'session/catalog/subscribe', 'session/subscribe']);
});

test('Turn interruption keeps the Session, Thread and accepted sequence on the existing request', async () => {
	const requests: { method: string; params: unknown; }[] = [];
	const service = createAppServerAgentTurnService({
		async request(definition: { method: string; }, params: unknown): Promise<unknown> {
			requests.push({ method: definition.method, params });
			return { type: 'turnInterrupt', value: { sequence: 8 } };
		},
	} as unknown as AppServerProtocolClient);
	assert.deepEqual(await service.interrupt({ commandId: 'interrupt', sessionId: 'session', threadId: 'thread', turnId: 'turn', expectedSequence: 7 }), { sequence: 8 });
	assert.deepEqual(requests, [{
		method: 'session/request', params: {
			commandId: 'interrupt', sessionId: 'session',
			request: { type: 'interruptTurn', threadId: 'thread', turnId: 'turn', expectedSequence: 7 },
		},
	}]);
});

test('Thread context inspection keeps its scope and converts usage at the Agent boundary', async () => {
	const requests: unknown[] = [];
	const context = { estimatedTokens: 123, categories: [{ category: 'conversation', tokens: 123, sources: [] }], model: { provider: 'test', model: 'test' }, allocation: null, latestRequest: null };
	const service = createAppServerAgentThreadService({
		async request(definition: { method: string; }, params: unknown): Promise<unknown> {
			requests.push({ method: definition.method, params });
			return { context, toolDefinitions: [] };
		},
	} as unknown as AppServerProtocolClient);
	assert.deepEqual(await service.readContext({ sessionId: 'session-a', threadId: 'thread-b' }), {
		context: {
			estimatedTokens: 123, categories: [{ category: 'conversation', tokens: 123 }], model: context.model, allocation: null, latestRequest: null,
		}
	});
	assert.deepEqual(requests, [{ method: 'context/read', params: { scope: { type: 'thread', sessionId: 'session-a', threadId: 'thread-b' }, detail: 'usage' } }]);
});
