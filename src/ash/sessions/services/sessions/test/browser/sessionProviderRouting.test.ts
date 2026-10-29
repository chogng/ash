import { createTestLanguageModelToolsService } from '../../../../../workbench/contrib/chat/test/common/tools/testLanguageModelToolsService.js';
import { ILanguageModelToolsService } from '../../../../../workbench/contrib/chat/common/tools/languageModelToolsService.js';
import { IInstructionService } from '../../../../../platform/instructions/common/instructionService.js';
import { IAgentVoiceService } from '../../../../../platform/agentHost/common/agentService.js';
import { AppServerChatDebugService } from '../../../../../workbench/contrib/chat/browser/chatDebug/appServerChatDebugService.js';
import { diagnosticPayload } from '../../../../../workbench/contrib/chat/common/chatDebugEvents.js';
import { SessionsAgentSessionService } from '../../../../browser/agentHost/sessionsAgentSessionService.js';
import { SessionConversationLinks } from '../../../../browser/agentHost/sessionConversationLinks.js';
import { buildOpenSessionLinkUri, parseOpenSessionLinkUri } from '../../../../../platform/agentHost/common/openSessionLink.js';
import type { ISessionsService } from '../../browser/sessionsService.js';
import { SessionFileSystemContribution } from '../../../../contrib/providers/agentHost/browser/sessionFileSystemContribution.js';
import type { IAgentHostFileSystemService } from '../../../../../workbench/services/agentHost/common/agentHostFileSystemService.js';
import type { ISession } from '../../common/session.js';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { isCancellationError } from '../../../../../base/common/errors.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { IRendererHostService } from '../../../../../platform/renderer/common/rendererHost.js';
import { IAgentExecutionSettingsService } from '../../../../../platform/agentHost/common/agentExecutionSettingsService.js';
import { IChatService, type ThreadRead } from '../../../../../workbench/services/chat/common/chatService.js';
import { ILanguageModelsService } from '../../../../../workbench/contrib/chat/common/languageModels.js';
import { IPromptsService } from '../../../../../workbench/contrib/chat/common/promptSyntax/service/promptsService.js';
import { createDisconnectedRendererApi } from '../../../../../workbench/browser/rendererApi.js';
import { SessionsProvidersService } from '../../browser/sessionsProvidersService.js';
import { SessionProviderServices, SessionProviderScopeService } from '../../../../browser/agentHost/sessionProviderScopeService.js';
import { SessionsChatService } from '../../../../browser/agentHost/sessionsChatService.js';
import { SessionsSearchService } from '../../../../contrib/providers/agentHost/browser/sessionsSearchService.js';
import type { ISessionsManagementService } from '../../common/sessionsManagement.js';
import type { ISessionsProvider } from '../../common/sessionsProvider.js';
import { sessionIdentity } from '../../common/sessionIdentity.js';

ensureNoDisposablesAreLeakedInTestSuite();

function fixture() {
	const lifetime = new DisposableStore();
	const registry = lifetime.add(new SessionsProvidersService());
	const root = lifetime.add(new InstantiationService());
	const child = lifetime.add(root.createChild());
	const remoteHost = createDisconnectedRendererApi();
	const primaryHost = createDisconnectedRendererApi();
	const changed = lifetime.add(new Emitter<void>());
	const goals = lifetime.add(new Emitter<{ threadId: string; }>());
	const emptyChat = (): IChatService => ({
		onDidSubmitRequest: Event.None, onDidChangeInteractionOffer: Event.None, onDidChangeSession: Event.None,
		onDidUpdateThread: Event.None, onDidUpdateThreadTranscript: Event.None, onDidUpdateGoal: Event.None,
		onDidBecomeReady: Event.None, onDidUpdateTurnChanges: Event.None, onDidChangeQueue: Event.None,
	} as unknown as IChatService);
	const primaryChat = emptyChat();
	const remoteChat = { ...emptyChat(), onDidUpdateGoal: goals.event };
	const models = { onDidChangeModels: Event.None } as ILanguageModelsService;
	const prompts = { onDidChangeSkills: Event.None, onDidChangeHooks: Event.None } as IPromptsService;
	const execution = { onDidChange: Event.None } as IAgentExecutionSettingsService;
	const tools = lifetime.add(createTestLanguageModelToolsService({ isAvailable: true, read: async () => ({ tools: [], sourceGroups: [] }) }));
	child.registerInstance(IChatService, remoteChat);
	child.registerInstance(ILanguageModelsService, models);
	child.registerInstance(IPromptsService, prompts);
	child.registerInstance(IAgentExecutionSettingsService, execution);
	child.registerInstance(ILanguageModelToolsService, tools);
	child.registerInstance(IRendererHostService, remoteHost);
	const provider = (id: string, instantiationService?: InstantiationService): ISessionsProvider => Object.assign(lifetime.add(new class extends Disposable { }()), {
		id, label: id, order: 0, instantiationService,
		currentWorkspace: () => id === 'remote' ? { type: 'ssh' as const, host: 'remote', root: '/workspace' } : { type: 'local' as const, root: '/primary' },
	}) as unknown as ISessionsProvider;
	const primary = provider('primary');
	const remote = provider('remote', child);
	lifetime.add(registry.registerProvider(primary));
	const registration = lifetime.add(registry.registerProvider(remote));
	const management = { onDidChange: changed.event, sessions: [] as ISession[] } as unknown as ISessionsManagementService;
	const scopes = lifetime.add(new SessionProviderScopeService('primary', new SessionProviderServices(primaryChat, models, prompts, execution, primaryHost, tools), registry, management, root));
	return {
		lifetime, registry, remote, remoteHost, primaryHost, remoteChat, primaryChat, registration, scopes, goals, models, execution, tools, management, changed,
		sessionId: sessionIdentity('remote', 'same', 'primary'), threadId: sessionIdentity('remote', 'thread', 'primary'),
		[Symbol.dispose]: () => lifetime.dispose(),
	};
}

