import { IDocsService } from '../../../src/ash/sessions/contrib/docs/common/docsService.js';
import { ImageResizeService } from '../../../src/ash/platform/imageResize/browser/imageResizeService.js';
import { createTestArtifactCatalogService, createTestDocsService } from '../../../src/ash/sessions/test/common/testArtifactCatalogService.js';
import './chatFixtureLocalization.js';
import { projectMaterialFilesScheme } from '../../../src/ash/platform/projects/common/projectMaterialFiles.js';
import { IWorkbenchEnvironmentService } from '../../../src/ash/workbench/services/environment/common/environmentService.js';
import { IBrowserViewService } from '../../../src/ash/platform/browserView/common/browserView.js';
import { IBrowserViewWorkbenchService } from '../../../src/ash/workbench/contrib/browserView/common/browserView.js';
import { MemoryFileService } from '../../../src/ash/workbench/contrib/bulkEdit/test/browser/bulkEditTestServices.js';
import '../../../src/ash/sessions/browser/actions/sessionsChatActions.js';
import '../../../src/ash/sessions/contrib/sessions/browser/views/sessionsViewActions.js';
import '../../../src/ash/sessions/contrib/projects/browser/projects.contribution.js';
import { IProjectDialogService, ProjectDialogService } from '../../../src/ash/sessions/contrib/projects/browser/projectDialogService.js';
import { IProjectsService } from '../../../src/ash/sessions/contrib/projects/browser/projectsService.js';
import { ILifecycleService } from '../../../src/ash/workbench/services/lifecycle/common/lifecycle.js';
import { ProjectsEditorPane } from '../../../src/ash/sessions/contrib/projects/browser/projectsEditor.js';
import { Menus } from '../../../src/ash/sessions/browser/menus.js';
import { ISessionFolderAuthorizationService } from '../../../src/ash/sessions/common/sessionWorkspace.js';
import { ProjectTitleBarContribution } from '../../../src/ash/sessions/contrib/projects/browser/projectTitleBarWidget.js';
import { MenuWorkbenchToolBar, type IMenuWorkbenchToolBarOptions } from '../../../src/ash/platform/actions/browser/toolbar.js';
import { IEditorPart } from '../../../src/ash/workbench/browser/parts/editor/editorPart.js';
import { IHistoryService } from '../../../src/ash/workbench/services/history/common/history.js';
import { documentConversationStorageKeys } from '../../../src/ash/sessions/contrib/chat/browser/documentConversation.js';
import { IPdfEditorService, PdfEditorService } from '../../../src/ash/sessions/contrib/pdf/browser/pdfEditorService.js';
import { BrowserWorkingCopyService } from '../../../src/ash/workbench/services/workingCopy/browser/browserWorkingCopyService.js';
import { IWorkingCopyService } from '../../../src/ash/workbench/services/workingCopy/common/workingCopyService.js';
import { IProjectService, type Project } from '../../../src/ash/platform/projects/common/projectService.js';
import { IFileDialogService } from '../../../src/ash/platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../src/ash/platform/files/common/files.js';
import { BrowserLayoutService, ILayoutService } from '../../../src/ash/platform/layout/browser/layoutService.js';
import { URI } from '../../../src/ash/base/common/uri.js';
import { IChatResponseResourceFileSystemProvider } from '../../../src/ash/workbench/contrib/chat/common/widget/chatResponseResourceFileSystemProvider.js';
import { IChatSlashCommandService } from '../../../src/ash/workbench/contrib/chat/common/participants/chatSlashCommands.js';
import { IActionViewItemService } from '../../../src/ash/platform/actions/browser/actionViewItemService.js';
import { IChatPasteTargetService, IChatWidgetService } from '../../../src/ash/workbench/contrib/chat/browser/chat.js';
import { ChatContextKeys } from '../../../src/ash/workbench/contrib/chat/common/actions/chatContextKeys.js';
import { ChatTimelineStorage } from '../../../src/ash/sessions/browser/chatTimelineStorage.js';
import { ISessionPrimaryProviderServices, ISessionProviderScopeService, type SessionProviderServices } from '../../../src/ash/sessions/browser/agentHost/sessionProviderScopeService.js';
import { IChatSpeechToTextService, ChatSpeechToTextService } from '../../../src/ash/workbench/contrib/chat/browser/speechToText/chatSpeechToTextService.js';
import { combinedDisposable, Disposable, DisposableStore, toDisposable } from '../../../src/ash/base/common/lifecycle.js';
import { observableValue } from '../../../src/ash/base/common/observable.js';
import { VSBuffer } from '../../../src/ash/base/common/buffer.js';
import { DeferredPromise } from '../../../src/ash/base/common/async.js';
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
import { OpenerService } from '../../../src/ash/editor/browser/services/openerService.js';
import { IEditorService } from '../../../src/ash/workbench/services/editor/common/editorService.js';
import { CommandsRegistry, ICommandService } from '../../../src/ash/platform/commands/common/commands.js';
import { ChatGPTService, IChatGPTService, chatGPTProjectConversationId } from '../../../src/ash/sessions/contrib/chatgptweb/browser/chatGPTService.js';
import { artifactSourceKey, type ArtifactResource } from '../../../src/ash/platform/artifactCatalog/common/artifactCatalog.js';
import { IArtifactCatalogService } from '../../../src/ash/sessions/services/artifactCatalog/common/artifactCatalogService.js';
import { ChatGPTList } from '../../../src/ash/sessions/contrib/chatgptweb/electron-browser/chatGPTList.js';
import { ASH_CHAT_SELECTED_CONTEXT, CHAT_WORKSPACE_NAVIGATION_ID, SHOW_ASH_CHAT_COMMAND } from '../../../src/ash/sessions/common/chatWorkspace.js';
import { registerChatWorkspaceNavigation } from '../../../src/ash/sessions/contrib/chat/electron-browser/chatWorkspace.contribution.js';
import { PaneComposite } from '../../../src/ash/workbench/browser/panecomposite.js';
import { IChatListCatalog, NativeChatCatalogSource, type ChatListSource } from '../../../src/ash/sessions/contrib/chat/browser/chatListModel.js';
import { ChatListForks } from '../../../src/ash/sessions/contrib/chat/browser/chatListForks.js';
import { SessionActionsService } from '../../../src/ash/sessions/browser/sessionActionsService.js';
import { IAgentSessionActionsService } from '../../../src/ash/workbench/contrib/chat/browser/agentSessions/agentSessionsService.js';
import { ISessionsListModelService, SessionsListModelService } from '../../../src/ash/sessions/services/sessions/browser/sessionsListModelService.js';
import type { ChatView } from '../../../src/ash/sessions/contrib/chat/browser/chatView.js';
import { ChatViewFactory } from '../../../src/ash/sessions/contrib/chat/browser/chatViewFactory.js';
import { ISessionsConversationService } from '../../../src/ash/sessions/services/sessions/common/sessionsConversation.js';
import { ISessionsEntryService } from '../../../src/ash/sessions/services/layout/common/sessionsEntryService.js';
import { chatGPTViewSource, chatGPTScrollOptimization } from '../../../src/ash/sessions/contrib/chatgptweb/electron-browser/chatGPTWeb.js';
import { registerChatGPTResponseActions } from '../../../src/ash/sessions/contrib/chatgptweb/electron-browser/chatGPTResponseActions.js';
import { ChatCopyActionRendering } from '../../../src/ash/workbench/contrib/chat/browser/actions/chatCopyActions.js';
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
import { Emitter, Event } from '../../../src/ash/base/common/event.js';
import { ISessionsSearchService } from '../../../src/ash/sessions/contrib/search/browser/searchService.js';
import { ISessionsManagementService } from '../../../src/ash/sessions/services/sessions/common/sessionsManagement.js';
import { ISessionsService, type SessionsSelection } from '../../../src/ash/sessions/services/sessions/browser/sessionsService.js';
import { ISessionSectionOrderService } from '../../../src/ash/sessions/services/sessions/browser/sessionSectionOrderService.js';
import { IGitHubService } from '../../../src/ash/sessions/contrib/github/browser/githubService.js';
import { BlockedSessionsIndicatorModel, IBlockedSessionsIndicatorService } from '../../../src/ash/sessions/contrib/sessions/browser/blockedSessionsIndicatorModel.js';
import { SessionsWorkspaceModeContext } from '../../../src/ash/sessions/common/contextkeys.js';
import { ISessionGroupsService } from '../../../src/ash/sessions/services/sessions/browser/sessionGroupsService.js';
import { IVoiceCodeTranscriptionBackendService } from '../../../src/ash/platform/dictation/common/dictation.js';
import { ISpeechService } from '../../../src/ash/workbench/contrib/speech/common/speechService.js';
import { SpeechService } from '../../../src/ash/workbench/contrib/speech/browser/speechService.js';
import { registerTestVoiceInputServices, createTestDictationBackend, installTestDictationAudio, type TestDictationCapture } from '../../../src/ash/workbench/test/common/testDictationServices.js';
import { IPreferencesService } from '../../../src/ash/workbench/services/preferences/common/preferences.js';
import { IChatService } from '../../../src/ash/workbench/services/chat/common/chatService.js';
import { IChatSessionNavigationService } from '../../../src/ash/workbench/services/chat/common/chatSessionNavigationService.js';
import { ILanguageModelsService } from '../../../src/ash/workbench/contrib/chat/common/languageModels.js';
import { ILanguageModelToolsService } from '../../../src/ash/workbench/contrib/chat/common/tools/languageModelToolsService.js';
import { createTestLanguageModelToolsService } from '../../../src/ash/workbench/contrib/chat/test/common/tools/testLanguageModelToolsService.js';

