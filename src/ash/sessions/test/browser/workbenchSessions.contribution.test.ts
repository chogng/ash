import { IRendererHostService } from '../../../platform/renderer/common/rendererHost.js';
import { quickInputServiceTestControls } from '../../../platform/quickinput/test/browser/testQuickInputService.js';
import { CommandsRegistry, ICommandService } from '../../../platform/commands/common/commands.js';
import { OPEN_CHAT_CHANGES_COMMAND_ID } from '../../../workbench/contrib/chat/common/chat.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { getSingletonServiceDescriptors } from '../../../platform/instantiation/common/extensions.js';
import { InstantiationService } from '../../../platform/instantiation/common/instantiationService.js';
import type { IRendererHost } from '../../../platform/renderer/common/rendererHost.js';
import { IAgentSessionService, IAgentTurnService } from '../../../platform/agentHost/common/agentService.js';
import { IAgentModelsService } from '../../../platform/agentHost/common/agentModels.js';
import { createDisconnectedRendererApi } from '../../../workbench/browser/rendererApi.js';
import { IAppServerApi, IServerEventApi } from '../../../platform/agentHost/common/appServerApi.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { DeferredPromise } from '../../../base/common/async.js';
import { IWorkspaceContextService } from '../../../platform/workspace/common/workspace.js';
import { WorkbenchContributionsRegistry, WorkbenchPhase } from '../../../workbench/common/contributions.js';
import type { MultiDiffEditorInput } from '../../../workbench/contrib/multiDiffEditor/browser/multiDiffEditorInput.js';
import { IMultiDiffSourceResolverService, MultiDiffSourceResolverService } from '../../../workbench/contrib/multiDiffEditor/browser/multiDiffSourceResolverService.js';
import { IQuickInputService } from '../../../platform/quickinput/common/quickInput.js';
import { IChatService, type TurnChangeSetSummary } from '../../../workbench/services/chat/common/chatService.js';
import { IChatSessionNavigationService } from '../../../workbench/services/chat/common/chatSessionNavigationService.js';
import { IViewsService } from '../../../workbench/services/views/common/viewsService.js';
import { IEditorService } from '../../../workbench/services/editor/common/editorService.js';
import { EditorInputSerializers } from '../../../workbench/services/editor/common/editorInputSerializer.js';
import { WorkspaceContextService } from '../../../workbench/services/workspaces/browser/workspaceContextService.js';
import { createThreadMultiDiffEditorInput, createTurnMultiDiffEditorInput } from '../../browser/turnMultiDiffSource.js';
import { ISessionsManagementService } from '../../services/sessions/common/sessionsManagement.js';

const browserEnvironment = new JSDOM('<!doctype html><body></body>');
for (const [name, value] of Object.entries({
	window: browserEnvironment.window,
	document: browserEnvironment.window.document,
	Node: browserEnvironment.window.Node,
	Element: browserEnvironment.window.Element,
	HTMLElement: browserEnvironment.window.HTMLElement,
	Event: browserEnvironment.window.Event,
})) {
	Object.defineProperty(globalThis, name, { configurable: true, value });
}
await import('../../contrib/providers/agentHost/browser/workbenchSessionsService.contribution.js');
await import('../../browser/workbenchChat.contribution.js');
await import('../../browser/turnMultiDiffSource.contribution.js');
await import('../../contrib/changes/browser/changesMultiDiffSourceResolver.js');

