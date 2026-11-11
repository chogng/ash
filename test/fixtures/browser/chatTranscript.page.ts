import { BaseSecretStorageService, ISecretStorageService } from '../../../src/ash/platform/secrets/common/secrets.js';
import { IProjectService } from '../../../src/ash/platform/projects/common/projectService.js';
import { ISessionsProvidersService, SessionsProvidersService } from '../../../src/ash/sessions/services/sessions/browser/sessionsProvidersService.js';
import './chatFixtureLocalization.js';
import { ISessionsListModelService, SessionsListModelService } from '../../../src/ash/sessions/services/sessions/browser/sessionsListModelService.js';
import { IChatEntitlementService } from '../../../src/ash/workbench/services/chat/common/chatEntitlementService.js';
import * as chatInputStatePersistence from '../../../src/ash/workbench/contrib/chat/browser/widget/input/chatInputStatePersistence.js';
import { ISessionGroupsService, SessionGroupsService } from '../../../src/ash/sessions/services/sessions/browser/sessionGroupsService.js';
import { ServiceCollection } from '../../../src/ash/platform/instantiation/common/serviceCollection.js';
import { ChatAuxiliaryWindow } from '../../../src/ash/workbench/contrib/chat/browser/widgetHosts/chatAuxiliaryWindow.js';
import { BrowserAuxiliaryWindowService } from '../../../src/ash/workbench/services/auxiliaryWindow/browser/auxiliaryWindowService.js';
import { registerTestCodeEditorFeatures } from '../codeEditorFeatures.js';
import { ChatMarkdownContentPart } from '../../../src/ash/workbench/contrib/chat/browser/widget/chatContentParts/chatMarkdownContentPart.js';
import type { ChatTurnChangeSource, ChatTurnFileChange } from '../../../src/ash/workbench/contrib/chat/browser/chatResponseFileChangesService.js';
import { ChatOutputPartStateCache, IChatOutputPartStateCache } from '../../../src/ash/workbench/contrib/chat/browser/widget/chatContentParts/chatOutputPartStateCache.js';
import { setIconResolver } from '../../../src/ash/base/browser/ui/lxicons/lxicon.js';
import { getIconDefinition } from '../../../src/ash/platform/theme/common/iconRegistry.js';
import { IDiffService } from '../../../src/ash/workbench/services/diff/common/diffService.js';
import { DiffService } from '../../../src/ash/workbench/services/diff/browser/diffService.js';
import { wrapTablesWithScrollable } from '../../../src/ash/workbench/contrib/chat/browser/widget/chatContentParts/chatMarkdownTableScrolling.js';
import { DeferredPromise } from '../../../src/ash/base/common/async.js';
import { constObservable } from '../../../src/ash/base/common/observable.js';
import { IImageEditorService } from '../../../src/ash/workbench/services/imageEditor/common/imageEditorService.js';
import { ImageEditorService } from '../../../src/ash/workbench/services/imageEditor/browser/imageEditorService.js';
const codeFeatures = registerTestCodeEditorFeatures();
import type { NotificationService } from '../../../src/ash/workbench/services/notification/common/notificationService.js';
import { IChatSpeechToTextService, ChatSpeechToTextService } from '../../../src/ash/workbench/contrib/chat/browser/speechToText/chatSpeechToTextService.js';

import { createTestLanguageModelToolsService } from '../../../src/ash/workbench/contrib/chat/test/common/tools/testLanguageModelToolsService.js';
import { ImagePreviewEditor } from '../../../src/ash/workbench/contrib/mediaPreview/browser/imagePreviewEditor.js';
import { MediaPreview } from '../../../src/ash/workbench/contrib/mediaPreview/browser/mediaPreview.js';
import '../../../src/ash/workbench/contrib/mediaPreview/browser/mediaPreview.contribution.js';
import { TerminalConfigurationService } from '../../../src/ash/workbench/contrib/terminal/browser/terminalConfigurationService.js';
import { ITerminalConfigurationService } from '../../../src/ash/workbench/contrib/terminal/browser/terminal.js';
import { IStorageService, StorageScope } from '../../../src/ash/platform/storage/common/storage.js';
import { readNewChatDraftState } from '../../../src/ash/sessions/contrib/chat/common/newChatDraftState.js';
import type { ChatInputDelegate } from '../../../src/ash/workbench/contrib/chat/browser/widget/input/chatInput.js';
import { NativeChatWidget } from '../../../src/ash/sessions/contrib/chat/browser/widget/nativeChatWidget.js';
import { ReplyChatInputFactory } from '../../../src/ash/sessions/contrib/chat/browser/replyChatInput.js';
import { ChatInputEditor } from '../../../src/ash/workbench/contrib/chat/browser/widget/input/chatInputEditor.js';
import { ChatInputEditors } from '../../../src/ash/workbench/contrib/chat/browser/widget/input/chatInputEditorRegistry.js';
import { ChatTipService, IChatTipService } from '../../../src/ash/workbench/contrib/chat/browser/chatTipService.js';
import { ILifecycleService } from '../../../src/ash/workbench/services/lifecycle/common/lifecycle.js';
import { registerTestVoiceInputServices, installTestDictationAudio } from '../../../src/ash/workbench/test/common/testDictationServices.js';
import { LocalTranscriptionService } from '../../../src/ash/workbench/services/localTranscription/electron-browser/localTranscriptionService.js';
import { DictationModelState, ILocalTranscriptionBackendService, ILocalTranscriptionService, ILocalTranscriptionModelService, type IDictationModelStatus } from '../../../src/ash/platform/localTranscription/common/localTranscription.js';
import { IVoiceCodeTranscriptionClient, VoiceCodeTranscriptionClient } from '../../../src/ash/workbench/contrib/chat/browser/speechToText/voiceCodeTranscriptionClient.js';
import { getSingletonServiceDescriptors } from '../../../src/ash/platform/instantiation/common/extensions.js';
import { IDevContainerAgentHostService } from '../../../src/ash/sessions/common/devContainerAgentHostService.js';
import { DevContainerAgentHostService } from '../../../src/ash/sessions/contrib/providers/remoteAgentHost/browser/devContainerAgentHostService.js';
import { IAgentSessionActionsService, IAgentSessionsService } from '../../../src/ash/workbench/contrib/chat/browser/agentSessions/agentSessionsService.js';
import { IViewsService } from '../../../src/ash/workbench/services/views/common/viewsService.js';
import { InstantiationService } from '../../../src/ash/platform/instantiation/common/instantiationService.js';
import { ILogService, ILoggerService, LogLevel, type LogEntry } from '../../../src/ash/platform/log/common/log.js';
import { ITerminalLogService } from '../../../src/ash/platform/terminal/common/terminal.js';
import { TerminalLogService } from '../../../src/ash/platform/terminal/common/terminalLogService.js';
import { LogService } from '../../../src/ash/platform/log/common/logServiceImpl.js';
import { IDialogsModel } from '../../../src/ash/workbench/common/dialogs.js';
import { DialogService } from '../../../src/ash/workbench/services/dialogs/common/dialogService.js';
import { BrowserDialogHandler } from '../../../src/ash/workbench/browser/parts/dialogs/dialog.js';
import { DialogHandlerContribution } from '../../../src/ash/workbench/browser/parts/dialogs/dialog.web.contribution.js';
import { IAgentVoiceService } from '../../../src/ash/platform/agentHost/common/agentService.js';
import { IChatInputNoticeHubService } from '../../../src/ash/workbench/contrib/chat/browser/widget/input/chatInputNoticeHub.js';
import { IChatInputNotificationService, ChatInputNotificationSeverity } from '../../../src/ash/workbench/contrib/chat/browser/widget/input/chatInputNotificationService.js';
import { AgentsVoiceStorageKeys } from '../../../src/ash/workbench/contrib/agentsVoice/common/agentsVoice.js';
import '../../../src/ash/workbench/contrib/agentsVoice/browser/agentsVoice.contribution.js';
import { type AgentVoiceSessionState, type AgentVoiceTaskRequest, type AgentVoiceSelection } from '../../../src/ash/platform/agentHost/common/agent.js';
import { IWebviewService } from '../../../src/ash/workbench/contrib/webview/browser/webview.js';
import '../../../src/ash/workbench/contrib/webview/browser/webview.contribution.js';
import { IFileService } from '../../../src/ash/platform/files/common/files.js';
import { IContentSearchService } from '../../../src/ash/platform/search/common/search.js';
import { FileContentSearchService } from '../../../src/ash/platform/search/browser/searchService.js';
import { ISearchService } from '../../../src/ash/workbench/services/search/common/search.js';
import { SearchService } from '../../../src/ash/workbench/services/search/common/searchService.js';
import { IEditorGroupsService } from '../../../src/ash/workbench/services/editor/common/editorGroupsService.js';
import { ITextModelService } from '../../../src/ash/editor/common/services/resolverService.js';
import { LinkDetector } from '../../../src/ash/editor/contrib/links/browser/links.js';
import { IPromptsService } from '../../../src/ash/workbench/contrib/chat/common/promptSyntax/service/promptsService.js';
import { PromptsService } from '../../../src/ash/workbench/contrib/chat/common/promptSyntax/service/promptsServiceImpl.js';
import { CancellationToken } from '../../../src/ash/base/common/cancellation.js';
import { ILanguageModelToolsService } from '../../../src/ash/workbench/contrib/chat/common/tools/languageModelToolsService.js';
import { IAgentConnection, IAgentThreadService, IAgentHostInputCompletionService } from '../../../src/ash/platform/agentHost/common/agentService.js';
import toneWav from '../../../crates/utils/audio/tests/fixtures/tone.wav?url';
import type { AppServerProtocolClient } from '../../../src/ash/platform/agentHost/browser/appServerProtocolClient.js';
import type { ThreadTranscriptUpdateEnvelope as TranscriptDto, ServerNotification } from '../../../.build/protocol/typescript/index.js';
import type { ThreadTranscriptUpdateEnvelope } from '../../../src/ash/platform/agentHost/common/agent.js';
import { BrowserLayoutService, ILayoutService } from '../../../src/ash/platform/layout/browser/layoutService.js';
import { AccessibleViewType, IAccessibleViewService } from '../../../src/ash/platform/accessibility/browser/accessibleView.js';
import { AccessibilityService } from '../../../src/ash/platform/accessibility/browser/accessibilityService.js';
import { IAccessibilityService } from '../../../src/ash/platform/accessibility/common/accessibility.js';
import { AccessibleViewService } from '../../../src/ash/workbench/contrib/accessibility/browser/accessibleView.js';
import '../../../src/ash/workbench/contrib/chat/browser/chat.contribution.js';
import '../../../src/ash/base/browser/ui/styles.css';
import '../../../src/ash/base/browser/markdownRenderer.css';
import '../../../src/ash/sessions/contrib/chat/browser/media/chatInput.css';
import '../../../src/ash/editor/browser/coreCommands.js';
import { Disposable, DisposableStore } from '../../../src/ash/base/common/lifecycle.js';
import { Lexer } from '../../../src/ash/base/common/marked/marked.js';
import { Emitter, Event } from '../../../src/ash/base/common/event.js';
import { URI } from '../../../src/ash/base/common/uri.js';
import { Selection } from '../../../src/ash/editor/common/core/selection.js';
import { IModelService } from '../../../src/ash/editor/common/services/model.js';
import { ILanguageService } from '../../../src/ash/editor/common/languages/language.js';
import { IMarkerService } from '../../../src/ash/platform/markers/common/markers.js';
import { IInstructionService } from '../../../src/ash/platform/instructions/common/instructionService.js';
import { TextModel } from '../../../src/ash/editor/common/model/textModel.js';
import { CodeEditorWidget } from '../../../src/ash/editor/browser/widget/codeEditor/codeEditorWidget.js';
import { CodeBlockPart } from '../../../src/ash/workbench/contrib/chat/browser/widget/chatContentParts/codeBlockPart.js';
import { ICodeEditorService } from '../../../src/ash/editor/browser/services/codeEditorService.js';
import { registerCodeEditorServices } from '../../../src/ash/editor/test/browser/testCodeEditor.js';
import { StandaloneCommandService } from '../../../src/ash/editor/standalone/browser/standaloneServices.js';
import { createTestEditorServices } from '../../../src/ash/workbench/test/common/testEditorServices.js';
import { chatTranscriptListItems, type ChatStreamingResponseUpdate, type IChatListItem } from '../../../src/ash/workbench/contrib/chat/common/model/chatViewModel.js';
import { createAppServerAgentThreadService, createDisconnectedAgentHostInputCompletionService } from '../../../src/ash/platform/agentHost/browser/appServerAgentService.js';
import { ChatWidget, type IChatWidgetModel } from '../../../src/ash/workbench/contrib/chat/browser/widget/chatWidget.js';
import { IMenuService } from '../../../src/ash/platform/actions/common/actions.js';
import { MenuService } from '../../../src/ash/platform/actions/common/menuService.js';
import { IContextViewService, IContextMenuService } from '../../../src/ash/platform/contextview/browser/contextView.js';
import { IContextKeyService } from '../../../src/ash/platform/contextkey/browser/contextKeyService.js';
import { IHostService } from '../../../src/ash/workbench/services/host/browser/host.js';
import { IsSessionsWindowContext } from '../../../src/ash/workbench/common/contextkeys.js';
import { SessionsWorkspaceModeContext } from '../../../src/ash/sessions/common/contextkeys.js';
import '../../../src/ash/sessions/contrib/chat/browser/chatRunAnotherVersionActions.js';
import { BrowserContextViewService } from '../../../src/ash/platform/contextview/browser/contextViewService.js';
import { ISpeechService, SpeechToTextStatus, type ISpeechToTextEvent } from '../../../src/ash/workbench/contrib/speech/common/speechService.js';
import { ExtensionIdentifier } from '../../../src/ash/platform/extensions/common/extensions.js';
import { IChatWidgetService, type IChatWidget, unwrapChatResponseActionContext } from '../../../src/ash/workbench/contrib/chat/browser/chat.js';
import { ChatCopyActionRendering } from '../../../src/ash/workbench/contrib/chat/browser/actions/chatCopyActions.js';
import { IPreferencesService } from '../../../src/ash/workbench/services/preferences/common/preferences.js';
import { SpeechService } from '../../../src/ash/workbench/contrib/speech/browser/speechService.js';
import { IVoiceCodeTranscriptionBackendService } from '../../../src/ash/platform/dictation/common/dictation.js';
import { IDialogService } from '../../../src/ash/platform/dialogs/common/dialogs.js';
import { ILanguageModelsService } from '../../../src/ash/workbench/contrib/chat/common/languageModels.js';
import { IChatSessionNavigationService } from '../../../src/ash/workbench/services/chat/common/chatSessionNavigationService.js';
import { IChatService, type RestoreChatCheckpointOptions } from '../../../src/ash/workbench/services/chat/common/chatService.js';
import { IOpenerService } from '../../../src/ash/platform/opener/common/opener.js';
import type { ChatContentPart, ThreadTranscriptEntry } from '../../../src/ash/platform/agentHost/common/agent.js';
import { ChatListWidget } from '../../../src/ash/workbench/contrib/chat/browser/widget/chatListWidget.js';
import { ChatContentMarkdownRenderer } from '../../../src/ash/workbench/contrib/chat/browser/widget/chatContentMarkdownRenderer.js';
import { WorkbenchContributionsRegistry, WorkbenchPhase } from '../../../src/ash/workbench/common/contributions.js';
import { EditorExtensionsRegistry } from '../../../src/ash/editor/browser/editorExtensions.js';
import { SuggestController } from '../../../src/ash/editor/contrib/suggest/browser/suggestController.js';
import '../../../src/ash/editor/contrib/hover/browser/hoverContribution.js';
import { IEditorService } from '../../../src/ash/workbench/services/editor/common/editorService.js';
import { IEditorPart } from '../../../src/ash/workbench/browser/parts/editor/editorPart.js';
import { IUntitledTextEditorService } from '../../../src/ash/workbench/services/untitled/common/untitledTextEditorService.js';
import { IClipboardService } from '../../../src/ash/platform/clipboard/common/clipboardService.js';
import { CommandsRegistry, ICommandService } from '../../../src/ash/platform/commands/common/commands.js';
import { ChatContextKeys } from '../../../src/ash/workbench/contrib/chat/common/actions/chatContextKeys.js';
import { ForkConversationActionId, type IForkConversationOptions } from '../../../src/ash/workbench/contrib/chat/browser/actions/chatForkActions.js';
import { CommandService } from '../../../src/ash/workbench/services/commands/common/commandService.js';
import { BrowserClipboardService } from '../../../src/ash/platform/clipboard/browser/clipboardService.js';
import { MainThreadSpeech } from '../../../src/ash/workbench/api/browser/mainThreadSpeech.js';
import { IExtensionHostApi, type ExtensionHostFleetSnapshot, type JsonValue } from '../../../src/ash/platform/extensions/common/extensionHostApi.js';
import { IConfigurationService } from '../../../src/ash/platform/configuration/common/configuration.js';
import { ChatAIDisabledSettingId } from '../../../src/ash/platform/chat/common/chatSettings.js';
import { ViewDescriptorService } from '../../../src/ash/workbench/services/views/browser/viewDescriptorService.js';
import { CHAT_VIEW_CONTAINER_ID, CHAT_VIEW_ID } from '../../../src/ash/workbench/contrib/chat/common/chat.js';
import '../../../src/ash/sessions/browser/workbenchChat.contribution.js';
import { INotificationService } from '../../../src/ash/platform/notification/common/notification.js';
import { IThemeService } from '../../../src/ash/platform/theme/common/themeService.js';
import { bindTestColorTheme } from './themeFixture.js';
import { darkColorTheme, lightColorTheme, highContrastDarkColorTheme, highContrastLightColorTheme } from '../../../src/ash/platform/theme/common/colorTheme.js';
import { TestThemeService } from '../../../src/ash/platform/theme/test/common/testThemeService.js';
import { localize } from '../../../src/ash/nls.js';
import type { IChatSessionHistoryStatus } from '../../../src/ash/platform/chat/common/chatSessionHistory.js';
import { decodeAppServerResponse } from '../../../.build/protocol/typescript/AppServerProtocolDecoder.js';
import type { SessionThreadReadResult } from '../../../.build/protocol/typescript/index.js';
import { ChatSessionArchiveActionWordingSettingId } from '../../../src/ash/platform/chat/common/sessionArchiveActions.js';
import { createDisconnectedRendererApi } from '../../../src/ash/workbench/browser/rendererApi.js';
import { IAgentSessionService, IAgentTurnService } from '../../../src/ash/platform/agentHost/common/agentService.js';
import { type AgentSession } from '../../../src/ash/platform/agentHost/common/agent.js';
import { IAgentModelsService } from '../../../src/ash/platform/models/common/agentModels.js';
import { IAppServerApi, IServerEventApi } from '../../../src/ash/platform/agentHost/common/appServerApi.js';
import { SessionsChatCopyActionRendering } from '../../../src/ash/sessions/contrib/chat/browser/chatCopyActionRendering.js';
import { AppServerSessionsProvider } from '../../../src/ash/sessions/contrib/providers/agentHost/browser/appServerSessionsProvider.js';
import { SessionsManagementService } from '../../../src/ash/sessions/services/sessions/browser/sessionsManagementService.js';
import { ISessionsManagementService } from '../../../src/ash/sessions/services/sessions/common/sessionsManagement.js';
import { TestConfigurationService as WorkbenchConfigurationService } from '../../../src/ash/workbench/services/configuration/test/common/testServices.js';