test('Chat and goal events qualify the exact remote Session and Thread while backend calls remain raw', async () => {
	using context = fixture();
	const calls: unknown[] = [];
	context.remoteChat.readThread = async (sessionId, threadId) => {
		calls.push({ sessionId, threadId });
		return { thread: { sessionId, threadId, origin: { type: 'root' }, turns: [] }, transcript: { sessionId, threadId, entries: [] } } as unknown as ThreadRead;
	};
	using chat = new SessionsChatService(context.scopes);
	const goalIds: string[] = [];
	using listener = chat.onDidUpdateGoal(event => goalIds.push(event.threadId));
	const result = await chat.readThread(context.sessionId, context.threadId);
	context.goals.fire({ threadId: 'thread' });
	assert.deepEqual(calls, [{ sessionId: 'same', threadId: 'thread' }]);
	assert.equal(result.thread.sessionId, context.sessionId);
	assert.equal(result.transcript.threadId, context.threadId);
	assert.deepEqual(goalIds, [context.threadId]);
});

test('Chat send unwraps the source address and never sends a removed remote Session to primary', async () => {
	using context = fixture();
	const calls: unknown[] = [];
	context.remoteChat.startTurn = async options => { calls.push(options); };
	context.primaryChat.startTurn = async () => { assert.fail('primary cannot receive remote sends'); };
	using chat = new SessionsChatService(context.scopes);
	const options = { sessionId: context.sessionId, threadId: context.threadId, expectedSequence: 1, text: 'hello', mode: 'agent' as const, source: { sessionId: context.sessionId, threadId: context.threadId } };
	await chat.startTurn(options);
	assert.deepEqual(calls, [{ ...options, sessionId: 'same', threadId: 'thread', source: { sessionId: 'same', threadId: 'thread' } }]);
	context.registration.dispose();
	await assert.rejects(chat.startTurn(options), isCancellationError);
});

test('a late response from a retired provider cannot publish into a replacement with the same identity', async () => {
	using context = fixture();
	const response = new DeferredPromise<ThreadRead>();
	context.remoteChat.readThread = () => response.p;
	using chat = new SessionsChatService(context.scopes);
	const pending = chat.readThread(context.sessionId, context.threadId);
	context.registration.dispose();
	using replacement = context.registry.registerProvider({ ...context.remote, instantiationService: context.remote.instantiationService } as ISessionsProvider);
	await response.complete({ thread: { sessionId: 'same', threadId: 'thread', origin: { type: 'root' }, turns: [] }, transcript: { sessionId: 'same', threadId: 'thread', entries: [] } } as unknown as ThreadRead);
	await assert.rejects(pending, isCancellationError);
});

