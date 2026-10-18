import { createHash } from 'node:crypto';
import { Emitter } from '../../../../base/common/event.js';
import type { ServerNotification, SessionThreadReadResult, ToolOutputArtifact } from '../../../../../../.build/protocol/typescript/index.js';
import type { ThreadTranscriptUpdateEnvelope } from '../../common/agent.js';
import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { DeferredPromise } from '../../../../base/common/async.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import type { AppServerConnectionState } from '../../common/appServerApi.js';
import { AppServerRemoteError } from '../../common/appServerError.js';
import { AgentThreadHistoryConflictError } from '../../common/agentService.js';
import type { AppServerProtocolClient } from '../../browser/appServerProtocolClient.js';
import { createAppServerAgentThreadService, createAppServerAgentSessionService, createAppServerAgentTurnService } from '../../browser/appServerAgentService.js';

suite('Session runtime connection ownership', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	for (const replacement of [false, true]) {
		for (const abort of [false, true]) {
			test(`retires a runtime result after ${replacement ? 'replacement' : 'close'} with cancellation ${abort}`, async () => {
				using changed = new Emitter<AppServerConnectionState>();
				const response = new DeferredPromise<unknown>();
				const methods: string[] = [];
				const connection = {
					generation: 1,
					state: 'ready' as AppServerConnectionState,
					capabilities: { contracts: { sessionRuntimes: { version: 1 } } },
					onStateChange: changed.event,
					request: (definition: { method: string; }) => {
						methods.push(definition.method);
						return methods.length === 1 ? response.p : Promise.resolve({});
					},
				};
				const api = createAppServerAgentSessionService(connection as unknown as AppServerProtocolClient);
				const controller = new AbortController();
				const pending = api.invokeRuntime!('ash.dev-containers', { operation: 'list' }, controller.signal);
				const rejected = assert.rejects(pending, isCancellationError);
				if (replacement) connection.generation++;
				else connection.state = 'stopped';
				changed.fire(connection.state);
				if (abort) controller.abort();
				await response.complete({ type: 'targets', targets: [] });
				await rejected;
				assert.deepEqual(methods, ['session/runtime/invoke']);
				assert.equal(changed.hasListeners(), false);
			});
		}
	}

	test('cancelling the live runtime operation preserves its exact operation identity', async () => {
		using changed = new Emitter<AppServerConnectionState>();
		const response = new DeferredPromise<unknown>();
		const requests: { method: string; params: unknown; }[] = [];
		const connection = {
			generation: 1,
			state: 'ready',
			capabilities: { contracts: { sessionRuntimes: { version: 1 } } },
			onStateChange: changed.event,
			request: (definition: { method: string; }, params: unknown) => {
				requests.push({ method: definition.method, params });
				return requests.length === 1 ? response.p : Promise.resolve({});
			},
		};
		const api = createAppServerAgentSessionService(connection as unknown as AppServerProtocolClient);
		const controller = new AbortController();
		const pending = api.invokeRuntime!('ash.dev-containers', { operation: 'list' }, controller.signal);
		const rejected = assert.rejects(pending, isCancellationError);
		controller.abort();
		await response.complete({ type: 'targets', targets: [] });
		await rejected;
		const operationId = (requests[0].params as { operationId: string; }).operationId;
		assert.deepEqual(requests, [
			{ method: 'session/runtime/invoke', params: { operationId, providerId: 'ash.dev-containers', request: { operation: 'list' } } },
			{ method: 'session/runtime/cancel', params: { operationId } },
		]);
		assert.equal(changed.hasListeners(), false);
	});
});