if (new URLSearchParams(location.search).has('workbench')) {
	await import('../../../src/ash/workbench/browser/media/style.css');
	document.body.classList.add('ash-workbench');
}
const resources = new DisposableStore();
setIconResolver(document, icon => getIconDefinition(icon));
const appLogs: LogEntry[] = [];
const parentServices = resources.add(new InstantiationService());
const windowLogger = resources.add(new LogService({ level: LogLevel.Debug, sinks: [{ log: entry => appLogs.push(entry) }] }));
parentServices.registerInstance(ILogService, windowLogger);
parentServices.registerInstance(ILoggerService, windowLogger);
const services = resources.add(createTestEditorServices(resources.add(new WorkbenchConfigurationService()), parentServices, document));
services.registerSingleton(IChatOutputPartStateCache, () => new ChatOutputPartStateCache());
services.registerInstance(IAccessibilityService, resources.add(new AccessibilityService({
	root: document.body, contextKeyService: services.get(IContextKeyService), configurationService: services.get(IConfigurationService),
})));
services.registerInstance(IInstructionService, { isAvailable: false, list: async () => [] });
services.registerInstance(IContentSearchService, new FileContentSearchService(services.get(IFileService)));
services.registerSingleton(ISearchService, () => services.createInstance(SearchService));
// This fixture hosts standalone editors rather than tabbed Workbench groups.
services.registerInstance(IEditorGroupsService, { groups: [] } as unknown as IEditorGroupsService);
services.registerInstance(IAgentHostInputCompletionService, createDisconnectedAgentHostInputCompletionService());
services.registerSingleton(IImageEditorService, () => new class extends ImageEditorService {
	async capture(): Promise<never> { throw new Error('Image capture is outside this transcript fixture'); }
}());
const theme = services.get(IThemeService) as TestThemeService;
const dialogs = resources.add(new DialogService());
services.registerInstance(IDialogService, dialogs);
services.registerInstance(IDialogsModel, dialogs.model);
resources.add(new DialogHandlerContribution(dialogs.model, new BrowserDialogHandler(document.body)));
resources.add(bindTestColorTheme(theme, document.body));
let clipboardText = '';
let clipboardImage: number[] = [];
let clipboardReady = Promise.resolve();
let releaseClipboard!: () => void;
let clipboardFailure = false;
class Clipboard extends BrowserClipboardService {
	constructor() { super(undefined); }
	public override async writeText(text: string): Promise<void> { await clipboardReady; if (clipboardFailure) throw new Error('clipboard rejected'); clipboardText = text; }
	public override async writeImage(data: Uint8Array | Promise<Uint8Array>): Promise<void> { clipboardImage = [...await data]; }
}
services.registerInstance(IClipboardService, resources.add(new Clipboard()));
services.registerSingleton(ICommandService, () => services.createInstance(StandaloneCommandService));
const builtinTranscripts = resources.add(new Emitter<{ resourceId: string; text: string; isFinal: boolean; }>());
const builtinOperations: string[] = [];
let builtinResource: string | undefined;
let retiredBuiltinResource: string | undefined;
let builtinStop: DeferredPromise<void> | undefined;
let builtinAudio: ReturnType<typeof installTestDictationAudio> | undefined;
const builtinBackend = new URLSearchParams(location.search).get('builtinBackend');
if (builtinBackend) {
	const modelStatus = resources.add(new Emitter<{ resourceId: string; model: string; status: IDictationModelStatus; }>());
	const start = async (resourceId: string) => { builtinResource = resourceId; builtinOperations.push('start'); };
	const stop = async (resourceId: string) => {
		builtinOperations.push('stop');
		await builtinStop?.p;
		builtinTranscripts.fire({ resourceId, text: 'built-in final', isFinal: true });
		return 'built-in final';
	};
	const cancel = async (resourceId: string) => { retiredBuiltinResource = resourceId; builtinOperations.push('cancel'); };
	services.registerInstance(IVoiceCodeTranscriptionBackendService, {
		readInstructions: async () => { throw new Error('This transcript fixture does not provide Profile instructions'); },
		writeInstructions: async () => { throw new Error('This transcript fixture does not provide Profile instructions'); },
		isConnected: true, onDidChangeConnection: Event.None, onDidTranscribe: builtinTranscripts.event, onDidEnd: Event.None,
		getOptions: async () => ({ inputDevices: [], languages: [] }), start, stop, cancel,
		pushAudio: async (_resourceId, audio) => { builtinOperations.push(`audio:${atob(audio).length}`); },
	});
	services.registerInstance(ILocalTranscriptionBackendService, {
		isConnected: true, onDidDisconnect: Event.None, onDidTranscribe: builtinTranscripts.event, onDidEnd: Event.None, onDidChangeModels: Event.None, onDidChangeModelStatus: modelStatus.event,
		getModelCacheInfo: async () => ({ directory: '/fixture/models', version: 1 }),
		getModelStatus: async model => ({ model, available: true, sizeBytes: 1024 }), listModels: async () => [],
		cancelModel: async () => { throw new Error('Unexpected model cancellation'); }, deleteModel: async () => { throw new Error('Unexpected model deletion'); },
		startModelOperation: async () => { throw new Error('Unexpected model preparation'); }, stopModelOperation: async () => { throw new Error('Unexpected model operation'); },
		async start(resourceId, model) {
			await start(resourceId);
			modelStatus.fire({ resourceId, model, status: { state: DictationModelState.Ready } });
		},
		stop, cancel, pushAudio: async (_resourceId, audio) => { builtinOperations.push(`audio:${audio.byteLength}`); },
	});
	services.registerSingleton(ILocalTranscriptionService, () => services.createInstance(LocalTranscriptionService));
	services.registerSingleton(ILocalTranscriptionModelService, () => services.get(ILocalTranscriptionService) as LocalTranscriptionService);
	services.registerSingleton(IVoiceCodeTranscriptionClient, () => services.createInstance(VoiceCodeTranscriptionClient));
} else {
	services.registerInstance(IVoiceCodeTranscriptionBackendService, undefined);
}
services.registerInstance(IPreferencesService, { openSettings: async () => { throw new Error('Unexpected introduction settings'); } } as unknown as IPreferencesService);
registerTestVoiceInputServices(services);
const copyPresentationQuery = new URLSearchParams(location.search);
if (copyPresentationQuery.has('sessionsCopyFeedback') || copyPresentationQuery.has('codeCard')) {
	resources.add(services.createInstance(SessionsChatCopyActionRendering));
} else {
	resources.add(services.createInstance(ChatCopyActionRendering));
}
services.registerSingleton(ISpeechService, () => services.createInstance(SpeechService));
if (!services.has(IChatSpeechToTextService)) services.registerSingleton(IChatSpeechToTextService, () => services.createInstance(ChatSpeechToTextService));
services.registerSingleton(ITerminalLogService, () => services.createInstance(TerminalLogService));
services.registerInstance(ILanguageModelsService, { listModelCatalog: async () => [] } as unknown as ILanguageModelsService);
services.registerSingleton(ILanguageModelToolsService, () => createTestLanguageModelToolsService({ isAvailable: true, read: async () => ({ tools: [{ name: 'read_file', description: 'Read authorized files', source: 'local', sourceDetails: ['Ash'], exposure: 'direct', authority: 'directoryRead' }, { name: 'internal_tool', description: 'Internal', source: 'local', sourceDetails: [], exposure: 'hidden', authority: 'providerDefined' }], toolSets: [], sourceGroups: [] }) }));
registerCodeEditorServices(services);
services.registerSingleton(IDiffService, () => services.createInstance(DiffService));
const skillResourceRequests: unknown[] = [];
const prompts = resources.add(new PromptsService({
	onDidChangeSkills: Event.None,
	list: async () => ({ generation: 1, skills: [{ id: { source: 'user:review', name: 'review' }, description: 'Review', contentDigest: `sha256:${'a'.repeat(64)}`, enabled: true, compatible: true }] }),
	read: async () => { throw new Error('Unexpected management read'); }, registerSource: async () => { throw new Error('Unexpected skill source registration'); }, setEnabled: async () => { },
	readTextResource: async (reference, path, _signal, sessionId) => {
		skillResourceRequests.push([reference, path, sessionId]);
		if (path === 'SKILL.md') return '---\nname: review\ndescription: Review changes\n---\n[Guide](references/guide.md)';
		if (path === 'references/guide.md') return 'Reference guide.\n\n[Next](nested/checks.md)';
		if (path === 'references/nested/checks.md') return 'Nested reference.';
		throw new Error('Skill resource unavailable');
	},
}, { onDidChangeHooks: Event.None, list: async () => { throw new Error('Unexpected Hook read in Skill fixture'); } }));
services.registerInstance(IPromptsService, prompts);
if (!services.has(IChatEntitlementService)) services.registerSingleton(IChatEntitlementService, () => services.createInstance(getSingletonServiceDescriptors().find(([id]) => id === IChatEntitlementService)![1]));
const promptContributions = resources.add(WorkbenchContributionsRegistry.createHost(services, error => { throw error; }, ['chat.promptLanguageFeatures', 'chatResponseResourceWorkbenchContribution', 'workbench.contrib.chatSetup']));
promptContributions.advance(WorkbenchPhase.BlockStartup);
const chatViews = resources.add(services.createInstance(ViewDescriptorService, {}));
resources.add(services.get(IConfigurationService).onDidChangeConfiguration(event => {
	if (event.affectsConfiguration(ChatAIDisabledSettingId)) chatChanges.fire();
}));
const fileContainer = document.createElement('section');
fileContainer.style.cssText = 'width:600px;height:140px';
fileContainer.setAttribute('aria-label', 'File editor');
document.body.append(fileContainer);
resources.add(services.get(ILanguageService).registerLanguage({ id: 'markdown', extensions: ['.md'] }));
resources.add(services.get(ILanguageService).registerLanguage({ id: 'typescript', extensions: ['.ts'] }));
const promptFile = new URLSearchParams(location.search).has('prompt');
const fileModel = services.get(IModelService).createModel(promptFile ? '---\n\n---\nBody' : 'before after',
	services.get(ILanguageService).createById(promptFile ? 'markdown' : 'typescript'),
	URI.parse(promptFile ? 'inmemory://fixture/review/SKILL.md' : 'inmemory://fixture/file.ts'));
if (!(fileModel instanceof TextModel)) throw new TypeError('Expected the registered Stanza model');
resources.add(fileModel);
const file = resources.add(services.createInstance(CodeEditorWidget, {
	container: fileContainer, model: fileModel,
	contributions: promptFile ? EditorExtensionsRegistry.getSomeEditorContributions([SuggestController.ID, 'editor.contrib.hover', LinkDetector.ID]) : [],
}));
file.layout({ width: 600, height: 140 });
file.setSelection(promptFile ? new Selection(2, 1, 2, 1) : new Selection(1, 8, 1, 8));
let activeResource = fileModel.uri;
resources.add(services.get(ICodeEditorService).registerCodeEditorOpenHandler(async input => {
	if (input.resource.authority !== 'skill') return null;
	const reference = resources.add(await services.get(ITextModelService).createModelReference(input.resource));
	if (!(reference.object.textEditorModel instanceof TextModel)) throw new TypeError('Expected a resolved Stanza model');
	activeResource = input.resource;
	file.setModel(reference.object.textEditorModel);
	file.updateOptions({ readOnly: reference.object.isReadonly() !== false });
	file.focus();
	return file;
}));
services.registerInstance(IEditorPart, { get activePane() { return { getControl: () => file }; } } as unknown as IEditorPart);
let mediaPreview: ImagePreviewEditor | MediaPreview | undefined;
let mediaPreviewRoot: HTMLElement | undefined;
services.registerInstance(IEditorService, {
	onDidActiveEditorChange: Event.None, onDidVisibleEditorsChange: Event.None,
	get activeEditor() { return { resource: activeResource }; },
	activeEditorPane: undefined, visibleEditorPanes: [],
	get visibleEditors() { return [{ resource: activeResource }]; },
	openEditor: async input => {
		if (input.resource.scheme === 'chat-response-resource' && /\.(?:png|jpeg|gif|webp|wav|mp3|m4a|webm|ogg)$/u.test(input.resource.path)) {
			mediaPreview?.dispose();
			mediaPreviewRoot?.remove();
			const previewServices = resources.add(services.createChild());
			previewServices.registerInstance(IAccessibleViewService, accessibleView);
			previewServices.registerInstance(IContextMenuService, { contextMenuStyle: 'custom', showContextMenu() { }, hideContextMenu() { }, onDidShowContextMenu: Event.None, onDidHideContextMenu: Event.None });
			mediaPreviewRoot = document.createElement('section');
			mediaPreviewRoot.style.cssText = 'height:240px;width:600px';
			document.body.append(mediaPreviewRoot);
			mediaPreview = /\.(?:png|jpeg|gif|webp)$/u.test(input.resource.path) ? resources.add(previewServices.createInstance(ImagePreviewEditor)) : resources.add(previewServices.createInstance(MediaPreview, 'audio', 'Audio'));
			mediaPreview.create(mediaPreviewRoot);
			await mediaPreview.setInput({ resource: input.resource, readOnly: input.readOnly }, new AbortController().signal);
			mediaPreview.setVisible(true);
			mediaPreview.layout({ width: 600, height: 240 });
			mediaPreview.focus();
			activeResource = input.resource;
			return;
		}
		if (input.resource.scheme === 'chat-response-resource') {
			const bytes = await services.get(IFileService).readFileBytes(input.resource);
			const model = services.get(IModelService).getModel(input.resource) ?? services.get(IModelService).createModel(new TextDecoder('utf-8', { fatal: true }).decode(bytes.bytes), services.get(ILanguageService).createByFilepathOrFirstLine(input.resource), input.resource);
			if (!(model instanceof TextModel)) throw new TypeError('Expected a resource model');
			file.setModel(model);
			file.updateOptions({ readOnly: input.readOnly });
			activeResource = input.resource;
			return;
		}
		const model = await services.get(IUntitledTextEditorService).resolve({ untitledResource: input.resource });
		activeResource = input.resource;
		file.setModel(model.textEditorModel!);
	},
	save: async () => ({ success: true, editors: [] }), saveAll: async () => ({ success: true, editors: [] }),
	focusActiveEditor: () => file.focus(),
});
const root = document.createElement('main');
root.style.cssText = 'display:flex;width:600px;height:400px';
document.body.append(root);
services.registerInstance(ILayoutService, resources.add(new BrowserLayoutService({ root: document.body })));
const accessibleView = resources.add(services.createInstance(AccessibleViewService));
services.registerInstance(IAccessibleViewService, accessibleView);
let imageReads = 0;
const openedAppLinks: { uri: string; options: unknown; }[] = [];
services.registerInstance(IChatService, {
	movePendingRequest: async () => { throw new Error('Unexpected queue reorder'); },
} satisfies Pick<IChatService, 'movePendingRequest'> as unknown as IChatService);
const appServices = resources.add(services.createChild());
if (new URLSearchParams(location.search).has('sentImageViewer')) {
	ChatContextKeys.imagePreviewPresentation.bindTo(appServices.get(IContextKeyService)).set('popup');
	appServices.registerInstance(IHostService, {
		hasFocus: true, onDidChangeFocus: Event.None, getWindows: async () => [],
		openWindow: async () => { }, restart: async () => { }, reload: async () => { }, getScreenshot: async () => undefined,
		showToast: async () => ({ supported: false, clicked: false }),
	});
}
appServices.registerInstance(IOpenerService, { open: async (uri: URI, options: unknown) => { openedAppLinks.push({ uri: uri.toString(), options }); return true; } } as unknown as IOpenerService);
let turnFiles: readonly Omit<ChatTurnFileChange, 'review'>[] = [];
let messageReferences: readonly { readonly id: string; readonly label: string; readonly target: string; }[] = [];
const listOptions = {
	codeBlockPresentation: new URLSearchParams(location.search).has('codeCard') ? 'card' as const : undefined,
	openTurnChanges: new URLSearchParams(location.search).has('turnChanges') ? async (source: NonNullable<IChatListItem['feedbackSource']>) => {
		root.dataset.openedTurn = JSON.stringify(source);
	} : undefined,
	getTurnChanges: new URLSearchParams(location.search).has('turnChanges') ? (source: ChatTurnChangeSource) => ({
		files: turnFiles.length, insertions: 3, deletions: 1,
		review: () => { root.dataset.openedTurn = JSON.stringify(source); },
		fileDiffs: turnFiles.map(file => ({
			...file, review: () => { root.dataset.openedTurnFile = JSON.stringify({ source, id: file.id }); },
		})),
	}) : undefined,
	messagePresentation: new URLSearchParams(location.search).has('messageReferences') ? {
		user: { name: 'You' }, assistant: { name: 'Assistant' },
		getReferences: () => messageReferences.map(reference => ({
			id: reference.id, label: reference.label,
			open: () => { root.dataset.openedMessageReference = reference.target; },
		})),
	} : undefined,
	promptTimelineChanges: new URLSearchParams(location.search).has('promptTimeline')
		? (prompt: IChatListItem) => prompt.id === 'second' ? {
			files: 1, insertions: 2, deletions: 1,
			review: () => { root.dataset.reviewedTurn = prompt.id; },
			fileDiffs: [{
				id: 'change', path: 'src/example.ts', additions: 2, deletions: 1,
				review: () => { root.dataset.reviewedPrompt = prompt.id; },
			}],
		} : undefined : undefined,
	imageResourceLoader: async () => { imageReads++; return new Blob([new Uint8Array(imageBytes)], { type: 'image/png' }); } };
