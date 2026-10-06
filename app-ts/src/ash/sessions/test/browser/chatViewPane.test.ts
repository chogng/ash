import { KeybindingTestServices } from '../../../workbench/services/keybinding/test/browser/keybindingTestServices.js';
import { ChatInputPart } from '../../../workbench/contrib/chat/browser/widget/input/chatInputPart.js';
import { ChatInputEditors } from '../../../workbench/contrib/chat/browser/widget/input/chatInputEditorRegistry.js';
import type { ChatInputDelegate } from '../../../workbench/contrib/chat/browser/widget/input/chatInput.js';
import { createTestModel } from '../../../platform/app-server/test/common/testAppServerProtocol.js';
import { ActionWidgetService, IActionWidgetService } from '../../../platform/actionWidget/browser/actionWidget.js';
import { ILanguageModelsService, LanguageModelsService } from '../../../workbench/contrib/chat/common/languageModels.js';
import { ChatModelPreferences, LanguageModelsConfigurationService } from '../../../workbench/contrib/chat/browser/languageModelsConfigurationService.js';
import { ILanguageModelsConfigurationService } from '../../../workbench/contrib/chat/common/languageModelsConfiguration.js';
import { CoworkModelPreferences } from '../../contrib/cowork/common/languageModels.js';
import { CoworkWidgetModel } from '../../contrib/cowork/browser/coworkWidgetModel.js';
import { ILanguageModelsConfigurationService as ICoworkModelPreferences } from '../../contrib/cowork/common/languageModelsConfiguration.js';
import { LanguageModelsConfigurationService as CoworkModelPreferencesService } from '../../contrib/cowork/browser/languageModelsConfigurationService.js';
import { initializeTestLocalization } from '../../../workbench/services/localization/test/common/localizationTestUtils.js';
import { resetNlsResolver } from '../../../nls.js';
import { IModelApi } from '../../../platform/sessions/common/sessionApi.js';
import { IAppServerApi, IServerEventApi } from '../../../platform/app-server/common/appServerApi.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { registerTestDictationOnboarding } from '../../../workbench/test/common/testDictationServices.js';
import { IDictationService } from '../../../platform/dictation/common/dictationService.js';
import { ChatSpeechToTextService, IChatSpeechToTextService } from '../../../workbench/contrib/chat/browser/speechToText/chatSpeechToTextService.js';
import { createTestEditorServices } from '../../../workbench/test/common/testEditorServices.js';
import { IFileTextModelService } from '../../../workbench/services/textmodelResolver/common/textModelResourceService.js';
import assert from "node:assert/strict";
import { test, suiteTeardown } from "mocha";
import { JSDOM } from "jsdom";
import type { ModelRef, QueueEnqueueParams, ServerNotification, Session as SessionDto, SessionCreateParams, Thread, ThreadTranscriptSnapshot } from "../../../platform/app-server/common/generated/index.js";
import type { SessionMutationParams, SessionOperationInput } from "../../../platform/sessions/common/sessionApi.js";
import type { IRendererHost } from "../../../platform/renderer/common/rendererHost.js";
import type { IAction } from "../../../base/common/actions.js";
import { Emitter, Event } from "../../../base/common/event.js";
import { DeferredPromise } from '../../../base/common/async.js';
import { SessionsService } from '../../services/sessions/browser/sessionsService.js';
import { DisposableStore, toDisposable } from '../../../base/common/lifecycle.js';
import { INotificationService } from '../../../platform/notification/common/notification.js';
import { TAB_CLOSE_ACTION_ID } from "../../../base/browser/ui/tablist/tabList.js";
import { Lxicon } from "../../../base/common/lxicons.js";
import { MenuId } from "../../../platform/actions/common/actions.js";
import { MenuService } from "../../../platform/actions/common/menuService.js";
import { IContextViewService } from "../../../platform/contextview/browser/contextView.js";
import type { IContextMenuService } from "../../../platform/contextview/browser/contextView.js";
import { IAccessibleViewService } from '../../../platform/accessibility/browser/accessibleView.js';
import { NotificationService } from '../../../workbench/services/notification/common/notificationService.js';
import { InstantiationService } from "../../../platform/instantiation/common/instantiationService.js";
import { IQuickInputService } from "../../../platform/quickinput/common/quickInput.js";
import { CommandService } from "../../../workbench/services/commands/common/commandService.js";
import type { ViewPaneContainer } from "../../../workbench/browser/parts/views/viewPaneContainer.js";
import { ViewContainerLocation, WorkbenchViewRegistry } from "../../../workbench/common/views.js";
import { chatTranscriptListItems, chatListItem, chatTurnErrorListItem, type ChatTurnErrorAction } from "../../../workbench/contrib/chat/browser/widget/chatListItems.js";
import { ChatWidgetModel } from "../../browser/chatWidgetModel.js";
import { CHAT_VIEW_CONTAINER_ID, CHAT_VIEW_ID, MOVE_CHAT_TO_EDITOR_COMMAND_ID, MOVE_CHAT_TO_NEW_WINDOW_COMMAND_ID, NEW_CHAT_COMMAND_ID, OPEN_CHAT_BROWSER_COMMAND_ID, OPEN_CHAT_SETTINGS_COMMAND_ID, SHOW_CHAT_HISTORY_COMMAND_ID, TOGGLE_AGENT_SESSIONS_SIDEBAR_COMMAND_ID } from "../../../workbench/contrib/chat/common/chat.js";
import { IPreferencesService, type IPreferencesService as PreferencesService } from "../../../workbench/services/preferences/common/preferences.js";
import { PreferencesService as BrowserPreferencesService } from "../../../workbench/services/preferences/browser/preferencesService.js";
import { emptyEditorServiceState } from '../../../workbench/test/common/testEditorService.js';
import { IWorkbenchLayoutService, type WorkbenchPartId, type WorkbenchPartVisibilityChangeEvent } from "../../../workbench/services/layout/browser/layoutService.js";
import { ChatService } from "../../../workbench/services/chat/browser/chatService.js";
import { IChatService, type AdvisorConfig, type ModelProviderCredentialStatus, type ThreadTranscriptUpdateEnvelope, type ThreadUpdateEnvelope, type TurnError } from "../../../workbench/services/chat/common/chatService.js";
import { Extensions as ConfigurationExtensions, type IConfigurationRegistry } from '../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../platform/registry/common/platform.js';
import { ModelCatalogConfiguration } from "../../../workbench/contrib/chat/common/languageModelsConfiguration.js";
import { WorkbenchConfigurationService } from "../../../workbench/services/configuration/browser/configurationService.js";
import { SessionsManagementService as BaseSessionsManagementService } from "../../services/sessions/browser/sessionsManagementService.js";
import { AppServerSessionsProvider } from "../../contrib/providers/appServer/browser/appServerSessionsProvider.js";
import type { ISession } from "../../services/sessions/common/session.js";
import { ISessionsManagementService } from "../../services/sessions/common/sessionsManagement.js";
import { IViewsService } from "../../../workbench/services/views/common/viewsService.js";
import { ViewsService } from "../../../workbench/services/views/browser/viewsService.js";
import { ContextKeyService, IContextKeyService } from "../../../platform/contextkey/browser/contextKeyService.js";
import { DialogResult, IDialogService, type IMessageDialogOptions } from '../../../platform/dialogs/common/dialogs.js';
import { ViewDescriptorService } from "../../../workbench/services/views/browser/viewDescriptorService.js";
import { WorkbenchQuickInputService } from "../../../workbench/services/quickinput/browser/quickInputService.js";
import { h } from "../../../base/browser/dom.js";
import type { IFileService } from '../../../platform/files/common/files.js';
import { URI } from "../../../base/common/uri.js";
import { ICommandService } from "../../../platform/commands/common/commands.js";
import type { IOpenerService, OpenOptions } from "../../../platform/opener/common/opener.js";
import type { IEditorService } from "../../../workbench/services/editor/common/editorService.js";
import { IStorageService } from '../../../platform/storage/common/storage.js';
import { ChatTipService, IChatTipService } from '../../../workbench/contrib/chat/browser/chatTipService.js';
import { BrowserLifecycleService } from '../../../workbench/services/lifecycle/browser/lifecycleService.js';
import { ILifecycleService } from '../../../workbench/services/lifecycle/common/lifecycle.js';

const inputResources = new DisposableStore();
suiteTeardown(() => inputResources.dispose());
function createInputServices(contextView: IContextViewService, chat: IChatService): InstantiationService {
	const services = inputResources.add(createTestEditorServices(undefined, createCodeEditorServices(inputResources)));
	services.registerInstance(IContextViewService, contextView);
	services.registerSingleton(IActionWidgetService, () => services.createInstance(ActionWidgetService));
	services.registerInstance(ILanguageModelsService, modelsFor(chat));
	services.registerInstance(IAccessibleViewService, unavailableAccessibleViewService);
	services.registerInstance(IDictationService, undefined);
	services.registerSingleton(IChatSpeechToTextService, () => services.createInstance(ChatSpeechToTextService));
	registerTestDictationOnboarding(services);
	return services;
}
function createChatListWidget(container: HTMLElement, options: ConstructorParameters<typeof ChatListWidget>[1] = {}): InstanceType<typeof ChatListWidget> {
	const services = inputResources.add(createTestEditorServices(undefined, createCodeEditorServices(inputResources)));
	return services.createInstance(ChatListWidget, container, options);
}
const browserEnvironment = new JSDOM("<!doctype html><body></body>");
const unavailableFileService = {
	readFileBytes: async () => { throw new Error('File read is unavailable in this test'); },
} as unknown as IFileService;
const unavailableAccessibleViewService = { getOpenAriaHint: () => undefined } as unknown as IAccessibleViewService;
const notifications = new NotificationService();

class SessionsManagementService extends BaseSessionsManagementService {
	constructor(api: IRendererHost) {
		const services = inputResources.add(new InstantiationService());
		services.registerInstance(IAppServerApi, api.appServer);
		super(services.createInstance(AppServerSessionsProvider, { session: api.session, model: api.model, turn: api.turn, events: api.events, workspace: () => ({ type: 'current' }), selectWorkspace: async () => undefined }));
	}
}
for (const [name, value] of Object.entries({
	window: browserEnvironment.window,
	document: browserEnvironment.window.document,
	Node: browserEnvironment.window.Node,
	Element: browserEnvironment.window.Element,
	HTMLElement: browserEnvironment.window.HTMLElement,
	Event: browserEnvironment.window.Event,
	MouseEvent: browserEnvironment.window.MouseEvent,
})) {
	Object.defineProperty(globalThis, name, {
		configurable: true,
		value,
	});
}
const { registerChatViews } = await import(
	"../../browser/workbenchChat.contribution.js"
);
const { BrowserContextViewService } = await import(
	"../../../platform/contextview/browser/contextViewService.js"
);
const { ChatViewPane } = await import(
	"../../browser/chatViewPane.js"
);
const { ChatListWidget } = await import(
	"../../../workbench/contrib/chat/browser/widget/chatListWidget.js"
);
const { BrowserStorageService } = await import('../../../workbench/services/storage/browser/storageService.js');
const testStorageEnvironment = new JSDOM('', { url: 'https://ash.test/' });
const storageResources = new DisposableStore();
const testStorages: InstanceType<typeof BrowserStorageService>[] = [];
const { ChatWidget, openChatMarkdownLink } = await import("../../../workbench/contrib/chat/browser/widget/chatWidget.js");
const { NewChatInputWidget } = await import('../../contrib/chat/browser/newChatInput.js');
const { readNewChatDraftState } = await import('../../contrib/chat/common/newChatDraftState.js');
const { createCodeEditorServices } = await import('../../../editor/test/browser/testCodeEditor.js');
await import(
	"../../../workbench/contrib/preferences/browser/preferences.contribution.js"
);
suiteTeardown(() => {
	for (const storage of testStorages) storage.dispose();
	testStorageEnvironment.window.close();
	storageResources.dispose();
	browserEnvironment.window.close();
	for (const name of [
		"window",
		"document",
		"Node",
		"Element",
		"HTMLElement",
		"Event",
		"MouseEvent",
	]) {
		Reflect.deleteProperty(globalThis, name);
	}
});

test("Chat Markdown links route resource, command, and external targets through their owning services", async () => {
	const editorResources: URI[] = [];
	const externalTargets: { target: string; options: OpenOptions; }[] = [];
	const commands: Array<{ readonly id: string; readonly args: readonly unknown[]; }> = [];
	const editorService = {
		openEditor: async ({ resource }: { readonly resource: URI; }) => { editorResources.push(resource); },
	} as unknown as IEditorService;
	const openerService = {
		open: async (target: string, options: OpenOptions) => { externalTargets.push({ target, options }); },
	} as unknown as IOpenerService;
	const commandService = {
		executeCommand: async (id: string, ...args: readonly unknown[]) => { commands.push({ id, args }); },
	} as unknown as ICommandService;

	await openChatMarkdownLink("vscode-remote://ssh-remote+host/src/file.ts", commandService, openerService, editorService);
	await openChatMarkdownLink('ash-remote://ssh+host/src/ash.ts', commandService, openerService, editorService);
	await openChatMarkdownLink("vscode-file://vscode-app/workspace/readme.md", commandService, openerService, editorService);
	await openChatMarkdownLink('vscode-remote-resource://ssh-remote+host/workspace/image.png', commandService, openerService, editorService);
	await openChatMarkdownLink('vscode-notebook-cell:///workspace/notebook.ipynb#cell-4', commandService, openerService, editorService);
	await openChatMarkdownLink('vscode-file://other-host/workspace/secret.md', commandService, openerService, editorService);
	await openChatMarkdownLink('vscode-remote-resource://127.0.0.1:9999/vscode-remote-resource?path=%2Fworkspace%2Fsecret.png', commandService, openerService, editorService);
	await openChatMarkdownLink("command:ash.open?%5B%22readme.md%22%5D", commandService, openerService, editorService);
	await openChatMarkdownLink("mailto:help@example.com", commandService, openerService, editorService);
	await openChatMarkdownLink('https://example.com/docs', commandService, openerService, editorService);
	await openChatMarkdownLink("private:///workbench/resource", commandService, openerService, editorService);
	await openChatMarkdownLink("#section", commandService, openerService, editorService);

	assert.deepEqual(editorResources.map(resource => resource.toString()), [
		'ash-remote://ssh+host/src/file.ts',
		'ash-remote://ssh+host/src/ash.ts',
		'file:///workspace/readme.md',
		'ash-remote://ssh+host/workspace/image.png',
		'vscode-notebook-cell:///workspace/notebook.ipynb#cell-4',
	]);
	assert.deepEqual(commands, [{ id: "ash.open", args: ["readme.md"] }]);
	assert.deepEqual(externalTargets, ['mailto:help@example.com', 'https://example.com/docs'].map(target => ({ target, options: { openExternal: true, fromUserGesture: true, allowContributedOpeners: true } })));
});

test('Chat loads an Ash remote workspace image through the file service', async () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	dom.window.HTMLElement.prototype.scrollTo = () => { };
	const resource = 'ash-remote://ssh+host/workspace/pixel.png';
	const fake = fakeApi({ sessions: [session('session-1', 'thread-1')], thread: () => thread(`![pixel](${resource})`) });
	const requests: URI[] = [];
	const fileService = {
		readFileBytes: async (requested: URI) => {
			requests.push(requested);
			return { resource: requested, bytes: new Uint8Array([137, 80, 78, 71]), revision: '1' };
		},
	} as unknown as IFileService;
	const objectUrl = 'blob:https://ash.invalid/remote-image';
	Object.defineProperty(dom.window.URL, 'createObjectURL', { configurable: true, value: () => objectUrl });
	Object.defineProperty(dom.window.URL, 'revokeObjectURL', { configurable: true, value: () => undefined });
	try {
		using contextViewService = new BrowserContextViewService(dom.window.document.body);
		using sessions = new SessionsManagementService(fake.api);
		using contextKeys = new ContextKeyService();
		const services = new InstantiationService();
		using commands = new CommandService(services);
		const menuService = new MenuService(commands, contextKeys);
		const contextMenuService = { showContextMenu: () => undefined } as unknown as IContextMenuService;
		const paneChat = createChatService(fake.api);
		using pane = new ChatViewPane(
			dom.window.document.body,
			{ id: CHAT_VIEW_ID, title: 'Chat' },
			paneChat,
			sessions,
			menuService,
			contextMenuService,
			contextViewService,
			commands,
			testLayoutService(),
			fileService,
			unavailableAccessibleViewService,
			notifications,
			createInputServices(contextViewService, paneChat), contextKeys,
		);
		dom.window.document.body.append(pane.element);
		await sessions.initialize();
		await waitFor(() => pane.element.querySelector('img')?.getAttribute('src') === objectUrl);
		assert.deepEqual(requests.map(requested => requested.toString()), [resource]);
		assert.equal(pane.element.querySelector('img')?.getAttribute('alt'), 'pixel');
	} finally {
		dom.window.close();
	}
});

function chatTitleContent(pane: { readonly partTitleProjection: { readonly content?: HTMLElement; } | undefined; }): HTMLElement {
	const content = pane.partTitleProjection?.content;
	assert.ok(content);
	return content;
}

function chatTitleActions(pane: { readonly partTitleProjection: { readonly actions?: HTMLElement; } | undefined; }): HTMLElement {
	const actions = pane.partTitleProjection?.actions;
	assert.ok(actions);
	return actions;
}

test("Chat contribution owns the fixed Auxiliary Bar view", () => {
	const registry = new WorkbenchViewRegistry();

	registerChatViews(registry);

	assert.equal(
		registry.getDefaultViewContainer(ViewContainerLocation.AuxiliaryBar)?.id,
		CHAT_VIEW_CONTAINER_ID,
	);
	assert.deepEqual(
		registry.getViews(CHAT_VIEW_CONTAINER_ID).map((view) => view.id),
		[CHAT_VIEW_ID],
	);
	assert.equal(registry.getDefaultViewContainer(ViewContainerLocation.AgentSidebar), undefined);
});

