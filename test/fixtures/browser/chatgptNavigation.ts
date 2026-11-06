import './chatFixtureLocalization.js';
import '../../../src/ash/sessions/contrib/sessions/browser/views/sessionsViewActions.js';
import { ILifecycleService } from '../../../src/ash/workbench/services/lifecycle/common/lifecycle.js';
import { ProjectsEditorPane } from '../../../src/ash/sessions/contrib/projects/browser/projectsEditor.js';
import { IProjectsService, ProjectsService } from '../../../src/ash/sessions/contrib/projects/browser/projectsService.js';
import { ISessionsTitlebarService } from '../../../src/ash/sessions/browser/parts/titlebarPart.js';
import { IProjectService } from '../../../src/ash/platform/projects/common/projectService.js';
import { IFileDialogService } from '../../../src/ash/platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../src/ash/platform/files/common/files.js';
import { URI } from '../../../src/ash/base/common/uri.js';
import { IChatResponseResourceFileSystemProvider } from '../../../src/ash/workbench/contrib/chat/common/widget/chatResponseResourceFileSystemProvider.js';
import { IChatSlashCommandService } from '../../../src/ash/workbench/contrib/chat/common/participants/chatSlashCommands.js';
import { IActionViewItemService } from '../../../src/ash/platform/actions/browser/actionViewItemService.js';
import { IChatPasteTargetService, IChatWidgetService } from '../../../src/ash/workbench/contrib/chat/browser/chat.js';
import { ChatContextKeys } from '../../../src/ash/workbench/contrib/chat/common/actions/chatContextKeys.js';
import { ChatTimelineStorage } from '../../../src/ash/sessions/browser/chatTimelineStorage.js';
import { ISessionPrimaryProviderServices, ISessionProviderScopeService, type SessionProviderServices } from '../../../src/ash/sessions/browser/agentHost/sessionProviderScopeService.js';
import { IChatSpeechToTextService, ChatSpeechToTextService } from '../../../src/ash/workbench/contrib/chat/browser/speechToText/chatSpeechToTextService.js';
import { Disposable, DisposableStore, toDisposable } from '../../../src/ash/base/common/lifecycle.js';
import { autorun } from '../../../src/ash/base/common/observable.js';
import { VSBuffer } from '../../../src/ash/base/common/buffer.js';
import { Registry } from '../../../src/ash/platform/registry/common/platform.js';
import { Extensions as ConfigurationExtensions, type IConfigurationRegistry } from '../../../src/ash/platform/configuration/common/configurationRegistry.js';
import { IConfigurationService } from '../../../src/ash/platform/configuration/common/configuration.js';
import { InMemoryConfigurationService } from '../../../src/ash/platform/configuration/common/inMemoryConfigurationService.js';
import { IContextKeyService, ContextKeyService } from '../../../src/ash/platform/contextkey/browser/contextKeyService.js';
import { InstantiationService } from '../../../src/ash/platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../src/ash/platform/instantiation/common/serviceCollection.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../src/ash/platform/storage/common/storage.js';
import { BrowserStorageService } from '../../../src/ash/workbench/services/storage/browser/storageService.js';
import { IOpenerService } from '../../../src/ash/platform/opener/common/opener.js';
import { IEditorService } from '../../../src/ash/workbench/services/editor/common/editorService.js';
import { CommandsRegistry, ICommandService } from '../../../src/ash/platform/commands/common/commands.js';
import { ChatGPTService, IChatGPTService } from '../../../src/ash/sessions/contrib/chatgptweb/browser/chatGPTService.js';
import { ChatGPTList } from '../../../src/ash/sessions/contrib/chatgptweb/electron-browser/chatGPTList.js';
import { ASH_CHAT_SELECTED_CONTEXT, CHAT_WORKSPACE_NAVIGATION_ID, SHOW_ASH_CHAT_COMMAND } from '../../../src/ash/sessions/contrib/chat/common/constants.js';
import { registerChatWorkspaceNavigation } from '../../../src/ash/sessions/contrib/chat/electron-browser/chatWorkspace.contribution.js';
import { PaneComposite } from '../../../src/ash/workbench/browser/panecomposite.js';
import { IChatListCatalog, type ChatListSource } from '../../../src/ash/sessions/contrib/chat/browser/chatListModel.js';
import { ISessionsListModelService, SessionsListModelService } from '../../../src/ash/sessions/services/sessions/browser/sessionsListModelService.js';
import { ReplyChatEditor } from '../../../src/ash/sessions/contrib/chat/browser/replyChatEditor.js';
import { chatGPTReplyEditor } from '../../../src/ash/sessions/contrib/chatgptweb/electron-browser/chatGPTWeb.js';
import { getSingletonServiceDescriptors } from '../../../src/ash/platform/instantiation/common/extensions.js';
import { IAccessibleViewService } from '../../../src/ash/platform/accessibility/browser/accessibleView.js';
import { IAgentVoiceService } from '../../../src/ash/platform/agentHost/common/agentService.js';
import { IVoiceModeOnboardingService } from '../../../src/ash/workbench/contrib/agentsVoice/browser/voiceModeOnboarding.js';
import { INotificationService } from '../../../src/ash/platform/notification/common/notification.js';
import { IMenuService } from '../../../src/ash/platform/actions/common/actions.js';
import { IChatContextService } from '../../../src/ash/workbench/contrib/chat/browser/contextContrib/chatContextService.js';
import { ChatAttachmentResolveService, IChatAttachmentResolveService } from '../../../src/ash/workbench/contrib/chat/browser/attachments/chatAttachmentResolveService.js';
import { IImageEditorService } from '../../../src/ash/workbench/services/imageEditor/common/imageEditorService.js';
import { createDisconnectedAgentHostInputCompletionService } from '../../../src/ash/platform/agentHost/browser/appServerAgentService.js';
import { IAgentHostInputCompletionService } from '../../../src/ash/platform/agentHost/common/agentService.js';
import { IMessageHistoryService } from '../../../src/ash/platform/messageHistory/common/messageHistory.js';
import '../../../src/ash/workbench/contrib/chat/browser/chat.shared.contribution.js';
import { IChatGPTTransport } from '../../../src/ash/sessions/contrib/chatgptweb/common/chatGPTTransport.js';
import { registerTestComponentServices } from '../../../src/ash/workbench/test/common/testEditorServices.js';
import { IExtensionHostApi } from '../../../src/ash/platform/extensions/common/extensionHostApi.js';
import { createDisconnectedExtensionHostApi } from '../../../src/ash/platform/extensions/browser/extensionHostApi.js';
import { normalizeExtensionHostSnapshot } from '../../../src/ash/platform/extensions/browser/extensionHostProtocol.js';
import { IAgentThreadService } from '../../../src/ash/platform/agentHost/common/agentService.js';
import { bindTestColorTheme } from './themeFixture.js';
import '../../../src/ash/workbench/browser/style.js';
import '../../../src/ash/sessions/browser/media/workbench.css';
import '../../../src/ash/sessions/browser/media/style.css';
import '../../../src/ash/sessions/browser/parts/activitybar/media/activityBarPart.css';
import { IThemeService } from '../../../src/ash/platform/theme/common/themeService.js';
import { TestThemeService } from '../../../src/ash/platform/theme/test/common/testThemeService.js';
import { darkColorTheme, lightColorTheme, highContrastDarkColorTheme, highContrastLightColorTheme } from '../../../src/ash/platform/theme/common/colorTheme.js';
import { IContextMenuService, IContextViewService } from '../../../src/ash/platform/contextview/browser/contextView.js';
import { BrowserContextViewService } from '../../../src/ash/platform/contextview/browser/contextViewService.js';
import { registerCodeEditorServices } from '../../../src/ash/editor/test/browser/testCodeEditor.js';
import { SessionsViewRegistry } from '../../../src/ash/sessions/common/views.js';
import { ViewDescriptorService } from '../../../src/ash/workbench/services/views/browser/viewDescriptorService.js';
import { Event } from '../../../src/ash/base/common/event.js';
import { AshChatNavigationSource } from '../../../src/ash/sessions/contrib/chat/browser/ashChatNavigationSource.js';
import { AshChatSelectionService, IAshChatSelectionService } from '../../../src/ash/sessions/contrib/chat/browser/ashChatSelectionService.js';
import { ISessionsSearchService } from '../../../src/ash/sessions/contrib/search/browser/searchService.js';
import { ISessionsManagementService } from '../../../src/ash/sessions/services/sessions/common/sessionsManagement.js';
import { ISessionGroupsService } from '../../../src/ash/sessions/services/sessions/browser/sessionGroupsService.js';
import { IVoiceCodeTranscriptionBackendService } from '../../../src/ash/platform/dictation/common/dictation.js';
import { ISpeechService } from '../../../src/ash/workbench/contrib/speech/common/speechService.js';
import { SpeechService } from '../../../src/ash/workbench/contrib/speech/browser/speechService.js';
import { registerTestDictationOnboarding, createTestDictationBackend, installTestDictationAudio, type TestDictationCapture } from '../../../src/ash/workbench/test/common/testDictationServices.js';
import { IPreferencesService } from '../../../src/ash/workbench/services/preferences/common/preferences.js';
import { IChatService } from '../../../src/ash/workbench/services/chat/common/chatService.js';
import { IChatSessionNavigationService } from '../../../src/ash/workbench/services/chat/common/chatSessionNavigationService.js';
import { ILanguageModelsService } from '../../../src/ash/workbench/contrib/chat/common/languageModels.js';

