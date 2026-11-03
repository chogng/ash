import { IDialogService, type IConfirmationDialogOptions } from '../../../../../platform/dialogs/common/dialogs.js';
import { IRemoteAgentHostService } from '../../../../../platform/agentHost/common/remoteAgentHostService.js';
import { IRemoteConnectionService, type RemoteConnectionDefinition } from '../../../../../platform/remote/common/remoteConnectionService.js';
import { SavedSSHConversationHost } from '../../../../browser/agentHost/savedSSHConversationHost.js';
import { sshAgentHostProviderId } from '../../../../common/agentHostSessionsProvider.js';
import { RemoteAgentHostContribution } from '../../../../../workbench/contrib/chat/browser/remoteAgentHost/remoteAgentHostChatContribution.js';
import { IChatSessionNavigationService } from '../../../../../workbench/services/chat/common/chatSessionNavigationService.js';
import { IViewsService } from '../../../../../workbench/services/views/common/viewsService.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IAppServerApi } from '../../../../../platform/agentHost/common/appServerApi.js';
import { getSingletonServiceDescriptors } from '../../../../../platform/instantiation/common/extensions.js';
import '../../../../browser/workbenchChat.contribution.js';
import { IAgentConnection } from '../../../../../platform/agentHost/common/agentService.js';
import { createTestLanguageModelToolsService } from '../../../../../workbench/contrib/chat/test/common/tools/testLanguageModelToolsService.js';
import { ILanguageModelToolsService } from '../../../../../workbench/contrib/chat/common/tools/languageModelToolsService.js';
import { IInstructionService } from '../../../../../platform/instructions/common/instructionService.js';
import { IAgentVoiceService } from '../../../../../platform/agentHost/common/agentService.js';
import type { AgentSessionChange } from '../../../../../platform/agentHost/common/agent.js';
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
import { canceled, isCancellationError } from '../../../../../base/common/errors.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { IAgentExecutionSettingsService } from '../../../../../platform/agentHost/common/agentExecutionSettingsService.js';
import { IChatService, type ThreadRead } from '../../../../../workbench/services/chat/common/chatService.js';
import { ILanguageModelsService } from '../../../../../workbench/contrib/chat/common/languageModels.js';
import { IPromptsService } from '../../../../../workbench/contrib/chat/common/promptSyntax/service/promptsService.js';
import { createDisconnectedRendererApi } from '../../../../../workbench/browser/rendererApi.js';
import { SessionsProvidersService } from '../../browser/sessionsProvidersService.js';
import { ISessionProviderScopeService, SessionProviderServices, SessionProviderScopeService } from '../../../../browser/agentHost/sessionProviderScopeService.js';
import { SessionsChatService } from '../../../../browser/agentHost/sessionsChatService.js';
import { SessionsSearchService } from '../../../../contrib/providers/agentHost/browser/sessionsSearchService.js';
import { ISessionsManagementService } from '../../common/sessionsManagement.js';
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
	child.registerInstance(IAgentConnection, remoteHost);
	const provider = (id: string, instantiationService?: InstantiationService): ISessionsProvider => Object.assign(lifetime.add(new class extends Disposable { }()), {
		id, label: id, order: 0, instantiationService,
		currentWorkspace: () => id === 'remote' ? { type: 'ssh' as const, host: 'remote', root: '/workspace' } : { type: 'local' as const, root: '/primary' },
	}) as unknown as ISessionsProvider;
	const primary = provider('primary');
	const remote = provider('remote', child);
	lifetime.add(registry.registerProvider(primary));
	const registration = lifetime.add(registry.registerProvider(remote));
	const management = { onDidChange: changed.event, sessions: [] as ISession[] } as unknown as ISessionsManagementService;
	const scopes = lifetime.add(new SessionProviderScopeService('primary', lifetime.add(new SessionProviderServices(primaryChat, models, prompts, execution, primaryHost, tools)), registry, management, root));
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