test("Chat title separates Session tabs from its action toolbar", async () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	dom.window.HTMLElement.prototype.scrollTo = () => { };
	using contextViewService = new BrowserContextViewService(dom.window.document.body);
	const subscriptionModel = {
		model: { provider: "openai", model: "gpt-6.1-sol" },
		displayName: "GPT-6.1 Sol",
		contextWindow: 128000,
		supportedReasoningEfforts: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }] as const,
		defaultReasoningEffort: 'medium' as const,
	};
	const fake = fakeApi({
		sessions: [
			{ ...session("session-1", "thread-1"), model: subscriptionModel.model },
			{ ...session("session-2", "thread-2"), model: subscriptionModel.model },
		],
		models: [subscriptionModel],
	});
	const api = fake.api;
	using sessions = new SessionsManagementService(api);
	using contextKeys = new ContextKeyService();
	using viewDescriptors = new ViewDescriptorService({
		registry: new WorkbenchViewRegistry(),
	}, contextKeys);
	const services = new InstantiationService();
	let preferencesEditorTarget: import('../../../workbench/services/editor/common/editorService.js').EditorOpenTarget | undefined;
	using chat = createChatService(api);
	using quickInput = new WorkbenchQuickInputService({ container: dom.window.document.body, contextKeyService: contextKeys });
	using keybindingFiles = new KeybindingTestServices();
	using editorServices = createTestEditorServices(undefined, keybindingFiles.services);
	using preferences: PreferencesService = new BrowserPreferencesService({
		...emptyEditorServiceState,
		openEditor: async (_input, _options, target) => { preferencesEditorTarget = target; },
		focusActiveEditor() { },
	}, editorServices.get(IFileTextModelService), keybindingFiles.files, keybindingFiles.profiles);
	services.registerInstance(IPreferencesService, preferences);
	services.registerInstance(IChatService, chat);
	services.registerInstance(ILanguageModelsService, modelsFor(chat));
	services.registerInstance(IQuickInputService, quickInput);
	services.registerInstance(IContextKeyService, contextKeys);
	using commands = new CommandService(services);
	const menuService = new MenuService(commands, contextKeys);
	const layout = testLayoutService();
	let chatView: InstanceType<typeof ChatViewPane> | undefined;
	services.registerInstance(IWorkbenchLayoutService, layout);
	services.registerInstance(IViewsService, {
		openView: async () => chatView,
		focusView: async () => true,
		getViewWithId: () => chatView,
	} as unknown as IViewsService);
	let shownContextMenuActions: readonly IAction[] = [];
	const contextMenuService = {
		showContextMenu: (options: { readonly getActions: () => readonly IAction[]; }) => {
			shownContextMenuActions = options.getActions();
		},
	} as unknown as IContextMenuService;
	using pane = new ChatViewPane(
		dom.window.document.body,
		{
			id: CHAT_VIEW_ID,
			title: "Chat",
		},
		chat,
		sessions,
		menuService,
		contextMenuService,
		contextViewService,
		commands,
		layout,
		unavailableFileService,
		unavailableAccessibleViewService,
		notifications,
		createInputServices(contextViewService, chat), contextKeys,
	);
	chatView = pane;
	const title = h(dom.window.document, "div");
	title.className = "ash-pane-composite-title";
	title.append(chatTitleContent(pane), chatTitleActions(pane));
	dom.window.document.body.append(title, pane.element);

	await sessions.initialize();
	await nextTask();

	const tablist = title.querySelector(
		".ash-chat-tabs-control .ash-action-bar",
	);
	const toolbar = title.querySelector(
		".ash-chat-title-actions > .ash-action-bar",
	);
	const layoutToolbar = title.querySelector<HTMLElement>(
		".ash-chat-title-layout-actions",
	);
	assert.equal(tablist?.getAttribute("role"), "tablist");
	assert.equal(toolbar?.getAttribute("role"), "toolbar");
	assert.equal(toolbar?.classList.contains("ash-toolbar"), true);
	assert.equal(
		chatTitleContent(pane).nextElementSibling,
		chatTitleActions(pane),
	);
	assert.deepEqual(
		[...toolbar?.querySelectorAll<HTMLElement>("[data-action-id]") ?? []]
			.map((item) => item.dataset.actionId),
		[
			NEW_CHAT_COMMAND_ID,
			SHOW_CHAT_HISTORY_COMMAND_ID,
			"ash.toolbar.moreActions",
		],
	);
	assert.deepEqual(
		[...toolbar?.querySelectorAll<HTMLButtonElement>("button") ?? []]
			.map((button) => button.title),
		["New Chat", "Show Chat History", "More Actions"],
	);
	assert.equal(
		toolbar?.querySelectorAll(".ash-action-view-item.icon").length,
		3,
	);
	assert.ok(toolbar?.querySelector(".ash-button-label"));
	assert.ok(toolbar?.querySelector("svg.ash-icon"));
	assert.ok(layoutToolbar?.querySelector(
		`[data-action-id="${TOGGLE_AGENT_SESSIONS_SIDEBAR_COMMAND_ID}"]`,
	));
	layoutToolbar?.querySelector<HTMLButtonElement>("button")?.focus();
	await commands.executeCommand(TOGGLE_AGENT_SESSIONS_SIDEBAR_COMMAND_ID);
	const sessionsSidebar = pane.element.querySelector<HTMLElement>('.ash-chat-sessions-sidebar');
	assert.equal(sessionsSidebar?.hidden, false);
	assert.equal(contextKeys.getValue('agentSessionsSidebarVisible'), true);
	assert.deepEqual([...sessionsSidebar?.querySelectorAll<HTMLButtonElement>('.ash-agent-session-row') ?? []].map(button => button.title), ['Session session-1', 'Session session-2']);
	assert.equal(sessionsSidebar?.contains(dom.window.document.activeElement), true);
	sessionsSidebar?.querySelectorAll<HTMLButtonElement>('.ash-agent-session-row')[1]?.click();
	assert.equal(sessions.active?.session.sessionId, 'session-2');
	const search = sessionsSidebar?.querySelector<HTMLInputElement>('.ash-agent-sessions-search');
	assert.ok(search);
	search.value = 'session-1';
	search.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
	assert.deepEqual([...sessionsSidebar?.querySelectorAll<HTMLButtonElement>('.ash-agent-session-row') ?? []].map(button => button.title), ['Session session-1']);
	search.value = '';
	search.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
	sessionsSidebar?.querySelector<HTMLButtonElement>('.ash-chat-sessions-new')?.click();
	const draftId = sessions.activeUntitledSession?.untitledSessionId;
	assert.ok(draftId);
	assert.equal(sessionsSidebar?.querySelector<HTMLElement>('.ash-agent-sessions-group')?.hidden, false);
	const paneHost = pane.element.querySelector<HTMLElement>('.ash-chat-pane-host');
	assert.ok(paneHost);
	const activeTab = chatTitleContent(pane).querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
	const paneChanges = new dom.window.MutationObserver(() => { });
	paneChanges.observe(paneHost, { childList: true });
	sessions.setUntitledSessionAgent(draftId, { name: 'reviewer', description: 'Reviews changes', sourceId: 'directory-1' });
	assert.equal(paneChanges.takeRecords().flatMap(record => [...record.removedNodes]).length, 0);
	assert.equal(chatTitleContent(pane).querySelector<HTMLElement>('[role="tab"][aria-selected="true"]'), activeTab);
	paneChanges.disconnect();
	sessions.discardUntitledSession(draftId);
	sessions.selectThread('session-1', 'thread-1');
	pane.element.querySelector(".ash-chat-body")!.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
	assert.equal(sessionsSidebar?.hidden, true);
	assert.equal(contextKeys.getValue('agentSessionsSidebarVisible'), false);
	assert.equal(dom.window.document.activeElement, layoutToolbar?.querySelector("button"));
	assert.equal(layoutToolbar?.hidden, false);
	const chatActions = menuService.getMenuActions(MenuId.ChatTitle)
		.filter(([group]) => group !== "navigation")
		.flatMap(([, actions]) => actions);
	assert.deepEqual(
		chatActions.map((action) => ({
			id: action.id,
			label: action.label,
			enabled: action.enabled,
			icon: action.icon,
		})),
		[
			{
				id: OPEN_CHAT_BROWSER_COMMAND_ID,
				label: "Open Browser",
				enabled: false,
				icon: Lxicon.browserWeb,
			},
			{
				id: MOVE_CHAT_TO_EDITOR_COMMAND_ID,
				label: "Move Chat to Editor Area",
				enabled: false,
				icon: Lxicon.layoutPanel1,
			},
			{
				id: MOVE_CHAT_TO_NEW_WINDOW_COMMAND_ID,
				label: "Move Chat to New Window",
				enabled: false,
				icon: Lxicon.linkExternal,
			},
			{
				id: OPEN_CHAT_SETTINGS_COMMAND_ID,
				label: "Chat Settings",
				enabled: true,
				icon: Lxicon.settings,
			},
		],
	);
	await chatActions[3]?.run();
	const settingsInput = dom.window.document.querySelector<HTMLInputElement>(".ash-quick-pick-input input");
	assert.ok(settingsInput);
	settingsInput.dispatchEvent(new dom.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }));
	assert.equal(preferencesEditorTarget, "modalGroup");
	const tabs = tablist?.querySelectorAll<HTMLButtonElement>("[role='tab']");
	assert.equal(tabs?.length, 2);
	assert.deepEqual(
		[...(tabs ?? [])].map((tab) => tab.getAttribute("aria-selected")),
		["true", "false"],
	);
	const panel = pane.element.querySelector("[role='tabpanel']");
	assert.equal(panel?.id, tabs?.[0]?.getAttribute("aria-controls"));
	assert.equal(panel?.getAttribute("aria-labelledby"), tabs?.[0]?.id);
	assert.equal(
		chatTitleContent(pane).querySelector(
			".ash-chat-tabs-control .ash-scrollable-element",
		)?.getAttribute("data-scroll-direction"),
		"horizontal",
	);
	assert.equal(
		pane.element.querySelector(
			".ash-chat-transcript-scrollable",
		)?.getAttribute("data-scroll-direction"),
		"vertical",
	);
	const chatPanes = pane.element.querySelectorAll<HTMLElement>(".ash-chat-pane-host > .ash-chat");
	assert.equal(chatPanes.length, 2);
	for (const chatPane of chatPanes) {
		assert.equal(chatPane.classList.contains("empty"), true);
		assert.equal(chatPane.classList.contains("has-conversation"), false);
		assert.equal(chatPane.querySelector<HTMLElement>(":scope > .ash-chat-goal")?.hidden, true);
		assert.ok(chatPane.querySelector(":scope > .ash-chat-list-widget"));
		assert.ok(chatPane.querySelector(":scope > .ash-chat-input-part"));
		const inputToolbar = chatPane.querySelector<HTMLElement>(".ash-chat-input-toolbars");
		assert.equal(inputToolbar?.getAttribute("role"), "toolbar");
		assert.deepEqual(
			[...inputToolbar?.querySelectorAll<HTMLElement>("[data-action-id]") ?? []].map((item) => item.dataset.actionId),
			[
				"ash.chat.input.mode",
				"ash.chat.input.model",
				"ash.chat.input.effort",
				"ash.chat.input.mic",
				"ash.chat.input.voice",
			],
		);
		assert.equal(inputToolbar?.querySelector<HTMLButtonElement>("[data-action-id='ash.chat.input.mode'] button")?.textContent, "Agent");
		assert.equal(inputToolbar?.querySelector<HTMLButtonElement>("[data-action-id='ash.chat.input.model'] button .ash-button-label")?.textContent, "GPT-6.1 Sol");
		assert.equal(inputToolbar?.querySelector<HTMLButtonElement>("[data-action-id='ash.chat.input.effort'] button")?.getAttribute('aria-label'), 'Model options: Medium');
		assert.equal(inputToolbar?.querySelector(".ash-chat-input-model-access-badge"), null);
		assert.equal(inputToolbar?.querySelector<HTMLButtonElement>("[data-action-id='ash.chat.input.mic'] button")?.disabled, true);
		assert.equal(inputToolbar?.querySelector<HTMLButtonElement>("[data-action-id='ash.chat.input.voice'] button")?.disabled, true);
	}
	const firstChatPane = chatPanes[0]!;
	const modelButton = firstChatPane.querySelector<HTMLButtonElement>("[data-action-id='ash.chat.input.model'] button");
	modelButton?.click();
	const modelPicker = dom.window.document.querySelector<HTMLElement>('.ash-chat-model-picker[role="dialog"]');
	assert.equal(modelPicker?.getAttribute('aria-label'), 'Choose a chat model');
	assert.equal(modelPicker?.closest('.ash-context-view')?.parentElement, contextViewService.container);
	assert.equal(modelButton?.getAttribute('aria-expanded'), 'true');
	assert.equal(modelPicker?.querySelector<HTMLInputElement>('input')?.placeholder, 'Search models');
	assert.match(modelPicker?.textContent ?? '', /GPT-6\.1 Sol/);
	assert.match(modelPicker?.querySelector('[role=menuitemradio]')?.getAttribute('aria-description') ?? '', /128,000 context tokens/);
	assert.match(modelPicker?.querySelector('[role=menuitemradio]')?.getAttribute('aria-description') ?? '', /Thinking: Low, Medium, High/);
	assert.equal(modelPicker?.classList.contains('ash-action-widget'), true);
	const modelSearch = modelPicker?.querySelector<HTMLInputElement>('input');
	assert.ok(modelSearch);
	modelSearch.value = 'no-such-model';
	modelSearch.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
	assert.equal(modelPicker?.querySelectorAll('[role=menuitemradio]').length, 0);
	modelSearch.value = 'GPT-6.1 Sol';
	modelSearch.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
	modelSearch.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
	assert.equal(dom.window.document.activeElement, modelPicker?.querySelector('[role=menuitemradio]'));
	modelSearch.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
	assert.equal(firstChatPane.querySelector<HTMLButtonElement>("[data-action-id='ash.chat.input.model'] button")?.getAttribute('aria-expanded'), 'false');
	firstChatPane.querySelector<HTMLButtonElement>("[data-action-id='ash.chat.input.effort'] button")?.click();
	const effortMenu = dom.window.document.querySelector<HTMLElement>('.ash-chat-model-configuration-menu');
	assert.equal(effortMenu?.querySelector('.ash-chat-model-configuration-heading')?.textContent, 'Thinking Level');
	assert.deepEqual([...effortMenu?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? []].map(button => button.textContent), ['Low', 'MediumDefault', 'High']);
	assert.equal(effortMenu?.querySelector('[role="menuitemradio"][aria-checked="true"]')?.textContent, 'MediumDefault');
	assert.equal(effortMenu?.querySelector('[role="menuitemradio"][aria-checked="true"]')?.getAttribute('aria-description'), 'Default');
	effortMenu?.querySelector<HTMLButtonElement>("[data-action-id='ash.chat.input.effort.high'] button")?.click();
	await waitFor(() => firstChatPane.querySelector<HTMLButtonElement>("[data-action-id='ash.chat.input.effort'] button")?.getAttribute('aria-label') === 'Model options: High');
	firstChatPane.querySelector<HTMLButtonElement>("[data-action-id='ash.chat.input.effort'] button")?.click();
	assert.equal(dom.window.document.querySelector('.ash-chat-model-configuration-menu [role="menuitemradio"][aria-checked="true"]')?.textContent, 'High');
	dom.window.document.querySelector<HTMLButtonElement>("[data-action-id='ash.chat.input.effort.medium'] button")?.click();
	await waitFor(() => firstChatPane.querySelector<HTMLButtonElement>("[data-action-id='ash.chat.input.effort'] button")?.getAttribute('aria-label') === 'Model options: Medium');
	shownContextMenuActions = [];
	firstChatPane.querySelector<HTMLButtonElement>("[data-action-id='ash.chat.input.mode'] button")?.click();
	assert.deepEqual(shownContextMenuActions, []);
	await waitFor(() => dom.window.document.querySelector('.ash-chat-input-mode-menu') !== null);
	const modeMenu = dom.window.document.querySelector<HTMLElement>(".ash-chat-input-mode-menu");
	assert.equal(modeMenu?.closest(".ash-context-view")?.parentElement, contextViewService.container);
	assert.deepEqual(
		[...modeMenu?.querySelectorAll<HTMLElement>("[data-action-id]") ?? []].map(item => item.textContent),
		['Agent', 'Plan', 'Debug', 'Multitask', 'Ask'],
	);
	assert.deepEqual(
		[...modeMenu?.querySelectorAll<HTMLElement>("[data-action-id]") ?? []].map(item => item.querySelector('.ash-menu-leading-slot .ash-icon-label-icon svg.ash-icon')?.getAttribute('data-ash-icon-id') ?? null),
		['unlimited', 'plan', 'debug', 'multitask', 'chat-4'],
	);
	assert.deepEqual(
		[...modeMenu?.querySelectorAll<HTMLButtonElement>("[role='menuitemradio']") ?? []].map(item => item.getAttribute('aria-checked')),
		['true', 'false', 'false', 'false', 'false'],
	);
	modeMenu?.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
	assert.equal(firstChatPane.querySelector<HTMLButtonElement>("[data-action-id='ash.chat.input.mode'] button")?.textContent, 'Agent');
	assert.equal(firstChatPane.querySelector(".ash-chat-input-mode-selector")?.classList.contains('mode-agent'), true);
	assert.equal(dom.window.document.querySelector(".ash-chat-input-mode-menu"), null);
	assert.deepEqual([...chatPanes].map((chatPane) => chatPane.hidden), [false, true]);
	const composerInputs = [...chatPanes].map((chatPane) => {
		const input = chatPane.querySelector<HTMLTextAreaElement>(".ash-chat-textarea-input");
		assert.ok(input);
		return input;
	});
	typeChatText(dom.window, composerInputs[0], "First draft");
	assert.equal(firstChatPane.querySelector<HTMLButtonElement>("[data-action-id='ash.chat.input.send'] button")?.disabled, false);
	assert.equal(firstChatPane.querySelector("[data-action-id='ash.chat.input.voice']"), null);

	tabs?.[1]?.click();
	assert.equal(sessions.active?.session.sessionId, "session-2");
	assert.equal(sessions.active?.threadId, "thread-2");
	assert.deepEqual(
		[...chatTitleContent(pane).querySelectorAll<HTMLElement>("[role='tab']")]
			.map((tab) => tab.getAttribute("aria-selected")),
		["false", "true"],
	);
	assert.deepEqual([...chatPanes].map((chatPane) => chatPane.hidden), [true, false]);
	typeChatText(dom.window, composerInputs[1], "Second draft");
	chatTitleContent(pane).querySelectorAll<HTMLButtonElement>("[role='tab']")[0]?.click();
	assert.equal(sessions.active?.session.sessionId, "session-1");
	assert.deepEqual([...chatPanes].map((chatPane) => chatPane.hidden), [false, true]);
	assert.equal(composerInputs[0]?.value, "First draft");
	assert.equal(composerInputs[1]?.value, "Second draft");

	const closeButtons = chatTitleContent(pane).querySelectorAll<HTMLButtonElement>(
		`[data-action-id="${TAB_CLOSE_ACTION_ID}"] button`,
	);
	assert.equal(closeButtons.length, 2);
	assert.deepEqual(
		[...closeButtons].map((button) => button.title),
		["Close Session session-1", "Close Session session-2"],
	);
	closeButtons[0]?.click();
	await nextTask();

	assert.deepEqual(
		fake.stopRequests.map(({ sessionId }) => ({ sessionId })),
		[{ sessionId: "session-1" }],
	);
	assert.equal(sessions.active?.session.sessionId, "session-2");
	assert.deepEqual(
		[...chatTitleContent(pane).querySelectorAll<HTMLElement>("[role='tab']")]
			.map((tab) => ({
				label: tab.textContent,
				selected: tab.getAttribute("aria-selected"),
			})),
		[{ label: "Session session-2", selected: "true" }],
	);
	assert.equal(
		pane.element.querySelector<HTMLElement>(".ash-chat-pane-host > .ash-chat")
			?.dataset.sessionId,
		"session-2",
	);

	chatTitleContent(pane).querySelector<HTMLButtonElement>(`[data-action-id="${TAB_CLOSE_ACTION_ID}"] button`)?.click();
	await waitFor(() => !layout.isPartVisible("auxiliarybar"));
	assert.equal(chatTitleContent(pane).querySelectorAll("[role='tab']").length, 0);
	assert.equal(sessions.active, undefined);
	assert.equal(sessions.untitledSessions.length, 0);

	layout.showPart("auxiliarybar");
	await waitFor(() => chatTitleContent(pane).querySelectorAll("[role='tab']").length === 1);
	assert.equal(chatTitleContent(pane).querySelector<HTMLElement>("[role='tab']")?.textContent, "New Chat");
	assert.equal(sessions.untitledSessions.length, 1);

	chatTitleContent(pane).querySelector<HTMLButtonElement>(`[data-action-id="${TAB_CLOSE_ACTION_ID}"] button`)?.click();
	assert.equal(layout.isPartVisible("auxiliarybar"), false);
	assert.equal(chatTitleContent(pane).querySelectorAll("[role='tab']").length, 0);
	assert.equal(sessions.untitledSessions.length, 0);

	dom.window.close();
});

