import { IDiffEditorCommandsService } from '../../workbench/browser/parts/editor/diffEditorCommandsService.js';
import { SessionsDiffEditorCommandsService } from '../contrib/editor/browser/diffEditor.sessions.contribution.js';
import { registerAddFileAsContextAction } from '../contrib/editor/browser/editor.contribution.js';
import { ISessionSectionOrderService, SessionSectionOrderService } from '../services/sessions/browser/sessionSectionOrderService.js';
import { ISessionsListModelService, SessionsListModelService } from '../services/sessions/browser/sessionsListModelService.js';
import { ISymphonyBackendService } from '../../platform/symphony/common/symphonyService.js';
import { IRemoteAgentHostService, NullRemoteAgentHostService } from '../../platform/agentHost/common/remoteAgentHostService.js';
import * as chatInputStatePersistence from '../../workbench/contrib/chat/browser/widget/input/chatInputStatePersistence.js';
import { bindSashFeedbackPresentation } from '../../base/browser/ui/sash/sash.js';
import { IAgentSessionActionsService, IAgentSessionsService } from '../../workbench/contrib/chat/browser/agentSessions/agentSessionsService.js';
import { SessionActionsService } from './sessionActionsService.js';
import { IChatListCatalog } from '../contrib/chat/browser/chatListModel.js';
import { ChatHistoryModel } from './chatHistoryModel.js';
import { Menus } from './menus.js';
import { Lxicon } from '../../base/common/lxicons.js';
import { StatusbarService } from '../../workbench/browser/parts/statusbar/statusbarPart.js';
import { ILanguageServerStatusService } from '../../workbench/services/language/common/languageServerStatusService.js';
import { IProjectService } from '../../platform/projects/common/projectService.js';
import { SessionsAgentSessionService } from './agentHost/sessionsAgentSessionService.js';
import type { Position } from '../../workbench/services/layout/browser/layoutService.js';
import { SessionConversationLinks } from './agentHost/sessionConversationLinks.js';
import { SessionsAgentThreadService } from './agentHost/sessionsAgentThreadService.js';
import { SessionsSearchService } from '../contrib/providers/agentHost/browser/sessionsSearchService.js';
import { SessionFileSystemContribution } from '../contrib/providers/agentHost/browser/sessionFileSystemContribution.js';
import { hasDevelopmentPermissions } from '../../platform/workspace/common/workspaceTrust.js';
import { ISessionFolderAuthorizationService, sessionWorkspaceUri } from '../common/sessionWorkspace.js';
import { ISessionProviderScopeService, ISessionPrimaryProviderServices, SessionProviderScopeService, SessionProviderServices, captureInstructionImports, type ISessionProviderScope } from './agentHost/sessionProviderScopeService.js';
import { SessionsChatService } from './agentHost/sessionsChatService.js';
import { SessionsLanguageModelsService } from './agentHost/sessionsLanguageModelsService.js';
import { SessionsPromptsService } from './agentHost/sessionsPromptsService.js';
import { SessionsExecutionSettingsService } from './agentHost/sessionsExecutionSettingsService.js';
import { sessionIdentity } from '../services/sessions/common/sessionIdentity.js';
import { IDefaultLogLevelsService } from '../../workbench/services/log/common/defaultLogLevels.js';
import { IBrowserPasswordService, UnavailableBrowserPasswordService } from '../../platform/browserView/common/browserPasswordService.js';
import { IDocumentEditorTextModelService } from '../../workbench/services/documentEditor/common/documentTypes.js';
import { DocumentEditorTextModelService } from '../../workbench/services/documentEditor/browser/documentEditorTextModelService.js';
import { IChannelService } from '../../platform/collab/common/channelService.js';
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
import { IAgentVoiceService, IAgentConnection } from '../../platform/agentHost/common/agentService.js';
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
import { IExtensionBackendApi } from '../../platform/extensions/common/extensionBackendApi.js';
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
import { IMemoriesService } from '../../platform/memories/common/memoriesService.js';
import { IConnectorService } from '../../platform/connectors/common/connectorService.js';
import { AppServerConnectorService } from '../../workbench/services/connectors/browser/appServerConnectorService.js';
import { IInstructionService } from '../../platform/instructions/common/instructionService.js';
import { SessionComparisonControls } from '../contrib/chat/browser/agentHostDelegation.js';
import { SessionsWindowUsageService } from '../services/sessions/browser/sessionsWindowUsageService.js';
import { ISessionComparisonService, SessionComparisonService } from '../services/sessions/browser/sessionComparisonService.js';
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
import { IAgentHostInputCompletionService, IAgentSessionService, IAgentThreadService, IAgentTurnService } from '../../platform/agentHost/common/agentService.js';
import { IAgentModelsService } from '../../platform/models/common/agentModels.js';
import { ITurnChangesApi } from '../../platform/turnChanges/common/turnChangesApi.js';
import { AppServerAvailableContext, IsSessionsWindowContext, WorkspaceFolderCountContext } from '../../workbench/common/contextkeys.js';
import { EditorPanes } from '../../workbench/browser/editor.js';
import { EditorContextKeyController } from '../../workbench/browser/parts/editor/editorContextKeys.js';
import { WorkbenchEditorContextKeysHandler } from '../../workbench/browser/contextkeys.js';
import { IsDevelopmentContext } from '../../platform/contextkey/common/contextkeys.js';
import { IWorkbenchEnvironmentService } from '../../workbench/services/environment/common/environmentService.js';
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
import { builtinLanguagePackSources, preinstalledLanguagePacks } from '../../../../.build/desktop/localization/localizationCatalogLoader.js';
import { IAppServerHookApi, IAppServerSkillApi } from '../../platform/agentHost/common/appServerApi.js';
import { IExtensionManagementService, OPEN_EXTENSIONS_COMMAND_ID, OPEN_INSTALLED_EXTENSIONS_COMMAND_ID, type ExtensionsOpenOptions } from '../../platform/extensionManagement/common/extensionManagementService.js';
import { registerExtensionManagementActions } from '../../workbench/contrib/extensions/browser/extensionsActions.js';
import { AppServerExtensionManagementService } from '../../workbench/services/extensionManagement/browser/appServerExtensionManagementService.js';
import { IPluginManagementService } from '../../platform/extensionManagement/common/pluginManagementService.js';
import { ILocalGitService } from '../../platform/git/common/localGitService.js';
import { AppServerPluginManagementService } from '../../workbench/services/extensionManagement/browser/appServerPluginManagementService.js';
import { IAppServerRemoteAgentService } from '../../workbench/services/remote/common/appServerRemoteAgentService.js';
import { AppServerRemoteAgentService } from '../../workbench/services/remote/browser/appServerRemoteAgentService.js';
import { autorun, derived, observableFromEvent, observableSignalFromEvent } from '../../base/common/observable.js';
import { CustomViewGridPart } from './parts/customViewGridPart.js';
import { ICustomViewService } from '../services/customView/browser/customViewService.js';
import { ICustomViewGridPartService } from '../services/customView/browser/customViewGridPartService.js';
import { ISessionsProvidersService } from '../services/sessions/browser/sessionsProvidersService.js';
import { IChatSessionNavigationService } from '../../workbench/services/chat/common/chatSessionNavigationService.js';
import { IAutomationDialogService } from '../../workbench/contrib/chat/common/automations/automationDialogService.js';
import '../../workbench/contrib/quickaccess/browser/quickAccess.contribution.js';
import { IVoiceCodeTranscriptionBackendService } from '../../platform/dictation/common/dictation.js';
import '../../workbench/browser/style.js';
import './media/style.css';
import './media/workbench.css';
import './media/notifications.css';
import { SHOW_SESSIONS_PICKER_COMMAND_ID } from '../contrib/sessions/browser/sessionsActions.js';
import './actions/sessionsChatActions.js';
import { NEW_SESSION_ACTION_ID } from '../contrib/chat/common/constants.js';
import './activityBarAccessibility.js';
import '../../workbench/contrib/accessibility/browser/accessibilityConfiguration.js';
import { NotificationActionRunner } from '../../workbench/browser/parts/notifications/notificationsCommands.js';
import '../../workbench/contrib/accessibility/browser/accessibleViewActions.js';
import { addDisposableListener, h, type IDimension } from '../../base/browser/dom.js';
import { canceled, errorHandler, getErrorMessage, onUnexpectedError, setUnexpectedErrorHandler } from '../../base/common/errors.js';
import { DeferredPromise } from '../../base/common/async.js';
import { mainWindow } from '../../base/browser/window.js';
import { Event } from '../../base/common/event.js';
import { SessionsViewRegistry } from '../common/views.js';
import { openExtensionsView, registerExtensionsViewContainer } from '../../workbench/contrib/extensions/browser/extensionsViewlet.js';
import { ViewContainerLocation } from '../../workbench/common/views.js';
import { DesignEditorService, IDesignEditorService } from '../contrib/artifacts/browser/designEditorService.js';
import { Disposable, toDisposable, type IDisposable } from '../../base/common/lifecycle.js';
import { ILanguageService } from '../../editor/common/languages/language.js';
import { LanguageService } from '../../editor/common/services/languageService.js';
import { localize, localize2 } from '../../nls.js';
import { BrowserViewUri } from '../../platform/browserView/common/browserViewUri.js';
import { IBrowserViewWorkbenchService } from '../../workbench/contrib/browserView/common/browserView.js';
import type { EditorWorkingSet } from '../../workbench/services/editor/common/editorWorkingSet.js';
import { MenusRegistry, MenuId } from '../../platform/actions/common/actions.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId, IAccessibleViewService } from '../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../platform/accessibility/browser/accessibleViewRegistry.js';
import { IConfigurationService } from '../../platform/configuration/common/configuration.js';
import { ContextKeyExpr } from '../../platform/contextkey/common/contextkey.js';
import { refineServiceDecorator, type IInstantiationService } from '../../platform/instantiation/common/instantiation.js';
import { InstantiationService } from '../../platform/instantiation/common/instantiationService.js';
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
import { CoworkPaneFactory } from '../contrib/cowork/browser/cowork.contribution.js';
import { ISessionsConversationService } from '../services/sessions/common/sessionsConversation.js';
import { ChatTipService, IChatTipService } from '../../workbench/contrib/chat/browser/chatTipService.js';
import { IsNewSessionContext, SessionsWorkspaceModeContext } from '../common/contextkeys.js';
import { migrateNewChatDraftState, readNewChatDraftState, writeNewChatDraftState } from '../contrib/chat/common/newChatDraftState.js';
import { IAccessibilityService } from '../../platform/accessibility/common/accessibility.js';
import { AccessibilityService } from '../../platform/accessibility/browser/accessibilityService.js';
import { NativeAccessibilityService } from '../../workbench/services/accessibility/electron-browser/accessibilityService.js';
import { ILoggerService, ILogService } from '../../platform/log/common/log.js';
import { WorkbenchContributionsRegistry, WorkbenchPhase, type WorkbenchContributionHost } from '../../workbench/common/contributions.js';
import type { LogService } from '../../platform/log/common/logServiceImpl.js';
import type { Constructor } from '../../platform/instantiation/common/descriptors.js';
import type { SessionsPartId } from '../common/layoutConstants.js';
import { ILayoutService } from '../../platform/layout/browser/layoutService.js';
import { ILifecycleService, LifecyclePhase, type ShutdownReason } from '../../workbench/services/lifecycle/common/lifecycle.js';
import { NotificationService } from '../../workbench/services/notification/common/notificationService.js';
import { INotificationsCenter, NotificationsCenter } from '../../workbench/browser/parts/notifications/notificationsCenter.js';
import { INotificationService } from '../../platform/notification/common/notification.js';
import { type IWorkbenchHost } from '../../workbench/browser/rendererApi.js';
import { AgentHostConnectionsService } from '../../platform/agentHost/browser/agentHostConnectionsService.js';
import { IAgentHostConnectionsService } from '../../platform/agentHost/common/agentHostConnectionsService.js';
import { IExtensionResourceLoaderService } from '../../platform/extensionResourceLoader/common/extensionResourceLoader.js';
import { ITraceSettingsService } from '../../platform/trace/common/traceSettingsService.js';
import type { INativeHostApi, IOpenAgentsWindowOptions } from '../../platform/native/common/nativeHost.js';
import { IStorageService, WillSaveStateReason, StorageScope } from '../../platform/storage/common/storage.js';
import { IThemeService } from '../../platform/theme/common/themeService.js';
import { WorkbenchState, IWorkspaceContextService, type IWorkspace } from '../../platform/workspace/common/workspace.js';
import { ISessionsWorkspaceContextService } from '../services/workspace/browser/workspaceContextService.js';
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
import { DesktopMainEditorPart } from './parts/desktopEditorPart.js';
import { DesktopEditorArea } from './parts/desktopEditorArea.js';
import { DesktopEditorParts } from './parts/desktopEditorParts.js';
import { DesktopToolEditorPart } from './parts/desktopToolEditorPart.js';
import type { DesktopEditorTool } from './parts/desktopEditorArea.js';
import { type IEditorPartOptions } from '../../workbench/browser/parts/editor/editorPart.js';
import { IEditorPartsService } from '../../workbench/browser/parts/editor/editorParts.js';
import { SessionsLayoutService } from '../contrib/layout/browser/sessionsLayoutService.js';
import { BrowserEditorService } from '../../workbench/services/editor/browser/browserEditorService.js';
import { IEditorService } from '../../workbench/services/editor/common/editorService.js';
import { IEditorGroupsService } from '../../workbench/services/editor/common/editorGroupsService.js';
import { IHistoryService } from '../../workbench/services/history/common/history.js';
import { HistoryService } from '../../workbench/services/history/browser/historyService.js';
import { IViewDescriptorService } from '../../workbench/common/views.js';
import { ViewDescriptorService } from '../../workbench/services/views/browser/viewDescriptorService.js';
import { IViewsService } from '../../workbench/services/views/common/viewsService.js';
import { ViewsService } from '../../workbench/services/views/browser/viewsService.js';
import type { IUntitledChatSession, SessionWorkspaceSelection } from '../services/sessions/common/session.js';
import { WorkspacePicker } from '../contrib/chat/browser/sessionWorkspacePicker.js';
import { IDevContainerAgentHostService } from '../common/devContainerAgentHostService.js';
import { DevContainerAgentHostService } from '../contrib/providers/remoteAgentHost/browser/devContainerAgentHostService.js';
import { logSessionsInteraction } from '../common/sessionsTelemetry.js';
import '../../workbench/services/workspaces/browser/workspacesService.js';
import type { Part } from '../../workbench/browser/part.js';
import { setHoverDelegate } from '../../base/browser/ui/hover/hoverDelegate.js';
import { IMenuService } from '../../platform/actions/common/actions.js';
import { MenuService } from '../../platform/actions/common/menuService.js';
import { CommandsRegistry, ICommandService } from '../../platform/commands/common/commands.js';
import { IContextKeyService, ContextKeyService } from '../../platform/contextkey/browser/contextKeyService.js';
import { IExtensionHostApi } from '../../platform/extensions/common/extensionHostApi.js';
import { ITelemetryService } from '../../platform/telemetry/common/telemetry.js';
import { NullTelemetryService } from '../../platform/telemetry/common/telemetryUtils.js';
import { IContextMenuService, IContextViewService } from '../../platform/contextview/browser/contextView.js';
import { BrowserContextViewService } from '../../platform/contextview/browser/contextViewService.js';
import { HoverService, IHoverService } from '../../platform/hover/browser/hoverService.js';
import { IKeybindingService } from '../../platform/keybinding/common/keybinding.js';
import { IKeyboardLayoutService, type IKeyboardLayoutProvider } from '../../platform/keyboardLayout/common/keyboardLayout.js';
import { IUserKeyboardLayoutService, UnavailableUserKeyboardLayoutService, type IUserKeyboardLayoutApi } from '../../platform/keyboardLayout/common/userKeyboardLayout.js';
import { IOpenerService } from '../../platform/opener/common/opener.js';
import { IMarkdownRendererService } from '../../platform/markdown/browser/markdownRenderer.js';
import { EditorMarkdownCodeBlockRenderer } from '../../editor/browser/widget/markdownRenderer/browser/editorMarkdownCodeBlockRenderer.js';
import '../../workbench/contrib/externalUriOpener/common/externalUriOpener.contribution.js';
import { OpenerService } from '../../editor/browser/services/openerService.js';
import { CommandService } from '../../workbench/services/commands/common/commandService.js';
import { BrowserKeyboardLayoutService } from '../../workbench/services/keybinding/browser/keyboardLayoutService.js';
import { WorkbenchKeybindingService } from '../../workbench/services/keybinding/browser/keybindingService.js';
import { IKeyboardShortcutTroubleshootingService } from '../../workbench/services/keybinding/common/keyboardShortcutTroubleshooting.js';
import { IPreferencesService } from '../../workbench/services/preferences/common/preferences.js';
import { PreferencesService } from '../../workbench/services/preferences/browser/preferencesService.js';
import '../../workbench/services/quickinput/browser/quickInputService.js';
import { WorkbenchWindow } from '../../workbench/browser/window.js';
import { IAccountService } from '../../platform/accounts/common/accountService.js';
import { IIssueReporterService } from '../../platform/issue/common/issue.js';
import { IIssueFormService } from '../../workbench/contrib/issue/common/issue.js';
import { IssueFormService } from '../../workbench/contrib/issue/browser/issueFormService.js';
import { IGitHubService } from '../../platform/github/common/githubService.js';
import { GitHubConnectionService } from '../../workbench/services/accounts/browser/gitHubConnectionService.js';
import { IGitHubConnectionService } from '../../workbench/services/accounts/common/gitHubConnectionService.js';
import { BrowserClipboardService } from '../../workbench/services/clipboard/browser/clipboardService.js';
import { INativeHostService } from '../../workbench/common/services.js';
import { ActivityBarPosition } from '../../workbench/common/configuration.js';
import { ChatService } from '../../workbench/services/chat/browser/chatService.js';
import { AppServerAccountService } from '../../workbench/services/accounts/browser/appServerAccountService.js';
import { IChatService } from '../../workbench/services/chat/common/chatService.js';
import { ConfigurationService } from '../services/configuration/browser/configurationService.js';
import { IPolicyService, NullPolicyService } from '../../platform/policy/common/policy.js';
import { MultiplexPolicyService } from '../../platform/policy/common/multiplexPolicyService.js';
import { AccountPolicyService, IAccountPolicyService } from '../../workbench/services/policies/common/accountPolicyService.js';
import type { ExtensionColorThemeService } from '../../workbench/services/extensions/browser/extensionColorThemeService.js';
import type { BrowserStorageServiceOptions } from '../../workbench/services/storage/browser/storageService.js';
import { IWorkbenchHostService } from '../../workbench/services/host/common/workbenchHostService.js';
import { WorkbenchThemeService } from '../../workbench/services/themes/browser/workbenchThemeService.js';
import { IHostColorSchemeService } from '../../workbench/services/themes/common/hostColorSchemeService.js';
import { AppServerSessionsProvider, type AppServerSessionsProviderHost } from '../contrib/providers/agentHost/browser/appServerSessionsProvider.js';
import { AppServerTeamsProvider } from '../contrib/providers/agentHost/browser/appServerTeamsProvider.js';
import { TeamsManagementService } from '../services/teams/browser/teamsManagementService.js';
import { ITeamsManagementService } from '../services/teams/common/teamsManagement.js';
import { SessionsAccountMenu } from '../contrib/accounts/browser/sessionsAccountMenu.js';
import { SessionsModernUIContribution } from '../contrib/modernUI/browser/modernUI.contribution.js';
import { SessionsPreferences } from '../contrib/preferences/browser/sessionsPreferences.js';
import type { SessionsProfile } from '../common/sessionsProfile.js';
import { RETURN_TO_WORKBENCH_COMMAND_ID } from '../common/windowNavigation.js';
import { OPEN_ASH_WINDOW_COMMAND_ID } from '../common/sessionCommands.js';
import { SessionsConfiguration, type SessionsActivityBarLocation } from '../common/configuration.js';
import { SessionsManagementService } from '../services/sessions/browser/sessionsManagementService.js';
import { ISessionsManagementService } from '../services/sessions/common/sessionsManagement.js';
import { ISessionsService, SessionsService } from '../services/sessions/browser/sessionsService.js';
import { ISessionsLayoutService } from '../services/layout/common/sessionsLayoutService.js';
import { registerLayoutActions } from './layoutActions.js';
import { registerSessionsTerminalContribution } from '../contrib/terminal/browser/sessionsTerminalContribution.js';
import { ITerminalProcessService, TerminalLocation } from '../../platform/terminal/common/terminal.js';
import { ITerminalService, ITerminalEditorService } from '../../workbench/contrib/terminal/browser/terminal.js';
import { TerminalService } from '../../workbench/contrib/terminal/browser/terminalService.js';
import { installWorkbenchServiceContributions } from '../../workbench/browser/workbenchServiceContributions.js';
import { AuxiliaryBarPart } from './parts/auxiliaryBarPart.js';
import { disposableWindowTimeout } from '../../base/browser/scheduler.js';
import { ActivityBar } from './parts/activitybar/activityBarPart.js';
import type { PaneCompositePart } from '../../workbench/browser/parts/paneCompositePart.js';
import { PaneCompositePartService } from '../../workbench/browser/parts/paneCompositePartService.js';
import { IPaneCompositePartService } from '../../workbench/services/panecomposite/browser/panecomposite.js';
import { SessionsPart, type SessionsPartOptions } from './parts/sessionsPart.js';
import { SidebarPart } from './parts/sidebarPart.js';
import { registerSessionsNavigation } from '../contrib/sessions/browser/views/sessionsView.js';
import { ISessionsTitlebarService, type TitlebarPart } from './parts/titlebarPart.js';

