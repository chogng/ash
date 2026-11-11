import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { constObservable, observableValue, type IObservable } from '../../../../../base/common/observable.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { CommandsRegistry, ICommandService } from '../../../../../platform/commands/common/commands.js';
import type { IAccountService } from '../../../../../platform/accounts/common/accountService.js';
import type { IAppServerApi, IServerEventApi } from '../../../../../platform/agentHost/common/appServerApi.js';
import { buildOpenSessionLinkUri } from '../../../../../platform/agentHost/common/openSessionLink.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { ContextKeyService, IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { InMemoryConfigurationService } from '../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import type { AgentModelDefaults, IAgentModelsService } from '../../../../../platform/models/common/agentModels.js';
import { IOpenerService, type IOpener } from '../../../../../platform/opener/common/opener.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { ChatModelPreferences, LanguageModelsConfigurationService } from '../../../../../workbench/contrib/chat/browser/languageModelsConfigurationService.js';
import { LanguageModelsService } from '../../../../../workbench/contrib/chat/common/languageModels.js';
import * as chatInputStatePersistence from '../../../../../workbench/contrib/chat/browser/widget/input/chatInputStatePersistence.js';
import { ISessionPrimaryProviderServices, ISessionProviderScopeService, type SessionProviderServices } from '../../../../browser/agentHost/sessionProviderScopeService.js';
import { LOCAL_AGENT_HOST_PROVIDER_ID } from '../../../../common/agentHostSessionsProvider.js';
import { ISessionsEntryService, type ISessionsEntry } from '../../../../services/layout/common/sessionsEntryService.js';
import { ASH_CHAT_SELECTED_CONTEXT, CHAT_WORKSPACE_NAVIGATION_ID, OPEN_ASH_CHAT_WITH_MODEL_COMMAND, SHOW_ASH_CHAT_COMMAND, SHOW_CHAT_WORKSPACE_COMMAND } from '../../../chat/common/constants.js';
import { ISessionsService, SessionsService } from '../../../../services/sessions/browser/sessionsService.js';
import { loadChatSelection } from '../../../../services/sessions/browser/sessionGridState.js';
import type { ICustomViewService } from '../../../../services/customView/browser/customViewService.js';
import type { ISession, IUntitledChatSession, ModelRef } from '../../../../services/sessions/common/session.js';
import { ISessionsManagementService } from '../../../../services/sessions/common/sessionsManagement.js';
import { readNewChatDraftState } from '../../../chat/common/newChatDraftState.js';
import { ChatGPTWebContribution, chatGPTViewSource, chatGPTScrollOptimization, SESSIONS_CHATGPT_DEFAULT_BACKEND } from '../../electron-browser/chatGPTWeb.js';
import { IChatGPTNativeService, IChatGPTService, linkedTaskStatus, type ChatGPTState } from '../../browser/chatGPTService.js';
import { experimentalChatGPTSelected, SHOW_EXPERIMENTAL_CHATGPT } from '../../common/chatGPTNative.js';
import { ISessionsSearchService } from '../../../search/browser/searchService.js';
import type { SearchResult } from '../../../search/browser/searchModel.js';
import { ChatWorkspaceContribution, registerChatWorkspace } from '../../../chat/electron-browser/chatWorkspace.contribution.js';
import { chatGPTWorkspaceSource } from '../../electron-browser/chatGPTWeb.contribution.js';
import { localize, setNlsMessages } from '../../../../../nls.js';
import { productLanguagePackCatalogs } from '../../../../../workbench/services/localization/common/localizationCatalogs.js';
import { DefaultSettings } from '../../../../../workbench/services/preferences/common/settingsModels.js';
import { IChatViewFactory } from '../../../chat/browser/chatViewFactory.js';
import { ISessionsConversationService } from '../../../../services/sessions/common/sessionsConversation.js';
import { ViewContainerLocation } from '../../../../../workbench/common/views.js';
import { SessionsViewRegistry } from '../../../../common/views.js';
import type { ArtifactKind } from '../../../../common/artifactKind.js';