import { BrowserContextMenuService } from '../../../src/ash/platform/contextview/browser/contextMenuService.js';
import { MenuService } from '../../../src/ash/platform/actions/common/menuService.js';
import { CommandService } from '../../../src/ash/workbench/services/commands/common/commandService.js';
import { IKeybindingService } from '../../../src/ash/platform/keybinding/common/keybinding.js';
import { TestNotificationService } from './notificationFixture.js';
import { IQuickInputService } from '../../../src/ash/platform/quickinput/common/quickInput.js';
import { TestQuickInputService } from '../../../src/ash/platform/quickinput/test/browser/testQuickInputService.js';
import { IDialogService } from '../../../src/ash/platform/dialogs/common/dialogs.js';
import { BrowserDialogHandler } from '../../../src/ash/workbench/browser/parts/dialogs/dialogHandler.js';
import { DialogHandlerContribution } from '../../../src/ash/workbench/browser/parts/dialogs/dialog.web.contribution.js';
import { DialogService } from '../../../src/ash/workbench/services/dialogs/common/dialogService.js';
import { IClipboardService } from '../../../src/ash/platform/clipboard/common/clipboardService.js';
import { AccessibilitySupport, IAccessibilityService } from '../../../src/ash/platform/accessibility/common/accessibility.js';
import { AccessibilityService } from '../../../src/ash/platform/accessibility/browser/accessibilityService.js';
import '../../../src/ash/sessions/contrib/chat/browser/chat.contribution.js';

