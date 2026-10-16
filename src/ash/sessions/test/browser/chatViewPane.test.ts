import { IChatSpeechToTextService, ChatSpeechToTextService } from '../../../workbench/contrib/chat/browser/speechToText/chatSpeechToTextService.js';
import { IRendererHostService } from '../../../platform/renderer/common/rendererHost.js';
import { setARIAContainer } from '../../../base/browser/ui/aria/aria.js';
import { ChatResponseResourceFileSystemProvider, IChatResponseResourceFileSystemProvider } from '../../../workbench/contrib/chat/common/widget/chatResponseResourceFileSystemProvider.js';
import { installEditorTestGlobals } from '../../../editor/test/browser/editorTestGlobals.js';
import { StorageScope, StorageTarget } from '../../../platform/storage/common/storage.js';
import { IAgentVoiceService } from '../../../platform/agentHost/common/agentService.js';
import { createAppServerAgentThreadService, createDisconnectedAgentThreadService } from '../../../platform/agentHost/browser/appServerAgentService.js';
import type { AppServerProtocolClient } from '../../../platform/agentHost/browser/appServerProtocolClient.js';
import { createAppServerAgentModelsService } from '../../../platform/agentHost/browser/appServerAgentModels.js';
import type { ModelListResult } from '../../../../../.build/protocol/typescript/index.js';
import { IAgentExecutionSettingsService } from '../../../platform/agentHost/common/agentExecutionSettingsService.js';
import { IPromptsService } from '../../../workbench/contrib/chat/common/promptSyntax/service/promptsService.js';
import { PromptsService } from '../../../workbench/contrib/chat/common/promptSyntax/service/promptsServiceImpl.js';
import { toSkillSelectors } from '../../../workbench/contrib/chat/common/skillSelectors.js';
import { KeybindingTestServices } from '../../../workbench/services/keybinding/test/browser/keybindingTestServices.js';
import { ChatInputPart } from '../../../workbench/contrib/chat/browser/widget/input/chatInputPart.js';
import { ChatInputEditors } from '../../../workbench/contrib/chat/browser/widget/input/chatInputEditorRegistry.js';
import type { ChatInputDelegate } from '../../../workbench/contrib/chat/browser/widget/input/chatInput.js';
import { createTestModel } from '../../../platform/agentHost/test/common/testAppServerProtocol.js';
import { ActionWidgetService, IActionWidgetService } from '../../../platform/actionWidget/browser/actionWidget.js';
import { ILanguageModelsService, LanguageModelsService } from '../../../workbench/contrib/chat/common/languageModels.js';
import { ChatModelPreferences, LanguageModelsConfigurationService } from '../../../workbench/contrib/chat/browser/languageModelsConfigurationService.js';
import { ILanguageModelsConfigurationService } from '../../../workbench/contrib/chat/common/languageModelsConfiguration.js';
import { CoworkModelPreferences } from '../../contrib/cowork/common/languageModels.js';
import { CoworkWidgetModel } from '../../contrib/cowork/browser/coworkWidgetModel.js';
import { ILanguageModelsConfigurationService as ICoworkModelPreferences } from '../../contrib/cowork/common/languageModelsConfiguration.js';
import { LanguageModelsConfigurationService as CoworkModelPreferencesService } from '../../contrib/cowork/browser/languageModelsConfigurationService.js';
import { SessionsChatAccessibilityHelp } from '../../contrib/chat/browser/sessionsChatAccessibilityHelp.js';
import { initializeTestLocalization } from '../../../workbench/services/localization/test/common/localizationTestUtils.js';
import { resetNlsResolver } from '../../../nls.js';
import { AccessibleViewRegistry } from '../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { AccessibleViewType } from '../../../platform/accessibility/browser/accessibleView.js';
import type { ServicesAccessor } from '../../../platform/instantiation/common/instantiation.js';
import { IAccountService } from '../../../platform/accounts/common/accountService.js';
import { AppServerAccountService } from '../../../workbench/services/accounts/browser/appServerAccountService.js';
import { IAgentSessionService, IAgentThreadService, IAgentTurnService } from '../../../platform/agentHost/common/agentService.js';
import { IAgentModelsService } from '../../../platform/agentHost/common/agentModels.js';
import { ITurnChangesApi } from '../../../platform/turnChanges/common/turnChangesApi.js';
import { IAppServerHookApi, IAppServerSkillApi } from '../../../platform/agentHost/common/appServerApi.js';
import { IAppServerApi, IServerEventApi, type AppServerConnectionState } from '../../../platform/agentHost/common/appServerApi.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { ChatAIDisabledSettingId } from '../../../platform/chat/common/chatSettings.js';
import { ChatContextKeys } from '../../../workbench/contrib/chat/common/actions/chatContextKeys.js';
import { WorkbenchContributionsRegistry, WorkbenchPhase } from '../../../workbench/common/contributions.js';
import { registerTestDictationOnboarding } from '../../../workbench/test/common/testDictationServices.js';
import { IVoiceCodeTranscriptionBackendService } from '../../../platform/renderer/common/dictation.js';
import { ISpeechService } from '../../../workbench/contrib/speech/common/speechService.js';
import { SpeechService } from '../../../workbench/contrib/speech/browser/speechService.js';
import { createTestEditorServices } from '../../../workbench/test/common/testEditorServices.js';
import { IGitHubService as ISessionsGitHubService } from '../../contrib/github/browser/githubService.js';
import { IFileTextModelService } from '../../../workbench/services/textmodelResolver/common/textModelResourceService.js';
import assert from "node:assert/strict";
import { test, suiteTeardown } from "mocha";
import { JSDOM } from "jsdom";
import type { ModelRef, QueueEnqueueParams, ServerNotification, Session as SessionDto, SessionCreateParams, Thread, ThreadTranscriptSnapshot } from "../../../../../.build/protocol/typescript/index.js";
import type { SessionMutationParams, SessionOperationInput, ThreadTranscriptEntry } from "../../../platform/agentHost/common/agentService.js";
import type { IRendererHost } from "../../../platform/renderer/common/rendererHost.js";
import type { IAction } from "../../../base/common/actions.js";
import { Emitter, Event } from "../../../base/common/event.js";
import { isCancellationError } from '../../../base/common/errors.js';
import { DeferredPromise } from '../../../base/common/async.js';
import { SessionsService } from '../../services/sessions/browser/sessionsService.js';
import { CustomViewService, ICustomViewService } from '../../services/customView/browser/customViewService.js';
import { DisposableStore, toDisposable } from '../../../base/common/lifecycle.js';
import { INotificationService } from '../../../platform/notification/common/notification.js';
import { Lxicon } from "../../../base/common/lxicons.js";
import { IMenuService, MenuId } from "../../../platform/actions/common/actions.js";
import { MenuService } from "../../../platform/actions/common/menuService.js";
import { IContextViewService } from "../../../platform/contextview/browser/contextView.js";
import { IContextMenuService } from "../../../platform/contextview/browser/contextView.js";
import { IAccessibleViewService } from '../../../platform/accessibility/browser/accessibleView.js';
import { NotificationService } from '../../../workbench/services/notification/common/notificationService.js';
import { InstantiationService } from "../../../platform/instantiation/common/instantiationService.js";
import { IQuickInputService } from "../../../platform/quickinput/common/quickInput.js";
import { CommandService } from "../../../workbench/services/commands/common/commandService.js";
import type { IPaneComposite } from '../../../workbench/common/panecomposite.js';
import { ViewContainerLocation, ViewsRegistry, WorkbenchViewRegistry } from "../../../workbench/common/views.js";
import { chatTranscriptListItems, chatListItem, chatTurnErrorListItem, type ChatTurnErrorAction } from "../../../workbench/contrib/chat/browser/widget/chatListItems.js";
import { ChatWidgetModel } from "../../browser/chatWidgetModel.js";
import { AGENT_SESSIONS_ORIENTATION_SETTING, AgentSessionsOrientation, CHAT_VIEW_CONTAINER_ID, CHAT_VIEW_ID, MOVE_CHAT_TO_EDITOR_COMMAND_ID, MOVE_CHAT_TO_NEW_WINDOW_COMMAND_ID, NEW_CHAT_COMMAND_ID, OPEN_CHAT_BROWSER_COMMAND_ID, OPEN_CHAT_SETTINGS_COMMAND_ID, SHOW_CHAT_HISTORY_COMMAND_ID, TOGGLE_AGENT_SESSIONS_SIDEBAR_COMMAND_ID } from "../../../workbench/contrib/chat/common/chat.js";
import { Menus } from '../../browser/menus.js';
import { IPreferencesService, type IPreferencesService as PreferencesService } from "../../../workbench/services/preferences/common/preferences.js";
import { PreferencesService as BrowserPreferencesService } from "../../../workbench/services/preferences/browser/preferencesService.js";
import { emptyEditorServiceState } from '../../../workbench/test/common/testEditorService.js';
import { IWorkbenchLayoutService, type WorkbenchPartId, type WorkbenchPartVisibilityChangeEvent } from "../../../workbench/services/layout/browser/layoutService.js";
import { ChatService } from "../../../workbench/services/chat/browser/chatService.js";
import { IChatService, type AdvisorConfig, type ModelProviderCredentialStatus, type ThreadTranscriptUpdateEnvelope, type ThreadUpdateEnvelope, type TurnError } from "../../../workbench/services/chat/common/chatService.js";
import { Extensions as ConfigurationExtensions, type IConfigurationRegistry } from '../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../platform/registry/common/platform.js';
import { ModelCatalogConfiguration } from "../../../workbench/contrib/chat/common/languageModelsConfiguration.js";
import { TestConfigurationService as WorkbenchConfigurationService } from '../../../workbench/services/configuration/test/common/testServices.js';
import { SessionsManagementService as BaseSessionsManagementService } from "../../services/sessions/browser/sessionsManagementService.js";
import { AppServerSessionsProvider } from "../../contrib/providers/agentHost/browser/appServerSessionsProvider.js";
import type { ISession } from "../../services/sessions/common/session.js";
import { ISessionsManagementService } from "../../services/sessions/common/sessionsManagement.js";
import { IViewsService } from "../../../workbench/services/views/common/viewsService.js";
import { ViewsService } from "../../../workbench/services/views/browser/viewsService.js";
import { ContextKeyService, IContextKeyService } from "../../../platform/contextkey/browser/contextKeyService.js";
import { DialogResult, IDialogService, type IMessageDialogOptions } from '../../../platform/dialogs/common/dialogs.js';
import { ViewDescriptorService } from "../../../workbench/services/views/browser/viewDescriptorService.js";
import { TestQuickInputService } from "../../../platform/quickinput/test/browser/testQuickInputService.js";
import { Dimension, h } from "../../../base/browser/dom.js";
import type { IFileService } from '../../../platform/files/common/files.js';
import { URI } from "../../../base/common/uri.js";
import { ICommandService } from "../../../platform/commands/common/commands.js";
import { IChatSessionNavigationService } from '../../../workbench/services/chat/common/chatSessionNavigationService.js';
import type { IOpenerService, OpenOptions } from "../../../platform/opener/common/opener.js";
import { IEditorService } from "../../../workbench/services/editor/common/editorService.js";
import { IStorageService } from '../../../platform/storage/common/storage.js';
import { UserDataProfileService } from '../../../workbench/services/userDataProfile/browser/userDataProfileService.js';
import { FileNotFoundError, FileRevisionConflictError } from '../../../platform/files/common/files.js';
import { TestConfigurationFiles } from '../../../workbench/services/configuration/test/common/testServices.js';
import { parseJsonDocument } from '../../../base/common/json.js';
import { productLanguagePackCatalogs } from '../../../workbench/services/localization/common/localizationCatalogs.js';
import { ChatTipService, IChatTipService } from '../../../workbench/contrib/chat/browser/chatTipService.js';
import { BrowserLifecycleService } from '../../../workbench/services/lifecycle/browser/lifecycleService.js';
import { ILifecycleService } from '../../../workbench/services/lifecycle/common/lifecycle.js';

const inputResources = new DisposableStore();
const userDataProfile = new UserDataProfileService();
suiteTeardown(() => inputResources.dispose());
function createInputServices(contextView: IContextViewService, chat: IChatService, menus?: IMenuService, contextMenus?: IContextMenuService): InstantiationService {
	const services = inputResources.add(createTestEditorServices(configurationServices.get(chat), createCodeEditorServices(inputResources)));
	services.registerInstance(IEditorService, { ...emptyEditorServiceState, openEditor: async () => { }, focusActiveEditor() { } });
	services.registerSingleton(IPromptsService, () => services.createInstance(PromptsService));
	services.registerInstance(IAppServerHookApi, { onDidChangeHooks: Event.None, list: async () => { throw new Error('Unexpected Hook read in Skill fixture'); } });
	services.registerInstance(IContextViewService, contextView);
	services.registerInstance(IMenuService, menus ?? new MenuService(inputResources.add(new CommandService(services)), services.get(IContextKeyService)));
	services.registerInstance(IContextMenuService, contextMenus ?? { showContextMenu: () => { } } as unknown as IContextMenuService);
	services.registerInstance(IDialogService, recordingDialogService([]));
	services.registerInstance(INotificationService, notifications);
	services.registerInstance(IChatSessionNavigationService, { openConversation: async () => { } } as unknown as IChatSessionNavigationService);
	services.registerSingleton(IActionWidgetService, () => services.createInstance(ActionWidgetService));
	services.registerInstance(ILanguageModelsService, modelsFor(chat));
	services.registerInstance(IAgentExecutionSettingsService, { onDidChange: Event.None, read: async () => ({ revision: 1, settings: { approvalMode: 'manual', commandFileAccess: 'directoryWrite', commandNetworkAccess: 'denied' } }), configure: async () => { } });
	services.registerInstance(IAppServerSkillApi, skillServices.get(chat)!);
	services.registerInstance(IAccessibleViewService, unavailableAccessibleViewService);
	services.registerInstance(IVoiceCodeTranscriptionBackendService, undefined);
	services.registerInstance(IAgentVoiceService, undefined);
	services.registerSingleton(ISpeechService, () => services.createInstance(SpeechService));
	services.registerSingleton(IChatSpeechToTextService, () => services.createInstance(ChatSpeechToTextService));
	registerTestDictationOnboarding(services);
	return services;
}
function createChatListWidget(container: HTMLElement, options: ConstructorParameters<typeof ChatListWidget>[1] = {}): InstanceType<typeof ChatListWidget> {
	const services = inputResources.add(createTestEditorServices(undefined, createCodeEditorServices(inputResources)));
	services.registerInstance(IAgentThreadService, createDisconnectedAgentThreadService(async operation => { throw new Error(operation); }));
	services.registerInstance(IChatResponseResourceFileSystemProvider, inputResources.add(services.createInstance(ChatResponseResourceFileSystemProvider)));
	services.registerInstance(IEditorService, { ...emptyEditorServiceState, openEditor: async () => { throw new Error('Unexpected media preview'); }, focusActiveEditor() { } });
	return services.createInstance(ChatListWidget, container, options);
}
const browserEnvironment = new JSDOM("<!doctype html><body></body>");
setARIAContainer(browserEnvironment.window.document.body);
const unavailableFileService = {
	readFile: async (resource: URI) => { throw new FileNotFoundError(resource); },
	readFileBytes: async () => { throw new Error('File read is unavailable in this test'); },
} as unknown as IFileService;
const unavailableAccessibleViewService = { getOpenAriaHint: () => undefined } as unknown as IAccessibleViewService;
const notifications = new NotificationService();