let rendererItems: readonly IChatListItem[] = [];
let list = resources.add(appServices.createInstance(ChatListWidget, root, listOptions));
list.setVisible(true);
const toolNotifications = resources.add(new Emitter<ServerNotification>());
const connectionChanges = resources.add(new Emitter<void>());
const appHtml = `<h1>Report</h1><output id="context"></output><output id="input"></output><output id="result"></output><output id="called"></output><output id="resource"></output><output id="binary"></output><output id="catalog"></output><output id="link-result"></output><output id="mode-result"></output><input id="link-url" aria-label="App link URL" value="https://example.com/report?view=8#result"><button id="open-link">Open external link</button><button id="fullscreen">Fullscreen</button><button id="inline">Inline</button><button id="pip">Picture in picture</button><button id="list-tools">List tools</button><output id="error"></output><output id="capabilities"></output><output id="context-ack"></output><output id="message-ack"></output><input aria-label="App context text" id="context-text" value="First context"><button id="update-context">Update context</button><button id="image-context">Image context</button><button id="clear-context">Clear context</button><button id="bad-image-context">Invalid image context</button><button id="bad-image-data">Undecodable image context</button><button id="audio-context">Unsupported audio context</button><output id="image-ack"></output><button id="resource-context">Resource context</button><button id="binary-context">Binary resource context</button><button id="cancel-context">Cancel resource context</button><output id="resource-context-ack"></output><button id="send-message">Send Chat message</button><button id="mixed-message">Send image message</button><button id="image-only-message">Send image only</button><button id="cancel-message">Cancel image message</button><button id="invalid-message">Invalid role</button><button id="increment">Increment</button><button id="call">Call tool</button><button id="cancel">Cancel call</button><button id="unsupported">Unsupported</button><button id="read">Read resource</button><button id="binary-read">Read binary</button><button id="logs">Send logs</button><button id="invalid-log">Invalid log</button><button id="large-log">Large log</button><button id="flood-log">Flood logs</button><output id="download-result"></output><button id="download-inline">Download inline</button><button id="download-linked">Download linked</button><button id="download-invalid">Invalid download</button><button id="download-cancel">Cancel download</button><output id="count">0</output>
<script>
let count = 0;
let callId = 1;
let imageMessageId = 213;
const rpc = message => parent.postMessage({jsonrpc:'2.0',...message}, '*');
window.addEventListener('message', event => {
  if (event.source !== parent) return;
  const message = event.data;
  if (message.id === 1 && message.result) {
    document.querySelector('#context').textContent = JSON.stringify(message.result.hostContext);
    document.querySelector('#capabilities').textContent = JSON.stringify(message.result.hostCapabilities);
    rpc({method:'ui/notifications/initialized',params:{}});
    rpc({method:'ui/notifications/size-changed',params:{height:240}});
  } else if (message.method === 'ui/notifications/tool-input') {
    document.querySelector('#input').textContent = JSON.stringify(message.params);
  } else if (message.method === 'ui/notifications/tool-result') {
    document.querySelector('#result').textContent = JSON.stringify(message.params);
  } else if (message.method === 'ui/notifications/host-context-changed') {
    document.querySelector('#context').textContent = JSON.stringify(message.params);
  } else if (message.error) document.querySelector('#error').textContent = JSON.stringify(message.error);
  else if (message.result && message.id === 201) document.querySelector('#context-ack').textContent = JSON.stringify(message.result);
  else if (message.result && message.id === 213) document.querySelector('#resource-context-ack').textContent = JSON.stringify(message.result);
  else if (message.result && (message.id === 211 || message.id === 212)) document.querySelector('#image-ack').textContent = JSON.stringify(message.result);
  else if (message.result && (message.id === 202 || message.id >= 214 && message.id <= 260)) document.querySelector('#message-ack').textContent = JSON.stringify(message.result);
  else if (message.result && message.id === 103) document.querySelector('#link-result').textContent = JSON.stringify(message.result);
  else if (message.result && message.id === 301) document.querySelector('#download-result').textContent = JSON.stringify(message.result);
  else if (message.result && message.id === 104) document.querySelector('#mode-result').textContent = JSON.stringify(message.result);
  else if (message.result && message.id === 102) document.querySelector('#catalog').textContent = JSON.stringify(message.result);
  else if (message.result && message.id === 100) document.querySelector('#resource').textContent = JSON.stringify(message.result);
  else if (message.result && message.id === 101) document.querySelector('#binary').textContent = JSON.stringify(message.result);
  else if (message.result && message.id === callId) document.querySelector('#called').textContent = JSON.stringify(message.result);
  else if (message.method === 'ui/resource-teardown') rpc({id:message.id,result:{}});
});
document.querySelector('#increment').onclick = () => { document.querySelector('#count').textContent = ++count; };
document.querySelector('#call').onclick = () => rpc({id:++callId,method:'tools/call',params:{name:'edit',arguments:{value:8}}});
document.querySelector('#read').onclick = () => { callId = 100; rpc({id:callId,method:'resources/read',params:{uri:'file:///server/report.json'}}); };
document.querySelector('#open-link').onclick = () => rpc({id:103,method:'ui/open-link',params:{url:document.querySelector('#link-url').value}});
for (const mode of ['fullscreen','inline','pip']) document.querySelector('#'+mode).onclick = () => rpc({id:104,method:'ui/request-display-mode',params:{mode}});
document.querySelector('#list-tools').onclick = () => rpc({id:102,method:'tools/list'});
document.querySelector('#binary-read').onclick = () => rpc({id:101,method:'resources/read',params:{uri:'mcp://server/blob'}});
document.querySelector('#cancel').onclick = () => rpc({method:'notifications/cancelled',params:{requestId:callId}});
document.querySelector('#update-context').onclick = () => rpc({id:201,method:'ui/update-model-context',params:{content:[{type:'text',text:document.querySelector('#context-text').value}],structuredContent:{value:8}}});
document.querySelector('#image-context').onclick = () => { document.querySelector('#image-ack').textContent=''; rpc({id:211,method:'ui/update-model-context',params:{content:[{type:'text',text:'Image context'}, {type:'image',mimeType:'image/png',data:'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADklEQVR4nGP4z8DwHwQBEPgD/U6VwW8AAAAASUVORK5CYII='}]}}); };
document.querySelector('#clear-context').onclick = () => { document.querySelector('#image-ack').textContent=''; rpc({id:212,method:'ui/update-model-context',params:{content:[]}}); };
document.querySelector('#bad-image-context').onclick = () => rpc({id:211,method:'ui/update-model-context',params:{content:[{type:'image',mimeType:'image/png',data:'AB=='}]}});
document.querySelector('#bad-image-data').onclick = () => rpc({id:211,method:'ui/update-model-context',params:{content:[{type:'image',mimeType:'image/png',data:'eA=='}]}});
document.querySelector('#audio-context').onclick = () => rpc({id:211,method:'ui/update-model-context',params:{content:[{type:'audio',mimeType:'audio/wav',data:'eA=='}]}});
document.querySelector('#resource-context').onclick = () => { document.querySelector('#resource-context-ack').textContent=''; rpc({id:213,method:'ui/update-model-context',params:{content:[{type:'resource',resource:{uri:'file:///ignored/source',mimeType:'application/octet-stream',text:'Embedded <safe>',_meta:{private:'private-inline'}}},{type:'resource',resource:{uri:'file:///ignored/binary',mimeType:'text/plain',blob:'aGVsbG8='}},{type:'resource_link',uri:'https://server/report/data',name:'linked.json'}]}}); };
document.querySelector('#binary-context').onclick = () => rpc({id:213,method:'ui/update-model-context',params:{content:[{type:'resource_link',uri:'mcp://server/blob',name:'binary'}]}});
document.querySelector('#cancel-context').onclick = () => rpc({method:'notifications/cancelled',params:{requestId:213}});


document.querySelector('#send-message').onclick = () => rpc({id:202,method:'ui/message',params:{role:'user',content:[{type:'text',text:'Follow-up from App'}]}});
const messageImage = {type:'image',mimeType:'image/png',data:'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADklEQVR4nGP4z8DwHwQBEPgD/U6VwW8AAAAASUVORK5CYII='};
document.querySelector('#mixed-message').onclick = () => { document.querySelector('#message-ack').textContent=''; rpc({id:++imageMessageId,method:'ui/message',params:{role:'user',content:[{type:'text',text:'Read image'},messageImage,{type:'resource',resource:{uri:'file:///message/report',text:'Message report',_meta:{private:'private-message-only'}}}]}}); };
document.querySelector('#image-only-message').onclick = () => { document.querySelector('#message-ack').textContent=''; rpc({id:++imageMessageId,method:'ui/message',params:{role:'user',content:[messageImage]}}); };
document.querySelector('#cancel-message').onclick = () => rpc({method:'notifications/cancelled',params:{requestId:imageMessageId}});

document.querySelector('#invalid-message').onclick = () => rpc({id:203,method:'ui/message',params:{role:'system',content:{type:'text',text:'untrusted instruction'}}});
document.querySelector('#unsupported').onclick = () => rpc({id:99,method:'sampling/createMessage',params:{}});
document.querySelector('#download-inline').onclick = () => rpc({id:301,method:'ui/download-file',params:{contents:[{type:'resource',resource:{uri:'file:///app/export.txt',mimeType:'text/plain',text:'中文\\r\\n<safe>\\r\\n'}}]}});
document.querySelector('#download-linked').onclick = () => rpc({id:301,method:'ui/download-file',params:{contents:[{type:'resource_link',uri:'mcp://report/blob.bin',name:'../report.bin'}]}});
document.querySelector('#download-invalid').onclick = () => rpc({id:301,method:'ui/download-file',params:{contents:[{type:'resource',resource:{uri:'mcp://report/blob.bin',blob:'Zh==',mimeType:'application/octet-stream'}}]}});
document.querySelector('#download-cancel').onclick = () => rpc({method:'notifications/cancelled',params:{requestId:301}});
document.querySelector('#logs').onclick = () => { for (const level of ['debug','info','notice','warning','error','critical','alert','emergency']) rpc({method:'notifications/message',params:{level,logger:'report',data:{value:8,text:'<script>unsafe()<\\/script>\\nnext line'}}}); };
document.querySelector('#invalid-log').onclick = () => rpc({method:'notifications/message',params:{level:'other',data:'invalid'}});
document.querySelector('#large-log').onclick = () => rpc({method:'notifications/message',params:{level:'info',data:'x'.repeat(9000)}});
document.querySelector('#flood-log').onclick = () => { for (let i=0;i<50;i++) rpc({method:'notifications/message',params:{level:'info',data:i}}); };
rpc({id:1,method:'ui/initialize',params:{protocolVersion:'2026-01-26',appInfo:{name:'report',version:'1'},appCapabilities:{availableDisplayModes:['inline']}}});
</script>`;
let appRequests = false;
let allowAppCsp = false;
let appCallMode: 'read' | 'delay' | 'error' = 'read';
let appItems: readonly IChatListItem[] = [];
let hasConversationChanges = false;
let responseWorking = false;
let appChat: ChatWidget | NativeChatWidget | undefined;
let composerServices: InstantiationService | undefined;
let dictationEvents: Emitter<ISpeechToTextEvent> | undefined;
let dictationStarts = 0;
let dictationCancels = 0;
const createBitmap = window.createImageBitmap.bind(window);
let completeImageDecode: (() => void) | undefined;
let appChatThread = 'app-thread';
let appChatGeneration = 0;
let historyFailure: IChatSessionHistoryStatus | undefined;
let finishHistory: (() => void) | undefined;
let historyRecoveries = 0;
let olderHistoryState: { loading: boolean; error?: string; } | undefined;
let finishOlderHistory: (() => void) | undefined;
let failOlderHistory = false;
let olderHistoryLoads = 0;
const historyWires = new Map<string, string>();
let historyDecodeTiming = { parseMs: 0, schemaMs: 0, bytes: 0 };
let requestEditMode = false;
const requestEdits: { readonly text: string; readonly commandId: string; readonly itemId: string; readonly contexts?: readonly { readonly name: string; readonly content: string; }[]; }[] = [];
let completeRequestEdit: ((failure?: boolean) => void) | undefined;
const messageForks: IForkConversationOptions[] = [];
let pendingMessageFork: DeferredPromise<void> | undefined;
const checkpointRestores: RestoreChatCheckpointOptions[] = [];
const checkpointDestinations: string[] = [];
const messageRowCommands: { id: string; args: readonly unknown[]; }[] = [];
let lifecycleSessions: SessionsManagementService | undefined;
let lifecycleCommands: CommandService | undefined;
const lifecycleRequests: { readonly operation: string; readonly sessionId: string; }[] = [];
const lifecycleOpened: string[] = [];
const appChatMessages: unknown[] = [];
const composerChanges = resources.add(new Emitter<void>());
const chatChanges = resources.add(new Emitter<void>());
const voiceChanges = resources.add(new Emitter<void>());
const voiceTasks = resources.add(new Emitter<AgentVoiceTaskRequest>());
let voiceSession: AgentVoiceSessionState | undefined;
let chosenVoice: AgentVoiceSelection | undefined;
const voiceControls: string[] = [];
const voiceFixture: IAgentVoiceService = {
	isAvailable: true, get state() { return voiceSession; }, onDidChange: voiceChanges.event, onDidRequestTask: voiceTasks.event,
	getOptions: async () => [{
		connectionId: 'fixture', name: 'Voice fixture', defaultModel: 'other-speech',
		models: [
			{ modelId: 'other-speech', defaultVoice: 'other-voice', voices: ['other-voice'] },
			{ modelId: 'gpt-live-1', defaultVoice: 'cedar', voices: ['cedar', 'marin'] },
		],
	}],
	start: async (source, selection) => { chosenVoice = { ...selection }; voiceControls.push('start'); voiceSession = { ...source, resourceId: 'voice-media', mediaEpoch: (voiceSession?.mediaEpoch ?? 0) + 1, sequence: 1, state: 'connected', inputMode: 'openMic' as const, muted: false, listening: true, inputSequence: 0, usageMilliseconds: 0 }; voiceChanges.fire(); return voiceSession; },
	stop: async () => { voiceControls.push('stop'); if (voiceSession) voiceSession = { ...voiceSession, state: 'ended' }; voiceChanges.fire(); },
	setMuted: async muted => { voiceControls.push('mute:' + muted); if (voiceSession) voiceSession = { ...voiceSession, muted, listening: !muted && voiceSession.inputMode === 'openMic' }; voiceChanges.fire(); },
	setInputMode: async inputMode => { voiceControls.push('mode:' + inputMode); if (voiceSession) voiceSession = { ...voiceSession, inputMode, listening: !voiceSession.muted && inputMode === 'openMic' }; voiceChanges.fire(); },
	pttDown: async () => { voiceControls.push('hold'); if (voiceSession) voiceSession = { ...voiceSession, listening: true }; voiceChanges.fire(); },
	pttUp: async () => { voiceControls.push('release'); if (voiceSession) voiceSession = { ...voiceSession, listening: false }; voiceChanges.fire(); },
	interrupt: async () => { voiceControls.push('interrupt'); if (voiceSession) voiceSession = { ...voiceSession, mediaEpoch: voiceSession.mediaEpoch + 1 }; voiceChanges.fire(); },
	rejectTask: async () => { voiceControls.push('reject'); },
};
const appMessages: unknown[] = [];
const webviews = services.get(IWebviewService);
const observedViews = new Set<unknown>();
resources.add(webviews.onDidChangeActiveWebview(view => {
	if (view && !observedViews.has(view)) { observedViews.add(view); resources.add(view.onMessage(event => appMessages.push(event.message))); }
}));
let linkMode: 'read' | 'delay' | 'error' = 'read';
let linkRequests: { method: string; params: unknown; }[] = [];
let completeLink: (() => void) | undefined;
const linkBytes = new TextEncoder().encode('# Linked\r\n中文\r\n');
const toolService = createAppServerAgentThreadService({
	generation: 1,
	onStateChange: (listener: () => void) => connectionChanges.event(listener),
	onNotification: (listener: (notification: ServerNotification) => void) => toolNotifications.event(listener),
	async request(definition: { method: string; }, params: unknown) {
		if (definition.method === 'session/thread/read' || definition.method === 'session/thread/subscribe') {
			const bounded = !!(params as { history?: unknown; }).history;
			const wire = historyWires.get(`${definition.method}:${bounded}`);
			if (!wire) throw new Error('History benchmark was not prepared');
			const start = performance.now();
			const parsed: unknown = JSON.parse(wire);
			const parsedAt = performance.now();
			const decoded = decodeAppServerResponse(definition.method, parsed);
			historyDecodeTiming = { parseMs: parsedAt - start, schemaMs: performance.now() - parsedAt, bytes: wire.length };
			if ('error' in decoded) throw new Error('Unexpected history fixture error');
			return decoded.result;
		}
		linkRequests.push({ method: definition.method, params });
		switch (definition.method) {
			case 'tool/resource/open': {
				if (linkMode === 'delay') await new Promise<void>(resolve => { completeLink = resolve; });
				if (linkMode === 'error') throw new Error('Resource origin retired');
				const bytes = appRequests ? new TextEncoder().encode(appHtml) : linkBytes;
				const digest = await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes));
				return { resourceId: 'linked', mimeType: appRequests ? 'text/html;profile=mcp-app' : 'text/markdown', size: bytes.length, sha256: `sha256:${[...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')}`, ...(allowAppCsp ? { appCsp: { connectDomains: ['https://api.example.invalid'], resourceDomains: ['https://cdn.example.invalid'], frameDomains: ['https://frame.example.invalid'], baseUriDomains: ['https://base.example.invalid'] } } : {}) };
			}
			case 'tool/app/resource/open': {
				if (appCallMode === 'delay') await new Promise<void>(resolve => { completeLink = resolve; });
				if (appCallMode === 'error') throw new Error('Resource origin retired');
				const binary = (params as { uri: string; }).uri.startsWith('mcp:');
				const bytes = binary ? new Uint8Array([0, 127, 255]) : new TextEncoder().encode('{"value":8}\r\n');
				const digest = await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes));
				return { resourceId: binary ? 'app-blob' : 'app-data', mimeType: binary ? 'text/plain' : 'application/vnd.example+json', encoding: binary ? 'binary' : 'text', resourceMetadata: '{"private":"view-only"}', size: bytes.length, sha256: `sha256:${[...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')}` };
			}
			case 'resource/read': {
				const id = (params as { resourceId: string; }).resourceId;
				const bytes = id === 'app-blob' ? new Uint8Array([0, 127, 255]) : id === 'app-data' ? new TextEncoder().encode('{"value":8}\r\n') : appRequests ? new TextEncoder().encode(appHtml) : linkBytes; return { resourceId: id, offset: 0, decodedLength: bytes.length, dataBase64: btoa(String.fromCharCode(...bytes)), eof: true };
			}
			case 'resource/release': return null;
			case 'tool/resource/cancel': return null;
			case 'tool/app/list': return { tools: [{ name: 'edit', inputSchema: { type: 'object', properties: { value: { type: 'number' } } }, outputSchema: { type: 'object' }, annotations: { readOnlyHint: false }, _meta: { ui: { visibility: ['app'] } } }] };
			case 'tool/app/call': {
				if (appCallMode === 'delay') await new Promise<void>(resolve => { completeLink = resolve; });
				if (appCallMode === 'error') throw new Error('App tool origin retired');
				return {
					item: {
						type: 'toolResult', itemId: 'app-edit-result', turnId: 'app-edit-turn', toolCallId: 'app-edit', text: 'Edited report', isError: false, content: [
							{ type: 'text', text: 'Edited report' },
							{ type: 'artifact', artifact: { source: { type: 'structuredResult' }, mimeType: 'application/json', data: { type: 'json', json: '{"value":8}' }, contentDigest: 'sha256:result', truncated: false } },
							{ type: 'artifact', artifact: { source: { type: 'viewMetadata' }, mimeType: 'application/json', data: { type: 'json', json: '{"viewOnly":8}' }, contentDigest: 'sha256:metadata', truncated: false } },
						]
					}
				};
			}
			case 'tool/app/cancel': return null;
			default: throw new Error(`Unexpected ${definition.method}`);
		}
	},
} as unknown as AppServerProtocolClient);
function receiveToolUpdate(params: TranscriptDto): ThreadTranscriptUpdateEnvelope {
	let latest: ThreadTranscriptUpdateEnvelope | undefined;
	using subscription = toolService.onDidUpdateThreadTranscript(update => { latest = update; });
	toolNotifications.fire({ method: 'session/thread/transcript/update', params });
	if (!latest) throw new Error('Expected an Agent Thread domain update');
	return latest;
}
const imageBytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADklEQVR4nGP4z8DwHwQBEPgD/U6VwW8AAAAASUVORK5CYII='), character => character.charCodeAt(0));
let mediaRequests: unknown[] = [];
let delayMedia = false;
const pendingMedia = new Set<() => void>();
let mediaAborted = false;
let generatedImageBytes: Uint8Array | undefined;
services.registerInstance(IAgentThreadService, {
	...toolService,
	readAttachment: async (source, signal) => {
		mediaRequests.push(source);
		signal?.addEventListener('abort', () => { mediaAborted = true; }, { once: true });
		if (delayMedia) await new Promise<void>(resolve => { pendingMedia.add(resolve); });
		if (source.itemId === 'audio' || source.itemId === 'app-result' && source.contentIndex === 5) return { bytes: new Uint8Array(await (await fetch(toneWav)).arrayBuffer()), mimeType: 'audio/wav' };
		return { bytes: source.itemId === 'image-result' && generatedImageBytes ? generatedImageBytes : imageBytes, mimeType: 'image/png' };
	},
});
let mediaEntries: ThreadTranscriptEntry[] = [];
let toolEntries: ThreadTranscriptEntry[] = [];
let text = 'Reply with `inline`.\n\n```typescript\nconst code = "<safe>";\nsecond line\n```';
list.render([{ id: 'reply', type: 'agentMessage', text, transient: false }]);