import { BrowserContextMenuService } from '../../../src/ash/platform/contextview/browser/contextMenuService.js';
import { MenuService } from '../../../src/ash/platform/actions/common/menuService.js';
import { CommandService } from '../../../src/ash/workbench/services/commands/common/commandService.js';
import { IKeybindingService } from '../../../src/ash/platform/keybinding/common/keybinding.js';
import { TestNotificationService } from './notificationFixture.js';
import { IQuickInputService } from '../../../src/ash/platform/quickinput/common/quickInput.js';
import { TestQuickInputService } from '../../../src/ash/platform/quickinput/test/browser/testQuickInputService.js';
import { IDialogService } from '../../../src/ash/platform/dialogs/common/dialogs.js';
import { BrowserDialogHandler } from '../../../src/ash/workbench/browser/parts/dialogs/dialog.js';
import { DialogHandlerContribution } from '../../../src/ash/workbench/browser/parts/dialogs/dialog.web.contribution.js';
import { DialogService } from '../../../src/ash/workbench/services/dialogs/common/dialogService.js';
import { IClipboardService } from '../../../src/ash/platform/clipboard/common/clipboardService.js';
import { AccessibilitySupport, IAccessibilityService } from '../../../src/ash/platform/accessibility/common/accessibility.js';
import '../../../src/ash/sessions/contrib/chat/browser/chat.contribution.js';

