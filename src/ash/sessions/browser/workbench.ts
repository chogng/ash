import { Button } from '../../base/browser/ui/button/button.js';
import { defaultButtonStyles } from '../../platform/theme/browser/defaultStyles.js';
import { Lxicon } from '../../base/common/lxicons.js';
import { DisposableStore } from '../../base/common/lifecycle.js';
import { StatusbarService } from '../../workbench/browser/parts/statusbar/statusbarPart.js';
import { ILanguageServerStatusService } from '../../workbench/services/language/common/languageServerStatusService.js';
import { IProjectService } from '../../platform/projects/common/projectService.js';
import { SessionsAgentSessionService } from './agentHost/sessionsAgentSessionService.js';
import { BannerPart } from '../../workbench/browser/parts/banner/bannerPart.js';
import { IBannerService } from '../../workbench/services/banner/browser/bannerService.js';
import type { Position } from '../../workbench/services/layout/browser/layoutService.js';
import { SessionConversationLinks } from './agentHost/sessionConversationLinks.js';
import { SessionsAgentThreadService } from './agentHost/sessionsAgentThreadService.js';
import { SessionsSearchService } from '../contrib/providers/agentHost/browser/sessionsSearchService.js';
import { SessionFileSystemContribution } from '../contrib/providers/agentHost/browser/sessionFileSystemContribution.js';
import { sessionWorkspaceUri } from '../common/sessionWorkspace.js';
import { ISessionProviderScopeService, ISessionPrimaryProviderServices, SessionProviderScopeService, SessionProviderServices } from './agentHost/sessionProviderScopeService.js';
import { SessionsChatService } from './agentHost/sessionsChatService.js';
import { SessionsLanguageModelsService } from './agentHost/sessionsLanguageModelsService.js';
import { SessionsPromptsService } from './agentHost/sessionsPromptsService.js';
import { SessionsExecutionSettingsService } from './agentHost/sessionsExecutionSettingsService.js';
import { sessionIdentity } from '../services/sessions/common/sessionIdentity.js';
import { IDefaultLogLevelsService } from '../../workbench/services/log/common/defaultLogLevels.js';
import { IBrowserPasswordService, UnavailableBrowserPasswordService } from '../../platform/browserView/common/browserPasswordService.js';
import { IDocumentEditorTextModelService } from '../../workbench/services/documentEditor/common/documentTypes.js';
import { DocumentEditorTextModelService } from '../../workbench/services/documentEditor/browser/documentEditorTextModelService.js';
import { IChannelService } from "../../platform/collab/common/channelService.js";
import { IActivityService } from '../../workbench/services/activity/common/activity.js';
import { ActivityService } from '../../workbench/services/activity/browser/activityService.js';
import { ProgressService } from '../../workbench/services/progress/browser/progressService.js';
import { IProgressService } from '../../platform/progress/common/progress.js';
import { IRemoteConnectionApi, IRemoteConnectionService, RemoteConnectionService, UnavailableRemoteConnectionApi } from '../../platform/remote/common/remoteConnectionService.js';
import { IDebugAdapterProcessService } from '../../platform/debug/common/debugAdapterProcessService.js';
import { ITestExecutionService } from '../../platform/testing/common/testExecutionService.js';
import { SystemOutputService } from '../../workbench/services/output/browser/systemOutputService.js';
import { AppServerLanguageServerStatusService } from '../../workbench/services/language/browser/appServerLanguageServerStatusService.js';
import { AppServerLanguageDiagnosticsService } from '../../workbench/services/language/browser/appServerLanguageDiagnosticsService.js';
import { ILanguageServerLifecycleService } from '../../workbench/services/language/common/languageServerLifecycleService.js';
import { AppServerLanguageLifecycleService } from '../../workbench/services/language/browser/appServerLanguageLifecycleService.js';
import { AppServerLanguageProviders } from '../../workbench/services/language/browser/appServerLanguageProviders.js';
import { ILanguageDiagnosticsService } from '../../workbench/services/language/common/languageDiagnosticsService.js';
import { LanguageDiagnosticsMarkerBridge } from '../../workbench/services/language/browser/languageDiagnosticsMarkerBridge.js';
import { IOutputService } from '../../workbench/services/output/common/output.js';
import { IStatusbarService } from '../../workbench/services/statusbar/browser/statusbar.js';
import type { IConfigurationModel } from '../../platform/configuration/common/configuration.js';
import { BaseSecretStorageService, ISecretStorageService, ISecretStorageStatusService } from '../../platform/secrets/common/secrets.js';
import { ICallService } from '../../platform/call/common/callService.js';
import { IAgentVoiceService } from '../../platform/agentHost/common/agentService.js';
import { BrowserAuxiliaryWindowService, IAuxiliaryWindowService } from '../../workbench/services/auxiliaryWindow/browser/auxiliaryWindowService.js';
import { ILanguageFeatureDebounceService, LanguageFeatureDebounceService } from '../../editor/common/services/languageFeatureDebounce.js';
import { IInlineCompletionsService, InlineCompletionsService } from '../../editor/browser/services/inlineCompletionsService.js';
import { IMarkerDecorationsService } from '../../editor/common/services/markerDecorations.js';
import { MarkerDecorationsService } from '../../editor/common/services/markerDecorationsService.js';
import { ILanguageServerService } from '../../platform/language/common/languageServerService.js';
import { INetworkDiagnosticsService } from '../../platform/networkDiagnostics/common/networkDiagnosticsService.js';
import { ISnippetsService } from '../../workbench/contrib/snippets/browser/snippets.js';
import { IMessageHistoryService } from '../../platform/messageHistory/common/messageHistory.js';
import { GlobalExtensionEnablementService } from '../../platform/extensionManagement/common/extensionEnablementService.js';
import { IGlobalExtensionEnablementService } from '../../platform/extensionManagement/common/extensionManagement.js';
import { withEnabledBuiltInExtensions } from '../../platform/extensions/browser/extensionApi.js';
import { WebWorkerExtensionHost } from '../../workbench/services/extensions/browser/webWorkerExtensionHost.js';
import { IExtensionBackendApi } from '../../platform/agentHost/common/extensionBackendApi.js';
import { IExtensionApi } from '../../platform/extensions/common/extensionApi.js';
import { IContentSearchService, IContentSearchConfigurationService } from '../../platform/search/common/search.js';
import { FileContentSearchService } from '../../platform/search/browser/searchService.js';
import { ISearchService } from '../../workbench/services/search/common/search.js';
import { SearchService } from '../../workbench/services/search/common/searchService.js';
import { IAgentExecutionSettingsService } from '../../platform/agentHost/common/agentExecutionSettingsService.js';
import { IChatEditingService } from '../../workbench/contrib/chat/common/editing/chatEditingService.js';
import { IUriIdentityService } from '../../platform/uriIdentity/common/uriIdentity.js';
import { IPromptsService } from '../../workbench/contrib/chat/common/promptSyntax/service/promptsService.js';
import { PromptsService } from '../../workbench/contrib/chat/common/promptSyntax/service/promptsServiceImpl.js';
import { IWorkspaceTrustApi, IWorkspaceTrustManagementService } from '../../platform/workspace/common/workspaceTrust.js';
import { WorkspaceTrustManagementService } from '../../workbench/services/workspaces/common/workspaceTrust.js';
import { IAgentCapabilitiesService } from '../../platform/agentCapabilities/common/agentCapabilitiesService.js';
import { IAgentToolsApi } from '../../platform/agentHost/common/agentToolsApi.js';
import { IMcpServerStatusService } from '../../platform/mcp/common/mcpServerStatusService.js';
import { IMcpServerManagementService } from '../../platform/mcp/common/mcpServerManagementService.js';
import { IConnectorService } from '../../platform/connectors/common/connectorService.js';
import { AppServerConnectorService } from '../../workbench/services/connectors/browser/appServerConnectorService.js';
import { IInstructionService } from '../../platform/instructions/common/instructionService.js';
import { ISessionGroupsService, SessionGroupsService } from '../services/sessions/browser/sessionGroupsService.js';
import { IFileSearchService } from '../../platform/search/common/fileSearch.js';
import { BrowserFileSearchService } from '../../platform/search/browser/browserFileSearchService.js';
import { Schemas } from '../../base/common/network.js';
import type { IFileSystemProvider } from '../../platform/files/common/files.js';
import { IUserDataProfileService } from '../../workbench/services/userDataProfile/common/userDataProfile.js';
import { UserDataProfileService } from '../../workbench/services/userDataProfile/browser/userDataProfileService.js';
import { IKeybindingEditingService, KeybindingsEditingService } from '../../workbench/services/keybinding/common/keybindingEditing.js';
import { ITextModelService } from '../../editor/common/services/resolverService.js';
import { TextModelResolverService } from '../../workbench/services/textmodelResolver/common/textModelResolverService.js';
import { ServiceCollection } from '../../platform/instantiation/common/serviceCollection.js';
import { getSingletonServiceDescriptors, InstantiationType } from '../../platform/instantiation/common/extensions.js';
import { SyncDescriptor } from '../../platform/instantiation/common/descriptors.js';
import { ExtensionUiTarget } from '../../platform/extensionManagement/common/extensionManagementService.js';
import { IExtensionRecommendationsService } from '../../workbench/services/extensionRecommendations/common/extensionRecommendations.js';
import { ExtensionRecommendationsService } from '../../workbench/contrib/extensions/browser/extensionRecommendationsService.js';
import { IAssetService } from '../../platform/assets/common/assetService.js';
import { IApprovalEnvironmentService } from '../../platform/approvalEnvironment/common/approvalEnvironmentService.js';
import { IAgentSessionService, IAgentThreadService, IAgentTurnService } from '../../platform/agentHost/common/agentService.js';
import { IAgentModelsService } from '../../platform/agentHost/common/agentModels.js';
import { ITurnChangesApi } from '../../platform/turnChanges/common/turnChangesApi.js';
import { AppServerAvailableContext, IsSessionsWindowContext, WorkspaceFolderCountContext } from '../../workbench/common/contextkeys.js';
import { EditorPanes } from '../../workbench/browser/editor.js';
import { EditorContextKeyController } from '../../workbench/browser/parts/editor/editorContextKeys.js';
import { WorkbenchEditorContextKeysHandler } from '../../workbench/browser/contextkeys.js';
import '../../workbench/browser/parts/editor/editorActions.js';
import '../../workbench/browser/parts/editor/editorCommands.js';
import { IAppServerApi as AppServerApiId, IServerEventApi as ServerEventApiId } from '../../platform/agentHost/common/appServerApi.js';
import { ILanguageModelsService, LanguageModelsService } from '../../workbench/contrib/chat/common/languageModels.js';
import { ILanguageModelsConfigurationService } from '../../workbench/contrib/chat/common/languageModelsConfiguration.js';
import { ChatModelPreferences, LanguageModelsConfigurationService } from '../../workbench/contrib/chat/browser/languageModelsConfigurationService.js';
import { WebLanguagePacksService } from '../../platform/languagePacks/browser/languagePacks.js';
import { ILanguagePackService } from '../../platform/languagePacks/common/languagePacks.js';
import { ILocaleService } from '../../workbench/services/localization/common/locale.js';
import { WorkbenchLocaleService } from '../../workbench/services/localization/browser/localeService.js';
import { ILocalizationService } from '../../workbench/services/localization/common/localizationService.js';
import { WorkbenchLocalizationService } from '../../workbench/services/localization/browser/workbenchLocalizationService.js';
import { builtinLanguagePackCatalogs, preinstalledLanguagePacks } from '../../workbench/services/localization/common/localizationCatalogs.js';
import { IAppServerHookApi, IAppServerSkillApi } from '../../platform/agentHost/common/appServerApi.js';
import { IExtensionManagementService, OPEN_EXTENSIONS_COMMAND_ID, OPEN_INSTALLED_EXTENSIONS_COMMAND_ID, type ExtensionsOpenOptions } from '../../platform/extensionManagement/common/extensionManagementService.js';
import { registerExtensionManagementActions } from '../../workbench/contrib/extensions/browser/extensionsActions.js';
import { AppServerExtensionManagementService } from '../../workbench/services/extensionManagement/browser/appServerExtensionManagementService.js';
import { IPluginManagementService } from '../../platform/extensionManagement/common/pluginManagementService.js';
import { ILocalGitService } from '../../platform/git/common/localGitService.js';
import { AppServerPluginManagementService } from '../../workbench/services/extensionManagement/browser/appServerPluginManagementService.js';
import { IAppServerRemoteAgentService } from '../../workbench/services/remote/common/appServerRemoteAgentService.js';
import { AppServerRemoteAgentService } from '../../workbench/services/remote/browser/appServerRemoteAgentService.js';
import { autorun } from '../../base/common/observable.js';
import { CustomViewGridPart } from './parts/customViewGridPart.js';
import { ICustomViewService } from '../services/customView/browser/customViewService.js';
import { ICustomViewGridPartService } from '../services/customView/browser/customViewGridPartService.js';
import { ISessionsProvidersService } from '../services/sessions/browser/sessionsProvidersService.js';
import { IChatSessionNavigationService } from '../../workbench/services/chat/common/chatSessionNavigationService.js';
import '../../workbench/contrib/chat/browser/actions/chatSpeechToTextActions.js';
import '../../workbench/contrib/quickaccess/browser/quickAccess.contribution.js';
import { IVoiceCodeTranscriptionBackendService } from '../../platform/renderer/common/dictation.js';
import "../../workbench/browser/style.js";
import "./media/style.css";
import "./media/workbench.css";
import "./actions/sessionsChatActions.js";
import "./actions/approvalEnvironmentActions.js";
import './activityBarAccessibility.js';
import '../../workbench/contrib/accessibility/browser/accessibilityConfiguration.js';
import { NotificationActionRunner } from '../../workbench/browser/parts/notifications/notificationsCommands.js';
import '../../workbench/contrib/accessibility/browser/accessibleViewActions.js';
import { addDisposableListener, h, type IDimension } from "../../base/browser/dom.js";
import { canceled, errorHandler, getErrorMessage, onUnexpectedError, setUnexpectedErrorHandler } from '../../base/common/errors.js';
import { mainWindow } from '../../base/browser/window.js';
import { Event } from '../../base/common/event.js';
import { SessionsViewRegistry } from '../common/views.js';
import { openExtensionsView, registerExtensionsViewContainer } from '../../workbench/contrib/extensions/browser/extensionsViewlet.js';
import { ViewContainerLocation } from '../../workbench/common/views.js';
import { DesignEditorService, IDesignEditorService } from '../contrib/creator/browser/designEditorService.js';
import { Disposable, toDisposable, type IDisposable } from "../../base/common/lifecycle.js";
import { ILanguageService } from "../../editor/common/languages/language.js";
import { LanguageService } from "../../editor/common/services/languageService.js";
import { localize } from '../../nls.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId, IAccessibleViewService } from '../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../platform/accessibility/browser/accessibleViewRegistry.js';
import { IConfigurationService } from "../../platform/configuration/common/configuration.js";
import { ContextKeyExpr } from '../../platform/contextkey/common/contextkey.js';
import { refineServiceDecorator, type IInstantiationService } from "../../platform/instantiation/common/instantiation.js";
import { InstantiationService } from "../../platform/instantiation/common/instantiationService.js";
import { ILocalTranscriptionService, ILocalTranscriptionModelService } from '../../platform/localTranscription/common/localTranscription.js';
import { NullLocalTranscriptionService } from '../../workbench/services/localTranscription/browser/localTranscriptionService.js';
import { ICodeEditorService } from '../../editor/browser/services/codeEditorService.js';
import { StandaloneCodeEditorService } from '../../editor/standalone/browser/standaloneCodeEditorService.js';
import { ILanguageConfigurationService } from '../../editor/common/languages/languageConfigurationRegistry.js';
import { ILanguageFeaturesService } from '../../editor/common/services/languageFeatures.js';
import { LanguageFeaturesService } from '../../editor/common/services/languageFeaturesService.js';
import { IModelService } from '../../editor/common/services/model.js';
import { ModelService } from '../../editor/common/services/modelService.js';
import { ITextResourcePropertiesService } from '../../editor/common/services/textResourceConfiguration.js';
import { TextResourcePropertiesService } from '../../workbench/services/textresourceProperties/common/textResourcePropertiesService.js';
import { NewChatInputWidget } from '../contrib/chat/browser/newChatInput.js';
import { CoworkPaneFactory } from '../contrib/cowork/browser/cowork.contribution.js';
import { ISessionsConversationService } from '../services/sessions/common/sessionsConversation.js';
import { ChatTipService, IChatTipService } from '../../workbench/contrib/chat/browser/chatTipService.js';
import { migrateNewChatDraftState, writeNewChatDraftState } from '../contrib/chat/common/newChatDraftState.js';
import { IAccessibilityService } from '../../platform/accessibility/common/accessibility.js';
import { AccessibilityService } from '../../platform/accessibility/browser/accessibilityService.js';
import { NativeAccessibilityService } from '../../workbench/services/accessibility/electron-browser/accessibilityService.js';
import { ILoggerService, ILogService } from '../../platform/log/common/log.js';
import { WorkbenchContributionsRegistry, WorkbenchPhase, type WorkbenchContributionHost } from '../../workbench/common/contributions.js';
import type { LogService } from '../../platform/log/common/logServiceImpl.js';
import type { Constructor } from '../../platform/instantiation/common/descriptors.js';
import type { SessionsPartId } from '../common/layoutConstants.js';
import { ILayoutService } from "../../platform/layout/browser/layoutService.js";
import { ILifecycleService, LifecyclePhase, type ShutdownReason } from "../../workbench/services/lifecycle/common/lifecycle.js";
import { NotificationService } from "../../workbench/services/notification/common/notificationService.js";
import { INotificationsCenter, NotificationsCenter } from "../../workbench/browser/parts/notifications/notificationsCenter.js";
import { INotificationService } from "../../platform/notification/common/notification.js";
import { IRendererHostService, type IRendererHost } from "../../platform/renderer/common/rendererHost.js";
import { AgentHostConnectionsService } from '../../platform/agentHost/browser/agentHostConnectionsService.js';
import { IAgentHostConnectionsService } from '../../platform/agentHost/common/agentHostConnectionsService.js';
import { IExtensionResourceLoaderService } from '../../platform/extensionResourceLoader/common/extensionResourceLoader.js';
import { ITraceSettingsService } from '../../platform/trace/common/traceSettingsService.js';
import type { INativeHostApi, IOpenAgentsWindowOptions } from '../../platform/native/common/nativeHost.js';
import { IStorageService, WillSaveStateReason, StorageScope } from "../../platform/storage/common/storage.js";
import { IThemeService } from "../../platform/theme/common/themeService.js";
import { WorkbenchState, IWorkspaceContextService, type IWorkspace } from "../../platform/workspace/common/workspace.js";
import { SessionsWorkspaceContextService } from '../services/workspace/browser/workspaceContextService.js';
import { IMarkerService } from '../../platform/markers/common/markers.js';
import { MarkerService } from '../../platform/markers/common/markerService.js';
import { GitHubService as SessionsGitHubService, IGitHubService as ISessionsGitHubService } from '../contrib/github/browser/githubService.js';
import { SessionFileService } from '../contrib/providers/agentHost/browser/sessionFileService.js';
import { AgentHostFileSystemService, IAgentHostFileSystemService } from '../../workbench/services/agentHost/common/agentHostFileSystemService.js';
import { IFileService } from '../../platform/files/common/files.js';
import { ISystemFileTransferService } from '../../platform/files/common/systemFileTransferService.js';
import { IClipboardService } from '../../platform/clipboard/common/clipboardService.js';
import { IDialogService, IFileDialogService } from '../../platform/dialogs/common/dialogs.js';
import { FileService } from '../../platform/files/common/fileService.js';
import type { DialogService } from '../../workbench/services/dialogs/common/dialogService.js';
import { IDialogsModel } from '../../workbench/common/dialogs.js';
import { BrowserDialogHandler } from '../../workbench/browser/parts/dialogs/dialog.js';
import { DialogHandlerContribution } from '../../workbench/browser/parts/dialogs/dialog.web.contribution.js';
import '../../workbench/services/label/common/labelService.js';
import { IResourceIconRenderer, IResourceLabelService, ResourceLabelService } from '../../workbench/browser/labels.js';
import { IDecorationsService } from '../../workbench/services/decorations/common/decorations.js';
import { DecorationsService } from '../../workbench/services/decorations/browser/decorationsService.js';
import { ITextFileService } from '../../workbench/services/textfile/common/textfiles.js';
import { TextFileService } from '../../workbench/services/textfile/browser/textFileService.js';
import { IWorkingCopyService } from '../../workbench/services/workingCopy/common/workingCopyService.js';
import { BrowserWorkingCopyService } from '../../workbench/services/workingCopy/browser/browserWorkingCopyService.js';
import { IUntitledTextEditorService, UntitledTextEditorService } from '../../workbench/services/untitled/common/untitledTextEditorService.js';
import { TextFileEditorTracker } from '../../workbench/contrib/files/browser/editors/textFileEditorTracker.js';
import { ITextModelResourceService, IFileTextModelService } from '../../workbench/services/textmodelResolver/common/textModelResourceService.js';
import { getBrowserTextModelService } from '../../workbench/services/textmodelResolver/browser/browserTextModelService.js';
import { getBrowserTextResourceStore } from '../../workbench/contrib/codeEditor/browser/browserTextResourceStore.js';
import { TreeSitterLibraryService, TreeSitterSyntaxProviders, createTreeSitterSyntaxSession } from '../../workbench/services/treeSitter/browser/treeSitterLibraryService.js';
import { ITreeSitterLibraryService } from '../../editor/common/services/treeSitter/treeSitterLibraryService.js';
import { ISyntaxApi } from '../../platform/syntax/common/syntaxApi.js';
import { AppServerExtensionService } from '../../workbench/services/extensions/browser/appServerExtensionService.js';
import { IExtensionService } from '../../workbench/services/extensions/common/extensionService.js';
import { DiffService } from '../../workbench/services/diff/browser/diffService.js';
import { IDiffService } from '../../workbench/services/diff/common/diffService.js';
import { IEditorPart } from '../../workbench/browser/parts/editor/editorPart.js';
import { EditorPart } from './parts/editorPart.js';
import { BrowserEditorService } from '../../workbench/services/editor/browser/browserEditorService.js';
import { IEditorService } from '../../workbench/services/editor/common/editorService.js';
import { IEditorGroupsService } from '../../workbench/services/editor/common/editorGroupsService.js';
import { IHistoryService } from '../../workbench/services/history/common/history.js';
import { HistoryService } from '../../workbench/services/history/browser/historyService.js';
import { IViewDescriptorService } from '../../workbench/common/views.js';
import { ViewDescriptorService } from '../../workbench/services/views/browser/viewDescriptorService.js';
import { IViewsService } from '../../workbench/services/views/common/viewsService.js';
import { ViewsService } from '../../workbench/services/views/browser/viewsService.js';
import type { SessionWorkspaceSelection } from '../services/sessions/common/session.js';
import { WorkspaceSelection } from './workspaceSelection.js';
import { IDevContainerAgentHostService } from '../common/devContainerAgentHostService.js';
import { DevContainerAgentHostService } from './devContainerAgentHostService.js';
import { logSessionsInteraction } from '../common/sessionsTelemetry.js';
import '../../workbench/services/workspaces/browser/workspacesService.js';
import type { Part } from "../../workbench/browser/part.js";
import { setHoverDelegate } from "../../base/browser/ui/hover/hoverDelegate.js";
import { IMenuService } from "../../platform/actions/common/actions.js";
import { MenuService } from "../../platform/actions/common/menuService.js";
import { CommandsRegistry, ICommandService } from "../../platform/commands/common/commands.js";
import { IContextKeyService, ContextKeyService } from "../../platform/contextkey/browser/contextKeyService.js";
import { IExtensionHostApi } from '../../platform/agentHost/common/extensionHostApi.js';
import { ITelemetryService } from '../../platform/telemetry/common/telemetry.js';
import { NullTelemetryService } from '../../platform/telemetry/common/telemetryUtils.js';
import { IContextMenuService, IContextViewService } from "../../platform/contextview/browser/contextView.js";
import { BrowserContextViewService } from "../../platform/contextview/browser/contextViewService.js";
import { HoverService, IHoverService } from "../../platform/hover/browser/hoverService.js";
import { IKeybindingService } from "../../platform/keybinding/common/keybinding.js";
import { IKeyboardLayoutService, type IKeyboardLayoutProvider } from "../../platform/keyboardLayout/common/keyboardLayout.js";
import { IUserKeyboardLayoutService, UnavailableUserKeyboardLayoutService, type IUserKeyboardLayoutApi } from "../../platform/keyboardLayout/common/userKeyboardLayout.js";
import { IQuickInputService } from "../../platform/quickinput/common/quickInput.js";
import { IOpenerService } from "../../platform/opener/common/opener.js";
import { IMarkdownRendererService } from '../../platform/markdown/browser/markdownRenderer.js';
import { EditorMarkdownCodeBlockRenderer } from '../../editor/browser/widget/markdownRenderer/browser/editorMarkdownCodeBlockRenderer.js';
import '../../workbench/contrib/externalUriOpener/common/externalUriOpener.contribution.js';
import { OpenerService } from '../../editor/browser/services/openerService.js';
import { CommandService } from "../../workbench/services/commands/common/commandService.js";
import { BrowserKeyboardLayoutService } from "../../workbench/services/keybinding/browser/keyboardLayoutService.js";
import { WorkbenchKeybindingService } from "../../workbench/services/keybinding/browser/keybindingService.js";
import { IKeyboardShortcutTroubleshootingService } from "../../workbench/services/keybinding/common/keyboardShortcutTroubleshooting.js";
import { IPreferencesService } from "../../workbench/services/preferences/common/preferences.js";
import { PreferencesService } from "../../workbench/services/preferences/browser/preferencesService.js";
import "../../workbench/services/quickinput/browser/quickInputService.js";
import { WorkbenchWindow } from "../../workbench/browser/window.js";
import { IAccountService } from '../../platform/accounts/common/accountService.js';
import { IGitHubService } from '../../platform/github/common/githubService.js';
import { GitHubConnectionService } from '../../workbench/services/accounts/browser/gitHubConnectionService.js';
import { IGitHubConnectionService } from '../../workbench/services/accounts/common/gitHubConnectionService.js';
import { BrowserClipboardService } from '../../workbench/services/clipboard/browser/clipboardService.js';
import { INativeHostService } from '../../workbench/common/services.js';
import { ActivityBarPosition } from '../../workbench/common/configuration.js';
import { ChatService } from "../../workbench/services/chat/browser/chatService.js";
import { AppServerAccountService } from '../../workbench/services/accounts/browser/appServerAccountService.js';
import { IChatService } from "../../workbench/services/chat/common/chatService.js";
import { ConfigurationService } from '../services/configuration/browser/configurationService.js';
import { IPolicyService, NullPolicyService } from '../../platform/policy/common/policy.js';
import { MultiplexPolicyService } from '../../platform/policy/common/multiplexPolicyService.js';
import { AccountPolicyService, IAccountPolicyService } from '../../workbench/services/policies/common/accountPolicyService.js';
import type { ExtensionColorThemeService } from "../../workbench/services/extensions/browser/extensionColorThemeService.js";
import type { BrowserStorageServiceOptions } from "../../workbench/services/storage/browser/storageService.js";
import { IWorkbenchHostService } from "../../workbench/services/host/common/workbenchHostService.js";
import { WorkbenchThemeService } from "../../workbench/services/themes/browser/workbenchThemeService.js";
import { IHostColorSchemeService } from '../../workbench/services/themes/common/hostColorSchemeService.js';
import { AppServerSessionsProvider, type AppServerSessionsProviderHost } from "../contrib/providers/agentHost/browser/appServerSessionsProvider.js";
import { AppServerTeamsProvider } from '../contrib/providers/agentHost/browser/appServerTeamsProvider.js';
import { TeamsManagementService } from '../services/teams/browser/teamsManagementService.js';
import { ITeamsManagementService } from '../services/teams/common/teamsManagement.js';
import { SessionsAccountMenu } from '../contrib/accounts/browser/sessionsAccountMenu.js';
import { SessionsModernUIContribution } from '../contrib/modernUI/browser/modernUI.contribution.js';
import { SessionsPreferences } from '../contrib/preferences/browser/sessionsPreferences.js';
import type { SessionsProfile } from "../common/sessionsProfile.js";
import { RETURN_TO_WORKBENCH_COMMAND_ID } from '../common/windowNavigation.js';
import { OPEN_ASH_WINDOW_COMMAND_ID } from '../common/sessionCommands.js';
import { SessionsConfiguration, type SessionsLayoutStyle } from '../common/configuration.js';
import { SessionsManagementService } from "../services/sessions/browser/sessionsManagementService.js";
import { ISessionsManagementService } from "../services/sessions/common/sessionsManagement.js";
import { ISessionsService, SessionsService } from "../services/sessions/browser/sessionsService.js";
import { ISessionsLayoutService } from '../services/layout/common/sessionsLayoutService.js';
import { registerLayoutActions } from './layoutActions.js';
import { PanelPart } from './parts/panelPart.js';
import { ITerminalProcessService } from '../../platform/terminal/common/terminal.js';
import { installWorkbenchServiceContributions } from '../../workbench/browser/workbenchServiceContributions.js';
import { AuxiliaryBarPart } from "./parts/auxiliaryBarPart.js";
import { disposableWindowTimeout } from '../../base/browser/scheduler.js';
import { ActivityBar } from './parts/activitybar/activityBarPart.js';
import type { PaneCompositePart } from '../../workbench/browser/parts/paneCompositePart.js';
import { PaneCompositePartService } from '../../workbench/browser/parts/paneCompositePartService.js';
import { IPaneCompositePartService } from '../../workbench/services/panecomposite/browser/panecomposite.js';
import { SessionsPart, type SessionsPartOptions } from "./parts/sessionsPart.js";
import { SidebarPart, registerSessionsNavigation } from "./parts/sidebarPart.js";
import { ISessionsTitlebarService, type TitlebarPart } from "./parts/titlebarPart.js";