class SessionsManagementService extends BaseSessionsManagementService {
	constructor(api: IRendererHost) {
		const services = inputResources.add(new InstantiationService());
		services.registerSingleton(IPromptsService, () => services.createInstance(PromptsService));
		services.registerInstance(IAppServerHookApi, { onDidChangeHooks: Event.None, list: async () => { throw new Error('Unexpected Hook read in Skill fixture'); } });
		services.registerInstance(IRendererHostService, api);
		services.registerInstance(IAppServerApi, api.appServer);
		services.registerInstance(IAgentSessionService, api.session);
		services.registerInstance(IAgentModelsService, api.model);
		services.registerInstance(IAgentTurnService, api.turn);
		services.registerInstance(IServerEventApi, api.events);
		super(services.createInstance(AppServerSessionsProvider, { workspace: () => ({ type: 'current' }), selectWorkspace: async () => undefined }));
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
await import(
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
const { readNewChatDraftState, writeNewChatDraftState } = await import('../../contrib/chat/common/newChatDraftState.js');
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
	const editorService = {
		openEditor: async ({ resource }: { readonly resource: URI; }) => { editorResources.push(resource); },
	} as unknown as IEditorService;
	const openerService = {
		open: async (target: string, options: OpenOptions) => { externalTargets.push({ target, options }); },
	} as unknown as IOpenerService;

	await openChatMarkdownLink("vscode-remote://ssh-remote+host/src/file.ts", openerService, editorService);
	await openChatMarkdownLink('ash-remote://ssh+host/src/ash.ts', openerService, editorService);
	await openChatMarkdownLink("vscode-file://vscode-app/workspace/readme.md", openerService, editorService);
	await openChatMarkdownLink('vscode-remote-resource://ssh-remote+host/workspace/image.png', openerService, editorService);
	await openChatMarkdownLink('vscode-notebook-cell:///workspace/notebook.ipynb#cell-4', openerService, editorService);
	await openChatMarkdownLink('vscode-file://other-host/workspace/secret.md', openerService, editorService);
	await openChatMarkdownLink('vscode-remote-resource://127.0.0.1:9999/vscode-remote-resource?path=%2Fworkspace%2Fsecret.png', openerService, editorService);
	await openChatMarkdownLink("command:ash.open?%5B%22readme.md%22%5D", openerService, editorService);
	await openChatMarkdownLink("mailto:help@example.com", openerService, editorService);
	await openChatMarkdownLink('https://example.com/docs', openerService, editorService);
	await openChatMarkdownLink("private:///workbench/resource", openerService, editorService);
	await openChatMarkdownLink("#section", openerService, editorService);

	assert.deepEqual(editorResources.map(resource => resource.toString()), [
		'ash-remote://ssh+host/src/file.ts',
		'ash-remote://ssh+host/src/ash.ts',
		'file:///workspace/readme.md',
		'ash-remote://ssh+host/workspace/image.png',
		'vscode-notebook-cell:///workspace/notebook.ipynb#cell-4',
	]);
	assert.deepEqual(externalTargets.shift(), { target: "command:ash.open?%5B%22readme.md%22%5D", options: { allowCommands: true, fromUserGesture: true } });
	assert.deepEqual(externalTargets, ['mailto:help@example.com', 'https://example.com/docs'].map(target => ({ target, options: { openExternal: true, fromUserGesture: true, allowContributedOpeners: true } })));
});

test('Chat loads an Ash remote workspace image through the file service', async () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	dom.window.HTMLElement.prototype.scrollTo = () => { };
	const resource = 'ash-remote://ssh+host/workspace/pixel.png';
	const fake = fakeApi({ sessions: [session('session-1', 'thread-1')], thread: () => thread(`![pixel](${resource})`) });
	const requests: URI[] = [];
	const fileService = {
		readFile: async (resource: URI) => { throw new FileNotFoundError(resource); },
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
		services.registerSingleton(IPromptsService, () => services.createInstance(PromptsService));
		services.registerInstance(IAppServerHookApi, { onDidChangeHooks: Event.None, list: async () => { throw new Error('Unexpected Hook read in Skill fixture'); } });
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
			createInputServices(contextViewService, paneChat, menuService, contextMenuService), inputResources.add(new WorkbenchConfigurationService()), inputResources.add(createTestStorage()), userDataProfile, contextKeys,
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
	const registry = ViewsRegistry;

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

test("Chat title and history switching retain conversations and drafts", async () => {
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
	services.registerSingleton(IPromptsService, () => services.createInstance(PromptsService));
	services.registerInstance(IAppServerHookApi, { onDidChangeHooks: Event.None, list: async () => { throw new Error('Unexpected Hook read in Skill fixture'); } });
	using configuration = new WorkbenchConfigurationService();
	services.registerInstance(IConfigurationService, configuration);
	let preferencesEditorTarget: import('../../../workbench/services/editor/common/editorService.js').EditorOpenTarget | undefined;
	using chat = createChatService(api);
	using quickInput = new TestQuickInputService({ instantiationService: services, container: dom.window.document.body, contextKeyService: contextKeys });
	using keybindingFiles = new KeybindingTestServices();
	using editorServices = createTestEditorServices(undefined, keybindingFiles.services);
	editorServices.registerInstance(IDialogService, recordingDialogService([]));
	using preferences: PreferencesService = new BrowserPreferencesService({
		...emptyEditorServiceState,
		openEditor: async (_input, _options, target) => { preferencesEditorTarget = target; },
		focusActiveEditor() { },
	}, editorServices.get(IFileTextModelService), keybindingFiles.files, keybindingFiles.profiles, editorServices);
	services.registerInstance(IPreferencesService, preferences);
	services.registerInstance(IChatService, chat);
	services.registerInstance(ISessionsManagementService, sessions);
	services.registerInstance(ILanguageModelsService, modelsFor(chat));
	services.registerInstance(IAgentExecutionSettingsService, { onDidChange: Event.None, read: async () => ({ revision: 1, settings: { approvalMode: 'manual', commandFileAccess: 'directoryWrite', commandNetworkAccess: 'denied' } }), configure: async () => { } });
	services.registerInstance(IAppServerSkillApi, skillServices.get(chat)!);
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
		createInputServices(contextViewService, chat, menuService, contextMenuService), configuration, inputResources.add(createTestStorage()), userDataProfile, contextKeys,
	);
	chatView = pane;
	const title = h(dom.window.document, "div");
	title.className = "ash-pane-composite-title";
	title.append(chatTitleContent(pane), chatTitleActions(pane));
	dom.window.document.body.append(title, pane.element);

	await sessions.initialize();
	await nextTask();

	const titleButton = title.querySelector<HTMLButtonElement>(".ash-chat-view-title-button")!;
	const toolbar = title.querySelector(
		".ash-chat-title-actions > .ash-action-bar",
	);
	const layoutToolbar = title.querySelector<HTMLElement>(
		".ash-chat-title-layout-actions",
	);
	assert.equal(title.querySelector("[role=tablist]"), null);
	assert.equal(titleButton.textContent, "Session session-1");
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
	assert.equal(pane.element.querySelector<HTMLElement>('.ash-chat-sessions-sidebar')?.hidden, true);
	assert.equal(configuration.getValue(AGENT_SESSIONS_ORIENTATION_SETTING), AgentSessionsOrientation.SideBySide);
	assert.equal(pane.minimumWidth, 300);
	await configuration.updateValue(AGENT_SESSIONS_ORIENTATION_SETTING, AgentSessionsOrientation.Stacked);
	layoutToolbar?.querySelector<HTMLButtonElement>("button")?.focus();
	await commands.executeCommand(TOGGLE_AGENT_SESSIONS_SIDEBAR_COMMAND_ID);
	const sessionsSidebar = pane.element.querySelector<HTMLElement>('.ash-chat-sessions-sidebar');
	assert.equal(sessionsSidebar?.hidden, false);
	assert.equal(contextKeys.getValue('agentSessionsSidebarVisible'), true);
	assert.deepEqual([...sessionsSidebar?.querySelectorAll<HTMLButtonElement>('.ash-agent-session-row') ?? []].map(button => button.title), ['Session session-1', 'Session session-2']);
	assert.equal(sessionsSidebar?.contains(dom.window.document.activeElement), true);
	sessionsSidebar?.querySelectorAll<HTMLButtonElement>('.ash-agent-session-row')[1]?.click();
	assert.equal(sessions.active?.session.sessionId, 'session-2');
	assert.equal(sessionsSidebar?.hidden, true);
	assert.equal(pane.element.querySelector<HTMLElement>('.ash-chat-pane-host')?.hidden, false);
	assert.equal(pane.element.querySelector('.ash-chat:where(:not([hidden]))')?.contains(dom.window.document.activeElement), true);
	layoutToolbar?.querySelector<HTMLButtonElement>('button')?.focus();
	await commands.executeCommand(TOGGLE_AGENT_SESSIONS_SIDEBAR_COMMAND_ID);
	assert.equal(pane.element.querySelector<HTMLElement>('.ash-chat-pane-host')?.hidden, false);
	assert.equal(pane.element.querySelector('.ash-chat-body')?.classList.contains('sessions-stacked'), true);
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
	const activeTab = chatTitleContent(pane).querySelector<HTMLElement>('.ash-chat-view-title-label');
	const paneChanges = new dom.window.MutationObserver(() => { });
	paneChanges.observe(paneHost, { childList: true });
	sessions.setUntitledSessionAgent(draftId, { name: 'reviewer', description: 'Reviews changes', sourceId: 'directory-1' });
	assert.equal(paneChanges.takeRecords().flatMap(record => [...record.removedNodes]).length, 0);
	assert.equal(chatTitleContent(pane).querySelector<HTMLElement>('.ash-chat-view-title-label'), activeTab);
	paneChanges.disconnect();
	sessions.discardUntitledSession(draftId);
	sessions.selectThread('session-1', 'thread-1');
	assert.equal(sessionsSidebar?.hidden, true);
	layoutToolbar?.querySelector<HTMLButtonElement>('button')?.focus();
	await commands.executeCommand(TOGGLE_AGENT_SESSIONS_SIDEBAR_COMMAND_ID);
	pane.element.querySelector(".ash-chat-body")!.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
	assert.equal(sessionsSidebar?.hidden, true);
	assert.equal(contextKeys.getValue('agentSessionsSidebarVisible'), false);
	assert.equal(dom.window.document.activeElement, layoutToolbar?.querySelector("button"));
	assert.equal(layoutToolbar?.hidden, false);
	const chatActions = menuService.getMenuActions(MenuId.ChatTitle)
		.filter(([group]) => group === 'chatActions')
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
	assert.deepEqual(menuService.getMenuActions(MenuId.ChatTitle).find(([group]) => group === 'layout')?.[1].map(action => action.label), ['Sessions layout']);
	const layoutChoices = () => menuService.getMenuActions(Menus.ChatSessionsLayout).flatMap(([, actions]) => actions);
	assert.deepEqual(layoutChoices().map(action => [action.label, action.checked]), [['Side by side', false], ['Stacked', true]]);
	await commands.executeCommand('workbench.action.chat.setAgentSessionsOrientationStacked');
	assert.equal(configuration.getValue(AGENT_SESSIONS_ORIENTATION_SETTING), AgentSessionsOrientation.Stacked);
	assert.deepEqual(layoutChoices().map(action => action.checked), [false, true]);
	await assert.rejects(configuration.updateValue(AGENT_SESSIONS_ORIENTATION_SETTING, 'diagonal'), /Invalid Sessions layout/);
	const body = pane.element.querySelector<HTMLElement>('.ash-chat-body')!;
	body.getBoundingClientRect = () => new dom.window.DOMRect(0, 0, 600, 600);
	await configuration.updateValue(AGENT_SESSIONS_ORIENTATION_SETTING, AgentSessionsOrientation.SideBySide);
	await commands.executeCommand(TOGGLE_AGENT_SESSIONS_SIDEBAR_COMMAND_ID);
	assert.equal(body.classList.contains('sessions-stacked'), false);
	assert.equal(pane.element.querySelector<HTMLElement>('.ash-chat-sessions-sash')?.hidden, false);
	assert.equal(pane.minimumWidth, 520);
	sessionsSidebar?.querySelector<HTMLButtonElement>('.ash-agent-session-row')?.click();
	assert.equal(sessionsSidebar?.hidden, false);
	assert.equal(paneHost.hidden, false);
	await configuration.updateValue(AGENT_SESSIONS_ORIENTATION_SETTING, AgentSessionsOrientation.Stacked);
	assert.equal(body.classList.contains('sessions-stacked'), true);
	assert.equal(paneHost.hidden, false);
	assert.equal(pane.minimumWidth, 300);
	const activeInput = paneHost.querySelector<HTMLTextAreaElement>('.ash-chat:not([hidden]) .ash-chat-textarea-input')!;
	activeInput.value = 'Keep this draft while resizing';
	activeInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
	activeInput.focus();
	// Width and orientation changes must retain the same composer and keyboard focus.
	body.getBoundingClientRect = () => new dom.window.DOMRect(0, 0, 599, 600);
	await configuration.updateValue(AGENT_SESSIONS_ORIENTATION_SETTING, AgentSessionsOrientation.SideBySide);
	assert.equal(body.classList.contains('sessions-stacked'), false);
	assert.equal(sessionsSidebar?.hidden, false);
	assert.equal(pane.minimumWidth, 520);
	assert.equal(paneHost.hidden, false);
	assert.equal(dom.window.document.activeElement, activeInput);
	assert.equal(activeInput.value, 'Keep this draft while resizing');
	body.getBoundingClientRect = () => new dom.window.DOMRect(0, 0, 600, 600);
	await commands.executeCommand('workbench.action.chat.setAgentSessionsOrientationStacked');
	assert.equal(body.classList.contains('sessions-stacked'), true);
	await commands.executeCommand('workbench.action.chat.setAgentSessionsOrientationSideBySide');
	assert.equal(body.classList.contains('sessions-stacked'), false);
	assert.equal(activeInput.value, 'Keep this draft while resizing');
	const sash = pane.element.querySelector<HTMLElement>('.ash-chat-sessions-sash')!;
	sash.focus();
	body.getBoundingClientRect = () => new dom.window.DOMRect(0, 0, 599, 600);
	await configuration.updateValue(AGENT_SESSIONS_ORIENTATION_SETTING, AgentSessionsOrientation.SideBySide);
	assert.equal(sash.hidden, false);
	assert.equal(dom.window.document.activeElement, sash);
	await commands.executeCommand('workbench.action.chat.setAgentSessionsOrientationStacked');
	assert.equal(sash.hidden, true);
	assert.equal(sessionsSidebar?.contains(dom.window.document.activeElement), true);
	sessionsSidebar?.querySelector<HTMLButtonElement>('.ash-agent-session-row')?.click();
	assert.equal(sessionsSidebar?.hidden, true);
	assert.equal(paneHost.hidden, false);
	activeInput.value = '';
	activeInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
	await chatActions[3]?.run();
	const settingsInput = dom.window.document.querySelector<HTMLInputElement>(".ash-quick-pick-input input");
	assert.ok(settingsInput);
	settingsInput.dispatchEvent(new dom.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }));
	assert.equal(preferencesEditorTarget, "modalGroup");
	assert.equal(chatTitleContent(pane).querySelector('[role=tab]'), null);
	const panel = pane.element.querySelector('[role=region]');
	assert.equal(panel?.id, titleButton.getAttribute('aria-controls'));
	assert.equal(panel?.getAttribute('aria-labelledby'), titleButton.querySelector('span')?.id);
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
		assert.ok(chatPane.querySelector(".ash-chat-secondary-input-toolbar [data-action-id='ash.chat.input.attach']"));
		assert.deepEqual(
			[...inputToolbar?.querySelectorAll<HTMLElement>("[data-action-id]") ?? []].map((item) => item.dataset.actionId),
			[
				"ash.chat.input.mode",
				"ash.chat.input.model",
				"ash.chat.input.mic",
				"ash.chat.input.voice",
			],
		);
		assert.equal(inputToolbar?.querySelector<HTMLButtonElement>("[data-action-id='ash.chat.input.mode'] button")?.textContent, "Agent");
		assert.equal(inputToolbar?.querySelector<HTMLElement>(".ash-chat-input-model-action .ash-chat-input-picker-label")?.textContent, "GPT-6.1 Sol");
		assert.equal(inputToolbar?.querySelector<HTMLElement>(".ash-chat-input-configuration-action")?.getAttribute('aria-label'), 'Model options: Medium');
		assert.equal(inputToolbar?.querySelector(".ash-chat-input-model-access-badge"), null);
		assert.equal(inputToolbar?.querySelector<HTMLButtonElement>("[data-action-id='ash.chat.input.mic'] button")?.disabled, true);
		assert.equal(inputToolbar?.querySelector<HTMLButtonElement>("[data-action-id='ash.chat.input.voice'] button")?.disabled, true);
	}
	const firstChatPane = chatPanes[0]!;
	const modelButton = firstChatPane.querySelector<HTMLElement>(".ash-chat-input-model-action");
	modelButton?.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
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
	assert.equal(firstChatPane.querySelector<HTMLElement>(".ash-chat-input-model-action")?.getAttribute('aria-expanded'), 'false');
	firstChatPane.querySelector<HTMLElement>(".ash-chat-input-configuration-action")?.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
	const effortMenu = dom.window.document.querySelector<HTMLElement>('.ash-chat-model-configuration-menu');
	assert.equal(effortMenu?.querySelector('.ash-chat-model-configuration-heading')?.textContent, 'Thinking Level');
	assert.deepEqual([...effortMenu?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? []].map(button => button.textContent), ['Low', 'Medium', 'High']);
	assert.equal(effortMenu?.querySelector('[role="menuitemradio"][aria-checked="true"]')?.textContent, 'Medium');
	assert.equal(effortMenu?.querySelector('[role="menuitemradio"][aria-checked="true"]')?.getAttribute('aria-description'), null);
	effortMenu?.querySelector<HTMLButtonElement>("[data-action-id='ash.chat.input.effort.high'] button")?.click();
	await waitFor(() => firstChatPane.querySelector<HTMLElement>(".ash-chat-input-configuration-action")?.getAttribute('aria-label') === 'Model options: High');
	firstChatPane.querySelector<HTMLElement>(".ash-chat-input-configuration-action")?.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
	assert.equal(dom.window.document.querySelector('.ash-chat-model-configuration-menu [role="menuitemradio"][aria-checked="true"]')?.textContent, 'High');
	dom.window.document.querySelector<HTMLButtonElement>("[data-action-id='ash.chat.input.effort.medium'] button")?.click();
	await waitFor(() => firstChatPane.querySelector<HTMLElement>(".ash-chat-input-configuration-action")?.getAttribute('aria-label') === 'Model options: Medium');
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
	pane.addContext({ id: "first-context", kind: "file", name: "first.txt", resolve: async () => ({ name: "first.txt", content: "First context" }) });
	assert.equal(firstChatPane.querySelector<HTMLButtonElement>("[data-action-id='ash.chat.input.send'] button")?.disabled, false);
	assert.equal(firstChatPane.querySelector("[data-action-id='ash.chat.input.voice']"), null);

	await chooseConversation(pane, dom, 1);
	assert.equal(sessions.active?.session.sessionId, "session-2");
	assert.equal(sessions.active?.threadId, "thread-2");
	assert.equal(titleButton.textContent, "Session session-2");
	assert.deepEqual([...chatPanes].map((chatPane) => chatPane.hidden), [true, false]);
	typeChatText(dom.window, composerInputs[1], "Second draft");
	await chooseConversation(pane, dom, 0);
	assert.equal(sessions.active?.session.sessionId, "session-1");
	assert.deepEqual([...chatPanes].map((chatPane) => chatPane.hidden), [false, true]);
	assert.equal(composerInputs[0]?.value, "First draft first.txt ");
	assert.equal(composerInputs[1]?.value, "Second draft");
	assert.deepEqual((await pane.captureActiveDraft())?.draft.contexts?.map(context => context.name), ["first.txt"]);