test("Empty chat transcripts do not render a redundant placeholder", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	using list = createChatListWidget(dom.window.document.body);

	list.render([]);

	assert.equal(list.element.querySelector(".ash-chat-empty"), null);
	assert.equal(list.element.textContent, "");
	dom.window.close();
});

test("Chat transcript reuses unchanged messages while replacing changed content", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	using list = createChatListWidget(dom.window.document.body);
	const first = { id: "first", type: "agentMessage" as const, text: "Original **answer**", transient: false };
	const second = { id: "second", type: "userMessage" as const, text: "Question", transient: false };
	list.render([first, second]);
	const firstElement = list.element.querySelector<HTMLElement>('[data-item-id="first"]');
	const secondElement = list.element.querySelector<HTMLElement>('[data-item-id="second"]');
	assert.ok(firstElement && secondElement);

	list.render([second, { ...first, text: "Revised **answer**" }]);

	assert.deepEqual([...list.element.querySelectorAll<HTMLElement>(".ash-chat-item")].map(element => ({
		id: element.dataset.itemId,
		reused: element === secondElement,
	})), [{ id: "second", reused: true }, { id: "first", reused: false }]);
	assert.equal(firstElement.isConnected, false);
	assert.equal(list.element.querySelector("strong")?.textContent, "answer");
	dom.window.close();
});

test("Chat transcript keeps the first visible message in place when history is prepended", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	using list = createChatListWidget(dom.window.document.body);
	const viewport = list.element.querySelector<HTMLElement>(".ash-scrollbar-viewport")!;
	const transcript = list.element.querySelector<HTMLElement>(".ash-chat-transcript")!;
	Object.defineProperties(viewport, {
		clientHeight: { configurable: true, get: () => 100 },
		scrollHeight: { configurable: true, get: () => transcript.childElementCount * 100 },
	});
	const rect = (top: number, bottom: number): DOMRect => ({ top, bottom, left: 0, right: 100, width: 100, height: bottom - top, x: 0, y: top, toJSON: () => ({}) });
	viewport.getBoundingClientRect = () => rect(0, 100);
	transcript.getBoundingClientRect = () => rect(-viewport.scrollTop, transcript.childElementCount * 100 - viewport.scrollTop);
	const item = (id: string) => ({ id, type: "userMessage" as const, text: id, transient: false });
	list.render([item("one"), item("two"), item("three")]);
	for (const element of transcript.children) {
		(element as HTMLElement).getBoundingClientRect = () => {
			const top = [...transcript.children].indexOf(element) * 100 - viewport.scrollTop;
			return rect(top, top + 100);
		};
	}
	list.setVisible(true);
	viewport.scrollTop = 100;

	list.render([item("zero"), item("one"), item("two"), item("three")]);

	assert.equal(viewport.scrollTop, 200);
	dom.window.close();
});

test("Turn error cards invoke their typed action without interpreting message text", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	let requestedAction: ChatTurnErrorAction | undefined;
	using list = createChatListWidget(dom.window.document.body, {
		onDidRequestErrorAction: (action) => { requestedAction = action; },
	});
	const item = chatTurnErrorListItem(failedTurn("providerAuth", false, "same opaque message"));
	assert.ok(item);

	list.render([item]);
	list.element.querySelector<HTMLButtonElement>(".ash-chat-turn-error-action")?.click();

	assert.equal(list.element.querySelector(".ash-chat-item-label")?.textContent, "Authentication");
	assert.equal(list.element.querySelector("pre")?.textContent, "same opaque message");
	assert.deepEqual(requestedAction, { type: "chooseModel", label: "Choose another model" });
	dom.window.close();
});

test('sending from one session preserves a later draft during first-session creation', async () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	using domLifetime = toDisposable(() => dom.window.close());
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using editorResources = new DisposableStore();
	const editorServices = editorResources.add(createTestEditorServices(undefined, createCodeEditorServices(editorResources)));
	editorServices.registerInstance(IDictationService, undefined);
	editorServices.registerSingleton(IChatSpeechToTextService, () => editorServices.createInstance(ChatSpeechToTextService));
	using contextViewService = new BrowserContextViewService(dom.window.document.body);
	editorServices.registerInstance(IAccessibleViewService, unavailableAccessibleViewService);
	editorServices.registerInstance(INotificationService, notifications);
	const composerStorage = editorResources.add(createTestStorage());
	editorServices.registerInstance(IStorageService, composerStorage);
	registerTestDictationOnboarding(editorServices);
	editorServices.registerInstance(IChatTipService, editorResources.add(editorServices.createInstance(ChatTipService)));
	Object.defineProperty(dom.window.performance, 'getEntriesByType', { value: () => [] });
	editorServices.registerInstance(ILifecycleService, editorResources.add(editorServices.createInstance(BrowserLifecycleService, { ownerWindow: dom.window as unknown as Window, onError: (error: unknown) => { throw error; } })));
	const fake = fakeApi({
		sessions: [],
		createSession: session('session-1', undefined, 'New Chat'),
		createThread: { session: session('session-1', 'thread-1', 'New Chat'), threadId: 'thread-1' },
	});
	using sessions = new SessionsManagementService(fake.api);
	await sessions.initialize();
	editorServices.registerInstance(ISessionsManagementService, sessions);
	using view = editorServices.createInstance(SessionsService);
	await view.initialize();
	view.openNewSession();
	const draft = view.activeSelection;
	if (draft?.kind !== 'untitled') throw new Error('Expected Code draft');
	using commands = new CommandService(new InstantiationService());
	editorServices.registerInstance(ICommandService, commands);
	editorServices.registerInstance(IContextViewService, contextViewService);
	using chat = createChatService(fake.api);
	editorServices.registerInstance(ILanguageModelsService, modelsFor(chat));
	const widgetModel = createWidgetModel(chat, { kind: 'untitled', session: draft.session }, sessions);
	using widget = new ChatWidget(
		dom.window.document.body,
		'centered-chat',
		widgetModel,
		() => sessions.createUntitledSession(),
		{ showContextMenu: () => undefined } as unknown as IContextMenuService,
		contextViewService,
		commands,
		unavailableAccessibleViewService,
		notifications,
		undefined,
		undefined,
		undefined,
		(container, delegate) => editorServices.createInstance(NewChatInputWidget, container, delegate, widgetModel),
		editorServices,
	);
	widget.setVisible(true);
	const input = widget.element.querySelector<HTMLElement>('.ash-chat-input-part');
	const heading = widget.element.querySelector<HTMLHeadingElement>('.ash-sessions-chat-welcome-heading');
	assert.equal(heading?.hidden, false);
	assert.equal(input?.classList.contains('chat-composer'), true);
	const welcomeTip = input?.querySelector('.ash-chat-input-tip');
	assert.ok(welcomeTip);
	assert.deepEqual([input?.getAttribute('aria-busy'), input?.querySelector('.ash-chat-status')?.textContent], ['true', '']);
	await widgetModel.initialize();
	assert.equal(input?.getAttribute('aria-busy'), 'false');
	assert.equal(input?.querySelector('.ash-chat-input-tip'), welcomeTip);
	const attachment = new DeferredPromise<{ name: string; content: string; }>();
	widget.addContext({ id: 'code-file', kind: 'file', name: 'code.ts', resolve: () => attachment.p });
	const sending = widget.acceptInput('Start this work');
	view.openNewSession();
	const chatSelection = view.activeSelection;
	if (chatSelection?.kind !== 'untitled') throw new Error('Expected Chat draft');
	const chatModel = createWidgetModel(chat, { kind: 'untitled', session: chatSelection.session }, sessions);
	using chatWidget = new ChatWidget(dom.window.document.body, 'separate-chat', chatModel, () => view.openNewSession(),
		{ showContextMenu: () => undefined } as unknown as IContextMenuService, contextViewService, commands,
		unavailableAccessibleViewService, notifications, undefined, undefined, undefined, (container, delegate) => editorServices.createInstance(NewChatInputWidget, container, delegate, chatModel), editorServices);
	chatWidget.setVisible(true);
	const chatDraft = { mode: 'agent' as const, text: 'Keep my Chat draft', contexts: [{ id: 'chat-file', kind: 'file', name: 'chat.txt', content: 'Chat context' }] };
	chatWidget.restoreDraft(chatDraft);
	await attachment.complete({ name: 'code.ts', content: 'Code context' });
	await sending;
	assert.equal(heading?.hidden, true);
	assert.equal(input?.classList.contains('has-conversation'), true);
	assert.equal(widget.element.querySelector('.ash-chat-input-part'), input);
	assert.equal(widget.sessionId, 'session-1');
	assert.deepEqual((await chatWidget.captureDraft())?.draft, chatDraft);
	assert.deepEqual(readNewChatDraftState(composerStorage, `untitled:${chatSelection.session.untitledSessionId}`), chatDraft);
	assert.equal(readNewChatDraftState(composerStorage, 'thread-1'), undefined);
	assert.equal(view.activeSelection?.kind, 'untitled');
	assert.equal(chatWidget.sessionId, undefined);
	view.openSession('session-1', 'thread-1');
	assert.equal(view.activeSelection?.kind, 'session');
	assert.equal(await widget.captureDraft(), undefined);
	assert.equal(readNewChatDraftState(composerStorage, 'thread-1'), undefined);
});

test("an empty Session list opens an untitled session and persists it on its first send", async () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	dom.window.HTMLElement.prototype.scrollTo = () => { };
	using contextViewService = new BrowserContextViewService(dom.window.document.body);
	let failAgentList = false;
	const createdSession = session("session-1", undefined, "New Chat");
	const attachedSession = session("session-1", "thread-1", "New Chat");
	const fake = fakeApi({
		sessions: [],
		agents: [{ name: 'reviewer', description: 'Reviews changes', sourceId: 'directory-1' }],
		agentListFails: () => failAgentList,
		createSession: createdSession,
		createThread: {
			session: attachedSession,
			threadId: "thread-1",
		},
	});
	const api = fake.api;
	const services = new InstantiationService();
	using sessions = new SessionsManagementService(api);
	using contextKeys = new ContextKeyService();
	using viewDescriptors = new ViewDescriptorService({
		registry: new WorkbenchViewRegistry(),
	}, contextKeys);
	services.registerInstance(ISessionsManagementService, sessions);
	services.registerInstance(IViewsService, {
		openView: async () => undefined,
		focusView: async () => true,
		getViewWithId: () => undefined,
	} as unknown as IViewsService);
	using commands = new CommandService(services);
	const menuService = new MenuService(commands, contextKeys);
	const layout = testLayoutService();
	const contextMenuService = {
		showContextMenu: () => undefined,
	} as unknown as IContextMenuService;
	const paneChat = createChatService(api);
	using pane = new ChatViewPane(
		dom.window.document.body,
		{
			id: CHAT_VIEW_ID,
			title: "Chat",
		},
		paneChat,
		sessions,
		menuService,
		contextMenuService,
		contextViewService,
		commands,
		layout,
		unavailableFileService,
		unavailableAccessibleViewService,
		notifications,
		createInputServices(contextViewService, paneChat),
	);
	dom.window.document.body.append(pane.element);

	await sessions.initialize();
	await nextTask();

	const tabs = chatTitleContent(pane).querySelectorAll<HTMLButtonElement>("[role='tab']");
	assert.equal(tabs.length, 1);
	assert.deepEqual(
		[...tabs].map((tab) => ({
			label: tab.textContent,
			selected: tab.getAttribute("aria-selected"),
		})),
		[
			{ label: "New Chat", selected: "true" },
		],
	);
	assert.equal(pane.element.querySelector<HTMLElement>(".ash-chat-view-empty")?.hidden, true);
	assert.equal(fake.createSessionRequests.length, 0);
	assert.equal(fake.createThreadRequests.length, 0);
	assert.equal(sessions.sessions.length, 0);
	assert.equal(sessions.untitledSessions.length, 1);
	const untitledPane = pane.element.querySelector<HTMLElement>("[role='tabpanel']");
	assert.ok(untitledPane?.dataset.untitledSessionId);
	const input = untitledPane.querySelector<HTMLTextAreaElement>(".ash-chat-textarea-input");
	assert.ok(input);
	assert.equal(untitledPane.classList.contains("empty"), true);
	let contextResolutions = 0;
	pane.addContext({
		id: "commit-1",
		kind: "scmHistoryItem",
		name: "abc1234 · Explain context transport",
		resolve: async () => {
			contextResolutions += 1;
			return { name: "Git commit abc1234", content: "diff --git a/file b/file" };
		},
	});
	assert.equal(untitledPane.querySelector(".ash-chat-input-attachment-label")?.textContent, "abc1234 · Explain context transport");
	typeChatText(dom.window, input, "Hello from an untitled session");
	input.dispatchEvent(new dom.window.KeyboardEvent("keydown", {
		bubbles: true,
		cancelable: true,
		key: "Enter",
	}));
	assert.equal(untitledPane.classList.contains("empty"), false);
	assert.equal(untitledPane.classList.contains("has-conversation"), true);
	assert.ok(untitledPane.querySelector(":scope > .ash-chat-list-widget"));
	assert.ok(untitledPane.querySelector(":scope > .ash-chat-input-part"));
	await waitFor(() => fake.turnStartRequests.length === 1);

	assert.equal(fake.createSessionRequests.length, 1);
	assert.deepEqual(fake.createSessionRequests[0]?.agent, { type: 'default' });
	assert.equal(fake.createThreadRequests.length, 1);
	assert.equal(fake.turnStartRequests.length, 1);
	assert.equal(fake.turnStartRequests[0]?.mode, 'agent');
	assert.equal(contextResolutions, 1);
	assert.deepEqual(fake.turnStartRequests[0]?.input, [
		{ type: "context", name: "Git commit abc1234", content: "diff --git a/file b/file" },
		{ type: "text", text: "Hello from an untitled session" },
	]);
	assert.equal(untitledPane.querySelector(".ash-chat-input-attachment-item"), null);
	assert.equal(sessions.untitledSessions.length, 0);
	assert.equal(sessions.active?.session.sessionId, "session-1");
	assert.equal(sessions.active?.threadId, "thread-1");

	assert.equal(
		pane.element.querySelector<HTMLElement>("[role='tabpanel']")?.dataset.sessionId,
		"session-1",
	);
	assert.equal(
		pane.element.querySelector("[role='tabpanel']")?.getAttribute(
			"aria-labelledby",
		),
		tabs[0]?.id,
	);

	pane.dispose();
	dom.window.close();
});

test("the New Chat slash command opens an untitled session", async () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	using contextViewService = new BrowserContextViewService(dom.window.document.body);
	const initialSession = session("session-1", "thread-1", "First Chat");
	const fake = fakeApi({ sessions: [initialSession] });
	const services = new InstantiationService();
	using sessions = new SessionsManagementService(fake.api);
	using contextKeys = new ContextKeyService();
	using viewDescriptors = new ViewDescriptorService({
		registry: new WorkbenchViewRegistry(),
	}, contextKeys);
	services.registerInstance(ISessionsManagementService, sessions);
	let focusedView: string | undefined;
	services.registerInstance(IViewsService, {
		openView: async () => undefined,
		focusView: async (viewId: string) => {
			focusedView = viewId;
			return true;
		},
		getViewWithId: () => undefined,
	} as unknown as IViewsService);
	using commands = new CommandService(services);
	const menuService = new MenuService(commands, contextKeys);
	const layout = testLayoutService();
	const contextMenuService = {
		showContextMenu: () => undefined,
	} as unknown as IContextMenuService;
	const paneChat = createChatService(fake.api);
	using pane = new ChatViewPane(
		dom.window.document.body,
		{
			id: CHAT_VIEW_ID,
			title: "Chat",
		},
		paneChat,
		sessions,
		menuService,
		contextMenuService,
		contextViewService,
		commands,
		layout,
		unavailableFileService,
		unavailableAccessibleViewService,
		notifications,
		createInputServices(contextViewService, paneChat),
	);
	dom.window.document.body.append(pane.element);

	await sessions.initialize();
	await nextTask();

	const input = pane.element.querySelector<HTMLTextAreaElement>(".ash-chat:not([hidden]) .ash-chat-textarea-input");
	assert.ok(input);
	typeChatText(dom.window, input, "/new");
	assert.equal(pane.element.querySelector("[data-action-id='ash.chat.input.command'] button")?.textContent, "Command");
	input.dispatchEvent(new dom.window.KeyboardEvent("keydown", {
		bubbles: true,
		cancelable: true,
		key: "Enter",
	}));
	await waitFor(() => chatTitleContent(pane).querySelectorAll("[role='tab']").length === 2);

	assert.deepEqual(
		[...chatTitleContent(pane).querySelectorAll<HTMLElement>("[role='tab']")].map((tab) => ({
			label: tab.textContent,
			selected: tab.getAttribute("aria-selected"),
		})),
		[
			{ label: "New Chat", selected: "true" },
			{ label: "First Chat", selected: "false" },
		],
	);
	assert.equal(fake.createSessionRequests.length, 0);
	assert.equal(fake.createThreadRequests.length, 0);
	assert.equal(sessions.untitledSessions.length, 1);
	assert.equal(focusedView, CHAT_VIEW_ID);

	dom.window.close();
});

test("failed first send keeps the untitled session and its input draft", async () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	using contextViewService = new BrowserContextViewService(dom.window.document.body);
	const fake = fakeApi({
		sessions: [],
		createSessionError: new Error("Cannot create Session"),
	});
	const services = new InstantiationService();
	using sessions = new SessionsManagementService(fake.api);
	using contextKeys = new ContextKeyService();
	using viewDescriptors = new ViewDescriptorService({
		registry: new WorkbenchViewRegistry(),
	}, contextKeys);
	services.registerInstance(ISessionsManagementService, sessions);
	services.registerInstance(IViewsService, {
		openView: async () => undefined,
		focusView: async () => true,
		getViewWithId: () => undefined,
	} as unknown as IViewsService);
	using commands = new CommandService(services);
	const menuService = new MenuService(commands, contextKeys);
	const layout = testLayoutService();
	const contextMenuService = {
		showContextMenu: () => undefined,
	} as unknown as IContextMenuService;
	const paneChat = createChatService(fake.api);
	using pane = new ChatViewPane(
		dom.window.document.body,
		{
			id: CHAT_VIEW_ID,
			title: "Chat",
		},
		paneChat,
		sessions,
		menuService,
		contextMenuService,
		contextViewService,
		commands,
		layout,
		unavailableFileService,
		unavailableAccessibleViewService,
		notifications,
		createInputServices(contextViewService, paneChat),
	);
	dom.window.document.body.append(pane.element);

	await sessions.initialize();
	await nextTask();

	const input = pane.element.querySelector<HTMLTextAreaElement>(".ash-chat-textarea-input");
	assert.ok(input);
	pane.addContext({
		id: "failed-commit",
		kind: "scmHistoryItem",
		name: "failed commit",
		resolve: async () => ({ name: "Git commit failed", content: "change" }),
	});
	typeChatText(dom.window, input, "Keep this draft");
	input.dispatchEvent(new dom.window.KeyboardEvent("keydown", {
		bubbles: true,
		cancelable: true,
		key: "Enter",
	}));
	await waitFor(() => input.value === "Keep this draft");

	assert.equal(fake.createSessionRequests.length, 1);
	assert.equal(sessions.sessions.length, 0);
	assert.equal(sessions.untitledSessions.length, 1);
	assert.equal(pane.element.querySelector(".ash-chat-input-attachment-label")?.textContent, "failed commit");
	assert.equal(input.value, "Keep this draft");
	assert.equal(pane.element.querySelector<HTMLElement>("[role='tabpanel']")?.dataset.untitledSessionId, sessions.untitledSessions[0]?.untitledSessionId);
	assert.equal(pane.element.querySelector<HTMLElement>("[role='tabpanel']")?.classList.contains("empty"), true);
	assert.equal(pane.element.querySelector<HTMLElement>("[role='tabpanel']")?.classList.contains("has-conversation"), false);
	assert.match(pane.element.querySelector<HTMLElement>(".ash-chat-status")?.textContent ?? "", /Cannot create Session/);

	dom.window.close();
});