test('conversation child services retain their models and route attachment coordinates to the original host', async () => {
	using context = fixture();
	const calls: unknown[] = [];
	Object.assign(context.remoteHost.thread, { readAttachment: async (source: unknown) => { calls.push(source); return { bytes: Uint8Array.of(1), mimeType: 'image/png' }; } });
	using scope = context.scopes.createScope(context.sessionId);
	assert.equal(scope.get(ILanguageModelsService), context.models);
	assert.equal(scope.get(IAgentExecutionSettingsService), context.execution);
	assert.equal(scope.get(ILanguageModelToolsService), context.tools);
	const source = { sessionId: context.sessionId, threadId: context.threadId, itemId: 'item' };
	assert.deepEqual(await context.scopes.getScope(context.sessionId).thread.readAttachment(source), { bytes: Uint8Array.of(1), mimeType: 'image/png' });
	assert.deepEqual(calls, [{ sessionId: 'same', threadId: 'thread', itemId: 'item' }]);
	context.registration.dispose();
	await assert.rejects(async () => context.scopes.getScope(context.sessionId).thread.readAttachment(source), isCancellationError);
});

test('conversation instructions unwrap Session identity and retain their host URI outside its workspace', async () => {
	using context = fixture();
	const calls: (string | undefined)[] = [];
	Object.assign(context.remoteHost.instructions, {
		isAvailable: true, list: async (sessionId: string | undefined) => {
			calls.push(sessionId);
			return [{ name: 'Review', path: '/home/user/instructions/review.md', scope: 'user' as const }];
		}
	});
	using scope = context.scopes.createScope(context.sessionId);
	const instructions = scope.get(IInstructionService);
	const catalog = await instructions.list(context.sessionId);
	assert.deepEqual(calls, ['same']);
	assert.equal(catalog[0]!.resource?.toString(), 'ash-remote://ssh+remote/home/user/instructions/review.md');
	assert.equal(scope.get(IAgentVoiceService), undefined, 'a host without voice must mask the ambient optional service');
	context.registration.dispose();
	assert.equal(instructions.isAvailable, false);
	await assert.rejects(instructions.list(context.sessionId), isCancellationError);
});

test('filename search captures the remote SessionDirectory and cancels on scope removal', async () => {
	using context = fixture();
	const response = new DeferredPromise<Awaited<ReturnType<typeof context.remoteHost.fileSearch.fuzzy>>>();
	const started = new DeferredPromise<void>();
	let signal: AbortSignal | undefined;
	Object.assign(context.remoteHost.fileSearch, {
		fuzzy: async (directory: unknown, _query: unknown, cancellation: AbortSignal) => {
			assert.deepEqual(directory, { resource: URI.parse('ash-remote://ssh+remote/worktree'), target: { type: 'session', sessionId: 'same', path: '/worktree' } });
			signal = cancellation; started.complete(); return response.p;
		}
	});
	const search = new SessionsSearchService('primary', () => ({ id: 'primary', folders: [] }), context.scopes, context.registry);
	const pending = search.fuzzy({ resource: URI.parse('ash-remote://ssh+remote/worktree'), target: { type: 'workspace', dirId: `session:${encodeURIComponent(context.sessionId)}:${encodeURIComponent('/worktree')}` } }, { query: 'main', maxResults: 5 });
	await started.p;
	context.registration.dispose();
	await assert.rejects(pending, isCancellationError);
	assert.equal(signal?.aborted, true);
	await response.complete({ matches: [], totalMatches: 0 });
});

test('providers without an optional domain scope do not break existing Chat bindings', () => {
	using context = fixture();
	using registration = context.registry.registerProvider(Object.assign(context.lifetime.add(new class extends Disposable { }()), { id: 'catalog-only', label: 'Catalog only', order: 1 }) as unknown as ISessionsProvider);
	using chat = new SessionsChatService(context.scopes);
	assert.deepEqual(context.scopes.getScopes().map(scope => scope.providerId), ['primary', 'remote']);
	assert.throws(() => context.scopes.getProviderScope('catalog-only'), isCancellationError);
});


test('Session worktree mounts use raw authority metadata, share roots and release with the provider', () => {
	using context = fixture();
	const registrations: { authority: string; connection: Parameters<IAgentHostFileSystemService['registerAuthority']>[1]; released: boolean; }[] = [];
	const files: IAgentHostFileSystemService = {
		registerAuthority: (authority, connection) => {
			const registration = { authority, connection, released: false }; registrations.push(registration);
			return toDisposable(() => { registration.released = true; });
		},
	};
	const session: ISession = { sessionId: context.sessionId, backendSessionId: 'same', providerId: 'remote', title: 'Remote', status: 'active', nextApprovalMode: 'manual', workspace: { authorityId: 'ssh+remote', root: '/worktree' }, chats: [] };
	Object.assign(context.management, { sessions: [session, { ...session, sessionId: sessionIdentity('remote', 'second', 'primary'), backendSessionId: 'second' }] });
	using contribution = new SessionFileSystemContribution('primary', context.management, context.registry, context.scopes, files);
	assert.equal(registrations.length, 1);
	assert.equal(registrations[0]!.connection.api, context.remoteHost.fs);
	assert.deepEqual(registrations[0]!.connection.directories(), [{ uri: URI.parse('ash-remote://ssh+remote/worktree'), target: { type: 'session', sessionId: 'same', path: '/worktree' } }]);
	context.registration.dispose();
	assert.equal(registrations[0]!.released, true);
	assert.equal(registrations.length, 1);
});