declare global {
	interface Window {
		ashChatGPTIntegration: {
			newChat(): void; draft(): string; readSavedMaterial(name: string): string | undefined; openedMaterial(): string | undefined; setOffline(offline: boolean): void; storageKeys(): readonly string[]; dictate(text: string, final: boolean): void; dictationStops(): number; setVisible(visible: boolean): void; setAshChatSelected(selected: boolean): void; setConfiguration(key: string, value: unknown): Promise<void>; showFind(): void; setMathEnabled(enabled: boolean): Promise<void>; setMathMacros(macros: Record<string, string>): Promise<void>; notifications(): readonly { id: number; message: string }[]; retryHistory(): Promise<void>; toggleArchivedProjects(): Promise<void>;
			switchAccount(): void;
			pauseMaterialRead(name: string): void;
			isMaterialReadPaused(): boolean;
			resumeMaterialRead(): Promise<void>;
			writeSavedMaterial(name: string, text: string): Promise<void>;
			seedProjectPdfDraft(name: string): Promise<string>;
			readProjectPdfDraft(uri: string): Promise<{ backup: boolean; conversation: boolean; }>;
		};
	}
}

const parameters = new URLSearchParams(location.search);
let chatGPTCacheScope = 'a'.repeat(64);
registerChatGPTResponseActions();
// The renderer widgets consume the containing Sessions host's visual defaults.
document.body.classList.add('ash-workbench');
const sessionsRoot = document.createElement('div');
sessionsRoot.className = 'ash-sessions-window';
sessionsRoot.style.flexDirection = 'row';
sessionsRoot.append(document.getElementById('navigation')!, document.getElementById('editor')!);
document.body.append(sessionsRoot);
const resources = new DisposableStore();
const authenticationChanged = resources.add(new Emitter<void>());
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
let widget: ChatView;
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
configurationRegistry.registerConfiguration({ key: chatGPTScrollOptimization, defaultValue: false, parse: value => Boolean(value) });
configurationRegistry.registerConfiguration({ key: 'markdown.math.enabled', defaultValue: true, parse: value => Boolean(value) });
configurationRegistry.registerConfiguration({ key: 'markdown.math.macros', defaultValue: {}, parse: value => value });
const configuration = resources.add(new InMemoryConfigurationService());
const notifications = resources.add(new TestNotificationService());
if (dictation) await configuration.updateValue('dictation.backend', 'cloud');
const savedMaterials = new Map<string, { resource: URI; text: string; }>();
let pausedMaterialRead: { name: string; started: boolean; release: DeferredPromise<void> } | undefined;
resources.add(toDisposable(() => void pausedMaterialRead?.release.complete()));
let openedMaterial: string | undefined;
const services = resources.add(new InstantiationService(new ServiceCollection(
	...getSingletonServiceDescriptors().filter(([id]) =>
		id === IChatWidgetService || id === IActionViewItemService || id === IChatSlashCommandService
		|| id === IChatPasteTargetService || id === IChatResponseResourceFileSystemProvider
		|| id === IProjectsService),
	[IAgentVoiceService, undefined],
	[IMessageHistoryService, undefined],
	[IVoiceModeOnboardingService, { showIfNeeded() { }, registerHost: () => toDisposable(() => { }) } as unknown as IVoiceModeOnboardingService],
	[IAccessibleViewService, { getOpenAriaHint: () => undefined } as unknown as IAccessibleViewService],
	[INotificationService, notifications],
	[ILayoutService, resources.add(new BrowserLayoutService({ root: document.body }))],
	// The standalone page has no embedded browser or Sessions window layout.
	[IBrowserViewWorkbenchService, undefined],
	[ISessionsEntryService, undefined],
	[IImageEditorService, {} as IImageEditorService],
	[IAgentHostInputCompletionService, createDisconnectedAgentHostInputCompletionService()],
	[IChatGPTTransport, {
		async getCacheScope() { return chatGPTCacheScope; },
		onDidChangeAuthentication: authenticationChanged.event,
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
	[ISessionsConversationService, { focus: () => widget.focus() } as ISessionsConversationService],
	[IEditorService, {
		openEditor: async ({ resource }: { resource: URI }) => {
			openedMaterial = (await services.get(IFileService).readFile(resource)).content;
		},
	} as unknown as IEditorService],
	[IAgentThreadService, {} as IAgentThreadService],
	[IChatService, {} as IChatService],
	[IChatSessionNavigationService, {} as IChatSessionNavigationService],
	[ILanguageModelsService, { listModelProviders: async () => {
		document.body.dataset.nativeModelProvidersRead = 'true';
		return [];
	} } as unknown as ILanguageModelsService],
	[ISessionProviderScopeService, { onDidChangeScopes: Event.None, getProviderScope: () => { throw new Error('This fixture has no Ash model provider'); } } as unknown as ISessionProviderScopeService],
	[ISessionPrimaryProviderServices, { models: { onDidChangeModels: Event.None, listModelCatalog: async () => [] } } as unknown as SessionProviderServices],
	[IThemeService, theme],
	// The project picker exercises the inherited styles of the production popup host.
	[IContextViewService, resources.add(new BrowserContextViewService(parameters.has('folderPicker') ? sessionsRoot : document.body))],
	[IVoiceCodeTranscriptionBackendService, dictation ? createTestDictationBackend(resources, dictation) : undefined],
	[IPreferencesService, { openSettings: async () => undefined } as unknown as IPreferencesService],
)));
services.registerSingleton(ISpeechService, () => services.createInstance(SpeechService));
services.registerSingleton(ILanguageModelToolsService, () => createTestLanguageModelToolsService());
if (!services.has(IChatSpeechToTextService)) services.registerSingleton(IChatSpeechToTextService, () => services.createInstance(ChatSpeechToTextService));
const commands = resources.add(new CommandService(services));
services.registerInstance(ICommandService, commands);
if (parameters.has('websiteFavicons')) {
	services.registerInstance(IBrowserViewService, {
		async getWebsiteFavicon(origin: string) {
			document.body.dataset.faviconOrigins = [document.body.dataset.faviconOrigins, origin].filter(Boolean).join(' ');
			return origin === 'https://docs.python.org'
				? 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGNgAAIAAAUAAen63NgAAAAASUVORK5CYII='
				: undefined;
		},
	} as IBrowserViewService);
}
services.registerSingleton(IOpenerService, () => {
	const opener = services.createInstance(OpenerService);
	opener.setDefaultExternalOpener({
		openExternal: async url => {
			document.body.dataset.openedExternal = url;
			return true;
		},
	});
	return opener;
});
services.registerInstance(ISessionFolderAuthorizationService, { isTrusted: async () => true, authorize: async () => true });
services.registerSingleton(IProjectDialogService, () => services.createInstance(ProjectDialogService, { readEnabled: async () => true }));
registerTestVoiceInputServices(services);
registerTestComponentServices(services);
const artifactCatalog: ArtifactResource[] = [];
let nextArtifactResource = 0;
const artifactCatalogChanged = resources.add(new Emitter<void>());
const generated: IArtifactCatalogService = {
	...createTestArtifactCatalogService(),
	onDidChange: artifactCatalogChanged.event, files: artifactCatalog, loading: false, error: undefined,
	async refresh() { artifactCatalogChanged.fire(); },
	findBySource: source => artifactCatalog.find(file => artifactSourceKey(file.source) === artifactSourceKey(source)),
	hasResource: resource => artifactCatalog.some(file => file.resource.toString() === resource.toString()),
	async register(file) {
		const entry = { ...file, createdAt: Date.now() };
		artifactCatalog.push(entry);
		artifactCatalogChanged.fire();
		return entry;
	},
};
services.registerInstance(IArtifactCatalogService, generated);
services.registerInstance(IDocsService, { ...createTestDocsService(),
	async importMarkdown(source, markdown, title) {
		const existing = generated.findBySource(source);
		if (existing) return existing;
		const id = `fixture-markdown-${nextArtifactResource++}`;
		const resource = URI.file(`/generated/${id}.md`);
		await services.get(IFileService).writeFileBytes(resource, new TextEncoder().encode(markdown));
		const file: ArtifactResource = { id, resource, title: title ?? 'Document', contentType: 'text/markdown', source, createdAt: Date.now() };
		artifactCatalog.push(file);
		artifactCatalogChanged.fire();
		return file;
	},
});
if (parameters.has('projectMaterials')) {
	Object.assign(services.get(IWorkbenchEnvironmentService), { userRoamingDataHome: URI.file('/fixture-profile') });
	const provider = new class extends MemoryFileService {
		override async readFile(resource: URI) {
			const result = await super.readFile(resource);
			const pause = pausedMaterialRead;
			if (pause && !pause.started && resource.path.endsWith(`/${pause.name}`)) {
				pause.started = true;
				await pause.release.p;
			}
			return result;
		}

		override async writeFile(...args: Parameters<MemoryFileService['writeFile']>) {
			const written = await super.writeFile(...args);
			savedMaterials.set(args[0].path.split('/').at(-1)!, { resource: args[0], text: this.text(args[0]) });
			return written;
		}

		override async delete(...args: Parameters<MemoryFileService['delete']>) {
			await super.delete(...args);
			const name = args[0].path.split('/').at(-1)!;
			if (savedMaterials.get(name)?.resource.toString() === args[0].toString()) savedMaterials.delete(name);
		}
	}([]);
	resources.add(services.get(IFileService).registerProvider(projectMaterialFilesScheme, provider));
}

services.registerInstance(IAccessibilityService, resources.add(new AccessibilityService({
	root: document.body, contextKeyService: services.get(IContextKeyService), configurationService: configuration,
})));
resources.add(services.createInstance(ChatCopyActionRendering));
const attachmentFolder = URI.file('/fixture-folder');
const attachmentFile = URI.joinPath(attachmentFolder, 'notes.txt');
if (parameters.has('folderPicker') || parameters.has('sidebarProjectFiles')) {
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
const menuService = new MenuService(commands, services.get(IContextKeyService));
services.registerInstance(IMenuService, menuService);
ChatContextKeys.enabled.bindTo(services.get(IContextKeyService)).set(true);
services.registerInstance(IChatAttachmentResolveService, new ChatAttachmentResolveService(
	{} as ConstructorParameters<typeof ChatAttachmentResolveService>[0],
	{} as ConstructorParameters<typeof ChatAttachmentResolveService>[1],
	{} as ConstructorParameters<typeof ChatAttachmentResolveService>[2],
	{} as ConstructorParameters<typeof ChatAttachmentResolveService>[3],
	services.get(IChatContextService),
	new ImageResizeService(),
));
services.registerInstance(IContextMenuService, resources.add(new BrowserContextMenuService(
	menuService, services.get(IContextKeyService),
	{ lookupKeybinding: () => undefined } as unknown as IKeybindingService,
	services.get(IContextViewService), notifications,
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
const workspaceMode = SessionsWorkspaceModeContext.bindTo(services.get(IContextKeyService));
resources.add(CommandsRegistry.register('sessions.show.chatgpt', () => {
	ashChatSelected.set(false);
	workspaceMode.set('chat');
}));
resources.add(CommandsRegistry.register('sessions.open.code', () => {
	ashChatSelected.set(false);
	workspaceMode.set('code');
}));
window.ashChatGPTIntegration = {
	setConfiguration: (key, value) => configuration.updateValue(key, value),
	showFind: () => services.get(IChatWidgetService).getAllWidgets().find(widget => widget.visible)?.getFindController()?.show(),
	setMathEnabled: enabled => services.get(IConfigurationService).updateValue('markdown.math.enabled', enabled),
	setMathMacros: macros => services.get(IConfigurationService).updateValue('markdown.math.macros', macros),
	newChat: () => chat.newChat(),
	draft: () => chat.state.get().draft,
	readSavedMaterial: name => savedMaterials.get(name)?.text,
	writeSavedMaterial: async (name, text) => {
		const resource = savedMaterials.get(name)!.resource;
		await services.get(IFileService).writeFileBytes(resource, new TextEncoder().encode(text), { create: false, overwrite: true });
	},
	seedProjectPdfDraft: async name => {
		const resource = savedMaterials.get(name)!.resource;
		const key = resource.toString();
		await services.get(IPdfEditorService).backups.store({ resource, kind: 'structuredDocument', contentType: 'application/pdf', content: 'PDF draft fixture', updatedAt: Date.now() });
		storage.store(documentConversationStorageKeys.chatgpt, JSON.stringify({ [key]: {
			scope: 'account-scope', identity: 'project-pdf', reference: { kind: 'conversation', id: 'project-chat' },
		} }), StorageScope.PROFILE, StorageTarget.MACHINE);
		return key;
	},
	readProjectPdfDraft: async uri => ({
		backup: !!await services.get(IPdfEditorService).backups.resolve(URI.parse(uri)),
		conversation: Object.hasOwn(JSON.parse(storage.get(documentConversationStorageKeys.chatgpt, StorageScope.PROFILE, '{}')), uri),
	}),
	switchAccount: () => {
		chatGPTCacheScope = (chatGPTCacheScope[0] === 'a' ? 'b' : 'a').repeat(64);
		authenticationChanged.fire();
	},
	pauseMaterialRead: name => { pausedMaterialRead = { name, started: false, release: new DeferredPromise<void>() }; },
	isMaterialReadPaused: () => pausedMaterialRead?.started === true,
	resumeMaterialRead: async () => {
		await pausedMaterialRead?.release.complete();
		pausedMaterialRead = undefined;
	},
	openedMaterial: () => openedMaterial,
	setOffline: offline => chat.setNetworkAvailable(!offline),
	storageKeys: () => storage.keys(StorageScope.PROFILE, StorageTarget.MACHINE),
	dictate: (text, final) => transcript?.(text, final),
	dictationStops: () => dictationStops,
	setVisible: visible => widget.setVisible(visible),
	setAshChatSelected: selected => ashChatSelected.set(selected),
	notifications: () => notifications.model.getNotifications().map(({ id, message }) => ({ id, message })),
	toggleArchivedProjects: () => commands.executeCommand('sessions.toggleArchivedProjects'),
	retryHistory: async () => {
		const retry = notifications.model.getNotifications().flatMap(item => item.actions?.primary ?? []).find(action => action.id === 'sessions.chatgpt.retryHistory');
		if (!retry) { throw new Error('Missing history retry action'); }
		await retry.run();
	},
};
services.registerInstance(ISessionsListModelService, new SessionsListModelService(storage));
let ashProject: Project = {
	id: 'ash-project-fixture', name: 'Local Ash project', revision: 1,
	archived: false, sessionCount: 0, description: '', materials: [], sessionIds: [],
	icon: 'chat', color: 'terminal.ansiBlue',
};
const mixedProjectArchive = parameters.has('mixedProjectArchive');
const sidebarProjectFiles = parameters.has('sidebarProjectFiles');
if (sidebarProjectFiles) ashProject = {
	...ashProject, materials: [{ kind: 'file', name: 'notes.txt', resource: attachmentFile, sizeBytes: 13 }],
};
const hasAshProject = parameters.has('ashProjectPicker') || mixedProjectArchive || sidebarProjectFiles;
const withArchiveMembers = (project: Project): Project => {
	if (!mixedProjectArchive) return project;
	const externalConversationIds = ['first', 'older'].map(id => chatGPTProjectConversationId(chatGPTCacheScope, id)!);
	return { ...project, sessionIds: ['fixture-chat'], externalConversationIds, sessionCount: 3 };
};
const projectChanged = resources.add(new Emitter<void>());
services.registerInstance(IProjectService, {
	list: async () => hasAshProject ? [withArchiveMembers(ashProject)] : [],
	read: async (id: string) => {
		if (hasAshProject && id === ashProject.id) return withArchiveMembers(ashProject);
		throw new Error('Unknown fixture project');
	},
	archive: async (project: Project) => {
		ashProject = { ...project, archived: true, revision: project.revision + 1 };
		projectChanged.fire();
		return ashProject;
	},
	moveExternalConversation: async (id: string, _from: string | undefined, to: string | undefined) => {
		if (to !== ashProject.id) throw new Error('Unknown destination project');
		ashProject = { ...ashProject, revision: ashProject.revision + 1, sessionCount: 1, externalConversationIds: [id] };
		document.body.dataset.linkedConversation = id;
		projectChanged.fire();
	},
	onDidChange: projectChanged.event,
} as unknown as IProjectService);
const groups = { groups: [], onDidChange: Event.None } as unknown as ISessionGroupsService;
services.registerInstance(ISessionGroupsService, groups);
services.registerInstance(ISessionSectionOrderService, { onDidChange: Event.None, getOrder: (_mode, ids) => ids } as ISessionSectionOrderService);

services.registerInstance(IGitHubService, { onDidChange: Event.None, getSessionPullRequests: () => [] } as unknown as IGitHubService);
const localChat = {
	sessionId: 'fixture-chat', title: 'Local Ash conversation', status: 'active', kind: 'chat',
	management: { status: 'idle' },
	chats: [{ threadId: 'fixture-thread', status: 'active', origin: { type: 'root' }, createdAt: new Date(1) }],
};
services.registerInstance(ISessionsManagementService, {
	pendingArchives: observableValue<ReadonlySet<string>>('pending archives', new Set()),
	state: 'ready', primaryCatalogReady: true, onDidChange: Event.None, untitledSessions: [],
	async initialize() { },
	async refresh() { },
	async archiveSession(id: string) {
		if (id !== localChat.sessionId || localChat.status !== 'active') throw new Error('Unexpected Ash conversation archive');
		localChat.status = 'archived';
		document.body.dataset.archivedAsh = id;
	},
	sessions: parameters.has('mixedCatalog') ? [{
		sessionId: 'fixture-code', title: 'Local Code conversation', status: 'active', kind: 'code',
		chats: [{ threadId: 'fixture-code', status: 'active', origin: { type: 'root' } }],
	}, localChat] : mixedProjectArchive ? [localChat] : [],
} as unknown as ISessionsManagementService);
const chatSelection = observableValue<import('../../../src/ash/sessions/services/sessions/browser/sessionGridState.js').StoredChatSelection | undefined>('fixture chat', undefined);
services.registerInstance(ISessionsService, {
	chatSelection,
	selectChatThread(sessionId: string, threadId: string) {
		chatSelection.set({ kind: 'thread', sessionId, threadId }, undefined);
		document.body.dataset.openedAsh = `${sessionId}/${threadId}`;
	},
	onDidChange: Event.None,
	getSelection: (): SessionsSelection => ({ activeSelection: undefined, visibleSelections: [] }),
	openSession: async (sessionId: string, threadId: string) => { document.body.dataset.openedCode = `${sessionId}/${threadId}`; },
} as unknown as ISessionsService);
services.registerInstance(IBlockedSessionsIndicatorService, services.createInstance(BlockedSessionsIndicatorModel));
const sources: ChatListSource[] = [resources.add(services.createInstance(ChatGPTList))];
if (parameters.has('mixedCatalog')) {
	const ashServices = resources.add(services.createChild(new ServiceCollection(
		[ICommandService, commands],
	)));
	ashServices.registerInstance(ISessionsSearchService, { registerSource: () => Disposable.None, show: async () => { }, focus: () => { } });
	resources.add(CommandsRegistry.register(SHOW_ASH_CHAT_COMMAND, () => {
		ashChatSelected.set(true);
		workspaceMode.set('chat');
	}));
	sources.push(resources.add(ashServices.createInstance(NativeChatCatalogSource)));
}
services.registerInstance(IChatListCatalog, {
	sources,
	forks: resources.add(new ChatListForks(sources, services.get(IStorageService))),
	attach: (window, isVisible) => combinedDisposable(...sources.map(source => source.attach?.(window, isVisible) ?? Disposable.None)),
});
services.registerSingleton(IAgentSessionActionsService, () => services.createInstance(SessionActionsService, services.get(IChatListCatalog)));
const titlebarContent = document.createElement('div');
titlebarContent.className = 'ash-sessions-titlebar-page-content';
titlebarContent.style.display = 'contents';
document.body.prepend(titlebarContent);
resources.add(services.createInstance(MenuWorkbenchToolBar, titlebarContent, Menus.TitleBarPageContent, {
	toolbarOptions: { primaryGroup: () => true },
} satisfies IMenuWorkbenchToolBarOptions));
const chatViews = services.createInstance(ChatViewFactory);
resources.add(chatViews.registerSource('chatgpt', chatGPTViewSource));
widget = resources.add(chatViews.createChatView('chatgpt', document.getElementById('editor')!));
if (parameters.has('screenReader')) { services.get(IAccessibilityService).setAccessibilitySupport(AccessibilitySupport.Enabled); }
widget.setVisible(true);
const host = document.getElementById('navigation')!;
resources.add(registerChatWorkspaceNavigation(chatGPTViewSource.accessibility));
let activePane: ProjectsEditorPane | undefined;
services.registerInstance(IEditorPart, { get activePane() { return activePane; }, activeGroup: { get activePane() { return activePane; } }, groups: [], onDidChangeEditors: Event.None } as unknown as IEditorPart);
services.registerSingleton(IWorkingCopyService, () => services.createInstance(BrowserWorkingCopyService));
services.registerSingleton(IPdfEditorService, () => services.createInstance(PdfEditorService));
services.registerInstance(IHistoryService, { getHistory: () => [], remove() { }, goBack: async () => { }, goForward: async () => { }, reopenLastClosedEditor: async () => { } });
const descriptors = resources.add(services.createInstance(ViewDescriptorService, { registry: SessionsViewRegistry }));
const descriptor = descriptors.getViewContainerById(CHAT_WORKSPACE_NAVIGATION_ID)!;
const view = resources.add(services.createInstance(PaneComposite, host, {
	viewContainer: descriptor, model: descriptors.getViewContainerModel(descriptor.id)!,
	paneLayout: 'fill', mergeViewWithContainerWhenSingleView: true,
	onDidFailCreateView: (error: unknown) => { throw error; },
}));
view.setVisible(true);
if (parameters.has('projects')) {
	const projects = resources.add(services.createInstance(ProjectsEditorPane));
	projects.create(document.getElementById('editor')!);
	projects.setVisible(true);
	activePane = projects;
}
resources.add(services.createInstance(ProjectTitleBarContribution));
const resize = new ResizeObserver(() => view.layout({ height: host.clientHeight, width: host.clientWidth }));
resize.observe(host);
resources.add(toDisposable(() => resize.disconnect()));
if (!mixedProjectArchive) chat.initialize();
if (parameters.has('focus')) { widget.focus(); }
window.addEventListener('pagehide', () => resources.dispose(), { once: true });