const newChatState = { conversations: [], messages: [], linkedTasks: [] } satisfies Partial<ChatGPTState>;

const testStorage = { get: () => undefined, store() { } } as unknown as IStorageService;

function chatSelectionFixture(storage: IStorageService, sessions: readonly ISession[] = []) {
	let drafts: IUntitledChatSession[] = [];
	let nextDraft = 0;
	const management = {
		sessions, onDidChange: Event.None, primaryCatalogReady: true, state: 'ready',
		materializedSessions: constObservable(new Map()),
		get untitledSessions() { return drafts; },
		async initialize() { },
		async readCatalog(id: string) { return sessions.find(session => session.sessionId === id); },
		createUntitledSession() {
			const draft = { untitledSessionId: `draft-${++nextDraft}`, title: '', kind: 'chat', workspace: { type: 'current' }, model: undefined, agent: undefined } as const;
			drafts.push(draft);
			return draft;
		},
		discardUntitledSession(id: string) { drafts = drafts.filter(draft => draft.untitledSessionId !== id); },
		setUntitledSessionModel(id: string, model: ModelRef) { drafts = drafts.map(draft => draft.untitledSessionId === id ? { ...draft, model } : draft); },
		setUntitledSessionArtifactKind(id: string, artifactKind: ArtifactKind | undefined) { drafts = drafts.map(draft => draft.untitledSessionId === id ? { ...draft, artifactKind } : draft); },
	} as unknown as ISessionsManagementService;
	const customViews = { activeCustomViewOpen: constObservable(undefined) } as unknown as ICustomViewService;
	const view = new SessionsService(management, storage, customViews, {} as ICommandService);
	return { management, view };
}

registerChatWorkspace(chatGPTWorkspaceSource);

const chatViews: IChatViewFactory = {
	registerSource: () => Disposable.None,
	createSessionChatView: () => assert.fail('Unexpected Code view'),
	createChatView: () => assert.fail('Unexpected desktop Chat view'),
};