type MarkdownWorkload = 'prose' | 'mixed' | 'fence' | 'largeFence' | 'largeParagraph' | 'hugeParagraph' | 'mathCandidates' | 'largeList' | 'largeTable';
function markdownWorkload(kind: MarkdownWorkload): string {
	const prose = 'Streaming **Markdown** with [a link](https://example.com) and `inline code`. 中文内容保持完整。 '.repeat(6);
	if (kind === 'hugeParagraph') return prose.repeat(64) + '\n\nFinal visible marker.';
	if (kind === 'mathCandidates') return String.raw`Incomplete \( candidate **bold** [link](https://example.com) and price $5. `.repeat(64) + ' Complete $x+1$.\n\nFinal visible marker.';
	if (kind === 'largeList') return Array.from({ length: 512 }, (_, index) => `- Item ${index}: **bold** [link](https://example.com) and \`code\` 中文`).join('\n') + '\n\nFinal visible marker.';
	if (kind === 'largeTable') return '| Name | Value | Detail |\n| --- | --- | --- |\n' + Array.from({ length: 256 }, (_, index) => `| Row ${index} | **bold** | [link](https://example.com) and \`code\` 中文 |`).join('\n') + '\n\nFinal visible marker.';
	if (kind === 'largeParagraph') return prose.repeat(16) + '\n\nFinal visible marker.';
	if (kind === 'prose') return Array.from({ length: 96 }, (_, index) => `Paragraph ${index}: ${prose}\n\n`).join('') + 'Final visible marker.';
	const code = Array.from({ length: kind === 'largeFence' ? 8000 : kind === 'fence' ? 800 : 36 }, (_, index) => `const value${index} = "streamed code ${index}";`).join('\n');
	if (kind === 'fence' || kind === 'largeFence') return `Before code.\n\n\`\`\`typescript\n${code}\n\`\`\`\n\nFinal visible marker.`;
	return Array.from({ length: 12 }, (_, index) => `Section ${index}: ${prose}\n\n\`\`\`typescript\n${code}\n\`\`\`\n\n`).join('') + 'Final visible marker.';
}

interface MarkdownBenchmarkResult {
	readonly bytes: number;
	readonly chunks: number;
	readonly consumer: { readonly setValueMs: number; readonly setValueCalls: number; readonly setValueCharacters: number; readonly applyEditsMs: number; readonly applyEditsCalls: number; readonly applyEditsCharacters: number; readonly updateOptionsMs: number; readonly updateOptionsCalls: number; readonly layoutMs: number; readonly layoutCalls: number; readonly lexMs: number; };
	readonly codeTextMatches: boolean;
	readonly wallMs: number;
	readonly updateMs: number;
	readonly maxUpdateMs: number;
	readonly updateSamplesMs: readonly number[];
	readonly maxLexMs: number;
	readonly renderSamplesMs: readonly number[];
	readonly markdownMs: number;
	readonly renderedCharacters: number;
	readonly renderCalls: number;
	readonly lexCalls: number;
	readonly lexedCharacters: number;
	readonly removedNodes: number;
	readonly longTasks: readonly number[];
	readonly codeBlocks: number;
	readonly finalVisible: boolean;
}

declare global {
	interface Window {
		ashChatTranscriptIntegration: {
			prepareBuiltinDictation(cowork: boolean, backend: 'local' | 'cloud'): Promise<void>;
			builtinDictationEvent(text: string, retired?: boolean): void;
			builtinAudioTail(): void;
			holdBuiltinStop(): void;
			finishBuiltinStop(): void;
			builtinDictationState(): { operations: readonly string[]; busy: boolean; state: string; };
			prepareDictation(cowork: boolean): void;
			runDictation(focusFile?: boolean): Promise<void>;
			dictationEvent(text: string): void;
			dictationState(): { starts: number; cancels: number; busy: boolean; widgets: number; focused: boolean; file: string; };
			holdClipboard(fail?: boolean): void;
			releaseClipboard(): void;
			state(): { copied: string; copiedImage: readonly number[]; file: string; resource: string; editorCount: number; codeModelCount: number; selection: unknown; notifications: readonly string[]; };
			openSkill(): Promise<void>;
			referenceReady(line: number, column: number): boolean;
			openReference(line: number, column: number): Promise<void>;
			skillRequests(): readonly unknown[];
			setFile(value: string, line: number, column: number): void;
			diagnostics(): readonly { message: string; code?: ReturnType<IMarkerService['read']>[number]['code']; }[];
			setReadonly(value: boolean): void;
			setWrap(value: boolean): Promise<void>;
			setCodeLineHeight(height: number): Promise<void>;
			setAutoExpandToolFailures(value: boolean): Promise<void>;
			setTypography(values: Readonly<Record<string, string | number | undefined>>): Promise<void>;
			setPromptTimeline(value: 'off' | 'gutter' | 'ruler'): Promise<void>;
			setTheme(value: 'dark' | 'light' | 'hc' | 'hcLight'): void;
			showHistoryFailure(): void;
			showHistoryPagination(fail?: boolean): void;
			finishHistoryPage(): void;
			historyPageLoads(): number;
			prepareHistoryBenchmark(turns: number, textBytes: number): void;
			runHistoryBenchmark(method: 'read' | 'subscribe', bounded: boolean): Promise<{ bytes: number; parseMs: number; schemaMs: number; receiveAndMapMs: number; renderMs: number; throughPaintMs: number; items: number; lastText: string; }>;
			setAIDisabled(value: boolean): Promise<void>;
			isCodeChatActive(): boolean;
			finishHistoryRecovery(): void;
			historyRecoveries(): number;
			openChatAuxiliaryWindow(): Promise<void>;
			prepareSessionLifecycle(wording: 'archive' | 'done'): Promise<void>;
			runSessionAction(command: string, target?: string): Promise<unknown>;
			sessionLifecycleState(): { readonly activeThreadId: string | undefined; readonly requests: readonly unknown[]; readonly opened: readonly string[]; readonly sessions: readonly { readonly id: string; readonly status: string; readonly threads: readonly string[]; }[]; readonly drafts: readonly string[]; };
			refresh(): void;
			imageReadCount(): number;
			renderItems(items: readonly IChatListItem[]): void;
			setTurnFiles(files: readonly Omit<ChatTurnFileChange, 'review'>[]): void;
			setMessageReferences(references: typeof messageReferences): void;
			setUpvoteAnimation(value: string): Promise<void>;
			showFind(query?: string): void;
			runNavigationCommand(command: string): Promise<void>;
			prepareRequestEditing(cowork: boolean, text?: string, unanswered?: boolean, hasCheckpoint?: boolean): void;
			updateRequestCheckpoint(): void;
			runChatCommand(id: string): Promise<unknown>;
			setAutoFollowReplies(enabled: boolean): Promise<void>;
			appendChatItem(item: IChatListItem): void;
			setConversationChanges(visible: boolean): void;
			setResponseWorking(working: boolean): void;
			requestEdits(): readonly { readonly text: string; readonly commandId: string; readonly itemId: string; readonly contexts?: readonly { readonly name: string; readonly content: string; }[]; }[];
			finishRequestEdit(failure?: boolean): void;
			prepareMessageFork(): void;
			setMessageForkEnabled(value: boolean): void;
			messageForks(): readonly IForkConversationOptions[];
			finishMessageFork(failure?: boolean): Promise<void>;
			prepareMessageCheckpoint(): void;
			messageCheckpointState(): { requests: readonly RestoreChatCheckpointOptions[]; opened: readonly string[]; };
			captureMessageRowCommands(): void;
			messageRowCommands(): readonly { id: string; args: readonly unknown[]; }[];
			readingState(): ReturnType<ChatListWidget['getViewState']>;
			delayAttachments(value: boolean): void;
			setTranscriptVisible(value: boolean): void;
			recreateTranscript(): void;
			stream(value: string, complete: boolean): void;
			queueStreamingResponse(update: ChatStreamingResponseUpdate): boolean;
			runMarkdownBenchmark(kind: MarkdownWorkload): Promise<MarkdownBenchmarkResult>;
			markdownWorkload(kind: MarkdownWorkload): string;
			inspectRawCodeUpdates(values: readonly string[]): Promise<{ readonly snapshots: readonly { readonly text: string; readonly eol: string; readonly copied: string; }[]; readonly released: boolean; }>;
			inspectCodeUpdates(values: readonly string[]): { readonly updates: readonly { readonly text: string; readonly reason: string; readonly replacedCharacters: number; readonly insertedCharacters: number; }[]; readonly sameModel: boolean; readonly canUndo: boolean; };
			compareStreamingMarkdown(value: string, complete: boolean, measureLayout?: boolean): Promise<{ actual: string; expected: string; layoutError: number; layout: unknown[]; }>;
			showLongCode(): string;
			showTool(): void;
			showImageGeneration(state: 'pending' | 'success' | 'failure' | 'stopped', count?: number, stored?: boolean): void;
			setReducedMotion(reduced: boolean): Promise<void>;
			openAccessibleView(help: boolean): boolean;
			updateTool(finish: boolean): void;
			showMedia(delay: boolean): void;
			showArtifacts(revise: boolean): void;
			showLink(mode: 'read' | 'delay' | 'error'): void;
			showApp(mode?: 'read' | 'delay' | 'error', allowCsp?: boolean, withMedia?: boolean): void;
			setAppResourceMode(mode: 'read' | 'error'): void;
			showReadAloudMessage(text: string, cowork?: boolean): Promise<void>;
			finishReadAloud(failure?: boolean): void;
			stopReadAloudCommand(): Promise<void>;
			revokeReadAloudProvider(): void;
			readAloudState(): { readonly text: readonly string[]; readonly open: number; readonly closed: number; };
			showCopiedMessage(text: string, cowork?: boolean): void;
			updateCopiedMessage(text: string, transient?: boolean): void;
			clearCopiedMessage(): void;
			showAcceptedContext(text: string, cowork?: boolean): void;
			updateAcceptedContext(text: string): void;
			showChatApp(voice?: boolean, cowork?: boolean, withMedia?: boolean, virtualizeHistory?: boolean): void;
			showLongCodeHistory(turns: number, virtualizeHistory: boolean, withTools?: boolean): void;
			voiceState(): readonly string[];
			showVoiceIntroduction(): void;
			toggleIntroductionFocus(): void;
			setIntroductionNotification(visible: boolean): void;
			voiceSelection(): AgentVoiceSelection | undefined;
			proposeVoiceTask(): void;
			delayAppResources(): void;
			appLogs(): readonly LogEntry[];
			retireChat(): void;
			setChatVisible(visible: boolean): void;
			chatDraft(): Promise<string | undefined>;
			chatDraftContexts(): Promise<readonly { name: string; content: string; }[] | undefined>;
			chatDraftContextNames(): Promise<readonly string[]>;
			persistedChatDraft(): ReturnType<typeof readNewChatDraftState>;
			appImagePending(): boolean;
			delayAppImages(): void;
			finishAppImages(): void;
			addUserContext(): void;
			addTerminalContext(): void;
			chatMessages(): readonly unknown[];
			closeConnection(): void;
			appState(): { messages: readonly unknown[]; views: number; };
			linkRequests(): readonly { method: string; params: unknown; }[];
			finishLink(): void;
			readResource(uri: string): Promise<number[]>;
			mediaPreviewState(): Promise<{ readonly resource: string; readonly content: string | undefined; readonly readonly: boolean; }>;
			closeMediaPreview(): void;
			refreshMedia(): void;
			finishMedia(): void;
			openedAppLinks(): readonly { uri: string; options: unknown; }[];
			mediaState(): { requests: readonly unknown[]; aborted: boolean; };
			remove(): void;
			dispose(): void;
		};
	}
}