test('Session debug logs verify routed resources and release every handle on completion, abort and corruption', async () => {
	for (const mode of ['read', 'abort', 'replace', 'corrupt', 'overBudget'] as const) {
		const controller = new AbortController();
		const bytes = Buffer.from('remote process log\n');
		let generation = 1;
		const calls: { method: string; params: { sessionId: string; resourceId?: string; }; }[] = [];
		const files = Array.from({ length: mode === 'overBudget' ? 5 : 2 }, (_, index) => `gateway-resource:7:log-${index}`).map(resourceId => ({
			name: 'app-server.log', truncated: false,
			resource: { resourceId, mimeType: 'text/plain', size: mode === 'overBudget' ? 16 * 1024 * 1024 : bytes.length, sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}` },
		}));
		const service = createAppServerAgentSessionService({
			get generation() { return generation; },
			async request(definition: { method: string; }, params: typeof calls[number]['params']) {
				calls.push({ method: definition.method, params });
				if (definition.method === 'session/debugLogs/collect') {
					if (mode === 'abort') controller.abort();
					if (mode === 'replace') generation++;
					return { files, omittedFiles: 0 };
				}
				if (definition.method === 'resource/read') {
					const content = mode === 'corrupt' ? Buffer.from('wrong process log!\n') : bytes;
					return { resourceId: params.resourceId, offset: 0, decodedLength: content.length, dataBase64: content.toString('base64'), eof: true };
				}
				if (definition.method === 'resource/release') return null;
				throw new Error('Unexpected debug log request');
			},
		} as unknown as AppServerProtocolClient);
		const operation = service.collectDebugLogs({ sessionId: 'remote-session' }, controller.signal);
		if (mode === 'read') {
			const result = await operation;
			assert.deepEqual(result.files.map(file => file.bytes), [new Uint8Array(bytes), new Uint8Array(bytes)]);
		} else if (mode === 'overBudget') await assert.rejects(operation, /collection byte limit/);
		else await assert.rejects(operation);
		assert(calls.every(call => call.params.sessionId === 'remote-session'));
		assert.equal(calls.filter(call => call.method === 'resource/read').length, mode === 'read' ? 2 : mode === 'corrupt' ? 1 : 0);
		assert.deepEqual(calls.filter(call => call.method === 'resource/release').map(call => call.params.resourceId).sort(), mode === 'replace' ? [] : files.map(file => file.resource.resourceId).sort());
	}
});

test('Thread history windows reach read and subscribe and retain detached pagination boundaries', async () => {
	const requests: unknown[] = [];
	const usage = { modelInvocations: 0, inputTokens: { reported: 0, complete: true }, outputTokens: { reported: 0, complete: true }, cachedInputTokens: { reported: 0, complete: true }, cacheWriteInputTokens: { reported: 0, complete: true }, reasoningTokens: { reported: 0, complete: true } };
	const items = [
		{ type: 'userContext' as const, clientId: 'original', itemId: 'context', turnId: 'turn', name: 'File', content: 'original context' },
		{ type: 'userMessage' as const, clientId: 'original', itemId: 'message', turnId: 'turn', text: 'Original' },
		{ type: 'userImage' as const, clientId: 'steering', itemId: 'image', turnId: 'turn', url: 'https://example.test/image.png' },
	];
	const boundary = { hasOlderTurns: true, oldestTurnId: 'turn-21' };
	const service = createAppServerAgentThreadService({
		async request(definition: { method: string; }, params: unknown): Promise<unknown> {
			requests.push({ method: definition.method, params });
			return {
				thread: { sessionId: 'session', threadId: 'thread', agentId: 'agent', origin: { type: 'root' }, title: 'History', status: 'active', sequence: 80, advisor: { type: 'off' }, usage, referenceCost: { knownAmounts: [], complete: true }, turns: [{ turnId: 'turn', status: 'running', kind: 'coding', mode: 'agent', approvalMode: 'manual', usage, items }], hookRuns: [] },
				transcript: { sessionId: 'session', threadId: 'thread', durableSequence: 80, revision: 9, entries: [] },
				history: boundary, updates: [],
			};
		},
	} as unknown as AppServerProtocolClient);
	const latest = { sessionId: 'session', threadId: 'thread', history: { type: 'latest' as const, turnLimit: 20 } };
	const before = { sessionId: 'session', threadId: 'thread', history: { type: 'before' as const, turnId: 'turn-21', turnLimit: 20 } };
	const read = await service.read(before);
	const subscription = await service.subscribe({ ...latest, afterSequence: 78 });
	assert.deepEqual(requests, [{ method: 'session/thread/read', params: before }, { method: 'session/thread/subscribe', params: { ...latest, afterSequence: 78 } }]);
	assert.deepEqual(read.history, boundary);
	assert.deepEqual(subscription.history, boundary);
	boundary.oldestTurnId = 'mutated';
	assert.equal(read.history?.oldestTurnId, 'turn-21');
	assert.equal(subscription.history?.oldestTurnId, 'turn-21');
	assert.equal(subscription.transcript.revision, 9);
	assert.deepEqual(read.thread.turns[0]!.items, items);
	assert.deepEqual(subscription.thread.turns[0]!.items, items);
});

function messageSnapshot(text: string, sequence = 1): SessionThreadReadResult {
	const total = { reported: 0, complete: true };
	const usage = { modelInvocations: 0, inputTokens: total, outputTokens: total, cachedInputTokens: total, cacheWriteInputTokens: total, reasoningTokens: total };
	const item = { type: 'agentMessage' as const, itemId: 'answer', turnId: 'turn', text, phase: 'final_answer' as const };
	return {
		thread: { sessionId: 'session', threadId: 'thread', agentId: 'agent', origin: { type: 'root' }, title: 'Body reuse', status: 'active', sequence, advisor: { type: 'off' }, usage, referenceCost: { knownAmounts: [], complete: true }, hookRuns: [], turns: [{ turnId: 'turn', status: 'completed', kind: 'coding', mode: 'agent', toolMode: 'direct', approvalMode: 'manual', usage, items: [item] }] },
		transcript: { sessionId: 'session', threadId: 'thread', durableSequence: sequence, revision: sequence, entries: [{ type: 'item', entryId: 'item:answer', turnId: 'turn', item: { ...item }, transient: false }] },
	};
}

for (const operation of ['read', 'subscribe', 'sessionSubscribe'] as const) test(`Thread ${operation} retains detached Item shells when immutable body values agree`, async () => {
	const wire = messageSnapshot('Original body'.repeat(1024));
	const expected = structuredClone(wire);
	const connection = {
		async request(): Promise<unknown> {
			const value = { ...wire, updates: [] };
			return operation === 'sessionSubscribe'
				? { session: { sessionId: 'session', title: 'Body reuse', status: 'active', manager: {}, threads: [] }, agentTree: { roots: [] }, threadProjections: [value] }
				: value;
		},
	} as unknown as AppServerProtocolClient;
	const api = createAppServerAgentThreadService(connection);
	const params = { sessionId: 'session', threadId: 'thread' };
	const result = operation === 'read' ? await api.read(params) : operation === 'subscribe' ? await api.subscribe({ ...params, afterSequence: 0 }) : (await createAppServerAgentSessionService(connection).subscribe({ sessionId: 'session' })).threadSnapshots[0];
	const canonical = result.thread.turns[0].items[0];
	const entry = result.transcript.entries[0];
	const expectedItem = expected.thread.turns[0].items[0];
	const wireItem = wire.thread.turns[0].items[0];
	const wireEntry = wire.transcript.entries[0];
	assert.ok(canonical.type === 'agentMessage' && entry.type === 'item' && entry.item.type === 'agentMessage');
	assert.ok(expectedItem.type === 'agentMessage' && wireItem.type === 'agentMessage' && wireEntry.type === 'item' && wireEntry.item.type === 'agentMessage');
	assert.equal(canonical.text, expectedItem.text);
	assert.deepEqual(entry, expected.transcript.entries[0]);
	assert.notEqual(entry.item, canonical);
	assert.notEqual(entry.item, wireEntry.item);
	assert.notEqual(canonical, wireItem);
	wireItem.text = 'Retired transport body';
	wireEntry.item.phase = 'commentary';
	wireEntry.item.text = 'Changed transport transcript';
	assert.equal(canonical.text, entry.item.text);
	assert.equal(entry.item.phase, 'final_answer');
});

test('Thread snapshot conversion preserves independently versioned, transient and differently scoped bodies', async () => {
	for (const mismatch of ['session', 'thread', 'sequence', 'turn', 'item', 'type', 'transient', 'text'] as const) {
		const wire = messageSnapshot('Committed body');
		const entry = wire.transcript.entries[0];
		assert.ok(entry.type === 'item' && entry.item.type === 'agentMessage');
		if (mismatch === 'session') wire.transcript.sessionId = 'another-session';
		if (mismatch === 'thread') wire.transcript.threadId = 'another-thread';
		if (mismatch === 'sequence') wire.transcript.durableSequence++;
		if (mismatch === 'turn') { entry.turnId = 'another-turn'; entry.item.turnId = 'another-turn'; }
		if (mismatch === 'item') entry.item.itemId = 'another-answer';
		if (mismatch === 'type') entry.item = { type: 'plan', itemId: 'answer', turnId: 'turn', text: 'Independent plan' };
		if (mismatch === 'transient') { entry.transient = true; entry.item.text = 'Streaming body'; }
		if (mismatch === 'text') entry.item.text = 'Newer transcript body';
		const expected = structuredClone(wire.transcript);
		const api = createAppServerAgentThreadService({ request: async () => wire } as unknown as AppServerProtocolClient);
		const result = await api.read({ sessionId: 'session', threadId: 'thread' });
		assert.deepEqual(result.transcript, expected, mismatch);
		assert.deepEqual(result.thread.turns[0].items, wire.thread.turns[0].items, mismatch);
	}
});

test('Thread reads and streaming notifications retain their own revisions without a body cache', async () => {
	using notifications = new Emitter<ServerNotification>();
	let wire = messageSnapshot('Version one');
	const api = createAppServerAgentThreadService({ request: async () => wire, onNotification: notifications.event } as unknown as AppServerProtocolClient);
	const updates: ThreadTranscriptUpdateEnvelope[] = [];
	using subscription = api.onDidUpdateThreadTranscript(update => updates.push(update));
	const first = await api.read({ sessionId: 'session', threadId: 'thread' });
	const secondWire = messageSnapshot('Version two', 2);
	wire = secondWire;
	const second = await api.read({ sessionId: 'session', threadId: 'thread' });
	const streaming = { type: 'item' as const, entryId: 'item:answer', turnId: 'turn', item: { type: 'agentMessage' as const, itemId: 'answer', turnId: 'turn', text: 'Version two with live suffix' }, transient: true };
	notifications.fire({ method: 'session/thread/transcript/update', params: { sessionId: 'session', threadId: 'thread', durableSequence: 2, revision: 3, changes: [{ type: 'upsert', entry: streaming }] } });
	assert.deepEqual(updates[0].changes, [{ type: 'upsert', entry: streaming }]);
	streaming.item.text = 'Retired notification';
	const live = updates[0].changes[0];
	assert.ok(live.type === 'upsert' && live.entry.type === 'item' && live.entry.item.type === 'agentMessage');
	assert.equal(live.entry.item.text, 'Version two with live suffix');
	const firstEntry = first.transcript.entries[0], secondEntry = second.transcript.entries[0];
	assert.ok(firstEntry.type === 'item' && firstEntry.item.type === 'agentMessage' && secondEntry.type === 'item' && secondEntry.item.type === 'agentMessage');
	assert.equal(firstEntry.item.text, 'Version one');
	assert.equal(secondEntry.item.text, 'Version two');
	assert.equal(first.transcript.revision, 1);
	assert.equal(second.transcript.revision, 2);
});

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
							itemId: 'directory-message',
							turnId: 'turn',
							sourceThreadId: 'source',
							workspace: { type: 'directory', sourceDirId: 'dir', digest: 'sha256:' + 'a'.repeat(64) }
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
		{ itemId: 'directory-message', turnId: 'turn', sourceThreadId: 'source', files: 'directory' },
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

test('SSH-bound Session requests use server-local paths and retain host identity on every snapshot', async () => {
	const root = "C:/workspace 中文/O'Brien";
	const local = { type: 'local' as const, root };
	const remote = { type: 'ssh' as const, host: 'windows-dev', root };
	const session = { sessionId: 'session', title: 'Remote task', status: 'active' as const, executionTarget: local, manager: { status: 'idle' as const, statusChangedAtUnixMs: 0 }, threads: [] };
	const requests: { method: string; params: unknown; }[] = [];
	const connection = {
		async request(definition: { method: string; }, params: unknown): Promise<unknown> {
			requests.push({ method: definition.method, params });
			if (definition.method === 'session/list' || definition.method === 'session/catalog/subscribe') return { sessions: [session] };
			const value = { session, agentTree: { roots: [] }, threadProjections: [] };
			if (definition.method === 'session/request') return { type: 'session', value };
			return value;
		},
	} as unknown as AppServerProtocolClient;
	const service = createAppServerAgentSessionService(connection, remote.host);
	const params = { commandId: 'create', title: 'Remote task', executionTarget: remote, agent: { type: 'default' as const } };
	assert.deepEqual((await service.create(params)).session.executionTarget, remote);
	assert.deepEqual(requests[0], { method: 'session/create', params: { ...params, executionTarget: local } });
	assert.deepEqual(params.executionTarget, remote);
	assert.deepEqual(session.executionTarget, local);
	assert.deepEqual((await service.read({ sessionId: 'session' })).session.executionTarget, remote);
	assert.deepEqual((await service.readCatalog({ sessionId: 'session' })).session?.executionTarget, remote);
	assert.deepEqual((await service.list()).sessions[0]?.executionTarget, remote);
	assert.deepEqual((await service.subscribeCatalog()).sessions[0]?.executionTarget, remote);
	assert.deepEqual((await service.subscribe({ sessionId: 'session' })).session.executionTarget, remote);
	for (const operation of ['archive', 'restore', 'stop'] as const) {
		assert.deepEqual((await service[operation]({ sessionId: 'session', commandId: operation })).session.executionTarget, remote);
	}
	// Another authority must remain explicit so the server can reject or route it.
	await service.create({ ...params, executionTarget: { ...remote, host: 'other-host' } });
	assert.deepEqual(requests.at(-1)?.params, { ...params, executionTarget: { ...remote, host: 'other-host' } });
	await service.create({ ...params, executionTarget: null });
	assert.deepEqual(requests.at(-1)?.params, { ...params, executionTarget: null });
	assert.deepEqual((await createAppServerAgentSessionService(connection).read({ sessionId: 'session' })).session.executionTarget, local);
});

test('SSH-bound Thread reads and subscriptions qualify remote directory paths', async () => {
	const directory = { type: 'local' as const, root: 'C:/workspace' };
	const thread = { origin: { type: 'root' }, usage: {}, turns: [] };
	const snapshot = { thread, directory, transcript: { entries: [] }, updates: [] };
	const session = { sessionId: 'session', title: 'Remote', status: 'active', manager: {}, threads: [] };
	const connection = {
		async request(definition: { method: string; }): Promise<unknown> {
			return definition.method === 'session/subscribe' ? { session, agentTree: { roots: [] }, threadProjections: [snapshot] } : snapshot;
		},
	} as unknown as AppServerProtocolClient;
	const expected = { type: 'ssh', host: 'windows-dev', root: directory.root };
	const service = createAppServerAgentThreadService(connection, 'windows-dev');
	const params = { sessionId: 'session', threadId: 'thread' };
	assert.deepEqual((await service.read(params)).directory, expected);
	assert.deepEqual((await service.subscribe({ ...params, afterSequence: 0 })).directory, expected);
	assert.deepEqual((await createAppServerAgentSessionService(connection, 'windows-dev').subscribe({ sessionId: 'session' })).threadSnapshots[0]?.directory, expected);
	assert.deepEqual((await createAppServerAgentThreadService(connection).read(params)).directory, directory);
	assert.deepEqual(directory, { type: 'local', root: 'C:/workspace' });
});

test('Session restoration uses the existing typed lifecycle request', async () => {
	const session = { sessionId: 'session', title: 'Restored', status: 'active' as const, manager: { status: 'idle' as const, statusChangedAtUnixMs: 0 }, threads: [{ threadId: 'session', title: 'Root', status: 'active' as const }] };
	const requests: { method: string; params: unknown; }[] = [];
	const api = createAppServerAgentSessionService({
		async request(definition: { method: string; }, params: unknown): Promise<unknown> {
			requests.push({ method: definition.method, params });
			return { type: 'session', value: { session, agentTree: { roots: [] } } };
		},
	} as unknown as AppServerProtocolClient);
	const restored = await api.restore({ sessionId: 'session', commandId: 'restore-session' });
	assert.deepEqual({ requests, restored }, { requests: [{ method: 'session/request', params: { sessionId: 'session', commandId: 'restore-session', request: { type: 'restore' } } }], restored: { session: { ...session, executionTarget: undefined, model: undefined, threads: [{ ...session.threads[0]!, forkedFromId: undefined, manager: undefined, parentThreadId: undefined }] }, agentTree: { roots: [] } } });
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

test('history actions use the same Thread and exact sequence and map structured file conflicts', async () => {
	const requests: unknown[] = [];
	let conflict = false;
	const service = createAppServerAgentThreadService({
		async request(definition: { method: string; }, params: unknown): Promise<unknown> {
			requests.push({ method: definition.method, params });
			if (conflict) throw new AppServerRemoteError(-32010, 'localized backend diagnostic', { kind: 'ThreadHistoryConflict' });
			if (definition.method === 'session/thread/history') return { sequence: 17, canUndo: true, canRedo: false };
			return { type: 'thread', value: { session: { sessionId: 'session' }, threadId: 'thread' } };
		},
	} as unknown as AppServerProtocolClient);
	assert.deepEqual(await service.readHistoryState({ sessionId: 'session', threadId: 'thread' }), { sequence: 17, canUndo: true, canRedo: false });
	const options = { sessionId: 'session', threadId: 'thread', commandId: 'undo', direction: 'undo' as const, expectedSequence: 17 };
	await service.moveHistory(options);
	assert.deepEqual(requests[1], {
		method: 'session/request', params: {
			sessionId: 'session', commandId: 'undo',
			request: { type: 'moveThreadHistory', threadId: 'thread', direction: 'undo', expectedSequence: 17 },
		},
	});
	conflict = true;
	await assert.rejects(service.moveHistory({ ...options, commandId: 'redo', direction: 'redo' }), AgentThreadHistoryConflictError);
	await assert.rejects(service.readHistoryState({ sessionId: 'session', threadId: 'thread' }), AgentThreadHistoryConflictError);
});


test('Agent Thread notifications detach tool provenance and rich results from transport values', () => {
	const binding = {
		registryGeneration: 3, definitionDigest: 'digest', sourceChain: [{ type: 'mcp' as const, serverId: 'remote', remoteName: 'shell', catalogGeneration: 4, connectionGeneration: 5 }],
		activity: { type: 'command' as const, program: 'echo', arguments: ['hello'], workingDirectory: '/remote' },
		caller: { type: 'codeMode' as const, parentToolCallId: 'parent', cellId: 'cell', runtimeCallId: 'runtime' },
	};
	const attachment = { contentDigest: 'digest', mediaType: 'png' as const, encodedBytes: 42, width: 4, height: 5 };
	const entries = [
		{ type: 'item' as const, entryId: 'call', turnId: 'turn', transient: false, item: { type: 'toolCall' as const, itemId: 'call', turnId: 'turn', toolCallId: 'tool', name: 'shell', argumentsJson: '{}', binding } },
		{ type: 'item' as const, entryId: 'result', turnId: 'turn', transient: false, item: { type: 'toolResult' as const, itemId: 'result', turnId: 'turn', toolCallId: 'tool', text: '', isError: false, content: [{ type: 'imageAttachment' as const, detail: 'high' as const, attachment }, { type: 'text' as const, text: 'result' }] } },
	];
	using notifications = new Emitter<ServerNotification>();
	const service = createAppServerAgentThreadService({ onNotification: listener => notifications.event(listener) } as AppServerProtocolClient);
	let converted: ThreadTranscriptUpdateEnvelope | undefined;
	using subscription = service.onDidUpdateThreadTranscript(update => { converted = update; });
	notifications.fire({ method: 'session/thread/transcript/update', params: { sessionId: 'session', threadId: 'thread', revision: 3, durableSequence: 2, changes: entries.map(entry => ({ type: 'upsert' as const, entry })) } });
	assert.ok(converted);
	assert.deepEqual(converted.changes, entries.map(entry => ({ type: 'upsert', entry })));
	binding.activity.arguments.push('changed');
	binding.sourceChain[0].serverId = 'changed';
	binding.caller.parentToolCallId = 'changed';
	attachment.width = 100;
	assert.notDeepEqual(converted.changes, entries.map(entry => ({ type: 'upsert', entry })));
	const call = converted.changes[0];
	assert.ok(call.type === 'upsert' && call.entry.type === 'item' && call.entry.item.type === 'toolCall');
	assert.equal(call.entry.item.binding!.sourceChain[0].type, 'mcp');
	assert.ok(call.entry.item.binding!.activity?.type === 'command');
	assert.deepEqual(call.entry.item.binding.activity.arguments, ['hello']);
	assert.deepEqual(call.entry.item.binding.caller, { type: 'codeMode', parentToolCallId: 'parent', cellId: 'cell', runtimeCallId: 'runtime' });
	const result = converted.changes[1];
	assert.ok(result.type === 'upsert' && result.entry.type === 'item' && result.entry.item.type === 'toolResult');
	assert.deepEqual(result.entry.item.content, [{ type: 'imageAttachment', detail: 'high', attachment: { contentDigest: 'digest', mediaType: 'png', encodedBytes: 42, width: 4, height: 5 } }, { type: 'text', text: 'result' }]);
});


test('Agent artifact notifications preserve exact payloads and detach binary bytes and source metadata', () => {
	const source = { type: 'embeddedResource' as const, uri: 'file:///resource/data' };
	const text = { type: 'text' as const, text: '<script>untrusted()</script>中文' };
	const binary = { type: 'binary' as const, bytes: [0, 127, 255] };
	const json = { type: 'json' as const, json: ' {\n  "text": "中文", "markup": "<svg/>"\n}\n' };
	const artifacts: ToolOutputArtifact[] = [
		{ source, mimeType: 'text/html', data: text, contentDigest: 'sha256:' + 'a'.repeat(64), truncated: false },
		{ source, mimeType: 'application/octet-stream', data: binary, contentDigest: 'sha256:' + 'b'.repeat(64), truncated: false },
		{ source: { type: 'structuredResult' }, mimeType: 'application/json', data: json, contentDigest: 'sha256:' + 'c'.repeat(64), truncated: true },
	];
	using notifications = new Emitter<ServerNotification>();
	const service = createAppServerAgentThreadService({ onNotification: listener => notifications.event(listener) } as AppServerProtocolClient);
	let converted: ThreadTranscriptUpdateEnvelope | undefined;
	using subscription = service.onDidUpdateThreadTranscript(update => { converted = update; });
	notifications.fire({
		method: 'session/thread/transcript/update', params: {
			sessionId: 'session', threadId: 'thread', revision: 1, durableSequence: 1,
			changes: [{
				type: 'upsert', entry: {
					type: 'item', entryId: 'result', turnId: 'turn', transient: false, item: {
						type: 'toolResult', itemId: 'result', turnId: 'turn', toolCallId: 'tool', text: '', isError: false,
						content: artifacts.map(artifact => ({ type: 'artifact', artifact })),
					}
				}
			}],
		}
	});
	assert.ok(converted);
	const change = converted.changes[0];
	assert.ok(change.type === 'upsert' && change.entry.type === 'item' && change.entry.item.type === 'toolResult');
	const content = change.entry.item.content;
	assert.deepEqual(content, [
		{ type: 'artifact', artifact: { ...artifacts[0], source: { ...source }, data: { ...text } } },
		{ type: 'artifact', artifact: { ...artifacts[1], source: { ...source }, data: { type: 'bytes', bytes: new Uint8Array([0, 127, 255]) } } },
		{ type: 'artifact', artifact: { ...artifacts[2], source: { type: 'structuredResult' }, data: { ...json } } },
	]);
	const snapshot = structuredClone(content);
	source.uri = 'file:///changed';
	text.text = 'changed';
	binary.bytes[0] = 42;
	binary.bytes.push(64);
	json.json = '{}';
	assert.deepEqual(content, snapshot, 'retained domain content does not alias transport objects');
});

test('Agent tool result conversion retains null, omitted and empty content', () => {
	using notifications = new Emitter<ServerNotification>();
	const service = createAppServerAgentThreadService({ onNotification: listener => notifications.event(listener) } as AppServerProtocolClient);
	const contentValues: unknown[] = [];
	using subscription = service.onDidUpdateThreadTranscript(update => {
		const change = update.changes[0];
		assert.ok(change.type === 'upsert' && change.entry.type === 'item' && change.entry.item.type === 'toolResult');
		contentValues.push(change.entry.item.content);
	});
	for (const content of [undefined, null, []]) notifications.fire({
		method: 'session/thread/transcript/update', params: {
			sessionId: 'session', threadId: 'thread', revision: 1, durableSequence: 1,
			changes: [{
				type: 'upsert', entry: {
					type: 'item', entryId: 'result', turnId: 'turn', transient: false, item: {
						type: 'toolResult', itemId: 'result', turnId: 'turn', toolCallId: 'tool', text: 'result', isError: false, content,
					}
				}
			}],
		}
	});
	assert.deepEqual(contentValues, [undefined, null, []]);
});

test('Agent attachment reads use the exact Item scope, verified resources and cancellation cleanup', async () => {
	for (const mode of ['read', 'abort', 'replace'] as const) {
		const requests: { method: string; params: unknown; }[] = [];
		const controller = new AbortController();
		const bytes = Buffer.from('verified media');
		let generation = 1;
		const service = createAppServerAgentThreadService({
			get generation() { return generation; },
			async request(definition: { method: string; }, params: unknown) {
				requests.push({ method: definition.method, params });
				switch (definition.method) {
					case 'attachment/resource/open': {
						if (mode === 'abort') controller.abort();
						return { resourceId: 'media', size: bytes.length, mimeType: 'image/png', sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}` };
					}
					case 'resource/read': {
						if (mode === 'replace') generation++;
						return { resourceId: 'media', offset: 0, decodedLength: bytes.length, dataBase64: bytes.toString('base64'), eof: true };
					}
					case 'resource/release': return null;
					default: throw new Error('Unexpected request');
				}
			},
		} as AppServerProtocolClient);
		const source = { sessionId: 'session', threadId: 'thread', itemId: 'result', contentIndex: 2 };
		const read = service.readAttachment(source, controller.signal);
		if (mode === 'read') assert.deepEqual(await read, { bytes: new Uint8Array(bytes), mimeType: 'image/png' });
		else await assert.rejects(read);
		assert.deepEqual(requests[0], { method: 'attachment/resource/open', params: source });
		assert.equal(requests.filter(request => request.method === 'resource/release').length, mode === 'replace' ? 0 : 1);
		for (const request of requests.filter(request => request.method === 'resource/read' || request.method === 'resource/release')) assert.equal((request.params as { sessionId: string; }).sessionId, source.sessionId);
		assert.equal(requests.filter(request => request.method === 'resource/read').length, mode === 'abort' ? 0 : 1);
	}
});