test("one Session retains one Chat pane while its selected Thread changes", async () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	using contextViewService = new BrowserContextViewService(dom.window.document.body);
	const multiThreadSession: ISession = {
		...session("session-1", "thread-1", "One Chat"),
		chats: [
			{ threadId: "thread-1", origin: { type: "root" }, status: "active" },
			{
				threadId: "thread-2",
				origin: {
					type: "fork",
					parentThreadId: "thread-1",
					parentSequence: 1,
				},
				status: "active",
			},
		],
	};
	const api = fakeApi({ sessions: [multiThreadSession] }).api;
	using sessions = new SessionsManagementService(api);
	using contextKeys = new ContextKeyService();
	using viewDescriptors = new ViewDescriptorService({
		registry: new WorkbenchViewRegistry(),
	}, contextKeys);
	using commands = new CommandService(new InstantiationService());
	const menuService = new MenuService(commands, contextKeys);
	const layout = testLayoutService();
	const contextMenuService = {
		showContextMenu: () => undefined,
	} as unknown as IContextMenuService;
	const paneChat = createChatService(api);
	using pane = new ChatViewPane(
		dom.window.document.body,
		{
			id: CHAT_VIEW_ID,
			title: "Chat",
		},
		paneChat,
		sessions,
		menuService,
		contextMenuService,
		contextViewService,
		commands,
		layout,
		unavailableFileService,
		unavailableAccessibleViewService,
		notifications,
		createInputServices(contextViewService, paneChat),
	);
	dom.window.document.body.append(pane.element);

	await sessions.initialize();
	await nextTask();

	assert.equal(chatTitleContent(pane).querySelectorAll("[role='tab']").length, 1);
	const chatPane = pane.element.querySelector<HTMLElement>(".ash-chat-pane-host > .ash-chat");
	assert.ok(chatPane);
	assert.equal(chatPane.dataset.sessionId, "session-1");
	assert.equal(chatPane.dataset.threadId, "thread-1");
	const input = chatPane.querySelector<HTMLTextAreaElement>(".ash-chat-textarea-input");
	assert.ok(input);
	input.focus();
	assert.strictEqual(dom.window.document.activeElement, input);

	sessions.selectThread("session-1", "thread-2");
	await nextTask();

	assert.strictEqual(
		pane.element.querySelector(".ash-chat-pane-host > .ash-chat"),
		chatPane,
	);
	assert.equal(chatTitleContent(pane).querySelectorAll("[role='tab']").length, 1);
	assert.equal(chatPane.dataset.threadId, "thread-2");
	assert.strictEqual(dom.window.document.activeElement, input);
	dom.window.close();
});

test("Chat history selects an active Thread through Quick Pick", async () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const api = fakeApi({
		sessions: [
			session("session-1", "thread-1", "First Chat"),
			session("session-2", "thread-2", "Second Chat"),
		],
	}).api;
	const services = new InstantiationService();
	using sessions = new SessionsManagementService(api);
	using contextKeys = new ContextKeyService();
	using quickInput = new WorkbenchQuickInputService({
		container: dom.window.document.body,
		contextKeyService: contextKeys,
	});
	let focusedView: string | undefined;
	services.registerInstance(ISessionsManagementService, sessions);
	services.registerInstance(IQuickInputService, quickInput);
	services.registerInstance(IViewsService, {
		openView: async () => undefined,
		focusView: async (viewId: string) => {
			focusedView = viewId;
			return true;
		},
		getViewWithId: () => undefined,
	} as unknown as IViewsService);
	using commands = new CommandService(services);
	await sessions.initialize();

	await commands.executeCommand(SHOW_CHAT_HISTORY_COMMAND_ID);
	assert.deepEqual(
		[...dom.window.document.querySelectorAll(
			".ash-quick-pick-row-label",
		)].map((label) => label.textContent),
		["First Chat", "Second Chat"],
	);
	const input = dom.window.document.querySelector<HTMLInputElement>(
		".ash-quick-pick-input input",
	);
	assert.ok(input);
	input.dispatchEvent(new dom.window.KeyboardEvent("keydown", {
		bubbles: true,
		cancelable: true,
		key: "ArrowDown",
	}));
	input.dispatchEvent(new dom.window.KeyboardEvent("keydown", {
		bubbles: true,
		cancelable: true,
		key: "Enter",
	}));

	assert.equal(sessions.active?.session.sessionId, "session-2");
	assert.equal(sessions.active?.threadId, "thread-2");
	assert.equal(focusedView, CHAT_VIEW_ID);
	assert.equal(
		dom.window.document.querySelector(".ash-quick-pick"),
		null,
	);
	dom.window.close();
});

test("ViewsService resolves, opens, and focuses contributed views", async () => {
	const registry = new WorkbenchViewRegistry();
	registerChatViews(registry);
	using contextKeys = new ContextKeyService();
	using descriptors = new ViewDescriptorService({
		registry,
	}, contextKeys);
	let focused = 0;
	let opened = 0;
	const view = {
		element: h(testStorageEnvironment.window.document, "div"),
		id: CHAT_VIEW_ID,
		focus: () => focused++,
		isVisible: () => true,
		setVisible: () => undefined,
	};
	const paneContainer = {
		panes: [],
		onDidChangeViewVisibility: Event.None,
		onDidAddViews: Event.None,
		onDidRemoveViews: Event.None,
		onDidFocusView: Event.None,
		onDidBlurView: Event.None,
		getView: (viewId: string) => viewId === CHAT_VIEW_ID ? view : undefined,
		openView: (viewId: string, focus = false) => {
			assert.equal(viewId, CHAT_VIEW_ID);
			if (focus) view.focus();
			opened++;
			return view;
		},
	} as unknown as ViewPaneContainer;
	const { IPaneCompositePartService } = await import('../../../workbench/services/panecomposite/browser/panecomposite.js');
	const { IViewDescriptorService } = await import('../../../workbench/common/views.js');
	using services = new InstantiationService();
	services.registerInstance(IViewDescriptorService, descriptors);
	services.registerInstance(IContextKeyService, contextKeys);
	const composite = Object.assign(paneContainer, { id: CHAT_VIEW_CONTAINER_ID }) as import("../../../workbench/browser/parts/views/paneComposite.js").PaneComposite;
	services.registerInstance(IPaneCompositePartService, {
		onDidPaneCompositeOpen: Event.None,
		onDidPaneCompositeClose: Event.None,
		openPaneComposite: async id => { assert.equal(id, CHAT_VIEW_CONTAINER_ID); return composite; },
		getActivePaneComposite: () => composite,
		getPartId: () => 'auxiliarybar',
		hideActivePaneComposite() { },
		getLastActivePaneCompositeId: () => CHAT_VIEW_CONTAINER_ID,
	} as import('../../../workbench/services/panecomposite/browser/panecomposite.js').IPaneCompositePartService);
	using service = services.createInstance(ViewsService);

	assert.equal(service.getViewWithId(CHAT_VIEW_ID), view);
	assert.equal(opened, 0);
	assert.equal(await service.focusView(CHAT_VIEW_ID), true);
	assert.equal(opened, 1);
	assert.equal(focused, 1);
	assert.equal(await service.openView("missing"), null);
});

test("SessionsManagementService restores and creates active Threads", async () => {
	const initialSession = session("session-1", "thread-1");
	const createdSession = session("session-2");
	const attachedSession = session("session-2", "thread-2");
	const api = fakeApi({
		sessions: [initialSession],
		createSession: createdSession,
		createThread: {
			session: attachedSession,
			threadId: "thread-2",
		},
	}).api;
	using service = new SessionsManagementService(api);

	await service.initialize();
	assert.equal(service.active?.threadId, "thread-1");
	assert.equal(service.active?.session.title, "Session session-1");

	const active = await service.startNewSession("Another");
	assert.equal(active.threadId, "thread-2");
	assert.equal(service.sessions[0].sessionId, "session-2");
	assert.equal(service.state, "ready");
});

test("SessionsManagementService archives a Session and selects the next active one", async () => {
	const first = session("session-1", "thread-1");
	const second = session("session-2", "thread-2");
	const fake = fakeApi({ sessions: [first, second] });
	using service = new SessionsManagementService(fake.api);

	await service.initialize();
	await service.archiveSession("session-1");

	assert.deepEqual(
		fake.archiveRequests.map(({ sessionId }) => ({ sessionId })),
		[{ sessionId: "session-1" }],
	);
	assert.equal(
		service.sessions.find(({ sessionId }) => sessionId === "session-1")
			?.status,
		"archived",
	);
	assert.equal(service.active?.session.sessionId, "session-2");
	assert.equal(service.active?.threadId, "thread-2");
	assert.equal(service.state, "ready");
});

test("SessionsManagementService permits an empty selection when no durable Session remains", async () => {
	const onlySession = session("session-1", "thread-1");
	const fake = fakeApi({ sessions: [onlySession] });
	using service = new SessionsManagementService(fake.api);

	await service.initialize();
	await service.archiveSession("session-1");

	assert.equal(service.active, undefined);
	assert.equal(service.untitledSessions.length, 0);
	assert.equal(service.activeUntitledSession, undefined);
	assert.equal(fake.createSessionRequests.length, 0);
	assert.equal(fake.createThreadRequests.length, 0);
});

test("SessionsManagementService selects another untitled session and permits the last one to be discarded", async () => {
	const fake = fakeApi();
	using service = new SessionsManagementService(fake.api);

	await service.initialize();
	assert.equal(service.untitledSessions.length, 0);
	const initialSession = service.createUntitledSession();
	const nextSession = service.createUntitledSession();

	service.discardUntitledSession(nextSession.untitledSessionId);
	assert.equal(service.activeUntitledSession?.untitledSessionId, initialSession.untitledSessionId);

	service.discardUntitledSession(initialSession.untitledSessionId);
	assert.equal(service.untitledSessions.length, 0);
	assert.equal(service.activeUntitledSession, undefined);
	assert.equal(fake.createSessionRequests.length, 0);
	assert.equal(fake.createThreadRequests.length, 0);
});

test("SessionsManagementService persists and reflects the model", async () => {
	const fake = fakeApi({
		sessions: [
			session("session-1", "thread-1"),
			session("session-2", "thread-2"),
		],
	});
	using service = new SessionsManagementService(fake.api);
	await service.initialize();
	const model: ModelRef = { provider: "openai", model: "gpt-session" };

	await service.setModel(model);

	assert.deepEqual(service.sessions.find(({ sessionId }) => sessionId === "session-1")?.model, model);
	assert.deepEqual(service.sessions.find(({ sessionId }) => sessionId === "session-2")?.model, model);
	assert.deepEqual(service.active?.session.model, model);
	assert.deepEqual(fake.modelRequests.map(request => request.model), [model]);
});

test("ChatWidgetModel applies backend-assembled transcript entries", async () => {
	const activeSession = session("session-1", "thread-1");
	let currentThread = thread();
	const fake = fakeApi({
		sessions: [activeSession],
		thread: () => currentThread,
	});
	using sessions = new SessionsManagementService(fake.api);
	using model = createWidgetModel(createChatService(fake.api), {
		kind: "session",
		active: {
			session: activeSession,
			threadId: "thread-1",
		},
	}, sessions);

	await model.initialize();
	fake.emit({
		method: "session/thread/transcript/update",
		params: {
			sessionId: "session-1",
			threadId: "thread-1",
			durableSequence: 1,
			revision: 2,
			changes: [{
				type: "upsert",
				entry: {
					type: "item",
					entryId: "item:item-1",
					turnId: "turn-1",
					transient: true,
					item: { type: "agentMessage", itemId: "item-1", turnId: "turn-1", text: "Hello" },
				},
			}],
		},
	});

	assert.deepEqual(model.items.map((item) => item.text), ["Hello"]);
	assert.equal(model.items[0].transient, true);

	currentThread = thread("Hello");
	fake.emit({
		method: "session/thread/update",
		params: {
			sessionId: "session-1",
			threadId: "thread-1",
			durableSequence: 4,
			update: {
				type: "committed",
				event: {
					type: "itemCompleted",
					threadId: "thread-1",
					turnId: "turn-1",
					item: currentThread.turns[0].items[0],
				},
			},
		},
	});
	await nextTask();

	assert.deepEqual(model.items.map((item) => item.text), ["Hello"]);
	assert.equal(model.items[0].transient, false);
	assert.equal(model.thread?.sequence, 4);
});

test("ChatWidgetModel projects and refreshes the canonical durable Turn plan", async () => {
	const activeSession = session("session-1", "thread-1");
	let currentThread: Thread = {
		...thread(),
		sequence: 3,
		turns: [{
			turnId: "turn-1",
			status: "running",
			mode: "agent",
			kind: "coding",
			toolMode: "direct",
			approvalMode: "manual",
			usage: emptyUsage(),
			items: [],
			plan: {
				explanation: "Implement S3",
				steps: [
					{ step: "Implement", status: "inProgress" },
					{ step: "Verify", status: "pending" },
				],
			},
		}],
	};
	const fake = fakeApi({ sessions: [activeSession], thread: () => currentThread });
	using sessions = new SessionsManagementService(fake.api);
	using model = createWidgetModel(createChatService(fake.api), {
		kind: "session",
		active: { session: activeSession, threadId: "thread-1" },
	}, sessions);

	await model.initialize();
	assert.equal(model.items[0]?.id, "turn-plan:turn-1");
	assert.match(model.items[0]?.text ?? "", /In progress:\*\* Implement/);

	currentThread = {
		...currentThread,
		sequence: 4,
		turns: [{
			...currentThread.turns[0],
			plan: {
				explanation: "Implementation complete",
				steps: [
					{ step: "Implement", status: "completed" },
					{ step: "Verify", status: "inProgress" },
				],
			},
		}],
	};
	fake.emit({
		method: "session/thread/update",
		params: {
			sessionId: "session-1",
			threadId: "thread-1",
			durableSequence: 4,
			update: {
				type: "committed",
				event: {
					type: "planUpdated",
					threadId: "thread-1",
					turnId: "turn-1",
					plan: currentThread.turns[0].plan!,
				},
			},
		},
	});
	await nextTask();

	assert.equal(model.items.length, 1);
	assert.match(model.items[0]?.text ?? "", /\[x\] Implement/);
	assert.match(model.items[0]?.text ?? "", /In progress:\*\* Verify/);
});

test("ChatWidgetModel mechanically clears and replaces transient transcript entries", async () => {
	const activeSession = session("session-1", "thread-1");
	const fake = fakeApi({
		sessions: [activeSession],
		thread: () => thread(),
	});
	using sessions = new SessionsManagementService(fake.api);
	using model = createWidgetModel(createChatService(fake.api), {
		kind: "session",
		active: {
			session: activeSession,
			threadId: "thread-1",
		},
	}, sessions);

	await model.initialize();
	let transcriptRevision = 1;
	const emitChanges = (
		changes: Extract<ServerNotification, { method: "session/thread/transcript/update"; }>["params"]["changes"],
		revision = ++transcriptRevision,
	): void => {
		fake.emit({
			method: "session/thread/transcript/update",
			params: {
				sessionId: "session-1",
				threadId: "thread-1",
				durableSequence: 1,
				revision,
				changes,
			},
		});
	};
	const item = (itemId: string) => ({
		type: "upsert" as const,
		entry: {
			type: "item" as const,
			entryId: `item:${itemId}`,
			turnId: "turn-1",
			transient: true,
			item: { type: "agentMessage" as const, itemId, turnId: "turn-1", text: itemId },
		},
	});

	emitChanges([item("old-item")]);
	assert.deepEqual(model.items.map((item) => item.text), ["old-item"]);
	emitChanges([{ type: "clearTransient" }]);
	assert.equal(model.items.length, 0);

	emitChanges([item("new-item")]);
	assert.deepEqual(model.items.map((item) => item.text), ["new-item"]);
	emitChanges([item("duplicate-is-ignored")], transcriptRevision);
	assert.deepEqual(model.items.map((item) => item.text), ["new-item"]);
	emitChanges([item("gap-is-ignored")], transcriptRevision + 2);
	await nextTask();
	assert.deepEqual(model.items.map((item) => item.text), ["new-item"]);
	emitChanges([{ type: "clearTransient" }], transcriptRevision + 3);
	assert.equal(model.items.length, 0);
});

test("ChatWidgetModel projects a durable Turn failure into the conversation", async () => {
	const activeSession = session("session-1", "thread-1");
	const failedThread: Thread = {
		advisor: { type: "default" },
		agentId: "agent-1",
		origin: { type: "root" },
		referenceCost: { knownAmounts: [], complete: true },
		sessionId: "session-1",
		threadId: "thread-1",
		title: "Main",
		status: "active",
		sequence: 3,
		usage: emptyUsage(),
		turns: [{
			turnId: "turn-1",
			status: "failed",
			mode: "agent",
			kind: "coding",
			toolMode: "direct",
			approvalMode: "manual",
			usage: emptyUsage(),
			items: [],
			error: {
				code: "providerAuth",
				message: "Model provider authentication failed",
				retryable: false,
			},
		}],
	};
	const fake = fakeApi({ sessions: [activeSession], thread: () => failedThread });
	using sessions = new SessionsManagementService(fake.api);
	using model = createWidgetModel(createChatService(fake.api), {
		kind: "session",
		active: { session: activeSession, threadId: "thread-1" },
	}, sessions);

	await model.initialize();

	assert.deepEqual(model.items, [{
		id: "turn-error:turn-1",
		type: "turnError",
		text: "Model provider authentication failed",
		transient: false,
		isError: true,
		label: "Authentication",
		detail: "Choose a model with working credentials before sending another message.",
		errorCode: "providerAuth",
		action: { type: "chooseModel", label: "Choose another model" },
	}]);
	assert.equal(model.state, "ready");
});