declare global {
	interface Window { ashChatGPTIntegration: { newChat(): void; draft(): string; storageKeys(): readonly string[]; dictate(text: string, final: boolean): void; dictationStops(): number; setVisible(visible: boolean): void; setAshChatSelected(selected: boolean): void; setConfiguration(key: string, value: unknown): Promise<void>; setMathEnabled(enabled: boolean): Promise<void>; setMathMacros(macros: Record<string, string>): Promise<void>; }; }
}

const parameters = new URLSearchParams(location.search);
// The renderer widgets consume the containing Sessions host's visual defaults.
document.body.classList.add('ash-workbench');
const sessionsRoot = document.createElement('div');
sessionsRoot.className = 'ash-sessions-window';
sessionsRoot.style.flexDirection = 'row';
sessionsRoot.append(document.getElementById('navigation')!, document.getElementById('editor')!);
document.body.append(sessionsRoot);
const resources = new DisposableStore();
if (parameters.has('dictation')) resources.add(installTestDictationAudio(window));
const themes = { light: lightColorTheme, dark: darkColorTheme, hcDark: highContrastDarkColorTheme, hcLight: highContrastLightColorTheme };
const theme = resources.add(new TestThemeService(themes[(parameters.get('theme') ?? 'dark') as keyof typeof themes]));
const requests = new Map<string, { controller: AbortController; reader?: ReadableStreamDefaultReader<Uint8Array>; }>();
const storage = resources.add(new BrowserStorageService({ ownerWindow: window, workspaceId: parameters.get('workspace') ?? 'chatgpt-navigation-fixture', profileId: 'chatgpt-navigation-fixture' }));
if (parameters.has('workRow')) {
	const timeline = new ChatTimelineStorage(storage, 'chatgpt-web');
	if (!timeline.read('local:fixture-work')) {
		timeline.write('local:fixture-work', { localId: 'fixture-work', title: 'Synthetic Work', tasks: [] });
	}
}
if (parameters.has('legacyCollapsed')) {
	for (const key of ['recent', 'projects', 'g-p-unloaded']) { storage.store(`sessions.chatgpt.navigation.collapsed.${key}`, true, StorageScope.PROFILE, StorageTarget.MACHINE); }
}
let widget: ReplyChatEditor;
let transcript: ((text: string, final: boolean) => void) | undefined;
let dictationStops = 0;
const dictation: TestDictationCapture | undefined = parameters.has('dictation') ? {
	getOptions: async () => ({ inputDevices: [], languages: [] }),
	start: async (_options, onTranscript, onEnded) => {
		let finalText = 'final words';
		transcript = (text, final) => { if (final) finalText = text; onTranscript(text, final); };
		return { stop: async () => { dictationStops++; onTranscript(finalText, true); onEnded(); }, cancel: async () => { dictationStops++; onEnded(); } };
	},
} : undefined;
const configurationRegistry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);
configurationRegistry.registerConfiguration({ key: 'markdown.math.enabled', defaultValue: true, parse: value => Boolean(value) });
configurationRegistry.registerConfiguration({ key: 'markdown.math.macros', defaultValue: {}, parse: value => value });
const configuration = resources.add(new InMemoryConfigurationService());
if (dictation) await configuration.updateValue('dictation.backend', 'cloud');
const services = resources.add(new InstantiationService(new ServiceCollection(
	...getSingletonServiceDescriptors().filter(([id]) =>
		id === IChatWidgetService || id === IActionViewItemService || id === IChatSlashCommandService
		|| id === IChatPasteTargetService || id === IChatResponseResourceFileSystemProvider),
	[IAgentVoiceService, undefined],
	[IMessageHistoryService, undefined],
	[IVoiceModeOnboardingService, { showIfNeeded() { }, registerHost: () => toDisposable(() => { }) } as unknown as IVoiceModeOnboardingService],
	[IAccessibleViewService, { getOpenAriaHint: () => undefined } as unknown as IAccessibleViewService],
	[INotificationService, resources.add(new TestNotificationService())],
	[IImageEditorService, {} as IImageEditorService],
	[IAgentHostInputCompletionService, createDisconnectedAgentHostInputCompletionService()],
	[IChatGPTTransport, {
		async getCacheScope() { return 'a'.repeat(64); },
		async request(id, request) {
			const controller = new AbortController();
			const pending = { controller, reader: undefined as ReadableStreamDefaultReader<Uint8Array> | undefined };
			requests.set(id, pending);
			const response = await fetch(request.path, { method: request.method, headers: request.headers, body: request.body instanceof VSBuffer ? new Uint8Array(request.body.buffer) : request.body, signal: controller.signal });
			pending.reader = response.body?.getReader();
			return { status: response.status, headers: Object.fromEntries(response.headers) };
		},
		async read(id) { const result = await requests.get(id)?.reader?.read(); return !result || result.done ? null : VSBuffer.wrap(new Uint8Array(result.value)); },
		async cancel(id) { const pending = requests.get(id); requests.delete(id); pending?.controller.abort(); await pending?.reader?.cancel().catch(() => { }); },
	} satisfies IChatGPTTransport],
	[IStorageService, storage],
	[IExtensionHostApi, {
		...createDisconnectedExtensionHostApi(async () => { throw new Error('No host'); }),
		list: async () => {
			const response = await fetch('/__chat_math');
			if (!response.ok) { throw new Error('Math provider unavailable'); }
			return normalizeExtensionHostSnapshot(await response.json());
		},
		invoke: async (request, signal) => {
			const response = await fetch('/__chat_math', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request.payload), signal });
			if (!response.ok) { throw new Error('Math rendering failed'); }
			return response.json();
		},
	} satisfies IExtensionHostApi],
	[IConfigurationService, configuration],
	[IContextKeyService, resources.add(new ContextKeyService())],
	[IOpenerService, { open: async (url: string, options?: { openExternal?: boolean }) => {
		if (options?.openExternal) document.body.dataset.openedExternal = url;
		return true;
	} } as unknown as IOpenerService],
	[IEditorService, { focusActiveEditor: () => widget.focus() } as unknown as IEditorService],
	[IAgentThreadService, {} as IAgentThreadService],
	[IChatService, {} as IChatService],
	[IChatSessionNavigationService, {} as IChatSessionNavigationService],
	[ILanguageModelsService, { listModelProviders: async () => {
		document.body.dataset.nativeModelProvidersRead = 'true';
		return [];
	} } as unknown as ILanguageModelsService],
	[ISessionProviderScopeService, { getProviderScope: () => { throw new Error('This fixture has no Ash model provider'); } } as unknown as ISessionProviderScopeService],
	[ISessionPrimaryProviderServices, { models: { onDidChangeModels: Event.None, listModelCatalog: async () => [] } } as unknown as SessionProviderServices],
	[IThemeService, theme],
	[IContextViewService, resources.add(new BrowserContextViewService(document.body))],
	[IVoiceCodeTranscriptionBackendService, dictation ? createTestDictationBackend(resources, dictation) : undefined],
	[IPreferencesService, { openSettings: async () => undefined } as unknown as IPreferencesService],
)));
services.registerSingleton(ISpeechService, () => services.createInstance(SpeechService));
if (!services.has(IChatSpeechToTextService)) services.registerSingleton(IChatSpeechToTextService, () => services.createInstance(ChatSpeechToTextService));
registerTestDictationOnboarding(services);
registerTestComponentServices(services);
const attachmentFolder = URI.file('/fixture-folder');
const attachmentFile = URI.joinPath(attachmentFolder, 'notes.txt');
if (parameters.has('folderPicker')) {
	await services.get(IFileService).writeFileBytes(attachmentFile, new TextEncoder().encode('fixture notes'));
}
services.registerInstance(IFileDialogService, {
	async showOpenDialog(options) {
		if (!parameters.has('folderPicker')) return undefined;
		if (options.canSelectFolders) return [attachmentFolder];
		if (options.defaultUri?.toString() === attachmentFolder.toString()) return [attachmentFile];
		return undefined;
	},
} as IFileDialogService);
const commands = resources.add(new CommandService(services));
const menuService = new MenuService(commands, services.get(IContextKeyService));
services.registerInstance(IMenuService, menuService);
ChatContextKeys.enabled.bindTo(services.get(IContextKeyService)).set(true);
services.registerInstance(IChatAttachmentResolveService, new ChatAttachmentResolveService(
	{} as ConstructorParameters<typeof ChatAttachmentResolveService>[0],
	{} as ConstructorParameters<typeof ChatAttachmentResolveService>[1],
	{} as ConstructorParameters<typeof ChatAttachmentResolveService>[2],
	{} as ConstructorParameters<typeof ChatAttachmentResolveService>[3],
	services.get(IChatContextService),
));
services.registerInstance(IContextMenuService, resources.add(new BrowserContextMenuService(
	menuService, services.get(IContextKeyService),
	{ lookupKeybinding: () => undefined } as unknown as IKeybindingService,
	services.get(IContextViewService), resources.add(new TestNotificationService()),
)));
services.registerInstance(IQuickInputService, resources.add(new TestQuickInputService({ container: document.body, instantiationService: services, contextKeyService: services.get(IContextKeyService) })));
const dialogs = resources.add(new DialogService());
services.registerInstance(IDialogService, dialogs);
resources.add(new DialogHandlerContribution(dialogs.model, new BrowserDialogHandler(document.body)));
services.registerInstance(IClipboardService, { writeText: async (value: string) => { document.body.dataset.copiedLink = value; } } as IClipboardService);
registerCodeEditorServices(services);