test('Agent App calls keep canonical coordinates, detach results and cancel only their original connection operation', async () => {
	for (const mode of ['read', 'abort', 'replace', 'error', 'wrongItem'] as const) {
		const requests: { method: string; params: unknown; options: unknown; }[] = [];
		const controller = new AbortController();
		let generation = 1;
		const item = { type: 'toolResult', itemId: 'result', turnId: 'turn', toolCallId: 'call', text: 'Edited', isError: false, content: [{ type: 'artifact', artifact: { source: { type: 'viewMetadata' }, mimeType: 'application/json', data: { type: 'json', json: '{"viewOnly":8}' }, contentDigest: 'digest', truncated: false } }] };
		const service = createAppServerAgentThreadService({
			get generation() { return generation; },
			async request(definition: { method: string; }, params: unknown, options: unknown) {
				requests.push({ method: definition.method, params, options });
				if (definition.method === 'tool/app/cancel') return null;
				assert.equal(definition.method, 'tool/app/call');
				if (mode === 'abort') controller.abort();
				if (mode === 'replace') generation++;
				if (mode === 'error') throw new Error('Origin retired');
				return { item: mode === 'wrongItem' ? { type: 'agentMessage', itemId: 'message', turnId: 'turn', text: 'wrong', attachments: [] } : item };
			},
		} as unknown as AppServerProtocolClient);
		const source = { sessionId: 'session', threadId: 'thread', itemId: 'origin', contentIndex: 2 };
		const call = service.invokeAppTool(source, 'edit', '{"value":8}', controller.signal);
		if (mode === 'read') {
			const result = await call;
			assert.deepEqual(result, item);
			assert.notEqual(result, item);
			assert.notEqual(result.content, item.content);
		} else await assert.rejects(call);
		const params = requests[0]!.params as Record<string, unknown>;
		assert.deepEqual(params, { ...source, remoteName: 'edit', argumentsJson: '{"value":8}', operationId: params.operationId });
		assert.equal(typeof params.operationId, 'string');
		assert.deepEqual(requests[0]!.options, { timeoutMs: 240_000 });
		const cancelled = requests.filter(request => request.method === 'tool/app/cancel');
		assert.equal(cancelled.length, mode === 'read' || mode === 'replace' ? 0 : 1);
		if (cancelled.length) assert.deepEqual(cancelled[0]!.params, { sessionId: source.sessionId, threadId: source.threadId, operationId: params.operationId });
	}
});