test('Sessions registers its regular Workbench service and starts its catalog', async () => {
	let subscriptions = 0;
	let catalogLoads = 0;
	const api = {
		...createDisconnectedRendererApi(),
		session: {
			async subscribeCatalog() { catalogLoads++; return { sessions: [] }; },
			async unsubscribeCatalog() { },
		},
		model: { async readModel() { return null; } },
		events: { subscribe() { subscriptions++; return { dispose() { } }; } },
	} as unknown as IRendererHost;
	using services = new InstantiationService();
	if (!services.has(IRendererHostService)) services.registerInstance(IRendererHostService, api);
	services.registerInstance(IAgentSessionService, api.session);
	services.registerInstance(IAgentModelsService, api.model);
	services.registerInstance(IAgentTurnService, api.turn);
	services.registerInstance(IServerEventApi, api.events);
	services.registerInstance(IAppServerApi, { connectionGeneration: 1, getConnectionState: async () => 'ready', getSlashCommands: async () => [], onConnectionState: Event.None });
	using workspace = new WorkspaceContextService({ id: 'empty-window' });
	services.registerInstance(IWorkspaceContextService, workspace);
	services.registerInstance(IQuickInputService, {} as IQuickInputService);
	services.registerInstance(IChatService, {} as IChatService);
	services.registerInstance(IEditorService, {} as IEditorService);
	services.registerInstance(IViewsService, { openView: async () => { throw new Error('Draft capture must not reveal Chat'); }, focusView: async () => false, getViewWithId: () => undefined } as unknown as IViewsService);
	services.registerInstance(IMultiDiffSourceResolverService, new MultiDiffSourceResolverService());
	for (const [id, descriptor] of getSingletonServiceDescriptors()) {
		if (id === ISessionsManagementService || id === IChatSessionNavigationService) {
			services.registerSingleton(id, () => services.createInstance(descriptor));
		}
	}
	const sessions = services.get(ISessionsManagementService);
	const navigation = services.get(IChatSessionNavigationService);
	assert.deepEqual(navigation.getConversations(), []);
	assert.equal(navigation.getActiveConversation(), undefined);
	assert.equal(await navigation.captureActiveDraft(), undefined);
	using contributions = WorkbenchContributionsRegistry.createHost(services);
	contributions.advance(WorkbenchPhase.BlockRestore);
	await sessions.initialize();
	assert.equal(subscriptions, 1);
	assert.equal(catalogLoads, 1);
});

test('Open in Agents uses the visible untitled chat instead of an older active session', () => {
	const selection = {
		active: { session: { sessionId: 'older-session' }, threadId: 'older-thread' },
		activeUntitledSession: undefined as { readonly untitledSessionId: string; } | undefined,
	};
	using services = new InstantiationService();
	services.registerInstance(ISessionsManagementService, selection as unknown as ISessionsManagementService);
	services.registerInstance(IViewsService, { openView: async () => undefined, focusView: async () => false, getViewWithId: () => undefined } as unknown as IViewsService);
	const descriptor = getSingletonServiceDescriptors().find(([id]) => id === IChatSessionNavigationService)?.[1];
	assert.ok(descriptor);
	services.registerSingleton(IChatSessionNavigationService, () => services.createInstance(descriptor));
	const navigation = services.get(IChatSessionNavigationService);
	assert.deepEqual(navigation.getActiveConversation(), { sessionId: 'older-session', threadId: 'older-thread' });
	selection.activeUntitledSession = { untitledSessionId: 'new-chat' };
	assert.equal(navigation.getActiveConversation(), undefined);
});