test("Turn error presentation is selected only from the stable error code", () => {
	const message = "same opaque message";
	const cases: readonly { readonly code: TurnError["code"]; readonly retryable: boolean; }[] = [
		{ code: "modelInvocationFailed", retryable: true },
		{ code: "contextOverflow", retryable: true },
		{ code: "providerAuth", retryable: false },
		{ code: "invalidRequest", retryable: false },
		{ code: "invalidResponse", retryable: true },
		{ code: "completionPersistenceFailed", retryable: true },
		{ code: "interactionDeadlineElapsed", retryable: true },
		{ code: "toolRepetition", retryable: false },
		{ code: "usageLimited", retryable: false },
		{ code: "worktreeCaptureFailed", retryable: true },
	];

	assert.deepEqual(cases.map(({ code, retryable }) => {
		const item = chatTurnErrorListItem(failedTurn(code, retryable, message));
		return { code: item?.errorCode, label: item?.label, action: item?.action?.type, message: item?.text };
	}), [
		{ code: "modelInvocationFailed", label: "Model error", action: "retry", message },
		{ code: "contextOverflow", label: "Context limit", action: "startNewChat", message },
		{ code: "providerAuth", label: "Authentication", action: "chooseModel", message },
		{ code: "invalidRequest", label: "Invalid request", action: "revise", message },
		{ code: "invalidResponse", label: "Invalid response", action: "retry", message },
		{ code: "completionPersistenceFailed", label: "Save failed", action: "retry", message },
		{ code: "interactionDeadlineElapsed", label: "Interaction expired", action: "retry", message },
		{ code: "toolRepetition", label: "Repeated tool failure", action: "revise", message },
		{ code: "usageLimited", label: "Usage limit", action: "chooseModel", message },
		{ code: "worktreeCaptureFailed", label: "Worktree capture failed", action: "retry", message },
	]);
});

test("ChatWidgetModel rebuilds error actions from canonical Thread state after refresh and reconnect", async () => {
	const activeSession = session("session-1", "thread-1");
	let currentThread = threadWithFailure("providerAuth", false);
	const fake = fakeApi({ sessions: [activeSession], thread: () => currentThread });
	using sessions = new SessionsManagementService(fake.api);
	using model = createWidgetModel(createChatService(fake.api), {
		kind: "session",
		active: { session: activeSession, threadId: "thread-1" },
	}, sessions);
	await model.initialize();

	currentThread = threadWithFailure("toolRepetition", false, 4);
	fake.emit({
		method: "session/thread/update",
		params: {
			sessionId: "session-1",
			threadId: "thread-1",
			durableSequence: currentThread.sequence,
			update: {
				type: "committed",
				event: {
					type: "turnFailed",
					threadId: "thread-1",
					turnId: "turn-1",
					error: currentThread.turns[0]!.error!,
				},
			},
		},
	});
	await waitFor(() => model.items[0]?.errorCode === "toolRepetition");
	assert.equal(model.items[0]?.action?.type, "revise");

	currentThread = threadWithFailure("usageLimited", false, 5);
	fake.emitReady();
	await waitFor(() => model.items[0]?.errorCode === "usageLimited");
	assert.equal(model.items[0]?.action?.type, "chooseModel");
});

test("ChatWidgetModel retries only the latest retryable failed Turn as a new visible Turn", async () => {
	const activeSession = session("session-1", "thread-1");
	const failedThread = threadWithFailure("modelInvocationFailed", true);
	const fake = fakeApi({ sessions: [activeSession], thread: () => failedThread });
	using sessions = new SessionsManagementService(fake.api);
	using model = createWidgetModel(createChatService(fake.api), {
		kind: "session",
		active: { session: activeSession, threadId: "thread-1" },
	}, sessions);
	await model.initialize();

	await model.retryFailedTurn("turn-1");

	assert.deepEqual(fake.turnStartRequests.map(({ expectedSequence, input }) => ({ expectedSequence, input })), [{
		expectedSequence: failedThread.sequence,
		input: [{ type: "text", text: "Try again." }],
	}]);
	await assert.rejects(model.retryFailedTurn("older-turn"), /Only the latest retryable failed Turn/);
});

interface FakeOptions {
	readonly agents?: readonly { readonly name: string; readonly description: string; readonly sourceId: string; }[];
	readonly agentListFails?: () => boolean;
	readonly sessions?: readonly ISession[];
	readonly createSession?: ISession;
	readonly createSessionError?: Error;
	readonly createThread?: {
		readonly session: ISession;
		readonly threadId: string;
	};
	readonly thread?: () => Thread;
	readonly skills?: readonly {
		readonly id: { readonly source: string; readonly name: string; };
		readonly description: string;
		readonly contentDigest: string;
		readonly enabled: boolean;
		readonly compatible: boolean;
	}[];
	readonly models?: readonly {
		readonly model: ModelRef;
		readonly displayName: string;
		readonly contextWindow?: number | null;
		readonly supportedReasoningEfforts?: readonly { readonly effort: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'extraHigh' | 'max'; readonly description?: string | null; }[];
		readonly defaultReasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'extraHigh' | 'max';
	}[];
	readonly configuredProviders?: readonly string[];
	readonly providers?: readonly ModelProviderCredentialStatus[];
	readonly providerModels?: Readonly<Record<string, readonly { readonly model: ModelRef; readonly displayName: string; }[]>>;
	readonly advisorDefault?: { readonly model: ModelRef; readonly enabled: boolean; readonly maxCalls: number; readonly maxOutputTokens: number; };
}

function createTestStorage(): InstanceType<typeof BrowserStorageService> {
	const environment = new JSDOM('', { url: 'https://ash.test' });
	storageResources.add(toDisposable(() => environment.window.close()));
	return new BrowserStorageService({ ownerWindow: environment.window as unknown as Window, workspaceId: 'test', flushInterval: 0 });
}

const modelServices = new WeakMap<IChatService, ILanguageModelsService>();
function modelsFor(chat: IChatService): ILanguageModelsService {
	return modelServices.get(chat)!;
}
function createWidgetModel(chat: IChatService, selection: import('../../browser/chatWidgetModel.js').ChatWidgetSelection, sessions: ISessionsManagementService): ChatWidgetModel {
	const services = inputResources.add(new InstantiationService());
	services.registerInstance(ILanguageModelsService, modelsFor(chat));
	return services.createInstance(ChatWidgetModel, chat, selection, sessions);
}
function createChatService(api: IRendererHost, configurationService?: WorkbenchConfigurationService, storageService?: InstanceType<typeof BrowserStorageService>): ChatService {
	const storage = storageService ?? createTestStorage();
	if (!storageService) testStorages.push(storage);
	const services = inputResources.add(new InstantiationService());
	services.registerInstance(IModelApi, api.model);
	services.registerInstance(IAppServerApi, api.appServer);
	services.registerInstance(IServerEventApi, api.events);
	services.registerInstance(IConfigurationService, configurationService ?? inputResources.add(new WorkbenchConfigurationService()));
	services.registerInstance(IStorageService, storage);
	services.registerInstance(ILanguageModelsConfigurationService, inputResources.add(services.createInstance(LanguageModelsConfigurationService, ChatModelPreferences)));
	const chat = new ChatService({ modelApi: api.model, threadApi: api.thread, turnApi: api.turn, turnChangesApi: api.turnChanges, skillApi: api.skills, appServerApi: api.appServer, eventApi: api.events });
	modelServices.set(chat, inputResources.add(services.createInstance(LanguageModelsService)));
	return chat;
}

test('closing one conversation owner retains another owner across repeated subscriptions', async () => {
	const fake = fakeApi();
	const released: string[] = [];
	using chat = createChatService({ ...fake.api, thread: { ...fake.api.thread, unsubscribe: async ({ threadId }) => { released.push(threadId); } } });
	const chatOwner = {};
	const codeOwner = {};
	await chat.subscribeThread('session-1', 'thread-1', 0, chatOwner);
	await chat.subscribeThread('session-1', 'thread-1', 0, codeOwner);
	await chat.subscribeThread('session-1', 'thread-1', 0, codeOwner);
	await chat.unsubscribeThread('session-1', 'thread-1', codeOwner);
	assert.deepEqual(released, []);
	await chat.unsubscribeThread('session-1', 'thread-1', chatOwner);
	assert.deepEqual(released, ['thread-1']);
});

test('closing during subscription waits for the request before releasing the backend', async () => {
	const fake = fakeApi();
	const pending = new DeferredPromise<Awaited<ReturnType<typeof fake.api.thread.subscribe>>>();
	const released: string[] = [];
	using chat = createChatService({
		...fake.api, thread: {
			...fake.api.thread,
			subscribe: () => pending.p,
			unsubscribe: async ({ threadId }) => { released.push(threadId); },
		}
	});
	const owner = {};
	const subscribing = chat.subscribeThread('session-1', 'thread-1', 0, owner);
	const closing = chat.unsubscribeThread('session-1', 'thread-1', owner);
	assert.deepEqual(released, []);
	await pending.complete(await fake.api.thread.subscribe({ sessionId: 'session-1', threadId: 'thread-1', afterSequence: 0 }));
	await subscribing;
	await closing;
	assert.deepEqual(released, ['thread-1']);
});

test("Chat service retains Agent identity and branch origin when reading a Thread", async () => {
	const fake = fakeApi();
	using chat = createChatService(fake.api);
	const read = await chat.readThread("session-1", "thread-1");
	assert.equal(read.thread.agentId, "agent-1");
	assert.deepEqual(read.thread.origin, { type: "root" });
});

test("Chat service preserves complete transcript items from reads and updates", async () => {
	const items: Thread["turns"][number]["items"] = [
		{ type: "reasoning", itemId: "reasoning-1", turnId: "turn-1", text: "Checking", state: [{ scope: "provider/model", item: { id: "encrypted-state" } }] },
		{
			type: "toolCall", itemId: "call-1", turnId: "turn-1", toolCallId: "tool-1", name: "shell", argumentsJson: '{}',
			binding: {
				registryGeneration: 3, definitionDigest: "digest", sourceChain: [{ type: "product", component: "shell" }],
				activity: { type: "run" }, caller: { type: "direct" },
			},
		},
		{
			type: "toolResult", itemId: "result-1", turnId: "turn-1", toolCallId: "tool-1", text: "Done", isError: false,
			content: [{ type: "text", text: "Done" }, { type: "imageUrl", url: "https://example.test/image.png", detail: "high" }],
		},
	];
	const original = thread("Done");
	const currentThread: Thread = { ...original, turns: original.turns.map(turn => ({ ...turn, items })) };
	const fake = fakeApi({ thread: () => currentThread });
	using chat = createChatService(fake.api);
	const read = await chat.readThread("session-1", "thread-1");
	assert.deepEqual(read.thread.turns[0].items, items);
	assert.deepEqual(read.transcript.entries.map(entry => entry.type === "item" ? entry.item : undefined), items);

	const updates: ThreadTranscriptUpdateEnvelope[] = [];
	using listener = chat.onDidUpdateThreadTranscript(update => updates.push(update));
	fake.emit({
		method: "session/thread/transcript/update",
		params: {
			sessionId: "session-1", threadId: "thread-1", durableSequence: 4, revision: 5,
			changes: items.map(item => ({ type: "upsert" as const, entry: { type: "item" as const, entryId: `item:${item.itemId}`, turnId: item.turnId, item, transient: false } })),
		},
	});
	assert.deepEqual(updates[0]?.changes.map(change => change.type === "upsert" && change.entry.type === "item" ? change.entry.item : undefined), items);
});

test("Chat service accepts committed fork-history import notifications", () => {
	const fake = fakeApi();
	using chat = createChatService(fake.api);
	const updates: ThreadUpdateEnvelope[] = [];
	using listener = chat.onDidUpdateThread(update => updates.push(update));

	fake.emit({
		method: "session/thread/update",
		params: {
			sessionId: "session-1",
			threadId: "thread-1",
			durableSequence: 2,
			update: {
				type: "committed",
				event: {
					type: "forkHistoryImported",
					threadId: "thread-1",
					sourceThreadId: "thread-source",
					sourceSequence: 7,
					turns: [],
				},
			},
		},
	});

	assert.deepEqual(updates, [{
		sessionId: "session-1",
		threadId: "thread-1",
		durableSequence: 2,
		streamCursor: undefined,
		update: { type: "committed", event: { type: "forkHistoryImported" } },
	}]);
});

test("Chat service projects unique enabled Skills and submits the exact pinned reference", async () => {
	const commit = {
		id: { source: "user:skill-source:test", name: "commit" },
		description: "Draft a commit message",
		contentDigest: "sha256:commit",
		enabled: true,
		compatible: true,
	};
	const fake = fakeApi({
		skills: [
			commit,
			{ ...commit, id: { source: "workspace:disabled-commit", name: "commit" }, enabled: false },
			{ ...commit, id: { source: "workspace:one", name: "duplicate" } },
			{ ...commit, id: { source: "workspace:two", name: "duplicate" } },
			{ ...commit, id: { source: "workspace:disabled", name: "disabled" }, enabled: false },
		]
	});
	using chat = createChatService(fake.api);

	const selectors = await chat.listSkillSelectors();

	assert.deepEqual(selectors, [{
		name: "commit",
		description: "Draft a commit message",
		source: "user:skill-source:test",
		skill: {
			id: { source: "user:skill-source:test", name: "commit" },
			version: { type: "pinnedDigest", digest: "sha256:commit" },
		},
	}]);
	await chat.startTurn({ sessionId: "session-1", threadId: "thread-1", expectedSequence: 1, text: "$commit staged changes", mode: "agent", skills: [selectors[0]!.skill] });
	assert.deepEqual(fake.turnStartRequests[0]?.input, [
		{ type: "skill", skill: selectors[0]!.skill },
		{ type: "text", text: "$commit staged changes" },
	]);
});

test("Language models service applies product visibility defaults and persists manual changes", async () => {
	const enabled = [
		{ provider: 'openai', model: 'gpt-6.1-sol' },
		{ provider: 'openai', model: 'gpt-6-astra' },
		{ provider: 'openai', model: 'gpt-6-luna' },
		{ provider: 'anthropic', model: 'claude-opus-5-5' },
		{ provider: 'anthropic', model: 'claude-sonnet-5-5' },
		{ provider: 'xai', model: 'grok-4.7' },
	].map(model => ({ model, displayName: model.model }));
	const older = { model: { provider: 'openai', model: 'gpt-5.6' }, displayName: 'GPT-5.6' };
	const custom = { model: { provider: 'custom-gateway', model: 'private-model' }, displayName: 'Private model' };
	const catalog = [...enabled, older, custom];
	const fake = fakeApi({ models: catalog });
	using configuration = new WorkbenchConfigurationService();
	using chat = createChatService(fake.api, configuration);

	assert.deepEqual((await modelsFor(chat).listModels()).map(({ model, displayName }) => ({ model, displayName })), enabled);
	assert.deepEqual((await modelsFor(chat).listModelCatalog()).map(({ model, displayName }) => ({ model, displayName })), catalog);
	assert.equal(fake.modelListRequests.length, 1);
	await modelsFor(chat).setModelVisible(older.model, true);
	await modelsFor(chat).setModelVisible(enabled[0]!.model, false);
	assert.deepEqual((await modelsFor(chat).listModels()).map(({ model, displayName }) => ({ model, displayName })), [...enabled.slice(1), older]);
	assert.deepEqual(configuration.getValue(ModelCatalogConfiguration.hiddenModels), [
		{ ...older.model, visible: true }, enabled[0]!.model,
	]);
	using restored = createChatService(fake.api, configuration);
	assert.deepEqual((await modelsFor(restored).listModels()).map(({ model, displayName }) => ({ model, displayName })), [...enabled.slice(1), older]);
	await modelsFor(restored).setModelVisible(older.model, false);
	await modelsFor(restored).setModelVisible(enabled[0]!.model, true);
	assert.deepEqual(configuration.getValue(ModelCatalogConfiguration.hiddenModels), []);
	assert.deepEqual((await modelsFor(chat).listModels()).map(({ model, displayName }) => ({ model, displayName })), enabled);
	await configuration.updateValue(ModelCatalogConfiguration.hiddenModels, [older.model, enabled[0]!.model]);
	assert.deepEqual((await modelsFor(chat).listModels()).map(({ model, displayName }) => ({ model, displayName })), enabled.slice(1));
	await configuration.updateValue(ModelCatalogConfiguration.hiddenModels, [{ ...older.model, visible: true }, enabled[0]!.model]);
	assert.deepEqual((await modelsFor(chat).listModels()).map(({ model, displayName }) => ({ model, displayName })), [...enabled.slice(1), older]);
	await modelsFor(chat).refreshModels();
	assert.equal(fake.modelListRequests.length, 3);
	const definition = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).getConfiguration(ModelCatalogConfiguration.hiddenModels)!;
	assert.deepEqual(definition.serialize(definition.parse([{ ...older.model, visible: true }, enabled[0]!.model])), [
		{ ...older.model, visible: true }, enabled[0]!.model,
	]);
	assert.throws(() => definition.parse([{ ...older.model, visible: 'true' }]), /must be a boolean/);
});

test('Cowork and Code keep independent defaults and model choices for the same draft', async () => {
	const codeModel = { model: { provider: 'openai', model: 'gpt-6.1-sol' }, displayName: 'Code model' };
	const coworkModel = { model: { provider: 'anthropic', model: 'claude-opus-5-5' }, displayName: 'Cowork model' };
	const fake = fakeApi({ models: [codeModel, coworkModel], createSession: session('created', 'created-thread'), thread: () => ({ ...thread(), threadId: 'created-thread' }) });
	using configuration = new WorkbenchConfigurationService();
	using storage = createTestStorage();
	await configuration.updateValue(ModelCatalogConfiguration.defaultModel, 'openai/gpt-6.1-sol');
	await configuration.updateValue(CoworkModelPreferences.defaultModelSetting, 'anthropic/claude-opus-5-5');
	using chat = createChatService(fake.api, configuration, storage);
	using sessions = new SessionsManagementService(fake.api);
	const draft = sessions.createUntitledSession();
	using code = createWidgetModel(chat, { kind: 'untitled', session: draft }, sessions);
	using services = new InstantiationService();
	services.registerInstance(IConfigurationService, configuration);
	services.registerInstance(IStorageService, storage);
	services.registerInstance(ILanguageModelsService, modelsFor(chat));
	using preferences = services.createInstance(CoworkModelPreferencesService, CoworkModelPreferences);
	services.registerInstance(ICoworkModelPreferences, preferences);
	using cowork = services.createInstance(CoworkWidgetModel, chat, { kind: 'untitled', session: draft }, sessions);
	await Promise.all([code.initialize(), cowork.initialize()]);
	assert.deepEqual([code.selectedModel, cowork.selectedModel], [codeModel.model, coworkModel.model]);
	await code.selectModel(codeModel.model);
	await cowork.selectAutomaticModel();
	assert.deepEqual([code.selectedModel, cowork.selectedModel], [codeModel.model, undefined]);
	await cowork.selectModel(codeModel.model);
	await code.selectModel(coworkModel.model);
	assert.deepEqual([code.selectedModel, cowork.selectedModel], [coworkModel.model, codeModel.model]);
	await code.selectModel(codeModel.model);
	await cowork.selectModel(coworkModel.model);
	await configuration.updateValue(ModelCatalogConfiguration.defaultModel, '');
	await configuration.updateValue(CoworkModelPreferences.defaultModelSetting, '');
	assert.deepEqual([code.selectedModel, cowork.selectedModel], [codeModel.model, coworkModel.model]);
	using restoredCodePreferences = services.createInstance(LanguageModelsConfigurationService, ChatModelPreferences);
	using restoredCoworkPreferences = services.createInstance(CoworkModelPreferencesService, CoworkModelPreferences);
	const catalog = await modelsFor(chat).listModels();
	assert.deepEqual([restoredCodePreferences.getDefaultNewChatModel(catalog), restoredCoworkPreferences.getDefaultNewChatModel(catalog)], [codeModel.model, coworkModel.model]);
	assert.deepEqual(sessions.untitledSessions.find(session => session.untitledSessionId === draft.untitledSessionId)?.model, codeModel.model);
	await cowork.send('Use the Cowork model');
	assert.deepEqual(fake.turnStartRequests.at(-1)?.model, coworkModel.model);
});