const readEvents = new Map<string, JsonValue[]>();
const spokenText: string[] = [];
let closedReadSessions = 0;
const readSnapshot: ExtensionHostFleetSnapshot = {
	generation: 1, extensions: [{
		id: 'example.reader', version: '1', packageDigest: `sha256:${'a'.repeat(64)}`, runtimeApiVersion: 1,
		incarnation: 1, activationGeneration: 1, lifecycle: 'ready', failure: undefined, stderr: '', outputEvents: [],
		registrations: [{ registrationId: 'reader', kind: 'speechProvider', registrationGeneration: 1, identifier: 'example.reader' }]
	}]
};
const readApi: IExtensionHostApi = {
	onDidChange: Event.None, onConnectionState: Event.None, isAvailable: async () => true, getConnectionState: async () => 'ready',
	list: async () => {
		if (!new URLSearchParams(location.search).has('mermaid')) { return readSnapshot; }
		const response = await fetch('/__chat_mermaid');
		return response.json();
	},
	start: async () => readSnapshot, reconcile: async () => readSnapshot, activateByEvent: async () => readSnapshot,
	registerClientHandler: () => Disposable.None,
	invoke: async (request, signal): Promise<JsonValue> => {
		signal.throwIfAborted();
		if (request.registrationId === 'markdown.mermaid.render.v1') {
			const response = await fetch('/__chat_mermaid', { method: 'POST', body: JSON.stringify(request.payload), signal });
			return response.json();
		}
		const payload = request.payload as { sessionId: string; kind?: string; text?: string; };
		if (request.operation === 'createSpeechSession') {
			if (payload.kind !== 'textToSpeech') throw new Error('Unexpected media session');
			readEvents.set(payload.sessionId, []); return {};
		}
		if (request.operation === 'synthesizeSpeech') {
			spokenText.push(payload.text!); readEvents.get(payload.sessionId)?.push({ status: 1 }); return {};
		}
		if (request.operation === 'readSpeechSession') return { events: readEvents.get(payload.sessionId)?.splice(0) ?? [], closed: !readEvents.has(payload.sessionId) };
		if (request.operation === 'closeSpeechSession') { if (readEvents.delete(payload.sessionId)) closedReadSessions++; return {}; }
		throw new Error('Unexpected Speech request');
	}
};
let readBridge: MainThreadSpeech | undefined;
services.registerInstance(IExtensionHostApi, readApi);