	assert.equal(title.querySelector('.ash-tab-close-action'), null);
	assert.deepEqual(fake.stopRequests, []);
	const pendingDraft = sessions.createUntitledSession();
	const draftInput = pane.element.querySelector<HTMLTextAreaElement>('.ash-chat:not([hidden]) textarea')!;
	typeChatText(dom.window, draftInput, 'Unsent draft');
	pane.addContext({ id: 'unsent-context', kind: 'file', name: 'draft.txt', resolve: async () => ({ name: 'draft.txt', content: 'Draft context' }) });
	await chooseConversation(pane, dom, 1);
	assert.equal(sessions.active?.session.sessionId, 'session-1');
	await chooseConversation(pane, dom, 0);
	assert.equal(sessions.activeUntitledSession?.untitledSessionId, pendingDraft.untitledSessionId);
	assert.equal(draftInput.value, 'Unsent draft draft.txt ');
	assert.deepEqual((await pane.captureActiveDraft())?.draft.contexts?.map(context => context.name), ['draft.txt']);
	assert.equal(composerInputs[0]?.value, 'First draft first.txt ');
	assert.equal(composerInputs[1]?.value, 'Second draft');
	assert.deepEqual(fake.stopRequests, []);

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

test("Chat transcript retains message rows while reordering and revising Markdown", () => {
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
	assert.equal(firstElement.isConnected, true);
	assert.equal(list.element.querySelector('[data-item-id="first"]'), firstElement);
	assert.equal(firstElement.querySelector("p")?.textContent, "Revised answer");
	assert.ok(!firstElement.textContent?.includes("Original"));
	assert.equal(firstElement.querySelector("strong")?.textContent, "answer");
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

class SessionsInputForTest extends NewChatInputWidget {
	removeContextForTest(id: string): void {
		const reference = this.contexts.find(context => context.id === id)!.reference!;
		this.input.setSelection({ anchor: reference.start, active: reference.end });
		this.input.insertText('');
	}

	retireWhenInputChanges() {
		return this.onDidChangeInput(() => this.invalidatePendingInput());
	}
}

async function sessionsInputFixture(send: ChatInputDelegate['send'] = async () => { }, stored?: string) {
	const resources = new DisposableStore();
	try {
		const fake = fakeApi({ sessions: [] });
		const sessions = resources.add(new SessionsManagementService(fake.api));
		await sessions.initialize();
		const draft = sessions.createUntitledSession();
		const chat = resources.add(createChatService(fake.api));
		const model = resources.add(createWidgetModel(chat, { kind: 'untitled', session: draft }, sessions));
		await model.initialize();
		const contextView = resources.add(new BrowserContextViewService(document.body));
		const parentServices = resources.add(createInputServices(contextView, chat));
		const services = resources.add(parentServices.createChild());
		const storage = resources.add(createTestStorage());
		const notices = resources.add(new NotificationService());
		services.registerInstance(IStorageService, storage);
		services.registerInstance(INotificationService, notices);
		services.registerInstance(ILifecycleService, { onWillShutdown: Event.None } as unknown as ILifecycleService);
		services.registerSingleton(IChatTipService, () => services.createInstance(ChatTipService));
		services.registerInstance(ISessionsGitHubService, {
			onDidChange: Event.None, getSessionPullRequests: () => [], getSessionIssues: () => [], initialize() { },
			attachIssue: async () => { }, detachIssue: async () => { }, attachPullRequest: async () => { throw new Error('Unexpected PR attachment'); }, detachPullRequest: async () => { },
		});
		const identity = `untitled:${draft.untitledSessionId}`;
		if (stored !== undefined) storage.store(`sessions.inputDraft:${identity}`, stored, StorageScope.WORKSPACE, StorageTarget.MACHINE);
		const delegate: ChatInputDelegate = {
			send, executeCommand: async () => { }, executeServerCommand: async () => { }, interrupt: async () => { },
			selectModel: async () => { }, selectReasoningEffort: async () => { }, selectAutomaticModel: async () => { },
			listAgents: async () => [], selectAgent: () => { }, selectMode: mode => model.selectMode(mode),
			openModelSettings: async () => { }, resolveInteraction: async () => { },
		};
		const input = resources.add(services.createInstance(SessionsInputForTest, document.body, delegate, model));
		input.render(model.inputState);
		return { input, model, storage, notices, identity, [Symbol.dispose]() { resources.dispose(); } };
	} catch (error) { resources.dispose(); throw error; }
}

test('Sessions custom composer footer displays and clears the shared context budget', async () => {
	using fixture = await sessionsInputFixture();
	const state = fixture.model.inputState;
	fixture.input.render({
		...state, contextUsage: {
			estimatedTokens: 800, autoCompactAt: 800, contextWindow: 1000,
			categories: [{ category: 'conversation', tokens: 800 }],
		}
	});
	const ring = fixture.input.element.querySelector<HTMLButtonElement>('.ash-sessions-chat-input-footer .ash-chat-context-usage-button');
	assert.ok(ring);
	assert.equal(ring.hidden, false);
	assert.equal(ring.disabled, false);
	assert.equal(ring.getAttribute('aria-label'), 'Context budget: 100%, estimated input 800 of 800 tokens');
	assert.equal(fixture.input.element.querySelectorAll('.ash-chat-context-usage-button').length, 1);
	fixture.input.render(state);
	assert.equal(fixture.input.element.querySelector('.ash-chat-context-usage-button'), null);
});

test('Sessions composer forwards its original submission lifetime to the owning widget', async () => {
	let submittedSignal: AbortSignal | undefined;
	using fixture = await sessionsInputFixture(async (_text, _mode, _skills, _contexts, signal) => { submittedSignal = signal; });
	await fixture.input.acceptInput('Use this composer');
	assert.ok(submittedSignal);
	assert.equal(submittedSignal.aborted, false);
	fixture.input.invalidatePendingInput();
	assert.equal(submittedSignal.aborted, true);
});

test('Sessions composer does not submit when clearing the old input synchronously retires its owner', async () => {
	let sends = 0;
	using fixture = await sessionsInputFixture(async () => { sends++; });
	fixture.input.appendToDraft('The old conversation');
	using transition = fixture.input.retireWhenInputChanges();
	await fixture.input.acceptInput();
	assert.equal(sends, 0);
	assert.equal(fixture.input.element.querySelector<HTMLHeadingElement>('.ash-sessions-chat-welcome-heading')!.hidden, false);
});

test('an old Sessions submission failure cannot hide the new submission or replace its unsent text', async () => {
	const oldResult = new DeferredPromise<void>();
	const newResult = new DeferredPromise<void>();
	let sends = 0;
	using fixture = await sessionsInputFixture(async () => (++sends === 1 ? oldResult.p : newResult.p));
	const oldSending = fixture.input.acceptInput('Old request');
	await waitFor(() => sends === 1);
	fixture.input.invalidatePendingInput();
	const newSending = fixture.input.acceptInput('New request');
	await waitFor(() => sends === 2);
	fixture.input.appendToDraft('Keep the new unsent text');
	const heading = fixture.input.element.querySelector<HTMLHeadingElement>('.ash-sessions-chat-welcome-heading')!;
	assert.equal(heading.hidden, true);
	const oldFailure = assert.rejects(oldSending, /Old request failed/u);
	await oldResult.error(new Error('Old request failed'));
	await oldFailure;
	assert.equal(heading.hidden, true);
	assert.equal((await fixture.input.captureDraft())?.draft.text, 'Keep the new unsent text');
	await newResult.complete();
	await newSending;
	assert.equal((await fixture.input.captureDraft())?.draft.text, 'Keep the new unsent text');
});

test('Sessions composer retains corrupt storage through visibility changes until the user edits', async () => {
	const raw = '{unfinished';
	using fixture = await sessionsInputFixture(undefined, raw);
	const { input, storage, notices, identity } = fixture;
	input.setVisible(true);
	input.setVisible(false);
	input.setVisible(true);
	assert.equal(storage.get(`sessions.inputDraft:${identity}`, StorageScope.WORKSPACE), raw);
	assert.equal(notices.getNotifications().length, 1);
	assert.match(notices.getNotifications()[0]!.message, /Could not restore the Chat draft/u);
	input.appendToDraft('A new draft');
	assert.deepEqual(readNewChatDraftState(storage, identity), { mode: 'agent', text: 'A new draft', contexts: [] });
});

test('Chinese Sessions draft recovery and accessibility help use the product language catalog', async () => {
	initializeTestLocalization('zh-CN');
	try {
		using fixture = await sessionsInputFixture(undefined, '{unfinished');
		assert.match(fixture.notices.getNotifications()[0]!.message, /^无法恢复聊天草稿：/u);
		fixture.input.focus();
		const help = new SessionsChatAccessibilityHelp(fixture.input.element, () => fixture.input.focus()).getProvider();
		assert.ok(help);
		const content = help.provideContent();
		assert.match(content, /已完成的附件仍保留在草稿中/u);
		assert.match(content, /暂不支持远程项目/u);
		const chinese = productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
		assert.match(chinese.bundles.ash['chat.sessions.help'], /新聊天和已有对话的输入区都保持可见/u);
		assert.match(chinese.bundles.ash['chat.sessions.help'], /外层分隔线会停在可容纳两栏的最小宽度/u);
		assert.match(chinese.bundles.ash['chat.sessions.layout.description'], /调整聊天区域大小时不会切换/u);
	} finally { resetNlsResolver(); }
});

test('a removed Sessions attachment cannot report a stale draft persistence error', async () => {
	using fixture = await sessionsInputFixture();
	fixture.input.appendToDraft('Keep this task');
	const source = new DeferredPromise<{ name: string; content: string; }>();
	fixture.input.addContext({ id: 'delayed', kind: 'file', name: 'delayed.txt', resolve: () => source.p });
	const capture = fixture.input.captureDraft();
	fixture.input.removeContextForTest('delayed');
	const rejected = assert.rejects(capture, /Source unavailable/u);
	await source.error(new Error('Source unavailable'));
	await rejected;
	assert.deepEqual(fixture.notices.getNotifications(), []);
	assert.deepEqual(readNewChatDraftState(fixture.storage, fixture.identity), { mode: 'agent', text: 'Keep this task  ', contexts: [] });
});

test('Sessions composer waits for file paste before sending and clears only the completed request', async () => {
	using globals = installEditorTestGlobals({ FileReader: browserEnvironment.window.FileReader });
	const sent: string[] = [];
	using fixture = await sessionsInputFixture(async (text, _mode, _skills, contexts) => {
		assert.equal(text, 'source.txt ');
		for (const context of contexts ?? []) sent.push((await context.resolve()).content);
	});
	const paste = new browserEnvironment.window.Event('paste', { bubbles: true, cancelable: true });
	Object.defineProperty(paste, 'clipboardData', { value: { files: [new browserEnvironment.window.File(['selected contents'], 'source.txt', { type: 'text/plain' })] } });
	fixture.input.element.querySelector('.ash-chat-input-container')!.dispatchEvent(paste);
	const sending = fixture.input.acceptInput();
	assert.equal(paste.defaultPrevented, true);
	assert.deepEqual(sent, []);
	await sending;
	assert.deepEqual(sent, ['selected contents']);
	assert.equal(await fixture.input.captureDraft(), undefined);
	assert.equal(readNewChatDraftState(fixture.storage, fixture.identity), undefined);
});

test('Sessions composer cancellation keeps the text and prevents a late file from entering the reopened draft', async () => {
	using globals = installEditorTestGlobals({ FileReader: browserEnvironment.window.FileReader });
	let sends = 0;
	using fixture = await sessionsInputFixture(async () => { sends++; });
	fixture.input.appendToDraft('Keep this task');
	const reading = fixture.input.attachFiles([new browserEnvironment.window.File(['late contents'], 'source.txt')]);
	const sending = assert.rejects(fixture.input.acceptInput(), isCancellationError);
	fixture.input.setVisible(false);
	await Promise.all([reading, sending]);
	fixture.input.setVisible(true);
	assert.equal(sends, 0);
	assert.deepEqual((await fixture.input.captureDraft())?.draft, { mode: 'agent', text: 'Keep this task', contexts: [] });
	assert.deepEqual(fixture.notices.getNotifications(), []);
});

test('sending from one session preserves a later draft during first-session creation', async () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	using domLifetime = toDisposable(() => dom.window.close());
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using editorResources = new DisposableStore();
	const composerStorage = editorResources.add(createTestStorage());
	const editorServices = editorResources.add(createTestEditorServices(undefined, createCodeEditorServices(editorResources), dom.window.document, composerStorage));
	editorServices.registerInstance(IEditorService, { ...emptyEditorServiceState, openEditor: async () => { assert.fail('Unexpected editor navigation'); }, focusActiveEditor: () => { } });
	editorServices.registerInstance(ISessionsGitHubService, {
		onDidChange: Event.None,
		getSessionPullRequests: () => [], getSessionIssues: () => [], attachIssue: async () => { }, detachIssue: async () => { },
		initialize() { },
		attachPullRequest: async () => { throw new Error('Unexpected PR attachment'); },
		detachPullRequest: async () => { throw new Error('Unexpected PR removal'); },
	});
	editorServices.registerInstance(IVoiceCodeTranscriptionBackendService, undefined);
	editorServices.registerInstance(IAgentVoiceService, undefined);
	editorServices.registerSingleton(ISpeechService, () => editorServices.createInstance(SpeechService));
	editorServices.registerSingleton(IChatSpeechToTextService, () => editorServices.createInstance(ChatSpeechToTextService));
	using contextViewService = new BrowserContextViewService(dom.window.document.body);
	editorServices.registerInstance(IAccessibleViewService, unavailableAccessibleViewService);
	editorServices.registerInstance(INotificationService, notifications);
	editorServices.registerInstance(IChatSessionNavigationService, { openConversation: async () => { } } as unknown as IChatSessionNavigationService);
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
	using customViews = editorServices.createInstance(CustomViewService);
	editorServices.registerInstance(ICustomViewService, customViews);
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
	editorServices.registerInstance(IAgentExecutionSettingsService, { onDidChange: Event.None, read: async () => ({ revision: 1, settings: { approvalMode: 'manual', commandFileAccess: 'directoryWrite', commandNetworkAccess: 'denied' } }), configure: async () => { } });
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
		recordingDialogService([]),
		editorServices.get(IQuickInputService),
	);
	widget.setVisible(true);
	const input = widget.element.querySelector<HTMLElement>('.ash-chat-input-part');
	const heading = widget.element.querySelector<HTMLHeadingElement>('.ash-sessions-chat-welcome-heading');
	assert.equal(heading?.hidden, false);
	assert.equal(input?.classList.contains('chat-composer'), true);
	const welcomeTip = input?.querySelector('.ash-chat-input-tip');
	assert.ok(welcomeTip);
	assert.deepEqual([input?.getAttribute('aria-busy'), input?.querySelector('.ash-chat-status, .ash-chat-status-summary')?.textContent], ['true', '']);
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
		unavailableAccessibleViewService, notifications, undefined, undefined, undefined, (container, delegate) => editorServices.createInstance(NewChatInputWidget, container, delegate, chatModel), editorServices, recordingDialogService([]), editorServices.get(IQuickInputService));
	chatWidget.setVisible(true);
	const chatDraft = { mode: 'agent' as const, text: 'Keep my Chat draft', contexts: [{ id: 'chat-file', kind: 'file', name: 'chat.txt', content: 'Chat context', resource: 'file:///workspace/chat.txt' }] };
	chatWidget.restoreDraft(chatDraft);
	const restoredChatDraft = { ...chatDraft, text: 'Keep my Chat draft chat.txt ', contexts: chatDraft.contexts.map(context => ({ ...context, reference: { start: 19, end: 27 } })) };
	await attachment.complete({ name: 'code.ts', content: 'Code context' });
	await sending;
	assert.equal(heading?.hidden, true);
	assert.equal(input?.classList.contains('has-conversation'), true);
	assert.equal(widget.element.querySelector('.ash-chat-input-part'), input);
	assert.equal(widget.sessionId, 'session-1');
	assert.deepEqual((await chatWidget.captureDraft())?.draft, restoredChatDraft);
	assert.deepEqual(readNewChatDraftState(composerStorage, `untitled:${chatSelection.session.untitledSessionId}`), restoredChatDraft);
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
	services.registerSingleton(IPromptsService, () => services.createInstance(PromptsService));
	services.registerInstance(IAppServerHookApi, { onDidChangeHooks: Event.None, list: async () => { throw new Error('Unexpected Hook read in Skill fixture'); } });
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
		createInputServices(contextViewService, paneChat, menuService, contextMenuService),
		inputResources.add(new WorkbenchConfigurationService()),
		inputResources.add(createTestStorage()),
		userDataProfile,
	);
	dom.window.document.body.append(pane.element);

	await sessions.initialize();
	await nextTask();

	const titleLabel = chatTitleContent(pane).querySelector<HTMLElement>('.ash-chat-view-title-label')!;
	assert.equal(titleLabel.textContent, 'New Chat');
	assert.equal(chatTitleContent(pane).querySelector('[role=tab]'), null);
	assert.equal(pane.element.querySelector<HTMLElement>(".ash-chat-view-empty")?.hidden, true);
	assert.equal(fake.createSessionRequests.length, 0);
	assert.equal(fake.createThreadRequests.length, 0);
	assert.equal(sessions.sessions.length, 0);
	assert.equal(sessions.untitledSessions.length, 1);
	const untitledPane = pane.element.querySelector<HTMLElement>("[role='region']");
	assert.ok(untitledPane?.dataset.untitledSessionId);
	const input = untitledPane.querySelector<HTMLTextAreaElement>(".ash-chat-textarea-input");
	assert.ok(input);
	assert.equal(untitledPane.classList.contains("empty"), true);
	let contextResolutions = 0;
	pane.toggleSessionsSidebar();
	assert.equal(pane.element.querySelector('.ash-chat-body')?.classList.contains('sessions-stacked'), false);
	pane.addContext({
		id: "commit-1",
		kind: "scmHistoryItem",
		name: "abc1234 · Explain context transport",
		resolve: async () => {
			contextResolutions += 1;
			return { name: "Git commit abc1234", content: "diff --git a/file b/file" };
		},
	});
	assert.equal(input.value, "abc1234 · Explain context transport ");
	assert.equal(untitledPane.querySelector(".ash-chat-input-attachments"), null);
	typeChatText(dom.window, input, "abc1234 · Explain context transport Hello from an untitled session");
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
	assert.equal(pane.element.querySelector<HTMLElement>('.ash-chat-sessions-sidebar')?.hidden, false);
	assert.equal(pane.element.querySelector<HTMLElement>('.ash-chat-pane-host')?.hidden, false);

	assert.equal(fake.createSessionRequests.length, 1);
	assert.deepEqual(fake.createSessionRequests[0]?.agent, { type: 'default' });
	assert.equal(fake.createThreadRequests.length, 0);
	assert.equal(fake.turnStartRequests.length, 1);
	assert.equal(fake.turnStartRequests[0]?.mode, 'agent');
	assert.equal(contextResolutions, 1);
	assert.deepEqual(fake.turnStartRequests[0]?.input, [
		{ type: "context", name: "Git commit abc1234", content: "diff --git a/file b/file" },
		{ type: "text", text: "abc1234 · Explain context transport Hello from an untitled session" },
	]);
	assert.equal(untitledPane.querySelector(".ash-chat-input-attachment-item"), null);
	assert.equal(sessions.untitledSessions.length, 0);
	assert.equal(sessions.active?.session.sessionId, "session-1");
	assert.equal(sessions.active?.threadId, "thread-1");

	assert.equal(
		pane.element.querySelector<HTMLElement>("[role='region']")?.dataset.sessionId,
		"session-1",
	);
	assert.equal(
		pane.element.querySelector("[role='region']")?.getAttribute(
			"aria-labelledby",
		),
		titleLabel.id,
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
	services.registerInstance(IConfigurationService, inputResources.add(new WorkbenchConfigurationService()));
	services.registerSingleton(IPromptsService, () => services.createInstance(PromptsService));
	services.registerInstance(IAppServerHookApi, { onDidChangeHooks: Event.None, list: async () => { throw new Error('Unexpected Hook read in Skill fixture'); } });
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
		createInputServices(contextViewService, paneChat, menuService, contextMenuService),
		inputResources.add(new WorkbenchConfigurationService()),
		inputResources.add(createTestStorage()),
		userDataProfile,
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
	await waitFor(() => sessions.untitledSessions.length === 1);
	assert.equal(chatTitleContent(pane).querySelector('.ash-chat-view-title-label')?.textContent, 'New Chat');
	assert.equal(pane.element.querySelectorAll('.ash-chat').length, 2);
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
	services.registerSingleton(IPromptsService, () => services.createInstance(PromptsService));
	services.registerInstance(IAppServerHookApi, { onDidChangeHooks: Event.None, list: async () => { throw new Error('Unexpected Hook read in Skill fixture'); } });
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
		createInputServices(contextViewService, paneChat, menuService, contextMenuService),
		inputResources.add(new WorkbenchConfigurationService()),
		inputResources.add(createTestStorage()),
		userDataProfile,
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
	typeChatText(dom.window, input, "failed commit Keep this draft");
	input.dispatchEvent(new dom.window.KeyboardEvent("keydown", {
		bubbles: true,
		cancelable: true,
		key: "Enter",
	}));
	await waitFor(() => input.value === "failed commit Keep this draft");

	assert.equal(fake.createSessionRequests.length, 1);
	assert.equal(sessions.sessions.length, 0);
	assert.equal(sessions.untitledSessions.length, 1);
	assert.equal(pane.element.querySelector(".ash-chat-input-attachments"), null);
	assert.equal(input.value, "failed commit Keep this draft");
	assert.equal(pane.element.querySelector<HTMLElement>("[role='region']")?.dataset.untitledSessionId, sessions.untitledSessions[0]?.untitledSessionId);
	assert.equal(pane.element.querySelector<HTMLElement>("[role='region']")?.classList.contains("empty"), true);
	assert.equal(pane.element.querySelector<HTMLElement>("[role='region']")?.classList.contains("has-conversation"), false);
	assert.match(pane.element.querySelector<HTMLElement>(".ash-chat-status, .ash-chat-status-summary")?.textContent ?? "", /Cannot create Session/);

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
		createInputServices(contextViewService, paneChat, menuService, contextMenuService),
		inputResources.add(new WorkbenchConfigurationService()),
		inputResources.add(createTestStorage()),
		userDataProfile,
	);
	dom.window.document.body.append(pane.element);

	await sessions.initialize();
	await nextTask();