test('content search sends SessionDirectory to the selected host and retains frontend progress identity', async () => {
	using context = fixture();
	const calls: unknown[] = [];
	Object.assign(context.remoteHost.contentSearch, {
		start: async (params: unknown) => { calls.push(params); return { searchId: 'search' }; },
		read: async (params: unknown) => { calls.push(params); return { completed: true, matches: [{ path: 'a.ts', lineNumber: 1, preview: 'text', ranges: [{ start: 0, end: 4 }] }], nextMatch: 1, limitHit: false }; },
		cancel: async () => { },
	});
	const search = new SessionsSearchService('primary', () => ({ id: 'primary', folders: [] }), context.scopes, context.registry);
	const id = `session:${encodeURIComponent(context.sessionId)}:${encodeURIComponent('/worktree')}`;
	const progress: unknown[] = [];
	const result = await search.search({ id, uri: URI.parse('ash-remote://ssh+remote/worktree'), name: 'worktree', index: 0 }, { text: 'text', patternKind: 'literal', caseSensitivity: 'smart', includePatterns: [], excludePatterns: [] }, { onProgress: matches => progress.push(...matches) });
	assert.equal(result.resultCount, 1);
	assert.ok(calls.every(params => (params as { sessionDirectory: { sessionId: string; }; }).sessionDirectory.sessionId === 'same'));
	assert.ok(calls.every(params => !('dirId' in (params as object))));
	assert.equal((progress[0] as { dirId: string; }).dirId, id);
});


test('long provider conversation links preserve short backend coordinates and cannot fall back after removal', async () => {
	using context = fixture();
	const providerId = `ssh-agent-host:${JSON.stringify(['host', '/' + 'long directory/'.repeat(40)])}`;
	using registration = context.registry.registerProvider({ ...context.remote, id: providerId } as ISessionsProvider);
	Object.assign(context.remoteHost.appServer, { connectionGeneration: 1, getConnectionState: async () => 'ready', onConnectionState: Event.None });
	const reads: unknown[] = [];
	context.remoteChat.readThread = async (sessionId, threadId) => {
		reads.push({ sessionId, threadId });
		return { thread: { sessionId, threadId, origin: { type: 'root' }, turns: [] }, transcript: { sessionId, threadId, entries: [] } } as unknown as ThreadRead;
	};
	const opened: unknown[] = [];
	const view = { navigationRevision: 0, openThread: async (sessionId: string, threadId: string) => { opened.push({ sessionId, threadId }); } } as unknown as ISessionsService;
	const links = new SessionConversationLinks('primary', context.scopes, view);
	const sessionId = sessionIdentity(providerId, 'same', 'primary');
	const threadId = sessionIdentity(providerId, 'thread', 'primary');
	assert.ok(sessionId.length > 256);
	const address = await links.prepare(sessionId, threadId);
	assert.deepEqual({ sessionId: address.sessionId, threadId: address.threadId }, { sessionId: 'same', threadId: 'thread' });
	const parsed = parseOpenSessionLinkUri(URI.parse(buildOpenSessionLinkUri(address.sessionId, address.threadId, address.connectionAuthority).toString()));
	await links.open(parsed);
	assert.deepEqual(opened, [{ sessionId, threadId }]);
	assert.deepEqual(reads, [{ sessionId: 'same', threadId: 'thread' }, { sessionId: 'same', threadId: 'thread' }]);
	registration.dispose();
	await assert.rejects(links.open(parsed), isCancellationError);
	assert.equal(opened.length, 1);
});