window.ashChatTranscriptIntegration = {
	prepareBuiltinDictation: async (cowork, backend) => {
		await services.get(IConfigurationService).updateValue('dictation.backend', backend);
		builtinAudio = resources.add(installTestDictationAudio(window));
		window.ashChatTranscriptIntegration.showChatApp(false, cowork);
	},
	builtinDictationEvent: (text, retired = false) => {
		const resourceId = retired ? retiredBuiltinResource : builtinResource;
		if (resourceId) builtinTranscripts.fire({ resourceId, text, isFinal: false });
	},
	builtinAudioTail: () => builtinAudio?.emit(new Float32Array([0, 1, -1])),
	holdBuiltinStop: () => { builtinStop = new DeferredPromise<void>(); },
	finishBuiltinStop: () => { void builtinStop?.complete(); builtinStop = undefined; },
	builtinDictationState: () => ({ operations: builtinOperations, busy: services.get(IChatSpeechToTextService).isBusy, state: services.get(IChatSpeechToTextService).state }),
	prepareDictation: cowork => {
		resources.add(services.get(ISpeechService).registerSpeechProvider('command-fixture', {
			metadata: { extension: new ExtensionIdentifier('test.speech'), displayName: 'Controlled recognition' },
			createSpeechToTextSession: token => {
				dictationStarts++;
				dictationEvents = resources.add(new Emitter<ISpeechToTextEvent>());
				resources.add(token.onCancellationRequested(() => { dictationCancels++; }));
				return { onDidChange: dictationEvents.event };
			},
			createTextToSpeechSession: () => { throw new Error('Unexpected synthesis'); },
			createKeywordRecognitionSession: () => { throw new Error('Unexpected keyword recognition'); },
		}));
		window.ashChatTranscriptIntegration.showChatApp(false, cowork, true);
	},
	runDictation: async focusFile => {
		if (focusFile) file.focus();
		await services.get(ICommandService).executeCommand('workbench.action.chat.toggleSpeechToText');
	},
	dictationEvent: text => {
		dictationEvents?.fire({ status: SpeechToTextStatus.Started });
		dictationEvents?.fire({ status: SpeechToTextStatus.Recognized, text });
	},
	dictationState: () => ({ starts: dictationStarts, cancels: dictationCancels, busy: services.get(IChatSpeechToTextService).isBusy, widgets: services.get(IChatWidgetService).getAllWidgets().length, focused: appChat?.inputEditor?.hasTextFocus() === true, file: file.getModel()!.getValue() }),
	holdClipboard: (fail = false) => { clipboardFailure = fail; clipboardReady = new Promise(resolve => { releaseClipboard = resolve; }); },
	releaseClipboard: () => releaseClipboard(),
	state: () => {
		const editors = services.get(ICodeEditorService).listCodeEditors();
		const responseEditors = editors.filter(editor => editor !== file);
		const selected = responseEditors.find(editor => editor.hasTextFocus()) ?? responseEditors[0];
		return {
			copied: clipboardText, copiedImage: clipboardImage, file: file.getModel()!.getValue(), resource: activeResource.toString(),
			editorCount: editors.length,
			codeModelCount: responseEditors.filter(editor => editor.getModel()).length,
			selection: selected?.getSelection(),
			notifications: (services.get(INotificationService) as NotificationService).model.getNotifications().map(item => item.message),
		};
	},
	openSkill: async () => {
		const [skill] = await prompts.findAgentSkills(CancellationToken.None, 'reference-session');
		await services.get(ICodeEditorService).openCodeEditor({ resource: skill.uri }, file);
	},
	referenceReady: (line, column) => !!LinkDetector.get(file)?.getLinkOccurrence(new Selection(line, column, line, column).getPosition()),
	openReference: async (line, column) => { file.setSelection(new Selection(line, column, line, column)); file.focus(); await services.get(ICommandService).executeCommand('editor.action.openLink'); },
	skillRequests: () => skillResourceRequests,
	setFile: (value, line, column) => { fileModel.setValue(value); file.setSelection(new Selection(line, column, line, column)); },
	diagnostics: () => services.get(IMarkerService).read({ resource: fileModel.uri }).map(marker => ({
		message: marker.message,
		code: typeof marker.code === 'object' ? marker.code.value : marker.code,
	})),
	setReadonly: value => file.updateOptions({ readOnly: value }),
	setWrap: value => services.get(IConfigurationService).updateValue('chat.editor.wordWrap', value ? 'on' : 'off'),
	setCodeLineHeight: height => services.get(IConfigurationService).updateValue('chat.editor.lineHeight', height),
	setAutoExpandToolFailures: value => services.get(IConfigurationService).updateValue('chat.tools.autoExpandFailures', value),
	setTypography: async values => {
		for (const [key, value] of Object.entries(values)) await services.get(IConfigurationService).updateValue(key, value);
	},
	setPromptTimeline: value => services.get(IConfigurationService).updateValue('sessions.chatTimeline.display', value),
	setTheme: value => {
		const palette = value === 'dark' ? darkColorTheme : value === 'light' ? lightColorTheme : value === 'hcLight' ? highContrastLightColorTheme : highContrastDarkColorTheme;
		theme.setColorTheme(palette);
	},
	imageReadCount: () => imageReads,
	showFind: query => list.getFindController().show(query),
	runNavigationCommand: async command => {
		const widget = {
			visible: true, domNode: list.element,
			getFindController: (): ReturnType<IChatWidget['getFindController']> => list.getFindController(),
			focusResponseItem: (last?: boolean) => list.focusResponseItem(last),
			focusCodeBlock: (reverse?: boolean) => list.focusCodeBlock(reverse),
			getFocus: () => list.getFocus(),
			getSibling: (item: IChatListItem | undefined, type: 'next' | 'previous') => list.getSibling(item, type),
			focus: (item: IChatListItem) => list.focus(item),
			reveal: (item: IChatListItem) => list.reveal(item),
		} as unknown as IChatWidget;
		using scope = services.createChild(new ServiceCollection([IChatWidgetService, { lastFocusedWidget: widget, getAllWidgets: () => [widget] } as unknown as IChatWidgetService]));
		await scope.invokeFunction(CommandsRegistry.getCommand(command)!);
	},
	renderItems: items => { rendererItems = items; list.render(items); },
	setTurnFiles: files => { turnFiles = files; list.render(rendererItems); },
	setMessageReferences: references => { messageReferences = references; list.render(rendererItems); },
	setUpvoteAnimation: value => services.get(IConfigurationService).updateValue('chat.upvoteAnimation', value),
	prepareRequestEditing: (cowork, text, unanswered, hasCheckpoint) => {
		requestEditMode = true;
		window.ashChatTranscriptIntegration.showChatApp(false, cowork);
		requestEdits.length = 0;
		const request: IChatListItem = {
			id: 'presentation-entry', type: 'userMessage', text: text ?? 'Original request', transient: false,
			requestSource: { sessionId: 'app-session', threadId: 'app-thread', turnId: 'original-turn', itemId: 'backend-request' },
			canForkBeforeRequest: hasCheckpoint, canRunAnotherVersion: hasCheckpoint,
		};
		appItems = text === undefined ? [request] : [
			{ id: 'preceding-answer', type: 'agentMessage', text: 'Earlier response\n\n'.repeat(15), transient: false },
			request,
			...(unanswered ? [] : [{ id: 'following-answer', type: 'agentMessage' as const, text: 'Following response', transient: false }]),
		];
		chatChanges.fire();
	},
	updateRequestCheckpoint: () => {
		appItems = appItems.map(item => item.id === 'presentation-entry' ? { ...item, canRunAnotherVersion: true } : item);
		chatChanges.fire();
	},
	runChatCommand: id => composerServices!.get(ICommandService).executeCommand(id),
	setAutoFollowReplies: enabled => services.get(IConfigurationService).updateValue('chat.autoFollowReplies', enabled),
	appendChatItem: item => { appItems = [...appItems, item]; chatChanges.fire(); },
	setConversationChanges: visible => { hasConversationChanges = visible; chatChanges.fire(); },
	setResponseWorking: working => { responseWorking = working; chatChanges.fire(); },
	requestEdits: () => requestEdits,
	finishRequestEdit: failure => completeRequestEdit?.(failure),
	prepareMessageFork: () => {
		const commands = services.get(ICommandService);
		appServices.registerInstance(ICommandService, {
			onWillExecuteCommand: commands.onWillExecuteCommand,
			onDidExecuteCommand: commands.onDidExecuteCommand,
			async executeCommand<T>(id: string, ...args: readonly unknown[]): Promise<T> {
				if (id !== ForkConversationActionId) return commands.executeCommand<T>(id, ...args);
				messageForks.push(args[0] as IForkConversationOptions);
				pendingMessageFork = new DeferredPromise<void>();
				await pendingMessageFork.p;
				return undefined as T;
			},
		});
		window.ashChatTranscriptIntegration.setMessageForkEnabled(true);
		list.render([{
			id: 'fork-source', type: 'userMessage', text: 'Follow-up request', transient: false,
			requestSource: { sessionId: 'source', threadId: 'original', turnId: 'turn-2', itemId: 'item-2' }, canForkBeforeRequest: true,
		}]);
	},
	setMessageForkEnabled: value => ChatContextKeys.enabled.bindTo(services.get(IContextKeyService)).set(value),
	messageForks: () => messageForks,
	finishMessageFork: async failure => {
		if (failure) await pendingMessageFork?.error(new Error('Synthetic fork failure'));
		else await pendingMessageFork?.complete();
	},
	prepareMessageCheckpoint: () => {
		const source = { sessionId: 'source', threadId: 'original' };
		appServices.registerSingleton(ICommandService, () => appServices.createInstance(StandaloneCommandService));
		appServices.registerInstance(IChatSessionNavigationService, {
			revision: 0,
			getActiveConversation: () => source,
			openConversation: async (_sessionId, threadId) => { checkpointDestinations.push(threadId); },
		} as IChatSessionNavigationService);
		appServices.registerInstance(IChatService, {
			readCheckpoints: async () => [1, 2].map(index => ({ itemId: `item-${index}`, turnId: `turn-${index}`, sourceThreadId: source.threadId, files: 'git' as const })),
			restoreCheckpoint: async (options: RestoreChatCheckpointOptions) => {
				checkpointRestores.push(options);
				return { sessionId: source.sessionId, threadId: 'restored' };
			},
		} satisfies Pick<IChatService, 'readCheckpoints' | 'restoreCheckpoint'> as unknown as IChatService);
		window.ashChatTranscriptIntegration.setMessageForkEnabled(true);
		list.render([1, 2].map(index => ({
			id: `request-${index}`, type: 'userMessage', text: `Request ${index}`, transient: false,
			requestSource: { ...source, turnId: `turn-${index}`, itemId: `item-${index}` }, canForkBeforeRequest: index > 1,
		})));
	},
	messageCheckpointState: () => ({ requests: checkpointRestores, opened: checkpointDestinations }),
	captureMessageRowCommands: () => {
		appServices.registerInstance(ICommandService, {
			onWillExecuteCommand: Event.None, onDidExecuteCommand: Event.None,
			async executeCommand<T>(id: string, ...args: readonly unknown[]): Promise<T> {
				messageRowCommands.push({ id, args: args.map(unwrapChatResponseActionContext) });
				return undefined as T;
			},
		});
		appServices.registerSingleton(IMenuService, () => appServices.createInstance(MenuService));
		window.ashChatTranscriptIntegration.setMessageForkEnabled(true);
	},
	messageRowCommands: () => messageRowCommands,
	readingState: () => list.getViewState(),
	delayAttachments: value => { delayMedia = value; },
	setTranscriptVisible: value => {
		if (!value) list.setVisible(false);
		root.style.display = value ? 'flex' : 'none';
		if (value) list.setVisible(true);
	},
	recreateTranscript: () => {
		const previous = list;
		const state = previous.getViewState();
		list = resources.add(services.createInstance(ChatListWidget, root, listOptions));
		previous.element.replaceWith(list.element);
		list.restoreViewState(state, rendererItems);
		previous.dispose();
	},
	stream: (value, complete) => list.render([{ id: 'stream', type: 'agentMessage', text: value, transient: !complete }]),
	queueStreamingResponse: update => list.tryQueueStreamingResponse(update),
	compareStreamingMarkdown: async (value, complete, measureLayout = false) => {
		list.render([{ id: 'stream', type: 'agentMessage', text: value, transient: !complete }]);
		// Large snapshots are consumed by the owning response in the next frame.
		if (value.length >= 1024) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
		const root = list.element.querySelector<HTMLElement>('.ash-chat-markdown-part')!;
		const copy = root.cloneNode(true) as HTMLElement;
		for (const fragment of copy.querySelectorAll('.ash-chat-markdown-fragment')) fragment.replaceWith(...fragment.childNodes);
		const codeNode = (language: string, text: string): HTMLElement => {
			const code = document.createElement('code');
			code.dataset.language = language;
			code.textContent = text;
			return code;
		};
		const editors = services.get(ICodeEditorService).listCodeEditors();
		const blocks = [...root.querySelectorAll('.ash-chat-code-block')];
		for (const [index, block] of copy.querySelectorAll('.ash-chat-code-block').entries()) {
			const editor = editors.find(editor => blocks[index].contains(editor.getDomNode()));
			const pre = document.createElement('pre');
			pre.append(codeNode(block.querySelector('.ash-chat-code-block-language')!.textContent!, editor!.getModel()!.getValue()));
			block.replaceWith(pre);
		}
		using renderer = services.createInstance(ChatContentMarkdownRenderer);
		using expected = renderer.render({ value, supportThemeIcons: true, supportAlertSyntax: true }, { fillInIncompleteTokens: !complete, codeBlockRendererSync: codeNode });
		wrapTablesWithScrollable(expected.element);
		// Provider completion is asynchronous; compare formula identity and syntax here.
		for (const element of [copy, expected.element]) for (const formula of element.querySelectorAll<HTMLElement>('.ash-katex-container')) formula.textContent = formula.dataset.latex!;
		let layoutError = 0;
		const layout: unknown[] = [];
		if (measureLayout) {
			expected.element.style.position = 'absolute';
			expected.element.style.visibility = 'hidden';
			expected.element.style.width = `${root.getBoundingClientRect().width}px`;
			root.parentElement!.append(expected.element);
			const actualBounds = root.getBoundingClientRect();
			const expectedBounds = expected.element.getBoundingClientRect();
			layoutError = Math.abs(actualBounds.height - expectedBounds.height);
			layout.push({ actual: { width: actualBounds.width, height: actualBounds.height }, expected: { width: expectedBounds.width, height: expectedBounds.height } });
			const actualBlocks = root.querySelectorAll('p,h1,h2,blockquote,table,ul,ol');
			for (const [index, block] of expected.element.querySelectorAll('p,h1,h2,blockquote,table,ul,ol').entries()) {
				const actual = actualBlocks[index].getBoundingClientRect();
				const reference = block.getBoundingClientRect();
				layoutError = Math.max(layoutError, Math.abs(actual.top - actualBounds.top - (reference.top - expectedBounds.top)), Math.abs(actual.height - reference.height));
				layout.push({ tag: block.tagName, actual: { top: actual.top - actualBounds.top, height: actual.height }, expected: { top: reference.top - expectedBounds.top, height: reference.height } });
			}
		}
		return { actual: copy.innerHTML, expected: expected.element.innerHTML, layoutError, layout };
	},
	inspectRawCodeUpdates: async values => {
		const part = services.createInstance(CodeBlockPart, document, undefined);
		document.body.append(part.element);
		const snapshots: { text: string; eol: string; copied: string; }[] = [];
		let model: TextModel | null = null;
		try {
			for (const value of values) {
				part.render({ text: value, languageId: 'typescript', codeBlockIndex: 0, element: undefined, chatSessionResource: undefined }, 600);
				model = part.model!;
				clipboardText = '';
				part.element.querySelector('button')!.click();
				await new Promise<void>(resolve => setTimeout(resolve, 0));
				snapshots.push({ text: model.getValue(), eol: model.getEOL(), copied: clipboardText });
			}
		} finally { part.dispose(); }
		return { snapshots, released: model?.isDisposed() ?? true };
	},
	inspectCodeUpdates: values => {
		list.render([{ id: 'stream', type: 'agentMessage', text: '```typescript\ninitial', transient: true }]);
		const editor = services.get(ICodeEditorService).listCodeEditors().find(editor => editor !== file)!;
		const model = editor.getModel()!;
		const updates: { text: string; reason: string; replacedCharacters: number; insertedCharacters: number; }[] = [];
		const listener = model.onDidChangeContent(change => updates.push({
			text: model.getValue(), reason: change.reason,
			replacedCharacters: change.changes.reduce((sum, edit) => sum + edit.rangeLength, 0),
			insertedCharacters: change.changes.reduce((sum, edit) => sum + edit.text.length, 0),
		}));
		try {
			for (const value of values) list.render([{ id: 'stream', type: 'agentMessage', text: '```typescript\n' + value, transient: true }]);
			return { updates, sameModel: editor.getModel() === model, canUndo: model.canUndo() };
		} finally { listener.dispose(); }
	},
	markdownWorkload,
	runMarkdownBenchmark: async kind => {
		const source = markdownWorkload(kind);
		const chunks = 128;
		const values = Array.from({ length: chunks }, (_, index) => source.slice(0, Math.ceil(source.length * (index + 1) / chunks)));
		list.render([]);
		await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
		let markdownMs = 0;
		let renderedCharacters = 0;
		let renderCalls = 0;
		let lexCalls = 0;
		let lexedCharacters = 0;
		let removedNodes = 0;
		const consumer = { setValueMs: 0, setValueCalls: 0, setValueCharacters: 0, applyEditsMs: 0, applyEditsCalls: 0, applyEditsCharacters: 0, updateOptionsMs: 0, updateOptionsCalls: 0, layoutMs: 0, layoutCalls: 0, lexMs: 0 };
		const setValue = TextModel.prototype.setValue;
		const applyEdits = TextModel.prototype.applyEdits;
		const updateOptions = CodeEditorWidget.prototype.updateOptions;
		const layout = CodeEditorWidget.prototype.layout;
		TextModel.prototype.setValue = function (value) {
			const start = performance.now();
			consumer.setValueCalls++;
			consumer.setValueCharacters += typeof value === 'string' ? value.length : 0;
			try { return setValue.call(this, value); } finally { consumer.setValueMs += performance.now() - start; }
		};
		TextModel.prototype.applyEdits = function (this: TextModel, ...args: Parameters<typeof applyEdits>) {
			const start = performance.now();
			consumer.applyEditsCalls++;
			consumer.applyEditsCharacters += args[0].reduce((sum, operation) => sum + (operation.text?.length ?? 0), 0);
			try { return Reflect.apply(applyEdits, this, args); } finally { consumer.applyEditsMs += performance.now() - start; }
		} as typeof applyEdits;
		CodeEditorWidget.prototype.updateOptions = function (...args) {
			const start = performance.now();
			consumer.updateOptionsCalls++;
			try { return updateOptions.apply(this, args); } finally { consumer.updateOptionsMs += performance.now() - start; }
		};
		CodeEditorWidget.prototype.layout = function (...args) {
			const start = performance.now();
			consumer.layoutCalls++;
			try { return layout.apply(this, args); } finally { consumer.layoutMs += performance.now() - start; }
		};
		const original = ChatContentMarkdownRenderer.prototype.render;
		// Include the actual deferred consumer, rather than reporting only the cheap enqueue call.
		const originalPartRender = ChatMarkdownContentPart.prototype['render'];
		const renderSamplesMs: number[] = [];
		ChatMarkdownContentPart.prototype['render'] = function (...args) {
			const start = performance.now();
			try { return originalPartRender.apply(this, args); }
			finally { renderSamplesMs.push(performance.now() - start); }
		};
		const originalLex = Lexer.lex;
		Lexer.lex = function (source, options) {
			lexCalls++;
			lexedCharacters += source.length;
			const start = performance.now();
			try { return originalLex(source, options); } finally {
				const elapsed = performance.now() - start;
				consumer.lexMs += elapsed;
				maxLexMs = Math.max(maxLexMs, elapsed);
			}
		};
		ChatContentMarkdownRenderer.prototype.render = function (markdown, ...args) {
			const start = performance.now();
			renderedCharacters += markdown.value.length;
			renderCalls++;
			try { return original.call(this, markdown, ...args); }
			finally { markdownMs += performance.now() - start; }
		};
		const mutations = new MutationObserver(records => { removedNodes += records.reduce((sum, record) => sum + record.removedNodes.length, 0); });
		mutations.observe(list.element, { childList: true, subtree: true });
		const longTasks: number[] = [];
		const observer = new PerformanceObserver(records => { for (const entry of records.getEntries()) longTasks.push(entry.duration); });
		observer.observe({ entryTypes: ['longtask'] });
		let updateMs = 0;
		let maxUpdateMs = 0;
		let maxLexMs = 0;
		const updateSamplesMs: number[] = [];
		const start = performance.now();
		try {
			for (const [index, value] of values.entries()) {
				const before = performance.now();
				list.render([{ id: 'stream', type: 'agentMessage', text: value, transient: index !== chunks - 1 }]);
				const elapsed = performance.now() - before;
				updateMs += elapsed;
				updateSamplesMs.push(elapsed);
				maxUpdateMs = Math.max(maxUpdateMs, elapsed);
				// Eight provider updates per frame, identical in both builds.
				if ((index + 1) % 8 === 0) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
			}
			await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
			const expectedCode = [...source.matchAll(/```typescript\n([\s\S]*?)\n```/gu)].map(match => match[1]);
			const actualCode = services.get(ICodeEditorService).listCodeEditors().filter(editor => editor !== file && editor.getModel()).map(editor => editor.getModel()!.getValue());
			return {
				consumer, codeTextMatches: expectedCode.length === actualCode.length && expectedCode.every((code, index) => code === actualCode[index]),
				bytes: new TextEncoder().encode(source).byteLength, chunks, wallMs: performance.now() - start,
				updateMs, maxUpdateMs, updateSamplesMs, maxLexMs, renderSamplesMs, markdownMs, renderedCharacters, renderCalls, lexCalls, lexedCharacters, removedNodes, longTasks,
				codeBlocks: list.element.querySelectorAll('.ash-chat-code-block').length,
				finalVisible: [...list.element.querySelectorAll('[data-item-id="stream"] p')].at(-1)?.textContent === 'Final visible marker.',
			};
		} finally {
			ChatContentMarkdownRenderer.prototype.render = original;
			ChatMarkdownContentPart.prototype['render'] = originalPartRender;
			Lexer.lex = originalLex;
			TextModel.prototype.setValue = setValue;
			TextModel.prototype.applyEdits = applyEdits;
			CodeEditorWidget.prototype.updateOptions = updateOptions;
			CodeEditorWidget.prototype.layout = layout;
			mutations.disconnect();
			observer.disconnect();
		}
	},
	refresh: () => list.render([{ id: 'reply', type: 'agentMessage', text, transient: false }]),
	showLongCode: () => {
		const code = Array.from({ length: 80 }, (_, index) => `const value${index} = ${index};`).join('\n');
		text = `\`\`\`typescript\n${code}\n\`\`\``;
		list.render([{ id: 'reply', type: 'agentMessage', text, transient: false }]);
		return code;
	},
	openAccessibleView: help => accessibleView.show(help ? AccessibleViewType.Help : AccessibleViewType.View),
	showTool: () => {
		const update = receiveToolUpdate({
			sessionId: 'session', threadId: 'thread', revision: 2, durableSequence: 1, changes: [{
				type: 'upsert', entry: {
					type: 'item', entryId: 'call', turnId: 'turn', transient: false, item: {
						type: 'toolCall', itemId: 'call', turnId: 'turn', toolCallId: 'shell', name: 'shell', argumentsJson: '{"command":"echo <safe>"}',
						binding: { registryGeneration: 1, definitionDigest: 'digest', sourceChain: [{ type: 'product', component: 'shell' }], caller: { type: 'direct' }, activity: { type: 'command', program: 'echo', arguments: ['<safe>'], workingDirectory: '/remote/project' } },
					}
				}
			}]
		});
		toolEntries = update.changes.flatMap(change => change.type === 'upsert' ? [change.entry] : []);
		list.render(chatTranscriptListItems(toolEntries));
	},
	showImageGeneration: (state, count = 1, stored = false) => {
		const canvas = document.createElement('canvas');
		canvas.width = 360; canvas.height = 220;
		const context = canvas.getContext('2d')!;
		context.fillStyle = '#e5a738'; context.fillRect(0, 0, 180, 220);
		context.fillStyle = '#537ac9'; context.fillRect(180, 0, 180, 220);
		const url = canvas.toDataURL('image/png');
		generatedImageBytes = Uint8Array.from(atob(url.split(',')[1]!), character => character.charCodeAt(0));
		const entries: ThreadTranscriptEntry[] = [{ type: 'item', entryId: 'image-call', turnId: 'image-turn', transient: false, item: { type: 'toolCall', itemId: 'image-call', turnId: 'image-turn', toolCallId: 'image-tool', name: 'imagegen', argumentsJson: '{"prompt":"two color fields","reference_images":[]}', binding: { registryGeneration: 1, definitionDigest: 'image-definition', sourceChain: [{ type: 'extension', id: 'imagegen' }], caller: { type: 'direct' } } } }];
		if (state === 'success' || state === 'failure') entries.push({ type: 'item', entryId: 'image-result', turnId: 'image-turn', transient: false, item: {
			type: 'toolResult', itemId: 'image-result', turnId: 'image-turn', toolCallId: 'image-tool', text: state === 'failure' ? 'Synthetic image generation failure' : 'Saved image', isError: state === 'failure',
			content: state === 'failure' ? [{ type: 'text', text: 'Synthetic image generation failure' }] : [{ type: 'text', text: 'Saved image' }, ...Array.from({ length: count }, (_, index): ChatContentPart => stored ? { type: 'imageAttachment', detail: 'auto', attachment: { contentDigest: `sha256:${String(index + 1).repeat(64)}`, width: 360, height: 220, mediaType: 'png', encodedBytes: generatedImageBytes!.length } } : { type: 'imageUrl', detail: 'auto', url })],
		} });
		if (state === 'stopped') entries.push({ type: 'turnError', entryId: 'image-stop', turnId: 'image-turn', error: { code: 'connectionFailed', message: 'Synthetic cancellation', retryable: false } });
		// Desktop supplies a Thread snapshot through this structurally typed source contract.
		const thread = { sessionId: 'session', threadId: 'thread', sequence: 3, turns: [] };
		rendererItems = chatTranscriptListItems(entries, undefined, [], thread);
		list.render(rendererItems);
	},
	setReducedMotion: reduced => services.get(IConfigurationService).updateValue('workbench.reduceMotion', reduced ? 'on' : 'off'),
	updateTool: finish => {
		const update = receiveToolUpdate({
			sessionId: 'session', threadId: 'thread', revision: finish ? 4 : 3, durableSequence: finish ? 2 : 1, changes: finish
				? [{ type: 'upsert', entry: { type: 'item', entryId: 'result', turnId: 'turn', transient: false, item: { type: 'toolResult', itemId: 'result', turnId: 'turn', toolCallId: 'shell', text: 'Denied <script>alert(1)</script>', isError: true } } }]
				: [{ type: 'upsert', entry: { type: 'toolOutput', entryId: 'stdout', turnId: 'turn', toolCallId: 'shell', stream: 'stdout', text: '<img src=x onerror=alert(1)>' } }, { type: 'upsert', entry: { type: 'toolOutput', entryId: 'stderr', turnId: 'turn', toolCallId: 'shell', stream: 'stderr', text: 'warning' } }],
		});
		toolEntries.push(...update.changes.flatMap(change => change.type === 'upsert' ? [change.entry] : []));
		list.render(chatTranscriptListItems(toolEntries));
	},
	linkRequests: () => linkRequests,
	finishLink: () => completeLink?.(),
	closeConnection: () => connectionChanges.fire(),
	setAppResourceMode: mode => { linkMode = mode; },
	appState: () => ({ messages: appMessages, views: [...webviews.webviews].length }),
	showChatApp: (voice = false, cowork = false, withMedia = false, virtualizeHistory = false) => {
		appChat?.dispose();
		window.ashChatTranscriptIntegration.showApp('read', false, withMedia);
		root.hidden = true;
		const chatServices = resources.add(services.createChild());
		if (new URLSearchParams(location.search).has('sessions')) {
			const chatContext = chatServices.get(IContextKeyService);
			IsSessionsWindowContext.bindTo(chatContext).set(true);
			ChatContextKeys.imagePreviewPresentation.bindTo(chatContext).set('popup');
			SessionsWorkspaceModeContext.bindTo(chatContext).set('code');
		}
		chatServices.registerInstance(IAccessibleViewService, accessibleView);
		chatServices.registerInstance(ILanguageModelsService, { onDidChangeModels: Event.None, isModelVisible: () => true } as unknown as ILanguageModelsService);
		chatServices.registerInstance(IChatSessionNavigationService, {
			createNewConversation: () => { throw new Error('Unexpected draft creation'); },
			revision: 0,
			getActiveConversation: () => ({ sessionId: 'app-session', threadId: 'app-thread' }),
			openConversation: async () => { if (!requestEditMode) throw new Error('Unexpected conversation navigation'); },
		} as unknown as IChatSessionNavigationService);
		chatServices.registerInstance(IChatService, {
			rewriteRequest: async options => {
				if (!requestEditMode || options.text === undefined) { throw new Error('Unexpected request edit'); }
				requestEdits.push({ ...options, text: options.text });
				await new Promise<void>((resolve, reject) => { completeRequestEdit = failure => failure ? reject(new Error('Synthetic edit failure')) : resolve(); });
				return { sessionId: options.sessionId, threadId: 'edited-thread' };
			}
		} as IChatService);
		if (requestEditMode) {
			chatServices.registerSingleton(ICommandService, () => chatServices.createInstance(StandaloneCommandService));
		}
		chatServices.registerInstance(IOpenerService, { open: async () => { throw new Error('Unexpected link opening'); } } as unknown as IOpenerService);
		if (!builtinBackend) chatServices.registerInstance(IVoiceCodeTranscriptionBackendService, undefined);
		chatServices.registerInstance(IAgentVoiceService, voice ? voiceFixture : undefined);
		registerTestVoiceInputServices(chatServices);
		composerServices = chatServices;
		if (new URLSearchParams(location.search).has('voiceOnboarding')) {
			chatServices.get(IStorageService).remove(AgentsVoiceStorageKeys.IntroBannerShown, StorageScope.PROFILE);
		}
		chatServices.registerSingleton(IMenuService, () => chatServices.createInstance(MenuService));
		const contextView = resources.add(new BrowserContextViewService(document.body));
		chatServices.registerInstance(IContextViewService, contextView);
		if (new URLSearchParams(location.search).has('richInput')) {
			resources.add(ChatInputEditors.register({ id: 'integration', create: options => chatServices.createInstance(ChatInputEditor, options) }));
		}
		chatServices.registerInstance(IDialogService, { confirm: async () => ({ confirmed: false }) } as unknown as IDialogService);
		const contextMenus: IContextMenuService = {
			contextMenuStyle: 'custom', hideContextMenu() { }, onDidShowContextMenu: Event.None, onDidHideContextMenu: Event.None,
			showContextMenu(delegate) {
				if ('getActions' in delegate) document.body.dataset.chatContextActions = delegate.getActions?.().map(action => action.id).join(' ');
			},
		};
		chatServices.registerInstance(IContextMenuService, contextMenus);
		if (cowork) {
			chatServices.registerSingleton(ITerminalConfigurationService, () => chatServices.createInstance(TerminalConfigurationService));
			chatServices.registerSingleton(IChatTipService, () => chatServices.createInstance(ChatTipService));
			chatServices.registerInstance(ILifecycleService, { onWillShutdown: Event.None } as unknown as ILifecycleService);
		}
		const model: IChatWidgetModel = {
			onDidChange: chatChanges.event, onDidChangeComposer: composerChanges.event, get composerGeneration() { return appChatGeneration; }, sessionId: 'app-session', get threadId() { return appChatThread; }, untitledSessionId: undefined, goal: undefined, get items() { return appItems; },
			get historyStatus() { return historyFailure; },
			get olderHistory() { return olderHistoryState; },
			loadOlderHistory: async () => {
				olderHistoryLoads++;
				olderHistoryState = { loading: true };
				chatChanges.fire();
				await new Promise<void>(resolve => { finishOlderHistory = resolve; });
				if (failOlderHistory) {
					failOlderHistory = false;
					olderHistoryState = { loading: false, error: localize('chat.history.olderFailed', 'Could not load earlier messages: {0}', 'Synthetic page failure') };
				} else {
					appItems = [...Array.from({ length: 20 }, (_, index) => ({ id: `older-${index}`, type: 'agentMessage' as const, text: `Earlier answer ${index}`, transient: false })), ...appItems];
					olderHistoryState = undefined;
				}
				chatChanges.fire();
			},
			get inputState() {
				const aiDisabled = services.get(IConfigurationService).getValue<boolean>(ChatAIDisabledSettingId);
				return { mode: 'plan' as const, queuedMessages: 0, approvalMode: 'manual' as const, phase: historyFailure ? 'error' as const : 'ready' as const, inputBlocked: !!historyFailure || aiDisabled, aiDisabled, canInterrupt: responseWorking, models: [], isAutomaticModel: true, slashCommands: [], skillSelectors: [], canSelectAgent: false, changes: hasConversationChanges ? { files: 1, additions: 1, deletions: 1 } : undefined };
			},
			send: async (text, mode, _skills, contexts, submissionOptions) => { appChatMessages.push({ text, mode, contexts, ...(submissionOptions ? { commandId: submissionOptions.commandId, source: submissionOptions.source } : {}) }); },
			executeServerCommand: async () => { }, interrupt: async () => { }, refreshChanges: async () => { }, selectModel: async () => { }, selectReasoningEffort: async () => { }, selectAutomaticModel: async () => { },
			listAgents: async () => [], selectAgent() { }, selectMode() { }, selectApprovalMode() { }, resolveInteraction: async () => { }, retryFailedTurn: async () => { }, dispose() { }, [Symbol.dispose]() { },
		};
		const container = document.createElement('main');
		container.style.cssText = 'height:700px;width:800px;background:var(--ash-editor-background);color:var(--ash-foreground);font-family:system-ui';
		document.body.append(container);
		appChat = cowork ? resources.add(chatServices.createInstance(NativeChatWidget, container, 'app-chat', model, () => { }, (host: HTMLElement, delegate: ChatInputDelegate) => chatServices.createInstance(ReplyChatInputFactory).createSessionInput(host, delegate, model, resources))) : resources.add(chatServices.createInstance(ChatWidget, container, 'app-chat', model, () => { }, contextMenus, contextView, chatServices.get(ICommandService), accessibleView, chatServices.get(INotificationService), undefined, undefined, undefined, undefined, virtualizeHistory ? { virtualizeHistoryFrom: constObservable(48) } : undefined));
		appChat.setVisible(true);
	},
	showLongCodeHistory: (turns, virtualizeHistory, withTools = false) => {
		window.ashChatTranscriptIntegration.showChatApp(false, false, false, virtualizeHistory);
		const appRows = appItems;
		const host = appChat!.domNode.parentElement!;
		host.style.position = 'fixed';
		host.style.inset = '20px auto auto 20px';
		const entries: ThreadTranscriptEntry[] = [];
		for (let index = 0; index < turns; index++) {
			const turnId = `code-turn-${index}`;
			const toolCallId = `code-tool-${index}`;
			const program = index % 2 ? 'fixture-command' : 'fixture-read';
			const output = Array.from({ length: 18 }, (_, line) => `Tool evidence ${index}, line ${line}`).join('\n');
			const code = Array.from({ length: 14 }, (_, line) => `const value${line} = ${index + line};`).join('\n');
			const items: Extract<ThreadTranscriptEntry, { type: 'item' }>['item'][] = [
				{ type: 'userMessage', itemId: `code-prompt-${index}`, turnId, text: `Code prompt ${index}` },
				{ type: 'toolCall', itemId: `code-call-${index}`, turnId, toolCallId, name: program, argumentsJson: JSON.stringify({ index }),
					binding: { registryGeneration: 1, definitionDigest: 'fixture', sourceChain: [{ type: 'product', component: 'fixture' }], caller: { type: 'direct' },
						activity: index % 2 ? { type: 'command', program, arguments: [String(index)], workingDirectory: '/fixture' } : { type: 'read', target: `file-${index}.ts` } } },
				{ type: 'toolResult', itemId: `code-result-${index}`, turnId, toolCallId, text: output, isError: index === 1, content: [{ type: 'text', text: output }] },
				{ type: 'agentMessage', itemId: `code-reply-${index}`, turnId, text: `## Code reply ${index}\n\n${'Synthetic repository work. '.repeat(40 + index % 6)}\n\n\`\`\`typescript\n${code}\n\`\`\`\n\nFinal result ${index}.` },
			];
			for (const item of items) entries.push({ type: 'item', entryId: item.itemId, turnId, transient: false, item });
		}
		appItems = chatTranscriptListItems(entries);
		if (withTools) {
			const media: ThreadTranscriptEntry[] = [
				{ type: 'item', entryId: 'long-image-call', turnId: 'long-media', transient: false, item: { type: 'toolCall', itemId: 'long-image-call', turnId: 'long-media', toolCallId: 'long-image', name: 'imagegen', argumentsJson: '{}' } },
				{ type: 'item', entryId: 'long-image-result', turnId: 'long-media', transient: false, item: { type: 'toolResult', itemId: 'long-image-result', turnId: 'long-media', toolCallId: 'long-image', isError: false, text: '', content: [
					{ type: 'imageAttachment', detail: 'auto', attachment: { contentDigest: 'sha256:long-image', mediaType: 'png', encodedBytes: imageBytes.length, width: 2, height: 1 } },
				] } },
			];
			appItems = [...appItems, ...appRows, ...chatTranscriptListItems(media, undefined, [], { sessionId: 'app-session', threadId: 'app-thread' })];
		}
		chatChanges.fire();
	},
	showHistoryPagination: (fail = false) => {
		window.ashChatTranscriptIntegration.showChatApp();
		olderHistoryLoads = 0;
		failOlderHistory = fail;
		olderHistoryState = { loading: false };
		appItems = Array.from({ length: 30 }, (_, index) => ({ id: `recent-${index}`, type: 'agentMessage', text: `Recent answer ${index}\n\n${'Synthetic response. '.repeat(15)}`, transient: false }));
		chatChanges.fire();
	},
	finishHistoryPage: () => finishOlderHistory?.(),
	historyPageLoads: () => olderHistoryLoads,
	prepareHistoryBenchmark: (turns, textBytes) => {
		appChat?.dispose();
		root.hidden = false;
		const usage = { modelInvocations: 0, inputTokens: { reported: 0, complete: true }, outputTokens: { reported: 0, complete: true }, cachedInputTokens: { reported: 0, complete: true }, cacheWriteInputTokens: { reported: 0, complete: true }, reasoningTokens: { reported: 0, complete: true } };
		for (const bounded of [false, true]) {
			const first = bounded ? Math.max(0, turns - 20) : 0;
			const items = Array.from({ length: turns - first }, (_, index) => {
				const number = index + first + 1;
				return { type: 'agentMessage' as const, itemId: `history-answer-${number}`, turnId: `history-turn-${number}`, text: `Answer ${number}: ` + 'x'.repeat(textBytes) };
			});
			const result: SessionThreadReadResult = {
				thread: { sessionId: 'history-session', threadId: 'history-thread', agentId: 'history-agent', origin: { type: 'root' }, title: 'Controlled history', status: 'active', sequence: turns, advisor: { type: 'off' }, usage, referenceCost: { knownAmounts: [], complete: true }, hookRuns: [], turns: items.map(item => ({ turnId: item.turnId, status: 'completed', kind: 'coding', mode: 'agent', toolMode: 'direct', approvalMode: 'manual', usage, items: [item] })) },
				transcript: { sessionId: 'history-session', threadId: 'history-thread', durableSequence: turns, revision: turns, entries: items.map(item => ({ type: 'item', entryId: `item:${item.itemId}`, turnId: item.turnId, item, transient: false })) },
				...(bounded ? { history: { hasOlderTurns: first > 0, oldestTurnId: items[0]?.turnId } } : {}),
			};
			for (const method of ['read', 'subscribe']) historyWires.set(`session/thread/${method}:${bounded}`, JSON.stringify({ jsonrpc: '2.0', id: 1, result: method === 'read' ? result : { ...result, updates: [] } }));
		}
	},
	runHistoryBenchmark: async (method, bounded) => {
		list.render([]);
		await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
		const params = { sessionId: 'history-session', threadId: 'history-thread', ...(bounded ? { history: { type: 'latest' as const, turnLimit: 20 } } : {}) };
		const start = performance.now();
		const result = method === 'read' ? await toolService.read(params) : await toolService.subscribe({ ...params, afterSequence: 0 });
		const receivedAt = performance.now();
		const items = chatTranscriptListItems(result.transcript.entries, result.thread.turns.at(-1)?.turnId, result.thread.turns, result.thread);
		list.render(items);
		const renderedAt = performance.now();
		await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
		return { ...historyDecodeTiming, receiveAndMapMs: receivedAt - start, renderMs: renderedAt - receivedAt, throughPaintMs: performance.now() - start, items: list.element.querySelectorAll('.ash-chat-item').length, lastText: items.at(-1)?.text ?? '' };
	},
	showHistoryFailure: () => {
		window.ashChatTranscriptIntegration.showChatApp();
		historyFailure = {
			kind: 'history', message: localize('chat.history.loadFailed', 'Could not load chat history: {0}', 'Synthetic history failure'),
			action: {
				label: localize('chat.history.retry', 'Retry loading chat'), run: async () => {
					historyRecoveries++;
					await new Promise<void>(resolve => { finishHistory = resolve; });
					historyFailure = undefined;
					chatChanges.fire();
				}
			},
		};
		chatChanges.fire();
	},
	setAIDisabled: value => services.get(IConfigurationService).updateValue(ChatAIDisabledSettingId, value),
	isCodeChatActive: () => chatViews.getViewContainerModel(CHAT_VIEW_CONTAINER_ID).activeViewDescriptors.some(view => view.id === CHAT_VIEW_ID),
	finishHistoryRecovery: () => { finishHistory?.(); finishHistory = undefined; },
	historyRecoveries: () => historyRecoveries,
	openChatAuxiliaryWindow: async () => {
		const scope = resources.add(services.createChild());
		scope.registerInstance(IAccessibleViewService, accessibleView);
		const windows = resources.add(scope.createInstance(BrowserAuxiliaryWindowService, window, document.body));
		const auxiliary = await windows.open({ title: 'Borrowed conversation', width: 640, height: 480 });
		await auxiliary.whenStylesHaveLoaded;
		const shell = resources.add(scope.createInstance(ChatAuxiliaryWindow, auxiliary, 'Borrowed conversation', undefined));
		const content = document.createElement('section');
		content.className = 'ash-chat';
		content.dataset.testChatWindow = 'true';
		const input = document.createElement('textarea');
		input.setAttribute('aria-label', 'Borrowed draft');
		input.value = 'Preserved draft';
		content.append(input);
		shell.mount(content);
		resources.add(auxiliary.onDidClose(() => {
			document.body.append(content);
			shell.dispose();
			auxiliary.dispose();
			input.focus();
		}));
		auxiliary.layout();
	},
	prepareSessionLifecycle: async wording => {
		await import('../../../src/ash/sessions/contrib/sessions/browser/views/sessionsViewActions.js');
		await services.get(IConfigurationService).updateValue(ChatSessionArchiveActionWordingSettingId, wording);
		const lifecycleServices = resources.add(services.createChild());
		lifecycleServices.registerInstance(ISecretStorageService, resources.add(new BaseSecretStorageService()));
		lifecycleServices.registerInstance(IProjectService, { onDidChange: Event.None, list: async () => [] } as unknown as IProjectService);
		lifecycleCommands = resources.add(new CommandService(lifecycleServices));
		lifecycleServices.registerInstance(ICommandService, lifecycleCommands);
		lifecycleServices.registerInstance(IViewsService, { focusView: async () => { file.focus(); return true; } } as unknown as IViewsService);
		const historyDescriptor = getSingletonServiceDescriptors().find(([id]) => id === IAgentSessionsService)![1];
		lifecycleServices.registerSingleton(IAgentSessionsService, () => lifecycleServices.createInstance(historyDescriptor));
		lifecycleServices.registerSingleton(ISessionGroupsService, () => lifecycleServices.createInstance(SessionGroupsService));
		const actionsDescriptor = getSingletonServiceDescriptors().find(([id]) => id === IAgentSessionActionsService)![1];
		lifecycleServices.registerSingleton(ISessionsListModelService, () => lifecycleServices.createInstance(SessionsListModelService));
		lifecycleServices.registerSingleton(IAgentSessionActionsService, () => lifecycleServices.createInstance(actionsDescriptor));
		const disconnected = createDisconnectedRendererApi();
		lifecycleServices.registerInstance(IAgentConnection, disconnected);
		let catalog: AgentSession[] = [{ sessionId: 'lifecycle', kind: 'code' as const, title: 'Synthetic task', status: 'active', manager: { status: 'idle', statusChangedAtUnixMs: 0 }, threads: [{ threadId: 'lifecycle', title: 'Root', status: 'active' }, { threadId: 'lifecycle-child', title: 'Child', parentThreadId: 'lifecycle', status: 'active' }] }];
		const read = () => ({ session: catalog[0]!, agentTree: { roots: [] } });
		lifecycleServices.registerInstance(IAppServerApi, { isAvailable: true, connectionGeneration: 1, getConnectionState: async () => 'ready', getSlashCommands: async () => [], onConnectionState: () => Disposable.None });
		lifecycleServices.registerInstance(IServerEventApi, { subscribe: () => Disposable.None });
		lifecycleServices.registerInstance(IAgentModelsService, disconnected.model);
		lifecycleServices.registerInstance(IAgentTurnService, disconnected.turn);
		lifecycleServices.registerInstance(IAgentSessionService, {
			...disconnected.session,
			list: async () => ({ sessions: catalog }), subscribeCatalog: async () => ({ sessions: catalog }), unsubscribeCatalog: async () => { },
			read: async () => read(), readCatalog: async () => ({ session: catalog[0] }),
			subscribe: async () => ({ ...read(), threadSnapshots: [] }), unsubscribe: async () => { },
			archive: async ({ sessionId }) => {
				lifecycleRequests.push({ operation: 'archive', sessionId });
				catalog = catalog.map(session => ({ ...session, status: 'archived', threads: session.threads.map(thread => ({ ...thread, status: 'archived' })) }));
				return read();
			},
			restore: async ({ sessionId }) => {
				lifecycleRequests.push({ operation: 'restore', sessionId });
				catalog = catalog.map(session => ({ ...session, status: 'active', threads: session.threads.map(thread => ({ ...thread, status: thread.parentThreadId ? 'archived' : 'active' })) }));
				return read();
			},
		});
		lifecycleServices.registerSingleton(IDevContainerAgentHostService, () => lifecycleServices.createInstance(DevContainerAgentHostService));
		const providers = resources.add(new SessionsProvidersService());
		lifecycleServices.registerInstance(ISessionsProvidersService, providers);
		const provider = resources.add(lifecycleServices.createInstance(AppServerSessionsProvider, {
			workspace: () => ({ type: 'current' }),
			selectWorkspace: async () => undefined,
		}));
		resources.add(providers.registerProvider(provider));
		lifecycleSessions = resources.add(lifecycleServices.createInstance(SessionsManagementService, provider.id));
		await lifecycleSessions.initialize();
		lifecycleServices.registerInstance(ISessionsManagementService, lifecycleSessions);
		lifecycleServices.registerInstance(IChatSessionNavigationService, {
			createNewConversation: () => { lifecycleSessions!.createUntitledSession(); },
			revision: 0,
			getConversations: () => [], appendToActiveDraft: () => { }, captureActiveDraft: async () => undefined,
			startVoiceConversation: async () => { throw new Error('Voice is unavailable in the session lifecycle fixture'); },
			getActiveConversation: () => lifecycleSessions!.activeUntitledSession ? undefined : lifecycleSessions!.active && { sessionId: lifecycleSessions!.active!.session.sessionId, threadId: lifecycleSessions!.active!.threadId },
			openConversation: async (sessionId, threadId) => { lifecycleOpened.push(`${sessionId}/${threadId}`); await lifecycleSessions!.openThread(sessionId, threadId); },
		});
	},
	runSessionAction: async (command, target) => {
		const result = await lifecycleCommands!.executeCommand(command, target);
		if (command === 'agentSession.archive' && result === true) lifecycleSessions!.createUntitledSession('Preserved synthetic draft');
		return result;
	},
	sessionLifecycleState: () => ({ activeThreadId: lifecycleSessions!.active?.threadId, requests: lifecycleRequests, opened: lifecycleOpened, sessions: lifecycleSessions!.sessions.map(session => ({ id: session.sessionId, status: session.status, threads: session.chats.map(chat => `${chat.threadId}/${chat.status}`) })), drafts: lifecycleSessions!.untitledSessions.map(session => session.title) }),
	showReadAloudMessage: async (text, cowork = false) => {
		await import('../../../src/ash/workbench/contrib/chat/electron-browser/actions/voiceChatActions.js');
		readBridge ??= resources.add(new MainThreadSpeech(1000, readApi, services.get(ISpeechService)));
		readBridge.update(readSnapshot);
		window.ashChatTranscriptIntegration.showCopiedMessage(text, cowork);
	},
	finishReadAloud: (failure = false) => {
		for (const events of readEvents.values()) events.push(failure ? { status: 3, text: 'reader failed' } : { status: 2 });
	},
	stopReadAloudCommand: () => services.get(ICommandService).executeCommand('workbench.action.speech.stopReadAloud'),
	revokeReadAloudProvider: () => readBridge?.clear(),
	readAloudState: () => ({ text: [...spokenText], open: readEvents.size, closed: closedReadSessions }),
	showCopiedMessage: (text, cowork = false) => {
		window.ashChatTranscriptIntegration.showChatApp(false, cowork);
		window.ashChatTranscriptIntegration.updateCopiedMessage(text);
	},
	clearCopiedMessage: () => { appItems = []; chatChanges.fire(); },
	updateCopiedMessage: (text, transient = false) => {
		appItems = chatTranscriptListItems([{ type: 'item', entryId: 'copy-response', turnId: 'turn', transient, item: { type: 'agentMessage', itemId: 'response', turnId: 'turn', text } }]);
		chatChanges.fire();
	},
	showAcceptedContext: (text, cowork = false) => {
		window.ashChatTranscriptIntegration.showChatApp(false, cowork);
		window.ashChatTranscriptIntegration.updateAcceptedContext(text);
	},
	updateAcceptedContext: text => {
		appItems = chatTranscriptListItems([{ type: 'item', entryId: 'accepted-context', turnId: 'turn', transient: false, item: { type: 'userContext', itemId: 'accepted-context', turnId: 'turn', name: 'Accepted <context>', content: text } }]);
		chatChanges.fire();
	},
	addTerminalContext: () => appChat?.addContext({ id: 'terminal:saved', kind: 'terminal', name: 'Terminal: saved', resource: URI.parse('internal://terminal?id=saved'), terminalSnapshot: { text: 'Saved <script>unsafe()</script>\nTerminal output', columns: 80 }, resolve: async () => ({ name: 'Terminal: saved', content: 'Saved terminal context' }) }),
	addUserContext: () => appChat?.addContext({ id: 'private-file', kind: 'file', name: 'private.txt', resolve: async () => ({ name: 'private.txt', content: 'private file body' }) }),
	appImagePending: () => completeImageDecode !== undefined,
	delayAppImages: () => { window.createImageBitmap = ((...args: Parameters<typeof createImageBitmap>) => new Promise<ImageBitmap>((resolve, reject) => { completeImageDecode = () => { window.createImageBitmap = createBitmap; void createBitmap(...args).then(resolve, reject); }; })) as typeof createImageBitmap; },
	finishAppImages: () => { completeImageDecode?.(); completeImageDecode = undefined; },
	persistedChatDraft: () => readNewChatDraftState(services.get(IStorageService), appChatThread, chatInputStatePersistence),
	chatDraft: async () => (await appChat?.captureDraft())?.draft.text,
	chatDraftContexts: async () => (await appChat?.captureDraft())?.draft.contexts,
	chatDraftContextNames: async () => (await appChat?.captureDraft())?.draft.contexts.map(context => context.name) ?? [],
	setChatVisible: visible => appChat?.setVisible(visible),
	retireChat: () => { appChatGeneration++; composerChanges.fire(); appChatThread = 'replacement-thread'; chatChanges.fire(); },
	voiceState: () => voiceControls,
	showVoiceIntroduction: () => { composerServices!.invokeFunction(CommandsRegistry.getCommand('agentsVoice.showIntroduction')!); },
	toggleIntroductionFocus: () => { composerServices!.get(IChatInputNoticeHubService).toggleNoticeFocus(); },
	setIntroductionNotification: visible => {
		const notifications = composerServices!.get(IChatInputNotificationService);
		if (visible) notifications.setNotification({ id: 'test.voice-notice', severity: ChatInputNotificationSeverity.Error, message: 'Synthetic connection failure', actions: [], dismissible: true, autoDismissOnMessage: false });
		else notifications.deleteNotification('test.voice-notice');
	},
	voiceSelection: () => chosenVoice,
	proposeVoiceTask: () => {
		if (!voiceSession) throw new Error('Voice is not connected');
		voiceTasks.fire({ ...voiceSession, delegationId: 'voice-proposal', commandId: 'voice-command', transcript: 'run tests <script>unsafe()</script>' });
		appItems = [...appItems, ...chatTranscriptListItems([{ type: 'voiceTranscript', entryId: 'speech', transcript: { itemId: 'speech', voiceSessionId: voiceSession.resourceId, mediaEpoch: voiceSession.mediaEpoch, speaker: 'user', text: 'run tests <script>unsafe()</script>', startMs: 0, endMs: 100, afterItemId: null } }])];
		chatChanges.fire();
	},
	appLogs: () => appLogs,
	delayAppResources: () => { appCallMode = 'delay'; },
	chatMessages: () => appChatMessages,
	showApp: (mode = 'read', allowCsp = false, withMedia = false) => {
		mediaRequests = [];
		delayMedia = withMedia && mode === 'delay';
		mediaAborted = false;
		allowAppCsp = allowCsp;
		appRequests = true;
		appCallMode = mode;
		linkMode = 'read';
		linkRequests = [];
		const update = receiveToolUpdate({
			sessionId: 'app-session', threadId: 'app-thread', revision: 2, durableSequence: 1, changes: [
				{ type: 'upsert', entry: { type: 'item', entryId: 'app-call', turnId: 'turn', transient: false, item: { type: 'toolCall', itemId: 'app-call', turnId: 'turn', toolCallId: 'report', name: 'report', argumentsJson: '{"tool":"report","arguments":{"value":7}}' } } },
				{
					type: 'upsert', entry: {
						type: 'item', entryId: 'app-result', turnId: 'turn', transient: false, item: {
							type: 'toolResult', itemId: 'app-result', turnId: 'turn', toolCallId: 'report', text: 'Report ready', isError: false, content: [
								{ type: 'text', text: 'Report ready' },
								{ type: 'artifact', artifact: { source: { type: 'structuredResult' }, mimeType: 'application/json', data: { type: 'json', json: '{"value":7}' }, contentDigest: 'sha256:result', truncated: false } },
								{ type: 'artifact', artifact: { source: { type: 'mcpApp', uri: 'ui://report' }, mimeType: 'text/html;profile=mcp-app', data: { type: 'json', json: '{"input":{"value":7}}' }, contentDigest: 'sha256:app', truncated: false } },
								{ type: 'artifact', artifact: { source: { type: 'viewMetadata' }, mimeType: 'application/json', data: { type: 'json', json: '{"viewOnly":"metadata"}' }, contentDigest: 'sha256:metadata', truncated: false } },
								...(withMedia ? [{ type: 'imageAttachment' as const, detail: 'auto' as const, attachment: { contentDigest: 'sha256:image', mediaType: 'png' as const, encodedBytes: imageBytes.length, width: 2, height: 1 } }, { type: 'audioAttachment' as const, attachment: { contentDigest: 'sha256:audio', mediaType: 'wav' as const, encodedBytes: 32044, durationMs: 1000 } }] : []),
								{ type: 'artifact', artifact: { source: { type: 'embeddedResource', uri: 'docs://embedded' }, mimeType: 'text/plain', data: { type: 'text', text: 'Embedded content' }, resourceMetadata: '{"private":"resource-view-only"}', contentDigest: 'sha256:embedded', truncated: false } },
								{ type: 'artifact', artifact: { source: { type: 'viewMetadata' }, mimeType: 'application/vnd.ash.mcp-content-metadata+json', data: { type: 'json', json: JSON.stringify([{ index: 0, annotations: { audience: ['user'], priority: 0.8 }, _meta: { private: 'text-view-only' } }, ...(withMedia ? [{ index: 4, _meta: { private: 'image-view-only' } }, { index: 5, annotations: { priority: 0.4 } }] : [])]) }, contentDigest: 'sha256:content-metadata', truncated: false } },
							]
						}
					}
				},
			]
		});
		appItems = chatTranscriptListItems(update.changes.flatMap(change => change.type === 'upsert' ? [change.entry] : []), undefined, [], { sessionId: update.sessionId, threadId: update.threadId });
		list.render(appItems);
	},
	showLink: mode => {
		appRequests = false;
		linkMode = mode;
		linkRequests = [];
		const update = receiveToolUpdate({
			sessionId: 'link-session', threadId: 'link-thread', revision: 2, durableSequence: 1, changes: [
				{ type: 'upsert', entry: { type: 'item', entryId: 'linked-result', turnId: 'link-turn', transient: false, item: { type: 'toolResult', itemId: 'linked-result', turnId: 'link-turn', toolCallId: 'documents', text: '', isError: false, content: [{ type: 'artifact', artifact: { source: { type: 'resourceLink', uri: 'file:///server/report.md' }, mimeType: 'text/markdown', data: { type: 'json', json: '{"name":"report.md","description":"Read from the original server"}' }, contentDigest: 'sha256:link', truncated: false } }] } } },
			]
		});
		list.render(chatTranscriptListItems(update.changes.flatMap(change => change.type === 'upsert' ? [change.entry] : []), undefined, [], { sessionId: update.sessionId, threadId: update.threadId }));
	},
	mediaPreviewState: async () => ({ resource: activeResource.toString(), content: mediaPreview?.getAccessibleContent(), readonly: (await services.get(IFileService).stat(activeResource)).readonly === true }),
	closeMediaPreview: () => { mediaPreview?.dispose(); mediaPreview = undefined; mediaPreviewRoot?.remove(); mediaPreviewRoot = undefined; },
	readResource: async uri => [...(await services.get(IFileService).readFileBytes(URI.parse(uri))).bytes],
	showArtifacts: revise => {
		const update = receiveToolUpdate({
			sessionId: 'resource-session', threadId: 'resource-thread', revision: revise ? 3 : 2, durableSequence: 2, changes: [
				{ type: 'upsert', entry: { type: 'item', entryId: 'call', turnId: 'turn', transient: false, item: { type: 'toolCall', itemId: 'call', turnId: 'turn', toolCallId: 'resources', name: 'resources', argumentsJson: '{}' } } },
				{
					type: 'upsert', entry: {
						type: 'item', entryId: 'result', turnId: 'turn', transient: false, item: {
							type: 'toolResult', itemId: 'result', turnId: 'turn', toolCallId: 'resources', text: 'Legacy fallback', isError: false, content: [
								{ type: 'artifact', artifact: { source: { type: 'embeddedResource', uri: 'file:///untrusted/report.md' }, mimeType: 'text/markdown', data: { type: 'text', text: revise ? 'Changed truncated resource' : '<script>window.compromised = true</script>\r\n中文' }, contentDigest: revise ? 'sha256:revised' : 'sha256:text', truncated: revise } },
								{ type: 'artifact', artifact: { source: { type: 'structuredResult' }, mimeType: 'application/json', data: { type: 'json', json: '{"amount":1.0,"text":"<img src=x onerror=alert(1)>"}' }, contentDigest: 'sha256:json', truncated: false } },
								{ type: 'artifact', artifact: { source: { type: 'embeddedResource', uri: 'mcp://data/blob.bin' }, mimeType: 'application/octet-stream', data: { type: 'binary', bytes: [0, 127, 255] }, contentDigest: 'sha256:bytes', truncated: false } },
							]
						}
					}
				},
			]
		});
		list.render(chatTranscriptListItems(update.changes.flatMap(change => change.type === 'upsert' ? [change.entry] : []), undefined, [], { sessionId: update.sessionId, threadId: update.threadId }));
	},
	showMedia: delay => {
		delayMedia = delay;
		mediaRequests = [];
		mediaAborted = false;
		const source = { sessionId: 'media-session', threadId: 'media-thread' };
		mediaEntries = [
			{ type: 'item', entryId: 'image', turnId: 'turn', transient: false, item: { type: 'userImageAttachment', itemId: 'image', turnId: 'turn', attachment: { contentDigest: 'sha256:image', mediaType: 'png', encodedBytes: imageBytes.length, width: 2, height: 1 } } },
			{ type: 'item', entryId: 'audio', turnId: 'turn', transient: false, item: { type: 'userAudioAttachment', itemId: 'audio', turnId: 'turn', attachment: { contentDigest: 'sha256:audio', mediaType: 'wav', encodedBytes: 32044, durationMs: 1000 } } },
			{ type: 'item', entryId: 'call', turnId: 'turn', transient: false, item: { type: 'toolCall', itemId: 'call', turnId: 'turn', toolCallId: 'tool', name: 'image-tool', argumentsJson: '{}' } },
			{ type: 'item', entryId: 'result', turnId: 'turn', transient: false, item: { type: 'toolResult', itemId: 'result', turnId: 'turn', toolCallId: 'tool', text: 'Result', isError: false, content: [{ type: 'text', text: 'Result' }, { type: 'imageAttachment', detail: 'auto', attachment: { contentDigest: 'sha256:image', mediaType: 'png', encodedBytes: imageBytes.length, width: 2, height: 1 } }] } },
		];
		list.render(chatTranscriptListItems(mediaEntries, undefined, [], source));
	},
	refreshMedia: () => list.render(chatTranscriptListItems(mediaEntries, undefined, [], { sessionId: 'media-session', threadId: 'media-thread' })),
	finishMedia: () => { for (const resolve of pendingMedia) resolve(); pendingMedia.clear(); },
	openedAppLinks: () => openedAppLinks,
	mediaState: () => ({ requests: mediaRequests, aborted: mediaAborted }),
	remove: () => list.render([]),
	dispose: () => resources.dispose(),
};
window.addEventListener('pagehide', () => resources.dispose(), { once: true });