test('Sessions contributes Turn changes and commit actions to the shared multi-diff editor', async () => {
	const summaries: TurnChangeSetSummary[] = [
		{ changeSetId: 'one', sessionId: 'session', threadId: 'thread', turnId: 'turn-one', repositoryId: 'repo', targetBranch: 'main', statistics: { files: 1, additions: 1, deletions: 1 }, captureState: 'sealed', messageState: 'ready', commitState: 'idle', committedPaths: [], dependencies: [], externalDependencyPaths: [], warnings: [], conflictPaths: [], revision: 1 },
		{ changeSetId: 'two', sessionId: 'session', threadId: 'thread', turnId: 'turn-two', repositoryId: 'repo', targetBranch: 'main', statistics: { files: 1, additions: 1, deletions: 1 }, captureState: 'sealed', messageState: 'ready', commitState: 'idle', committedPaths: [], dependencies: [], externalDependencyPaths: [], warnings: [], conflictPaths: [], revision: 2 },
	];
	const commits: string[] = [];
	const opened: MultiDiffEditorInput[] = [];
	const chat = {
		listTurnChanges: async () => summaries,
		readThreadChanges: async () => ({ sequence: 2, revision: 'checkpoint', statistics: { files: 1, additions: 1, deletions: 1 }, repositories: [{ repositoryId: 'repo', files: [{ path: 'src/file.ts', kind: 'modified', binary: false, additions: 1, deletions: 1 }] }], warnings: [] }),
		readThreadChangeFile: async () => ({ path: 'src/file.ts', binary: false, truncated: false, before: 'before', after: 'after' }),
		readTurnChange: async (_sessionId: string, _threadId: string, changeSetId: string) => ({
			summary: summaries.find(summary => summary.changeSetId === changeSetId)!,
			files: [{ path: 'src/file.ts', kind: 'modified', binary: false, additions: 1, deletions: 1 }],
			draftMessage: 'feat: review changes',
		}),
		readTurnChangeFile: async (_sessionId: string, _threadId: string, changeSetId: string) => changeSetId === 'one'
			? { path: 'src/file.ts', binary: false, truncated: false, before: 'before', after: 'middle' }
			: { path: 'src/file.ts', binary: false, truncated: false, before: 'middle', after: 'after' },
		prepareTurnCommit: async (_session: string, _thread: string, selections: unknown, message: string) => {
			assert.deepEqual(selections, [{ changeSetId: 'one', expectedRevision: 1, paths: ['src/file.ts'] }, { changeSetId: 'two', expectedRevision: 2, paths: ['src/file.ts'] }]);
			assert.equal(message, 'feat: reviewed selection');
			return { commitId: 'prepared', targetBranch: 'main', message, files: [{ path: 'src/file.ts', kind: 'modified', binary: false, additions: 1, deletions: 1 }], warnings: [] };
		},
		readTurnCommitFile: async () => ({ path: 'src/file.ts', binary: false, truncated: false, before: 'target', after: 'selected' }),
		commitTurnChange: async (_sessionId: string, _threadId: string, changeSetId: string) => {
			commits.push(changeSetId);
			return summaries;
		},
	} as unknown as IChatService;
	using services = new InstantiationService();
	services.registerInstance(IQuickInputService, {
		...quickInputServiceTestControls,
		input: async () => 'feat: reviewed selection', createQuickPick() { throw new Error('This scenario uses a message input'); }
	});
	services.registerInstance(IChatService, chat);
	const session = { sessionId: 'session', chats: [{ threadId: 'thread' }] };
	services.registerInstance(ISessionsManagementService, {
		onDidChange: Event.None,
		active: { session, threadId: 'thread' },
		sessions: [session],
		initialize: async () => { },
	} as unknown as ISessionsManagementService);
	const resolvers = new MultiDiffSourceResolverService();
	services.registerInstance(IMultiDiffSourceResolverService, resolvers);
	using contributions = WorkbenchContributionsRegistry.createHost(services);
	contributions.advance(WorkbenchPhase.BlockStartup);
	assert.deepEqual(resolvers.sourceActions(), []);
	services.registerInstance(IEditorService, {
		openEditor: async (input: MultiDiffEditorInput) => { opened.push(input); },
	} as unknown as IEditorService);
	contributions.advance(WorkbenchPhase.BlockRestore);
	await resolvers.sourceActions()[1]?.run();
	const input = opened[0]!;
	assert.deepEqual({
		before: input.items[0]?.original.initialText,
		after: input.items[0]?.modified.initialText,
		source: input.source,
	}, {
		before: 'before', after: 'after',
		source: { kind: 'external', providerId: 'sessions.turn', label: 'Changes Through Current Turn', repositoryId: 'repo', branchName: 'main' },
	});
	const openChanges = CommandsRegistry.getCommand(OPEN_CHAT_CHANGES_COMMAND_ID)!;
	await openChanges(services, 'session', 'thread');
	const changesInput = opened.pop()!;
	assert.equal(changesInput.label, 'Conversation Changes');
	assert.equal(changesInput.items[0]?.original.initialText, 'before');
	await assert.rejects(() => createThreadMultiDiffEditorInput(chat, 'session', 'thread', 'stale'), /conversation changed/);
	assert.equal(changesInput.items[0]?.modified.initialText, 'after');
	await assert.rejects(async () => openChanges(services, 'session', 'unknown-thread'), /no longer available/);
	await assert.rejects(async () => openChanges(services, undefined, 'thread'), /require a conversation/);
	let managedChangesOpened = 0;
	using managedChanges = CommandsRegistry.register('workbench.agentSessions.action.viewChanges', () => { managedChangesOpened++; });
	services.registerInstance(ICommandService, { executeCommand: async (id: string) => CommandsRegistry.getCommand(id)!(services) } as unknown as ICommandService);
	await openChanges(services, 'session', 'thread');
	assert.equal(managedChangesOpened, 0);
	opened.pop();
	assert.equal(opened.length, 1);

	const restored = EditorInputSerializers.deserialize(EditorInputSerializers.serialize(input)) as MultiDiffEditorInput;
	assert.deepEqual(restored.source, input.source);
	summaries.push({ ...summaries[1]!, changeSetId: 'three', turnId: 'turn-three', revision: 3 });
	const resolved = await resolvers.resolve(restored.resource);
	assert.equal(resolved?.resource.toString(), restored.resource.toString());
	assert.deepEqual(resolved?.resources.map(item => item.label), restored.items.map(item => item.label));
	assert.equal(resolved?.source?.kind, 'external');
	assert.equal(resolvers.primaryRepositoryAction({ ...restored, source: { kind: 'external', providerId: 'test', label: 'Changes', repositoryId: 'repo', branchName: 'main' } }), undefined);
	await resolvers.primaryRepositoryAction(restored)?.run();
	assert.deepEqual(commits, []);
	assert.equal(opened[1]?.items[0]?.original.initialText, 'target');
	assert.equal(opened[1]?.items[0]?.modified.initialText, 'selected');
	await resolvers.primaryRepositoryAction(opened[1]!)?.run();
	assert.deepEqual(commits, ['prepared']);
	const direct = await createTurnMultiDiffEditorInput(chat, { session: { sessionId: 'session' }, threadId: 'thread' } as never, 'currentTurn');
	assert.equal(direct.items[0]?.original.initialText, 'middle');
});

