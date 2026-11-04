import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { Disposable, DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { observableValue, type IObservable } from '../../../../../base/common/observable.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { CommandsRegistry, ICommandService } from '../../../../../platform/commands/common/commands.js';
import { ContextKeyService, IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { ChatGPTNewDraftContext } from '../../../../common/contextkeys.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { ILayoutService } from '../../../../../platform/layout/browser/layoutService.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import * as chatInputStatePersistence from '../../../../../workbench/contrib/chat/browser/widget/input/chatInputStatePersistence.js';
import { ISessionProviderScopeService } from '../../../../browser/agentHost/sessionProviderScopeService.js';
import { LOCAL_AGENT_HOST_PROVIDER_ID } from '../../../../common/agentHostSessionsProvider.js';
import { ISessionsLayoutService, type ISessionsEntry } from '../../../../services/layout/common/sessionsLayoutService.js';
import { ISessionsService } from '../../../../services/sessions/browser/sessionsService.js';
import { ISessionsManagementService } from '../../../../services/sessions/common/sessionsManagement.js';
import { ASH_CHAT_SELECTED_CONTEXT, CHAT_WORKSPACE_NAVIGATION_ID, OPEN_ASH_CHAT_WITH_MODEL_COMMAND, SHOW_ASH_CHAT_COMMAND, SHOW_CHAT_WORKSPACE_COMMAND } from '../../../chat/common/constants.js';
import { readNewChatDraftState } from '../../../chat/common/newChatDraftState.js';
import { ChatGPTWebContribution, chatGPTScrollOptimization } from '../../browser/chatGPTWeb.js';
import { IChatGPTService, coworkTaskStatus, type ChatGPTState } from '../../browser/chatGPTService.js';
import { ISessionsSearchService } from '../../../search/browser/searchService.js';
import type { SearchResult } from '../../../search/browser/searchModel.js';
import { ChatWorkspaceContribution } from '../../../../electron-browser/chatWorkspace.contribution.js';
import { localize, setNlsMessages } from '../../../../../nls.js';
import { productLanguagePackCatalogs } from '../../../../../workbench/services/localization/common/localizationCatalogs.js';
import { DefaultSettings } from '../../../../../workbench/services/preferences/common/settingsModels.js';
import { IEditorService } from '../../../../../workbench/services/editor/common/editorService.js';
import { ViewContainerLocation } from '../../../../../workbench/common/views.js';
import { SessionsViewRegistry } from '../../../../common/views.js';

const newChatState = { conversations: [], messages: [], coworkTasks: [] } satisfies Partial<ChatGPTState>;

const testStorage = { get: () => undefined, store() { } } as unknown as IStorageService;

suite('ChatGPT entry', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('the Workbench Browser settings expose the translated ChatGPT scrolling control', async () => {
		setNlsMessages('zh-CN', productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!.bundles);
		try {
			assert.equal(localize('sessions.chatgpt.toggleOptimization', 'ChatGPT: Toggle Scrolling Optimization'), 'ChatGPT：切换滚动优化');
			assert.equal(localize('sessions.chatgpt.reloadShort', 'Reload'), '刷新');
			assert.equal(coworkTaskStatus({ sessionId: 'session', threadId: 'thread', prompt: '任务' }), '正在准备 Cowork 任务…');
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

	test('open and restore use a normal editor resource and independent sidebar without a BrowserView', async () => {
		assert.equal(SessionsViewRegistry.getDefaultViewContainer(ViewContainerLocation.Sidebar)?.id, CHAT_WORKSPACE_NAVIGATION_ID);
		using resources = new DisposableStore();
		const entries: { entry: ISessionsEntry; source?: string; }[] = [];
		let initialized = 0;
		const services = resources.add(new InstantiationService(new ServiceCollection(
			[IStorageService, testStorage],
			[IContextKeyService, resources.add(new ContextKeyService())],
			[IChatGPTService, { state: observableValue('chatgpt', newChatState), initialize: () => initialized++ } as unknown as IChatGPTService],
			[ISessionsSearchService, { registerSource: () => Disposable.None } as unknown as ISessionsSearchService],
			[IEditorService, {} as IEditorService],
			[ISessionsLayoutService, { openEntry: async (entry, _arg, options) => { entries.push({ entry, source: options?.source }); } } as ISessionsLayoutService],
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
			assert.equal(entry.editorInput!.label, 'ChatGPT');
			assert.equal(entry.sidebarContainerId, CHAT_WORKSPACE_NAVIGATION_ID);
			assert.equal(entry.content, 'editor');
			assert.equal(entry.showEditorTabs, false);
			assert.equal(entry.editorInput!.resource.scheme, 'ash-chatgpt');
		}
	});

	test('the entry New command delegates to the retained chat owner and focuses its input', async () => {
		using resources = new DisposableStore();
		let entry: ISessionsEntry | undefined;
		let created = 0;
		let focused = 0;
		const state = observableValue<Partial<ChatGPTState>>('chatgpt', { ...newChatState, conversationId: 'existing' });
		const services = resources.add(new InstantiationService(new ServiceCollection(
			[IStorageService, testStorage],
			[IContextKeyService, resources.add(new ContextKeyService())],
			[IChatGPTService, { state, initialize() { }, newChat: () => { created++; state.set(newChatState); } } as unknown as IChatGPTService],
			[ISessionsSearchService, { registerSource: () => Disposable.None } as unknown as ISessionsSearchService],
			[IEditorService, { focusActiveEditor: () => { focused++; } } as unknown as IEditorService],
			[ISessionsLayoutService, { openEntry: async value => { entry = value; } } as ISessionsLayoutService],
		)));
		resources.add(services.createInstance(ChatGPTWebContribution));
		await services.invokeFunction(CommandsRegistry.getCommand('sessions.show.chatgptNative')!, undefined);
		assert.ok(entry?.newSessionCommand);
		const contexts = services.get(IContextKeyService);
		assert.equal(contexts.getValue(ChatGPTNewDraftContext.key), false);
		await services.invokeFunction(CommandsRegistry.getCommand(entry.newSessionCommand)!, undefined);
		assert.deepEqual({ created, focused }, { created: 1, focused: 1 });
		assert.equal(contexts.getValue(ChatGPTNewDraftContext.key), true);
		state.set({ ...newChatState, pendingCreation: 'queued' });
		assert.equal(contexts.getValue(ChatGPTNewDraftContext.key), false);
		state.set({ ...newChatState, conversationId: 'existing' });
		assert.equal(contexts.getValue(ChatGPTNewDraftContext.key), false);
	});

	test('Desktop New preserves the selected chat on restore and creates a draft only on explicit New', async () => {
		using resources = new DisposableStore();
		let created = 0;
		const entries: { entry: ISessionsEntry; source?: string; }[] = [];
		const services = resources.add(new InstantiationService(new ServiceCollection(
			[IStorageService, testStorage],
			[IContextKeyService, resources.add(new ContextKeyService())],
			[IChatGPTService, { state: observableValue('chatgpt', newChatState), initialize() { }, newChat: () => { created++; } } as unknown as IChatGPTService],
			[ISessionsSearchService, { registerSource: () => Disposable.None } as unknown as ISessionsSearchService],
			[IEditorService, {} as IEditorService],
			[ISessionsLayoutService, { openEntry: async (entry, _arg, options) => { entries.push({ entry, source: options?.source }); } } as ISessionsLayoutService],
		)));
		resources.add(services.createInstance(ChatGPTWebContribution));
		await services.invokeFunction(CommandsRegistry.getCommand('sessions.open.new')!, 'restore');
		assert.equal(created, 0);
		assert.equal(entries[0]!.source, 'restore');
		await services.invokeFunction(CommandsRegistry.getCommand('sessions.open.new')!, undefined);
		assert.equal(created, 1);
		assert.equal(entries[1]!.entry.editorInput!.resource.scheme, 'ash-chatgpt');
		assert.equal(entries[1]!.source, undefined);
	});

	test('Ash uses the Code conversation renderer inside the Chat workspace and restores it from the mode toggle', async () => {
		const values = new Map<string, string>();
		using contexts = new ContextKeyService();
		const entries: ISessionsEntry[] = [];
		using services = new InstantiationService(new ServiceCollection(
			[IStorageService, { get: (key: string) => values.get(key), store: (key: string, value: string) => { values.set(key, value); } } as unknown as IStorageService],
			[ICommandService, { executeCommand: (id: string, ...args: unknown[]) => services.invokeFunction(CommandsRegistry.getCommand(id)!, ...args) } as ICommandService],
			[IContextKeyService, contexts],
			[IChatGPTService, { state: observableValue('chatgpt', newChatState), initialize() { } } as unknown as IChatGPTService],
			[ISessionsSearchService, { registerSource: () => Disposable.None } as unknown as ISessionsSearchService],
			[IEditorService, {} as IEditorService],
			[ISessionsLayoutService, { openEntry: async entry => { entries.push(entry); } } as ISessionsLayoutService],
		));
		using contribution = services.createInstance(ChatWorkspaceContribution);
		await services.invokeFunction(CommandsRegistry.getCommand(SHOW_ASH_CHAT_COMMAND)!, 'restore');
		await services.invokeFunction(CommandsRegistry.getCommand(SHOW_CHAT_WORKSPACE_COMMAND)!);
		assert.equal(entries.length, 2);
		for (const entry of entries) {
			assert.equal(entry.workspaceMode, 'chat');
			assert.equal(entry.activityContext, ASH_CHAT_SELECTED_CONTEXT);
			assert.equal(entry.conversationKind, 'code');
			assert.equal(entry.newSessionCommand, 'sessions.open.new');
			assert.equal(entry.sidebarContainerId, CHAT_WORKSPACE_NAVIGATION_ID);
			assert.equal(entry.restoreCommand, SHOW_ASH_CHAT_COMMAND);
		}
	});

	test('choosing an Ash model from ChatGPT creates a separate Ash draft with the chosen model and plain text', async () => {
		const values = new Map<string, string>();
		const storage = { get: (key: string) => values.get(key), store: (key: string, value: string) => { values.set(key, value); } } as unknown as IStorageService;
		let mode = 'code';
		const state = observableValue<ChatGPTState>('draft', {
			localConversationId: 'chatgpt-draft', draft: 'Unsent prompt', voice: 'idle',
			conversations: [], messages: [], coworkTasks: [], attachments: [],
		} as unknown as ChatGPTState);
		const model = { provider: 'fixture-provider', model: 'fixture-model' };
		const calls: unknown[][] = [];
		using services = new InstantiationService(new ServiceCollection(
			[IConfigurationService, { getValue: () => false } as unknown as IConfigurationService],
			[IContextKeyService, { getValue: (key: string) => key === 'sessions.workspaceMode' ? mode : key === 'sessions.activity.chatgptSelected' } as unknown as IContextKeyService],
			[ISessionProviderScopeService, {
				getProviderScope: (provider: string) => {
					assert.equal(provider, LOCAL_AGENT_HOST_PROVIDER_ID);
					return { assertCurrent() { }, services: { models: { listModels: async () => [{ model, displayName: 'Fixture model', longContext: null }] } } };
				}
			} as unknown as ISessionProviderScopeService],
			[IChatGPTService, { state, newDraftRevision: 1 } as unknown as IChatGPTService],
			[ICommandService, { executeCommand: async (id: string) => { calls.push([id]); } } as ICommandService],
			[ISessionsManagementService, {
				createUntitledSession: (_title, _workspace, provider, activate) => { calls.push(['create', provider, activate]); return { untitledSessionId: 'new' }; },
				setUntitledSessionModel: (id, value) => { calls.push(['model', id, value]); },
			} as ISessionsManagementService],
			[ISessionsService, { openUntitledSession: (id: string) => { calls.push(['open', id]); } } as ISessionsService],
			[IStorageService, storage],
			[ILayoutService, { focus: () => { calls.push(['focus']); } } as ILayoutService],
		));
		const command = CommandsRegistry.getCommand(OPEN_ASH_CHAT_WITH_MODEL_COMMAND)!;
		await services.invokeFunction(command, model);
		assert.deepEqual(calls, []);

		mode = 'chat';
		await assert.rejects(async () => services.invokeFunction(command, { provider: 'chatgpt', model: 'fixture' }), /no longer available/);
		assert.deepEqual(calls, []);

		const draft = state.get();
		state.set({ ...draft, conversationId: 'existing' }, undefined);
		await services.invokeFunction(command, model);
		assert.deepEqual(calls, []);
		state.set(draft, undefined);

		await services.invokeFunction(command, model);
		assert.deepEqual(calls, [['create', LOCAL_AGENT_HOST_PROVIDER_ID, false], ['model', 'new', model], [SHOW_ASH_CHAT_COMMAND], ['open', 'new'], ['focus']]);
		assert.deepEqual(readNewChatDraftState(storage, 'untitled:new', chatInputStatePersistence), { text: 'Unsent prompt', mode: 'agent', contexts: [] });
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
			[IStorageService, testStorage],
			[IContextKeyService, resources.add(new ContextKeyService())],
			[IChatGPTService, { state, initialize() { }, select: async (id: string) => { opened.push(id); } } as unknown as IChatGPTService],
			[ISessionsSearchService, {
				registerSource: value => { source = value; return toDisposable(() => { source = undefined; }); },
			} as ISessionsSearchService],
			[IEditorService, { focusActiveEditor: () => { opened.push('focus'); } } as unknown as IEditorService],
			[ISessionsLayoutService, { openEntry: async () => { opened.push('open'); } } as unknown as ISessionsLayoutService],
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
