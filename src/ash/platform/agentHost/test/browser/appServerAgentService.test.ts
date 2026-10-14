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