test('Cowork default model settings use the Chinese catalog and reject invalid values', () => {
	initializeTestLocalization('zh-CN');
	try {
		const setting = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).getConfiguration(CoworkModelPreferences.defaultModelSetting)!;
		const schema = setting.setting;
		assert.ok(schema?.valueType === 'text');
		assert.deepEqual([schema.title, schema.description, schema.placeholder], ['默认 Cowork 模型', '新 Cowork 对话使用的模型。填写 auto 或 provider/model 标识。', 'auto 或 provider/model']);
		assert.throws(() => setting.parse(42), /默认 Cowork 模型必须是字符串/);
		assert.equal(setting.parse(' auto '), 'auto');
	} finally { resetNlsResolver(); }
});

test('New chats use the configured model before the remembered picker choice', async () => {
	const first = { model: { provider: 'openai', model: 'gpt-6.1-sol' }, displayName: 'First' };
	const second = { model: { provider: 'anthropic', model: 'claude-opus-5-5' }, displayName: 'Second' };
	const fake = fakeApi({
		models: [first, second],
		createSession: session('created', 'created-thread'),
		thread: () => ({ ...thread(), threadId: 'created-thread' }),
	});
	using configuration = new WorkbenchConfigurationService();
	using storage = createTestStorage();
	using chat = createChatService(fake.api, configuration, storage);
	using sessions = new SessionsManagementService(fake.api);
	modelsFor(chat).rememberSelectedModel(first.model);
	await configuration.updateValue(ModelCatalogConfiguration.defaultModel, 'anthropic/claude-opus-5-5');
	const configuredDraft = sessions.createUntitledSession();
	using configured = createWidgetModel(chat, { kind: 'untitled', session: configuredDraft }, sessions);
	await configured.initialize();
	assert.deepEqual(configured.selectedModel, second.model);
	await configured.send('Use the configured model');
	assert.deepEqual(fake.turnStartRequests.at(-1)?.model, second.model);

	await configuration.updateValue(ModelCatalogConfiguration.defaultModel, '');
	const rememberedDraft = sessions.createUntitledSession();
	using remembered = createWidgetModel(chat, { kind: 'untitled', session: rememberedDraft }, sessions);
	await remembered.initialize();
	assert.deepEqual(remembered.selectedModel, first.model);
	await remembered.send('Use the remembered model');
	assert.deepEqual(fake.turnStartRequests.at(-1)?.model, first.model);
	using restoredChatService = createChatService(fake.api, configuration, storage);
	assert.deepEqual(modelsFor(restoredChatService).getDefaultNewChatModel(await modelsFor(restoredChatService).listModels()), first.model);
	await configuration.updateValue(ModelCatalogConfiguration.defaultModel, 'missing/model');
	assert.deepEqual(modelsFor(chat).getDefaultNewChatModel(await modelsFor(chat).listModels()), first.model);
	await configuration.updateValue(ModelCatalogConfiguration.defaultModel, 'auto');
	const automaticDraft = sessions.createUntitledSession();
	using automatic = createWidgetModel(chat, { kind: 'untitled', session: automaticDraft }, sessions);
	await automatic.initialize();
	assert.equal(automatic.isAutomaticModel, true);
});

test('A manual model choice stays with its chat while later new chats use the new default', async () => {
	const first = { model: { provider: 'openai', model: 'gpt-6.1-sol' }, displayName: 'First' };
	const second = { model: { provider: 'anthropic', model: 'claude-opus-5-5' }, displayName: 'Second' };
	const fake = fakeApi({ models: [first, second] });
	using configuration = new WorkbenchConfigurationService();
	using storage = createTestStorage();
	using chat = createChatService(fake.api, configuration, storage);
	using sessions = new SessionsManagementService(fake.api);
	const firstDraft = sessions.createUntitledSession();
	using firstChat = createWidgetModel(chat, { kind: 'untitled', session: firstDraft }, sessions);
	await firstChat.initialize();
	await firstChat.selectModel(first.model);
	await configuration.updateValue(ModelCatalogConfiguration.defaultModel, 'anthropic/claude-opus-5-5');
	await waitFor(() => firstChat.models.length === 2);
	assert.deepEqual(firstChat.selectedModel, first.model);
	const secondDraft = sessions.createUntitledSession();
	using secondChat = createWidgetModel(chat, { kind: 'untitled', session: secondDraft }, sessions);
	await secondChat.initialize();
	assert.deepEqual(secondChat.selectedModel, second.model);

	await secondChat.selectAutomaticModel();
	await configuration.updateValue(ModelCatalogConfiguration.defaultModel, 'openai/gpt-6.1-sol');
	assert.equal(secondChat.isAutomaticModel, true);
	const thirdDraft = sessions.createUntitledSession();
	using thirdChat = createWidgetModel(chat, { kind: 'untitled', session: thirdDraft }, sessions);
	await thirdChat.initialize();
	assert.deepEqual(thirdChat.selectedModel, first.model);
});

test('Model discovery refreshes the picker after an older catalog request completes', async () => {
	const discovered: Awaited<ReturnType<IRendererHost['model']['listProviderModels']>>[number] = createTestModel({
		model: { provider: 'custom-gateway', model: 'private-model' }, display_name: 'Private model', discovered: true,
		description: 'Private model overview',
		context_window: null, default_context_window: null, maximum_context_window: null, context_window_options: [], fast_enabled: false,
		auto_compact_token_limit: null, capabilities: { tools: 'supported', reasoning: 'unknown', parallel_tool_calls: 'unknown', personality: 'unknown', image_detail_original: 'unknown', fast_mode: 'unknown' },
		supported_reasoning_efforts: [{ effort: 'low', description: 'Quick tasks' }], default_reasoning_effort: null, default_personality: null,
	});
	discovered.capabilities.fast_mode = 'supported';
	discovered.settings.service_tiers = [{ id: 'priority', name: 'Priority lane', description: 'Faster processing' }];
	discovered.settings.acceleration = { type: 'service_tier', service_tier: 'priority' };
	const initial = new DeferredPromise<Awaited<ReturnType<IRendererHost['model']['listModels']>>>();
	const fake = fakeApi();
	let loads = 0;
	using chat = createChatService({
		...fake.api, model: {
			...fake.api.model,
			listModels: async () => ++loads === 1 ? initial.p : { models: [discovered] },
			listProviderModels: async () => [discovered],
		}
	});
	const models = modelsFor(chat);
	const oldCatalog = models.listModelCatalog();
	const discovery = models.discoverProviderModels('custom-gateway');
	await initial.complete({ models: [] });
	assert.deepEqual(await oldCatalog, []);
	const pickerEntry = {
		model: discovered.model, displayName: discovered.display_name, description: discovered.description, discovered: true,
		contextWindow: null, defaultContextWindow: null, maximumContextWindow: null, contextWindowOptions: [],
		supportsFast: true, fast: false, supportedReasoningEfforts: [{ effort: 'low', description: 'Quick tasks' }],
		acceleration: { name: 'Priority lane', description: 'Faster processing' },
	};
	assert.deepEqual(await discovery, [pickerEntry]);
	assert.deepEqual(await models.listModelCatalog(), [pickerEntry]);
	assert.deepEqual(await models.listModels(), []);
	await models.setModelVisible(discovered.model, true);
	assert.deepEqual(await models.listModels(), [pickerEntry]);
	assert.equal(loads, 2);
	let changes = 0;
	using subscription = models.onDidChangeModels(() => changes++);
	discovered.settings.service_tiers[0].description = 'Updated processing terms';
	const refreshed = await models.refreshModels();
	assert.deepEqual(refreshed[0].acceleration, { name: 'Priority lane', description: 'Updated processing terms' });
	assert.equal(changes, 1);
	assert.equal(pickerEntry.acceleration.description, 'Faster processing');
	discovered.description = 'Updated overview';
	discovered.supported_reasoning_efforts[0].description = 'Updated explanation';
	const explained = await models.refreshModels();
	assert.equal(explained[0].description, 'Updated overview');
	assert.deepEqual(explained[0].supportedReasoningEfforts, [{ effort: 'low', description: 'Updated explanation' }]);
	assert.equal(changes, 2);
	assert.equal(pickerEntry.description, 'Private model overview');
	assert.equal(pickerEntry.supportedReasoningEfforts[0].description, 'Quick tasks');
});

test("Language models service includes ready Kimi connections in the model catalog", async () => {
	const desktop = { model: { provider: 'kimi-desktop', model: 'desktop-k2' }, displayName: 'Desktop K2' };
	const cli = { model: { provider: 'kimi-cli', model: 'cli-k2' }, displayName: 'CLI K2' };
	const provider = (connection: string): ModelProviderCredentialStatus => ({
		connection, provider: connection, displayName: connection, access: 'subscription',
		active: true, configured: true, ready: true, apiKeyPolicy: 'unsupported', apiKeyConfigured: false,
	});
	const fake = fakeApi({
		providers: [provider('kimi-desktop'), provider('kimi-cli')],
		providerModels: { 'kimi-desktop': [desktop], 'kimi-cli': [cli] },
	});
	using chat = createChatService(fake.api);

	assert.deepEqual((await modelsFor(chat).listModelCatalog()).map(({ model, displayName }) => ({ model, displayName })), [desktop, cli]);
	assert.deepEqual(fake.providerModelRequests, ['kimi-desktop', 'kimi-cli']);
	assert.deepEqual((await modelsFor(chat).listModelCatalog()).map(({ model, displayName }) => ({ model, displayName })), [desktop, cli]);
	assert.deepEqual(fake.providerModelRequests, ['kimi-desktop', 'kimi-cli']);
});

test("Chat picker excludes a hidden selected model", async () => {
	const entry = {
		model: { provider: "openai", model: "gpt-5.6-sol" },
		displayName: "GPT-5.6 Sol",
	};
	const activeSession = { ...session("session-1", "thread-1"), model: entry.model };
	const fake = fakeApi({ sessions: [activeSession], models: [entry] });
	using configuration = new WorkbenchConfigurationService();
	await configuration.updateValue(ModelCatalogConfiguration.hiddenModels, [entry.model]);
	using chat = createChatService(fake.api, configuration);
	using sessions = new SessionsManagementService(fake.api);
	using model = createWidgetModel(chat, { kind: "session", active: { session: activeSession, threadId: "thread-1" } }, sessions);

	await model.initialize();

	assert.deepEqual(await modelsFor(chat).listModels(), []);
	assert.deepEqual(model.models, []);
	assert.deepEqual(model.selectedModel, entry.model);
});

test("ChatWidgetModel selects models per chat without changing the global model", async () => {
	const firstModel: ModelRef = { provider: "openai", model: "gpt-first" };
	const secondModel: ModelRef = { provider: "openai", model: "gpt-second" };
	const activeSession = {
		...session("session-1", "thread-1"),
		chats: [
			{ threadId: "thread-1", origin: { type: "root" as const }, status: "active" as const },
			{ threadId: "thread-2", origin: { type: "root" as const }, status: "active" as const },
		],
	};
	let currentThread = thread();
	const fake = fakeApi({ sessions: [activeSession], thread: () => currentThread });
	using chat = createChatService(fake.api);
	using sessions = new SessionsManagementService(fake.api);
	using model = createWidgetModel(chat, { kind: "session", active: { session: activeSession, threadId: "thread-1" } }, sessions);
	await model.initialize();

	await model.selectModel(firstModel);
	await model.send("first chat");
	currentThread = { ...thread(), threadId: "thread-2" };
	await model.selectThread({ session: activeSession, threadId: "thread-2" });
	await model.selectModel(secondModel);
	await model.send("second chat");
	currentThread = thread();
	await model.selectThread({ session: activeSession, threadId: "thread-1" });

	assert.deepEqual(fake.turnStartRequests.map(request => request.model), [firstModel, secondModel]);
	assert.deepEqual(model.selectedModel, firstModel);
	assert.equal(fake.modelRequests.length, 0);
});

test('ChatWidgetModel sends the selected model thinking effort with its Turn', async () => {
	const first = { model: { provider: 'openai', model: 'gpt-6.1-sol' }, displayName: 'First', supportedReasoningEfforts: [{ effort: 'low' }, { effort: 'high' }] as const };
	const second = { model: { provider: 'openai', model: 'gpt-6-astra' }, displayName: 'Second', supportedReasoningEfforts: [{ effort: 'medium' }] as const };
	const activeSession = session('session-1', 'thread-1');
	const previous = thread('previous answer');
	const fake = fakeApi({
		sessions: [activeSession], models: [first, second],
		thread: () => ({ ...previous, turns: previous.turns.map(turn => ({ ...turn, model: first.model, reasoningEffort: 'high' as const })) }),
	});
	using chat = createChatService(fake.api);
	using sessions = new SessionsManagementService(fake.api);
	using model = createWidgetModel(chat, { kind: 'session', active: { session: activeSession, threadId: 'thread-1' } }, sessions);
	await model.initialize();

	assert.equal(model.inputState.selectedReasoningEffort, 'high');
	await model.selectReasoningEffort(undefined);
	assert.equal(model.inputState.selectedReasoningEffort, undefined);
	await model.selectModel(first.model);
	await model.selectReasoningEffort('high');
	assert.equal(model.inputState.selectedReasoningEffort, 'high');
	await model.send('Use high effort');
	assert.equal(fake.turnStartRequests[0]?.reasoningEffort, 'high');

	await model.selectModel(second.model);
	assert.equal(model.inputState.selectedReasoningEffort, undefined);
	await assert.rejects(model.selectReasoningEffort('high'), /does not support/);
	await model.selectAutomaticModel();
	assert.equal(model.inputState.selectedReasoningEffort, undefined);
	await assert.rejects(model.selectReasoningEffort('medium'), /Select a model/);
});

test('New Chat keeps its thinking effort when it creates a Thread', async () => {
	const entry = { model: { provider: 'openai', model: 'gpt-6.1-sol' }, displayName: 'First', supportedReasoningEfforts: [{ effort: 'low' }, { effort: 'high' }] as const };
	const fake = fakeApi({
		models: [entry],
		createSession: session('session-1', undefined, 'New Chat'),
		createThread: { session: session('session-1', 'thread-1', 'New Chat'), threadId: 'thread-1' },
	});
	using chat = createChatService(fake.api);
	using sessions = new SessionsManagementService(fake.api);
	const untitled = sessions.createUntitledSession();
	using model = createWidgetModel(chat, { kind: 'untitled', session: untitled }, sessions);
	await model.initialize();

	await model.selectModel(entry.model);
	model.selectUntitledSession(sessions.untitledSessions.find(session => session.untitledSessionId === untitled.untitledSessionId)!);
	await model.selectReasoningEffort('high');
	await model.send('Use high effort');

	assert.equal(fake.turnStartRequests[0]?.reasoningEffort, 'high');
	assert.equal(model.inputState.selectedReasoningEffort, 'high');
});

test('ChatWidgetModel returns to the session model when Auto is selected', async () => {
	const sessionModel: ModelRef = { provider: 'openai', model: 'gpt-default' };
	const manualModel: ModelRef = { provider: 'openai', model: 'gpt-manual' };
	const activeSession = { ...session('session-1', 'thread-1'), model: sessionModel };
	const fake = fakeApi({ sessions: [activeSession] });
	using chat = createChatService(fake.api);
	using sessions = new SessionsManagementService(fake.api);
	using model = createWidgetModel(chat, { kind: 'session', active: { session: activeSession, threadId: 'thread-1' } }, sessions);
	await model.initialize();

	await model.selectModel(manualModel);
	assert.equal(model.inputState.isAutomaticModel, false);
	await model.selectAutomaticModel();
	assert.equal(model.inputState.isAutomaticModel, true);
	assert.deepEqual(model.selectedModel, sessionModel);
	await model.send('Use the session model');

	assert.equal(fake.turnStartRequests[0]?.model, undefined);
});

test('ChatWidgetModel sends image-only input using the selected approval mode', async () => {
	const fake = fakeApi({
		createSession: session('session-1', undefined, 'New Chat'),
		createThread: { session: session('session-1', 'thread-1', 'New Chat'), threadId: 'thread-1' },
	});
	using chat = createChatService(fake.api);
	using sessions = new SessionsManagementService(fake.api);
	using model = createWidgetModel(chat, { kind: 'untitled', session: sessions.createUntitledSession() }, sessions);
	await model.initialize();
	model.selectApprovalMode('auto');
	await model.send('', 'agent', undefined, [{ name: 'image.png', content: 'data:image/png;base64,aGVsbG8=', kind: 'image' }]);
	assert.equal(fake.turnStartRequests[0]?.approvalMode, 'auto');
	assert.deepEqual(fake.turnStartRequests[0]?.input, [{ type: 'image', url: 'data:image/png;base64,aGVsbG8=' }]);
	assert.equal(model.inputState.approvalMode, 'auto');
});

test("ChatWidgetModel steers an active Turn instead of starting another Turn", async () => {
	const activeSession = session("session-1", "thread-1");
	const activeThread: Thread = {
		...thread(),
		sequence: 4,
		turns: [{
			turnId: "turn-running",
			status: "running",
			mode: "agent",
			kind: "coding",
			toolMode: "direct",
			approvalMode: "manual",
			usage: emptyUsage(),
			items: [{
				type: "userMessage",
				itemId: "item-user",
				turnId: "turn-running",
				text: "initial request",
			}],
		}],
	};
	const fake = fakeApi({ sessions: [activeSession], thread: () => activeThread });
	using chat = createChatService(fake.api);
	using sessions = new SessionsManagementService(fake.api);
	using model = createWidgetModel(chat, { kind: "session", active: { session: activeSession, threadId: "thread-1" } }, sessions);
	await model.initialize();

	await model.send("focus on the failing test");

	assert.equal(fake.turnStartRequests.length, 0);
	assert.deepEqual(fake.turnSteerRequests, [{
		commandId: fake.turnSteerRequests[0]?.commandId,
		sessionId: "session-1",
		threadId: "thread-1",
		turnId: "turn-running",
		expectedSequence: 4,
		input: [{ type: "text", text: "focus on the failing test" }],
	}]);
});

test("ChatWidgetModel dispatches compact as a standalone server command", async () => {
	const activeSession = session("session-1", "thread-1");
	const fake = fakeApi({ sessions: [activeSession], thread: () => thread("previous answer") });
	using chat = createChatService(fake.api);
	using sessions = new SessionsManagementService(fake.api);
	using model = createWidgetModel(chat, { kind: "session", active: { session: activeSession, threadId: "thread-1" } }, sessions);
	await model.initialize();

	await model.executeServerCommand("compact", "preserve the deployment decision");

	assert.equal(fake.turnStartRequests.length, 0);
	assert.deepEqual(fake.turnCompactRequests, [{
		commandId: fake.turnCompactRequests[0]?.commandId,
		sessionId: "session-1",
		threadId: "thread-1",
		expectedSequence: 4,
		retentionPrompt: "preserve the deployment decision",
	}]);
});