export interface IWorkbenchOptions {
	/** Host-owned services are borrowed before this window creates its consumers. */
	readonly serviceCollection?: ServiceCollection;
	readonly createAppToolsHost?: (services: IInstantiationService) => IDisposable;
	readonly createTextDocumentHost?: (services: IInstantiationService) => IDisposable;
	readonly createBrowserHost?: (services: IInstantiationService) => IDisposable;
	readonly contributionIds: readonly string[];
	readonly profile: SessionsProfile;
	readonly api: IRendererHost;
	readonly workspaceSelection: () => SessionWorkspaceSelection;
	readonly workspace: () => IWorkspace;
	readonly browserFileSystemProvider?: IFileSystemProvider;
	/** Host-owned extension execution; embedders can supply a disconnected implementation. */
	readonly extensionHost?: IExtensionHostApi;
	readonly createFileDialogService: (services: IInstantiationService) => IFileDialogService;
	readonly createLifecycleService: (services: IInstantiationService) => ILifecycleService & IDisposable;
	readonly createStorageService: (options: BrowserStorageServiceOptions) => Promise<IStorageService & IDisposable>;
	readonly createLogService: () => LogService;
	readonly nativeHostApi?: INativeHostApi;
	readonly createAuxiliaryWindowService?: (opener: Window, root: HTMLElement, services: IInstantiationService) => IAuxiliaryWindowService;
	readonly keyboardLayoutProvider?: IKeyboardLayoutProvider;
	readonly userKeyboardLayoutApi?: IUserKeyboardLayoutApi;
	readonly returnToWorkbench: () => void;
	readonly initialConfiguration?: IConfigurationModel;
	readonly createUserDataFileSystemProvider: () => Promise<IFileSystemProvider & IDisposable>;
	readonly createContextMenuService: (services: IInstantiationService) => IContextMenuService & IDisposable;
	readonly createHostColorSchemeService: (services: IInstantiationService) => IHostColorSchemeService & IDisposable;
	readonly createTitlebarPart: (container: HTMLElement, services: IInstantiationService) => TitlebarPart;
	readonly container: HTMLElement;
}