suite('ChatGPT entry', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('the Workbench Browser settings expose the translated ChatGPT scrolling control', async () => {
		setNlsMessages('zh-CN', productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!.bundles);
		try {
			assert.equal(localize('sessions.chatgpt.toggleOptimization', 'ChatGPT: Toggle Scrolling Optimization'), 'ChatGPT：切换滚动优化');
			assert.equal(localize('sessions.chatgpt.reloadShort', 'Reload'), '刷新');
			assert.equal(linkedTaskStatus({ sessionId: 'session', threadId: 'thread', prompt: '任务' }), '正在准备任务…');
			const { createSettingsLayout, SettingsNavigation } = await import('../../../../../workbench/contrib/preferences/browser/settingsLayout.js');
			const defaults = new DefaultSettings();
			const browser = createSettingsLayout([defaults.get(chatGPTScrollOptimization)]).find(category => category.id === 'browser')!;
			assert.equal(browser.descriptor.label, '浏览器');
			assert.equal(browser.groups[0]!.description, '配置此窗口中的 ChatGPT。');
			assert.equal(browser.groups[0]!.settings[0]!.title, 'ChatGPT 滚动优化');
			assert.deepEqual(SettingsNavigation.filter(entry => 'categories' in entry && entry.categories.some(category => category.id === browser.id)).map(entry => entry.id), ['workbench']);
		}
		finally { setNlsMessages('en', {}); }
	});

	test('open and restore reuse the Sessions Part content and the shared Chat sidebar', async () => {
		assert.equal(SessionsViewRegistry.getDefaultViewContainer(ViewContainerLocation.Sidebar)?.id, CHAT_WORKSPACE_NAVIGATION_ID);
		using resources = new DisposableStore();
		const entries: { entry: ISessionsEntry; source?: string; }[] = [];
		let initialized = 0;
		const services = resources.add(new InstantiationService(new ServiceCollection(
			[IChatViewFactory, chatViews],
			[IStorageService, testStorage],
			[IContextKeyService, resources.add(new ContextKeyService())],
			[IChatGPTService, { state: observableValue('chatgpt', newChatState), initialize: () => initialized++, setNetworkAvailable() { } } as unknown as IChatGPTService],
			[ISessionsSearchService, { registerSource: () => Disposable.None } as unknown as ISessionsSearchService],
			[ISessionsConversationService, {} as ISessionsConversationService],
			[ISessionsEntryService, { openEntry: async (entry, _arg, options) => { entries.push({ entry, source: options?.source }); } } as ISessionsEntryService],
		)));
		resources.add(services.createInstance(ChatGPTWebContribution));
		await services.invokeFunction(CommandsRegistry.getCommand('sessions.show.chatgptNative')!, undefined);
		await services.invokeFunction(CommandsRegistry.getCommand('sessions.show.chatgptNative')!, 'restore');
		assert.equal(initialized, 2);
		assert.equal(entries.length, 2);
		assert.equal(entries[1]!.source, 'restore');
		for (const { entry } of entries) {
			assert.equal(entry.id, 'chatgpt');
			assert.equal(entry.restoreCommand, 'sessions.show.chatgpt');
			assert.equal(entry.editorInput, undefined);
			assert.equal(entry.sidebarContainerId, CHAT_WORKSPACE_NAVIGATION_ID);
			assert.equal(entry.content, 'conversation');
			assert.equal(entry.focus, 'conversation');
			assert.ok(entry.chatSource);
			assert.equal(entry.chatSource, entries[0]!.entry.chatSource);
		}
	});

	test('the explicit Web New command uses the retained Web chat owner and focuses its input', async () => {
		using resources = new DisposableStore();
		let entry: ISessionsEntry | undefined;
		let created = 0;
		let focused = 0;
		const state = observableValue<Partial<ChatGPTState>>('chatgpt', { ...newChatState, conversationId: 'existing' });
		const services = resources.add(new InstantiationService(new ServiceCollection(
			[IChatViewFactory, chatViews],
			[IStorageService, testStorage],
			[IContextKeyService, resources.add(new ContextKeyService())],
			[IChatGPTService, { state, initialize() { }, setNetworkAvailable() { }, newChat: () => { created++; state.set(newChatState); } } as unknown as IChatGPTService],
			[ISessionsSearchService, { registerSource: () => Disposable.None } as unknown as ISessionsSearchService],
			[ISessionsConversationService, { focus: () => { focused++; } } as unknown as ISessionsConversationService],
			[ISessionsEntryService, { openEntry: async value => { entry = value; } } as ISessionsEntryService],
		)));
		resources.add(services.createInstance(ChatGPTWebContribution));
		await services.invokeFunction(CommandsRegistry.getCommand('sessions.show.chatgptNative')!, undefined);
		assert.equal(entry?.newSessionCommand, 'sessions.open.new');
		const draft = entry.newDraft;
		assert.ok(draft && draft !== 'conversation');
		assert.equal(draft.get(), false);
		await services.invokeFunction(CommandsRegistry.getCommand('sessions.chatgpt.newChat')!);
		assert.deepEqual({ created, focused }, { created: 1, focused: 1 });
		assert.equal(draft.get(), true);
		state.set({ ...newChatState, pendingCreation: 'queued' });
		assert.equal(draft.get(), false);
		state.set({ ...newChatState, conversationId: 'existing' });
		assert.equal(draft.get(), false);
	});

	test('Desktop New uses the configured ChatGPT entry and explicit Web restore preserves the conversation', async () => {
		using resources = new DisposableStore();
		let created = 0;
		const entries: { entry: ISessionsEntry; source?: string; }[] = [];
		const experimentalOpens: (readonly unknown[])[] = [];
		const configuration = resources.add(new InMemoryConfigurationService());
		const services = resources.add(new InstantiationService(new ServiceCollection(
			[IChatViewFactory, chatViews],
			[IStorageService, testStorage],
			[IConfigurationService, configuration],
			[ICommandService, { executeCommand: (id: string, ...args: unknown[]) => services.invokeFunction(CommandsRegistry.getCommand(id)!, ...args) } as ICommandService],
			[IContextKeyService, resources.add(new ContextKeyService())],
			[IChatGPTService, { state: observableValue('chatgpt', newChatState), initialize() { }, setNetworkAvailable() { }, newChat: () => { created++; } } as unknown as IChatGPTService],
			[ISessionsSearchService, { registerSource: () => Disposable.None } as unknown as ISessionsSearchService],
			[ISessionsConversationService, {} as ISessionsConversationService],
			[ISessionsEntryService, { openEntry: async (entry, _arg, options) => { entries.push({ entry, source: options?.source }); } } as ISessionsEntryService],
		)));
		resources.add(services.createInstance(ChatGPTWebContribution));
		resources.add(CommandsRegistry.register(SHOW_EXPERIMENTAL_CHATGPT, (_accessor, ...args) => { experimentalOpens.push(args); }));
		await services.invokeFunction(CommandsRegistry.getCommand('sessions.open.new')!, 'startup');
		assert.deepEqual(experimentalOpens, [['startup', true]]);
		assert.equal(entries.length, 0);
		await services.invokeFunction(CommandsRegistry.getCommand('sessions.show.chatgpt')!, 'restore');
		assert.equal(created, 0);
		assert.equal(entries[0]!.source, 'restore');
		await configuration.updateValue(SESSIONS_CHATGPT_DEFAULT_BACKEND, 'chatgptweb');
		await services.invokeFunction(CommandsRegistry.getCommand('sessions.open.new')!);
		assert.equal(created, 1);
		assert.equal(entries[1]!.entry.chatSource, entries[0]!.entry.chatSource);
		assert.ok(entries[1]!.entry.chatSource);
		assert.equal(entries[1]!.source, undefined);
	});

	test('Ash opens native conversations inside the Chat workspace and restores them from the mode toggle', async () => {
		const values = new Map([['sessions.chat.ashSelection', JSON.stringify({ kind: 'thread', sessionId: 'saved', threadId: 'old-root' })]]);
		const storage = { get: (key: string) => values.get(key), getBoolean: () => false, onWillSaveState: Event.None, store: (key: string, value: string) => { values.set(key, value); } } as unknown as IStorageService;
		const { management, view } = chatSelectionFixture(storage, [
			{ sessionId: 'saved', kind: 'chat', status: 'active', chats: [{ threadId: 'old-root', status: 'active' }] },
			{ sessionId: 'code', kind: 'code', status: 'active', chats: [{ threadId: 'code', status: 'active' }] },
		] as unknown as ISession[]);
		using selection = view;
		let linkOpener: IOpener | undefined;
		using contexts = new ContextKeyService();
		const entries: ISessionsEntry[] = [];
		using services = new InstantiationService(new ServiceCollection(
			[IChatViewFactory, chatViews],
			[IStorageService, storage],
			[ICommandService, { executeCommand: (id: string, ...args: unknown[]) => services.invokeFunction(CommandsRegistry.getCommand(id)!, ...args) } as ICommandService],
			[IContextKeyService, contexts],
			[ISessionsService, selection],
			[ISessionsManagementService, management],
			[IOpenerService, { registerOpener: (value: IOpener) => { linkOpener = value; return toDisposable(() => { linkOpener = undefined; }); } } as IOpenerService],
			[IChatGPTService, { state: observableValue('chatgpt', newChatState), initialize() { } } as unknown as IChatGPTService],
			[ISessionsSearchService, { registerSource: () => Disposable.None } as unknown as ISessionsSearchService],
			[ISessionsConversationService, {} as ISessionsConversationService],
			[ISessionsEntryService, { openEntry: async entry => { entries.push(entry); } } as ISessionsEntryService],
		));
		using contribution = services.createInstance(ChatWorkspaceContribution, chatGPTWorkspaceSource.openCommand, chatGPTWorkspaceSource.draftModels);
		await services.invokeFunction(CommandsRegistry.getCommand(SHOW_ASH_CHAT_COMMAND)!, 'restore');
		await services.invokeFunction(CommandsRegistry.getCommand(SHOW_CHAT_WORKSPACE_COMMAND)!);
		assert.deepEqual(selection.chatSelection.get(), { kind: 'thread', sessionId: 'saved', threadId: 'old-root' });
		assert.equal(entries.length, 2);
		for (const entry of entries) {
			assert.equal(entry.workspaceMode, 'chat');
			assert.equal(entry.activityContext, ASH_CHAT_SELECTED_CONTEXT);
			assert.equal(entry.content, 'conversation');
			assert.equal(entry.focus, 'conversation');
			assert.equal(entry.editorInput, undefined);
			assert.ok(entry.chatSource);
			assert.equal(entry.chatSource, entries[0]!.chatSource);
			assert.equal(entry.newSessionCommand, 'sessions.open.new');
			assert.equal(entry.sidebarContainerId, CHAT_WORKSPACE_NAVIGATION_ID);
			assert.equal(entry.restoreCommand, SHOW_ASH_CHAT_COMMAND);
		}
		selection.openChatDraft();
		assert.equal(await linkOpener!.open(buildOpenSessionLinkUri('code', 'code', 'local')), false);
		assert.equal(await linkOpener!.open(buildOpenSessionLinkUri('saved', 'old-root', 'sessions+remote')), false);
		assert.equal(await linkOpener!.open(buildOpenSessionLinkUri('saved', 'old-root', 'local')), true);
		assert.deepEqual(loadChatSelection(storage), { kind: 'thread', sessionId: 'saved', threadId: 'old-root' });
	});

	for (const staleSelection of ['deleted', 'archived'] as const) {
		test(`an Ash Chat link opens its target when the previous conversation was ${staleSelection}`, async () => {
			const values = new Map([['sessions.chat.ashSelection', JSON.stringify({ kind: 'thread', sessionId: 'old', threadId: 'old-root' })]]);
			const storage = {
				get: (key: string) => values.get(key), getBoolean: () => false, onWillSaveState: Event.None,
				store: (key: string, value: string) => { values.set(key, value); },
			} as unknown as IStorageService;
			const sessions = [{ sessionId: 'target', kind: 'chat', status: 'active', chats: [{ threadId: 'target-root', status: 'active' }] }];
			if (staleSelection === 'archived') {
				sessions.push({ sessionId: 'old', kind: 'chat', status: 'archived', chats: [{ threadId: 'old-root', status: 'archived' }] });
			}
			const { management, view } = chatSelectionFixture(storage, sessions as unknown as ISession[]);
			using selection = view;
			let linkOpener: IOpener | undefined;
			let opened = 0;
			const target = { kind: 'thread', sessionId: 'target', threadId: 'target-root' };
			using services = new InstantiationService(new ServiceCollection(
				[IChatViewFactory, chatViews],
				[IStorageService, storage],
				[ISessionsService, selection],
				[ISessionsManagementService, management],
				[IOpenerService, { registerOpener: (value: IOpener) => { linkOpener = value; return Disposable.None; } } as IOpenerService],
				[ISessionsEntryService, {
					openEntry: async (entry: ISessionsEntry) => {
						assert.equal(entry.id, 'ashChat');
						assert.deepEqual(selection.chatSelection.get(), target);
						assert.equal(selection.getChatSelection()?.kind, 'session');
						opened++;
					},
				} as ISessionsEntryService],
			));
			using contribution = services.createInstance(ChatWorkspaceContribution, chatGPTWorkspaceSource.openCommand, chatGPTWorkspaceSource.draftModels);
			assert.equal(await linkOpener!.open(buildOpenSessionLinkUri('target', 'target-root', 'local')), true);
			assert.equal(opened, 1);
			assert.deepEqual(loadChatSelection(storage), target);
			assert.deepEqual(management.untitledSessions, []);
		});
	}

	test('an experimental Chat draft applies Ash model visibility while default model reads are pending', async () => {
		const native = { model: { provider: 'openai', model: 'gpt-6.1-sol' }, displayName: 'GPT-6.1 Sol', longContext: null };
		const web = { provider: 'chatgpt', model: 'web' };
		const state = observableValue<ChatGPTState>('draft', {
			...newChatState, localConversationId: 'draft', draft: '', attachments: [], voice: 'idle', voiceTranscript: [],
			connected: true, networkAvailable: true, canQueue: false, pendingSync: false, busy: false, sending: false,
			projects: [], projectHistory: new Map(), hasMore: false, title: 'ChatGPT', parentId: 'root', error: '', uncertain: false, stopped: false, managing: false,
			model: 'web', modelPreset: 'instant',
			models: [{ id: 'web', title: 'Web model', modelIds: ['web-instant'], defaultPreset: 'instant', presets: [{ id: 'instant', label: 'Instant', model: 'web-instant', isPro: false }] }],
		});
		using configuration = new InMemoryConfigurationService();
		using preferences = new LanguageModelsConfigurationService(ChatModelPreferences, configuration, { onDidChangeValue: Event.None } as IStorageService);
		using notifications = new Emitter<Parameters<Parameters<IServerEventApi['subscribe']>[0]>[0]>();
		const defaults = { revision: 1, model: null, reasoningEffort: null, commitMessageModel: null, commitMessageEnabled: false, codeReviewModel: null };
		let defaultRead: Promise<AgentModelDefaults> = Promise.resolve(defaults);
		using models = new LanguageModelsService({
			listModels: async () => ({ models: [native] }),
			listProviders: async () => ({ providers: [] }),
			readDefaults: () => defaultRead,
		} as unknown as IAgentModelsService,
			{ connectionGeneration: 1, onConnectionState: Event.None } as unknown as IAppServerApi,
			{ subscribe: notifications.event }, preferences,
			{ onDidChangeAccounts: Event.None, read: async () => ({ revision: 1n, accounts: [] }) } as unknown as IAccountService);
		const calls: unknown[][] = [];
		using services = new InstantiationService(new ServiceCollection(
			[IChatViewFactory, chatViews],
			[IChatGPTService, { native: true, state, newDraftRevision: 1 } as unknown as IChatGPTService],
			[IClipboardService, {} as IClipboardService],
			[IDialogService, {} as IDialogService],
			[IOpenerService, {} as IOpenerService],
			[ISessionPrimaryProviderServices, { models } as unknown as SessionProviderServices],
			[ICommandService, { executeCommand: async (...args: unknown[]) => { calls.push(args); } } as ICommandService],
		));
		using draft = services.createInstance(chatGPTViewSource.model);
		const presented = new DeferredPromise<void>();
		let choices = draft.inputState.models.map(entry => entry.model);
		using listener = draft.onDidChange(() => {
			choices = draft.inputState.models.map(entry => entry.model);
			if (choices.length === 2) { void presented.complete(); }
		});
		await presented.p;
		assert.deepEqual(choices, [web, native.model]);

		const pendingDefaults = new DeferredPromise<AgentModelDefaults>();
		defaultRead = pendingDefaults.p;
		try {
			notifications.fire({ method: 'config/changed', params: { revision: 2, generation: 2 } });
			await models.setModelVisible(native.model, false);
			assert.deepEqual(choices, [web]);
			assert.deepEqual(draft.inputState.selectedModel, web);
			await assert.rejects(draft.selectModel(native.model), /no longer available/);
			assert.deepEqual(calls, []);

			await models.setModelVisible(native.model, true);
			assert.deepEqual(choices, [web, native.model]);
			await draft.selectModel(native.model);
			assert.deepEqual(calls, [[OPEN_ASH_CHAT_WITH_MODEL_COMMAND, native.model]]);

			state.set({ ...state.get(), conversationId: 'existing' }, undefined);
			assert.deepEqual(choices, [web]);
			await assert.rejects(draft.selectModel(native.model), /no longer available/);
			assert.deepEqual(calls, [[OPEN_ASH_CHAT_WITH_MODEL_COMMAND, native.model]]);
		} finally {
			await pendingDefaults.complete({ ...defaults, revision: 2 });
		}
	});

	test('choosing an Ash model from ChatGPT creates a separate Ash draft with the chosen model and plain text', async () => {
		const values = new Map<string, string>();
		const storage = { get: (key: string) => values.get(key), getBoolean: () => false, onWillSaveState: Event.None, store: (key: string, value: string) => { values.set(key, value); } } as unknown as IStorageService;
		const { management, view } = chatSelectionFixture(storage);
		using selection = view;
		let mode = 'code';
		let experimental = false;
		const state = observableValue<ChatGPTState>('draft', {
			localConversationId: 'chatgpt-draft', draft: 'Unsent prompt', draftArtifactKind: 'slides', voice: 'idle',
			conversations: [], messages: [], linkedTasks: [], attachments: [],
		} as unknown as ChatGPTState);
		const experimentalState = observableValue<ChatGPTState>('experimentalDraft', { ...state.get(), localConversationId: 'experimental-draft', draft: 'Experimental prompt' });
		const model = { provider: 'fixture-provider', model: 'fixture-model' };
		let modelVisible = true;
		const calls: unknown[][] = [];
		using services = new InstantiationService(new ServiceCollection(
			[IChatViewFactory, chatViews],
			[IConfigurationService, { getValue: () => false } as unknown as IConfigurationService],
			[IContextKeyService, { getValue: (key: string) => key === 'sessions.workspaceMode' ? mode : key === (experimental ? experimentalChatGPTSelected : 'sessions.activity.chatgptSelected') } as unknown as IContextKeyService],
			[ISessionProviderScopeService, {
				getProviderScope: (provider: string) => {
					assert.equal(provider, LOCAL_AGENT_HOST_PROVIDER_ID);
					return { assertCurrent() { }, services: { models: { listModelCatalog: async () => [{ model, displayName: 'Fixture model', longContext: null }], isModelVisible: () => modelVisible } } };
				}
			} as unknown as ISessionProviderScopeService],
			[IChatGPTService, { state, newDraftRevision: 1 } as unknown as IChatGPTService],
			[IChatGPTNativeService, { native: true, state: experimentalState, newDraftRevision: 1 } as unknown as IChatGPTService],
			[ICommandService, { executeCommand: async (id: string) => { calls.push([id]); } } as ICommandService],
			[ISessionsService, selection],
			[ISessionsManagementService, management],
			[IStorageService, storage],
		));
		const command = CommandsRegistry.getCommand(OPEN_ASH_CHAT_WITH_MODEL_COMMAND)!;
		await services.invokeFunction(command, model);
		assert.deepEqual(calls, []);

		mode = 'chat';
		await assert.rejects(async () => services.invokeFunction(command, { provider: 'chatgpt', model: 'fixture' }), /no longer available/);
		assert.deepEqual(calls, []);

		const draft = state.get();
		const handoff = services.invokeFunction(command, model);
		state.set({ ...draft, conversationId: 'existing' }, undefined);
		await handoff;
		assert.deepEqual(calls, []);
		state.set(draft, undefined);

		const hiddenHandoff = services.invokeFunction(command, model);
		modelVisible = false;
		await assert.rejects(Promise.resolve(hiddenHandoff), /no longer available/);
		assert.deepEqual(calls, []);
		modelVisible = true;

		await services.invokeFunction(command, model);
		assert.deepEqual(calls, [[SHOW_ASH_CHAT_COMMAND]]);
		const selected = selection.chatSelection.get();
		assert.ok(selected?.kind === 'draft');
		assert.deepEqual(selected.model, model);
		assert.equal(management.untitledSessions.find(draft => draft.untitledSessionId === selected.id)?.artifactKind, 'slides');
		assert.deepEqual(readNewChatDraftState(storage, `ash-chat:untitled:${selected.id}`, chatInputStatePersistence), { text: 'Unsent prompt', mode: 'agent', contexts: [] });
		assert.deepEqual(loadChatSelection(storage), selected);

		experimental = true;
		const experimentalHandoff = services.invokeFunction(command, model);
		experimental = false;
		await experimentalHandoff;
		assert.deepEqual(calls, [[SHOW_ASH_CHAT_COMMAND]]);

		experimental = true;
		await services.invokeFunction(command, model);
		assert.deepEqual(calls, [[SHOW_ASH_CHAT_COMMAND], [SHOW_ASH_CHAT_COMMAND]]);
		const experimentalSelection = selection.chatSelection.get();
		assert.ok(experimentalSelection?.kind === 'draft');
		assert.deepEqual(experimentalSelection.model, model);
		assert.deepEqual(readNewChatDraftState(storage, `ash-chat:untitled:${experimentalSelection.id}`, chatInputStatePersistence), { text: 'Experimental prompt', mode: 'agent', contexts: [] });
	});

	test('unified search projects the live ChatGPT catalogue and opens the exact conversation after navigation', async () => {
		using resources = new DisposableStore();
		const state = observableValue('chatgpt-search', {
			...newChatState,
			conversations: [{ id: 'one', title: 'Design review', projectId: 'g-p-project', pinned: false }],
			projects: [{ id: 'g-p-project', title: 'Website project' }],
		});
		let source: IObservable<readonly SearchResult[]> | undefined;
		const opened: string[] = [];
		const services = resources.add(new InstantiationService(new ServiceCollection(
			[IChatViewFactory, chatViews],
			[IStorageService, testStorage],
			[IContextKeyService, resources.add(new ContextKeyService())],
			[IChatGPTService, { state, initialize() { }, setNetworkAvailable() { }, select: async (id: string) => { opened.push(id); } } as unknown as IChatGPTService],
			[ISessionsSearchService, {
				registerSource: value => { source = value; return toDisposable(() => { source = undefined; }); },
			} as ISessionsSearchService],
			[ISessionsConversationService, { focus: () => { opened.push('focus'); } } as unknown as ISessionsConversationService],
			[ISessionsEntryService, { openEntry: async () => { opened.push('open'); } } as unknown as ISessionsEntryService],
		)));
		const contribution = resources.add(services.createInstance(ChatGPTWebContribution));
		assert.deepEqual(source!.get().map(({ id, category, title, description }) => ({ id, category, title, description })), [
			{ id: 'chatgpt:one', category: 'sessions', title: 'Design review', description: 'ChatGPT · Website project' },
		]);
		state.set({ ...state.get(), conversations: [{ ...state.get().conversations[0]!, title: 'Renamed review' }] });
		assert.equal(source!.get()[0]!.title, 'Renamed review');
		const target = source!.get()[0]!.target;
		assert.equal(target.kind, 'contributed');
		if (target.kind === 'contributed') { await target.open(); }
		assert.deepEqual(opened, ['open', 'one', 'focus']);
		state.set({ ...state.get(), conversations: [] });
		assert.deepEqual(source!.get(), []);
		contribution.dispose();
		assert.equal(source, undefined);
	});
});