test('ChatWidgetModel queues a new mode while keeping the active Turn unchanged', async () => {
	const activeSession = session('session-1', 'thread-1');
	const value = thread('working');
	value.turns[0]!.status = 'running';
	value.turns[0]!.mode = 'plan';
	const fake = fakeApi({ sessions: [activeSession], thread: () => value });
	using chat = createChatService(fake.api);
	using sessions = new SessionsManagementService(fake.api);
	using model = createWidgetModel(chat, { kind: 'session', active: { session: activeSession, threadId: 'thread-1' } }, sessions);
	await model.initialize();
	assert.equal(model.inputState.mode, 'plan');
	model.selectMode('multitask');
	model.selectApprovalMode('auto');
	await model.send('Implement independent steps', 'multitask', undefined, [{ name: 'image.png', content: 'data:image/png;base64,aGVsbG8=', kind: 'image' }]);
	assert.equal(fake.turnStartRequests.length, 0);
	assert.equal(fake.turnSteerRequests.length, 0);
	assert.deepEqual(fake.queuedRequests, [{
		commandId: fake.queuedRequests[0]!.commandId,
		sessionId: 'session-1', threadId: 'thread-1', mode: 'multitask',
		model: undefined, reasoningEffort: undefined,
		input: [{ type: 'image', url: 'data:image/png;base64,aGVsbG8=' }, { type: 'text', text: 'Implement independent steps' }],
		approvalMode: 'auto',
	}]);
	assert.equal(model.inputState.activeMode, 'plan');
	assert.equal(value.turns[0]!.approvalMode, 'manual');
	assert.equal(model.inputState.mode, 'multitask');
});

test('Chat mode accessibility help explains switch_mode in Chinese and restores input focus', async () => {
	const { SessionsChatAccessibilityHelp } = await import('../../contrib/chat/browser/sessionsChatAccessibilityHelp.js');
	const { builtinLanguagePackCatalogs } = await import('../../../workbench/services/localization/common/localizationCatalogs.js');
	const { formatNlsMessage, setNlsResolver, resetNlsResolver } = await import('../../../nls.js');
	const chinese = builtinLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	const container = document.createElement('div');
	const input = document.createElement('textarea');
	container.append(input);
	document.body.append(container);
	setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(chinese.bundles[bundle]?.[key] ?? fallback, parameters));
	try {
		input.focus();
		const help = new SessionsChatAccessibilityHelp(container, () => input.focus());
		const provider = help.getProvider()!;
		assert.match(provider.provideContent(), /退出到 Agent、Debug 或 Multitask 需要你的选择，并保留权限模式/);
		assert.match(provider.provideContent(), /权限菜单提供 Auto、Manual 和 Bypass permissions/);
		assert.match(provider.provideContent(), /菜单打开时按 1、2、3 选择/);
		input.blur();
		provider.dispose();
		assert.equal(document.activeElement, input);
	} finally {
		container.remove();
		resetNlsResolver();
	}
});

test('ChatWidgetModel follows switch_mode while preserving a different next-message mode', async () => {
	for (const selectedMode of [undefined, 'ask'] as const) {
		const activeSession = session('session-1', 'thread-1');
		let value = thread('working');
		value.turns[0]!.status = 'running';
		const fake = fakeApi({ sessions: [activeSession], thread: () => value });
		using chat = createChatService(fake.api);
		using sessions = new SessionsManagementService(fake.api);
		using model = createWidgetModel(chat, { kind: 'session', active: { session: activeSession, threadId: 'thread-1' } }, sessions);
		await model.initialize();
		if (selectedMode) {
			model.selectMode(selectedMode);
		}
		value = { ...value, sequence: value.sequence + 1, turns: [{ ...value.turns[0]!, mode: 'plan' }] };
		const update: ServerNotification = {
			method: 'session/thread/update',
			params: {
				sessionId: 'session-1', threadId: 'thread-1', durableSequence: value.sequence,
				update: {
					type: 'committed', event: {
						type: 'turnModeChanged', threadId: 'thread-1', turnId: 'turn-1',
						fromMode: 'agent', mode: 'plan',
						instructions: { owner: 'test', id: 'approach', revision: '1', body: 'Plan the task.' },
					}
				},
			},
		};
		fake.emit(update);
		await waitFor(() => model.thread?.sequence === value.sequence);
		assert.equal(model.inputState.activeMode, 'plan');
		assert.equal(model.inputState.mode, selectedMode ?? 'plan');
		model.selectMode('agent');
		fake.emit(update);
		assert.equal(model.inputState.mode, 'agent', 'replayed events must not overwrite a later choice');
	}
});

test('ChatWidgetModel restores the mode once and keeps it when reconnecting to newer Turns', async () => {
	const activeSession = session('session-1', 'thread-1');
	let value = thread('planning');
	value.turns[0]!.mode = 'plan';
	const fake = fakeApi({ sessions: [activeSession], thread: () => value });
	using chat = createChatService(fake.api);
	using sessions = new SessionsManagementService(fake.api);
	using model = createWidgetModel(chat, { kind: 'session', active: { session: activeSession, threadId: 'thread-1' } }, sessions);
	await model.initialize();
	assert.equal(model.inputState.mode, 'plan');
	value = { ...value, sequence: value.sequence + 1, turns: [{ ...value.turns[0]!, mode: 'agent' }] };
	fake.emitReady();
	await waitFor(() => model.thread?.sequence === value.sequence);
	assert.equal(model.inputState.mode, 'plan');
	await model.send('Continue planning');
	assert.equal(fake.turnStartRequests[0]!.mode, 'plan');
});

test('ChatWidgetModel submits server commands using the selected mode', async () => {
	const activeSession = session('session-1', 'thread-1');
	const fake = fakeApi({ sessions: [activeSession] });
	using chat = createChatService(fake.api);
	using sessions = new SessionsManagementService(fake.api);
	using model = createWidgetModel(chat, { kind: 'session', active: { session: activeSession, threadId: 'thread-1' } }, sessions);
	await model.initialize();
	model.selectMode('ask');
	await model.executeServerCommand('init', '');
	assert.equal(fake.turnStartRequests[0]!.mode, 'ask');
	assert.deepEqual(fake.turnStartRequests[0]!.input, [{ type: 'text', text: '/init' }]);
});

test('ChatWidgetModel retries the recorded mode independently of prompt identity', async () => {
	const activeSession = session('session-1', 'thread-1');
	const value = threadWithFailure('providerUnavailable', true);
	value.turns[0]!.mode = 'debug';
	value.turns[0]!.items = [{ type: 'userMessage', itemId: 'request', turnId: 'turn-1', text: 'Find the failure' }];
	const fake = fakeApi({ sessions: [activeSession], thread: () => value });
	using chat = createChatService(fake.api);
	using sessions = new SessionsManagementService(fake.api);
	using model = createWidgetModel(chat, { kind: 'session', active: { session: activeSession, threadId: 'thread-1' } }, sessions);
	await model.initialize();
	model.selectMode('ask');
	await model.retryFailedTurn('turn-1');
	assert.equal(fake.turnStartRequests[0]!.mode, 'debug');
});

function testLayoutService(auxiliaryBarVisible = true): IWorkbenchLayoutService {
	const visibility = new Emitter<WorkbenchPartVisibilityChangeEvent>();
	const visibleParts = new Set<WorkbenchPartId>(auxiliaryBarVisible ? ["auxiliarybar"] : []);
	const updateVisibility = (partId: WorkbenchPartId, visible: boolean): void => {
		if (visible === visibleParts.has(partId)) return;
		if (visible) visibleParts.add(partId);
		else visibleParts.delete(partId);
		visibility.fire({ partId, visible });
	};
	return {
		onDidChangePartVisibility: visibility.event,
		isPartVisible: (partId) => visibleParts.has(partId),
		showPart: (partId) => updateVisibility(partId, true),
		showParts: (partIds) => partIds.forEach((partId) => updateVisibility(partId, true)),
		hidePart: (partId) => updateVisibility(partId, false),
		hideParts: (partIds) => partIds.forEach((partId) => updateVisibility(partId, false)),
	} as IWorkbenchLayoutService;
}

function fakeApi(options: FakeOptions = {}): {
	readonly api: IRendererHost;
	readonly archiveRequests: readonly SessionMutationParams[];
	readonly stopRequests: readonly SessionMutationParams[];
	readonly createSessionRequests: readonly SessionCreateParams[];
	readonly createThreadRequests: readonly SessionOperationInput<"createThread">[];
	readonly turnStartRequests: readonly SessionOperationInput<"startTurn">[];
	readonly queuedRequests: readonly QueueEnqueueParams[];
	readonly advisorRequests: readonly SessionOperationInput<"configureAdvisor">[];
	readonly consultRequests: readonly SessionOperationInput<"consultAdvisor">[];
	readonly turnCompactRequests: readonly SessionOperationInput<"compactContext">[];
	readonly turnSteerRequests: readonly SessionOperationInput<"steerTurn">[];
	readonly modelListRequests: readonly undefined[];
	readonly providerModelRequests: readonly string[];
	readonly providerKeyRequests: readonly { readonly connection: string; readonly apiKey: string; }[];
	readonly modelRequests: readonly { readonly commandId: string; readonly model: ModelRef; }[];
	readonly savedAdvisorDefaults: readonly (AdvisorConfig | null)[];
	readonly emit: (notification: ServerNotification) => void;
	readonly emitReady: () => void;
} {
	const listeners = new Set<(notification: ServerNotification) => void>();
	const connectionListeners = new Set<(state: "ready") => void>();
	const archiveRequests: SessionMutationParams[] = [];
	const stopRequests: SessionMutationParams[] = [];
	const createSessionRequests: SessionCreateParams[] = [];
	const createThreadRequests: SessionOperationInput<"createThread">[] = [];
	const turnStartRequests: SessionOperationInput<"startTurn">[] = [];
	const queuedRequests: QueueEnqueueParams[] = [];
	const advisorRequests: SessionOperationInput<"configureAdvisor">[] = [];
	const consultRequests: SessionOperationInput<"consultAdvisor">[] = [];
	const turnCompactRequests: SessionOperationInput<"compactContext">[] = [];
	const turnSteerRequests: SessionOperationInput<"steerTurn">[] = [];
	const modelListRequests: undefined[] = [];
	const providerModelRequests: string[] = [];
	const providerKeyRequests: { connection: string; apiKey: string; }[] = [];
	let providers = options.providers?.map(provider => ({ ...provider })) ?? [];
	const modelRequests: { readonly commandId: string; readonly model: ModelRef; }[] = [];
	const savedAdvisorDefaults: (AdvisorConfig | null)[] = [];
	let advisorDefault: AdvisorConfig | null = options.advisorDefault ?? null;
	const currentThread = () => options.thread?.() ?? thread();
	const currentSession = (sessionId: string): ISession => options.sessions?.find(candidate => candidate.sessionId === sessionId)
		?? (options.createThread?.session.sessionId === sessionId ? options.createThread.session : undefined)
		?? (options.createSession?.sessionId === sessionId ? options.createSession : undefined)
		?? session(sessionId);
	const api = {
		appServer: {
			getConnectionState: async () => "ready" as const,
			getSlashCommands: async () => [],
			onConnectionState: (next: (state: "ready") => void) => {
				connectionListeners.add(next);
				return { dispose: () => { connectionListeners.delete(next); } };
			},
		},
		session: {
			listAgents: async () => {
				if (options.agentListFails?.()) throw new Error('Agent list unavailable');
				return { agents: (options.agents ?? []).map(agent => ({ name: agent.name, description: agent.description, source: { type: 'directory' as const, id: agent.sourceId } })) };
			},
			list: async () => ({ sessions: (options.sessions ?? []).map(sessionDto) }),
			subscribeCatalog: async () => ({ sessions: (options.sessions ?? []).map(sessionDto) }),
			unsubscribeCatalog: async () => undefined,
			readCatalog: async ({ sessionId }: { sessionId: string; }) => ({ session: sessionDto(currentSession(sessionId)) }),
			read: async ({ sessionId }: { sessionId: string; }) => ({
				session: sessionDto(currentSession(sessionId)),
			}),
			subscribe: async ({ sessionId }: { sessionId: string; }) => ({
				session: sessionDto(currentSession(sessionId)),
				updates: [],
				threadProjections: [],
				agentTree: { roots: [] },
			}),
			unsubscribe: async () => undefined,
			create: async (params: SessionCreateParams) => {
				createSessionRequests.push(params);
				if (options.createSessionError) throw options.createSessionError;
				return { session: sessionDto(options.createSession ?? session("created")) };
			},
			createThread: async (params: SessionOperationInput<"createThread">) => {
				createThreadRequests.push(params);
				const created = options.createThread ?? {
					session: session("created", "created-thread"),
					threadId: "created-thread",
				};
				return { ...created, session: sessionDto(created.session) };
			},
			archive: async (params: SessionMutationParams) => {
				archiveRequests.push(params);
				const archived = options.sessions?.find(
					({ sessionId }) => sessionId === params.sessionId,
				) ?? session(params.sessionId);
				return {
					session: {
						...sessionDto(archived),
						status: "archived" as const,
					},
				};
			},
			stop: async (params: SessionMutationParams) => {
				stopRequests.push(params);
				const stopped = options.sessions?.find(
					({ sessionId }) => sessionId === params.sessionId,
				) ?? session(params.sessionId);
				return {
					session: {
						...sessionDto(stopped),
						status: "archived" as const,
					},
				};
			},
		},
		model: {
			setModelPreferences: async () => { },
			listModels: async () => {
				modelListRequests.push(undefined);
				return { models: (options.models ?? []).map(entry => createTestModel({
					model: entry.model, display_name: entry.displayName,
					context_window: entry.contextWindow ?? null,
					default_reasoning_effort: entry.defaultReasoningEffort ?? null,
					supported_reasoning_efforts: (entry.supportedReasoningEfforts ?? []).map(option => ({ ...option, description: option.description ?? null })),
				})) };
			},
			listProviders: async () => ({ providers: providers.map(provider => ({ ...provider })) }),
			listProviderModels: async (connection: string) => {
				providerModelRequests.push(connection);
				return (options.providerModels?.[connection] ?? []).map(entry => createTestModel({ model: entry.model, display_name: entry.displayName }));
			},
			setProviderApiKey: async ({ connection, apiKey }: { connection: string; apiKey: string; }) => {
				providerKeyRequests.push({ connection, apiKey });
				providers = providers.map(entry => entry.connection === connection ? { ...entry, apiKeyConfigured: true, active: true, configured: true, ready: true } : entry);
				return { connection, apiKeyConfigured: true };
			},
			readAdvisorDefault: async () => advisorDefault,
			readConfiguredProviderIds: async () => options.configuredProviders ?? [],
			setAdvisorDefault: async ({ advisor }: { readonly advisor: AdvisorConfig | null; }) => {
				advisorDefault = advisor;
				savedAdvisorDefaults.push(advisor);
			},
			readModel: async () => options.sessions?.find(session => session.model)?.model ?? null,
			setModel: async (params: { readonly commandId: string; readonly model: ModelRef; }) => {
				modelRequests.push(params);
			},
		},
		skills: {
			list: async () => ({ generation: 1, skills: options.skills ?? [] }),
		},
		thread: {
			configureAdvisor: async (params: SessionOperationInput<"configureAdvisor">) => { advisorRequests.push(params); return { sequence: params.expectedSequence + 1 }; },
			read: async () => {
				const value = currentThread();
				return { thread: value, transcript: transcript(value) };
			},
			subscribe: async () => ({
				thread: currentThread(),
				transcript: transcript(currentThread()),
				updates: [],
			}),
			unsubscribe: async () => undefined,
		},
		turn: {
			enqueue: async (params: QueueEnqueueParams) => { queuedRequests.push(params); return {}; },
			listQueued: async () => ({ messages: [] }),
			consultAdvisor: async (params: SessionOperationInput<"consultAdvisor">) => { consultRequests.push(params); return { turnId: "advisor-turn", sequence: params.expectedSequence + 1 }; },
			start: async (params: SessionOperationInput<"startTurn">) => {
				turnStartRequests.push(params);
				return { turnId: "turn-started", sequence: 2 };
			},
			compact: async (params: SessionOperationInput<"compactContext">) => {
				turnCompactRequests.push(params);
				return { turnId: "turn-compact", sequence: params.expectedSequence + 2 };
			},
			steer: async (params: SessionOperationInput<"steerTurn">) => {
				turnSteerRequests.push(params);
				return { turnId: params.turnId, sequence: params.expectedSequence + 2 };
			},
			interrupt: async () => ({ sequence: 3 }),
			resolveInteraction: async () => ({ sequence: 3 }),
		},
		events: {
			subscribe: (next: (notification: ServerNotification) => void) => {
				listeners.add(next);
				return { dispose: () => { listeners.delete(next); } };
			},
		},
	} as unknown as IRendererHost;
	return {
		api,
		archiveRequests,
		stopRequests,
		createSessionRequests,
		createThreadRequests,
		turnStartRequests,
		queuedRequests,
		advisorRequests,
		consultRequests,
		turnCompactRequests,
		turnSteerRequests,
		modelListRequests,
		providerModelRequests,
		providerKeyRequests,
		modelRequests,
		savedAdvisorDefaults,
		emit: (notification) => {
			for (const listener of listeners) listener(notification);
		},
		emitReady: () => {
			for (const listener of connectionListeners) listener("ready");
		},
	};
}

function session(
	id: string,
	threadId?: string,
	title = `Session ${id}`,
): ISession {
	return {
		sessionId: id,
		title,
		status: "active",
		nextApprovalMode: "manual",
		chats: threadId
			? [{ threadId, origin: { type: "root" }, status: "active" }]
			: [],
	};
}

function sessionDto(value: ISession): SessionDto {
	return {
		sessionId: value.sessionId,
		title: value.title,
		status: value.status,
		manager: { status: "idle", statusChangedAtUnixMs: 0 },
		threads: value.chats.map(chat => ({
			threadId: chat.threadId,
			title: `Thread ${chat.threadId}`,
			createdAtUnixMs: 0,
			completedTurnDurationMs: 0,
			usage: emptyUsage(),
			status: chat.status,
			...(chat.origin.type === "root" ? {} : { parentThreadId: chat.origin.parentThreadId }),
			...(chat.origin.type === "fork" || chat.origin.type === "rewind" ? { forkedFromId: chat.origin.parentThreadId } : {}),
		})),
	};
}

function thread(agentText?: string): Thread {
	return {
		advisor: { type: "default" },
		agentId: "agent-1",
		origin: { type: "root" },
		referenceCost: { knownAmounts: [], complete: true },
		sessionId: "session-1",
		threadId: "thread-1",
		title: "Main",
		status: "active",
		sequence: agentText ? 4 : 1,
		usage: emptyUsage(),
		turns: agentText
			? [{
				turnId: "turn-1",
				status: "completed",
				mode: "agent",
				kind: "coding",
				toolMode: "direct",
				approvalMode: "manual",
				usage: emptyUsage(),
				items: [{
					type: "agentMessage",
					itemId: "item-1",
					turnId: "turn-1",
					text: agentText,
				}],
			}]
			: [],
	};
}

function transcript(value: Thread): ThreadTranscriptSnapshot {
	return {
		sessionId: value.sessionId,
		threadId: value.threadId,
		durableSequence: value.sequence,
		revision: value.sequence,
		entries: value.turns.flatMap((turn) => [
			...turn.items.map((item) => ({ type: "item" as const, entryId: `item:${item.itemId}`, turnId: turn.turnId, item, transient: false })),
			...(turn.plan ? [{ type: "turnPlan" as const, entryId: `turn-plan:${turn.turnId}`, turnId: turn.turnId, plan: turn.plan }] : []),
			...(turn.error ? [{ type: "turnError" as const, entryId: `turn-error:${turn.turnId}`, turnId: turn.turnId, error: turn.error }] : []),
		]),
	};
}