/** Owns the dedicated Sessions window's services, Parts, layout, and disposal. */
export abstract class Workbench extends Disposable {
	readonly domNode: HTMLElement;
	readonly configurationService: ConfigurationService;
	readonly themeService: WorkbenchThemeService;
	private readonly layoutService: IAgentWorkbenchLayoutService & IDisposable;
	private readonly lifecycleService: ILifecycleService;
	private readonly sessionsView: SessionsService;
	private readonly sessionsPart: SessionsPart;
	private readonly showChat: () => Promise<void>;
	private readonly workspaceSelection: () => SessionWorkspaceSelection;
	/** Saved session layouts are restored before the host completes startup. */
	public readonly whenRestored: Promise<void>;
	private readonly logService: ILogService;

	protected constructor(layoutConstructor: Constructor<IAgentWorkbenchLayoutService & IDisposable>, options: IWorkbenchOptions, themes: ExtensionColorThemeService, storageService: IStorageService & IDisposable, logger: LogService, userDataFileSystemProvider: IFileSystemProvider & IDisposable) {
		super();
		this._register(themes);
		this.workspaceSelection = options.workspaceSelection;
		const ownerDocument = options.container.ownerDocument;
		const ownerWindow = ownerDocument.defaultView;
		if (!ownerWindow) throw new Error("Sessions renderer requires an owner window");

		const serviceCollection = options.serviceCollection ?? new ServiceCollection();
		if (!serviceCollection.has(IExtensionRecommendationsService)) {
			serviceCollection.set(IExtensionRecommendationsService, new SyncDescriptor(ExtensionRecommendationsService, [ExtensionUiTarget.Agents], true));
		}
		// Load service descriptions before consumers so shared dependencies resolve in this window's scope.
		for (const [id, descriptor] of getSingletonServiceDescriptors()) {
			if (!serviceCollection.has(id)) { serviceCollection.set(id, descriptor); }
		}
		const hostPolicies = new ServiceCollection(...[...serviceCollection.entries()].filter(([id]) => id === IPolicyService));
		const windowServices = new ServiceCollection(...[...serviceCollection.entries()].filter(([id]) => id !== IPolicyService));
		const hostServices = this._register(new InstantiationService(hostPolicies));
		const services = this._register(hostServices.createChild(windowServices));
		this.logService = this._register(logger);
		services.registerInstance(ILogService, this.logService);
		if (!services.has(ILoggerService)) services.registerInstance(ILoggerService, logger);
		const fileService = this._register(services.createInstance(FileService));
		this._register(userDataFileSystemProvider);
		this._register(fileService.registerProvider(Schemas.vscodeUserData, userDataFileSystemProvider));
		services.registerInstance(IUserDataProfileService, new UserDataProfileService());
		services.registerInstance(IFileService, fileService);
		const configurationService = this.configurationService = this._register(services.createInstance(ConfigurationService, { initialConfiguration: options.initialConfiguration, workspace: options.workspace() }));
		services.registerInstance(IStorageService, storageService);
		const extensionManagementService = this._register(new AppServerExtensionManagementService(options.api.extensionManagement, options.api.events));
		services.registerInstance(IExtensionManagementService, extensionManagementService);
		services.registerInstance(ILocalGitService, options.api.localGit);
		const enablement = this._register(services.createInstance(GlobalExtensionEnablementService));
		services.registerInstance(IGlobalExtensionEnablementService, enablement);
		const enabledExtensions = withEnabledBuiltInExtensions(options.api.extensions, enablement, extensionManagementService);
		const commandService = this._register(new CommandService(services));
		services.registerInstance(ICommandService, commandService);
		const serviceContributionReady: Promise<void>[] = [];
		services.registerInstance(IAssetService, options.api.assets);
		services.registerInstance(IProjectService, options.api.projects);
		services.registerInstance(INetworkDiagnosticsService, options.api.networkDiagnostics);
		services.registerInstance(IContentSearchConfigurationService, options.api.contentSearchConfiguration);
		services.registerInstance(IExtensionHostApi, options.extensionHost ?? this._register(services.createInstance(WebWorkerExtensionHost, enabledExtensions, options.api.extensionHost)));
		if (!serviceCollection.has(ITelemetryService)) { services.registerInstance(ITelemetryService, NullTelemetryService); }
		if (options.api.approvalEnvironment) { services.registerInstance(IApprovalEnvironmentService, options.api.approvalEnvironment); }
		services.registerInstance(IVoiceCodeTranscriptionBackendService, options.api.dictation);
		services.registerInstance(IAgentVoiceService, options.api.agentVoice);
		if (options.api.channels) services.registerInstance(IChannelService, options.api.channels);
		if (options.api.calls) services.registerInstance(ICallService, options.api.calls);
		const localTranscription = options.api.localTranscription ?? this._register(new NullLocalTranscriptionService());
		services.registerInstance(ILocalTranscriptionService, localTranscription);
		services.registerInstance(ILocalTranscriptionModelService, options.api.localTranscriptionModels ?? (localTranscription instanceof NullLocalTranscriptionService ? localTranscription : this._register(new NullLocalTranscriptionService())));
		services.registerInstance(IConfigurationService, configurationService);
		const languagePacks = this._register(services.createInstance(WebLanguagePacksService, builtinLanguagePackCatalogs, preinstalledLanguagePacks));
		services.registerInstance(ILanguagePackService, languagePacks);
		if (options.nativeHostApi) services.registerInstance(INativeHostService, options.nativeHostApi);
		const languageService = this._register(new LanguageService());
		services.registerInstance(ILanguageService, languageService);
		services.registerInstance(ILanguageFeaturesService, this._register(new LanguageFeaturesService()));
		services.registerSingleton(ITextResourcePropertiesService, () => services.createInstance(TextResourcePropertiesService));
		// Shared inspectors create transient models; this window owns their registry and shutdown.
		services.registerSingleton(IModelService, () => new ModelService(configurationService, services.get(ITextResourcePropertiesService), languageService, services.get(ILanguageFeaturesService), services.get(ILanguageConfigurationService)));
		services.registerInstance(ICodeEditorService, this._register(new StandaloneCodeEditorService()));
		services.registerSingleton(IInlineCompletionsService, () => services.createInstance(InlineCompletionsService));
		services.registerSingleton(ILanguageFeatureDebounceService, () => services.createInstance(LanguageFeatureDebounceService));
		services.registerSingleton(IMarkerDecorationsService, () => services.createInstance(MarkerDecorationsService));
		// Window errors must terminate at the host logger. The default handler rethrows,
		// which sends the growing error message back through WorkbenchWindow indefinitely.
		const previousErrorHandler = errorHandler.getUnexpectedErrorHandler();
		const handleError = (error: unknown): void => {
			const message = error instanceof Error ? error.stack || error.message : getErrorMessage(error);
			if (message) logger.error('runtime', message);
		};
		setUnexpectedErrorHandler(handleError);
		this._register(toDisposable(() => {
			if (errorHandler.getUnexpectedErrorHandler() === handleError) setUnexpectedErrorHandler(previousErrorHandler);
		}));
		if (ownerWindow === mainWindow) {
			this._register(addDisposableListener<PromiseRejectionEvent>(ownerWindow, 'unhandledrejection', event => {
				onUnexpectedError(event.reason);
				event.preventDefault();
			}));
		}
		services.registerInstance(IHostColorSchemeService, this._register(options.createHostColorSchemeService(services)));
		const themeService = this.themeService = this._register(services.createInstance(WorkbenchThemeService, options.container));
		services.registerInstance(IThemeService, themeService);
		themeService.initialize();
		services.registerInstance(IAuxiliaryWindowService, this._register(options.createAuxiliaryWindowService ? options.createAuxiliaryWindowService(ownerWindow, options.container, services) : services.createInstance(BrowserAuxiliaryWindowService, ownerWindow, options.container)));
		const workbenchWindow = this._register(new WorkbenchWindow({
			root: options.container,
			workbenchState: WorkbenchState.EMPTY,
			editUserConfiguration: options.api.editUserConfiguration,
		}));
		services.registerInstance(IWorkbenchHostService, workbenchWindow);
		if (!services.has(IBrowserPasswordService)) { services.registerInstance(IBrowserPasswordService, UnavailableBrowserPasswordService); }
		services.registerInstance(AppServerApiId, options.api.appServer);
		services.registerInstance(IRendererHostService, options.api);
		services.registerSingleton(IAgentHostConnectionsService, () => services.createInstance(AgentHostConnectionsService));
		services.registerInstance(IMessageHistoryService, options.api.messageHistory);
		services.registerInstance(IExtensionResourceLoaderService, enabledExtensions.resources);
		services.registerInstance(IExtensionApi, enabledExtensions);
		services.registerInstance(IExtensionBackendApi, options.api.extensionBackend);
		services.registerInstance(IDebugAdapterProcessService, options.api.debugAdapter);
		services.registerInstance(ITestExecutionService, options.api.testing);
		services.registerInstance(IRemoteConnectionApi, options.api.remoteConnections ?? UnavailableRemoteConnectionApi);
		services.registerSingleton(IRemoteConnectionService, () => services.createInstance(RemoteConnectionService));
		const primaryHostServices = this._register(services.createChild());
		services.registerInstance(IAgentModelsService, options.api.model);
		services.registerInstance(ISecretStorageStatusService, options.api.secretStorage);
		if (!services.has(ISecretStorageService)) services.registerInstance(ISecretStorageService, this._register(new BaseSecretStorageService()));
		primaryHostServices.registerInstance(IAgentExecutionSettingsService, options.api.executionSettings);
		primaryHostServices.registerInstance(IAgentSessionService, options.api.session);
		services.registerSingleton(IDevContainerAgentHostService, () => services.createInstance(DevContainerAgentHostService));
		primaryHostServices.registerInstance(IAgentThreadService, options.api.thread);
		services.registerInstance(IAgentTurnService, options.api.turn);
		services.registerInstance(ITurnChangesApi, options.api.turnChanges);
		services.registerInstance(ServerEventApiId, options.api.events);
		services.registerInstance(IAppServerSkillApi, options.api.skills);
		primaryHostServices.registerSingleton(IPromptsService, () => primaryHostServices.createInstance(PromptsService));
		const provider = primaryHostServices.createInstance(AppServerSessionsProvider, {
			workspace: options.workspaceSelection,
			selectWorkspace: async folders => {
				using selection = services.createInstance(WorkspaceSelection);
				return await selection.pick(folders);
			},
		} satisfies AppServerSessionsProviderHost);
		const sessions = this._register(services.createInstance(SessionsManagementService, provider));
		this._register(services.get(ISessionsProvidersService).registerProvider(provider));
		const teams = new TeamsManagementService(new AppServerTeamsProvider(options.api.teams));
		services.registerInstance(ITeamsManagementService, teams);
		const storage = this._register(storageService);
		services.registerInstance(ISessionsManagementService, sessions);
		const view = this.sessionsView = this._register(services.createInstance(SessionsService));
		const chat = this._register(primaryHostServices.createInstance(ChatService));
		services.registerInstance(ISessionsService, view);
		services.registerInstance(ISessionGroupsService, this._register(services.createInstance(SessionGroupsService)));
		const workspace = configurationService;
		this._register(services.createInstance(SessionsWorkspaceContextService, options.workspace, (next: IWorkspace) => workspace.updateWorkspace(next)));
		services.registerInstance(IWorkspaceContextService, workspace);
		services.registerInstance(IMarkerService, this._register(new MarkerService()));
		const files = this._register(services.createInstance(SessionFileService, options.api, () => [...options.workspace().folders.map(folder => ({ uri: folder.uri, target: { type: 'environment' as const, dirId: folder.id } })), ...sessions.sessions.filter(session => (session.providerId ?? provider.id) === provider.id).flatMap(session => [session.workspace, ...session.chats.map(chat => chat.workspace)].flatMap(workspace => workspace ? [{ uri: sessionWorkspaceUri(workspace), target: { type: 'session' as const, sessionId: session.backendSessionId ?? session.sessionId, path: workspace.root } }] : []))]));
		const agentHostFiles = this._register(services.createInstance(AgentHostFileSystemService, files, options.browserFileSystemProvider));
		services.registerInstance(IAgentHostFileSystemService, agentHostFiles);
		const systemPolicies = hostServices.has(IPolicyService) ? hostServices.get(IPolicyService) : new NullPolicyService();
		services.registerInstance(IPluginManagementService, this._register(services.createInstance(AppServerPluginManagementService, options.api.plugins, options.api.events)));
		if (!options.api.hasAppServer) services.registerInstance(IFileSearchService, services.createInstance(BrowserFileSearchService));
		services.registerInstance(ISystemFileTransferService, files);
		services.registerInstance(IResourceIconRenderer, themeService);
		services.registerInstance(IDecorationsService, this._register(services.createInstance(DecorationsService, ownerDocument)));
		services.registerSingleton(IResourceLabelService, () => services.createInstance(ResourceLabelService));
		services.registerSingleton(IUntitledTextEditorService, () => services.createInstance(UntitledTextEditorService));
		if (!services.has(IClipboardService)) services.registerSingleton(IClipboardService, () => services.createInstance(BrowserClipboardService), { instantiation: InstantiationType.Delayed });
		const textFiles = this._register(services.createInstance(TextFileService));
		themes.watchSourceSaves(textFiles);
		services.registerInstance(ITextFileService, textFiles);
		const workingCopies = this._register(services.createInstance(BrowserWorkingCopyService));
		services.registerInstance(IWorkingCopyService, workingCopies);
		services.registerInstance(IDocumentEditorTextModelService, this._register(services.createInstance(DocumentEditorTextModelService)));
		services.registerInstance(ISyntaxApi, options.api.syntax);
		const treeSitterLibrary = this._register(services.createInstance(TreeSitterLibraryService));
		services.registerInstance(ITreeSitterLibraryService, treeSitterLibrary);
		this._register(new TreeSitterSyntaxProviders(services.get(ILanguageFeaturesService)));
		const extensionService = this._register(services.createInstance(AppServerExtensionService, { api: enabledExtensions, eventApi: options.api.events, languageService, languageConfigurationService: services.get(ILanguageConfigurationService) }));
		services.registerInstance(IExtensionService, extensionService);
		services.get(ISnippetsService);
		const extensionReady = extensionService.start();
		void extensionReady.catch(error => logger.error('extensions', 'Declarative extension activation failed', error));
		const textModels = this._register(getBrowserTextModelService(getBrowserTextResourceStore(textFiles), services, {
			languageService,
			languageConfigurationService: services.get(ILanguageConfigurationService),
			languageFeaturesService: services.get(ILanguageFeaturesService),
			createSyntaxSession: model => createTreeSitterSyntaxSession(model, configurationService, treeSitterLibrary, themeService),
			onDidChangeSyntaxBackend: Event.any(
				treeSitterLibrary.onDidChange,
				Event.map(themeService.onDidColorThemeChange, () => undefined),
				(listener, thisArgs, disposables) => configurationService.onDidChangeConfiguration(event => {
					if (event.affectsConfiguration('editor.experimental.treeSitterTelemetry')) listener.call(thisArgs, undefined);
				}, undefined, disposables),
			),
		}));
		services.registerInstance(ITextModelResourceService, textModels);
		services.registerInstance(IFileTextModelService, textModels);
		if (!options.api.hasAppServer) services.registerInstance(IContentSearchService, new FileContentSearchService(fileService));
		services.registerSingleton(IKeybindingEditingService, () => services.createInstance(KeybindingsEditingService));
		services.registerSingleton(ITextModelService, () => services.createInstance(TextModelResolverService));
		primaryHostServices.registerInstance(IChatService, chat);
		const accountService = this._register(new AppServerAccountService(options.api.accounts, options.api.events));
		services.registerInstance(IAccountService, accountService);
		services.registerInstance(ILanguageModelsConfigurationService, this._register(services.createInstance(LanguageModelsConfigurationService, ChatModelPreferences)));
		primaryHostServices.registerInstance(ILanguageModelsService, this._register(primaryHostServices.createInstance(LanguageModelsService)));
		services.registerInstance(IInstructionService, options.api.instructions);
		services.registerInstance(IAgentCapabilitiesService, options.api.agentCapabilities);
		services.registerInstance(IAgentToolsApi, options.api.agentTools);
		services.registerInstance(IMcpServerStatusService, options.api.mcpServerStatus);
		services.registerInstance(IMcpServerManagementService, options.api.mcpServerManagement);
		services.registerInstance(IConnectorService, this._register(new AppServerConnectorService(options.api.connectors, options.api.events)));
		services.registerInstance(IWorkspaceTrustApi, options.api.workspaceTrust);
		services.registerInstance(IWorkspaceTrustManagementService, this._register(services.createInstance(WorkspaceTrustManagementService)));
		const checkWorkspaceTrust = !!options.nativeHostApi;
		services.registerInstance(ILanguageServerService, options.api.languageServers);
		const languageLifecycle = this._register(services.createInstance(AppServerLanguageLifecycleService));
		services.registerInstance(ILanguageServerLifecycleService, languageLifecycle);
		const languageProviders = options.api.hasAppServer ? this._register(services.createInstance(AppServerLanguageProviders, options.api.language, { checkWorkspaceTrust })) : undefined;
		const languageDiagnosticsService = this._register(services.createInstance(AppServerLanguageDiagnosticsService, options.api.language, undefined, checkWorkspaceTrust));
		services.registerInstance(ILanguageDiagnosticsService, languageDiagnosticsService);
		this._register(new LanguageDiagnosticsMarkerBridge(languageDiagnosticsService, services.get(IMarkerService)));
		services.registerInstance(IAppServerHookApi, options.api.hooks);
		services.registerInstance(ISessionPrimaryProviderServices, primaryHostServices.createInstance(SessionProviderServices));
		const providerScopes = this._register(services.createInstance(SessionProviderScopeService, provider.id));
		services.registerInstance(ISessionProviderScopeService, providerScopes);
		this._register(services.createInstance(SessionFileSystemContribution, provider.id));
		if (options.api.hasAppServer) {
			const search = services.createInstance(SessionsSearchService, provider.id, options.workspace);
			services.registerInstance(IFileSearchService, search);
			services.registerInstance(IContentSearchService, search);
		}
		const routedChat = this._register(services.createInstance(SessionsChatService));
		services.registerInstance(IChatService, routedChat);
		services.registerInstance(IAgentThreadService, this._register(services.createInstance(SessionsAgentThreadService)));
		services.registerInstance(IAgentSessionService, services.createInstance(SessionsAgentSessionService));
		services.registerInstance(ISearchService, this._register(services.createInstance(SearchService)));
		services.registerInstance(ILanguageModelsService, this._register(services.createInstance(SessionsLanguageModelsService)));
		services.registerInstance(IPromptsService, this._register(services.createInstance(SessionsPromptsService)));
		services.registerInstance(IAgentExecutionSettingsService, this._register(services.createInstance(SessionsExecutionSettingsService)));
		services.registerInstance(ITraceSettingsService, options.api.traceSettings);
		const localization = this._register(new WorkbenchLocalizationService());
		services.registerInstance(ILocalizationService, localization);
		services.registerInstance(IAppServerRemoteAgentService, this._register(services.createInstance(AppServerRemoteAgentService, { remoteApi: options.api.remote })));
		services.registerInstance(IGitHubService, options.api.github);
		const accountPolicies = this._register(services.createInstance(AccountPolicyService));
		services.registerInstance(IAccountPolicyService, accountPolicies);
		const policies = this._register(new MultiplexPolicyService([systemPolicies, accountPolicies]));
		services.registerInstance(IPolicyService, policies);
		// Match Code startup: server initialization needs the extension defaults as
		// well as the profile and workspace settings, before any background pull.
		serviceContributionReady.push(Promise.all([configurationService.initialize(fileService, policies, workingCopies), extensionReady]).then(() => {
			languageLifecycle.start();
			languageProviders?.start();
			languageDiagnosticsService.start();
		}));
		const sessionGitHub = this._register(services.createInstance(SessionsGitHubService));
		services.registerInstance(ISessionsGitHubService, sessionGitHub);
		sessionGitHub.initialize();
		services.registerInstance(IChatTipService, this._register(services.createInstance(ChatTipService)));
		this.lifecycleService = this._register(options.createLifecycleService(services));
		services.registerInstance(ILifecycleService, this.lifecycleService);
		this._register(this.lifecycleService.onWillShutdown(event => {
			event.join(storage.flush(WillSaveStateReason.SHUTDOWN).catch(error => logger.error('storage', 'Could not save Sessions state during shutdown', error)), "Sessions storage flush");
		}));

		options.container.replaceChildren();
		this.domNode = h(ownerDocument, "main");
		this.domNode.className = "ash-sessions-window ash-code-sessions-window";
		this.domNode.setAttribute('aria-busy', 'true');
		options.container.append(this.domNode);
		this._register(toDisposable(() => this.domNode.remove()));
		const dialogs = services.get(IDialogService) as DialogService;
		services.registerInstance(IDialogsModel, dialogs.model);
		const output = services.get(IOutputService);
		services.get(IDefaultLogLevelsService);
		const systemOutput = this._register(new SystemOutputService(output, options.api.appServer, logger, services.get(ILoggerService).files));
		this._register(logger.registerSink(systemOutput, true));
		if (!services.has(IStatusbarService)) services.registerInstance(IStatusbarService, this._register(new StatusbarService()));
		this._register(new DialogHandlerContribution(dialogs.model, new BrowserDialogHandler(this.domNode)));

		let sessionsPart: SessionsPart | undefined;
		const layout = this.layoutService = this._register(services.createInstance(layoutConstructor, this.domNode, {
			activityBarLocation: configurationService.getValue<ActivityBarPosition>(SessionsConfiguration.activityBarLocation),
			focus: () => sessionsPart?.focus(),
		}));
		services.registerInstance(IAgentWorkbenchLayoutService, layout);
		const notificationService = this._register(services.createInstance(NotificationService));
		services.registerInstance(INotificationService, notificationService);
		const feedbackHost = h(ownerDocument, "div");
		feedbackHost.className = "ash-feedback-host";
		services.registerSingleton(IProgressService, () => services.createInstance(ProgressService), { instantiation: InstantiationType.Delayed });
		this.domNode.append(feedbackHost);
		this._register(toDisposable(() => feedbackHost.remove()));
		const openerService = this._register(services.createInstance(OpenerService));
		if (options.nativeHostApi) {
			openerService.setDefaultExternalOpener({ openExternal: options.nativeHostApi.openExternal.bind(options.nativeHostApi) });
		}
		services.registerInstance(IOpenerService, openerService);
		services.get(IMarkdownRendererService).setDefaultCodeBlockRenderer(services.createInstance(EditorMarkdownCodeBlockRenderer));
		const userKeyboardLayoutService = options.userKeyboardLayoutApi ?? UnavailableUserKeyboardLayoutService;
		services.registerInstance(IUserKeyboardLayoutService, userKeyboardLayoutService);
		this._register(CommandsRegistry.register(RETURN_TO_WORKBENCH_COMMAND_ID, () => {
			options.returnToWorkbench();
			logSessionsInteraction(services.get(ITelemetryService), 'openInVSCode');
		}));
		if (!options.nativeHostApi) {
			this._register(CommandsRegistry.register(OPEN_ASH_WINDOW_COMMAND_ID, () => options.returnToWorkbench()));
		}
		const contextKeys = this._register(new ContextKeyService());
		AppServerAvailableContext.bindTo(contextKeys).set(options.api.hasAppServer);
		IsSessionsWindowContext.bindTo(contextKeys).set(true);
		const workspaceFolderCount = WorkspaceFolderCountContext.bindTo(contextKeys);
		workspaceFolderCount.set(workspace.getWorkspace().folders.length);
		this._register(workspace.onDidChangeWorkspace(() => workspaceFolderCount.set(workspace.getWorkspace().folders.length)));
		services.registerInstance(IContextKeyService, contextKeys);
		// Locale changes resolve the host, which uses this window's context keys.
		services.registerInstance(ILocaleService, this._register(services.createInstance(WorkbenchLocaleService)));
		services.registerInstance(IAccessibilityService, this._register(options.nativeHostApi
			? services.createInstance(NativeAccessibilityService, this.domNode)
			: new AccessibilityService({
				root: this.domNode,
				contextKeyService: contextKeys,
				configurationService,
			})));
		// Document hosts resolve Chat editing, whose signals use the window accessibility policy.
		if (options.createTextDocumentHost) { this._register(options.createTextDocumentHost(services)); }
		if (options.createBrowserHost) { this._register(options.createBrowserHost(services)); }
		services.registerInstance(IGitHubConnectionService, this._register(services.createInstance(GitHubConnectionService)));
		const notificationActionRunner = this._register(services.createInstance(NotificationActionRunner));
		const keyboardLayoutService = this._register(new BrowserKeyboardLayoutService({
			navigator: ownerWindow.navigator,
			configurationService,
			layoutProvider: options.keyboardLayoutProvider,
			userLayoutProvider: userKeyboardLayoutService,
		}));
		services.registerInstance(IKeyboardLayoutService, keyboardLayoutService);
		const keybindings = this._register(services.createInstance(WorkbenchKeybindingService, {
			ownerDocument,
			commandService,
			contextKeyService: contextKeys,
			keyboardLayoutService,
		}));
		services.registerInstance(IKeybindingService, keybindings);
		const keybindingsReady = keybindings.initialize().catch(error => { notificationService.warn(localize({ bundle: 'ash', key: 'keybindings.invalid' }, 'Could not load keybindings.json: {0}', String(error))); });
		services.registerInstance(IKeyboardShortcutTroubleshootingService, keybindings);
		const menus = new MenuService(commandService, contextKeys);
		services.registerInstance(IMenuService, menus);
		const contextViews = this._register(new BrowserContextViewService(this.layoutService.activeContainer, this.layoutService));
		services.registerInstance(IContextViewService, contextViews);
		const contextMenus = this._register(options.createContextMenuService(services));
		services.registerInstance(IContextMenuService, contextMenus);
		const notificationsCenter = this._register(services.createInstance(NotificationsCenter, this.domNode, notificationService.model, feedbackHost, notificationActionRunner, undefined, () => services.get(IAccessibleViewService).getOpenAriaHint(AccessibilityVerbositySettingId.Notifications)));
		services.registerInstance(INotificationsCenter, notificationsCenter);
		services.registerInstance(IFileDialogService, options.createFileDialogService(services));
		const hoverService = this._register(new HoverService(configurationService, contextViews, contextMenus));
		services.registerInstance(IHoverService, hoverService);
		this._register(setHoverDelegate(hoverService));
		const accessibleViewService = services.get(IAccessibleViewService);
		services.registerSingleton(ILanguageServerStatusService, () => services.createInstance(AppServerLanguageServerStatusService));
		this._register(registerExtensionManagementActions());
		const preferences = this._register(services.createInstance(SessionsPreferences, this.domNode, async () => {
			await commandService.executeCommand('sessions.open.code');
			// Code may start with only its tab strip. An explicit Preferences handoff needs visible editor content.
			layout.showPart('editor');
		}));
		this._register(registerExtensionsViewContainer(SessionsViewRegistry, ViewContainerLocation.Sidebar));
		const openExtensions = async (options: ExtensionsOpenOptions): Promise<void> => {
			await commandService.executeCommand('sessions.open.code');
			await openExtensionsView(services.get(IViewsService), options);
		};
		this._register(CommandsRegistry.register(OPEN_INSTALLED_EXTENSIONS_COMMAND_ID, (_accessor, options) => openExtensions({ ...options as ExtensionsOpenOptions | undefined, view: 'plugins', mode: 'installed' })));
		this._register(CommandsRegistry.register(OPEN_EXTENSIONS_COMMAND_ID, (_accessor, value: unknown) => {
			const options = value as ExtensionsOpenOptions | string | undefined;
			return openExtensions(typeof options === 'string' ? { query: options.trim() } : options ?? {});
		}));
		const accountMenu = services.createInstance(SessionsAccountMenu, preferences);

		let auxiliarybar: AuxiliaryBarPart | undefined;
		const titlebar = this._register(options.createTitlebarPart(this.domNode, services));
		services.registerInstance(ISessionsTitlebarService, titlebar);
		const viewDescriptors = this._register(services.createInstance(ViewDescriptorService, { registry: SessionsViewRegistry }));
		services.registerInstance(IViewDescriptorService, viewDescriptors);
		services.registerSingleton(IActivityService, () => services.createInstance(ActivityService));
		services.registerSingleton(IDesignEditorService, () => services.createInstance(DesignEditorService));
		this._register(registerSessionsNavigation(async () => {
			const catalog = await options.api.session.listAgents();
			return catalog.agents.map(agent => ({ name: agent.name, description: agent.description, role: { type: 'exact' as const, name: agent.name, source: agent.source } }));
		}));
		const sidebar = this._register(services.createInstance(SidebarPart, this.domNode));
		const recoveredDrafts = migrateNewChatDraftState(storage, error => notificationService.error(localize('sessions.chat.draftRestoreFailed', 'Could not restore the Chat draft: {0}', String(error))));
		this._register(CommandsRegistry.register('sessions.creator.buildWithAgent', async (_accessor, value) => {
			const request = value as { readonly prompt: string; readonly content: string; };
			view.openNewSession(localize('sessions.creator.make.session', 'Make development'));
			await commandService.executeCommand('sessions.open.code');
			sessionsPart!.addContext({ id: 'creator-source', name: 'creator.html', kind: 'file', resolve: async () => ({ name: 'creator.html', content: request.content }) });
			sessionsPart!.appendToDraft(request.prompt || localize('sessions.creator.make.request', 'Build an application from the attached Creator document.'));
			sessionsPart!.focus();
		}));
		this._register(CommandsRegistry.register('sessions.addContextToAgent', async (_accessor, value) => {
			const context = value as { readonly id: string; readonly name: string; readonly content: string; };
			await services.get(ISessionsLayoutService).setConversationVisible(true);
			sessionsPart!.addContext({ id: context.id, name: context.name, kind: 'file', resolve: async () => ({ name: context.name, content: context.content }) });
			sessionsPart!.focus();
		}));
		this.showChat = () => commandService.executeCommand<void>('sessions.open.chat');
		const activitybar = this._register(services.createInstance(ActivityBar, sidebar.domNode, {
			showAccountMenu: (anchor: HTMLElement) => accountMenu.show(anchor),
		}));
		const activityBarLocation = configurationService.getValue<ActivityBarPosition>(SessionsConfiguration.activityBarLocation);
		const setActivityBarLocation = (location: ActivityBarPosition): void => {
			const host = sidebar.setActivityBarLocation(location);
			const integrated = location === ActivityBarPosition.DEFAULT;
			activitybar.setLocation(location, host, integrated ? sidebar.activityBarAccountHost : undefined);
			titlebar.setActivityActions(
				location === ActivityBarPosition.TOP || location === ActivityBarPosition.BOTTOM ? [activitybar.accountAction] : [],
				(action, options) => activitybar.createAccountActionViewItem(action, options, 'titlebar'),
			);
		};
		for (const container of [activitybar.domNode, activitybar.accountContainer]) {
			const activityBarContext = this._register(contextKeys.createScoped(container));
			activityBarContext.createKey('sessionsActivityBarFocused', true);
		}
		this._register(AccessibleViewRegistry.register({
			type: AccessibleViewType.Help,
			priority: 100,
			name: 'sessionsActivityBarHelp',
			when: ContextKeyExpr.has('sessionsActivityBarFocused'),
			getProvider: () => {
				const focused = activitybar.domNode.ownerDocument.activeElement as HTMLElement;
				return new AccessibleContentProvider(
					AccessibleViewProviderId.SessionsActivityBar,
					{ type: AccessibleViewType.Help },
					() => localize('sessions.activity.sidebarHelp', 'Expanded navigation shows icons and names in the sidebar, with Accounts at the bottom. Use the title bar sidebar toggle to hide the entire sidebar, including navigation, Accounts and the workspace mode control; expanding restores them. On Desktop in Chat mode, New opens ChatGPT and focuses its message input. In Code and Browser, New creates an Agent session. The list below contains Pinned, Projects and Chats; Code uses Recents in place of Chats. Enter or Space toggles a group, Left Arrow collapses it and Right Arrow expands it. Code subgroups use folder icons and their chat rows have leading icons. Use Up and Down Arrow, Home and End to move through visible rows. Right-click a chat or press Shift+F10 to pin or unpin it. Expansion is saved separately for Chat and Code. New Chat in Session and Fork Conversation are in the current Chat More Actions menu. Input tips appear below the message input.') + ' ' + localize('sessions.list.menuHelp', 'Hover or focus a chat to reveal More actions, or press Shift+F10. The menu offers pin, rename, archive, add to project, move to group, delete and open in new window. Every chat item supports these actions before its first message. Organizing a chat preserves its draft and does not send a message. A separate Agent chat window keeps the same conversation and draft. Return to main window or close it to bring the chat back; Keep window on top pins the desktop window above others.') + ' ' + localize('sessions.search.navigationHelp', 'Search below New opens a categorized search panel. Type a name to filter sessions, projects and schedules. Use arrow keys to choose a result and Enter to open it; Escape closes Search and restores focus.') + ' ' + localize('sessions.chatgpt.activityHelp', 'On Desktop, New starts a ChatGPT conversation and focuses its message input. ChatGPT offers model selection, attachments, dictation, voice conversation, Send and Stop. Switching conversations and pages retains their drafts, and reopening restores the last selected chat. Login uses the existing Codex account credentials. Press Alt+F1 for help.') + ' ' + localize({ bundle: 'ash', key: 'windowMode.help' }, 'The title bar workspace mode control switches between Chat / Agents and Code in this window, retaining the current session and draft. Each workspace has its own sidebar. The workspace mode control is visible only while the sidebar is expanded. Code navigation contains New, Automations, Collab, Agent Teams and Symphony. New creates a session in the current workspace. Navigation order is saved separately for Chat and Code. Select the current mode again to return from a product page to its conversation. Use arrow keys, Home and End to focus a mode, then Enter or Space to switch pages. In narrow title bars, Back and Forward are available in the Go menu.') + ' ' + localize('sessions.activity.help', 'Sessions Activity Bar\nUse Tab and Shift+Tab to enter navigation and Accounts. Use arrow keys, Home and End to move between actions. Press Enter or Space to open the focused action. Drag icons to reorder them, or choose Move earlier and Move later with the Context Menu key or Shift+F10. Navigation order is saved across restarts and Activity Bar positions. The menu also offers position and size options. New focuses the message input: ChatGPT in Desktop Chat mode, or an Agent session in Code and Browser. Chat keeps a flat conversation list; Code groups conversations by workspace or connected Agent host. Creating an Agent session opens a host picker when more than one host is available; use arrow keys and Enter to choose, or Escape to cancel. Each draft keeps its chosen host when switching conversations. Code custom group headings organize tasks; use Tab to reach a task and Enter to open it. Application tools can create, rename and remove groups without deleting tasks. Each ChatGPT conversation and Agent session retains its own history, unsent text and attachments when switching pages. Each session restores its editor tabs. Toggle Code panel shows or hides the bottom tools. Toggle details, Hide editor and Show editor change the side panel. Toggle Code side panel closes and reopens the composition. Changes and Files tabs remain available in Details-only mode. Use arrow keys on separators to resize. Collab opens the channel preview and Calls in the sidebar. Agent Teams opens the separate Agent teams list. Projects and Creator are product pages selected from the Activity Bar. Projects retains its search and selected project. Materials are organized inside each project. Creator opens seven workspaces. Creator home returns to the mode list. Each workspace retains its document, selection and viewport. Code retains its own file and comparison tabs when you leave the page. Accounts opens Settings, Account, Open IDE and Keyboard Shortcuts. On Desktop, Open IDE opens or focuses the IDE while keeping the Agents window and its unsent drafts open. Use arrow keys to move through the menu, Enter to choose an action and Escape to close it and return focus to Accounts.') + ' ' + localize('customize.activityHelp', 'Customize opens Skills, Connectors and Plugins. Switch between Yours and Discover, search resources and open details to manage them.') + ' ' + localize('automations.activityHelp', 'Automations opens schedules and run history. Create or edit a plan, run it now, pause future runs, or open a result in its conversation.') + ' ' + localize('symphony.activityHelp', 'Symphony schedules tasks inside Ash. The monitor shows conversation messages, status, cumulative tokens and runtime.') + ' ' + localize('agentTrace.activityHelp', 'View Execution Trace opens saved execution from the conversation menu or Command Palette. Show Agent Output opens a bounded live summary in Output; its channel identifies the reviewed Session. Switching conversations keeps that reader on its selected Session until Show Agent Output is invoked again. Output links open the exact execution event. Clear Output only clears the text view, and Auto Scroll only controls following new output.') + (options.api.agentHosts ? ' ' + localize({ bundle: 'ash.workbench', key: 'agentHosts.help' }, 'Use Agents: Manage Connected Hosts in the Command Palette or Sessions header menu to connect a saved SSH host or disconnect a selected host. In the picker, use arrow keys to move, Enter to select, and Escape to cancel.') : ''),
					() => focused.focus(),
					AccessibilityVerbositySettingId.SessionsActivityBar,
				);
			},
		}));
		const updateActivityBarHelpHint = (): void => activitybar.updateHelpHint(accessibleViewService.getOpenAriaHint(AccessibilityVerbositySettingId.SessionsActivityBar));
		this._register(configurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(AccessibilityVerbositySettingId.SessionsActivityBar)) updateActivityBarHelpHint();
		}));
		updateActivityBarHelpHint();
		const cowork = this._register(services.createInstance(CoworkPaneFactory));
		sessionsPart = this.sessionsPart = this._register(services.createInstance(SessionsPart, this.domNode, {
			sessionService: sessions,
			chatService: routedChat,
			contextMenuService: contextMenus,
			contextViewService: contextViews,
			accessibleViewService,
			notifications: notificationService,
			commandService,
			createInputPart: (container, delegate, model, scope) => scope.createInstance(NewChatInputWidget, container, delegate, model),
			createCoworkPane: (container, panelId, selection) => cowork.createPane(container, panelId, selection, () => { view.openNewSession(); }),
			activateSelection: selection => view.activateSelection(selection),
			createNewSession: () => { view.openNewSession(); },
		} satisfies SessionsPartOptions));
		services.registerInstance(ISessionsConversationService, sessionsPart);
		const updateSessionsPart = (): void => {
			const selection = view.getSelection();
			sessionsPart?.updateVisibleSelections(selection.visibleSelections, selection.activeSelection);
		};
		this._register(view.onDidChange(updateSessionsPart));
		updateSessionsPart();
		const conversationLinks = services.createInstance(SessionConversationLinks, provider.id);
		services.registerInstance(IChatSessionNavigationService, {
			get revision() { return view.navigationRevision; },
			captureConnection: sessionId => {
				const scope = providerScopes.getScope(sessionId);
				scope.assertCurrent();
				const appServer = scope.services.host.appServer;
				const generation = appServer.connectionGeneration;
				let retired = false;
				const listener = appServer.onConnectionState(() => { retired = true; });
				return Object.assign(toDisposable(() => { retired = true; listener.dispose(); }), {
					generation,
					assertCurrent: async () => {
						scope.assertCurrent();
						if (retired || generation !== appServer.connectionGeneration) throw canceled();
						const state = await appServer.getConnectionState();
						scope.assertCurrent();
						if (retired || generation !== appServer.connectionGeneration || state !== 'ready') throw canceled();
					},
				});
			},
			prepareConversationLink: (sessionId, threadId) => conversationLinks.prepare(sessionId, threadId),
			openConversationLink: address => conversationLinks.open(address),
			getActiveConversation: () => {
				const selected = view.activeSelection;
				return selected?.kind === 'session' ? { sessionId: selected.active.session.sessionId, threadId: selected.active.threadId } : undefined;
			},
			getConversations: () => sessions.sessions.filter(session => session.status === 'active').flatMap(session => session.chats.filter(chat => chat.status === 'active').map(chat => ({ providerId: session.providerId ?? provider.id, sessionId: session.backendSessionId ?? session.sessionId, threadId: session.backendSessionId ? providerScopes.getScope(session.sessionId).backendIdentity(chat.threadId) : chat.threadId, title: chat.title ?? session.title }))),
			appendToActiveDraft: text => {
				void this.showChat().then(() => {
					sessionsPart!.appendToDraft(text);
					sessionsPart!.focus();
				}).catch(error => notificationService.error(String(error)));
			},
			captureActiveDraft: () => sessionsPart!.captureActiveDraft(),
			openConversation: async (sessionId, threadId, providerId) => {
				if (providerId !== undefined) {
					sessionId = sessionIdentity(providerId, sessionId, provider.id);
					threadId = sessionIdentity(providerId, threadId, provider.id);
				}
				// Visible Code and Cowork panes keep their current composition and draft owner.
				if (!layout.isPartVisible('sessions')) await this.showChat();
				await view.openThread(sessionId, threadId);
				const selected = view.activeSelection;
				if (selected?.kind === 'session' && selected.active.session.sessionId === sessionId && selected.active.threadId === threadId) sessionsPart!.focus();
			},
			startVoiceConversation: () => sessionsPart!.startVoiceConversation(),
		});

		const diffService = services.createInstance(DiffService);
		services.registerInstance(IDiffService, diffService);
		const editor = this._register(services.createInstance(EditorPart, this.domNode, {
			configurationService,
			contextKeyService: contextKeys,
			keybindingService: keybindings,
			keyboardLayoutService,
			fileService,
			textFileService: textFiles,
			languageResolver: languageService,
			languageFeaturesService: services.get(ILanguageFeaturesService),
			diffService,
			languageDiagnosticsService,
			workingCopyService: workingCopies,
			accessibilityService: services.get(IAccessibilityService),
			dialogService: dialogs,
			fileDialogService: services.get(IFileDialogService),
			titleActions: { menuService: menus, contextMenuProvider: contextMenus },
		}));
		services.registerInstance(IEditorPart, editor);
		this._register(new EditorContextKeyController(contextKeys, editor, EditorPanes, languageService));
		const editors = this._register(new BrowserEditorService(editor));
		services.registerInstance(IEditorService, editors);
		services.registerInstance(IEditorGroupsService, editors);
		const workbenchPreferences = this._register(services.createInstance(PreferencesService));
		services.registerInstance(IPreferencesService, {
			openSettings: options => preferences.open(options),
			openUserSettings: options => workbenchPreferences.openUserSettings(options),
			openGlobalKeybindingSettings: textual => workbenchPreferences.openGlobalKeybindingSettings(textual),
		});
		this._register(new WorkbenchEditorContextKeysHandler(contextKeys, editors, editors));
		services.registerInstance(IHistoryService, this._register(services.createInstance(HistoryService)));
		this._register(services.createInstance(TextFileEditorTracker, ownerWindow));
		auxiliarybar = this._register(services.createInstance(AuxiliaryBarPart, this.domNode));
		services.registerInstance(ITerminalProcessService, options.api.terminal);
		const panel = this._register(services.createInstance(PanelPart, this.domNode));
		const panes = this._register(services.createInstance(PaneCompositePartService, new Map<ViewContainerLocation, PaneCompositePart>([
			[ViewContainerLocation.Sidebar, sidebar],
			[ViewContainerLocation.Panel, panel],
			[ViewContainerLocation.AuxiliaryBar, auxiliarybar],
		])));
		services.registerInstance(IPaneCompositePartService, panes);
		const views = this._register(services.createInstance(ViewsService));
		services.registerInstance(IViewsService, views);
		services.get(ILanguageServerStatusService);
		// Extension adapters require the completed editor and view service graph.
		installWorkbenchServiceContributions({ container: services, register: value => this._register(value), blockRestorationUntil: operation => serviceContributionReady.push(operation) });
		const customViewPart = this._register(services.createInstance(CustomViewGridPart, this.domNode));
		services.registerInstance(ICustomViewGridPartService, customViewPart);
		const banner = this._register(services.createInstance(BannerPart, this.domNode, (visible: boolean) => {
			if (visible) layout.showPart('banner');
			else layout.hidePart('banner');
		}));
		services.registerInstance(IBannerService, banner);
		const parts = new Map<SessionsPartId, Part>([
			["titlebar", titlebar],
			['banner', banner],
			["sidebar", sidebar],
			["sessions", sessionsPart],
			['editor', editor],
			["auxiliarybar", auxiliarybar],
			['panel', panel],
			['customview', customViewPart],
		]);
		layout.createWorkbenchLayout(parts);
		setActivityBarLocation(activityBarLocation);
		const customViews = services.get(ICustomViewService);
		this._register(autorun(reader => {
			const opening = customViews.activeCustomViewOpen.read(reader);
			customViewPart.setView(opening?.descriptor);
			layout.setCustomViewVisible(!!opening);
			if (opening?.source === 'explicit') customViewPart.focusActiveView();
		}));
		this._register(this.lifecycleService.onBeforeShutdown(event => {
			event.veto(textModels.waitForSaveRecovery().then(() => false), 'Sessions text save recovery');
			// Pending rejection decisions are captured by the review service's shutdown
			// join. Ordinary dirty files still require an explicit save/discard decision.
			const reviews = services.get(IChatEditingService).entries;
			const identity = services.get(IUriIdentityService).extUri;
			const recoverable = event.reason !== 'load' && workingCopies.getAll().filter(copy => copy.isDirty).every(copy =>
				copy.backupKind === 'text' && reviews.some(entry => entry.hasPendingSave && entry.resources.some(resource => identity.isEqual(resource, copy.resource))));
			if (!recoverable) event.veto(editor.confirmCloseAllEditors().then(confirmed => !confirmed), 'Sessions unsaved files');
		}));
		this._register(configurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(SessionsConfiguration.activityBarLocation)) {
				const location = configurationService.getValue<ActivityBarPosition>(SessionsConfiguration.activityBarLocation);
				setActivityBarLocation(location);
				layout.setActivityBarLocation(location);
			}
		}));
		if (options.createAppToolsHost) this._register(options.createAppToolsHost(services));
		this._register(new SessionsModernUIContribution(this.domNode, layout, configurationService));
		this._register(registerLayoutActions(layout, view, contextKeys));
		const contributions = this._register(WorkbenchContributionsRegistry.createHost(services, undefined, options.contributionIds));
		contributions.advance(WorkbenchPhase.BlockStartup);
		contributions.advance(WorkbenchPhase.BlockRestore);
		this.layoutService.layout();
		const entryLayout = services.get(ISessionsLayoutService);
		// Stop layout persistence before Parts are released; the service scope otherwise outlives their editor grids.
		this._register(toDisposable(() => entryLayout.dispose()));
		this.lifecycleService.phase = LifecyclePhase.Ready;
		// Configuration initialization above owns its first load and reports unavailable workspace settings.
		// Re-reading all workspace files here would turn a disconnected backend into a fatal startup error.
		this.whenRestored = Promise.all([keybindingsReady, extensionReady, ...serviceContributionReady]).then(() => this.initialize(view, ownerWindow, entryLayout, contributions, storage, recoveredDrafts));
	}

	async acceptHandoff(options: IOpenAgentsWindowOptions): Promise<void> {
		await this.whenRestored;
		await this.showChat();
		if (options.conversation) {
			await this.sessionsView.openThread(options.conversation.sessionId, options.conversation.threadId);
		}
		else if (options.draft) {
			const selected = this.sessionsView.activeSelection;
			if (selected?.kind !== 'untitled' || !sameWorkspace(selected.session.workspace, this.workspaceSelection())) {
				this.sessionsView.openNewSession('New code session');
			}
		}
		await this.showChat();
		if (options.draft) this.sessionsPart.restoreDraft(options.draft);
	}

	shutdown(reason: ShutdownReason): Promise<void> {
		return this.lifecycleService.shutdown(reason);
	}

	private async initialize(view: SessionsService, ownerWindow: Window, entryLayout: ISessionsLayoutService, contributions: WorkbenchContributionHost, storage: IStorageService, recoveredDrafts: ReturnType<typeof migrateNewChatDraftState>): Promise<void> {
		if (this.isDisposed) return;
		await view.initialize();
		if (this.isDisposed) return;
		if (!view.activeSelection) view.openNewSession(undefined, { source: 'restore' });
		const selected = view.activeSelection!;
		for (const recovered of recoveredDrafts) {
			const session = view.openNewSession(undefined, { sideBySide: true, source: 'restore' });
			writeNewChatDraftState(storage, recovered.draft, `untitled:${session.untitledSessionId}`);
			this.sessionsPart.restoreDraft(recovered.draft);
			storage.remove(recovered.key, StorageScope.WORKSPACE);
		}
		view.activateSelection(selected, { source: 'restore' });
		await entryLayout.restore();
		if (this.isDisposed) return;
		this.lifecycleService.phase = LifecyclePhase.Restored;
		contributions.advance(WorkbenchPhase.AfterRestored);
		await contributions.workspaceRestored();
		if (this.isDisposed) return;
		this.domNode.setAttribute('aria-busy', 'false');
		this.logService.info('lifecycle', 'Agents restored');
		this._register(disposableWindowTimeout(ownerWindow, () => {
			this.lifecycleService.phase = LifecyclePhase.Eventually;
			contributions.advance(WorkbenchPhase.Eventually);
		}, 2_000));
	}
}