test('the editor link opener selects the remote conversation and sends its follow-up to that host', async () => {
	using context = fixture();
	Object.assign(context.remoteHost.appServer, { connectionGeneration: 1, getConnectionState: async () => 'ready', onConnectionState: Event.None });
	context.primaryChat.readThread = async () => assert.fail('the link cannot read the ambient conversation');
	context.primaryChat.startTurn = async () => assert.fail('the ambient host cannot receive a remote follow-up');
	context.remoteChat.readThread = async (sessionId, threadId) => ({
		thread: { sessionId, threadId },
	} as ThreadRead);
	const sent: { sessionId: string; threadId: string; text: string; }[] = [];
	context.remoteChat.startTurn = async ({ sessionId, threadId, text }) => { sent.push({ sessionId, threadId, text }); };
	using services = new InstantiationService();
	using chat = new SessionsChatService(context.scopes);
	let active: ISessionsManagementService['active'];
	let focused = 0;
	services.registerInstance(ISessionsManagementService, {
		navigationRevision: 0,
		get active() { return active; },
		async openThread(sessionId: string, threadId: string) {
			active = { session: { sessionId } as ISession, threadId };
		},
	} as ISessionsManagementService);
	services.registerInstance(ISessionProviderScopeService, context.scopes);
	services.registerInstance(IChatService, chat);
	services.registerInstance(IAppServerApi, context.primaryHost.appServer);
	services.registerInstance(IViewsService, { focusView: async () => { focused++; return true; } } as unknown as IViewsService);
	const descriptor = getSingletonServiceDescriptors().find(([id]) => id === IChatSessionNavigationService)![1];
	services.registerSingleton(IChatSessionNavigationService, () => services.createInstance(descriptor));
	let open: ((uri: URI) => Promise<boolean>) | undefined;
	services.registerInstance(IOpenerService, {
		registerOpener: (opener: { open(uri: URI): Promise<boolean>; }) => {
			open = uri => opener.open(uri);
			return toDisposable(() => { open = undefined; });
		},
	} as IOpenerService);
	using opener = services.createInstance(RemoteAgentHostContribution);
	const link = buildOpenSessionLinkUri('same', 'thread', 'sessions+remote');
	assert.equal(await open!(link), true);
	const navigation = services.get(IChatSessionNavigationService);
	const conversation = navigation.getActiveConversation();
	assert.deepEqual(conversation, { sessionId: context.sessionId, threadId: context.threadId });
	assert.equal(focused, 1);
	const followUp = { ...conversation!, expectedSequence: 1, text: 'Continue', mode: 'agent' as const };
	await chat.startTurn(followUp);
	assert.deepEqual(sent, [{ sessionId: 'same', threadId: 'thread', text: 'Continue' }]);
	context.registration.dispose();
	await assert.rejects(open!(link), /connection for this conversation link is unavailable/i);
	await assert.rejects(chat.startTurn(followUp), isCancellationError);
});

test('link recovery prompts only for a unique saved SSH target and retires stale consent', async () => {
	using services = new InstantiationService();
	const target = { name: 'build', host: 'build.example', workspace: '/srv/project' };
	let catalog: readonly RemoteConnectionDefinition[] = [];
	const dialogs: IConfirmationDialogOptions[] = [];
	const connected: unknown[] = [];
	let confirmation = new DeferredPromise<{ confirmed: boolean; }>();
	services.registerInstance(IRemoteConnectionService, { available: true, list: async () => catalog } as IRemoteConnectionService);
	services.registerInstance(IRemoteAgentHostService, {
		isAvailable: true,
		connect: async (connection: RemoteConnectionDefinition) => { connected.push(connection); },
	} as unknown as IRemoteAgentHostService);
	services.registerInstance(IDialogService, {
		confirm: async (options: IConfirmationDialogOptions) => { dialogs.push(options); return confirmation.p; },
	} as IDialogService);
	const resolver = services.createInstance(SavedSSHConversationHost);
	const providerId = sshAgentHostProviderId(target);
	let current = true;
	const assertCurrent = () => { if (!current) throw canceled(); };
	const signal = new AbortController().signal;
	assert.equal(await resolver.connect(providerId, assertCurrent, signal), false);
	catalog = [target, { ...target, name: 'another-alias' }];
	assert.equal(await resolver.connect(providerId, assertCurrent, signal), false);
	assert.equal(dialogs.length, 0);
	catalog = [target];
	const stale = resolver.connect(providerId, assertCurrent, signal);
	await Promise.resolve();
	assert.match(dialogs[0]!.message, /build/);
	assert.match(dialogs[0]!.detail!, /build\.example[\s\S]*\/srv\/project/);
	current = false;
	await confirmation.complete({ confirmed: true });
	await assert.rejects(stale, isCancellationError);
	assert.deepEqual(connected, []);
	current = true;
	confirmation = new DeferredPromise();
	const accepted = resolver.connect(providerId, assertCurrent, signal);
	await confirmation.complete({ confirmed: true });
	assert.equal(await accepted, true);
	assert.deepEqual(connected, [target]);
});