test('Conversation review keeps identical paths in different repositories and rejects a moving checkpoint', async () => {
	let revision = 'before';
	let moveWhileReading = false;
	const chat = {
		readThreadChanges: async () => ({ sequence: 1, revision, statistics: { files: 2, additions: 2, deletions: 2 }, repositories: ['first', 'second'].map(repositoryId => ({ repositoryId, files: [{ path: 'same.txt', kind: 'modified', binary: false, additions: 1, deletions: 1 }] })), warnings: [] }),
		readThreadChangeFile: async (_session: string, _thread: string, _revision: string, repositoryId: string) => { if (moveWhileReading) revision = 'after'; return { path: 'same.txt', binary: false, truncated: false, before: 'base', after: repositoryId }; },
	} as unknown as IChatService;
	const input = await createThreadMultiDiffEditorInput(chat, 'session', 'thread');
	assert.deepEqual(input.items.map(item => item.label), ['first: same.txt', 'second: same.txt']);
	assert.notEqual(input.items[0]!.modified.resource.toString(), input.items[1]!.modified.resource.toString());
	moveWhileReading = true;
	await assert.rejects(() => createThreadMultiDiffEditorInput(chat, 'session', 'thread'), /conversation changed/);
});

test('Chat opens the current checkpoint when composer counts arrive before its final revision', async () => {
	let revision = 'sealed';
	let summaryReads = 0;
	let moveWhileReading = false;
	const chat = {
		readThreadChanges: async () => {
			summaryReads++;
			return { sequence: 2, revision, statistics: { files: 1, additions: 7, deletions: 0 }, repositories: [{ repositoryId: 'repo', files: [{ path: 'b-only.txt', kind: 'added', binary: false, additions: 7, deletions: 0 }] }], warnings: [] };
		},
		readThreadChangeFile: async (_session: string, _thread: string, requestedRevision: string) => {
			assert.equal(requestedRevision, 'sealed');
			if (moveWhileReading) revision = 'undone';
			return { path: 'b-only.txt', binary: false, truncated: false, after: 'B only\n'.repeat(7) };
		},
	} as unknown as IChatService;
	const session = { sessionId: 'session', chats: [{ threadId: 'B' }] };
	using services = new InstantiationService();
	services.registerInstance(ISessionsManagementService, { onDidChange: Event.None, active: { session, threadId: 'B' }, sessions: [session] } as unknown as ISessionsManagementService);
	services.registerInstance(IChatService, chat);
	const opened: MultiDiffEditorInput[] = [];
	services.registerInstance(IEditorService, { openEditor: async (input: MultiDiffEditorInput) => { opened.push(input); } } as unknown as IEditorService);
	const open = CommandsRegistry.getCommand(OPEN_CHAT_CHANGES_COMMAND_ID)!;
	await open(services, 'session', 'B', 'capturing');
	assert.equal(summaryReads, 3);
	assert.equal(opened.length, 1);
	assert.equal(opened[0].items[0].label, 'b-only.txt');
	assert.equal(opened[0].items[0].modified.initialText, 'B only\n'.repeat(7));
	moveWhileReading = true;
	await assert.rejects(async () => open(services, 'session', 'B', 'capturing'), /conversation changed/);
	assert.equal(opened.length, 1, 'a checkpoint that changes during file loading must not open');
});

