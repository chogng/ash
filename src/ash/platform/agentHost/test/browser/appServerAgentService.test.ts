import { createHash } from 'node:crypto';
import { Emitter } from '../../../../base/common/event.js';
import type { ServerNotification, ToolOutputArtifact } from '../../../../../../.build/protocol/typescript/index.js';
import type { ThreadTranscriptUpdateEnvelope } from '../../common/agentService.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { AppServerRemoteError } from '../../common/appServerError.js';
import { AgentThreadHistoryConflictError } from '../../common/agentService.js';
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
		assert.equal(requests.filter(request => request.method === 'resource/read').length, mode === 'abort' ? 0 : 1);
	}
});

test('Agent linked resource reads use canonical coordinates and cancel the original operation before releasing late handles', async () => {
	for (const mode of ['read', 'abort', 'replace'] as const) {
		const requests: { method: string; params: unknown; }[] = [];
		const controller = new AbortController();
		const bytes = Buffer.from('# Original\r\n中文\r\n');
		let generation = 1;
		const service = createAppServerAgentThreadService({
			get generation() { return generation; },
			async request(definition: { method: string; }, params: unknown) {
				requests.push({ method: definition.method, params });
				switch (definition.method) {
					case 'tool/resource/open': {
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
		const result = service.readToolResource(source, controller.signal);
		if (mode === 'read') assert.deepEqual(await result, { bytes: new Uint8Array(bytes), mimeType: 'text/markdown' });
		else await assert.rejects(result);
		assert.equal(requests[0].method, 'tool/resource/open');
		assert.deepEqual(Object.keys(requests[0].params as object).sort(), ['contentIndex', 'itemId', 'operationId', 'sessionId', 'threadId']);
		assert.equal(requests.filter(request => request.method === 'resource/release').length, mode === 'replace' ? 0 : 1);
		const cancellations = requests.filter(request => request.method === 'tool/resource/cancel');
		assert.equal(cancellations.length, mode === 'abort' ? 1 : 0);
		if (mode === 'abort') assert.deepEqual(cancellations[0].params, { sessionId: source.sessionId, threadId: source.threadId, operationId: (requests[0].params as { operationId: string; }).operationId });
	}
});