function failedTurn(code: TurnError["code"], retryable: boolean, message = "Turn failed"): Thread["turns"][number] {
	return {
		turnId: "turn-1",
		status: "failed",
		mode: "agent",
		kind: "coding",
		toolMode: "direct",
		approvalMode: "manual",
		usage: emptyUsage(),
		items: [],
		error: { code, message, retryable },
	};
}

function threadWithFailure(code: TurnError["code"], retryable: boolean, sequence = 3): Thread {
	return {
		advisor: { type: "default" },
		agentId: "agent-1",
		origin: { type: "root" },
		referenceCost: { knownAmounts: [], complete: true },
		sessionId: "session-1",
		threadId: "thread-1",
		title: "Main",
		status: "active",
		sequence,
		usage: emptyUsage(),
		turns: [failedTurn(code, retryable)],
	};
}

function emptyUsage(): Thread["usage"] {
	return {
		modelInvocations: 0,
		inputTokens: { reported: 0, complete: true },
		outputTokens: { reported: 0, complete: true },
		cachedInputTokens: { reported: 0, complete: true },
		cacheWriteInputTokens: { reported: 0, complete: true },
		reasoningTokens: { reported: 0, complete: true },
	};
}

function typeChatText(targetWindow: typeof browserEnvironment.window, input: HTMLTextAreaElement, text: string): void {
	input.value = text;
	input.dispatchEvent(new targetWindow.Event("input", { bubbles: true }));
}

function nextTask(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 30; attempt += 1) {
		if (predicate()) return;
		await nextTask();
	}
	assert.fail("Timed out waiting for Chat view state");
}

function recordingDialogService(messages: IMessageDialogOptions[]): IDialogService {
	return {
		onWillShowDialog: Event.None,
		onDidShowDialog: Event.None,
		about: async () => { throw new Error('Unexpected about dialog'); },
		showMessage: async options => { messages.push(options); },
		info: async () => { },
		warn: async () => { },
		error: async () => { },
		confirm: async () => ({ confirmed: false }),
		input: async () => { throw new Error('Unexpected input dialog'); },
		prompt: async () => { throw new Error('Unexpected prompt'); },
	};
}


test("Audio history identifies the sender and recording duration", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	using list = createChatListWidget(dom.window.document.body);
	list.render([chatListItem({
		type: "userAudioAttachment", itemId: "audio", turnId: "turn",
		attachment: { contentDigest: "sha256:audio", mediaType: "wav", encodedBytes: 32044, durationMs: 1001 },
	})]);
	assert.equal(list.element.textContent, "YouAudio (2 seconds)");
	dom.window.close();
});


test("Advisor question consults directly without starting the worker", async () => {
	const activeSession = session("session-1", "thread-1");
	const fake = fakeApi({
		sessions: [activeSession],
		advisorDefault: { model: { provider: "openai", model: "reviewer" }, enabled: true, maxCalls: 3, maxOutputTokens: 2048 },
		thread: () => ({ ...thread("previous answer"), advisor: { type: "off" } }),
	});
	using chat = createChatService(fake.api);
	using sessions = new SessionsManagementService(fake.api);
	using model = createWidgetModel(chat, { kind: "session", active: { session: activeSession, threadId: "thread-1" } }, sessions);
	await model.initialize();
	await model.executeServerCommand("advisor", "Check src/app.rs cancellation");
	assert.equal(fake.turnStartRequests.length, 0);
	assert.equal(fake.advisorRequests.length, 0);
	assert.equal(fake.consultRequests[0]?.question, "Check src/app.rs cancellation");
	assert.equal(fake.consultRequests[0]?.threadId, "thread-1");
});

test("Advisor without a configured model keeps an untitled chat", async () => {
	const fake = fakeApi();
	using chat = createChatService(fake.api);
	using sessions = new SessionsManagementService(fake.api);
	const untitled = sessions.createUntitledSession();
	using model = createWidgetModel(chat, { kind: "untitled", session: untitled }, sessions);
	await model.initialize();
	await assert.rejects(model.executeServerCommand("advisor", "Check cancellation"), /Configure an advisor model in Chat Settings/);
	assert.equal(fake.createSessionRequests.length, 0);
	assert.equal(fake.consultRequests.length, 0);
});

test('Selecting a custom Agent in a new Chat creates the Session with its exact authorized source', async () => {
	const agent = { name: 'reviewer', description: 'Reviews changes', sourceId: 'directory-1' };
	const fake = fakeApi({
		agents: [agent],
		createSession: session('session-1'),
		createThread: { session: session('session-1', 'thread-1'), threadId: 'thread-1' },
	});
	using chat = createChatService(fake.api);
	using sessions = new SessionsManagementService(fake.api);
	using model = createWidgetModel(chat, { kind: 'untitled', session: sessions.createUntitledSession() }, sessions);
	await model.initialize();

	assert.deepEqual(await model.listAgents(), [agent]);
	model.selectAgent(agent);
	assert.deepEqual(model.inputState.selectedAgent, agent);
	await model.send('Review this change');

	assert.deepEqual(fake.createSessionRequests[0]?.agent, { type: 'exact', source: { type: 'directory', id: 'directory-1' }, name: 'reviewer' });
	assert.equal(fake.turnStartRequests[0]?.input[0]?.type, 'text');
	assert.equal(sessions.untitledSessions.length, 0);
});

test("Advisor command selects a model and the off switch preserves its settings", async () => {
	const fake = fakeApi({
		configuredProviders: ["openai"],
		models: [{ model: { provider: "openai", model: "reviewer" }, displayName: "Reviewer", }],
	});
	using chat = createChatService(fake.api);
	using sessions = new SessionsManagementService(fake.api);
	using model = createWidgetModel(chat, { kind: "untitled", session: sessions.createUntitledSession() }, sessions);
	await model.initialize();
	await model.executeServerCommand("advisor", "openai/reviewer");
	assert.equal(fake.savedAdvisorDefaults[0]?.enabled, true);
	await model.executeServerCommand("advisor", "off");
	assert.deepEqual(fake.savedAdvisorDefaults[1], { ...fake.savedAdvisorDefaults[0], enabled: false });
	await assert.rejects(model.executeServerCommand("advisor", "Check cancellation"), /Configure an advisor model/);
	await model.executeServerCommand("advisor", "openai/reviewer");
	assert.deepEqual(fake.savedAdvisorDefaults[2], fake.savedAdvisorDefaults[0]);
	await model.executeServerCommand("advisor", "clear");
	assert.equal(fake.savedAdvisorDefaults[3], null);
	assert.equal(fake.createSessionRequests.length, 0);
	assert.equal(fake.consultRequests.length, 0);
});

test("Chat Settings toggles Advisor while keeping its selected model", async () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const selected = { model: { provider: "openai", model: "reviewer" }, enabled: true, maxCalls: 5, maxOutputTokens: 4096 };
	const fake = fakeApi({ advisorDefault: selected });
	using chat = createChatService(fake.api);
	using contextKeys = new ContextKeyService();
	using quickInput = new WorkbenchQuickInputService({ container: dom.window.document.body, contextKeyService: contextKeys });
	const services = new InstantiationService();
	services.registerInstance(IChatService, chat);
	services.registerInstance(ILanguageModelsService, modelsFor(chat));
	services.registerInstance(IQuickInputService, quickInput);
	services.registerInstance(IDialogService, recordingDialogService([]));
	using keybindingFiles = new KeybindingTestServices();
	using editorServices = createTestEditorServices(undefined, keybindingFiles.services);
	using preferences = new BrowserPreferencesService({
		...emptyEditorServiceState,
		openEditor: async () => undefined,
		focusActiveEditor() { },
	}, editorServices.get(IFileTextModelService), keybindingFiles.files, keybindingFiles.profiles);
	services.registerInstance(IPreferencesService, preferences);
	using commands = new CommandService(services);
	for (const enabled of [false, true]) {
		await commands.executeCommand(OPEN_CHAT_SETTINGS_COMMAND_ID);
		const labels = [...dom.window.document.querySelectorAll(".ash-quick-pick-row-label")].map(element => element.textContent);
		assert.ok(labels.includes(enabled ? "Turn Advisor on" : "Turn Advisor off"));
		assert.ok(labels.includes("Clear saved Advisor model"));
		const input = dom.window.document.querySelector<HTMLInputElement>(".ash-quick-pick-input input");
		assert.ok(input);
		input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "ArrowDown" }));
		input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "ArrowDown" }));
		input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }));
		await waitFor(() => fake.savedAdvisorDefaults.length === (enabled ? 2 : 1));
		assert.deepEqual(fake.savedAdvisorDefaults.at(-1), { ...selected, enabled });
	}
	dom.window.close();
});

test('Chat Settings saves a masked provider key through the model API and refreshes the catalog', async () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const fake = fakeApi({
		providers: [
			{ provider: 'ollama', connection: 'ollama', access: 'apiKey', active: false, configured: false, ready: true, displayName: 'Ollama', apiKeyPolicy: 'unsupported', apiKeyConfigured: false },
			{ provider: 'openai', connection: 'openai', access: 'apiKey', active: false, configured: false, ready: false, displayName: 'OpenAI', apiKeyPolicy: 'required', apiKeyConfigured: false },
		]
	});
	using chat = createChatService(fake.api);
	using contextKeys = new ContextKeyService();
	using quickInput = new WorkbenchQuickInputService({ container: dom.window.document.body, contextKeyService: contextKeys });
	const messages: IMessageDialogOptions[] = [];
	const services = new InstantiationService();
	services.registerInstance(IChatService, chat);
	services.registerInstance(ILanguageModelsService, modelsFor(chat));
	services.registerInstance(IQuickInputService, quickInput);
	services.registerInstance(IDialogService, recordingDialogService(messages));
	using keybindingFiles = new KeybindingTestServices();
	using editorServices = createTestEditorServices(undefined, keybindingFiles.services);
	using preferences = new BrowserPreferencesService({
		...emptyEditorServiceState,
		openEditor: async () => undefined,
		focusActiveEditor() { },
	}, editorServices.get(IFileTextModelService), keybindingFiles.files, keybindingFiles.profiles);
	services.registerInstance(IPreferencesService, preferences);
	using commands = new CommandService(services);

	const choose = (value: string): void => {
		const input = dom.window.document.querySelector<HTMLInputElement>('.ash-quick-pick-input input');
		assert.ok(input);
		input.value = value;
		input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
		input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter' }));
	};
	await commands.executeCommand(OPEN_CHAT_SETTINGS_COMMAND_ID);
	choose('Manage Model Connections');
	await waitFor(() => dom.window.document.querySelector('[role="dialog"][aria-label="Model connections"]') !== null);
	const labels = [...dom.window.document.querySelectorAll('.ash-quick-pick-row-label')].map(element => element.textContent);
	assert.deepEqual(labels, ['Save key for OpenAI']);
	assert.match(dom.window.document.querySelector('.ash-quick-pick-row-description')?.textContent ?? '', /API key required/);
	choose('OpenAI');
	await waitFor(() => dom.window.document.querySelector<HTMLInputElement>('.ash-quick-pick-input input[type="password"]') !== null);
	const input = dom.window.document.querySelector<HTMLInputElement>('.ash-quick-pick-input input[type="password"]');
	assert.ok(input);
	input.value = '  test-secret  ';
	input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
	assert.equal(dom.window.document.body.textContent?.includes('test-secret'), false);
	input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter' }));
	await waitFor(() => messages.length === 1);
	assert.deepEqual(fake.providerKeyRequests, [{ connection: 'openai', apiKey: 'test-secret' }]);
	assert.equal(fake.modelListRequests.length, 2);
	assert.equal(messages[0]?.message, 'API key saved for OpenAI');
	assert.equal(input.value, '');

	await commands.executeCommand(OPEN_CHAT_SETTINGS_COMMAND_ID);
	choose('Manage Model Connections');
	await waitFor(() => dom.window.document.querySelector('[role="dialog"][aria-label="Model connections"]') !== null);
	assert.equal(dom.window.document.querySelector('.ash-quick-pick-row-description')?.textContent, 'API key saved');
	dom.window.close();
});

test("Advisor model choices include the fixed catalog before connection setup", async () => {
	const fake = fakeApi({
		configuredProviders: ["openai"],
		models: [
			{ model: { provider: "openai", model: "reviewer" }, displayName: "Reviewer", },
			{ model: { provider: "google", model: "flash" }, displayName: "Flash", },
		],
	});
	using chat = createChatService(fake.api);
	assert.deepEqual((await modelsFor(chat).listAdvisorModels()).map(entry => entry.displayName), ["Reviewer", "Flash"]);
});

test("Advisor transcript groups the call and renders advice as a disclosure", () => {
	const entries: ThreadTranscriptSnapshot["entries"] = [
		{ type: "item", entryId: "call", turnId: "turn", transient: false, item: { type: "toolCall", itemId: "call", turnId: "turn", toolCallId: "consult", name: "advisor", argumentsJson: '{"question":"Check cancellation"}' } },
		{ type: "item", entryId: "result", turnId: "turn", transient: false, item: { type: "toolResult", itemId: "result", turnId: "turn", toolCallId: "consult", text: JSON.stringify({ status: "reviewed", model: { provider: "test", model: "reviewer" }, advice: "Check **cancellation**.", question: "Check cancellation", sourceSequence: 10, usage: { inputTokens: 120, outputTokens: 8 } }), isError: false } },
	];
	const items = chatTranscriptListItems(entries);
	assert.equal(items.length, 1);
	assert.equal(items[0]?.type, "advisor");
	const container = document.createElement("div");
	using widget = createChatListWidget(container);
	widget.render(items);
	assert.equal(container.querySelector("summary")?.textContent, "Advisor · test/reviewer");
	assert.equal(container.querySelector("strong")?.textContent, "cancellation");
	assert.match(container.textContent ?? "", /120 input · 8 output/);
});

test('reconnection keeps a draft and blocks submission until thread subscription finishes', async () => {
	const activeSession = session('session-1', 'thread-1');
	const fake = fakeApi({ sessions: [activeSession] });
	const pending = new DeferredPromise<Awaited<ReturnType<typeof fake.api.thread.subscribe>>>();
	let subscriptions = 0;
	using chat = createChatService({ ...fake.api, thread: { ...fake.api.thread, subscribe: params => ++subscriptions === 1 ? fake.api.thread.subscribe(params) : pending.p } });
	using sessions = new SessionsManagementService(fake.api);
	using model = createWidgetModel(chat, { kind: 'session', active: { session: activeSession, threadId: 'thread-1' } }, sessions);
	await model.initialize();
	using contextView = new BrowserContextViewService(document.body);
	const services = createInputServices(contextView, chat);
	const delegate: ChatInputDelegate = {
		send: text => model.send(text),
		executeCommand: async () => { }, executeServerCommand: async () => { }, interrupt: async () => { },
		selectModel: async () => { }, selectReasoningEffort: async () => { }, selectAutomaticModel: async () => { },
		listAgents: async () => [], selectAgent: () => { }, selectMode: () => { },
		openModelSettings: async () => { }, resolveInteraction: async () => { },
	};
	using part = services.createInstance(ChatInputPart, document.body, delegate, {} as IContextMenuService, contextView, unavailableAccessibleViewService, notifications, ChatInputEditors, [], { modePicker: 'visible', modelPickerPosition: 'leading' });
	using changed = model.onDidChange(() => part.render(model.inputState));
	part.render(model.inputState);
	part.appendToDraft('Keep this draft');
	fake.emitReady();
	assert.equal(subscriptions, 2);
	assert.equal(model.inputState.phase, 'loading');
	await part.acceptInput();
	assert.equal(fake.turnStartRequests.length, 0);
	assert.equal((await part.captureDraft())?.draft.text, 'Keep this draft');
	await pending.complete(await fake.api.thread.subscribe({ sessionId: 'session-1', threadId: 'thread-1', afterSequence: 0 }));
	await waitFor(() => model.inputState.phase === 'ready');
	assert.equal((await part.captureDraft())?.draft.text, 'Keep this draft');
	await part.acceptInput();
	assert.deepEqual(fake.turnStartRequests.map(request => request.input), [[{ type: 'text', text: 'Keep this draft' }]]);
});

test('stream updates preserve message order and survive an older refresh snapshot', async () => {
	const activeSession = session('session-1', 'thread-1');
	let currentThread = thread();
	const fake = fakeApi({ sessions: [activeSession], thread: () => currentThread });
	const read = new DeferredPromise<Awaited<ReturnType<typeof fake.api.thread.read>>>();
	let reads = 0;
	using chat = createChatService({ ...fake.api, thread: { ...fake.api.thread, read: () => { reads++; return read.p; } } });
	using sessions = new SessionsManagementService(fake.api);
	using model = createWidgetModel(chat, { kind: 'session', active: { session: activeSession, threadId: 'thread-1' } }, sessions);
	await model.initialize();
	const emit = (revision: number, itemId: string, text: string, transient = true): void => fake.emit({
		method: 'session/thread/transcript/update', params: { sessionId: 'session-1', threadId: 'thread-1', durableSequence: 1, revision, changes: [{ type: 'upsert', entry: { type: 'item', entryId: `item:${itemId}`, turnId: 'turn-1', transient, item: { type: 'agentMessage', itemId, turnId: 'turn-1', text } } }] },
	});
	emit(2, 'first', 'Partial');
	emit(3, 'second', 'Later message');
	// A revision gap triggers a snapshot read while the first message keeps streaming.
	emit(5, 'gap', 'Not applied');
	await waitFor(() => reads === 1);
	emit(4, 'first', 'Completed', false);
	emit(3, 'first', 'Stale duplicate');
	assert.deepEqual(model.items.map(item => [item.id, item.text, item.transient]), [['item:first', 'Completed', false], ['item:second', 'Later message', true]]);
	await read.complete(await fake.api.thread.read({ sessionId: 'session-1', threadId: 'thread-1' }));
	await nextTask();
	assert.deepEqual(model.items.map(item => item.text), ['Completed', 'Later message']);
	currentThread = thread('Recovered');
	fake.emitReady();
	await waitFor(() => model.inputState.phase === 'ready');
	assert.deepEqual(model.items.map(item => item.text), ['Recovered']);
	emit(4, 'item-1', 'Replayed duplicate');
	assert.deepEqual(model.items.map(item => item.text), ['Recovered']);
});

test('approval capabilities reach the composer through committed backend notifications', async () => {
	const activeSession = session('session-1', 'thread-1');
	const fake = fakeApi({ sessions: [activeSession] });
	using chat = createChatService(fake.api);
	using sessions = new SessionsManagementService(fake.api);
	using model = createWidgetModel(chat, { kind: 'session', active: { session: activeSession, threadId: 'thread-1' } }, sessions);
	await model.initialize();
	const interaction = { requestId: 'approval-1', request: { type: 'approval' as const, request: { actionDigest: 'action', policyRevision: 'policy', reason: 'Review this write', capabilities: [{ kind: 'fileWrite' as const, scope: String.raw`C:\Users\name\file.txt` }] } } };
	fake.emit({ method: 'session/thread/update', params: { sessionId: 'session-1', threadId: 'thread-1', durableSequence: 2, update: { type: 'committed', event: { type: 'interactionRequested', threadId: 'thread-1', turnId: 'turn-1', interaction } } } });
	assert.deepEqual(model.inputState.interaction?.request, interaction.request);
	await nextTask();
});