resources.add(bindTestColorTheme(services.get(IThemeService), document.body));
services.registerInstance(ILifecycleService, { onWillShutdown: Event.None } as ILifecycleService);
const chat = resources.add(services.createInstance(ChatGPTService));
services.registerInstance(IChatGPTService, chat);
const ashChatSelected = services.get(IContextKeyService).createKey<boolean>(ASH_CHAT_SELECTED_CONTEXT, false);
resources.add(CommandsRegistry.register('sessions.show.chatgpt', () => ashChatSelected.set(false)));
window.ashChatGPTIntegration = {
	setConfiguration: (key, value) => configuration.updateValue(key, value),
	setMathEnabled: enabled => services.get(IConfigurationService).updateValue('markdown.math.enabled', enabled),
	setMathMacros: macros => services.get(IConfigurationService).updateValue('markdown.math.macros', macros),
	newChat: () => chat.newChat(),
	draft: () => chat.state.get().draft,
	storageKeys: () => storage.keys(StorageScope.PROFILE, StorageTarget.MACHINE),
	dictate: (text, final) => transcript?.(text, final),
	dictationStops: () => dictationStops,
	setVisible: visible => widget.setVisible(visible),
	setAshChatSelected: selected => ashChatSelected.set(selected),
};
services.registerInstance(ISessionsListModelService, new SessionsListModelService(storage));
services.registerInstance(IProjectService, { list: async () => [], onDidChange: Event.None } as unknown as IProjectService);
services.registerInstance(IProjectsService, resources.add(services.createInstance(ProjectsService)));
const sources: ChatListSource[] = [resources.add(services.createInstance(ChatGPTList))];
if (parameters.has('mixedCatalog')) {
	const ashServices = resources.add(services.createChild(new ServiceCollection(
		[ICommandService, commands],
		[ISessionsManagementService, {
			onDidChange: Event.None,
			sessions: [{ sessionId: 'fixture-chat', title: 'Local Ash conversation', status: 'active', surface: 'chat', chats: [
				{ threadId: 'fixture-thread', status: 'active', origin: { type: 'root' } },
			] }],
		} as unknown as ISessionsManagementService],
		[ISessionGroupsService, { groups: [], onDidChange: Event.None } as unknown as ISessionGroupsService],
	)));
	ashServices.registerInstance(ISessionsSearchService, { registerSource: () => Disposable.None, show: async () => { }, focus: () => { } });
	const selection = ashServices.createInstance(AshChatSelectionService);
	ashServices.registerInstance(IAshChatSelectionService, selection);
	resources.add(autorun(reader => {
		const current = selection.selection.read(reader);
		if (current.kind === 'thread') document.body.dataset.openedAsh = `${current.sessionId}/${current.threadId}`;
	}));
	resources.add(CommandsRegistry.register(SHOW_ASH_CHAT_COMMAND, () => ashChatSelected.set(true)));
	sources.push(resources.add(ashServices.createInstance(AshChatNavigationSource)));
}
services.registerInstance(IChatListCatalog, { sources });
const titlebarContent = document.createElement('div');
titlebarContent.className = 'ash-sessions-titlebar-page-content';
titlebarContent.style.display = 'contents';
document.body.prepend(titlebarContent);
services.registerInstance(ISessionsTitlebarService, {
	setPageContent: content => {
		titlebarContent.replaceChildren(content);
		return toDisposable(() => {
			if (content.parentElement === titlebarContent) content.remove();
		});
	},
} as ISessionsTitlebarService);
widget = resources.add(services.createInstance(ReplyChatEditor, chatGPTReplyEditor));
widget.create(document.getElementById('editor')!);
if (parameters.has('screenReader')) { services.get(IAccessibilityService).setAccessibilitySupport(AccessibilitySupport.Enabled); }
widget.setVisible(true);
const host = document.getElementById('navigation')!;
resources.add(registerChatWorkspaceNavigation(chatGPTReplyEditor.accessibility));
const descriptors = resources.add(services.createInstance(ViewDescriptorService, { registry: SessionsViewRegistry }));
const descriptor = descriptors.getViewContainerById(CHAT_WORKSPACE_NAVIGATION_ID)!;
const view = resources.add(services.createInstance(PaneComposite, host, {
	viewContainer: descriptor, model: descriptors.getViewContainerModel(descriptor.id)!,
	paneLayout: 'fill', mergeViewWithContainerWhenSingleView: true,
}));
view.setVisible(true);
if (parameters.has('projects')) {
	const projects = resources.add(services.createInstance(ProjectsEditorPane));
	projects.create(document.getElementById('editor')!);
	projects.setVisible(true);
}
const resize = new ResizeObserver(() => view.layout({ height: host.clientHeight, width: host.clientWidth }));
resize.observe(host);
resources.add(toDisposable(() => resize.disconnect()));
chat.initialize();
if (parameters.has('focus')) { widget.focus(); }
window.addEventListener('pagehide', () => resources.dispose(), { once: true });