test('shared peer-chat creation and process-log export use the remote Session owner', async () => {
	using context = fixture();
	const calls: unknown[] = [];
	Object.assign(context.remoteHost.session, {
		createThread: async (params: unknown) => {
			calls.push(params);
			return { session: { sessionId: 'same', title: 'Remote', status: 'active', manager: { status: 'idle', statusChangedAtUnixMs: 0 }, threads: [{ threadId: 'new-thread', title: 'Peer', status: 'active' }] }, threadId: 'new-thread' };
		},
		collectDebugLogs: async (params: unknown, signal: AbortSignal) => { calls.push({ params, signal }); return { files: [], omittedFiles: 0 }; },
	});
	const sessions = new SessionsAgentSessionService(context.scopes);
	const result = await sessions.createThread({ sessionId: context.sessionId, commandId: 'create', title: 'Peer' });
	assert.equal(result.session.sessionId, context.sessionId);
	assert.equal(result.threadId, sessionIdentity('remote', 'new-thread', 'primary'));
	const controller = new AbortController();
	await sessions.collectDebugLogs({ sessionId: context.sessionId }, controller.signal);
	assert.deepEqual(calls, [{ sessionId: 'same', commandId: 'create', title: 'Peer' }, { params: { sessionId: 'same' }, signal: controller.signal }]);
});

test('the real trace reader projects remote identity and round-trips backend pagination and selected payloads', async () => {
	using context = fixture();
	const calls: unknown[] = [];
	const payload = { sessionId: 'model-content-session', threadId: 'model-content-thread' };
	Object.assign(context.remoteHost.thread, {
		readTrace: async (params: { sessionId: string; after: Record<string, number>; }) => {
			calls.push(params);
			assert.equal(params.sessionId, 'same');
			const sequence = params.after.thread ? 2 : 1;
			return { trace: { formatVersion: 3, sessionId: 'same', historyPrefixes: [], threads: [{ threadId: 'thread', events: [{ eventId: `event-${sequence}`, sequence, recordedAt: 0, event: { type: 'threadCreated', threadId: 'thread', origin: { type: 'agentSpawn', parentThreadId: 'parent' }, payload } }] }] }, cursors: { thread: sequence }, hasMore: sequence === 1 };
		},
		readTraceDiagnostics: async (params: unknown) => {
			calls.push(params);
			return { diagnostics: { formatVersion: 1, captureId: 'capture-1', recordingStatus: 'recording', droppedRecords: 0, events: [{ eventId: 'diagnostic-1', sequence: 1, recordedAt: 0, threadId: 'thread', turnId: 'turn', event: { type: 'modelRequestPrepared', attemptId: 'attempt', requestPayload: { payloadId: 'payload-1', kind: 'coreRequest', byteLength: 2, status: 'saved', digest: `sha256:${'0'.repeat(64)}` } } }] }, cursor: 1, hasMore: false };
		},
		readTracePayload: async (params: unknown) => { calls.push(params); return { payload }; },
		readTraceGraph: async () => ({ graph: { nodes: { opaque: { id: 'opaque', kind: 'thread', label: 'Thread', threadId: 'thread', turnId: null, eventKey: 'thread:event-1' } }, edges: [{ from: 'opaque', to: 'opaque', kind: 'self' }], warnings: [] } }),
	});
	const debug = new AppServerChatDebugService(context.scopes.getScope(context.sessionId).thread);
	const first = await debug.readTrace(context.sessionId, {});
	assert.equal(first.trace.sessionId, context.sessionId);
	assert.equal(first.trace.threads[0]!.threadId, context.threadId);
	assert.deepEqual(first.cursors, { [context.threadId]: 1 });
	assert.equal((first.trace.threads[0]!.events[0]!.event.origin as { parentThreadId: string; }).parentThreadId, sessionIdentity('remote', 'parent', 'primary'));
	assert.equal(first.trace.threads[0]!.events[0]!.event.payload, payload, 'model evidence is never recursively rewritten');
	const second = await debug.readTrace(context.sessionId, first.cursors);
	assert.deepEqual(second.cursors, { [context.threadId]: 2 });
	assert.deepEqual((calls[1] as { after: unknown; }).after, { thread: 1 });
	const page = await debug.readTraceDiagnostics(context.sessionId, 0);
	const selected = page.diagnostics.events.filter(record => new Set([context.threadId]).has(record.threadId)).map(diagnosticPayload);
	assert.equal(selected[0]?.payloadId, 'payload-1', 'the export selection must retain the exact remote conversation payload');
	assert.equal(await debug.readTracePayload(context.sessionId, 'capture-1', selected[0]!.payloadId), payload);
	assert.deepEqual(calls.at(-1), { sessionId: 'same', captureId: 'capture-1', payloadId: 'payload-1' });
	const graph = await debug.readTraceGraph(context.sessionId);
	assert.equal(graph.nodes.opaque!.threadId, context.threadId);
	assert.equal(graph.nodes.opaque!.eventKey, 'thread:event-1');
	assert.equal(graph.edges[0]!.from, 'opaque');
});