export interface IWorkbenchOptions {
	/** Host-owned services are borrowed before this window creates its consumers. */
	readonly serviceCollection?: ServiceCollection;
	readonly createAppToolsHost?: (services: IInstantiationService) => IDisposable;
	readonly createTextDocumentHost?: (services: IInstantiationService) => IDisposable;
	readonly createBrowserHost?: (services: IInstantiationService) => IDisposable;
	readonly contributionIds: readonly string[];
	readonly profile: SessionsProfile;
	readonly api: IWorkbenchHost;
	readonly workspaceSelection: () => SessionWorkspaceSelection;
	readonly workspace: () => IWorkspace;
	readonly initialWorkspaceReady?: Promise<void>;
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

/** New Sessions terminals use the same Editor Groups as the other Code tools. */
class SessionsTerminalService extends TerminalService {
	protected override getDefaultLocation(): TerminalLocation { return TerminalLocation.Editor; }
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
		if (!ownerWindow) throw new Error('Sessions renderer requires an owner window');

		const serviceCollection = options.serviceCollection ?? new ServiceCollection();
		if (!serviceCollection.has(ITerminalService)) {
			serviceCollection.set(ITerminalService, new SyncDescriptor(SessionsTerminalService, [], true));
		}
		if (!serviceCollection.has(IExtensionRecommendationsService)) {
			serviceCollection.set(IExtensionRecommendationsService, new SyncDescriptor(ExtensionRecommendationsService, [ExtensionUiTarget.Agents], true));
		}
		// Load service descriptions before consumers so shared dependencies resolve in this window's scope.
		for (const [id, descriptor] of getSingletonServiceDescriptors()) {
			if (id !== ISessionsLayoutService && !serviceCollection.has(id)) { serviceCollection.set(id, descriptor); }
		}
		const hostPolicies = new ServiceCollection(...[...serviceCollection.entries()].filter(([id]) => id === IPolicyService));
		const windowServices = new ServiceCollection(...[...serviceCollection.entries()].filter(([id]) => id !== IPolicyService));
		// The scope's services can persist state while disposing; borrowed storage must outlive them.
		const storage = this._register(storageService);
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
		const workspaceProjectionReady = new DeferredPromise<void>();
		void workspaceProjectionReady.p.catch(() => undefined);
		this._register(toDisposable(() => { void workspaceProjectionReady.complete(); }));
		const configurationService = this.configurationService = this._register(services.createInstance(ConfigurationService, {
			initialConfiguration: options.initialConfiguration, workspace: options.workspace(), initialWorkspaceReady: workspaceProjectionReady.p,
		}));
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
		if (!serviceCollection.has(ITelemetryService)) { services.registerInstance(ITelemetryService, NullTelemetryService); }
		services.registerInstance(IApprovalEnvironmentService, options.api.approvalEnvironment);
		services.registerInstance(IVoiceCodeTranscriptionBackendService, options.api.dictation);
		services.registerInstance(IAgentVoiceService, options.api.agentVoice);
		if (options.api.channels) services.registerInstance(IChannelService, options.api.channels);
		if (options.api.calls) services.registerInstance(ICallService, options.api.calls);
		const localTranscription = options.api.localTranscription ?? this._register(new NullLocalTranscriptionService());
		services.registerInstance(ILocalTranscriptionService, localTranscription);
		services.registerInstance(ILocalTranscriptionModelService, options.api.localTranscriptionModels ?? (localTranscription instanceof NullLocalTranscriptionService ? localTranscription : this._register(new NullLocalTranscriptionService())));
		services.registerInstance(IConfigurationService, configurationService);
		const languagePacks = this._register(services.createInstance(WebLanguagePacksService, builtinLanguagePackSources, preinstalledLanguagePacks));
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
		Object.assign(services.get(IWorkbenchEnvironmentService), { userHome: options.api.localUserHome, userRoamingDataHome: options.api.userDataHome });
		services.registerInstance(IAgentConnection, options.api);
		services.registerInstance(ISymphonyBackendService, options.api.symphony);
		services.registerInstance(IRemoteAgentHostService, options.api.agentHosts ?? new NullRemoteAgentHostService());
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
		services.registerSingleton(IDevContainerAgentHostService, () => primaryHostServices.createInstance(DevContainerAgentHostService));
		primaryHostServices.registerInstance(IAgentThreadService, options.api.thread);
		services.registerInstance(IAgentTurnService, options.api.turn);
		services.registerInstance(ITurnChangesApi, options.api.turnChanges);
		services.registerInstance(ServerEventApiId, options.api.events);
		services.registerInstance(IAppServerSkillApi, options.api.skills);
		primaryHostServices.registerSingleton(IPromptsService, () => primaryHostServices.createInstance(PromptsService));
		if (!serviceCollection.has(ISessionFolderAuthorizationService)) {
			services.registerInstance(ISessionFolderAuthorizationService, { isTrusted: async () => true, authorize: async () => true });
		}
		const folderAuthorization = services.get(ISessionFolderAuthorizationService);
		const provider = this._register(primaryHostServices.createInstance(AppServerSessionsProvider, {
			workspace: options.workspaceSelection,
			isWorkspaceTrusted: async target => {
				if (target.type === 'local') return folderAuthorization.isTrusted(target.root);
				const directory = await options.api.workspaceTrust.readDirectory(target.root);
				return hasDevelopmentPermissions(directory.permissions ?? directory.inheritedWorkspacePermissions);
			},
			authorizeWorkspace: (target, signal) => folderAuthorization.authorize(
				target.root, signal, target.type === 'ssh' ? { api: options.api, label: target.host }
				: target.type === 'remote' ? { api: options.api, label: target.authority } : undefined),
			selectWorkspace: async folders => {
				using selection = services.createInstance(WorkspacePicker, {});
				return await selection.pick(folders);
			},
		} satisfies AppServerSessionsProviderHost));
		this._register(services.get(ISessionsProvidersService).registerProvider(provider));
		const sessions = this._register(services.createInstance(SessionsManagementService, provider.id));
		const teams = new TeamsManagementService(new AppServerTeamsProvider(options.api.teams));
		services.registerInstance(ITeamsManagementService, teams);
		services.registerInstance(ISessionsManagementService, sessions);
		services.registerSingleton(IAgentSessionActionsService, () => services.createInstance(SessionActionsService, services.get(IChatListCatalog)));
		const view = this.sessionsView = this._register(services.createInstance(SessionsService));
		const windowUsage = services.createInstance(SessionsWindowUsageService);
		logger.trace('sessions.navigation', 'Sessions window started', { count: windowUsage.windowOpenCount, hadPriorWindowOpen: windowUsage.hadPriorWindowOpen });
		this._register(view.onDidFinishThreadOpen(result => logger.trace('sessions.navigation', 'Thread open finished', result)));
		const chat = this._register(primaryHostServices.createInstance(ChatService));
		services.registerInstance(ISessionsService, view);
		services.registerInstance(ISessionGroupsService, this._register(services.createInstance(SessionGroupsService)));
		services.registerInstance(ISessionComparisonService, services.createInstance(SessionComparisonService));
		services.registerSingleton(ISessionSectionOrderService, () => services.createInstance(SessionSectionOrderService));
		services.registerSingleton(ISessionsListModelService, () => services.createInstance(SessionsListModelService));
		services.registerSingleton(IAgentSessionsService, () => services.createInstance(ChatHistoryModel));
		const workspace = configurationService;
		services.registerInstance(ISessionsWorkspaceContextService, {
			getHostWorkspace: options.workspace,
			updateWorkspace: next => workspace.updateWorkspace(next),
		});
		services.registerInstance(IWorkspaceContextService, workspace);
		services.registerInstance(IMarkerService, this._register(new MarkerService()));
		const files = this._register(services.createInstance(SessionFileService, options.api, () => [...options.workspace().folders.map(folder => ({ uri: folder.uri, target: { type: 'environment' as const, dirId: folder.id } })), ...sessions.sessions.filter(session => (session.providerId ?? provider.id) === provider.id).flatMap(session => [session.workspace, ...session.chats.map(chat => chat.workspace)].flatMap(workspace => workspace ? [{ uri: sessionWorkspaceUri(workspace), target: { type: 'session' as const, sessionId: session.backendSessionId ?? session.sessionId, path: workspace.root } }] : []))]));
		const agentHostFiles = this._register(services.createInstance(AgentHostFileSystemService, files, options.browserFileSystemProvider));
		services.registerInstance(IAgentHostFileSystemService, agentHostFiles);
		const systemPolicies = hostServices.has(IPolicyService) ? hostServices.get(IPolicyService) : new NullPolicyService();
		services.registerInstance(IPluginManagementService, this._register(services.createInstance(AppServerPluginManagementService, options.api.plugins, options.api.events)));
		if (!options.api.appServer.isAvailable) services.registerInstance(IFileSearchService, services.createInstance(BrowserFileSearchService));
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
		if (!options.api.appServer.isAvailable) services.registerInstance(IContentSearchService, new FileContentSearchService(fileService));
		services.registerSingleton(IKeybindingEditingService, () => services.createInstance(KeybindingsEditingService));
		services.registerSingleton(ITextModelService, () => services.createInstance(TextModelResolverService));
		primaryHostServices.registerInstance(IChatService, chat);
		const accountService = this._register(new AppServerAccountService(options.api.accounts, options.api.events));
		services.registerInstance(IAccountService, accountService);
		services.registerInstance(IIssueReporterService, options.api.issueReporter);
		services.registerSingleton(IIssueFormService, () => services.createInstance(IssueFormService));
		services.registerInstance(ILanguageModelsConfigurationService, this._register(services.createInstance(LanguageModelsConfigurationService, ChatModelPreferences)));
		primaryHostServices.registerInstance(ILanguageModelsService, this._register(primaryHostServices.createInstance(LanguageModelsService)));
		services.registerInstance(IAgentCapabilitiesService, options.api.agentCapabilities);
		services.registerInstance(IAgentToolsApi, options.api.agentTools);
		services.registerInstance(IMcpServerStatusService, options.api.mcpServerStatus);
		services.registerInstance(IMcpServerManagementService, options.api.mcpServerManagement);
		if (options.api.memories) { services.registerInstance(IMemoriesService, options.api.memories); }
		services.registerInstance(IConnectorService, this._register(new AppServerConnectorService(options.api.connectors, options.api.events)));
		services.registerInstance(IWorkspaceTrustApi, options.api.workspaceTrust);
		services.registerInstance(IWorkspaceTrustManagementService, this._register(services.createInstance(WorkspaceTrustManagementService)));
		const checkWorkspaceTrust = !!options.nativeHostApi;
		services.registerInstance(ILanguageServerService, options.api.languageServers);
		services.registerSingleton(ILanguageServerLifecycleService, () => services.createInstance(AppServerLanguageLifecycleService));
		const languageLifecycle = options.api.appServer.isAvailable ? services.get(ILanguageServerLifecycleService) : undefined;
		const languageProviders = options.api.appServer.isAvailable ? this._register(services.createInstance(AppServerLanguageProviders, options.api.language, { checkWorkspaceTrust })) : undefined;
		// A disconnected preview needs local syntax, not server diagnostics or model sync.
		const createDiagnostics = () => services.createInstance(AppServerLanguageDiagnosticsService, options.api.language, undefined, checkWorkspaceTrust);
		const languageDiagnosticsService = options.api.appServer.isAvailable ? this._register(createDiagnostics()) : undefined;
		if (languageDiagnosticsService) {
			services.registerInstance(ILanguageDiagnosticsService, languageDiagnosticsService);
			this._register(new LanguageDiagnosticsMarkerBridge(languageDiagnosticsService, services.get(IMarkerService)));
		} else services.registerSingleton(ILanguageDiagnosticsService, createDiagnostics);
		services.registerInstance(IAppServerHookApi, options.api.hooks);
		services.registerInstance(ISessionPrimaryProviderServices, this._register(primaryHostServices.createInstance(SessionProviderServices)));
		const providerScopes = this._register(services.createInstance(SessionProviderScopeService, provider.id,
			(scope: ISessionProviderScope) => search.forScope(scope)));
		services.registerInstance(ISessionProviderScopeService, providerScopes);
		const search = services.createInstance(SessionsSearchService, provider.id, options.workspace);
		services.registerInstance(IInstructionService, { ...options.api.instructions, captureImports: sessionId => captureInstructionImports(providerScopes.getScope(sessionId), sessionId) });
		this._register(services.createInstance(SessionFileSystemContribution, provider.id));
		if (options.api.appServer.isAvailable) {
			services.registerInstance(IFileSearchService, search);
			services.registerInstance(IAgentHostInputCompletionService, search);
			services.registerInstance(IContentSearchService, search);
		} else {
			services.registerInstance(IAgentHostInputCompletionService, options.api.completions);
		}
		const routedChat = this._register(services.createInstance(SessionsChatService));
		services.registerInstance(IChatService, routedChat);
		services.registerInstance(IAgentThreadService, this._register(services.createInstance(SessionsAgentThreadService)));
		services.registerInstance(IAgentSessionService, this._register(services.createInstance(SessionsAgentSessionService)));
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
			languageLifecycle?.start();
			languageProviders?.start();
			languageDiagnosticsService?.start();
		}));
		const sessionGitHub = this._register(services.createInstance(SessionsGitHubService));
		services.registerInstance(ISessionsGitHubService, sessionGitHub);
		sessionGitHub.initialize();
		services.registerInstance(IChatTipService, this._register(services.createInstance(ChatTipService)));
		this.lifecycleService = this._register(options.createLifecycleService(services));
		services.registerInstance(ILifecycleService, this.lifecycleService);
		services.registerInstance(IExtensionHostApi, options.extensionHost ?? this._register(services.createInstance(WebWorkerExtensionHost, enabledExtensions, options.api.extensionHost)));
		this._register(this.lifecycleService.onWillShutdown(event => {
			event.join(storage.flush(WillSaveStateReason.SHUTDOWN).catch(error => logger.error('storage', 'Could not save Sessions state during shutdown', error)), 'Sessions storage flush');
		}));

		options.container.replaceChildren();
		this.domNode = h(ownerDocument, 'main');
		this.domNode.className = 'ash-sessions-window ash-code-sessions-window';
		const applyInterfaceFont = () => {
			this.domNode.dataset.interfaceFont = configurationService.getValue<string>(SessionsConfiguration.interfaceFontFamily);
		};
		applyInterfaceFont();
		this._register(configurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(SessionsConfiguration.interfaceFontFamily)) applyInterfaceFont();
		}));
		this._register(bindSashFeedbackPresentation(this.domNode, 'handle'));
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
			focus: () => sessionsPart?.focus(),
		}));
		services.registerInstance(IAgentWorkbenchLayoutService, layout);
		const notificationService = this._register(services.createInstance(NotificationService));
		services.registerInstance(INotificationService, notificationService);
		const feedbackHost = h(ownerDocument, 'div');
		feedbackHost.className = 'ash-feedback-host';
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
		IsDevelopmentContext.bindTo(contextKeys).set(!services.get(IWorkbenchEnvironmentService).isBuilt);
		AppServerAvailableContext.bindTo(contextKeys).set(options.api.appServer.isAvailable);
		IsSessionsWindowContext.bindTo(contextKeys).set(true);
		const workspaceFolderCount = WorkspaceFolderCountContext.bindTo(contextKeys);
		workspaceFolderCount.set(workspace.getWorkspace().folders.length);
		this._register(workspace.onDidChangeWorkspace(() => workspaceFolderCount.set(workspace.getWorkspace().folders.length)));
		services.registerInstance(IContextKeyService, contextKeys);
		const workspaceModeKeys = new Set([SessionsWorkspaceModeContext.key]);
		this._register(contextKeys.onDidChangeContext(event => {
			if (event.affectsSome(workspaceModeKeys)) {
				view.setWorkspaceMode(contextKeys.getValue<'chat' | 'code'>(SessionsWorkspaceModeContext.key) ?? 'chat');
			}
		}));
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
		this._register(registerSessionsNavigation());
		const sidebar = this._register(services.createInstance(SidebarPart, this.domNode));
		const recoveredDrafts = migrateNewChatDraftState(storage, chatInputStatePersistence, error => notificationService.error(localize('sessions.chat.draftRestoreFailed', 'Could not restore the Chat draft: {0}', String(error))));
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
			showAccountMenu: (anchor: HTMLElement, selectFirst: boolean) => accountMenu.show(anchor, selectFirst),
		}));
		const activityBarLocation = configurationService.getValue<SessionsActivityBarLocation>(SessionsConfiguration.activityBarLocation);
		const setActivityBarLocation = (location: SessionsActivityBarLocation): void => {
			const host = sidebar.setActivityBarLocation(location);
			const accountsInTitlebar = location === ActivityBarPosition.TOP;
			activitybar.setLocation(location, host, accountsInTitlebar ? undefined : sidebar.activityBarAccountHost);
			titlebar.setActivityActions(
				accountsInTitlebar ? [activitybar.accountAction] : [],
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
					() => localize('sessions.activity.sidebarHelp', 'The Default position shows navigation icons and names. In Chat, focus Projects in navigation and press Tab to reach Create project. Open Scheduled to manage Chat tasks and their run history. In Default and Bottom, Accounts is at the bottom of the sidebar. In Top, Accounts is in the title bar. Use the title bar sidebar toggle to collapse or expand the sidebar and its controls. New opens a draft in the selected Chat or Code mode and focuses the message input. The sidebar shows Pinned, Projects and Recent conversations for the current mode. Enter or Space toggles a group, Left Arrow collapses it and Right Arrow expands it. Code subgroups use folder icons and their chat rows have leading icons. Use Up and Down Arrow, Home and End to move through visible rows. Right-click a chat or press Shift+F10 to pin or unpin it. Fork Conversation is available in the Command Palette. Input tips appear above the message input.') + ' ' + localize('sessions.list.menuHelp', 'Use Tab to reach the change icon button on a saved conversation. Hover or focus a chat to reveal More actions, or press Shift+F10. The menu offers pin, rename, archive, project and group actions, delete and open in new window. Saved conversations can be moved to a project or removed from their current project. Dragging a pinned conversation to Recents unpins it and keeps its memberships. Organizing a chat preserves its draft and does not send a message. A separate Agent chat window keeps the same conversation and draft. Return to main window or close it to bring the chat back; Keep window on top pins the desktop window above others.') + ' ' + localize('sessions.list.automationFilterHelp', 'Open More Sessions Actions to find Group By, Sort By, and Show. Use Right Arrow to enter a submenu and Left Arrow to return. Sort By offers a sort field and direction. Show controls comparison groups and task run conversations. Scheduled and Routines keep their run history when these conversations are hidden.') + ' ' + localize('sessions.list.groupAppearanceHelp', 'Focus a project name or group title and press Shift+F10 to change its icon or color. Select Default in the picker to reset it. Choose Pin to move it to Pinned or Unpin to return it to Projects. On a project row, press Tab to reach More project actions. The button and the context menu offer Rename, Archive, and Delete when available. Rename opens a dialog next to the project with the current name selected. Press Enter to confirm or Escape to cancel. Archive asks for confirmation and archives the project and its active conversations. Deleting a project also requires confirmation.') + ' ' + localize('sessions.list.workspaceProjectHelp', 'In the Code sidebar, use Tab to reach Create project beside the Projects heading. Enter a name and use Add to choose source folders. Use Change project appearance next to the name to choose an icon and color. Escape closes the picker and returns focus to its button. Right-click a folder group in Recents or press Shift+F10 to copy its path. Use the Command Palette to run Link Unassigned Code Conversations to Folder Projects and review the conversations to link.') + ' ' + localize('sessions.search.navigationHelp', 'Search in the sidebar opens a categorized search panel. Type a name to filter sessions, projects and tasks. Use arrow keys to choose a result and Enter to open it; Escape closes Search and restores focus.') + ' ' + localize({ bundle: 'ash', key: 'windowMode.help' }, 'The title bar workspace mode control switches between Chat / Agents and Code in this window, retaining the current session and draft. The conversation sidebar and Activity Bar actions follow the selected mode. The workspace mode control is visible only while the sidebar is expanded. New opens a draft in the selected mode. Select the current mode again to return from a product page to its conversation. Use arrow keys, Home and End to focus a mode, then Enter or Space to switch pages. In narrow title bars, Back and Forward are available in the Go menu.') + ' ' + localize('sessions.activity.help', 'Sessions Activity Bar\nUse Tab and Shift+Tab to enter navigation and Accounts. Use arrow keys, Home and End to move between actions. Press Enter or Space to open the focused action. Drag icons to reorder them, or choose Move earlier and Move later with the Context Menu key or Shift+F10. Navigation order is saved across restarts and Activity Bar positions. In Top and Bottom, actions that do not fit appear under More. Use Activity Bar Position in the menu to choose Default, Top, or Bottom. The conversation sidebar groups conversations by project, workspace or connected Agent host. In a new Code conversation, use the Run on menu to choose its host before sending. Use arrow keys and Enter to choose, or Escape to close the menu. Each draft keeps its chosen host when switching conversations. Code custom group headings organize tasks; use Tab to reach a task and Enter to open it. Application tools can create, rename and remove groups without deleting tasks. Conversations retain their history, unsent text and attachments when you switch pages. Each session restores its editor tabs. Toggle details, Hide editor and Show editor change the side panel. Toggle Code side panel closes and reopens the composition. Files opens the file tree in its editor group. Opening a document shows the editor; closing the last document hides it and keeps Files visible. Use arrow keys on separators to resize. Collab opens the channel preview and Calls in the sidebar. Settings > Agents manages roles and teams. Use Left and Right to move between its tabs, then Enter or Space to open a view. Projects and Creator are product pages selected from the Activity Bar. Projects retains its search and selected project. Materials are organized inside each project. Creator opens seven workspaces. Creator home returns to the mode list. Each workspace retains its document, selection and viewport. Code retains its own file and comparison tabs when you leave the page. Accounts opens Settings, Account, Open IDE and Keyboard Shortcuts. On Desktop, Open IDE opens or focuses the IDE while keeping the Agents window and its unsent drafts open. Use arrow keys to move through the menu, Enter to choose an action and Escape to close it and return focus to Accounts.') + ' ' + localize('sessions.update.help', 'After an update finishes downloading, Restart to Update remains above Accounts. Tab to the button and press Enter or Space to install the update and restart.') + ' ' + localize('sessions.activity.moreHelp', 'Open More for Collab in Chat, or Routines and Symphony in Code when available. Use Up or Down Arrow to browse, Enter to open an item, or Escape to return to More. Press Right Arrow and Enter to pin or unpin a focused item. It stays in More. You can also unpin it from its sidebar context menu.') + ' ' + localize('customize.activityHelp', 'Customize opens Skills, Connectors and Plugins. Switch between Yours and Discover, search resources and open details to manage them.') + ' ' + localize('automations.activityHelp', 'Routines opens Code plans and run history. Create or edit a plan, run it now, pause future runs, or open a result in its conversation.') + ' ' + localize('symphony.activityHelp', 'Symphony schedules tasks inside Ash. The monitor shows conversation messages, status, cumulative tokens and runtime.') + ' ' + localize('pinnedCanvas.activityHelp', 'Use Add Canvas to Sidebar from a Canvas tab menu or the Command Palette to keep a registered Canvas in navigation. Choose its sidebar item to open the full page without switching conversations. Its page header and sidebar context menu offer Go to Chat, Reconnect Canvas, Remove from Sidebar and Close Canvas. Removing a pin keeps its page in the conversation. Up to five Canvases can be pinned.') + ' ' + localize('agentTrace.activityHelp', 'View Execution Trace opens saved execution from the conversation menu or Command Palette.') + (options.api.agentHosts ? ' ' + localize({ bundle: 'ash.workbench', key: 'agentHosts.help' }, 'Use Agents: Manage Connected Hosts in the Command Palette. In Remote Environments, use Tab to reach the connection actions and Escape to close the dialog.') : ''),
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
		const conversationVisible = observableFromEvent(this, layout.onDidChangePartVisibility, () => layout.isPartVisible('sessions'));
		const draftChanged = observableSignalFromEvent(this, listener => storage.onDidChangeValue(event => {
			const active = view.activeSelection;
			if (active?.kind === 'untitled' && event.scope === StorageScope.WORKSPACE
				&& event.key === `sessions.inputDraft:untitled:${active.session.untitledSessionId}`) listener(event);
		}));
		const newDraftVisible = derived(reader => {
			const active = view.getSelection(reader).activeSelection;
			if (!conversationVisible.read(reader) || active?.kind !== 'untitled' || active.session.forkSource) return false;
			draftChanged.read(reader);
			try {
				const draft = readNewChatDraftState(storage, `untitled:${active.session.untitledSessionId}`, chatInputStatePersistence);
				return !draft || (!draft.text.trim() && draft.contexts.length === 0);
			} catch { /* The composer owns reporting unreadable drafts. */ }
			return false;
		});
		const cowork = this._register(services.createInstance(CoworkPaneFactory));
		sessionsPart = this.sessionsPart = this._register(
			services.createInstance(SessionsPart, this.domNode, {
				newDraftVisible,
				createComparisonControls: container => services.createInstance(SessionComparisonControls, container),
				createCoworkPane: (container, panelId, selection) =>
					cowork.createPane(container, panelId, selection, () => {
						view.openNewSession();
					}),
				activateSelection: selection => view.activateSelection(selection),
				markVisibleThreadViewed: entry => view.markVisibleThreadViewed(entry),
				closeSelection: selection => {
					if (view.activeSelection !== selection) view.activateSelection(selection);
					void commandService.executeCommand('sessionsViewPane.closeSession')
						.then(() => sessionsPart?.focus(), error => notificationService.error(getErrorMessage(error)));
				},
				createNewSession: () => {
					view.openNewSession();
				},
			} satisfies SessionsPartOptions),
		);
		services.registerInstance(ISessionsConversationService, sessionsPart);
		const part = sessionsPart;
		this._register(autorun(reader => {
			const { visibleSelections, activeSelection } = view.getSelection(reader);
			part.updateVisibleSessions(visibleSelections, activeSelection);
		}));
		const conversationLinks = services.createInstance(SessionConversationLinks, provider.id);
		const focusConversation = (sessionId: string, threadId: string): void => {
			const selected = view.activeSelection;
			if (selected?.kind === 'session' && selected.active.session.sessionId === sessionId && selected.active.threadId === threadId) sessionsPart!.focus();
		};
		services.registerInstance(IChatSessionNavigationService, {
			openToolResult: async (sourceSessionId, target, signal) => {
				const scope = providerScopes.getScope(sourceSessionId);
				const revision = view.navigationRevision;
				const connection = scope.services.host.appServer;
				const generation = connection.connectionGeneration;
				let retired = false;
				const listener = connection.onConnectionState(() => { retired = true; });
				const assertCurrent = (): void => {
					scope.assertCurrent();
					if (signal.aborted || retired || generation !== connection.connectionGeneration || revision !== view.navigationRevision) throw canceled();
				};
				try {
					assertCurrent();
					if (target.type === 'sessionTarget') {
						await scope.services.chat.readThread(target.sessionId, target.threadId);
						assertCurrent();
						await view.openThread(scope.identity(target.sessionId), scope.identity(target.threadId));
						if (!signal.aborted && !layout.isPartVisible('sessions')) await this.showChat();
					} else {
						const store = services.get(ISessionsProvidersService).getProvider(scope.providerId)?.automations;
						if (!store?.getAutomationByBackendId) throw new Error(localize('chat.tool.resultUnavailable', 'This result is unavailable on its originating host.'));
						await store.refresh();
						assertCurrent();
						const existing = store.getAutomationByBackendId(target.automationId);
						if (!existing) throw new Error(localize('chat.tool.resultUnavailable', 'This result is unavailable on its originating host.'));
						await services.get(IAutomationDialogService).showAutomationDialog({ existing });
					}
				} finally { listener.dispose(); }
			},
			createNewConversation: async options => {
				if (!options) { await commandService.executeCommand('sessions.newSession'); return true; }
				// Select the Agent presentation before creating its mode-scoped draft.
				if (options?.focus) await commandService.executeCommand('sessions.open.code');
				const created = await commandService.executeCommand<IUntitledChatSession | undefined>(NEW_SESSION_ACTION_ID, options.providerId);
				if (!created) return false;
				if (options?.agent) sessions.setUntitledSessionAgent(created.untitledSessionId, options.agent);
				if (options?.focus) sessionsPart!.focus();
				return true;
			},
			showConversationHistory: () => commandService.executeCommand(SHOW_SESSIONS_PICKER_COMMAND_ID),
			get revision() { return view.navigationRevision; },
			captureConnection: sessionId => conversationLinks.captureConnection(sessionId),
			prepareConversationLink: (sessionId, threadId) => conversationLinks.prepare(sessionId, threadId),
			openConversationLink: async (address, options) => {
				const { sessionId, threadId } = await conversationLinks.open(address, view, options);
				const selected = view.activeSelection;
				if (selected?.kind !== 'session' || selected.active.session.sessionId !== sessionId || selected.active.threadId !== threadId) return;
				if (!layout.isPartVisible('sessions')) await this.showChat();
				focusConversation(sessionId, threadId);
			},
			getActiveConversation: () => {
				if (!layout.isPartVisible('sessions')) return undefined;
				const selected = view.activeSelection;
				return selected?.kind === 'session' ? { sessionId: selected.active.session.sessionId, threadId: selected.active.threadId } : undefined;
			},
			getConversations: () => sessions.sessions.filter(session => session.status === 'active').flatMap(session => session.chats.filter(chat => chat.status === 'active').map(chat => ({ providerId: session.providerId ?? provider.id, kind: session.kind, sessionId: session.backendSessionId ?? session.sessionId, threadId: session.backendSessionId ? providerScopes.getScope(session.sessionId).backendIdentity(chat.threadId) : chat.threadId, title: chat.title ?? session.title }))),
			getConversationsForReference: () => sessions.sessions.filter(session => session.status === 'active').flatMap(session =>
				session.chats.filter(chat => chat.status === 'active').map(chat => ({
					providerId: session.providerId ?? provider.id,
					providerLabel: session.providerLabel,
					sessionId: session.sessionId,
					threadId: chat.threadId,
					title: chat.title ?? session.title,
				}))),
			appendToActiveDraft: text => {
				void this.showChat().then(() => {
					sessionsPart!.appendToDraft(text);
					sessionsPart!.focus();
				}).catch(error => notificationService.error(String(error)));
			},
			captureActiveDraft: () => layout.isPartVisible('sessions') ? sessionsPart!.captureActiveDraft() : Promise.resolve(undefined),
			openConversation: async (sessionId, threadId, providerId) => {
				if (providerId !== undefined) {
					sessionId = sessionIdentity(providerId, sessionId, provider.id);
					threadId = sessionIdentity(providerId, threadId, provider.id);
				}
				// Visible Code and Cowork panes keep their current composition and draft owner.
				if (!layout.isPartVisible('sessions')) await this.showChat();
				await view.openThread(sessionId, threadId);
				focusConversation(sessionId, threadId);
			},
			openSideConversation: async (sessionId, threadId) => {
				if (!layout.isPartVisible('sessions')) await this.showChat();
				await view.openThread(sessionId, threadId, { sideBySide: true });
				focusConversation(sessionId, threadId);
			},
			startVoiceConversation: () => sessionsPart!.startVoiceConversation(),
		});

		const diffService = services.createInstance(DiffService);
		services.registerInstance(IDiffService, diffService);
		const editorOptions: IEditorPartOptions = {
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
		};
		const editorArea = this._register(services.createInstance(DesktopEditorArea, this.domNode));
		const createToolScope = (tool: DesktopEditorTool): { container: HTMLElement; services: InstantiationService; context: IContextKeyService; } => {
			const container = ownerDocument.createElement('div');
			editorArea.domNode.append(container);
			const context = this._register(contextKeys.createScoped(container));
			context.createKey('sessions.editorTool', tool);
			const scope = this._register(services.createChild());
			scope.registerInstance(IContextKeyService, context);
			return { container, services: scope, context };
		};
		const filesScope = createToolScope('files');
		const filesEditor = this._register(filesScope.services.createInstance(DesktopMainEditorPart, filesScope.container, {
			...editorOptions,
			contextKeyService: filesScope.context,
			modalContainer: this.domNode,
		}));
		filesScope.services.registerInstance(IEditorPart, filesEditor);
		const tools = new Map<Exclude<DesktopEditorTool, 'files'>, DesktopToolEditorPart>();
		for (const tool of ['changes', 'browser', 'terminal', 'chat'] as const) {
			const scope = createToolScope(tool);
			const part = this._register(scope.services.createInstance(DesktopToolEditorPart, scope.container, { ...editorOptions, contextKeyService: scope.context, hideTabs: tool === 'changes' }));
			scope.services.registerInstance(IEditorPart, part);
			tools.set(tool, part);
		}
		const editor = this._register(services.createInstance(DesktopEditorParts, filesEditor, editorArea, tools));
		const documentServices = this._register(services.createChild());
		documentServices.registerInstance(IEditorPart, editor);
		const documentEditors = this._register(new BrowserEditorService(editor));
		documentServices.registerInstance(IEditorService, documentEditors);
		documentServices.registerInstance(IEditorGroupsService, documentEditors);
		if (!services.has(ISessionsLayoutService)) {
			services.registerSingleton(ISessionsLayoutService, () => documentServices.createInstance(SessionsLayoutService));
		}
		const editorParts = editor;
		services.registerInstance(IEditorPartsService, editorParts);
		services.registerInstance(IEditorPart, editorParts);
		this._register(new EditorContextKeyController(contextKeys, editorParts, EditorPanes, languageService));
		const editors = this._register(new BrowserEditorService(editorParts));
		services.registerInstance(IEditorService, editors);
		services.registerSingleton(IDiffEditorCommandsService, () => services.createInstance(SessionsDiffEditorCommandsService));
		services.registerInstance(IEditorGroupsService, editors);
		// The browser host resolves Workbench browsing, which borrows the window's editor services.
		if (!services.has(IBrowserViewWorkbenchService)) {
			services.registerInstance<IBrowserViewWorkbenchService | undefined>(IBrowserViewWorkbenchService, undefined);
		}
		const browsers: IBrowserViewWorkbenchService | undefined = services.get(IBrowserViewWorkbenchService);
		if (options.createBrowserHost) this._register(options.createBrowserHost(services));
		const workbenchPreferences = this._register(services.createInstance(PreferencesService));
		services.registerInstance(IPreferencesService, {
			openSettings: options => preferences.open(options),
			openUserSettings: options => workbenchPreferences.openUserSettings(options),
			openGlobalKeybindingSettings: (textual, options) => workbenchPreferences.openGlobalKeybindingSettings(textual, options),
		});
		this._register(new WorkbenchEditorContextKeysHandler(contextKeys, editors, editors));
		services.registerInstance(IHistoryService, this._register(services.createInstance(HistoryService)));
		this._register(services.createInstance(TextFileEditorTracker, ownerWindow));
		auxiliarybar = this._register(services.createInstance(AuxiliaryBarPart, this.domNode, { id: 'auxiliarybar' }));
		services.registerInstance(ITerminalProcessService, options.api.terminal);
		const panes = this._register(services.createInstance(PaneCompositePartService, new Map<ViewContainerLocation, PaneCompositePart>([
			[ViewContainerLocation.Sidebar, sidebar],
			[ViewContainerLocation.AuxiliaryBar, auxiliarybar],
		])));
		services.registerInstance(IPaneCompositePartService, panes);
		const views = this._register(services.createInstance(ViewsService));
		services.registerInstance(IViewsService, views);
		if (options.api.appServer.isAvailable) services.get(ILanguageServerStatusService);
		// Extension adapters require the completed editor and view service graph.
		installWorkbenchServiceContributions({ container: services, register: value => this._register(value), blockRestorationUntil: operation => serviceContributionReady.push(operation) });
		const customViewPart = this._register(services.createInstance(CustomViewGridPart, this.domNode));
		services.registerInstance(ICustomViewGridPartService, customViewPart);
		const parts = new Map<SessionsPartId, Part>([
			['titlebar', titlebar],
			['sidebar', sidebar],
			['sessions', sessionsPart],
			['editor', editorArea],
			['auxiliarybar', auxiliarybar],
			['customview', customViewPart],
		]);
		layout.createWorkbenchLayout(parts);
		if (browsers) {
			const browserVisible = contextKeys.createKey<boolean>('sessions.browserVisible', false);
			const updateBrowserContext = (): void => browserVisible.set(editors.visibleEditors.some(input => input.resource.scheme === BrowserViewUri.scheme));
			this._register(toDisposable(() => browserVisible.reset()));
			this._register(editor.onDidChangeEditors(updateBrowserContext));
			this._register(CommandsRegistry.register('ash.sessions.toggleBrowser', async () => {
				if (contextKeys.getValue('sessions.desktopCode') !== true) {
					await commandService.executeCommand('sessions.open.code');
				}
				if (!await editor.toggleToolEditors(input => input.resource.scheme === BrowserViewUri.scheme)) {
					const retained = browsers.getKnownBrowserViews().values().next().value;
					if (retained) await editors.openEditor(retained, { pinned: true });
					else await browsers.createBrowserView({ initialUrl: 'about:blank', owner: { type: 'user' } });
				}
				updateBrowserContext();
			}));
			this._register(MenusRegistry.appendMenuItems([Menus.TitleBarRightLayout, MenuId.CommandPalette].map(id => ({
				id, item: {
					command: {
						id: 'ash.sessions.toggleBrowser', title: localize2('sessions.cards.toggleBrowser', 'Toggle browser pane'),
						icon: Lxicon.browserExplore, toggled: ContextKeyExpr.equals('sessions.browserVisible', true),
					},
					when: ContextKeyExpr.and(
						ContextKeyExpr.equals('sessions.toolsAvailable', true),
						id === Menus.TitleBarRightLayout ? ContextKeyExpr.not(IsNewSessionContext.key) : undefined,
					),
					group: 'navigation', order: 4.5
				},
			}))));
		}
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
				const location = configurationService.getValue<SessionsActivityBarLocation>(SessionsConfiguration.activityBarLocation);
				setActivityBarLocation(location);
				layout.layout();
			}
		}));
		// Browser integration resolves editor and view services; install it after the window graph is complete.
		if (options.createAppToolsHost) this._register(options.createAppToolsHost(services));
		this._register(new SessionsModernUIContribution(this.domNode, configurationService));
		this._register(registerLayoutActions(layout, view, contextKeys, editor, workspace));
		this._register(registerAddFileAsContextAction(this.sessionsPart));
		this._register(registerSessionsTerminalContribution(layout, contextKeys, editor));
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
		this.whenRestored = Promise.all([keybindingsReady, extensionReady, ...serviceContributionReady, options.initialWorkspaceReady]).then(async () => {
			if (!this.isDisposed && options.initialWorkspaceReady) workspace.updateWorkspace(options.workspace());
			await this.initialize(view, ownerWindow, entryLayout, contributions, storage, recoveredDrafts, () => {
				// Terminal editors can wait on PTY recovery during layout restore. Publish the
				// selected execution directory first, including when the catalog is still hydrating.
				const selection = view.activeSelection;
				if (selection?.kind === 'session') {
					const { session, threadId } = selection.active;
					if (session.chats.find(chat => chat.threadId === threadId)?.workspace === undefined) {
						workspaceProjectionReady.settleWith(sessions.prepareThread(session.sessionId, threadId));
						return;
					}
				}
				void workspaceProjectionReady.complete();
			});
			if (this.isDisposed) return;
			using suppression = entryLayout.suppressEditorAutoVisibility();
			const previousGroups = new Set(editor.groups.map(group => group.id));
			const previousActive = editor.activeGroup;
			const legacyBrowser = browsers && storage.get('sessions.browser.editorState', StorageScope.WORKSPACE);
			try {
				if (legacyBrowser && !editor.groups.some(group => group.inputs.some(input => input.resource.scheme === BrowserViewUri.scheme))) {
					await editor.applyWorkingSet(JSON.parse(legacyBrowser) as EditorWorkingSet, { preserveFocus: true, preserveGroups: [...previousGroups] });
				}
				if (options.api.appServer.isAvailable) {
					const terminals = services.get(ITerminalService);
					await terminals.whenConnected;
					for (const instance of terminals.instances) {
						if (instance.target === TerminalLocation.Panel) await services.get(ITerminalEditorService).openEditor(instance, { preserveFocus: true });
					}
				}
				await entryLayout.checkpointEditorLayout();
			} catch (error) { notificationService.error(getErrorMessage(error)); }
			if (!contextKeys.getValue('sessions.desktopCode')) {
				for (const group of editor.groups) if (!previousGroups.has(group.id)) editor.setGroupVisible(group.id, false);
			}
			if (editor.groups.includes(previousActive)) editor.activateGroup(previousActive.id);
		});
		void this.whenRestored.catch(error => workspaceProjectionReady.error(error));
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
				this.sessionsView.openNewSession();
			}
		}
		await this.showChat();
		if (options.draft) this.sessionsPart.restoreDraft(options.draft);
	}

	shutdown(reason: ShutdownReason): Promise<void> {
		return this.lifecycleService.shutdown(reason);
	}

	private async initialize(view: SessionsService, ownerWindow: Window, entryLayout: ISessionsLayoutService, contributions: WorkbenchContributionHost, storage: IStorageService, recoveredDrafts: ReturnType<typeof migrateNewChatDraftState>, publishWorkspaceReady: () => void): Promise<void> {
		if (this.isDisposed) return;
		await view.initialize();
		if (this.isDisposed) return;
		if (!view.activeSelection) view.openNewSession(undefined, { source: 'restore' });
		const selected = view.activeSelection!;
		for (const recovered of recoveredDrafts) {
			const session = view.openNewSession(undefined, { sideBySide: true, source: 'restore' });
			writeNewChatDraftState(storage, recovered.draft, `untitled:${session.untitledSessionId}`, chatInputStatePersistence);
			this.sessionsPart.restoreDraft(recovered.draft);
			storage.remove(recovered.key, StorageScope.WORKSPACE);
		}
		view.activateSelection(selected, { source: 'restore' });
		publishWorkspaceReady();
		await entryLayout.restore();
		if (this.isDisposed) return;
		const revision = view.navigationRevision;
		void this.sessionsPart.didActiveCodeHistoryFail().then(failed => {
			// A late history failure must not replace a conversation the user chose meanwhile.
			if (failed && !this.isDisposed && revision === view.navigationRevision) {
				view.openNewSession(undefined, { source: 'restore' });
			}
		}).catch(error => this.logService.error('Failed to restore Code conversation', error));
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
	createWorkbenchLayout(parts: ReadonlyMap<SessionsPartId, Part>): void;
	layout(dimension?: IDimension): void;
	readonly onDidChangePartVisibility: Event<SessionsPartVisibilityChangeEvent>;
	/** Determines which center absorbs window resizing; supporting Parts retain their user widths. */
	setPrimaryPart(partId: 'sessions' | 'editor'): void;
	setCustomViewVisible(visible: boolean): void;
	isPartVisible(partId: SessionsPartId): boolean;
	isPartAvailable(partId: SessionsPartId): boolean;
	isPartRequested(partId: 'sidebar' | 'editor' | 'auxiliarybar'): boolean;
	setPartAvailable(partId: 'sessions' | 'sidebar' | 'auxiliarybar' | 'editor', available: boolean): void;
	updateParts(update: () => void): void;
	showPart(partId: SessionsPartId): void;
	hidePart(partId: SessionsPartId): void;
}

export const IAgentWorkbenchLayoutService = refineServiceDecorator<ILayoutService, IAgentWorkbenchLayoutService>(ILayoutService);

export interface SessionsPartVisibilityChangeEvent {
	readonly partId: SessionsPartId;
	readonly visible: boolean;
}