function sameWorkspace(first: SessionWorkspaceSelection, second: SessionWorkspaceSelection): boolean {
	if (first.type !== second.type) return false;
	if (first.type === 'current') return true;
	if (first.type === 'multiple' && second.type === 'multiple') return first.folders.length === second.folders.length && first.folders.every((folder, index) => folder.label === second.folders[index]?.label && sameWorkspace(folder.target, second.folders[index]!.target));
	if (first.type === 'local' && second.type === 'local') return first.root === second.root;
	if (first.type === 'provider' && second.type === 'provider') return first.providerId === second.providerId && first.workspace === second.workspace && first.root === second.root;
	return first.type === 'ssh' && second.type === 'ssh' && first.host === second.host && first.root === second.root;
}

export interface IAgentWorkbenchLayoutService extends ILayoutService {
	getSideBarPosition(): Position;
	getPanelPosition(): Position;
	setPanelPosition(position: Position): void;
	readonly onDidChangePanelPosition: Event<string>;
	isPanelMaximized(): boolean;
	toggleMaximizedPanel(): void;
	createWorkbenchLayout(parts: ReadonlyMap<SessionsPartId, Part>): void;
	setActivityBarLocation(location: ActivityBarPosition): void;
	layout(dimension?: IDimension): void;
	readonly onDidChangePartVisibility: Event<SessionsPartVisibilityChangeEvent>;
	setLayoutStyle(style: SessionsLayoutStyle): void;
	/** Determines which center absorbs window resizing; supporting Parts retain their user widths. */
	setPrimaryPart(partId: 'sessions' | 'editor'): void;
	setCustomViewVisible(visible: boolean): void;
	isPartVisible(partId: SessionsPartId): boolean;
	isPartAvailable(partId: SessionsPartId): boolean;
	setPartAvailable(partId: 'sessions' | 'sidebar' | 'auxiliarybar' | 'editor' | 'panel', available: boolean): void;
	updateParts(update: () => void): void;
	showPart(partId: SessionsPartId): void;
	hidePart(partId: SessionsPartId): void;
}

export const IAgentWorkbenchLayoutService = refineServiceDecorator<ILayoutService, IAgentWorkbenchLayoutService>(ILayoutService);

export interface SessionsPartVisibilityChangeEvent {
	readonly partId: SessionsPartId;
	readonly visible: boolean;
}