test('Chat review stays on the owning host and unwraps its Session and Thread', async () => {
	using context = fixture();
	const calls: unknown[] = [];
	context.remoteChat.startReview = async options => { calls.push(options); };
	context.primaryChat.startReview = async () => { assert.fail('primary cannot receive remote reviews'); };
	using chat = new SessionsChatService(context.scopes);
	const options = { sessionId: context.sessionId, threadId: context.threadId, expectedSequence: 1, target: { type: 'stagedChanges' as const } };
	await chat.startReview(options);
	assert.deepEqual(calls, [{ ...options, sessionId: 'same', threadId: 'thread' }]);
	context.registration.dispose();
	await assert.rejects(chat.startReview(options), isCancellationError);
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
	Object.assign(context.remoteHost.appServer, { isAvailable: true, connectionGeneration: 1, getConnectionState: async () => 'ready', onConnectionState: Event.None });
	const reads: unknown[] = [];
	context.remoteChat.readThread = async (sessionId, threadId) => {
		reads.push({ sessionId, threadId });
		return { thread: { sessionId, threadId, origin: { type: 'root' }, turns: [] }, transcript: { sessionId, threadId, entries: [] } } as unknown as ThreadRead;
	};
	const opened: unknown[] = [];
	const view = { navigationRevision: 0, openThread: async (sessionId: string, threadId: string) => { opened.push({ sessionId, threadId }); } } as unknown as ISessionsService;
	const links = new SessionConversationLinks('primary', context.scopes);
	const sessionId = sessionIdentity(providerId, 'same', 'primary');
	const threadId = sessionIdentity(providerId, 'thread', 'primary');
	assert.ok(sessionId.length > 256);
	const address = await links.prepare(sessionId, threadId);
	assert.deepEqual({ sessionId: address.sessionId, threadId: address.threadId }, { sessionId: 'same', threadId: 'thread' });
	const parsed = parseOpenSessionLinkUri(URI.parse(buildOpenSessionLinkUri(address.sessionId, address.threadId, address.connectionAuthority).toString()));
	await links.open(parsed, view);
	assert.deepEqual(opened, [{ sessionId, threadId }]);
	assert.deepEqual(reads, [{ sessionId: 'same', threadId: 'thread' }, { sessionId: 'same', threadId: 'thread' }]);
	registration.dispose();
	await assert.rejects(links.open(parsed, view), /connection for this conversation link is unavailable/i);
	assert.equal(opened.length, 1);
});


test('Session events qualify each provider identity and retire subscriptions with the provider or service', () => {
	using context = fixture();
	using primaryChanges = new Emitter<AgentSessionChange>();
	using remoteChanges = new Emitter<AgentSessionChange>();
	using primaryDeletions = new Emitter<string>();
	using remoteDeletions = new Emitter<string>();
	Object.assign(context.primaryHost.session, { onDidChangeSession: primaryChanges.event, onDidDeleteSession: primaryDeletions.event });
	Object.assign(context.remoteHost.session, { onDidChangeSession: remoteChanges.event, onDidDeleteSession: remoteDeletions.event });
	using sessions = new SessionsAgentSessionService(context.scopes);
	const changes: AgentSessionChange[] = [];
	const deletions: string[] = [];
	using changed = sessions.onDidChangeSession(event => changes.push(event));
	using deleted = sessions.onDidDeleteSession(sessionId => deletions.push(sessionId));
	primaryChanges.fire({ sessionId: 'same', agentTreeChanged: false });
	remoteChanges.fire({ sessionId: 'same', agentTreeChanged: true });
	primaryDeletions.fire('same');
	remoteDeletions.fire('same');
	assert.deepEqual(changes, [
		{ sessionId: 'same', agentTreeChanged: false },
		{ sessionId: context.sessionId, agentTreeChanged: true },
	]);
	assert.deepEqual(deletions, ['same', context.sessionId]);
	context.registration.dispose();
	assert.equal(remoteChanges.hasListeners(), false);
	assert.equal(remoteDeletions.hasListeners(), false);
	remoteChanges.fire({ sessionId: 'same', agentTreeChanged: true });
	remoteDeletions.fire('same');
	using replacement = context.registry.registerProvider({ ...context.remote } as ISessionsProvider);
	remoteChanges.fire({ sessionId: 'same', agentTreeChanged: false });
	assert.deepEqual(changes, [
		{ sessionId: 'same', agentTreeChanged: false },
		{ sessionId: context.sessionId, agentTreeChanged: true },
		{ sessionId: context.sessionId, agentTreeChanged: false },
	]);
	assert.deepEqual(deletions, ['same', context.sessionId]);
	sessions.dispose();
	assert.equal(primaryChanges.hasListeners(), false);
	assert.equal(primaryDeletions.hasListeners(), false);
	assert.equal(remoteChanges.hasListeners(), false);
	assert.equal(remoteDeletions.hasListeners(), false);
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
	using sessions = new SessionsAgentSessionService(context.scopes);
	const result = await sessions.createThread({ sessionId: context.sessionId, commandId: 'create', title: 'Peer' });
	assert.equal(result.session.sessionId, context.sessionId);
	assert.equal(result.threadId, sessionIdentity('remote', 'new-thread', 'primary'));
	const controller = new AbortController();
	await sessions.collectDebugLogs({ sessionId: context.sessionId }, controller.signal);
	assert.deepEqual(calls, [{ sessionId: 'same', commandId: 'create', title: 'Peer' }, { params: { sessionId: 'same' }, signal: controller.signal }]);
});