test('Conversation review cannot open after an A-B-A selection change', async () => {
	using changed = new Emitter<void>();
	const pending = new DeferredPromise<{ path: string; binary: boolean; truncated: boolean; before: string; after: string; }>();
	const reading = new DeferredPromise<void>();
	const session = { sessionId: 'session', chats: [{ threadId: 'A' }, { threadId: 'B' }] };
	const sessions = { onDidChange: changed.event, active: { session, threadId: 'A' }, sessions: [session] };
	const chat = {
		readThreadChanges: async () => ({ sequence: 1, revision: 'checkpoint', statistics: { files: 1, additions: 1, deletions: 1 }, repositories: [{ repositoryId: 'repo', files: [{ path: 'file', kind: 'modified', binary: false, additions: 1, deletions: 1 }] }], warnings: [] }),
		readThreadChangeFile: () => { void reading.complete(); return pending.p; },
	} as unknown as IChatService;
	using services = new InstantiationService();
	services.registerInstance(ISessionsManagementService, sessions as unknown as ISessionsManagementService);
	services.registerInstance(IChatService, chat);
	let opened = false;
	services.registerInstance(IEditorService, { openEditor: async () => { opened = true; } } as unknown as IEditorService);
	const opening = CommandsRegistry.getCommand(OPEN_CHAT_CHANGES_COMMAND_ID)!(services, 'session', 'A');
	await reading.p;
	sessions.active = { session, threadId: 'B' }; changed.fire();
	sessions.active = { session, threadId: 'A' }; changed.fire();
	await pending.complete({ path: 'file', binary: false, truncated: false, before: 'before', after: 'after' });
	await opening;
	assert.equal(opened, false);
});