	assert.equal(chatTitleContent(pane).querySelectorAll(".ash-chat-view-title-label").length, 1);
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
	assert.equal(chatTitleContent(pane).querySelectorAll(".ash-chat-view-title-label").length, 1);
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
	services.registerInstance(IConfigurationService, inputResources.add(new WorkbenchConfigurationService()));
	services.registerSingleton(IPromptsService, () => services.createInstance(PromptsService));
	services.registerInstance(IAppServerHookApi, { onDidChangeHooks: Event.None, list: async () => { throw new Error('Unexpected Hook read in Skill fixture'); } });
	using sessions = new SessionsManagementService(api);
	using contextKeys = new ContextKeyService();
	using quickInput = new TestQuickInputService({
		instantiationService: services,
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

	const picking = commands.executeCommand(SHOW_CHAT_HISTORY_COMMAND_ID);
	await nextTask();
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

	await picking;
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
	const registry = ViewsRegistry;
	using contextKeys = new ContextKeyService();
	using descriptors = new ViewDescriptorService({
		registry,
	}, contextKeys);
	let focused = 0;
	let opened = 0;
	const view = {
		element: h(testStorageEnvironment.window.document, "div"),
		id: CHAT_VIEW_ID,
		paneTitle: 'Chat',
		focus: () => { focused++; view.element.focus(); },
		hasFocus: () => view.element.contains(view.element.ownerDocument.activeElement),
		isBodyVisible: () => true,
		setExpanded: () => false,
		isVisible: () => true,
		setVisible: () => undefined,
	};
	view.element.tabIndex = 0;
	testStorageEnvironment.window.document.body.append(view.element);
	using removeView = toDisposable(() => view.element.remove());
	const composite: IPaneComposite = {
		id: CHAT_VIEW_CONTAINER_ID,
		title: 'Chat',
		panes: [],
		onDidFocus: Event.None,
		onDidBlur: Event.None,
		onDidChangeViewVisibility: Event.None,
		onDidAddViews: Event.None,
		onDidRemoveViews: Event.None,
		onDidFocusView: Event.None,
		onDidBlurView: Event.None,
		getId: () => CHAT_VIEW_CONTAINER_ID,
		getTitle: () => 'Chat',
		getControl: () => composite,
		focus: () => view.focus(),
		hasFocus: () => view.hasFocus(),
		isVisible: () => true,
		setVisible: () => undefined,
		getView: (viewId: string) => viewId === CHAT_VIEW_ID ? view : undefined,
		openView: (viewId: string, focus = false) => {
			assert.equal(viewId, CHAT_VIEW_ID);
			if (focus) view.focus();
			opened++;
			return view;
		},
	};
	const { IPaneCompositePartService } = await import('../../../workbench/services/panecomposite/browser/panecomposite.js');
	const { IViewDescriptorService } = await import('../../../workbench/common/views.js');
	using services = new InstantiationService();
	services.registerSingleton(IPromptsService, () => services.createInstance(PromptsService));
	services.registerInstance(IAppServerHookApi, { onDidChangeHooks: Event.None, list: async () => { throw new Error('Unexpected Hook read in Skill fixture'); } });
	services.registerInstance(IViewDescriptorService, descriptors);
	services.registerInstance(IContextKeyService, contextKeys);
	services.registerInstance(IConfigurationService, inputResources.add(new WorkbenchConfigurationService()));
	using enablement = WorkbenchContributionsRegistry.createHost(services, error => { throw error; }, ['workbench.contrib.chatEnablement']);
	enablement.advance(WorkbenchPhase.BlockStartup);
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

test("SessionsManagementService writes the default without replacing existing Session models", async () => {
	const firstModel = { provider: 'openai', model: 'first' };
	const secondModel = { provider: 'openai', model: 'second' };
	const fake = fakeApi({
		sessions: [
			{ ...session("session-1", "thread-1"), model: firstModel },
			{ ...session("session-2", "thread-2"), model: secondModel },
		],
	});
	using service = new SessionsManagementService(fake.api);
	await service.initialize();
	const model: ModelRef = { provider: "openai", model: "gpt-session" };

	await service.setModel(model);

	assert.deepEqual(service.sessions.map(value => value.model), [firstModel, secondModel]);
	assert.deepEqual(service.active?.session.model, firstModel);
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
		hookRuns: [],
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
const configurationServices = new WeakMap<IChatService, WorkbenchConfigurationService>();
const skillServices = new WeakMap<IChatService, IAppServerSkillApi>();
function modelsFor(chat: IChatService): ILanguageModelsService {
	return modelServices.get(chat)!;
}
function createWidgetModel(chat: IChatService, selection: import('../../browser/chatWidgetModel.js').ChatWidgetSelection, sessions: ISessionsManagementService, execution?: IAgentExecutionSettingsService, configuration?: WorkbenchConfigurationService): ChatWidgetModel {
	const services = inputResources.add(new InstantiationService());
	services.registerSingleton(IPromptsService, () => services.createInstance(PromptsService));
	services.registerInstance(IAppServerHookApi, { onDidChangeHooks: Event.None, list: async () => { throw new Error('Unexpected Hook read in Skill fixture'); } });
	services.registerInstance(ILanguageModelsService, modelsFor(chat));
	services.registerInstance(IAgentExecutionSettingsService, execution ?? { onDidChange: Event.None, read: async () => ({ revision: 1, settings: { approvalMode: 'manual', commandFileAccess: 'directoryWrite', commandNetworkAccess: 'denied' } }), configure: async () => { } });
	services.registerInstance(IAppServerSkillApi, skillServices.get(chat)!);
	services.registerInstance(IConfigurationService, configuration ?? configurationServices.get(chat) ?? inputResources.add(new WorkbenchConfigurationService()));
	return services.createInstance(ChatWidgetModel, chat, selection, sessions);
}
function createChatService(api: IRendererHost, configurationService?: WorkbenchConfigurationService, storageService?: InstanceType<typeof BrowserStorageService>): ChatService {
	const storage = storageService ?? createTestStorage();
	if (!storageService) testStorages.push(storage);
	const services = inputResources.add(new InstantiationService());
	services.registerSingleton(IPromptsService, () => services.createInstance(PromptsService));
	services.registerInstance(IAppServerHookApi, { onDidChangeHooks: Event.None, list: async () => { throw new Error('Unexpected Hook read in Skill fixture'); } });
	registerChatBackend(services, api, IConfigurationService);
	services.registerInstance(IAccountService, inputResources.add(new AppServerAccountService(api.accounts, api.events)));
	const configuration = configurationService ?? inputResources.add(new WorkbenchConfigurationService());
	services.registerInstance(IConfigurationService, configuration);
	services.registerInstance(IStorageService, storage);
	services.registerInstance(ILanguageModelsConfigurationService, inputResources.add(services.createInstance(LanguageModelsConfigurationService, ChatModelPreferences)));
	const chat = services.createInstance(ChatService);
	configurationServices.set(chat, configuration);
	modelServices.set(chat, inputResources.add(services.createInstance(LanguageModelsService)));
	skillServices.set(chat, api.skills);
	return chat;
}

function registerChatBackend(services: InstantiationService, api: IRendererHost, omitted?: unknown, configuration?: WorkbenchConfigurationService): void {
	if (omitted !== IConfigurationService) { services.registerInstance(IConfigurationService, configuration ?? inputResources.add(new WorkbenchConfigurationService())); }
	if (omitted !== IAgentModelsService) { services.registerInstance(IAgentModelsService, api.model); }
	services.registerInstance(IRendererHostService, api);
	if (omitted !== IAppServerApi) { services.registerInstance(IAppServerApi, api.appServer); }
	if (omitted !== IAgentThreadService) { services.registerInstance(IAgentThreadService, api.thread); }
	if (omitted !== IAgentTurnService) { services.registerInstance(IAgentTurnService, api.turn); }
	if (omitted !== ITurnChangesApi) { services.registerInstance(ITurnChangesApi, api.turnChanges); }
	if (omitted !== IAppServerSkillApi) { services.registerInstance(IAppServerSkillApi, api.skills); }
	if (omitted !== IServerEventApi) { services.registerInstance(IServerEventApi, api.events); }
	if (omitted !== IAgentExecutionSettingsService) { services.registerInstance(IAgentExecutionSettingsService, { onDidChange: Event.None, read: async () => ({ revision: 1, settings: { approvalMode: 'manual', commandFileAccess: 'directoryWrite', commandNetworkAccess: 'denied' } }), configure: async () => { } }); }
}

for (const dependency of [IAgentModelsService, IAgentThreadService, IAgentTurnService, ITurnChangesApi, IAppServerApi, IServerEventApi, IAgentExecutionSettingsService, IConfigurationService]) {
	test(`Chat rejects missing ${dependency.description} before allocating listeners`, () => {
		using services = new InstantiationService();
		services.registerSingleton(IPromptsService, () => services.createInstance(PromptsService));
		services.registerInstance(IAppServerHookApi, { onDidChangeHooks: Event.None, list: async () => { throw new Error('Unexpected Hook read in Skill fixture'); } });
		registerChatBackend(services, fakeApi().api, dependency);
		assert.throws(() => services.createInstance(ChatService), { message: `Unknown service: ${dependency.description}` });
	});
}

test('a late subscription and release from the old connection cannot replace or release a restored Thread', async () => {
	const fake = fakeApi();
	using connection = new Emitter<AppServerConnectionState>();
	let generation = 1;
	const pending = new DeferredPromise<Awaited<ReturnType<typeof fake.api.thread.subscribe>>>();
	let subscribing = 0;
	const released: string[] = [];
	using chat = createChatService({
		...fake.api,
		appServer: { ...fake.api.appServer, get connectionGeneration() { return generation; }, onConnectionState: listener => connection.event(listener) },
		thread: {
			...fake.api.thread,
			subscribe: params => ++subscribing === 1 ? pending.p : fake.api.thread.subscribe(params),
			unsubscribe: async ({ threadId }) => { released.push(threadId); },
		},
	});
	const owner = {};
	const old = chat.subscribeThread('session-1', 'thread-1', 0, owner);
	const rejected = assert.rejects(old, isCancellationError);
	const closing = chat.unsubscribeThread('session-1', 'thread-1', owner);
	connection.fire('crashed');
	generation++;
	connection.fire('ready');
	await chat.subscribeThread('session-1', 'thread-1', 0, owner);
	await pending.complete(await fake.api.thread.subscribe({ sessionId: 'session-1', threadId: 'thread-1', afterSequence: 0 }));
	await rejected;
	await closing;
	assert.deepEqual(released, []);
	await chat.unsubscribeThread('session-1', 'thread-1', owner);
	assert.deepEqual(released, ['thread-1']);
});

test('disposing Chat releases each shared Thread subscription once', async () => {
	const fake = fakeApi();
	const released: string[] = [];
	const chat = createChatService({ ...fake.api, thread: { ...fake.api.thread, unsubscribe: async ({ threadId }) => { released.push(threadId); } } });
	try {
		await chat.subscribeThread('session-1', 'thread-1', 0, {});
		await chat.subscribeThread('session-1', 'thread-1', 0, {});
		await chat.subscribeThread('session-1', 'thread-2', 0, {});
	} finally { chat.dispose(); }
	await waitFor(() => released.length === 2);
	assert.deepEqual(released.sort(), ['thread-1', 'thread-2']);
});

for (const reconnect of [false, true]) {
	test(`disposing Chat during subscription only releases its own connection (reconnect: ${reconnect})`, async () => {
		const fake = fakeApi();
		const pending = new DeferredPromise<Awaited<ReturnType<typeof fake.api.thread.subscribe>>>();
		const released: string[] = [];
		const chat = createChatService({ ...fake.api, thread: { ...fake.api.thread, subscribe: () => pending.p, unsubscribe: async ({ threadId }) => { released.push(threadId); } } });
		const subscribing = chat.subscribeThread('session-1', 'thread-1', 0, {});
		const rejected = assert.rejects(subscribing, isCancellationError);
		chat.dispose();
		if (reconnect) fake.emitReady();
		await pending.complete(await fake.api.thread.subscribe({ sessionId: 'session-1', threadId: 'thread-1', afterSequence: 0 }));
		await rejected;
		await Promise.resolve();
		if (!reconnect) await waitFor(() => released.length === 1);
		assert.deepEqual(released, reconnect ? [] : ['thread-1']);
	});
}

test('release skips a stopped connection even when its old listener has been disposed', async () => {
	const fake = fakeApi();
	const released: string[] = [];
	let state: AppServerConnectionState = 'ready';
	using chat = createChatService({
		...fake.api,
		appServer: { ...fake.api.appServer, getConnectionState: async () => state },
		thread: { ...fake.api.thread, unsubscribe: async ({ threadId }) => { released.push(threadId); } },
	});
	const owner = {};
	await chat.subscribeThread('session-1', 'thread-1', 0, owner);
	state = 'stopped';
	await chat.unsubscribeThread('session-1', 'thread-1', owner);
	assert.deepEqual(released, []);
});

for (const disconnect of [false, true]) {
	test(`release preserves active failures but accepts connection closure during cleanup (disconnect: ${disconnect})`, async () => {
		const fake = fakeApi();
		let state: AppServerConnectionState = 'ready';
		using chat = createChatService({
			...fake.api,
			appServer: { ...fake.api.appServer, getConnectionState: async () => state },
			thread: { ...fake.api.thread, unsubscribe: async () => { if (disconnect) state = 'stopped'; throw new Error('release failed'); } },
		});
		const owner = {};
		await chat.subscribeThread('session-1', 'thread-1', 0, owner);
		const closing = chat.unsubscribeThread('session-1', 'thread-1', owner);
		if (disconnect) await closing;
		else await assert.rejects(closing, /release failed/);
	});
}

test('release retains an owner acquired while checking connection readiness', async () => {
	const fake = fakeApi();
	const checking = new DeferredPromise<AppServerConnectionState>();
	const started = new DeferredPromise<void>();
	const released: string[] = [];
	using chat = createChatService({
		...fake.api,
		appServer: { ...fake.api.appServer, getConnectionState: () => { void started.complete(); return checking.p; } },
		thread: { ...fake.api.thread, unsubscribe: async ({ threadId }) => { released.push(threadId); } },
	});
	const first = {}, second = {};
	await chat.subscribeThread('session-1', 'thread-1', 0, first);
	const closing = chat.unsubscribeThread('session-1', 'thread-1', first);
	await started.p;
	await chat.subscribeThread('session-1', 'thread-1', 0, second);
	await checking.complete('ready');
	await closing;
	assert.deepEqual(released, []);
	await chat.unsubscribeThread('session-1', 'thread-1', second);
	assert.deepEqual(released, ['thread-1']);
});

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

	const selectors = toSkillSelectors((await fake.api.skills.list("cached", "session-1")).skills);

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

for (const kind of ['Code', 'Cowork'] as const) {
	test(`${kind} reads Session Skills directly and rejects superseded catalog replies`, async () => {
		const fake = fakeApi();
		using changed = new Emitter<void>();
		const pending: DeferredPromise<Awaited<ReturnType<IAppServerSkillApi['list']>>>[] = [];
		const scopes: (string | undefined)[] = [];
		const catalog = (name: string) => ({ generation: 1, skills: [{ id: { source: 'directory:skill-source:test', name }, description: name, contentDigest: `sha256:${name}`, enabled: true, compatible: true }] });
		const api: IRendererHost = {
			...fake.api, skills: {
				...fake.api.skills, onDidChangeSkills: changed.event, list: async (_reload, sessionId) => {
					scopes.push(sessionId);
					if (scopes.length === 1) return catalog('initial');
					const request = new DeferredPromise<Awaited<ReturnType<IAppServerSkillApi['list']>>>();
					pending.push(request);
					return request.p;
				}
			}
		};
		using chat = createChatService(api);
		using sessions = new SessionsManagementService(api);
		using services = new InstantiationService();
		services.registerSingleton(IPromptsService, () => services.createInstance(PromptsService));
		services.registerInstance(IAppServerHookApi, { onDidChangeHooks: Event.None, list: async () => { throw new Error('Unexpected Hook read in Skill fixture'); } });
		services.registerInstance(IAppServerSkillApi, api.skills);
		services.registerInstance(ILanguageModelsService, modelsFor(chat));
		services.registerInstance(IAgentExecutionSettingsService, { onDidChange: Event.None, read: async () => ({ revision: 1, settings: { approvalMode: 'manual', commandFileAccess: 'directoryWrite', commandNetworkAccess: 'denied' } }), configure: async () => { } });
		using configuration = new WorkbenchConfigurationService();
		using storage = createTestStorage();
		services.registerInstance(IConfigurationService, configuration);
		services.registerInstance(IStorageService, storage);
		using preferences = services.createInstance(CoworkModelPreferencesService, CoworkModelPreferences);
		services.registerInstance(ICoworkModelPreferences, preferences);
		const selection = { kind: 'session' as const, active: { session: session('session-1'), threadId: 'thread-1' } };
		using widget = kind === 'Code' ? services.createInstance(ChatWidgetModel, chat, selection, sessions) : services.createInstance(CoworkWidgetModel, chat, selection, sessions);
		await widget.initialize();
		assert.deepEqual(scopes, ['session-1']);
		changed.fire();
		changed.fire();
		await pending[1]!.complete(catalog('latest'));
		await waitFor(() => widget.inputState.skillSelectors[0]?.name === 'latest');
		await pending[0]!.complete(catalog('stale'));
		await nextTask();
		assert.equal(widget.inputState.skillSelectors[0]?.name, 'latest');
		assert.deepEqual(scopes, ['session-1', 'session-1', 'session-1']);
		changed.fire();
		widget.dispose();
		await pending[2]!.complete(catalog('disposed'));
		await nextTask();
		assert.equal(widget.inputState.skillSelectors[0]?.name, 'latest');
	});
}

test('instruction references reach Turn start, queue and steering without becoming document text', async () => {
	const fake = fakeApi();
	using chat = createChatService(fake.api);
	const contexts = [{ name: 'Review', content: '/workspace/.ash/instructions/review.md', kind: 'instruction' as const }];
	const options = { sessionId: 'session-1', threadId: 'thread-1', expectedSequence: 1, text: 'Review this API', mode: 'agent' as const, contexts };
	await chat.startTurn(options);
	await chat.queueTurn(options);
	await chat.steerTurn({ ...options, turnId: 'turn-1' });
	const input = [{ type: 'instruction', path: contexts[0]!.content }, { type: 'text', text: options.text }];
	assert.deepEqual(fake.turnStartRequests[0]?.input, input);
	assert.deepEqual(fake.queuedRequests[0]?.input, input);
	assert.deepEqual(fake.turnSteerRequests[0]?.input, input);
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
	services.registerSingleton(IPromptsService, () => services.createInstance(PromptsService));
	services.registerInstance(IAppServerHookApi, { onDidChangeHooks: Event.None, list: async () => { throw new Error('Unexpected Hook read in Skill fixture'); } });
	services.registerInstance(IConfigurationService, configuration);
	services.registerInstance(IStorageService, storage);
	services.registerInstance(ILanguageModelsService, modelsFor(chat));
	services.registerInstance(IAgentExecutionSettingsService, { onDidChange: Event.None, read: async () => ({ revision: 1, settings: { approvalMode: 'manual', commandFileAccess: 'directoryWrite', commandNetworkAccess: 'denied' } }), configure: async () => { } });
	services.registerInstance(IAppServerSkillApi, skillServices.get(chat)!);
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
	using restoredCoworkPreferences = services.createInstance(CoworkModelPreferencesService, CoworkModelPreferences);
	const catalog = await modelsFor(chat).listModels();
	assert.deepEqual([modelsFor(chat).getDefaultNewChatModel(catalog), restoredCoworkPreferences.getDefaultNewChatModel(catalog)], [codeModel.model, coworkModel.model]);
	assert.deepEqual(sessions.untitledSessions.find(session => session.untitledSessionId === draft.untitledSessionId)?.model, codeModel.model);
	await cowork.send('Use the Cowork model');
	assert.deepEqual(fake.turnStartRequests.at(-1)?.model, coworkModel.model);
	assert.ok(fake.skillListRequests.includes(undefined));
	assert.equal(fake.skillListRequests.at(-1), 'created');
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
	await modelsFor(chat).rememberSelectedModel(first.model);
	await configuration.updateValue(ModelCatalogConfiguration.defaultModel, 'anthropic/claude-opus-5-5');
	const configuredDraft = sessions.createUntitledSession();
	using configured = createWidgetModel(chat, { kind: 'untitled', session: configuredDraft }, sessions);
	await configured.initialize();
	assert.deepEqual(configured.selectedModel, second.model);
	await configured.send('Use the configured model');
	assert.deepEqual(fake.turnStartRequests.at(-1)?.model, second.model);
	assert.ok(fake.skillListRequests.includes(undefined));
	assert.equal(fake.skillListRequests.at(-1), 'created');

	await configuration.updateValue(ModelCatalogConfiguration.defaultModel, '');
	const rememberedDraft = sessions.createUntitledSession();
	using remembered = createWidgetModel(chat, { kind: 'untitled', session: rememberedDraft }, sessions);
	await remembered.initialize();
	assert.deepEqual(remembered.selectedModel, first.model);
	await remembered.send('Use the remembered model');
	assert.deepEqual(fake.turnStartRequests.at(-1)?.model, first.model);
	using restoredChatService = createChatService(fake.api, configuration, storage);
	await modelsFor(restoredChatService).readModelDefaults();
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
	const discovered = createTestModel({
		model: { provider: 'custom-gateway', model: 'private-model' }, display_name: 'Private model', discovered: true,
		description: 'Private model overview',
		context_window: null, default_context_window: null, maximum_context_window: null, long_context: null, selected_acceleration: null, acceleration_options: [],
		auto_compact_token_limit: null, capabilities: { tools: 'supported', reasoning: 'unknown', parallel_tool_calls: 'unknown', personality: 'unknown', image_detail_original: 'unknown', fast_mode: 'unknown' },
		supported_reasoning_efforts: [{ effort: 'low', description: 'Quick tasks' }], default_reasoning_effort: null, default_personality: null,
	});
	discovered.capabilities.fast_mode = 'supported';
	discovered.settings.service_tiers = [{ id: 'priority', name: 'Priority lane', description: 'Faster processing' }];
	discovered.settings.acceleration = { type: 'service_tier', service_tier: 'priority' };
	discovered.acceleration_options = [{ id: 'priority', name: 'Priority lane', description: 'Faster processing' }];
	const initial = new DeferredPromise<Awaited<ReturnType<IRendererHost['model']['listModels']>>>();
	const fake = fakeApi();
	let loads = 0;
	using chat = createChatService({
		...fake.api, model: {
			...fake.api.model,
			listModels: async () => ++loads === 1 ? initial.p : agentModelCatalog([discovered]),
			listProviderModels: async () => (await agentModelCatalog([discovered])).models,
		}
	});
	const models = modelsFor(chat);
	const oldCatalog = models.listModelCatalog();
	const discovery = models.discoverProviderModels('custom-gateway');
	await initial.complete({ models: [] });
	assert.deepEqual(await oldCatalog, []);
	const pickerEntry = {
		model: discovered.model, displayName: discovered.display_name, description: discovered.description, discovered: true,
		inputModalities: null, retirement: undefined,
		contextWindow: null, defaultContextWindow: null, maximumContextWindow: null, longContext: null,
		selectedAcceleration: null, accelerationOptions: [{ id: 'priority', name: 'Priority lane', description: 'Faster processing' }],
		supportedReasoningEfforts: [{ effort: 'low', description: 'Quick tasks' }],
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
	discovered.acceleration_options[0].description = 'Updated processing terms';
	const refreshed = await models.refreshModels();
	assert.deepEqual(refreshed[0].accelerationOptions, [{ id: 'priority', name: 'Priority lane', description: 'Updated processing terms' }]);
	assert.equal(changes, 1);
	assert.equal(pickerEntry.accelerationOptions[0].description, 'Faster processing');
	discovered.description = 'Updated overview';
	discovered.supported_reasoning_efforts[0].description = 'Updated explanation';
	const explained = await models.refreshModels();
	assert.equal(explained[0].description, 'Updated overview');
	assert.deepEqual(explained[0].supportedReasoningEfforts, [{ effort: 'low', description: 'Updated explanation' }]);
	assert.equal(changes, 2);
	assert.equal(pickerEntry.description, 'Private model overview');
	assert.equal(pickerEntry.supportedReasoningEfforts[0].description, 'Quick tasks');
});

test("Language models service reads cached Kimi connections from the authoritative model catalog", async () => {
	const desktop = { model: { provider: 'kimi-desktop', model: 'desktop-k2' }, displayName: 'Desktop K2' };
	const cli = { model: { provider: 'kimi-cli', model: 'cli-k2' }, displayName: 'CLI K2' };
	const provider = (connection: string): ModelProviderCredentialStatus => ({
		connection, provider: connection, displayName: connection, access: 'subscription',
		active: true, configured: true, ready: true, apiKeyPolicy: 'unsupported', apiKeyConfigured: false,
	});
	const fake = fakeApi({
		providers: [provider('kimi-desktop'), provider('kimi-cli')],
		models: [desktop, cli],
	});
	using chat = createChatService(fake.api);

	assert.deepEqual((await modelsFor(chat).listModelCatalog()).map(({ model, displayName }) => ({ model, displayName })), [desktop, cli]);
	assert.deepEqual(fake.providerModelRequests, []);
	assert.deepEqual((await modelsFor(chat).listModelCatalog()).map(({ model, displayName }) => ({ model, displayName })), [desktop, cli]);
	assert.deepEqual(fake.providerModelRequests, []);
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

for (const kind of ['Code', 'Cowork'] as const) {
	test(`${kind} reopens root and child models independently of the profile default`, async () => {
		const rootModel = { provider: 'provider', model: 'root-a' };
		const childModel = { provider: 'provider', model: 'child-b' };
		const defaultModel = { provider: 'provider', model: 'default-c' };
		const durable = {
			...session('session-1', 'thread-1'), model: rootModel,
			chats: [...session('session-1', 'thread-1').chats, { threadId: 'child', origin: { type: 'fork' as const, parentThreadId: 'thread-1', parentSequence: 4 }, status: 'active' as const }],
		};
		const root = thread('Root answer');
		let currentThread = { ...root, turns: root.turns.map(turn => ({ ...turn, model: rootModel })) };
		const fake = fakeApi({ sessions: [durable], models: [rootModel, childModel, defaultModel].map(model => ({ model, displayName: model.model })), thread: () => currentThread });
		fake.api.model.readModel = async () => defaultModel;
		using configuration = new WorkbenchConfigurationService();
		await configuration.updateValue(ModelCatalogConfiguration.defaultModel, 'provider/default-c');
		await configuration.updateValue(CoworkModelPreferences.defaultModelSetting, 'provider/default-c');
		using chat = createChatService(fake.api, configuration);
		using sessions = new SessionsManagementService(fake.api);
		await sessions.openThread('session-1', 'thread-1');
		using services = new InstantiationService();
		services.registerSingleton(IPromptsService, () => services.createInstance(PromptsService));
		services.registerInstance(IAppServerHookApi, { onDidChangeHooks: Event.None, list: async () => { throw new Error('Unexpected Hook read in Skill fixture'); } });
		services.registerInstance(IAppServerSkillApi, fake.api.skills);
		services.registerInstance(ILanguageModelsService, modelsFor(chat));
		services.registerInstance(IAgentExecutionSettingsService, { onDidChange: Event.None, read: async () => ({ revision: 1, settings: { approvalMode: 'manual', commandFileAccess: 'directoryWrite', commandNetworkAccess: 'denied' } }), configure: async () => { } });
		services.registerInstance(IConfigurationService, configuration);
		using storage = createTestStorage();
		services.registerInstance(IStorageService, storage);
		using preferences = services.createInstance(CoworkModelPreferencesService, CoworkModelPreferences);
		services.registerInstance(ICoworkModelPreferences, preferences);
		const selection = { kind: 'session' as const, active: sessions.active! };
		using widget = kind === 'Code' ? services.createInstance(ChatWidgetModel, chat, selection, sessions) : services.createInstance(CoworkWidgetModel, chat, selection, sessions);
		await widget.initialize();
		assert.deepEqual({ catalog: sessions.active?.session.model, picker: widget.inputState.selectedModel }, { catalog: rootModel, picker: rootModel });
		await widget.send('Continue the root');
		currentThread = { ...root, threadId: 'child', origin: { type: 'fork', parentThreadId: 'thread-1', parentSequence: 4 }, turns: root.turns.map(turn => ({ ...turn, model: childModel })) };
		await sessions.openThread('session-1', 'child');
		await widget.selectThread(sessions.active!);
		assert.deepEqual({ catalog: sessions.active?.session.model, picker: widget.inputState.selectedModel }, { catalog: rootModel, picker: childModel });
		await widget.send('Continue the child');
		assert.deepEqual(fake.turnStartRequests.map(request => request.model), [rootModel, childModel]);
	});

	test(`${kind} preserves an unsent manual choice and explicit Auto across Session catalog model updates`, async () => {
		const initialModel = { provider: 'provider', model: 'initial' };
		const nextModel = { provider: 'provider', model: 'next' };
		const manualModel = { provider: 'provider', model: 'manual' };
		const persisted = [{ ...session('session-1', 'thread-1'), model: initialModel }];
		const fake = fakeApi({ sessions: persisted, models: [initialModel, nextModel, manualModel].map(model => ({ model, displayName: model.model })) });
		using chat = createChatService(fake.api);
		await modelsFor(chat).setModelVisible(manualModel, true);
		using sessions = new SessionsManagementService(fake.api);
		await sessions.openThread('session-1', 'thread-1');
		using services = new InstantiationService();
		services.registerSingleton(IPromptsService, () => services.createInstance(PromptsService));
		services.registerInstance(IAppServerHookApi, { onDidChangeHooks: Event.None, list: async () => { throw new Error('Unexpected Hook read in Skill fixture'); } });
		services.registerInstance(IAppServerSkillApi, fake.api.skills);
		services.registerInstance(ILanguageModelsService, modelsFor(chat));
		services.registerInstance(IAgentExecutionSettingsService, { onDidChange: Event.None, read: async () => ({ revision: 1, settings: { approvalMode: 'manual', commandFileAccess: 'directoryWrite', commandNetworkAccess: 'denied' } }), configure: async () => { } });
		using configuration = new WorkbenchConfigurationService();
		using storage = createTestStorage();
		services.registerInstance(IConfigurationService, configuration);
		services.registerInstance(IStorageService, storage);
		using preferences = services.createInstance(CoworkModelPreferencesService, CoworkModelPreferences);
		services.registerInstance(ICoworkModelPreferences, preferences);
		const selection = { kind: 'session' as const, active: sessions.active! };
		using widget = kind === 'Code' ? services.createInstance(ChatWidgetModel, chat, selection, sessions) : services.createInstance(CoworkWidgetModel, chat, selection, sessions);
		await widget.initialize();
		await widget.selectModel(manualModel);
		persisted[0] = { ...persisted[0]!, model: nextModel };
		fake.emit({ method: 'session/changed', params: { sessionId: 'session-1', agentTreeChanged: false } });
		await waitFor(() => sessions.active?.session.model?.model === nextModel.model);
		await widget.selectThread(sessions.active!);
		assert.deepEqual({ selected: widget.inputState.selectedModel, automatic: widget.inputState.isAutomaticModel }, { selected: manualModel, automatic: false });
		await widget.send('Use the unsent manual choice');
		await widget.selectAutomaticModel();
		persisted[0] = { ...persisted[0]!, model: initialModel };
		fake.emit({ method: 'session/changed', params: { sessionId: 'session-1', agentTreeChanged: false } });
		await waitFor(() => sessions.active?.session.model?.model === initialModel.model);
		await widget.selectThread(sessions.active!);
		assert.equal(widget.inputState.isAutomaticModel, true);
		await widget.send('Use explicit Auto');
		assert.deepEqual(fake.turnStartRequests.map(request => request.model), [manualModel, undefined]);
	});
}

test("ChatWidgetModel keeps per-chat choices while saving the default for new chats", async () => {
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
	const fake = fakeApi({ sessions: [activeSession], models: [firstModel, secondModel].map(model => ({ model, displayName: model.model })), thread: () => currentThread });
	using chat = createChatService(fake.api);
	await modelsFor(chat).setModelVisible(firstModel, true);
	await modelsFor(chat).setModelVisible(secondModel, true);
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
	assert.deepEqual((await fake.api.model.readDefaults()).model, secondModel);
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

test('ChatWidgetModel Auto retains the configured profile model and leaves Turn resolution to the backend', async () => {
	const sessionModel: ModelRef = { provider: 'openai', model: 'gpt-default' };
	const manualModel: ModelRef = { provider: 'openai', model: 'gpt-manual' };
	const activeSession = { ...session('session-1', 'thread-1'), model: sessionModel };
	const fake = fakeApi({ sessions: [activeSession], models: [sessionModel, manualModel].map(model => ({ model, displayName: model.model })) });
	using chat = createChatService(fake.api);
	await modelsFor(chat).setModelVisible(manualModel, true);
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
	assert.deepEqual((await fake.api.model.readDefaults()).model, manualModel);
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

for (const kind of ['tool', 'shell', 'contextCompaction', 'advisor'] as const) {
	test(`ChatWidgetModel queues user follow-ups after an active ${kind} Turn instead of losing them to steering`, async () => {
		const activeSession = session('session-1', 'thread-1');
		const value = thread('previous result');
		value.turns[0]!.status = 'running';
		value.turns[0]!.kind = kind;
		value.turns[0]!.mode = 'agent';
		const fake = fakeApi({ sessions: [activeSession], thread: () => value });
		using chat = createChatService(fake.api);
		using sessions = new SessionsManagementService(fake.api);
		using model = createWidgetModel(chat, { kind: 'session', active: { session: activeSession, threadId: 'thread-1' } }, sessions);
		await model.initialize();
		await model.send('Follow up', 'agent', undefined, [{ name: 'App context', content: 'latest context' }]);
		assert.equal(fake.turnStartRequests.length, 0);
		assert.equal(fake.turnSteerRequests.length, 0);
		assert.equal(fake.queuedRequests.length, 1);
		assert.deepEqual(fake.queuedRequests[0]?.input, [{ type: 'context', name: 'App context', content: 'latest context' }, { type: 'text', text: 'Follow up' }]);
	});
}

test('Chat mode accessibility help explains switch_mode in Chinese and restores input focus', async () => {
	const { SessionsChatAccessibilityHelp } = await import('../../contrib/chat/browser/sessionsChatAccessibilityHelp.js');
	const { productLanguagePackCatalogs } = await import('../../../workbench/services/localization/common/localizationCatalogs.js');
	const { formatNlsMessage, setNlsResolver, resetNlsResolver } = await import('../../../nls.js');
	const chinese = productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
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
	let auxiliaryBarSize = new Dimension(380, 600);
	const visibility = new Emitter<WorkbenchPartVisibilityChangeEvent>();
	const visibleParts = new Set<WorkbenchPartId>(auxiliaryBarVisible ? ["auxiliarybar"] : []);
	const updateVisibility = (partId: WorkbenchPartId, visible: boolean): void => {
		if (visible === visibleParts.has(partId)) return;
		if (visible) visibleParts.add(partId);
		else visibleParts.delete(partId);
		visibility.fire({ partId, visible });
	};
	const layout: Partial<IWorkbenchLayoutService> = {
		getPartSize: () => auxiliaryBarSize,
		resizePart: (_partId, size) => { auxiliaryBarSize = new Dimension(size.width, size.height); },
		onDidChangePartVisibility: visibility.event,
		isPartVisible: (partId) => visibleParts.has(partId),
		showPart: (partId) => updateVisibility(partId, true),
		showParts: (partIds) => partIds.forEach((partId) => updateVisibility(partId, true)),
		hidePart: (partId) => updateVisibility(partId, false),
		hideParts: (partIds) => partIds.forEach((partId) => updateVisibility(partId, false)),
	};
	return layout as IWorkbenchLayoutService;
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
	readonly skillListRequests: readonly (string | undefined)[];
	readonly providerModelRequests: readonly string[];
	readonly providerKeyRequests: readonly { readonly connection: string; readonly apiKey: string; }[];
	readonly modelRequests: readonly { readonly commandId: string; readonly model: ModelRef; }[];
	readonly savedAdvisorDefaults: readonly (AdvisorConfig | null)[];
	readonly emit: (notification: ServerNotification) => void;
	readonly emitReady: () => void;
} {
	const listeners = new Set<(notification: ServerNotification) => void>();
	const connectionListeners = new Set<(state: "ready") => void>();
	let connectionGeneration = 1;
	let modelDefaults = { revision: 1, model: null as ModelRef | null, reasoningEffort: null as import('../../../platform/agentHost/common/agentModels.js').ModelReasoningEffort | null };
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
	const skillListRequests: (string | undefined)[] = [];
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
		accounts: { read: async () => ({ revision: '1', accounts: [] }) },
		appServer: {
			get connectionGeneration() { return connectionGeneration; },
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
				threadSnapshots: [],
				agentTree: { roots: [] },
			}),
			unsubscribe: async () => undefined,
			create: async (params: SessionCreateParams) => {
				createSessionRequests.push(params);
				if (options.createSessionError) throw options.createSessionError;
				const created = options.createSession ?? options.createThread?.session ?? session("created", "created-thread");
				// Legacy fixtures kept root creation in createThread; the real create API is atomic.
				const chats = created.chats.length ? created.chats : (options.createThread?.session ?? session(created.sessionId, 'created-thread')).chats;
				return { session: sessionDto({ ...created, chats }) };
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
			readDefaults: async () => modelDefaults,
			configureDefaults: async (update: import('../../../platform/agentHost/common/agentModels.js').AgentModelDefaultsUpdate, expectedRevision: number) => {
				assert.equal(expectedRevision, modelDefaults.revision);
				modelDefaults = { revision: modelDefaults.revision + 1, model: update.model === undefined ? modelDefaults.model : update.model, reasoningEffort: update.reasoningEffort === undefined ? modelDefaults.reasoningEffort : update.reasoningEffort };
			},
			setModelPreferences: async () => { },
			listModels: async () => {
				modelListRequests.push(undefined);
				return agentModelCatalog((options.models ?? []).map(entry => createTestModel({
					model: entry.model, display_name: entry.displayName,
					context_window: entry.contextWindow ?? null,
					default_reasoning_effort: entry.defaultReasoningEffort ?? null,
					supported_reasoning_efforts: (entry.supportedReasoningEfforts ?? []).map(option => ({ ...option, description: option.description ?? null })),
				})));
			},
			listProviders: async () => ({ providers: providers.map(provider => ({ ...provider })) }),
			listProviderModels: async (connection: string) => {
				providerModelRequests.push(connection);
				return (await agentModelCatalog((options.providerModels?.[connection] ?? []).map(entry => createTestModel({ model: entry.model, display_name: entry.displayName })))).models;
			},
			setProviderApiKey: async ({ connection, apiKey }: { connection: string; apiKey: string; }) => {
				providerKeyRequests.push({ connection, apiKey });
				providers = providers.map(entry => entry.connection === connection ? { ...entry, apiKeyConfigured: true, active: true, configured: true, ready: true } : entry);
				return { connection, apiKeyConfigured: true };
			},
			readAdvisorDefault: async () => advisorDefault,
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
			onDidChangeSkills: Event.None, readTextResource: async () => { throw new Error("No Skill body in this test fixture"); },
			list: async (_reload: string, sessionId?: string) => { skillListRequests.push(sessionId); return { generation: 1, skills: options.skills ?? [] }; },
		},
		thread: {
			...createAppServerAgentThreadService({ get generation() { return connectionGeneration; }, onNotification: (listener: (event: ServerNotification) => void) => { listeners.add(listener); return toDisposable(() => listeners.delete(listener)); } } as AppServerProtocolClient),
			readContext: async () => ({
				context: {
					estimatedTokens: 200, estimatorRevision: 'test', model: { provider: 'test', model: 'test-model' },
					compactionPolicy: { mode: 'summary', summaryTokens: 100, recentTokens: 100 },
					allocation: { contextWindow: 1000, autoCompactWindow: 1000, autoCompactAt: 800, autoCompactBuffer: 0, reservedOutput: 100, safetyMargin: 100 },
					categories: [{ category: 'conversation', tokens: 200, sources: [] }], latestRequest: { usedTokens: 180, source: 'estimated' },
				}, toolDefinitions: []
			}),
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
		skillListRequests,
		providerModelRequests,
		providerKeyRequests,
		modelRequests,
		savedAdvisorDefaults,
		emit: (notification) => {
			for (const listener of listeners) listener(notification);
		},
		emitReady: () => {
			connectionGeneration++;
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
		model: value.model,
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
		hookRuns: [],
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

function failedTurn(code: TurnError["code"], retryable: boolean, message = "Turn failed"): Omit<Thread["turns"][number], 'items'> & { items: []; } {
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
		hookRuns: [],
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
	assert.equal(list.element.querySelector('.ash-chat-item-label')!.textContent, 'You');
	assert.equal(list.element.querySelector('figcaption')!.textContent, 'Audio (2 seconds)');
	assert.equal(list.element.querySelector('audio')!.controls, true);
	assert.equal(list.element.querySelector('button')!.textContent, 'Load audio');
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
	using quickInput = new TestQuickInputService({ container: dom.window.document.body, contextKeyService: contextKeys });
	const services = new InstantiationService();
	services.registerSingleton(IPromptsService, () => services.createInstance(PromptsService));
	services.registerInstance(IAppServerHookApi, { onDidChangeHooks: Event.None, list: async () => { throw new Error('Unexpected Hook read in Skill fixture'); } });
	services.registerInstance(IChatService, chat);
	services.registerInstance(ILanguageModelsService, modelsFor(chat));
	services.registerInstance(IAgentExecutionSettingsService, { onDidChange: Event.None, read: async () => ({ revision: 1, settings: { approvalMode: 'manual', commandFileAccess: 'directoryWrite', commandNetworkAccess: 'denied' } }), configure: async () => { } });
	services.registerInstance(IAppServerSkillApi, skillServices.get(chat)!);
	services.registerInstance(IQuickInputService, quickInput);
	services.registerInstance(IDialogService, recordingDialogService([]));
	using keybindingFiles = new KeybindingTestServices();
	using editorServices = createTestEditorServices(undefined, keybindingFiles.services);
	editorServices.registerInstance(IDialogService, recordingDialogService([]));
	using preferences = new BrowserPreferencesService({
		...emptyEditorServiceState,
		openEditor: async () => undefined,
		focusActiveEditor() { },
	}, editorServices.get(IFileTextModelService), keybindingFiles.files, keybindingFiles.profiles, editorServices);
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
	using quickInput = new TestQuickInputService({ container: dom.window.document.body, contextKeyService: contextKeys });
	const messages: IMessageDialogOptions[] = [];
	const services = new InstantiationService();
	services.registerSingleton(IPromptsService, () => services.createInstance(PromptsService));
	services.registerInstance(IAppServerHookApi, { onDidChangeHooks: Event.None, list: async () => { throw new Error('Unexpected Hook read in Skill fixture'); } });
	services.registerInstance(IChatService, chat);
	services.registerInstance(ILanguageModelsService, modelsFor(chat));
	services.registerInstance(IAgentExecutionSettingsService, { onDidChange: Event.None, read: async () => ({ revision: 1, settings: { approvalMode: 'manual', commandFileAccess: 'directoryWrite', commandNetworkAccess: 'denied' } }), configure: async () => { } });
	services.registerInstance(IAppServerSkillApi, skillServices.get(chat)!);
	services.registerInstance(IQuickInputService, quickInput);
	services.registerInstance(IDialogService, recordingDialogService(messages));
	using keybindingFiles = new KeybindingTestServices();
	using editorServices = createTestEditorServices(undefined, keybindingFiles.services);
	editorServices.registerInstance(IDialogService, recordingDialogService([]));
	using preferences = new BrowserPreferencesService({
		...emptyEditorServiceState,
		openEditor: async () => undefined,
		focusActiveEditor() { },
	}, editorServices.get(IFileTextModelService), keybindingFiles.files, keybindingFiles.profiles, editorServices);
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
	const entries: readonly ThreadTranscriptEntry[] = [
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

test('approval capabilities reach the composer only through owner-directed backend offers', async () => {
	const activeSession = session('session-1', 'thread-1');
	const pendingThread = thread('Pending approval');
	const fake = fakeApi({ sessions: [activeSession], thread: () => ({ ...pendingThread, sequence: 2, turns: pendingThread.turns.map(turn => ({ ...turn, status: 'waitingForApproval' })) }) });
	using chat = createChatService(fake.api);
	using sessions = new SessionsManagementService(fake.api);
	using model = createWidgetModel(chat, { kind: 'session', active: { session: activeSession, threadId: 'thread-1' } }, sessions);
	await model.initialize();
	const interaction = { requestId: 'approval-1', request: { type: 'approval' as const, request: { actionDigest: 'action', policyRevision: 'policy', reason: 'Review this write', allowedDecisions: ['approveOnce' as const, 'decline' as const], capabilities: [{ kind: 'fileWrite' as const, scope: String.raw`C:\Users\name\file.txt` }] } } };
	fake.emit({ method: 'session/thread/update', params: { sessionId: 'session-1', threadId: 'thread-1', durableSequence: 2, update: { type: 'committed', event: { type: 'interactionRequested', threadId: 'thread-1', turnId: 'turn-1', interaction } } } });
	assert.equal(model.interaction, undefined);
	fake.emit({ method: 'agent/request', params: { sessionId: 'session-1', threadId: 'thread-1', turnId: 'turn-1', interaction } });
	assert.deepEqual(model.inputState.interaction?.request, { type: 'approval', request: { reason: interaction.request.request.reason, allowedDecisions: interaction.request.request.allowedDecisions, command: undefined, capabilities: interaction.request.request.capabilities } });
	await nextTask();
});

for (const kind of ['Code', 'Cowork']) {
	test(`${kind} concurrent model visibility saves preserve both enabled rows after the first durable write`, async () => {
		using configuration = new WorkbenchConfigurationService();
		const firstWrite = new DeferredPromise<void>();
		const started = new DeferredPromise<void>();
		const write = configuration.updateValue.bind(configuration);
		let writes = 0;
		configuration.updateValue = async (key, value) => {
			if (key === ModelCatalogConfiguration.hiddenModels && ++writes === 1) {
				void started.complete();
				await firstWrite.p;
			}
			await write(key, value);
		};
		const entries = ['first', 'second'].map(model => ({ model: { provider: 'custom', model }, displayName: model }));
		const fake = fakeApi({ models: entries });
		using storage = createTestStorage();
		using chat = createChatService(fake.api, configuration, storage);
		using services = new InstantiationService();
		services.registerInstance(IConfigurationService, configuration);
		services.registerInstance(IStorageService, storage);
		using cowork = services.createInstance(CoworkModelPreferencesService, CoworkModelPreferences);
		const models = modelsFor(chat);
		const visibility = kind === 'Code' ? models : cowork;
		const first = visibility.setModelVisible(entries[0]!.model, true);
		await started.p;
		const second = visibility.setModelVisible(entries[1]!.model, true);
		await firstWrite.complete();
		await Promise.all([first, second]);
		assert.deepEqual((await models.listModels()).map(entry => entry.model), entries.map(entry => entry.model));
		assert.equal(writes, 2);
	});
}


test('ChatWidgetModel inherits profile approval and preserves a conversation override across default changes', async () => {
	const fake = fakeApi();
	using chat = createChatService(fake.api);
	using sessions = new SessionsManagementService(fake.api);
	using changed = new Emitter<void>();
	let mode: import('../../../platform/agentHost/common/approvalModes.js').ApprovalMode = 'auto';
	const execution: IAgentExecutionSettingsService = { onDidChange: changed.event, read: async () => ({ revision: 1, settings: { approvalMode: mode, commandFileAccess: 'readOnly', commandNetworkAccess: 'denied' } }), configure: async () => { } };
	using model = createWidgetModel(chat, { kind: 'untitled', session: sessions.createUntitledSession() }, sessions, execution);
	await model.initialize();
	assert.equal(model.inputState.approvalMode, 'auto');
	const updated = new Promise<void>(resolve => { const subscription = model.onDidChange(() => { subscription.dispose(); resolve(); }); });
	mode = 'bypassPermissions'; changed.fire(); await updated;
	assert.equal(model.inputState.approvalMode, 'bypassPermissions');
	model.selectApprovalMode('manual');
	const overridden = new Promise<void>(resolve => { const subscription = model.onDidChange(() => { subscription.dispose(); resolve(); }); });
	mode = 'auto'; changed.fire(); await overridden;
	assert.equal(model.inputState.approvalMode, 'manual');
});


test('Chat context usage refresh ignores an estimate from an older connection', async () => {
	const activeSession = session('session-1', 'thread-1');
	const fake = fakeApi({ sessions: [activeSession] });
	const sample = await fake.api.thread.readContext({ sessionId: 'session-1', threadId: 'thread-1' });
	const oldRead = new DeferredPromise<typeof sample>();
	const currentRead = new DeferredPromise<typeof sample>();
	let reads = 0;
	using chat = createChatService({ ...fake.api, thread: { ...fake.api.thread, readContext: () => (++reads === 1 ? oldRead : currentRead).p } });
	using sessions = new SessionsManagementService(fake.api);
	using model = createWidgetModel(chat, { kind: 'session', active: { session: activeSession, threadId: 'thread-1' } }, sessions);
	await model.initialize();
	const contextUsage = () => model.inputState.contextUsage;
	await waitFor(() => reads === 1);
	assert.deepEqual(contextUsage(), undefined);
	fake.emitReady();
	await waitFor(() => reads === 2);
	await currentRead.complete({ ...sample, context: { ...sample.context, estimatedTokens: 400 } });
	await waitFor(() => contextUsage()?.estimatedTokens === 400);
	assert.deepEqual(contextUsage(), {
		estimatedTokens: 400, contextWindow: 1000, autoCompactAt: 800,
		model: { provider: 'test', model: 'test-model' }, latestRequestTokens: 180,
		categories: [{ category: 'conversation', tokens: 200 }],
	});
	await oldRead.complete({ ...sample, context: { ...sample.context, estimatedTokens: 100 } });
	await nextTask();
	assert.equal(contextUsage()?.estimatedTokens, 400);
});

test('Chat footer permission changes use the current model and confirm full access', async () => {
	const activeSession = session('session-1', 'thread-1');
	const fake = fakeApi({ sessions: [activeSession] });
	using chat = createChatService(fake.api);
	using sessions = new SessionsManagementService(fake.api);
	using model = createWidgetModel(chat, { kind: 'session', active: { session: activeSession, threadId: 'thread-1' } }, sessions);
	await model.initialize();
	using contextView = new BrowserContextViewService(document.body);
	const services = createInputServices(contextView, chat);
	let confirmed = false;
	let confirmations = 0;
	const dialogs = { ...recordingDialogService([]), confirm: async () => { confirmations++; return { confirmed }; } };
	const delegates: ChatInputDelegate[] = [];
	using widget = new ChatWidget(document.body, 'footer-permissions', model, () => { },
		{} as IContextMenuService, contextView, services.get(ICommandService), unavailableAccessibleViewService, notifications,
		undefined, undefined, undefined, (container, delegate) => {
			delegates.push(delegate);
			return services.createInstance(ChatInputPart, container, delegate, {} as IContextMenuService, contextView, unavailableAccessibleViewService, notifications, ChatInputEditors, [], { modePicker: 'visible', modelPickerPosition: 'leading' });
		}, services, dialogs, services.get(IQuickInputService));
	const delegate = delegates[0]!;
	assert.ok(delegate.selectApprovalMode);
	await delegate.selectApprovalMode('auto');
	assert.equal(model.inputState.approvalMode, 'auto');
	assert.equal(confirmations, 0);
	await delegate.selectApprovalMode('bypassPermissions');
	assert.equal(model.inputState.approvalMode, 'auto');
	assert.equal(confirmations, 1);
	confirmed = true;
	await delegate.selectApprovalMode('bypassPermissions');
	assert.equal(model.inputState.approvalMode, 'bypassPermissions');
	assert.equal(confirmations, 2);
});
function agentModelCatalog(models: ModelListResult['models']) {
	return createAppServerAgentModelsService({
		async request(): Promise<ModelListResult> { return { models }; },
	} as unknown as AppServerProtocolClient).listModels();
}


async function chooseConversation(pane: InstanceType<typeof ChatViewPane>, dom: JSDOM, index: number): Promise<void> {
	chatTitleContent(pane).querySelector<HTMLButtonElement>('.ash-chat-view-title-button')!.click();
	await nextTask();
	const input = dom.window.document.querySelector<HTMLInputElement>('.ash-quick-pick-input input')!;
	assert.ok(input);
	for (let step = 0; step < index; step++) input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, key: 'ArrowDown' }));
	input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
	await nextTask();
}


test('ChatWidgetModel connects agentHost tool transcript updates to a retained call and interrupted Turn', async () => {
	const activeSession = session('session-1', 'thread-1');
	const original = { ...thread('initial'), sequence: 1 };
	let currentThread: Thread = { ...original, turns: [{ ...original.turns[0], status: 'running', items: [{ type: 'toolCall', itemId: 'call', turnId: 'turn-1', toolCallId: 'tool', name: 'shell', argumentsJson: '{}' }] }] };
	const fake = fakeApi({ sessions: [activeSession], thread: () => currentThread });
	using chat = createChatService(fake.api);
	using sessions = new SessionsManagementService(fake.api);
	using model = createWidgetModel(chat, { kind: 'session', active: { session: activeSession, threadId: 'thread-1' } }, sessions);
	await model.initialize();
	const callId = model.items[0].id;
	assert.equal(model.items[0].toolInvocation?.call.name, 'shell');
	assert.equal(model.items[0].toolInvocation?.stopped, false);
	fake.emit({ method: 'session/thread/transcript/update', params: { sessionId: 'session-1', threadId: 'thread-1', durableSequence: 1, revision: 2, changes: [{ type: 'upsert', entry: { type: 'toolOutput', entryId: 'output', turnId: 'turn-1', toolCallId: 'tool', stream: 'stdout', text: 'streaming' } }] } });
	assert.equal(model.items.length, 1);
	assert.equal(model.items[0].id, callId);
	assert.equal(model.items[0].toolInvocation?.output[0].text, 'streaming');
	currentThread = { ...currentThread, turns: currentThread.turns.map(turn => ({ ...turn, status: 'interrupted' })) };
	fake.emitReady();
	await waitFor(() => model.items[0]?.toolInvocation?.stopped === true);
	assert.equal(model.items[0].toolInvocation?.result, undefined);
	assert.equal(model.items[0].transient, false);
});


test('Chat model saves cannot overwrite or send the previous input into the newly selected Thread', async () => {
	const entry = { model: { provider: 'openai', model: 'gpt-6.1-sol' }, displayName: 'First' };
	const activeSession = session('session-1');
	let currentThread = thread();
	const fake = fakeApi({ sessions: [activeSession], models: [entry], thread: () => currentThread });
	const saved = new DeferredPromise<void>();
	fake.api.model.configureDefaults = async () => saved.p;
	using chat = createChatService(fake.api);
	using sessions = new SessionsManagementService(fake.api);
	using model = createWidgetModel(chat, { kind: 'session', active: { session: activeSession, threadId: 'thread-1' } }, sessions);
	await model.initialize();
	const selecting = model.selectModel(entry.model);
	const sending = model.send('Keep this message in its original Thread');
	const canceledSend = assert.rejects(sending, error => isCancellationError(error));
	assert.equal(model.selectedModel, undefined);
	currentThread = { ...currentThread, threadId: 'thread-2' };
	await model.selectThread({ session: { ...activeSession, chats: [{ ...activeSession.chats[0]!, threadId: 'thread-2' }] }, threadId: 'thread-2' });
	await saved.complete(); await selecting; await canceledSend;
	assert.equal(fake.turnStartRequests.length, 0);
	assert.equal(model.threadId, 'thread-2');
	assert.equal(model.selectedModel, undefined);
});

test('Chat selection failure retains Auto and sending awaits successful effort persistence', async () => {
	const entry = { model: { provider: 'openai', model: 'gpt-6.1-sol' }, displayName: 'First', supportedReasoningEfforts: [{ effort: 'high' as const }] };
	const fake = fakeApi({ models: [entry], createSession: session('created', 'created-thread'), thread: () => ({ ...thread(), threadId: 'created-thread' }) });
	using chat = createChatService(fake.api);
	using sessions = new SessionsManagementService(fake.api);
	using model = createWidgetModel(chat, { kind: 'untitled', session: sessions.createUntitledSession() }, sessions);
	await model.initialize();
	const write = fake.api.model.configureDefaults;
	fake.api.model.configureDefaults = async () => { throw new Error('save rejected'); };
	await assert.rejects(model.selectModel(entry.model), /save rejected/);
	assert.equal(model.isAutomaticModel, true);
	fake.api.model.configureDefaults = write;
	await model.selectModel(entry.model);
	const saved = new DeferredPromise<void>();
	fake.api.model.configureDefaults = async (...args) => { await saved.p; await write(...args); };
	const selecting = model.selectReasoningEffort('high');
	const sending = model.send('Use saved effort');
	await nextTask(); assert.equal(fake.turnStartRequests.length, 0);
	await saved.complete(); await Promise.all([selecting, sending]);
	assert.equal(fake.turnStartRequests.at(-1)?.reasoningEffort, 'high');
});

test('Queued chat Turns inherit the backend permission default and reject a late connection read', async () => {
	const fake = fakeApi();
	using services = new InstantiationService();
	registerChatBackend(services, fake.api, IAgentExecutionSettingsService);
	const pending = new DeferredPromise<Awaited<ReturnType<IAgentExecutionSettingsService['read']>>>();
	let delayed = false;
	services.registerInstance(IAgentExecutionSettingsService, { onDidChange: Event.None, configure: async () => { }, read: async () => delayed ? pending.p : { revision: 2, settings: { approvalMode: 'auto', commandFileAccess: 'readOnly', commandNetworkAccess: 'denied' } } });
	using chat = services.createInstance(ChatService);
	const options = { sessionId: 'session-1', threadId: 'thread-1', expectedSequence: 1, text: 'Queue', mode: 'agent' as const };
	await chat.queueTurn(options);
	assert.equal(fake.queuedRequests[0]?.approvalMode, 'auto');
	await chat.queueTurn({ ...options, approvalMode: 'manual' });
	assert.equal(fake.queuedRequests[1]?.approvalMode, 'manual');
	delayed = true;
	const queuing = chat.queueTurn(options);
	fake.emitReady();
	await pending.complete({ revision: 2, settings: { approvalMode: 'auto', commandFileAccess: 'readOnly', commandNetworkAccess: 'denied' } });
	await assert.rejects(queuing, error => isCancellationError(error));
	assert.equal(fake.queuedRequests.length, 2);
});


test('New chat Turns let the backend inherit permission when the default read fails', async () => {
	const fake = fakeApi({ createSession: session('created', 'created-thread'), thread: () => ({ ...thread(), threadId: 'created-thread' }) });
	using chat = createChatService(fake.api);
	using sessions = new SessionsManagementService(fake.api);
	using model = createWidgetModel(chat, { kind: 'untitled', session: sessions.createUntitledSession() }, sessions,
		{ onDidChange: Event.None, read: async () => { throw new Error('temporarily unavailable'); }, configure: async () => { } });
	await model.initialize();
	await model.send('Inherit server permissions');
	assert.equal(fake.turnStartRequests.at(-1)?.approvalMode, undefined);
});


test('A queued permission read cannot enqueue after a same-generation crash', async () => {
	const fake = fakeApi();
	using connection = new Emitter<AppServerConnectionState>();
	using services = new InstantiationService();
	registerChatBackend(services, { ...fake.api, appServer: { ...fake.api.appServer, onConnectionState: listener => connection.event(listener) } }, IAgentExecutionSettingsService);
	const pending = new DeferredPromise<Awaited<ReturnType<IAgentExecutionSettingsService['read']>>>();
	services.registerInstance(IAgentExecutionSettingsService, { onDidChange: Event.None, configure: async () => { }, read: () => pending.p });
	using chat = services.createInstance(ChatService);
	const queuing = chat.queueTurn({ sessionId: 'session-1', threadId: 'thread-1', expectedSequence: 1, text: 'Queue', mode: 'agent' });
	const rejected = assert.rejects(queuing, error => isCancellationError(error));
	connection.fire('crashed');
	await pending.complete({ revision: 2, settings: { approvalMode: 'auto', commandFileAccess: 'readOnly', commandNetworkAccess: 'denied' } });
	await rejected;
	assert.equal(fake.queuedRequests.length, 0);
});


test('An unavailable model leaves backend defaults and Auto intact with the generated Chinese catalog', async () => {
	initializeTestLocalization('zh-CN');
	try {
		const fake = fakeApi();
		using chat = createChatService(fake.api);
		using sessions = new SessionsManagementService(fake.api);
		using model = createWidgetModel(chat, { kind: 'untitled', session: sessions.createUntitledSession() }, sessions);
		await model.initialize();
		const before = await fake.api.model.readDefaults();
		await assert.rejects(model.selectModel({ provider: 'missing', model: 'retired' }), { message: '所选模型不可用' });
		assert.deepEqual(await fake.api.model.readDefaults(), before);
		assert.equal(model.isAutomaticModel, true);
	} finally { resetNlsResolver(); }
});


function navigationThreadSnapshot(threadId: string): import('../../../platform/agentHost/common/agentService.js').ThreadRead {
	return {
		thread: { advisor: { type: 'default' }, agentId: 'agent-1', origin: { type: 'root' }, sessionId: 'session-1', threadId, title: 'Navigation fixture', status: 'active', sequence: 1, usage: emptyUsage(), turns: [] },
		transcript: { sessionId: 'session-1', threadId, durableSequence: 1, revision: 1, entries: [] },
	};
}


async function createNavigationInputPane(configurationSource = '{}', configurationFiles?: IFileService, threadApi: Partial<IAgentThreadService> = {}) {
	const resources = new DisposableStore();
	const dom = new JSDOM('<!doctype html><body></body>');
	const contextView = resources.add(new BrowserContextViewService(dom.window.document.body));
	const activeSession: ISession = {
		...session('session-1', 'thread-1', 'Navigation fixture'),
		chats: [
			{ threadId: 'thread-1', origin: { type: 'root' }, status: 'active' },
			{ threadId: 'thread-2', origin: { type: 'fork', parentThreadId: 'thread-1', parentSequence: 1 }, status: 'active' },
		],
	};
	const fake = fakeApi({ sessions: [activeSession] });
	const api: IRendererHost = {
		...fake.api,
		thread: {
			...fake.api.thread,
			read: async ({ threadId }) => navigationThreadSnapshot(threadId),
			subscribe: async ({ threadId }) => ({ ...navigationThreadSnapshot(threadId), updates: [] }),
			...threadApi,
		},
	};
	const sessions = resources.add(new SessionsManagementService(api));
	const contextKeys = resources.add(new ContextKeyService());
	resources.add(new ViewDescriptorService({ registry: new WorkbenchViewRegistry() }, contextKeys));
	const commandServices = resources.add(new InstantiationService());
	const configuration = resources.add(new WorkbenchConfigurationService({ source: configurationSource }));
	commandServices.registerInstance(IConfigurationService, configuration);
	const commands = resources.add(new CommandService(commandServices));
	const menu = new MenuService(commands, contextKeys);
	const contextMenus = { showContextMenu: () => { } } as unknown as IContextMenuService;
	const chat = resources.add(createChatService(api, configuration));
	const inputServices = createInputServices(contextView, chat, menu, contextMenus);
	const pane = resources.add(new ChatViewPane(dom.window.document.body, { id: CHAT_VIEW_ID, title: 'Chat' }, chat, sessions,
		menu, contextMenus, contextView, commands, testLayoutService(), configurationFiles ?? configuration.fileService, unavailableAccessibleViewService, notifications,
		inputServices, configuration, inputResources.add(createTestStorage()), userDataProfile));
	dom.window.document.body.append(pane.element);
	await sessions.initialize();
	await nextTask();
	const chatPane = pane.element.querySelector<HTMLElement>('.ash-chat-pane-host > .ash-chat')!;
	const input = chatPane.querySelector<HTMLTextAreaElement>('.ash-chat-textarea-input')!;
	assert.ok(input);
	resources.add(toDisposable(() => dom.window.close()));
	return { resources, dom, fake, pane, sessions, chatPane, input, configuration, commands };
}

for (const locale of ['en', 'zh-CN']) {
	test(`Chat history recovery preserves the draft and attachments without sending in ${locale}`, async () => {
		initializeTestLocalization(locale);
		try {
			let subscriptions = 0;
			const pending = new DeferredPromise<import('../../../platform/agentHost/common/agentService.js').ThreadSubscription>();
			const fixture = await createNavigationInputPane('{}', undefined, {
				subscribe: async () => {
					subscriptions++;
					if (subscriptions === 1) throw new Error('History fixture unavailable');
					return pending.p;
				},
			});
			using resources = fixture.resources;
			const { pane, fake, chatPane, input, dom } = fixture;
			const recovery = chatPane.querySelector<HTMLElement>('.ash-chat-history-status')!;
			await waitFor(() => !recovery.hidden);
			const retry = recovery.querySelector<HTMLButtonElement>('button')!;
			assert.equal(retry.textContent, locale === 'en' ? 'Retry loading chat' : '重新加载聊天');
			assert.match(recovery.textContent!, locale === 'en' ? /Could not load chat history/u : /无法加载聊天历史/u);
			typeChatText(dom.window, input, 'Keep this draft');
			pane.addContext({ id: 'history-file', kind: 'file', name: 'fixture.txt', resolve: async () => ({ name: 'fixture.txt', content: 'Synthetic context' }) });
			const originalDraft = input.value;
			await pane.acceptInput();
			assert.equal(fake.turnStartRequests.length, 0);
			retry.focus();
			const help = AccessibleViewRegistry.getImplementations().find(provider => provider.type === AccessibleViewType.Help && provider.name.startsWith('chatHistory-'))!.getProvider({} as ServicesAccessor);
			assert.ok(help);
			assert.match(help.provideContent(), locale === 'en' ? /never sends a message/u : /不会发送消息/u);
			retry.click();
			retry.click();
			assert.equal(retry.disabled, true);
			assert.equal(recovery.getAttribute('aria-busy'), 'true');
			assert.equal(subscriptions, 2);
			await pending.complete({ ...navigationThreadSnapshot('thread-1'), updates: [] });
			await waitFor(() => recovery.hidden === true);
			await waitFor(() => dom.window.document.activeElement === input);
			assert.equal(input.value, originalDraft);
			assert.deepEqual((await pane.captureActiveDraft())?.draft.contexts?.map(context => context.name), ['fixture.txt']);
			assert.equal(fake.turnStartRequests.length, 0);
			await pane.acceptInput();
			assert.deepEqual(fake.turnStartRequests.map(request => request.input), [[{ type: 'context', name: 'fixture.txt', content: 'Synthetic context' }, { type: 'text', text: originalDraft.trim() }]]);
		} finally { resetNlsResolver(); }
	});
}

test('Chat history recovery actions expire across A-B-A selection and pane disposal', async () => {
	const activeSession = session('session-1', 'thread-1');
	const fake = fakeApi({ sessions: [activeSession] });
	const requested: string[] = [];
	const released: string[] = [];
	let pending: DeferredPromise<import('../../../platform/agentHost/common/agentService.js').ThreadSubscription> | undefined;
	using chat = createChatService({
		...fake.api, thread: {
			...fake.api.thread,
			subscribe: async ({ threadId }) => {
				requested.push(threadId);
				if (threadId === 'thread-1') {
					if (pending) return pending.p;
					throw new Error('Synthetic load failure');
				}
				return { ...navigationThreadSnapshot(threadId), updates: [] };
			},
			unsubscribe: async ({ threadId }) => { released.push(threadId); },
		}
	});
	using sessions = new SessionsManagementService(fake.api);
	using model = createWidgetModel(chat, { kind: 'session', active: { session: activeSession, threadId: 'thread-1' } }, sessions);
	await model.initialize();
	const retired = model.historyStatus!;
	await model.selectThread({ session: activeSession, threadId: 'thread-2' });
	await model.selectThread({ session: activeSession, threadId: 'thread-1' });
	await retired.action.run();
	assert.deepEqual(requested, ['thread-1', 'thread-2', 'thread-1']);
	assert.equal(model.historyStatus?.kind, 'history');
	const current = model.historyStatus!;
	pending = new DeferredPromise();
	const retry = current.action.run();
	assert.equal(current.action.run(), retry);
	model.dispose();
	await pending.complete({ ...navigationThreadSnapshot('thread-1'), updates: [] });
	await retry;
	await current.action.run();
	await waitFor(() => released.includes('thread-1'));
	assert.deepEqual(requested, ['thread-1', 'thread-2', 'thread-1', 'thread-1']);
	assert.equal(model.thread, undefined);
});

test('Chat live-update recovery reloads retained content and keeps repeated failures recoverable', async () => {
	const activeSession = session('session-1', 'thread-1');
	const fake = fakeApi({ sessions: [activeSession] });
	let reads = 0;
	using chat = createChatService({
		...fake.api, thread: {
			...fake.api.thread,
			read: async () => {
				if (++reads < 3) throw new Error('Synthetic refresh failure');
				const snapshot = navigationThreadSnapshot('thread-1');
				return { ...snapshot, thread: { ...snapshot.thread, sequence: 2 }, transcript: { ...snapshot.transcript, durableSequence: 2 } };
			},
		}
	});
	using sessions = new SessionsManagementService(fake.api);
	using model = createWidgetModel(chat, { kind: 'session', active: { session: activeSession, threadId: 'thread-1' } }, sessions);
	await model.initialize();
	const retained = model.thread;
	fake.emit({ method: 'session/thread/update', params: { sessionId: 'session-1', threadId: 'thread-1', durableSequence: 2, update: { type: 'committed', event: { type: 'turnFailed', threadId: 'thread-1', turnId: 'turn-1', error: { code: 'modelInvocationFailed', message: 'Synthetic turn failure', retryable: true } } } } });
	await waitFor(() => model.historyStatus?.kind === 'live');
	assert.equal(model.thread?.threadId, retained?.threadId);
	await model.historyStatus!.action.run();
	assert.equal(model.historyStatus?.kind, 'live');
	assert.equal(model.inputState.inputBlocked, true);
	await model.historyStatus!.action.run();
	assert.deepEqual({ reads, status: model.historyStatus, blocked: model.inputState.inputBlocked, phase: model.state, sent: fake.turnStartRequests.length }, { reads: 3, status: undefined, blocked: false, phase: 'ready', sent: 0 });
});

test('Sessions layout is explicit, persists across recreation and starts with full Chat', async () => {
	const fixture = await createNavigationInputPane();
	using resources = fixture.resources;
	const { pane, commands, configuration } = fixture;
	const sidebar = pane.element.querySelector<HTMLElement>('.ash-chat-sessions-sidebar')!;
	assert.equal(sidebar.hidden, true);
	assert.equal(configuration.getValue(AGENT_SESSIONS_ORIENTATION_SETTING), AgentSessionsOrientation.SideBySide);
	await commands.executeCommand('workbench.action.chat.setAgentSessionsOrientationStacked');
	assert.equal(sidebar.hidden, true);
	const snapshot = await configuration.read();
	resources.dispose();
	const reopened = await createNavigationInputPane(snapshot.source);
	using reopenedResources = reopened.resources;
	assert.equal(reopened.configuration.getValue(AGENT_SESSIONS_ORIENTATION_SETTING), AgentSessionsOrientation.Stacked);
	assert.equal(reopened.pane.element.querySelector<HTMLElement>('.ash-chat-sessions-sidebar')?.hidden, true);
	reopened.pane.toggleSessionsSidebar();
	assert.equal(reopened.pane.element.querySelector('.ash-chat-body')?.classList.contains('sessions-stacked'), true);
});

test('Sessions migrates legacy automatic layout once while preserving profile comments and other settings', async () => {
	const source = '{\n // Keep this comment\n "chat.viewSessions.orientation": "auto",\n "editor.wordWrap": "on",\n}';
	const fixture = await createNavigationInputPane(source);
	using resources = fixture.resources;
	const snapshot = await fixture.configuration.read();
	assert.ok(snapshot.source.includes('// Keep this comment'));
	assert.ok(snapshot.source.includes('"editor.wordWrap": "on"'));
	assert.deepEqual(parseJsonDocument(snapshot.source, { allowComments: true, allowTrailingComma: true }).value, { [AGENT_SESSIONS_ORIENTATION_SETTING]: AgentSessionsOrientation.SideBySide, 'editor.wordWrap': 'on' });
	resources.dispose();
	const reopened = await createNavigationInputPane(snapshot.source);
	using reopenedResources = reopened.resources;
	assert.equal((await reopened.configuration.read()).source, snapshot.source);
});

test('Sessions migration yields to a newer explicit preference', async () => {
	let writes = 0;
	using files = new class extends TestConfigurationFiles {
		override async writeFile(...args: Parameters<TestConfigurationFiles['writeFile']>): Promise<never> {
			writes++;
			throw new FileRevisionConflictError(args[0].resource);
		}
	}(`{"${AGENT_SESSIONS_ORIENTATION_SETTING}":"auto"}`);
	const fixture = await createNavigationInputPane(`{"${AGENT_SESSIONS_ORIENTATION_SETTING}":"stacked"}`, files);
	using resources = fixture.resources;
	assert.equal(writes, 1);
	assert.equal(fixture.configuration.getValue(AGENT_SESSIONS_ORIENTATION_SETTING), AgentSessionsOrientation.Stacked);
});

for (const text of ['', 'Private request for A']) {
	for (const aba of [false, true]) {
		test(`composer navigation cancels held file ${text ? 'with text' : 'only'} across ${aba ? 'A-B-A' : 'A-B'} and preserves the new draft`, async () => {
			const fixture = await createNavigationInputPane();
			using resources = fixture.resources;
			const { dom, fake, pane, sessions, chatPane, input } = fixture;
			const reads: (() => void)[] = [];
			const Reader = dom.window.FileReader;
			using globals = installEditorTestGlobals({
				FileReader: class extends Reader {
					override readAsArrayBuffer(blob: Blob): void { reads.push(() => super.readAsArrayBuffer(blob)); }
				}
			});
			const paste = new dom.window.Event('paste', { bubbles: true, cancelable: true });
			Object.defineProperty(paste, 'clipboardData', { value: { files: [new dom.window.File(['Private contents for A'], 'private-A.txt', { type: 'text/plain' })] } });
			input.dispatchEvent(paste);
			assert.equal(paste.defaultPrevented, true);
			await waitFor(() => reads.length === 1);
			const previous = pane.acceptInput(text).then(() => undefined, error => { assert.ok(isCancellationError(error)); });
			sessions.selectThread('session-1', 'thread-2');
			await nextTask();
			if (aba) { sessions.selectThread('session-1', 'thread-1'); await nextTask(); }
			assert.strictEqual(pane.element.querySelector('.ash-chat-pane-host > .ash-chat'), chatPane);
			assert.equal(chatPane.hidden, false);
			const selected = aba ? 'thread-1' : 'thread-2';
			assert.equal(chatPane.dataset.threadId, selected);
			const newDraft = `Current draft for ${selected}`;
			typeChatText(dom.window, input, newDraft);
			for (const read of reads.splice(0)) read();
			await previous;
			assert.equal(fake.turnStartRequests.length, 0);
			assert.equal(input.value, newDraft);
			assert.equal(chatPane.querySelectorAll('.ash-chat-input-attachment-item').length, 0);
			await pane.acceptInput();
			assert.equal(fake.turnStartRequests.length, 1);
			assert.equal(fake.turnStartRequests[0]!.threadId, selected);
			assert.deepEqual(fake.turnStartRequests[0]!.input, [{ type: 'text', text: newDraft }]);
		});
	}
}

test('composer navigation stable A sends held file context exactly once', async () => {
	const fixture = await createNavigationInputPane();
	using resources = fixture.resources;
	const { dom, fake, pane, input, chatPane } = fixture;
	const reads: (() => void)[] = [];
	const Reader = dom.window.FileReader;
	using globals = installEditorTestGlobals({
		FileReader: class extends Reader {
			override readAsArrayBuffer(blob: Blob): void { reads.push(() => super.readAsArrayBuffer(blob)); }
		}
	});
	const paste = new dom.window.Event('paste', { bubbles: true, cancelable: true });
	Object.defineProperty(paste, 'clipboardData', { value: { files: [new dom.window.File(['Stable A contents'], 'stable-A.txt', { type: 'text/plain' })] } });
	input.dispatchEvent(paste);
	await waitFor(() => reads.length === 1);
	const sending = pane.acceptInput('Stable A request');
	assert.equal(fake.turnStartRequests.length, 0);
	for (const read of reads.splice(0)) read();
	await sending;
	assert.equal(fake.turnStartRequests.length, 1);
	assert.equal(fake.turnStartRequests[0]!.threadId, 'thread-1');
	assert.deepEqual(fake.turnStartRequests[0]!.input, [{ type: 'context', name: 'stable-A.txt', content: 'Stable A contents' }, { type: 'text', text: 'Stable A request stable-A.txt' }]);
	assert.equal(input.value, '');
	assert.equal(chatPane.querySelectorAll('.ash-chat-input-attachment-item').length, 0);
});

test('composer navigation keeps the first untitled materialization in the same input lifetime', async () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	using domLifetime = toDisposable(() => dom.window.close());
	using contextView = new BrowserContextViewService(dom.window.document.body);
	const fake = fakeApi({ createSession: session('session-1', undefined, 'First request'), createThread: { session: session('session-1', 'thread-1'), threadId: 'thread-1' } });
	using sessions = new SessionsManagementService(fake.api);
	using chat = createChatService(fake.api);
	using model = createWidgetModel(chat, { kind: 'untitled', session: sessions.createUntitledSession() }, sessions);
	using commands = new CommandService(new InstantiationService());
	const contextMenus = { showContextMenu: () => { } } as unknown as IContextMenuService;
	const services = createInputServices(contextView, chat, undefined, contextMenus);
	using widget = services.createInstance(ChatWidget, dom.window.document.body, 'materialization-fixture', model, () => { }, contextMenus, contextView, commands, unavailableAccessibleViewService, notifications, undefined, undefined, undefined, undefined);
	widget.setVisible(true);
	await model.initialize();
	widget.addContext({ id: 'first-file', kind: 'file', name: 'first.txt', resolve: async () => ({ name: 'first.txt', content: 'First file contents' }) });
	await widget.acceptInput('First request');
	assert.equal(fake.turnStartRequests.length, 1);
	assert.equal(fake.turnStartRequests[0]!.threadId, 'thread-1');
	assert.equal(widget.element.querySelectorAll('.ash-chat-input-attachment-item').length, 0);
	assert.equal(widget.element.querySelector<HTMLTextAreaElement>('.ash-chat-textarea-input')!.value, '');
});

test('composer navigation A-B-A during model initialization cannot dispatch an old A request', async () => {
	const activeSession = { ...session('session-1', 'thread-1'), chats: [{ threadId: 'thread-1', origin: { type: 'root' as const }, status: 'active' as const }, { threadId: 'thread-2', origin: { type: 'fork' as const, parentThreadId: 'thread-1', parentSequence: 1 }, status: 'active' as const }] };
	const fake = fakeApi({ sessions: [activeSession] });
	const initial = new DeferredPromise<void>();
	let subscriptions = 0;
	using chat = createChatService({
		...fake.api, thread: {
			...fake.api.thread, subscribe: async ({ threadId }) => {
				if (++subscriptions === 1) await initial.p;
				return { ...navigationThreadSnapshot(threadId), updates: [] };
			}
		}
	});
	using sessions = new SessionsManagementService(fake.api);
	using model = createWidgetModel(chat, { kind: 'session', active: { session: activeSession, threadId: 'thread-1' } }, sessions);
	await waitFor(() => subscriptions === 1);
	const previous = model.send('Old A request').then(() => undefined, error => { assert.ok(isCancellationError(error)); });
	await model.selectThread({ session: activeSession, threadId: 'thread-2' });
	await model.selectThread({ session: activeSession, threadId: 'thread-1' });
	await initial.complete();
	await previous;
	assert.equal(fake.turnStartRequests.length, 0);
});


for (const aba of [false, true]) {
	test(`composer navigation cancels text-only between input submission and model dispatch across ${aba ? 'A-B-A' : 'A-B'}`, async () => {
		const fixture = await createNavigationInputPane();
		using resources = fixture.resources;
		const { dom, fake, pane, sessions, chatPane, input } = fixture;
		const previous = pane.acceptInput('Private text for A').then(() => undefined, error => { assert.ok(isCancellationError(error)); });
		// Even empty context resolution yields. Navigate before that continuation resumes.
		sessions.selectThread('session-1', 'thread-2');
		if (aba) sessions.selectThread('session-1', 'thread-1');
		typeChatText(dom.window, input, 'Current unsent draft');
		await previous;
		assert.equal(fake.turnStartRequests.length, 0);
		assert.equal(input.value, 'Current unsent draft');
		assert.strictEqual(pane.element.querySelector('.ash-chat-pane-host > .ash-chat'), chatPane);
	});
}

test('composer navigation A-B-A during a pending model save cannot dispatch the old request', async () => {
	const activeSession = { ...session('session-1', 'thread-1'), chats: [{ threadId: 'thread-1', origin: { type: 'root' as const }, status: 'active' as const }, { threadId: 'thread-2', origin: { type: 'fork' as const, parentThreadId: 'thread-1', parentSequence: 1 }, status: 'active' as const }] };
	const selected = { provider: 'openai', model: 'gpt-6.1-sol' };
	const fake = fakeApi({ sessions: [activeSession], models: [{ model: selected, displayName: 'Navigation model' }] });
	const gate = new DeferredPromise<void>();
	const saving = new DeferredPromise<void>();
	using chat = createChatService({
		...fake.api, model: {
			...fake.api.model, configureDefaults: async (update, expectedRevision) => {
				await saving.complete();
				await gate.p;
				return fake.api.model.configureDefaults(update, expectedRevision);
			}
		}, thread: { ...fake.api.thread, read: async ({ threadId }) => navigationThreadSnapshot(threadId), subscribe: async ({ threadId }) => ({ ...navigationThreadSnapshot(threadId), updates: [] }) }
	});
	using sessions = new SessionsManagementService(fake.api);
	using model = createWidgetModel(chat, { kind: 'session', active: { session: activeSession, threadId: 'thread-1' } }, sessions);
	await model.initialize();
	assert.ok(model.inputState.models.some(entry => entry.model.provider === selected.provider && entry.model.model === selected.model));
	const selection = model.selectModel(selected);
	await saving.p;
	const previous = model.send('Old A request').then(() => undefined, error => { assert.ok(isCancellationError(error)); });
	await model.selectThread({ session: activeSession, threadId: 'thread-2' });
	await model.selectThread({ session: activeSession, threadId: 'thread-1' });
	await gate.complete();
	await selection;
	await previous;
	assert.equal(fake.turnStartRequests.length, 0);
});


for (const aba of [false, true]) {
	test(`composer navigation old dispatched failure cannot alter the next pending send across ${aba ? 'A-B-A' : 'A-B'}`, async () => {
		const fixture = await createNavigationInputPane();
		using resources = fixture.resources;
		const { dom, fake, pane, sessions, chatPane, input } = fixture;
		const oldReply = new DeferredPromise<void>();
		const nextReply = new DeferredPromise<void>();
		const oldDispatched = new DeferredPromise<void>();
		const nextDispatched = new DeferredPromise<void>();
		const start = fake.api.turn.start;
		let requests = 0;
		fake.api.turn.start = async params => {
			const result = await start(params);
			if (++requests === 1) { await oldDispatched.complete(); await oldReply.p; }
			else { await nextDispatched.complete(); await nextReply.p; }
			return result;
		};
		const previous = assert.rejects(pane.acceptInput('Already dispatched A'), /Old request failed/u);
		await oldDispatched.p;
		sessions.selectThread('session-1', 'thread-2');
		await nextTask();
		if (aba) { sessions.selectThread('session-1', 'thread-1'); await nextTask(); }
		const next = pane.acceptInput('Next request');
		try {
			await nextDispatched.p;
			typeChatText(dom.window, input, 'Keep my later draft');
			await oldReply.error(new Error('Old request failed'));
			await previous;
			assert.equal(chatPane.querySelector('.ash-chat-status, .ash-chat-status-summary')!.textContent, 'Working…');
			assert.equal(input.value, 'Keep my later draft');
			await pane.acceptInput();
			assert.equal(fake.turnStartRequests.length, 2);
			assert.equal(fake.turnStartRequests[1]!.threadId, aba ? 'thread-1' : 'thread-2');
		} finally {
			await oldReply.error(new Error('Old request failed'));
			await nextReply.complete();
			await Promise.all([previous, next]);
		}
		assert.equal(input.value, 'Keep my later draft');
	});
}

for (const navigate of [false, true]) {
	test(`first materialization adopts its initiating pane after early catalog notification${navigate ? ' unless the user chose the durable pane' : ''}`, async () => {
		const resources = new DisposableStore();
		using lifetime = resources;
		const dom = new JSDOM('<!doctype html><body></body>');
		resources.add(toDisposable(() => dom.window.close()));
		const contextView = resources.add(new BrowserContextViewService(dom.window.document.body));
		const created = session('session-1', 'thread-1', 'Early created Session');
		const fake = fakeApi({ sessions: [], createSession: created });
		const reply = new DeferredPromise<void>();
		const create = fake.api.session.create;
		fake.api.session.create = async params => {
			const result = await create(params);
			fake.emit({ method: 'session/changed', params: { sessionId: created.sessionId, agentTreeChanged: false } });
			await reply.p;
			return result;
		};
		fake.api.session.readCatalog = async () => ({ session: sessionDto(created) });
		fake.api.thread.read = async ({ threadId }) => navigationThreadSnapshot(threadId);
		fake.api.thread.subscribe = async ({ threadId }) => ({ ...navigationThreadSnapshot(threadId), updates: [] });
		const sessions = resources.add(new SessionsManagementService(fake.api));
		await sessions.initialize();
		const contextKeys = resources.add(new ContextKeyService());
		resources.add(new ViewDescriptorService({ registry: new WorkbenchViewRegistry() }, contextKeys));
		const commands = resources.add(new CommandService(resources.add(new InstantiationService())));
		const menu = new MenuService(commands, contextKeys);
		const contextMenus = { showContextMenu: () => { } } as unknown as IContextMenuService;
		const chat = resources.add(createChatService(fake.api));
		const pane = resources.add(new ChatViewPane(dom.window.document.body, { id: CHAT_VIEW_ID, title: 'Chat' }, chat, sessions,
			menu, contextMenus, contextView, commands, testLayoutService(), unavailableFileService, unavailableAccessibleViewService, notifications,
			createInputServices(contextView, chat, menu, contextMenus), inputResources.add(new WorkbenchConfigurationService()), inputResources.add(createTestStorage()), userDataProfile));
		dom.window.document.body.append(pane.element);
		await nextTask();
		const original = pane.element.querySelector<HTMLElement>('.ash-chat-pane-host > .ash-chat')!;
		assert.ok(original);
		let contextResolutions = 0;
		typeChatText(dom.window, original.querySelector<HTMLTextAreaElement>('textarea')!, 'Original first request');
		pane.addContext({ id: 'original-file', kind: 'file', name: 'original.txt', resolve: async () => { contextResolutions++; return { name: 'original.txt', content: 'Original request context' }; } });
		const sending = pane.acceptInput().then(() => undefined, error => {
			if (!navigate) throw error;
			assert.ok(isCancellationError(error));
		});
		await waitFor(() => pane.element.querySelectorAll('.ash-chat-pane-host > .ash-chat').length === 2);
		let target = original;
		if (navigate) {
			sessions.selectThread(created.sessionId, 'thread-1');
			await nextTask();
			target = pane.element.querySelector<HTMLElement>('.ash-chat-pane-host > .ash-chat:not([hidden])')!;
			assert.notStrictEqual(target, original);
			const input = target.querySelector<HTMLTextAreaElement>('.ash-chat-textarea-input')!;
			input.value = 'Keep my chosen durable draft';
			input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
		}
		await reply.complete();
		await sending;
		await nextTask();
		assert.strictEqual(pane.element.querySelector('.ash-chat-pane-host > .ash-chat:not([hidden])'), target);
		assert.equal(target.hidden, false);
		if (navigate) {
			assert.equal(fake.turnStartRequests.length, 0);
			assert.equal(target.querySelector<HTMLTextAreaElement>('.ash-chat-textarea-input')!.value, 'Keep my chosen durable draft');
		} else {
			assert.equal(fake.turnStartRequests.length, 1);
			assert.equal(fake.turnStartRequests[0]!.threadId, 'thread-1');
			assert.equal(contextResolutions, 1);
			assert.deepEqual(fake.turnStartRequests[0]!.input, [
				{ type: 'context', name: 'original.txt', content: 'Original request context' },
				{ type: 'text', text: 'Original first request original.txt' },
			]);
			assert.equal(original.querySelectorAll('.ash-chat-input-attachment-item').length, 0);
		}
	});
}


test('Cowork consumes rich tool evidence from its actual scoped transcript and cancels superseded input', async () => {
	const base = thread('Existing answer');
	const turn = base.turns[0]!;
	const durable = session('session-1', 'thread-1');
	let current: Thread = {
		...base, turns: [
			{
				...turn, turnId: 'first', items: [
					{ type: 'toolCall', itemId: 'call-first', turnId: 'first', toolCallId: 'reused', name: 'shell', argumentsJson: '{}' },
					{ type: 'toolResult', itemId: 'result-first', turnId: 'first', toolCallId: 'reused', text: 'first result', isError: false, content: [{ type: 'imageAttachment', detail: 'auto', attachment: { contentDigest: 'sha256:image', mediaType: 'png', encodedBytes: 4, width: 2, height: 1 } }] },
				]
			},
			{ ...turn, turnId: 'second', items: [{ type: 'toolCall', itemId: 'call-second', turnId: 'second', toolCallId: 'reused', name: 'shell', argumentsJson: '{}' }] },
		]
	};
	const fake = fakeApi({ sessions: [durable], thread: () => current });
	using chat = createChatService(fake.api);
	using sessions = new SessionsManagementService(fake.api);
	using contextView = new BrowserContextViewService(document.body);
	using services = createInputServices(contextView, chat);
	using preferences = services.createInstance(CoworkModelPreferencesService, CoworkModelPreferences);
	services.registerInstance(ICoworkModelPreferences, preferences);
	using model = services.createInstance(CoworkWidgetModel, chat, { kind: 'session', active: { session: durable, threadId: 'thread-1' } }, sessions);
	await model.initialize();
	assert.equal(model.items.length, 2);
	assert.equal(model.items[0]!.toolInvocation?.result?.itemId, 'result-first');
	assert.deepEqual(model.items[0]!.attachmentSource, { sessionId: 'session-1', threadId: 'thread-1', itemId: 'result-first', kind: 'toolResult' });
	assert.equal(model.items[0]!.toolInvocation?.result?.content?.[0]?.type, 'imageAttachment');
	assert.equal(model.items[1]!.toolInvocation?.result, undefined);
	assert.equal(model.items[1]!.toolInvocation?.stopped, true);
	let changes = 0;
	using listener = model.onDidChangeComposer(() => changes++);
	const generation = model.composerGeneration;
	const sending = model.send('Old source request', 'agent');
	const rejected = assert.rejects(sending, isCancellationError);
	current = { ...current, threadId: 'child' };
	await model.selectThread({ session: durable, threadId: 'child' });
	await rejected;
	assert.equal(changes, 1);
	assert.equal(model.composerGeneration, generation + 1);
	assert.equal(fake.turnStartRequests.length, 0);
	await model.selectThread({ session: durable, threadId: 'child' });
	assert.equal(changes, 1);
});


test('The original draft codec preserves terminal snapshots and rejects malformed stored geometry', () => {
	using storage = createTestStorage();
	const draft = { mode: 'agent' as const, text: 'Check this output', contexts: [{ id: 'terminal:saved', kind: 'terminal', name: 'Saved terminal', content: 'Context', resource: 'internal://terminal?id=saved', terminalSnapshot: { text: 'Saved output', columns: 80 } }] };
	writeNewChatDraftState(storage, draft, 'thread');
	assert.deepEqual(readNewChatDraftState(storage, 'thread'), draft);
	storage.store('sessions.inputDraft:thread', JSON.stringify({ ...draft, contexts: [{ ...draft.contexts[0], terminalSnapshot: { text: 'Saved output', columns: 0 } }] }), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	assert.throws(() => readNewChatDraftState(storage, 'thread'), /Invalid terminal snapshot/);
});

for (const locale of ['en', 'zh-CN']) {
	test(`AI preference blocks Chat input without losing its draft or contexts in ${locale}`, async () => {
		initializeTestLocalization(locale);
		try {
			const fixture = await createNavigationInputPane();
			using resources = fixture.resources;
			const { configuration, input, pane, fake, dom, chatPane } = fixture;
			typeChatText(dom.window, input, 'Keep this AI-disabled draft');
			pane.addContext({ id: 'ai-file', kind: 'file', name: 'fixture.txt', resolve: async () => ({ name: 'fixture.txt', content: 'Synthetic context' }) });
			const originalDraft = input.value;
			await configuration.updateValue(ChatAIDisabledSettingId, true);
			assert.match(chatPane.querySelector('.ash-chat-status, .ash-chat-status-summary')!.textContent!, locale === 'en' ? /AI features are disabled/u : /AI 功能已禁用/u);
			await pane.acceptInput();
			assert.equal(fake.turnStartRequests.length, 0);
			assert.equal(input.value, originalDraft);
			assert.deepEqual((await pane.captureActiveDraft())?.draft.contexts?.map(context => context.name), ['fixture.txt']);
			await configuration.updateValue(ChatAIDisabledSettingId, false);
			await pane.acceptInput();
			assert.equal(fake.turnStartRequests.length, 1);
			assert.deepEqual(fake.turnStartRequests[0]!.input, [{ type: 'context', name: 'fixture.txt', content: 'Synthetic context' }, { type: 'text', text: originalDraft.trim() }]);
		} finally { resetNlsResolver(); }
	});
}

test('AI preference blocks direct dispatch, including a pending permission read, while history and interrupt remain usable', async () => {
	const fake = fakeApi();
	using configuration = new WorkbenchConfigurationService();
	using services = new InstantiationService();
	registerChatBackend(services, fake.api, IAgentExecutionSettingsService, configuration);
	const permission = new DeferredPromise<Awaited<ReturnType<IAgentExecutionSettingsService['read']>>>();
	services.registerInstance(IAgentExecutionSettingsService, { onDidChange: Event.None, configure: async () => { }, read: () => permission.p });
	using chat = services.createInstance(ChatService);
	const options = { sessionId: 'session-1', threadId: 'thread-1', expectedSequence: 1, text: 'Synthetic request', mode: 'agent' as const };
	const pending = chat.queueTurn(options);
	const rejected = assert.rejects(pending, /AI features are disabled/);
	await configuration.updateValue(ChatAIDisabledSettingId, true);
	await permission.complete({ revision: 1, settings: { approvalMode: 'manual', commandFileAccess: 'readOnly', commandNetworkAccess: 'denied' } });
	await rejected;
	for (const request of [
		() => chat.startTurn(options), () => chat.queueTurn(options), () => chat.steerTurn({ ...options, turnId: 'turn-1' }),
		() => chat.consultAdvisor({ ...options, question: 'Synthetic question' }), () => chat.compactContext(options),
		() => chat.generateTurnChangeMessage('session-1', 'thread-1', 'change-1', 1),
	]) await assert.rejects(request(), /AI features are disabled/);
	assert.equal(fake.turnStartRequests.length + fake.queuedRequests.length + fake.turnSteerRequests.length + fake.consultRequests.length + fake.turnCompactRequests.length, 0);
	await chat.readThread('session-1', 'thread-1');
	await chat.interruptTurn({ ...options, turnId: 'turn-1' });
	await configuration.updateValue(ChatAIDisabledSettingId, false);
	await chat.startTurn(options);
	assert.equal(fake.turnStartRequests.length, 1);
});

test('AI preference prevents an Untitled Chat from materializing and follows JSONC reload without changing execution defaults', async () => {
	const fake = fakeApi({ createSession: session('created', 'created-thread'), thread: () => ({ ...thread(), threadId: 'created-thread' }) });
	using configuration = new WorkbenchConfigurationService({ source: '{\n // Keep this comment\n "chat.disableAIFeatures": true,\n "chat.input.fontSize": 17,\n}' });
	using chat = createChatService(fake.api, configuration);
	using sessions = new SessionsManagementService(fake.api);
	using model = createWidgetModel(chat, { kind: 'untitled', session: sessions.createUntitledSession() }, sessions);
	await model.initialize();
	assert.equal(model.inputState.aiDisabled, true);
	await assert.rejects(model.send('Preserved draft'), /AI features are disabled/);
	await assert.rejects(model.prepareConversation(), /AI features are disabled/);
	assert.equal(fake.createSessionRequests.length, 0);
	await assert.rejects(configuration.updateValue(ChatAIDisabledSettingId, 'true'), /boolean/);
	assert.equal(model.inputState.aiDisabled, true);
	const saved = await configuration.read();
	await configuration.write(saved.source.replace('true', 'false'), saved.revision);
	assert.equal(model.inputState.aiDisabled, false);
	assert.equal(configuration.getValue('chat.input.fontSize'), 17);
	assert.match((await configuration.read()).source, /Keep this comment/);
	assert.equal(model.inputState.approvalMode, 'manual');
	await model.send('Preserved draft');
	assert.equal(fake.createSessionRequests.length, 1);
	assert.equal(fake.turnStartRequests.length, 1);
});

test('Chat configuration contribution hides the registered Code view and commands and releases its listener', async () => {
	using configuration = new WorkbenchConfigurationService();
	using contexts = new ContextKeyService();
	using services = new InstantiationService();
	services.registerInstance(IConfigurationService, configuration);
	services.registerInstance(IContextKeyService, contexts);
	using descriptors = new ViewDescriptorService({}, contexts);
	const view = descriptors.getViewContainerModel(CHAT_VIEW_CONTAINER_ID);
	const host = WorkbenchContributionsRegistry.createHost(services, error => { throw error; }, ['workbench.contrib.chatEnablement']);
	try {
		host.advance(WorkbenchPhase.BlockStartup);
		assert.equal(contexts.getValue(ChatContextKeys.enabled.key), true);
		assert.equal(view.activeViewDescriptors.some(view => view.id === CHAT_VIEW_ID), true);
		await configuration.updateValue(ChatAIDisabledSettingId, true);
		assert.equal(view.activeViewDescriptors.length, 0);
		using commands = new CommandService(services);
		assert.equal(await commands.executeCommand(NEW_CHAT_COMMAND_ID), false, 'Disabled direct calls need no Session service and cannot create a draft');
		await configuration.updateValue(ChatAIDisabledSettingId, false);
		assert.equal(view.activeViewDescriptors.some(view => view.id === CHAT_VIEW_ID), true);
	} finally { host.dispose(); }
	assert.equal(contexts.getValue(ChatContextKeys.enabled.key), false);
	await configuration.updateValue(ChatAIDisabledSettingId, true);
	await configuration.updateValue(ChatAIDisabledSettingId, false);
	assert.equal(contexts.getValue(ChatContextKeys.enabled.key), false, 'Disposed contribution no longer mirrors settings');
});

for (const kind of ['Chat', 'Cowork']) {
	test(`${kind} model observes the canonical AI preference before materializing an untitled conversation`, async () => {
		const fake = fakeApi({ createSession: session('created', 'created-thread'), thread: () => ({ ...thread(), threadId: 'created-thread' }) });
		using configuration = new WorkbenchConfigurationService();
		using chat = createChatService(fake.api, configuration);
		const submissions: { sessionId: string; threadId: string; isNewSession: boolean; requestSequence: number; }[] = [];
		using submitted = chat.onDidSubmitRequest(event => submissions.push(event));
		using sessions = new SessionsManagementService(fake.api);
		using services = new InstantiationService();
		services.registerSingleton(IPromptsService, () => services.createInstance(PromptsService));
		services.registerInstance(IAppServerHookApi, { onDidChangeHooks: Event.None, list: async () => [] });
		services.registerInstance(IAppServerSkillApi, fake.api.skills);
		services.registerInstance(ILanguageModelsService, modelsFor(chat));
		services.registerInstance(IAgentExecutionSettingsService, { onDidChange: Event.None, read: async () => ({ revision: 1, settings: { approvalMode: 'manual', commandFileAccess: 'readOnly', commandNetworkAccess: 'denied' } }), configure: async () => { } });
		services.registerInstance(IConfigurationService, configuration);
		using storage = createTestStorage();
		services.registerInstance(IStorageService, storage);
		using preferences = services.createInstance(CoworkModelPreferencesService, CoworkModelPreferences);
		services.registerInstance(ICoworkModelPreferences, preferences);
		const selection = { kind: 'untitled' as const, session: sessions.createUntitledSession() };
		using model = kind === 'Chat' ? services.createInstance(ChatWidgetModel, chat, selection, sessions) : services.createInstance(CoworkWidgetModel, chat, selection, sessions);
		await model.initialize();
		await configuration.updateValue(ChatAIDisabledSettingId, true);
		assert.equal(model.inputState.aiDisabled, true);
		assert.equal(model.inputState.inputBlocked, true);
		await assert.rejects(model.prepareConversation(), /AI features are disabled/);
		await assert.rejects(model.send('Synthetic draft'), /AI features are disabled/);
		await assert.rejects(model.executeServerCommand('compact', ''), /AI features are disabled/);
		assert.equal(fake.createSessionRequests.length, 0);
		assert.deepEqual(submissions, []);
		await configuration.updateValue(ChatAIDisabledSettingId, false);
		assert.equal(model.inputState.inputBlocked, false);
		await model.send('Synthetic draft');
		assert.equal(fake.createSessionRequests.length, 1);
		assert.equal(fake.turnStartRequests.length, 1);
		assert.deepEqual(submissions, [{ sessionId: 'created', threadId: 'created-thread', isNewSession: true, requestSequence: 1 }]);
	});
}

test('Chat accepted-request notifications follow backend success and exclude rejected or retired dispatches', async () => {
	const fake = fakeApi();
	const accepted = new DeferredPromise<Awaited<ReturnType<typeof fake.api.turn.start>>>();
	let reject = false;
	using chat = createChatService({ ...fake.api, turn: { ...fake.api.turn, start: async () => { if (reject) throw new Error('Controlled rejected submission'); return accepted.p; } } });
	const submissions: { sessionId: string; threadId: string; isNewSession: boolean; requestSequence: number; }[] = [];
	using listener = chat.onDidSubmitRequest(event => submissions.push(event));
	const options = { sessionId: 'session-1', threadId: 'thread-1', expectedSequence: 1, text: 'Synthetic request', mode: 'agent' as const, isNewSession: true };
	const starting = chat.startTurn(options);
	assert.equal(submissions.length, 0);
	await accepted.complete({ turnId: 'turn-1', sequence: 2 });
	await starting;
	await chat.queueTurn(options);
	await chat.steerTurn({ ...options, turnId: 'turn-1' });
	assert.deepEqual([...submissions], [
		{ sessionId: 'session-1', threadId: 'thread-1', isNewSession: true, requestSequence: 1 },
		{ sessionId: 'session-1', threadId: 'thread-1', isNewSession: false, requestSequence: 1 },
		{ sessionId: 'session-1', threadId: 'thread-1', isNewSession: false, requestSequence: 1 },
	]);
	reject = true;
	await assert.rejects(chat.startTurn(options), /Controlled rejected submission/);
	await chat.consultAdvisor({ ...options, question: 'Synthetic consultation' });
	assert.deepEqual(submissions.at(-1), { sessionId: 'session-1', threadId: 'thread-1', isNewSession: true, requestSequence: 1 });
	assert.equal(submissions.length, 4);
	const retiring = new DeferredPromise<Awaited<ReturnType<typeof fake.api.turn.start>>>();
	using retired = createChatService({ ...fake.api, turn: { ...fake.api.turn, start: () => retiring.p } });
	using retiredListener = retired.onDidSubmitRequest(event => submissions.push(event));
	const pending = retired.startTurn(options);
	fake.emitReady();
	await retiring.complete({ turnId: 'old-turn', sequence: 2 });
	await pending;
	assert.equal(submissions.length, 4);
});