test('Agent linked and App resource reads keep their provider scope and release late handles', async () => {
	for (const selection of ['linked', 'app'] as const) for (const mode of ['read', 'abort', 'replace'] as const) {
		const requests: { method: string; params: unknown; }[] = [];
		const controller = new AbortController();
		const bytes = Buffer.from('# Original\r\n中文\r\n');
		let generation = 1;
		const service = createAppServerAgentThreadService({
			get generation() { return generation; },
			async request(definition: { method: string; }, params: unknown) {
				requests.push({ method: definition.method, params });
				switch (definition.method) {
					case 'tool/resource/open':
					case 'tool/app/resource/open': {
						if (mode === 'abort') controller.abort();
						return { resourceId: 'linked', size: bytes.length, mimeType: 'text/markdown', sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}` };
					}
					case 'tool/resource/cancel': return null;
					case 'resource/read': {
						if (mode === 'replace') generation++;
						return { resourceId: 'linked', offset: 0, decodedLength: bytes.length, dataBase64: bytes.toString('base64'), eof: true };
					}
					case 'resource/release': return null;
					default: throw new Error('Unexpected request');
				}
			},
		} as AppServerProtocolClient);
		const source = { sessionId: 'session', threadId: 'thread', itemId: 'result', contentIndex: 2 };
		const result = selection === 'linked' ? service.readToolResource(source, controller.signal) : service.readAppResource(source, 'file:///server/report.md', controller.signal);
		if (mode === 'read') assert.deepEqual(await result, { bytes: new Uint8Array(bytes), mimeType: 'text/markdown' });
		else await assert.rejects(result);
		assert.equal(requests[0].method, selection === 'linked' ? 'tool/resource/open' : 'tool/app/resource/open');
		assert.deepEqual(Object.keys(requests[0].params as object).sort(), ['contentIndex', 'itemId', 'operationId', 'sessionId', 'threadId', ...(selection === 'app' ? ['uri'] : [])]);
		if (selection === 'app') assert.equal((requests[0].params as { uri: string; }).uri, 'file:///server/report.md');
		assert.equal(requests.filter(request => request.method === 'resource/release').length, mode === 'replace' ? 0 : 1);
		for (const request of requests.filter(request => request.method === 'resource/read' || request.method === 'resource/release')) assert.equal((request.params as { sessionId: string; }).sessionId, source.sessionId);
		const cancellations = requests.filter(request => request.method === 'tool/resource/cancel');
		assert.equal(cancellations.length, mode === 'abort' ? 1 : 0);
		if (mode === 'abort') assert.deepEqual(cancellations[0].params, { sessionId: source.sessionId, threadId: source.threadId, operationId: (requests[0].params as { operationId: string; }).operationId });
	}
});

test('Agent connection events keep thisArgs and release the original protocol listener', () => {
	using states = new Emitter<void>();
	const api = createAppServerAgentThreadService({ onStateChange: (listener: () => void) => states.event(listener) } as unknown as AppServerProtocolClient);
	const scope = { count: 0 };
	const subscription = api.onDidChangeConnection(function (this: typeof scope) { this.count++; }, scope);
	states.fire();
	subscription.dispose();
	states.fire();
	assert.equal(scope.count, 1);
});

test('Agent App document CSP stays outside verified handle metadata and does not alias transport arrays', async () => {
	const bytes = Buffer.from('<p>App</p>');
	const appCsp = { connectDomains: ['https://api.example.com'], resourceDomains: ['https://cdn.example.com'], frameDomains: [], baseUriDomains: [] };
	const methods: string[] = [];
	const service = createAppServerAgentThreadService({
		generation: 1,
		async request(definition: { method: string; }) {
			methods.push(definition.method);
			if (definition.method === 'tool/resource/open') return { resourceId: 'app', mimeType: 'text/html;profile=mcp-app', size: bytes.length, sha256: 'sha256:' + createHash('sha256').update(bytes).digest('hex'), appCsp, encoding: 'text', resourceMetadata: '{"private":"view-only"}' };
			if (definition.method === 'resource/read') return { resourceId: 'app', offset: 0, decodedLength: bytes.length, dataBase64: bytes.toString('base64'), eof: true };
			if (definition.method === 'resource/release') return null;
			throw new Error('Unexpected request');
		},
	} as unknown as AppServerProtocolClient);
	const document = await service.readToolResource({ sessionId: 'session', threadId: 'thread', itemId: 'app', contentIndex: 2 });
	assert.deepEqual(document.appCsp, appCsp);
	assert.deepEqual(document.bytes, new Uint8Array(bytes));
	assert.equal(document.encoding, 'text');
	assert.equal(document.resourceMetadata, '{"private":"view-only"}');
	appCsp.connectDomains.push('https://changed.example.com');
	assert.deepEqual(document.appCsp?.connectDomains, ['https://api.example.com']);
	assert.deepEqual(methods, ['tool/resource/open', 'resource/read', 'resource/release']);
});

test('Agent App catalogs retain original tool contracts and retire with their source connection', async () => {
	for (const mode of ['read', 'abort', 'replace'] as const) {
		const controller = new AbortController();
		let generation = 1;
		const tool = { name: 'edit', inputSchema: { type: 'object', properties: { value: { type: 'number' } } }, outputSchema: { type: 'object' }, annotations: { readOnlyHint: false }, _meta: { ui: { visibility: ['app'] } } };
		let requested: unknown;
		const service = createAppServerAgentThreadService({
			get generation() { return generation; },
			async request(definition: { method: string; }, params: unknown) {
				assert.equal(definition.method, 'tool/app/list'); requested = params;
				if (mode === 'abort') controller.abort();
				if (mode === 'replace') generation++;
				return { tools: [tool] };
			}
		} as unknown as AppServerProtocolClient);
		const source = { sessionId: 'session', threadId: 'thread', itemId: 'result', contentIndex: 2 };
		const listing = service.listAppTools(source, controller.signal);
		if (mode === 'read') {
			const catalog = await listing;
			assert.deepEqual(catalog, [tool]);
			tool._meta.ui.visibility.push('model');
			tool.inputSchema.properties.value.type = 'string';
			assert.deepEqual(catalog[0]!._meta, { ui: { visibility: ['app'] } });
			assert.deepEqual(catalog[0]!.inputSchema, { type: 'object', properties: { value: { type: 'number' } } });
		} else await assert.rejects(listing);
		assert.deepEqual(requested, source);
	}
});


test('naming and deletion preserve request identity and reject responses for another Session', async () => {
	const requests: unknown[] = [];
	let returnedId = 'session';
	const connection = {
		async request(definition: { method: string; }, params: { request: { type: string; }; }): Promise<unknown> {
			requests.push({ method: definition.method, params });
			if (params.request.type === 'delete') return { type: 'deleted', value: returnedId };
			return { type: 'session', value: { session: { sessionId: returnedId, title: '命名', status: 'active', manager: { status: 'idle', statusChangedAtUnixMs: 0 }, threads: [] }, agentTree: { roots: [] } } };
		},
	} as unknown as AppServerProtocolClient;
	const sessions = createAppServerAgentSessionService(connection);
	const threads = createAppServerAgentThreadService(connection);
	await sessions.rename({ sessionId: 'session', commandId: 'session-name', title: '命名' });
	await threads.rename({ sessionId: 'session', threadId: 'branch', commandId: 'thread-name', title: '命名', source: 'manual' });
	await sessions.delete({ sessionId: 'session', commandId: 'delete-session' });
	assert.deepEqual(requests, [
		{ method: 'session/request', params: { sessionId: 'session', commandId: 'session-name', request: { type: 'renameSession', title: '命名' } } },
		{ method: 'session/request', params: { sessionId: 'session', commandId: 'thread-name', request: { type: 'renameThread', threadId: 'branch', title: '命名', source: 'manual' } } },
		{ method: 'session/request', params: { sessionId: 'session', commandId: 'delete-session', request: { type: 'delete' } } },
	]);
	returnedId = 'other-session';
	await assert.rejects(sessions.rename({ sessionId: 'session', commandId: 'wrong-name', title: '命名' }));
	await assert.rejects(threads.rename({ sessionId: 'session', threadId: 'branch', commandId: 'wrong-thread', title: '命名', source: 'automatic' }));
	await assert.rejects(sessions.delete({ sessionId: 'session', commandId: 'wrong-delete' }));
});

test('Fork and edit dispatch existing typed session operations and keep their returned identities', async () => {
	const requests: unknown[] = [];
	let wrongSession = false;
	const service = createAppServerAgentThreadService({
		async request(definition: { method: string; }, params: { request: { type: string; }; }) {
			requests.push({ method: definition.method, params });
			return { type: params.request.type === 'rewriteThread' ? 'rewrite' : 'thread', value: { session: { sessionId: wrongSession ? 'wrong' : params.request.type === 'forkSession' ? 'new-session' : 'source' }, threadId: 'new-thread', turn: { turnId: 'edited-turn', sequence: 1 } } };
		},
	} as unknown as AppServerProtocolClient);
	const base = { sessionId: 'source', threadId: 'original', title: 'New history', commandId: 'command' };
	assert.deepEqual(await service.fork({ ...base, target: 'session' }), { sessionId: 'new-session', threadId: 'new-thread' });
	assert.deepEqual(await service.fork({ ...base, target: 'thread' }), { sessionId: 'source', threadId: 'new-thread' });
	assert.deepEqual(await service.rewrite({ ...base, beforeTurnId: 'old-turn', input: [{ type: 'text', text: 'Edited' }] }), { sessionId: 'source', threadId: 'new-thread' });
	assert.deepEqual(requests, [
		{ method: 'session/request', params: { sessionId: 'source', commandId: 'command', request: { type: 'forkSession', parentThreadId: 'original', title: 'New history' } } },
		{ method: 'session/request', params: { sessionId: 'source', commandId: 'command', request: { type: 'forkThread', parentThreadId: 'original', title: 'New history' } } },
		{ method: 'session/request', params: { sessionId: 'source', commandId: 'command', request: { type: 'rewriteThread', parentThreadId: 'original', beforeTurnId: 'old-turn', title: 'New history', input: [{ type: 'text', text: 'Edited' }] } } },
	]);
	wrongSession = true;
	await assert.rejects(service.fork({ ...base, target: 'thread' }), /different conversation/);
	await assert.rejects(service.rewrite({ ...base, beforeTurnId: 'turn', input: [{ type: 'text', text: 'Edited' }] }), /different conversation/);
});