test('Agent definition settings query the selected provider and retire its late catalog', async () => {
	using context = fixture();
	Object.assign(context.management, { activeUntitledSession: { providerId: 'remote' } });
	const catalog = { agents: [], diagnostics: ['remote definition diagnostic'] };
	const pending = new DeferredPromise<typeof catalog>();
	let late = false;
	context.remoteHost.session.readRoleCatalog = async () => late ? pending.p : catalog;
	using sessions = new SessionsAgentSessionService(context.scopes);
	assert.deepEqual(await sessions.readRoleCatalog(), { ...catalog, providerId: 'remote' });
	late = true;
	const read = sessions.readRoleCatalog();
	context.registration.dispose();
	await pending.complete(catalog);
	await assert.rejects(read, isCancellationError);
});

test('the real trace reader projects remote identity and round-trips backend pagination and selected payloads', async () => {
	using context = fixture();
	const calls: unknown[] = [];
	const payload = { sessionId: 'model-content-session', threadId: 'model-content-thread' };
	const wirePage = { captureId: 'wire', connectionId: '7', recording: false, frames: [], cursor: 0, hasMore: false, droppedFrames: 0 };
	Object.assign(context.remoteHost.thread, {
		startWireLog: async (params: unknown) => { calls.push(params); },
		stopWireLog: async (params: unknown) => { calls.push(params); },
		readWireLog: async (params: unknown) => { calls.push(params); return wirePage; },
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
	using sessions = new SessionsAgentSessionService(context.scopes);
	using debug = new AppServerChatDebugService(context.scopes.getScope(context.sessionId).thread, sessions);
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
	await debug.startWireLog(context.sessionId, 'wire');
	assert.deepEqual(calls.at(-1), { sessionId: 'same', captureId: 'wire' });
	assert.equal(await debug.readWireLog(context.sessionId, 'wire', 0), wirePage, 'frame contents and connection identity stay backend evidence');
	assert.deepEqual(calls.at(-1), { sessionId: 'same', captureId: 'wire', after: 0, limit: 100 });
	await debug.stopWireLog(context.sessionId, 'wire');
	assert.deepEqual(calls.at(-1), { sessionId: 'same', captureId: 'wire' });
});

test('Queue snapshots and revisioned operations retain the originating provider scope', async () => {
	using f = fixture();
	using chat = new SessionsChatService(f.scopes);
	const calls: unknown[] = [];
	const message = { sessionId: 'same', threadId: 'thread', commandId: 'stable-command', revision: 12, status: 'paused' as const, mode: 'agent' as const, text: 'Retained input', contextCount: 2 };
	f.remoteChat.getPendingRequests = async (...args) => { calls.push(['list', ...args]); return [message]; };
	for (const method of ['pausePendingRequest', 'resumePendingRequest', 'editPendingRequest', 'removePendingRequest'] as const) {
		Object.assign(f.remoteChat, { [method]: async (...args: unknown[]) => { calls.push([method, ...args]); return message; } });
	}
	f.remoteChat.sendPendingRequestImmediately = async target => { calls.push(['send', target]); };
	const target = { sessionId: f.sessionId, threadId: f.threadId, commandId: 'stable-command', expectedRevision: 12 };
	const backend = { ...target, sessionId: 'same', threadId: 'thread' };
	const qualified = { ...message, sessionId: f.sessionId, threadId: f.threadId };
	assert.deepEqual(await chat.getPendingRequests(f.sessionId, f.threadId), [qualified]);
	assert.deepEqual(await chat.pausePendingRequest(target), qualified);
	assert.deepEqual(await chat.resumePendingRequest(target), qualified);
	assert.deepEqual(await chat.editPendingRequest(target, 'Changed'), qualified);
	assert.deepEqual(await chat.removePendingRequest(target), qualified);
	await chat.sendPendingRequestImmediately(target);
	assert.deepEqual(calls, [['list', 'same', 'thread'], ['pausePendingRequest', backend], ['resumePendingRequest', backend], ['editPendingRequest', backend, 'Changed'], ['removePendingRequest', backend], ['send', backend]]);
	f.registration.dispose();
	await assert.rejects(chat.removePendingRequest(target));
	assert.equal(calls.length, 6);
});
