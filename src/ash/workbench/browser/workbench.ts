import { ITraceService } from '../services/trace/common/traceService.js';
import { AppServerTraceService } from '../services/trace/browser/appServerTraceService.js';
import { IExecutionSettingsService } from '../../platform/execution/common/executionSettingsService.js';
import { IPromptsService } from '../contrib/chat/common/promptSyntax/service/promptsService.js';
import { PromptsService } from '../contrib/chat/common/promptSyntax/service/promptsServiceImpl.js';
import { IInstructionService } from '../../platform/instructions/common/instructionService.js';
import { IFileSearchService } from '../../platform/search/common/fileSearch.js';
import { BrowserFileSearchService } from '../../platform/search/browser/browserFileSearchService.js';
import { AppServerAvailableContext } from '../common/contextkeys.js';
import { IWorkbenchEnvironmentService } from '../services/environment/common/environmentService.js';
import { localize } from '../../nls.js';
import { Schemas } from '../../base/common/network.js';
import type { IFileSystemProvider } from '../../platform/files/common/files.js';
import { IUserDataProfileService } from '../services/userDataProfile/common/userDataProfile.js';
import { UserDataProfileService } from '../services/userDataProfile/browser/userDataProfileService.js';
import { IKeybindingEditingService, KeybindingsEditingService } from '../services/keybinding/common/keybindingEditing.js';
import type { PaneCompositePart } from './parts/paneCompositePart.js';
import { ITextResourcePropertiesService } from '../../editor/common/services/textResourceConfiguration.js';
import { TextResourcePropertiesService } from '../services/textresourceProperties/common/textResourcePropertiesService.js';
import { IModelService } from '../../editor/common/services/model.js';
import { ModelService } from '../../editor/common/services/modelService.js';
import { IAssetService } from '../../platform/assets/common/assetService.js';
import { INetworkDiagnosticsService } from '../../platform/networkDiagnostics/common/networkDiagnosticsService.js';
import { IModelApi as ModelApiId, IThreadApi, ITurnApi, ISessionApi } from '../../platform/sessions/common/sessionApi.js';
import { ITurnChangesApi } from '../../platform/turnChanges/common/turnChangesApi.js';
import { IAppServerApi as AppServerApiId, IServerEventApi as ServerEventApiId } from '../../platform/agentHost/common/appServerApi.js';
import { ILanguageModelsService, LanguageModelsService } from '../contrib/chat/common/languageModels.js';
import { ILanguageModelsConfigurationService } from '../contrib/chat/common/languageModelsConfiguration.js';
import { ChatModelPreferences, LanguageModelsConfigurationService } from '../contrib/chat/browser/languageModelsConfigurationService.js';
import { IDictationService } from '../../platform/dictation/common/dictationService.js';
import { IHooksService } from '../../platform/hooks/common/hooksService.js';
import { ExtensionColorThemeService } from '../services/extensions/browser/extensionColorThemeService.js';
import { IWorkbenchThemeService } from '../services/themes/common/workbenchThemeService.js';
import { IHostColorSchemeService, type IHostColorSchemeService as HostColorSchemeService } from '../services/themes/common/hostColorSchemeService.js';
import { BrowserHostColorSchemeService } from '../services/themes/browser/browserHostColorSchemeService.js';
import { getActivityHoverPosition } from "./parts/compositeBarActions.js";
import { IAppServerSkillApi } from "../../platform/agentHost/common/appServerApi.js";
import { ILanguageServerService } from "../../platform/language/common/languageServerService.js";
import { ILanguageFeatureDebounceService, LanguageFeatureDebounceService } from '../../editor/common/services/languageFeatureDebounce.js';
import { IInlineCompletionsService, InlineCompletionsService } from '../../editor/browser/services/inlineCompletionsService.js';
import { ICallService } from '../../platform/call/common/callService.js';
import { FormattingConflicts } from '../../editor/contrib/format/browser/format.js';
import { MarkerDecorationsService } from '../../editor/common/services/markerDecorationsService.js';
import { FontMeasurements } from '../../editor/browser/config/fontMeasurements.js';
import { createBareFontInfoFromRawSettings } from '../../editor/common/config/fontInfoFromSettings.js';
import { type IEditorOptions } from '../../editor/common/config/editorOptions.js';
import { IMarkerDecorationsService } from '../../editor/common/services/markerDecorations.js';
import { IApprovalEnvironmentService } from '../../platform/approvalEnvironment/common/approvalEnvironmentService.js';
import { IMemoriesService } from '../../platform/memories/common/memoriesService.js';
import { IMemoryDiagnosticsService } from '../../platform/memory/common/memoryDiagnosticsService.js';
import "./style.js";
import { IAutomationService } from '../../platform/automation/common/automationService.js';
import { disposableWindowTimeout } from "../../base/browser/scheduler.js";
import { getWindow } from '../../base/browser/dom.js';
import { TextFileSaveErrorHandler } from '../contrib/files/browser/editors/textFileSaveErrorHandler.js';
import { mainWindow } from "../../base/browser/window.js";
import { PixelRatio } from '../../base/browser/pixelRatio.js';
import {
	type IDisposable,
	Disposable,
	DisposableStore,
	toDisposable,
} from "../../base/common/lifecycle.js";
import { CancellationError, getErrorMessage, onUnexpectedError, setUnexpectedErrorHandler } from "../../base/common/errors.js";
import { assertDefined } from "../../base/common/types.js";
import { URI } from "../../base/common/uri.js";
import { AccessibilityService } from "../../platform/accessibility/browser/accessibilityService.js";
import { IAccessibilityService } from "../../platform/accessibility/common/accessibility.js";
import { ILogService } from "../../platform/log/common/log.js";
import type { LogService } from "../../platform/log/common/logServiceImpl.js";
import { ILifecycleService, LifecyclePhase, type ShutdownReason } from "../services/lifecycle/common/lifecycle.js";
import { IDebugAdapterProcessService } from "../../platform/debug/common/debugAdapterProcessService.js";
import { ITestExecutionService } from '../../platform/testing/common/testExecutionService.js';
import { IExtensionHostApi } from "../../platform/extensionHost/common/extensionHostApi.js";
import { BrowserExtensionHostApi } from '../../platform/extensionHost/browser/extensionHostApi.js';
import { createBrowserExtensionApi } from '../../platform/extensions/browser/extensionApi.js';
import { IExtensionResourceLoaderService } from '../../platform/extensionResourceLoader/common/extensionResourceLoader.js';
import { ITelemetryService } from '../../platform/telemetry/common/telemetry.js';
import { NullTelemetryService } from '../../platform/telemetry/common/telemetryUtils.js';
import { ISyntaxApi } from "../../platform/syntax/common/syntaxApi.js";
import { IRendererHostService, type IRendererHost } from "../../platform/renderer/common/rendererHost.js";
import { ILocalTranscriptionService } from '../../platform/localTranscription/common/localTranscription.js';
import { NullLocalTranscriptionService } from '../services/localTranscription/browser/localTranscriptionService.js';
import { IAgentCapabilitiesService } from '../../platform/agentCapabilities/common/agentCapabilitiesService.js';
import { ITraceSettingsService } from '../../platform/trace/common/traceSettingsService.js';
import { IBrowserViewService } from '../../platform/browserView/common/browserView.js';
import { IRemoteConnectionApi, IRemoteConnectionService, RemoteConnectionService } from "../../platform/remote/common/remoteConnectionService.js";
import { UnavailableRemoteConnectionApi } from "../../platform/remote/common/remoteConnectionService.js";
import type {
	INativeHostApi,
} from "../../platform/native/common/nativeHost.js";
import { MenuId } from "../../platform/actions/common/actions.js";
import type { IConfigurationApi, IConfigurationSnapshot } from "../../platform/configuration/common/configurationIpc.js";
import { IConfigurationResourceService } from "../../platform/configuration/common/configurationResourceService.js";
import { IConfigurationService } from "../../platform/configuration/common/configuration.js";
import { IStorageService, StorageScope, StorageTarget, WillSaveStateReason } from "../../platform/storage/common/storage.js";
import "../../platform/layout/browser/zIndexRegistry.js";
import { InstantiationService } from "../../platform/instantiation/common/instantiationService.js";
import { type IInstantiationService } from "../../platform/instantiation/common/instantiation.js";
import { getSingletonServiceDescriptors } from '../../platform/instantiation/common/extensions.js';
import { IEmbedderTerminalService, type IEmbedderTerminalOptions } from '../services/terminal/common/embedderTerminalService.js';
import { ServiceCollection } from '../../platform/instantiation/common/serviceCollection.js';
import { NotificationService } from "../services/notification/common/notificationService.js";
import { IAccessibleViewService, AccessibilityVerbositySettingId } from "../../platform/accessibility/browser/accessibleView.js";
import { INotificationsCenter, NotificationsCenter } from "./parts/notifications/notificationsCenter.js";
import { NotificationActionRunner } from "./parts/notifications/notificationsCommands.js";
import { INotificationService } from "../../platform/notification/common/notification.js";
import { BrowserProgressService } from "../../platform/progress/browser/progressService.js";
import { IProgressService } from "../../platform/progress/common/progress.js";
import { StatusbarHeight } from './parts/workbenchPartDimensions.js';
import { MarkerService, IMarkerService } from "../../platform/markers/common/markers.js";
import type { IKeyboardLayoutProvider } from "../../platform/keyboardLayout/common/keyboardLayout.js";
import {
	BrowserDialogHandler,
} from "./parts/dialogs/dialog.js";
import {
	IDialogService,
	IFileDialogService,
	type IDialogHandler,
} from "../../platform/dialogs/common/dialogs.js";
import {
	AppServerFileSystemProvider,
} from "../../platform/agentHost/browser/appServerFileSystemProvider.js";
import { FileService } from "../../platform/files/common/fileService.js";
import { IQuickInputService } from "../../platform/quickinput/common/quickInput.js";
import type { HTMLFileSystemProvider } from '../../platform/files/browser/htmlFileSystemProvider.js';
import { ISystemFileTransferService } from '../../platform/files/common/systemFileTransferService.js';
import {
	IFileService,
} from "../../platform/files/common/files.js";
import { DecorationsService } from "../services/decorations/browser/decorationsService.js";
import { IDecorationsService } from "../services/decorations/common/decorations.js";
import {
	IThemeService,
} from "../../platform/theme/common/themeService.js";
import { type IWorkspace, IWorkspaceContextService, WorkbenchState, workbenchStateFromWorkspace, workspaceOpenTarget } from "../../platform/workspace/common/workspace.js";
import { ActivityBarPosition, WorkbenchConfiguration, type SideBarLocation, type WorkbenchLayoutStyle } from "../common/configuration.js";
import {
	type WorkbenchContributionHost,
	WorkbenchContributionsRegistry,
	WorkbenchPhase,
} from "../common/contributions.js";
import {
	IDialogsModel,
	IWorkbenchDialogHandler,
} from "../common/dialogs.js";
import { INativeHostService } from "../common/services.js";
import { FileDialogService } from '../services/dialogs/electron-browser/fileDialogService.js';
import { FileDialogService as BrowserFileDialogService } from '../services/dialogs/browser/fileDialogService.js';
import { IUserThemeService, type IUserThemeService as IUserThemeServiceContract, UnavailableUserThemeService } from "../common/userThemes.js";
import {
	ViewContainerLocation,
} from "../common/views.js";
import {
	IStatusbarService,
	StatusbarService,
} from "../services/statusbar/browser/statusbar.js";
import {
	WorkspaceContextService,
} from "../services/workspaces/browser/workspaceContextService.js";
import {
	IWorkspaceOpenService,
	WorkspaceOpenService,
	BrowserWorkspaceOpenService,
	WebWorkspaceOpenService,
	type IWebWorkspaceClient,
} from "../services/workspaces/browser/workspaceOpenService.js";
import { RecentWorkspacesService } from "../services/workspaces/browser/recentWorkspacesService.js";
import { IRecentWorkspacesService } from "../services/workspaces/common/recentWorkspacesService.js";
import { IViewDescriptorService } from "../common/views.js";
import { ViewDescriptorService } from "../services/views/browser/viewDescriptorService.js";
import { IViewsService } from "../services/views/common/viewsService.js";
import { ViewsService } from "../services/views/browser/viewsService.js";
import {
	WorkbenchConfigurationService,
} from "../services/configuration/browser/configurationService.js";
import type { DialogService } from "../services/dialogs/common/dialogService.js";
import { WorkbenchContextKeysHandler } from './contextkeys.js';
import { WorkbenchThemeService } from "../services/themes/browser/workbenchThemeService.js";
import { IResourceIconRenderer, IResourceLabelService, ResourceLabelService } from "./labels.js";
import { ILabelService, LabelService } from "../../platform/label/common/labelService.js";
import { WorkbenchLayout, type WorkbenchDefaultLayout } from "./layout.js";
import { IWorkbenchLayoutService, type WorkbenchPartId } from "../services/layout/browser/layoutService.js";
import type { BrowserStorageServiceOptions } from "../services/storage/browser/storageService.js";
import { SystemOutputService } from "../services/output/browser/systemOutputService.js";
import { IContentSearchService, IContentSearchConfigurationService } from "../../platform/search/common/search.js";
import { BrowserContentSearchService, FileContentSearchService } from "../../platform/search/browser/searchService.js";
import type { Part } from "./part.js";
import { AuxiliarybarPart } from "./parts/auxiliarybar/auxiliarybarPart.js";
import { EditorContextKeyController } from './parts/editor/editorContextKeys.js';
import { EditorPart, IEditorPart, type IEditorPartOptions } from "./parts/editor/editorPart.js";
import { BreadcrumbsFilePicker, BreadcrumbsSymbolPicker } from "./parts/editor/breadcrumbsPicker.js";
import { BreadcrumbsService, IBreadcrumbsService } from "./parts/editor/breadcrumbs.js";
import { EditorParts, IEditorPartsService } from "./parts/editor/editorParts.js";
import { HistoryService } from '../services/history/browser/historyService.js';
import { IHistoryService } from '../services/history/common/history.js';
import { EditorPanes } from './editor.js';
import { PanelPart } from "./parts/panel/panelPart.js";
import { SidebarPart } from "./parts/sidebar/sidebarPart.js";
import { ActivitybarPart } from "./parts/activitybar/activitybarPart.js";
import { GlobalCompositeBar } from './parts/globalCompositeBar.js';
import { StatusbarPart } from "./parts/statusbar/statusbarPart.js";
import {
	BrowserTitleService,
	type TitlebarPartFactory,
} from "./parts/titlebar/titlebarPart.js";
import { PaneCompositePartService } from "./parts/paneCompositePartService.js";
import { IPaneCompositePartService } from "../services/panecomposite/browser/panecomposite.js";
import { WorkbenchWindow } from "./window.js";
import { BrowserAuxiliaryWindowService, IAuxiliaryWindowService } from "../services/auxiliaryWindow/browser/auxiliaryWindowService.js";
import { ITerminalProcessService } from "../../platform/terminal/common/terminal.js";
import { ITextFileService } from "../services/textfile/common/textfiles.js";
import { TextFileService } from "../services/textfile/browser/textFileService.js";
import { ITextMateService } from "../services/textMate/common/textMateService.js";
import { BrowserTextMateService } from "../services/textMate/browser/browserTextMateService.js";
import { AppServerExtensionService } from "../services/extensions/browser/appServerExtensionService.js";
import { IExtensionService } from "../services/extensions/common/extensionService.js";
import { AppServerRemoteAgentService } from "../services/remote/browser/appServerRemoteAgentService.js";
import { IAppServerRemoteAgentService } from "../services/remote/common/appServerRemoteAgentService.js";
import { ILanguageFeaturesService } from '../../editor/common/services/languageFeatures.js';
import { DefaultDropProvidersFeature, DefaultPasteProvidersFeature } from '../../editor/contrib/dropOrPasteInto/browser/defaultProviders.js';
import { ICodeEditorService } from '../../editor/browser/services/codeEditorService.js';
import { CodeEditorService } from '../services/editor/browser/codeEditorService.js';
import { LanguageFeaturesService } from '../../editor/common/services/languageFeaturesService.js';
import { ILanguageService } from '../../editor/common/languages/language.js';
import { LanguageService } from '../../editor/common/services/languageService.js';
import { ILanguageConfigurationService } from '../../editor/common/languages/languageConfigurationRegistry.js';
import { WorkbenchLanguageFeatures } from '../services/language/browser/workbenchLanguageFeatures.js';
import { GitService } from "../contrib/git/browser/gitService.js";
import { IGitService } from "../contrib/git/common/gitService.js";
import { ChatService } from "../services/chat/browser/chatService.js";
import { IChatService } from "../services/chat/common/chatService.js";
import { ICodebaseService } from "../../platform/codebase/common/codebaseService.js";
import { AppServerCodebaseService } from "../services/codebase/browser/appServerCodebaseService.js";
import { IToolSearchService } from "../../platform/toolSearch/common/toolSearchService.js";
import { IDirPermissionsService } from "../../platform/dirPermissions/common/dirPermissionsService.js";
import { IKeyboardLayoutService } from "../../platform/keyboardLayout/common/keyboardLayout.js";
import { AppServerDirPermissionsService } from "../services/dirPermissions/browser/appServerDirPermissionsService.js";
import { IWorkspaceTrustManagementService } from '../../platform/workspace/common/workspaceTrust.js';
import { WorkspaceTrustManagementService } from '../services/workspaces/common/workspaceTrust.js';
import { IConnectorService } from "../../platform/connectors/common/connectorService.js";
import { AppServerConnectorService } from "../services/connectors/browser/appServerConnectorService.js";
import { IAccountService } from "../../platform/accounts/common/accountService.js";
import { AppServerAccountService } from "../services/accounts/browser/appServerAccountService.js";
import { IIssueReporterService } from '../../platform/issue/common/issue.js';
import { IGitHubService } from '../../platform/github/common/githubService.js';
import { GitHubConnectionService } from "../services/accounts/browser/gitHubConnectionService.js";
import { IGitHubConnectionService } from "../services/accounts/common/gitHubConnectionService.js";
import { IPluginService } from "../../platform/plugins/common/pluginService.js";
import { AppServerPluginService } from "../services/plugins/browser/appServerPluginService.js";
import { IMarketplaceService } from "../../platform/marketplace/common/marketplaceService.js";
import { AppServerMarketplaceService } from "../services/marketplace/browser/appServerMarketplaceService.js";
import { MarketplaceLanguagePackService } from "../../platform/languagePacks/browser/marketplaceLanguagePackService.js";
import { ILanguagePackService } from "../../platform/languagePacks/common/languagePacksService.js";
import { ILocaleService } from "../services/localization/common/locale.js";
import { WorkbenchLocaleService } from "../services/localization/browser/localeService.js";
import { ILocalizationService } from "../services/localization/common/localizationService.js";
import { WorkbenchLocalizationService } from "../services/localization/browser/workbenchLocalizationService.js";
import { builtinLanguagePackCatalogs } from "../services/localization/common/localizationCatalogs.js";
import { AppServerToolSearchService } from "../services/toolSearch/browser/appServerToolSearchService.js";
import { ICodebaseSymbolsApi } from "../../platform/codebaseSymbols/common/codebaseSymbolsApi.js";
import { AccessibleViewInformationService, IAccessibleViewInformationService } from "../services/accessibility/common/accessibleViewInformationService.js";
import { NativeAccessibilityService } from "../services/accessibility/electron-browser/accessibilityService.js";
import { IUntitledTextEditorService, UntitledTextEditorService } from "../services/untitled/common/untitledTextEditorService.js";
import { UntitledTextEditorInput } from "../services/untitled/common/untitledTextEditorInput.js";
import { BrowserWorkingCopyService } from "../services/workingCopy/browser/browserWorkingCopyService.js";
import { ITitleService } from '../services/title/browser/titleService.js';
import { IWorkingCopyService } from "../services/workingCopy/common/workingCopyService.js";
import { IActivityService } from '../services/activity/common/activity.js';
import { ActivityService } from '../services/activity/browser/activityService.js';
import { WorkingCopyBackupTracker } from "../services/workingCopy/browser/workingCopyBackupTracker.js";
import { IWorkingCopyBackupService, type WorkingCopyBackup } from "../services/workingCopy/common/workingCopyBackupService.js";
import { projectColorThemeTokens } from "../services/textMate/common/textMateThemeProjection.js";
import { IFileTextModelService, ITextModelResourceService } from "../services/textmodelResolver/common/textModelResourceService.js";
import { IDocumentEditorTextModelService } from '../services/documentEditor/common/documentTypes.js';
import { DocumentEditorTextModelService } from '../services/documentEditor/browser/documentEditorTextModelService.js';
import { ITextModelService } from '../../editor/common/services/resolverService.js';
import { TextModelResolverService } from '../services/textmodelResolver/common/textModelResolverService.js';
import { IBulkEditService } from "../../editor/browser/services/bulkEditService.js";
import { getBrowserTextModelService } from "../services/textmodelResolver/browser/browserTextModelService.js";
import { getBrowserTextResourceStore } from "../contrib/codeEditor/browser/browserTextResourceStore.js";
import { AppServerLanguageProviders } from "../services/language/browser/appServerLanguageProviders.js";
import { DiffService } from "../services/diff/browser/diffService.js";
import { IDiffService } from "../services/diff/common/diffService.js";
import { AppServerLanguageDiagnosticsService } from "../services/language/browser/appServerLanguageDiagnosticsService.js";
import { AppServerCodeIntelligenceDocumentService } from "../services/codeIntelligence/browser/appServerCodeIntelligenceDocumentService.js";
import { ICodeIntelligenceDocumentService } from "../services/codeIntelligence/common/codeIntelligenceDocumentService.js";
import { AppServerLanguageServerStatusService } from "../services/language/browser/appServerLanguageServerStatusService.js";
import { ILanguageDiagnosticsService } from "../services/language/common/languageDiagnosticsService.js";
import { LanguageDiagnosticsMarkerBridge } from "../services/language/browser/languageDiagnosticsMarkerBridge.js";
import { IOutputService } from "../services/output/common/output.js";
import { IWorkbenchHostService } from "../services/host/common/workbenchHostService.js";
import { BrowserEditorService } from "../services/editor/browser/browserEditorService.js";
import { IEditorService } from "../services/editor/common/editorService.js";
import { IEditorGroupsService } from '../services/editor/common/editorGroupsService.js';
import { installWorkbenchServiceContributions } from "./workbenchServiceContributions.js";
import { setHoverDelegate } from "../../base/browser/ui/hover/hoverDelegate.js";
import { IMenuService } from "../../platform/actions/common/actions.js";
import { MenuService } from "../../platform/actions/common/menuService.js";
import { ICommandService } from "../../platform/commands/common/commands.js";
import { IContextKeyService, ContextKeyService } from "../../platform/contextkey/browser/contextKeyService.js";
import { IContextMenuService, IContextViewService } from "../../platform/contextview/browser/contextView.js";
import { BrowserContextViewService } from "../../platform/contextview/browser/contextViewService.js";
import { HoverService, IHoverService } from "../../platform/hover/browser/hoverService.js";
import { IKeybindingService } from "../../platform/keybinding/common/keybinding.js";
import { IUserKeyboardLayoutService, UnavailableUserKeyboardLayoutService } from "../../platform/keyboardLayout/common/userKeyboardLayout.js";
import { IQuickAccessController } from "../../platform/quickinput/common/quickAccess.js";
import { QuickAccessController } from "../../platform/quickinput/browser/quickAccess.js";
import { IOpenerService } from "../../platform/opener/common/opener.js";
import { OpenerService } from '../../editor/browser/services/openerService.js';
import { IURLService } from '../../platform/url/common/url.js';
import { CommandService } from "../services/commands/common/commandService.js";
import { BrowserKeyboardLayoutService } from "../services/keybinding/browser/keyboardLayoutService.js";
import { WorkbenchKeybindingService } from "../services/keybinding/browser/keybindingService.js";
import { IKeyboardShortcutTroubleshootingService } from "../services/keybinding/common/keyboardShortcutTroubleshooting.js";
import { IPreferencesService } from "../services/preferences/common/preferences.js";
import { PreferencesService } from "../services/preferences/browser/preferencesService.js";
import { WorkbenchQuickInputService } from "../services/quickinput/browser/quickInputService.js";
import { ChatContextPickService } from "../services/chat/browser/chatContextPickService.js";
import { IChatContextPickService } from "../services/chat/common/chatContextService.js";
import type { IUserKeyboardLayoutApi } from "../../platform/keyboardLayout/common/userKeyboardLayout.js";
import { BrowserClipboardService } from "../../platform/clipboard/browser/clipboardService.js";
import { IClipboardService } from "../../platform/clipboard/common/clipboardService.js";

/** Host-specific inputs required to construct a workbench. */
export interface IStartWorkbenchOptions {
	/** Host-owned services are borrowed by this window's container before consumers are created. */
	readonly serviceCollection?: ServiceCollection;
	readonly productName: string;
	readonly environmentService: IWorkbenchEnvironmentService;
	readonly defaultLayout?: WorkbenchDefaultLayout;
	readonly api: IRendererHost;
	readonly browserFileSystemProvider?: HTMLFileSystemProvider;
	readonly webWorkspaceClient?: IWebWorkspaceClient;
	readonly browserViewService?: IBrowserViewService;
	readonly container: HTMLElement;
	readonly workspace: IWorkspace;
	/** The host selects its implementation; the Workbench supplies initialized window services. */
	readonly createLifecycleService: (services: IInstantiationService) => ILifecycleService & IDisposable;
	readonly createURLService: (services: InstantiationService) => IURLService & IDisposable;
	readonly createTextDocumentHost?: (services: IInstantiationService) => IDisposable;
	readonly createWindow?: (services: IInstantiationService) => IDisposable;
	readonly createStorageService: (options: BrowserStorageServiceOptions) => Promise<IStorageService & IDisposable & { switchWorkspace(workspaceId: string): void | Promise<void>; }>;
	readonly createWorkingCopyBackupService: (services: IInstantiationService, workspaceId: string) => IWorkingCopyBackupService;
	readonly createLogService: () => LogService;
	readonly configurationApi?: IConfigurationApi;
	readonly initialConfigurationSnapshot?: IConfigurationSnapshot;
	readonly createUserDataFileSystemProvider: () => Promise<IFileSystemProvider & IDisposable>;
	readonly keyboardLayoutProvider?: IKeyboardLayoutProvider;
	readonly userKeyboardLayoutApi?: IUserKeyboardLayoutApi;
	readonly nativeHostApi?: INativeHostApi;
	readonly createHostColorSchemeService?: (services: IInstantiationService) => HostColorSchemeService & IDisposable;
	readonly clipboardService?: IClipboardService;
	readonly dialogHandler?: IDialogHandler;
	readonly userThemeService?: IUserThemeServiceContract;
	readonly createContextMenuService: (services: IInstantiationService) => IContextMenuService & IDisposable;
	readonly createTitlebarPart: TitlebarPartFactory;
}

/** Starts the browser workbench and binds its commands to the initial UI. */
export async function startWorkbench({
	serviceCollection,
	productName,
	environmentService,
	defaultLayout,
	api,
	browserFileSystemProvider,
	webWorkspaceClient,
	container,
	workspace,
	createLifecycleService,
	createURLService,
	createWindow,
	createTextDocumentHost,
	createStorageService,
	createWorkingCopyBackupService,
	createLogService,
	configurationApi,
	initialConfigurationSnapshot,
	createUserDataFileSystemProvider,
	keyboardLayoutProvider,
	userKeyboardLayoutApi,
	nativeHostApi,
	createHostColorSchemeService,
	clipboardService,
	dialogHandler,
	userThemeService,
	createContextMenuService,
	createTitlebarPart,
	browserViewService,
}: IStartWorkbenchOptions): Promise<Workbench> {
	const themes = new ExtensionColorThemeService(api.extensions, api.events);
	const logger = createLogService();
	let storage: Awaited<ReturnType<IStartWorkbenchOptions['createStorageService']>> | undefined;
	let userDataFiles: IFileSystemProvider & IDisposable | undefined;
	try {
		await themes.start();
		const ownerWindow = container.ownerDocument.defaultView;
		if (!ownerWindow) { throw new Error('Workbench requires an owner window'); }
		storage = await createStorageService({ ownerWindow, workspaceId: workspace.id });
		userDataFiles = await createUserDataFileSystemProvider();
		return new Workbench(
			productName,
			defaultLayout,
			api,
			container,
			workspace,
			createLifecycleService,
			configurationApi,
			initialConfigurationSnapshot,
			userDataFiles,
			keyboardLayoutProvider,
			userKeyboardLayoutApi,
			nativeHostApi,
			createHostColorSchemeService,
			clipboardService,
			dialogHandler,
			userThemeService,
			createContextMenuService,
			createTitlebarPart,
			browserViewService,
			browserFileSystemProvider,
			webWorkspaceClient,
			themes,
			storage,
			logger,
			createWorkingCopyBackupService,
			createWindow,
			createTextDocumentHost,
			createURLService,
			environmentService,
			serviceCollection,
		);
	} catch (error) {
		userDataFiles?.dispose();
		logger.error('startup', 'Workbench startup failed', error);
		logger.dispose();
		storage?.dispose();
		themes.dispose();
		throw error;
	}
}

/** Owns the renderer workbench, its parts, commands, and runtime layout. */
export class Workbench extends Disposable {
	public readonly window: {
		createTerminal(options: IEmbedderTerminalOptions): Promise<void>;
	};
	/** Resolves after dirty working copies are restored and AfterRestored contributions are active. */
	readonly whenRestored: Promise<void>;
	private readonly workspaceContext: WorkspaceContextService;
	private readonly configurationService: IConfigurationService;
	private readonly storage: IStorageService & { switchWorkspace(workspaceId: string): void | Promise<void>; };
	private readonly editor: IEditorPartsService;
	private readonly untitledTextEditorService: IUntitledTextEditorService;
	private readonly workbenchLayout: WorkbenchLayout;
	private readonly workingCopyBackups: IWorkingCopyBackupService;
	private readonly workingCopyBackupTracker: WorkingCopyBackupTracker;
	private readonly workbenchWindow: WorkbenchWindow;
	private readonly logService: ILogService;
	private readonly lifecycleService: ILifecycleService;
	private readonly contributions: WorkbenchContributionHost;
	private readonly ownerWindow: Window;
	private restoreActiveViewContainers: (() => Promise<void>) | undefined;
	private workspaceSwitchQueue: Promise<void> = Promise.resolve();
	private previousUnexpectedError: { message: string | undefined; time: number; } = { message: undefined, time: 0 };

	constructor(
		productName: string,
		defaultLayout: WorkbenchDefaultLayout | undefined,
		api: IRendererHost,
		workbenchRoot: HTMLElement,
		workspace: IWorkspace,
		createLifecycleService: (services: IInstantiationService) => ILifecycleService & IDisposable,
		configurationApi: IConfigurationApi | undefined,
		initialConfigurationSnapshot: IConfigurationSnapshot | undefined,
		userDataFileSystemProvider: IFileSystemProvider & IDisposable,
		keyboardLayoutProvider: IKeyboardLayoutProvider | undefined,
		userKeyboardLayoutApi: IUserKeyboardLayoutApi | undefined,
		nativeHostApi: INativeHostApi | undefined,
		createHostColorSchemeService: ((services: IInstantiationService) => HostColorSchemeService & IDisposable) | undefined,
		clipboardService: IClipboardService | undefined,
		dialogHandler: IDialogHandler | undefined,
		userThemeService: IUserThemeServiceContract | undefined,
		createContextMenuService: (services: IInstantiationService) => IContextMenuService & IDisposable,
		createTitlebarPart: TitlebarPartFactory,
		browserViewService: IBrowserViewService | undefined,
		browserFileSystemProvider: HTMLFileSystemProvider | undefined,
		webWorkspaceClient: IWebWorkspaceClient | undefined,
		themes: ExtensionColorThemeService,
		storageService: IStorageService & IDisposable & { switchWorkspace(workspaceId: string): void | Promise<void>; },
		logger: LogService,
		createWorkingCopyBackupService: IStartWorkbenchOptions['createWorkingCopyBackupService'],
		createWindow: ((services: IInstantiationService) => IDisposable) | undefined,
		createTextDocumentHost: ((services: IInstantiationService) => IDisposable) | undefined,
		createURLService: IStartWorkbenchOptions['createURLService'],
		environmentService: IWorkbenchEnvironmentService,
		serviceCollection = new ServiceCollection(),
	) {
		super();
		performance.mark('ash.workbench.constructor-start');
		this._register(themes);
		this._register(FormattingConflicts.setFormatterSelector(async formatters => formatters[0]));
		for (const [id, descriptor] of getSingletonServiceDescriptors()) {
			if (!serviceCollection.has(id)) { serviceCollection.set(id, descriptor); }
		}
		const services = this._register(new InstantiationService(serviceCollection));
		services.registerInstance(IWorkbenchEnvironmentService, environmentService);
		const embedderTerminals = services.get(IEmbedderTerminalService);
		this.window = {
			createTerminal: async options => {
				this.assertNotDisposed();
				embedderTerminals.createTerminal(options);
			},
		};
		// Editor contributions can resolve data-channel enablement while Parts are being constructed.
		const contextKeys = this._register(new ContextKeyService());
		services.registerInstance(IContextKeyService, contextKeys);
		if (browserViewService) { services.registerInstance(IBrowserViewService, browserViewService); }
		const instantiationService = services;
		const logService = this._register(logger);
		this.logService = logService;
		this.registerErrorHandler(logService);
		services.registerInstance(ILogService, logService);
		services.registerInstance(IRendererHostService, api);
		services.registerInstance(IExtensionResourceLoaderService, api.extensions.resources);
		const workspaceContext = this._register(new WorkspaceContextService(workspace));
		this.workspaceContext = workspaceContext;
		services.registerInstance(IWorkspaceContextService, workspaceContext);
		AppServerAvailableContext.bindTo(contextKeys).set(api.hasAppServer);
		services.registerInstance(IDictationService, api.dictation);
		services.registerInstance(ILocalTranscriptionService, api.localTranscription ?? this._register(new NullLocalTranscriptionService()));
		services.registerInstance(IAgentCapabilitiesService, api.agentCapabilities);
		services.registerInstance(ITraceSettingsService, api.traceSettings);
		services.registerInstance(IExecutionSettingsService, api.executionSettings);
		services.registerInstance(INetworkDiagnosticsService, api.networkDiagnostics);
		services.registerInstance(IContentSearchConfigurationService, api.contentSearchConfiguration);
		services.registerInstance(IHooksService, api.hooks);
		const commandService = this._register(new CommandService(services));
		services.registerInstance(ICommandService, commandService);
		// Browser packages always execute in Workers; server executable packages keep their process host.
		services.registerInstance(IExtensionHostApi, this._register(services.createInstance(BrowserExtensionHostApi, createBrowserExtensionApi(), api.extensionHost)));
		services.registerInstance(ITelemetryService, NullTelemetryService);
		services.registerInstance(ICodebaseSymbolsApi, api.codebaseSymbols);
		services.registerInstance(ISyntaxApi, api.syntax);
		services.registerInstance(IDebugAdapterProcessService, api.debugAdapter);
		services.registerInstance(IAssetService, api.assets);
		services.registerInstance(ITestExecutionService, api.testing);
		if (api.approvalEnvironment) { services.registerInstance(IApprovalEnvironmentService, api.approvalEnvironment); }
		if (api.memories) { services.registerInstance(IMemoriesService, api.memories); }
		if (api.memoryDiagnostics) { services.registerInstance(IMemoryDiagnosticsService, api.memoryDiagnostics); }
		if (api.calls) { services.registerInstance(ICallService, api.calls); }
		if (api.automation) {
			services.registerInstance(IAutomationService, api.automation);
		}
		services.registerInstance(AppServerApiId, api.appServer);
		const remoteAgentService = this._register(services.createInstance(AppServerRemoteAgentService, { remoteApi: api.remote }));
		services.registerInstance(IAppServerRemoteAgentService, remoteAgentService);
		services.registerInstance(IRemoteConnectionApi, api.remoteConnections ?? UnavailableRemoteConnectionApi);
		services.registerSingleton(IRemoteConnectionService, () => services.createInstance(RemoteConnectionService));
		const dialogService = services.get(IDialogService) as DialogService;
		services.registerInstance(IDialogsModel, dialogService.model);
		if (nativeHostApi) {
			services.registerInstance(INativeHostService, nativeHostApi);
			services.registerSingleton(IFileDialogService, () => services.createInstance(FileDialogService));
		}
		if (browserFileSystemProvider) this._register(browserFileSystemProvider);
		if (browserFileSystemProvider) {
			services.registerInstance(IFileDialogService, services.createInstance(BrowserFileDialogService, {
				kind: 'local',
				provider: browserFileSystemProvider,
				pickDirectory: (startIn: FileSystemDirectoryHandle | undefined) => (window as unknown as { showDirectoryPicker: (options?: { startIn?: FileSystemDirectoryHandle; }) => Promise<FileSystemDirectoryHandle>; }).showDirectoryPicker(startIn ? { startIn } : undefined),
				quickInput: () => services.get(IQuickInputService),
				fileService: () => services.get(IFileService),
				workspaceRoot: () => services.get(IWorkspaceContextService).getWorkspace().folders[0]?.uri,
			}, () => services.get(IDialogService)));
		} else if (webWorkspaceClient) {
			services.registerInstance(IFileDialogService, services.createInstance(BrowserFileDialogService, {
				kind: 'server',
				client: webWorkspaceClient,
				quickInput: () => services.get(IQuickInputService),
				fileService: () => services.get(IFileService),
				workspaceRoot: () => services.get(IWorkspaceContextService).getWorkspace().folders[0]?.uri,
			}, () => services.get(IDialogService)));
		}
		const workspaceOpenService = browserFileSystemProvider
			? new BrowserWorkspaceOpenService(
				browserFileSystemProvider,
				workspace => this.updateWorkspace(workspace),
				services.get(IFileDialogService),
			)
			: webWorkspaceClient
				? services.createInstance(WebWorkspaceOpenService,
					webWorkspaceClient,
					() => services.get(IDialogService),
					async () => {
						await this.workingCopyBackupTracker.flush();
						if (!await this.editor.closeAllEditors({ reason: 'reset' })) return false;
						await this.workingCopyBackupTracker.flush();
						await this.storage.flush(WillSaveStateReason.WORKSPACE_CHANGE);
						return true;
					},
				)
				: new WorkspaceOpenService(nativeHostApi, services.getOptional(IFileDialogService), () => services.get(IDialogService));
		services.registerInstance(IWorkspaceOpenService, workspaceOpenService);
		const labelService = this._register(services.createInstance(LabelService));
		services.registerInstance(ILabelService, labelService);
		services.registerInstance(IDecorationsService, this._register(services.createInstance(DecorationsService, workbenchRoot.ownerDocument)));
		const dirPermissionsService = this._register(new AppServerDirPermissionsService(api.dirPermissions, api.events));
		services.registerInstance(IDirPermissionsService, dirPermissionsService);
		const workspaceTrustService = this._register(services.createInstance(WorkspaceTrustManagementService));
		services.registerInstance(IWorkspaceTrustManagementService, workspaceTrustService);
		const workspaceFileService = new AppServerFileSystemProvider({
			api: api.fs,
			resourceApi: api.resource,
			workspaceContextService: workspaceContext,
			onDidChange: listener => {
				const subscription = api.events.subscribe(event => {
					if (event.method === "fs/changed") listener(event.params);
				});
				return {
					dispose: () => subscription.dispose(),
					[Symbol.dispose]: () => subscription.dispose(),
				};
			},
		});
		this._register(workspaceFileService);
		const fileService = this._register(services.createInstance(FileService));
		this._register(userDataFileSystemProvider);
		this._register(fileService.registerProvider(Schemas.vscodeUserData, userDataFileSystemProvider));
		services.registerInstance(IUserDataProfileService, new UserDataProfileService());
		this._register(fileService.registerProvider(Schemas.file, browserFileSystemProvider ?? workspaceFileService));
		this._register(fileService.registerProvider(Schemas.ashRemote, workspaceFileService));
		services.registerInstance(IFileService, fileService);
		services.registerInstance(ISystemFileTransferService, workspaceFileService);
		const configuration = this._register(new WorkbenchConfigurationService({
			api: configurationApi,
			initialSnapshot: initialConfigurationSnapshot,
		}));
		this.configurationService = configuration;
		services.registerInstance(IConfigurationService, configuration);
		services.registerInstance(IConfigurationResourceService, configuration);
		const textFileService = this._register(services.createInstance(TextFileService));
		services.registerInstance(ITextFileService, textFileService);
		const workingCopyService = this._register(services.createInstance(BrowserWorkingCopyService));
		services.registerInstance(IWorkingCopyService, workingCopyService);
		const documentTextModelService = this._register(services.createInstance(DocumentEditorTextModelService));
		services.registerInstance(IDocumentEditorTextModelService, documentTextModelService);
		const untitledTextEditorService = this._register(services.createInstance(UntitledTextEditorService));
		this.untitledTextEditorService = untitledTextEditorService;
		services.registerInstance(IUntitledTextEditorService, untitledTextEditorService);
		const workingCopyBackups = this._register(createWorkingCopyBackupService(services, workspace.id));
		this.workingCopyBackups = workingCopyBackups;
		services.registerInstance(IWorkingCopyBackupService, workingCopyBackups);
		const languageService = this._register(new LanguageService());
		services.registerInstance(ILanguageService, languageService);
		const languageConfigurationService = services.get(ILanguageConfigurationService);
		const languageFeaturesService = this._register(new LanguageFeaturesService());
		services.registerInstance(ILanguageFeaturesService, languageFeaturesService);
		services.registerSingleton(ITextResourcePropertiesService, () => services.createInstance(TextResourcePropertiesService));
		services.registerSingleton(IModelService, () => new ModelService(configuration, services.get(ITextResourcePropertiesService), languageService, languageFeaturesService, languageConfigurationService));
		this._register(new DefaultPasteProvidersFeature(languageFeaturesService, workspaceContext));
		this._register(new DefaultDropProvidersFeature(languageFeaturesService, workspaceContext));
		services.registerSingleton(ICodeEditorService, () => services.createInstance(CodeEditorService));
		services.registerSingleton(IInlineCompletionsService, () => services.createInstance(InlineCompletionsService));
		services.registerSingleton(ILanguageFeatureDebounceService, () => services.createInstance(LanguageFeatureDebounceService));
		const textMateService = this._register(new BrowserTextMateService());
		services.registerInstance(ITextMateService, textMateService);
		const textResourceStore = getBrowserTextResourceStore(textFileService);
		const textModelService = this._register(getBrowserTextModelService(textResourceStore, services, {
			languageService,
			languageConfigurationService,
			languageFeaturesService,
			syntaxService: { workerFactory: textMateService.syntaxWorkerFactory },
			onDidChangeLanguageSupport: textMateService.onDidChange,
		}));
		services.registerInstance(ITextModelResourceService, textModelService);
		services.registerInstance(IFileTextModelService, textModelService);
		services.registerSingleton(IKeybindingEditingService, () => services.createInstance(KeybindingsEditingService));
		services.registerSingleton(ITextModelService, () => services.createInstance(TextModelResolverService));
		const bulkEditService = services.get(IBulkEditService);
		this._register(services.createInstance(WorkbenchLanguageFeatures));
		// Only the desktop host may inspect directory grants. Web language requests
		// are authorized by the server for the authenticated workspace.
		const languageDirPermissions = nativeHostApi ? dirPermissionsService : undefined;
		if (api.hasAppServer) { this._register(new AppServerLanguageProviders(languageFeaturesService, api.language, workspaceContext, { dirPermissions: languageDirPermissions, events: api.events })); }
		const diffService = new DiffService();
		services.registerInstance(IDiffService, diffService);
		const codeIntelligenceDocuments = new AppServerCodeIntelligenceDocumentService(api.codebaseSymbols);
		services.registerInstance(ICodeIntelligenceDocumentService, codeIntelligenceDocuments);
		const languageDiagnosticsService = this._register(new AppServerLanguageDiagnosticsService(api.language, api.events, workspaceContext, codeIntelligenceDocuments, languageDirPermissions));
		services.registerInstance(ILanguageDiagnosticsService, languageDiagnosticsService);
		const markerService = this._register(new MarkerService());
		services.registerInstance(IMarkerService, markerService);
		services.registerSingleton(IMarkerDecorationsService, () => services.createInstance(MarkerDecorationsService));
		this._register(new LanguageDiagnosticsMarkerBridge(languageDiagnosticsService, markerService));
		const extensionService = this._register(new AppServerExtensionService({ api: api.extensions, eventApi: api.events, textMateService, languageService, languageConfigurationService, languageFeaturesService }));
		services.registerInstance(IExtensionService, extensionService);
		const extensionReady = extensionService.start();
		void extensionReady.catch(error => logService.error("extensions", "Declarative extension activation failed", error));
		services.registerInstance(IFileSearchService, api.hasAppServer ? api.fileSearch : services.createInstance(BrowserFileSearchService));
		services.registerInstance(
			IContentSearchService,
			api.hasAppServer ? new BrowserContentSearchService(api.contentSearch, workspaceContext) : new FileContentSearchService(fileService, workspaceContext),
		);
		services.registerInstance(ITerminalProcessService, api.terminal);
		const gitService = this._register(services.createInstance(GitService, { api: api.git, appServerApi: api.appServer, eventApi: api.events, workspaceContext, canCloneRepository: nativeHostApi !== undefined }));
		services.registerInstance(IGitService, gitService);
		services.registerInstance(ICodebaseService, new AppServerCodebaseService(api.codebase));
		services.registerInstance(IConnectorService, this._register(new AppServerConnectorService(api.connectors, api.events)));
		services.registerInstance(IAccountService, this._register(new AppServerAccountService(api.accounts, api.events)));
		services.registerInstance(IIssueReporterService, api.issueReporter);
		services.registerInstance(IGitHubService, api.github);
		services.registerInstance(IPluginService, this._register(new AppServerPluginService(api.plugins, api.events)));
		const marketplaceService = this._register(new AppServerMarketplaceService(api.marketplace, api.events));
		services.registerInstance(IMarketplaceService, marketplaceService);
		services.registerInstance(IAppServerSkillApi, api.skills);
		services.registerSingleton(IPromptsService, () => services.createInstance(PromptsService));
		services.registerInstance(IInstructionService, api.instructions);
		services.registerInstance(ILanguageServerService, api.languageServers);
		services.registerInstance(IToolSearchService, new AppServerToolSearchService(api.toolSearch));
		const workbenchState = workspaceContext.getWorkbenchState();
		const workbenchWindow = this._register(new WorkbenchWindow({
			root: workbenchRoot,
			workbenchState,
		}));
		services.registerInstance(IWorkbenchHostService, workbenchWindow);
		const ownerDocument = workbenchWindow.ownerDocument;

		const languagePackService = this._register(services.createInstance(MarketplaceLanguagePackService, builtinLanguagePackCatalogs));
		services.registerInstance(ILanguagePackService, languagePackService);
		const localizationService = this._register(new WorkbenchLocalizationService());
		services.registerInstance(ILocalizationService, localizationService);
		const ownerWindow = ownerDocument.defaultView;
		if (!ownerWindow) {
			throw new Error("Workbench requires an owner window");
		}
		this.ownerWindow = ownerWindow;
		const feedbackHost = ownerDocument.createElement('div');
		feedbackHost.className = 'ash-feedback-host';
		feedbackHost.style.setProperty('--ash-feedback-statusbar-height', `${StatusbarHeight}px`);
		workbenchRoot.append(feedbackHost);
		this._register(toDisposable(() => feedbackHost.remove()));
		const notificationService = this._register(new NotificationService());
		services.registerInstance(INotificationService, notificationService);
		const progressService = this._register(new BrowserProgressService(feedbackHost));
		services.registerInstance(IProgressService, progressService);
		services.registerInstance(IClipboardService, clipboardService ?? new BrowserClipboardService(ownerWindow.navigator.clipboard));
		const workingCopyBackupTracker = this._register(new WorkingCopyBackupTracker(workingCopyService, workingCopyBackups, ownerWindow, undefined, resource => textModelService.hasPendingSaveRecovery(resource)));
		this.workingCopyBackupTracker = workingCopyBackupTracker;
		this._register(textModelService.addSaveCompletionParticipant({ prepare: (model, signal, recovery) => workingCopyBackupTracker.prepareSave(model, signal, recovery) }));
		if (!nativeHostApi) {
			const onBeforeUnload = (event: BeforeUnloadEvent) => {
				if (!textModelService.hasPendingSaveRecovery()) return;
				event.preventDefault();
				event.returnValue = '';
			};
			ownerWindow.addEventListener('beforeunload', onBeforeUnload);
			this._register(toDisposable(() => ownerWindow.removeEventListener('beforeunload', onBeforeUnload)));
		}
		const storage = this._register(storageService);
		this.workbenchWindow = workbenchWindow;
		this.storage = storage;
		services.registerInstance(IStorageService, storage);
		const lifecycleService = this.lifecycleService = this._register(createLifecycleService(services));
		services.registerInstance(ILifecycleService, lifecycleService);
		services.registerInstance(ILocaleService, this._register(services.createInstance(WorkbenchLocaleService)));
		const layoutService = this._register(services.createInstance(WorkbenchLayout, workbenchRoot, {
			workbenchState,
			defaultLayout,
			focus: () => this.editor.focus(),
		}));
		this.workbenchLayout = layoutService;
		services.registerInstance(IWorkbenchLayoutService, layoutService);
		services.registerInstance(ModelApiId, api.model);
		services.registerInstance(ISessionApi, api.session);
		services.registerInstance(IThreadApi, api.thread);
		services.registerSingleton(ITraceService, () => services.createInstance(AppServerTraceService));
		services.registerInstance(ITurnApi, api.turn);
		services.registerInstance(ITurnChangesApi, api.turnChanges);
		services.registerInstance(ServerEventApiId, api.events);
		const chatService = this._register(services.createInstance(ChatService));
		services.registerInstance(IChatService, chatService);
		services.registerInstance(ILanguageModelsConfigurationService, this._register(services.createInstance(LanguageModelsConfigurationService, ChatModelPreferences)));
		services.registerInstance(ILanguageModelsService, this._register(services.createInstance(LanguageModelsService)));
		const savedFontInfo = storage.get('editorFontInfo', StorageScope.APPLICATION);
		if (savedFontInfo !== undefined) {
			try {
				const entries: unknown = JSON.parse(savedFontInfo);
				if (!Array.isArray(entries)) throw new TypeError('Saved editor font information must be an array');
				FontMeasurements.restoreFontInfo(ownerWindow, entries);
			} catch (error) {
				storage.remove('editorFontInfo', StorageScope.APPLICATION);
				logService.warn('editor', 'Discarded invalid saved font information', error);
			}
		}
		FontMeasurements.readFontInfo(ownerWindow, createBareFontInfoFromRawSettings(
			configuration.getValue<IEditorOptions>('editor'), PixelRatio.getInstance(ownerWindow).value,
		));
		const saveFontInfo = (): void => {
			const entries = FontMeasurements.serializeFontInfo(ownerWindow);
			if (entries !== undefined) {
				storage.store('editorFontInfo', JSON.stringify(entries), StorageScope.APPLICATION, StorageTarget.MACHINE);
			}
		};
		this._register(storage.onWillSaveState(() => {
			if (!lifecycleService.willShutdown) saveFontInfo();
		}));
		this._register(toDisposable(() => {
			if (!lifecycleService.willShutdown) saveFontInfo();
		}));
		const recentWorkspaces = this._register(services.createInstance(RecentWorkspacesService));
		services.registerInstance(IRecentWorkspacesService, recentWorkspaces);
		this._register(lifecycleService.onBeforeShutdown(event => {
			// Page teardown clears font caches before async shutdown joins complete.
			saveFontInfo();
			event.veto(textModelService.waitForSaveRecovery().then(() => false), 'text save recovery');
			if (event.reason === 'load') event.veto(editorParts.confirmCloseAllEditors().then(confirmed => !confirmed), 'workspace editor changes');
			event.veto(workingCopyBackupTracker.flush().then(() => false), 'working-copy backup flush');
		}));
		this._register(lifecycleService.onBeforeShutdownError(event => {
			// pagehide forcibly disposes even before final joins; keep the previous valid backup through editor teardown.
			if (event.reason === 'pageHide') workingCopyBackupTracker.completeShutdown();
		}));
		this._register(lifecycleService.onWillShutdown(event => {
			event.join(storage.flush(WillSaveStateReason.SHUTDOWN), "Workbench storage flush");
			event.join(() => workingCopyBackupTracker.shutdown(), "Working-copy backup drain", () => workingCopyBackupTracker.isShutdownCurrent);
		}));
		this._register(lifecycleService.onDidShutdown(() => workingCopyBackupTracker.completeShutdown()));
		this._register(lifecycleService.onDidShutdownError(reason => {
			// pagehide hosts dispose even on failure; resuming there would race a closing database.
			if (reason !== 'pageHide') workingCopyBackupTracker.cancelShutdown();
		}));
		const outputService = services.get(IOutputService);
		const systemOutputService = this._register(new SystemOutputService(outputService, api.appServer));
		this._register(logService.registerSink(systemOutputService));
		const serviceContributionReady: Promise<void>[] = [];
		services.registerInstance(IAccessibleViewInformationService, this._register(new AccessibleViewInformationService(storage)));
		if (nativeHostApi && !createHostColorSchemeService) { throw new Error('Desktop Workbench requires its system appearance service'); }
		const hostColors = this._register(createHostColorSchemeService ? createHostColorSchemeService(services) : new BrowserHostColorSchemeService(this.ownerWindow));
		services.registerInstance(IHostColorSchemeService, hostColors);
		const themeService = this._register(services.createInstance(WorkbenchThemeService, workbenchRoot));
		services.registerInstance(IThemeService, themeService);
		services.registerInstance(IWorkbenchThemeService, themeService);
		themeService.initialize();
		let textMateThemeRevision = 0;
		const updateTextMateTheme = (): void => {
			const model = textMateService.mutableScopeTheme;
			if (!model) return;
			const activeTheme = themeService.getColorTheme();
			try { model.replace(projectColorThemeTokens(activeTheme, ++textMateThemeRevision)); }
			catch (error) { logService.error("theme", "Failed to apply extension token theme", error); }
		};
		this._register(themeService.onDidColorThemeChange(() => updateTextMateTheme()));
		updateTextMateTheme();
		services.registerInstance(IUserThemeService, userThemeService ?? UnavailableUserThemeService);
		services.registerInstance(IResourceIconRenderer, themeService);
		services.registerInstance(IResourceLabelService, services.createInstance(ResourceLabelService));
		const statusbarService = this._register(new StatusbarService());
		services.registerInstance(IStatusbarService, statusbarService);
		this._register(new AppServerLanguageServerStatusService(api.events, dialogService, outputService, statusbarService, workspaceContext));
		services.registerInstance(
			IWorkbenchDialogHandler,
			dialogHandler ?? new BrowserDialogHandler(workbenchRoot),
		);
		services.registerSingleton(IOpenerService, () => {
			const openerService = services.createInstance(OpenerService);
			if (nativeHostApi) {
				openerService.setDefaultExternalOpener({ openExternal: href => nativeHostApi.openExternal(href) });
			}
			return openerService;
		});
		services.registerSingleton(IURLService, () => createURLService(services));
		const userKeyboardLayoutService = userKeyboardLayoutApi ?? UnavailableUserKeyboardLayoutService;
		services.registerInstance(IUserKeyboardLayoutService, userKeyboardLayoutService);
		const notificationActionRunner = this._register(services.createInstance(NotificationActionRunner));
		const keyboardLayoutService = this._register(new BrowserKeyboardLayoutService({
			navigator: ownerWindow.navigator,
			configurationService: configuration,
			layoutProvider: keyboardLayoutProvider,
			userLayoutProvider: userKeyboardLayoutService,
		}));
		services.registerInstance(IKeyboardLayoutService, keyboardLayoutService);
		const keybindings = this._register(services.createInstance(WorkbenchKeybindingService, {
			ownerDocument: workbenchRoot.ownerDocument,
			commandService,
			contextKeyService: contextKeys,
			keyboardLayoutService,
			statusbarService,
		}));
		services.registerInstance(IKeybindingService, keybindings);
		const keybindingsReady = keybindings.initialize().catch(error => { notificationService.warning(localize({ bundle: 'ash', key: 'keybindings.invalid' }, 'Could not load keybindings.json: {0}', getErrorMessage(error))); });
		services.registerInstance(IKeyboardShortcutTroubleshootingService, keybindings);
		const menus = new MenuService(commandService, contextKeys);
		services.registerInstance(IMenuService, menus);
		const contextViews = this._register(new BrowserContextViewService(layoutService.activeContainer, layoutService));
		services.registerInstance(IContextViewService, contextViews);
		const quickInputService = this._register(new WorkbenchQuickInputService({
			container: layoutService.activeContainer,
			contextKeyService: contextKeys,
			layoutService,
		}));
		services.registerInstance(IQuickInputService, quickInputService);
		// Extension callbacks can open Quick Pick; install their bridge after its UI service exists.
		installWorkbenchServiceContributions({ container: services, register: value => this._register(value), blockRestorationUntil: operation => serviceContributionReady.push(operation) });
		services.registerInstance(IQuickAccessController, this._register(services.createInstance(QuickAccessController)));
		services.registerInstance(IChatContextPickService, new ChatContextPickService());
		services.registerSingleton(IPreferencesService, () => services.createInstance(PreferencesService));
		const contextMenus = this._register(createContextMenuService(services));
		services.registerInstance(IContextMenuService, contextMenus);
		const notificationsCenter = this._register(services.createInstance(NotificationsCenter, workbenchRoot, feedbackHost, notificationActionRunner, statusbarService, () => services.get(IAccessibleViewService).getOpenAriaHint(AccessibilityVerbositySettingId.Notifications)));
		services.registerInstance(INotificationsCenter, notificationsCenter);
		const hoverService = this._register(new HoverService(configuration, contextViews, contextMenus));
		services.registerInstance(IHoverService, hoverService);
		this._register(setHoverDelegate(hoverService));
		void configuration.reloadConfiguration().catch((error: unknown) => console.error("Failed to initialize configuration", error));
		const accessibilityService = this._register(nativeHostApi
			? services.createInstance(NativeAccessibilityService, workbenchRoot)
			: new AccessibilityService({
				root: workbenchRoot,
				contextKeyService: contextKeys,
				configurationService: configuration,
			}));
		services.registerInstance(IAccessibilityService, accessibilityService);
		// Document hosts resolve Chat editing, whose signals use the window accessibility policy.
		if (createTextDocumentHost) { this._register(createTextDocumentHost(services)); }
		services.registerInstance(IGitHubConnectionService, this._register(services.createInstance(GitHubConnectionService)));
		const viewDescriptors = this._register(services.createInstance(ViewDescriptorService, {}));
		services.registerInstance(IViewDescriptorService, viewDescriptors);
		const contributions = this._register(
			WorkbenchContributionsRegistry.createHost(services),
		);
		this.contributions = contributions;
		performance.mark('ash.workbench.services-ready');
		contributions.advance(WorkbenchPhase.BlockStartup);

		const sidebar = this._register(services.createInstance(SidebarPart, workbenchRoot, {
			openComposite: (id: string, preserveFocus?: boolean) => services.invokeFunction(accessor => {
				const panes = accessor.get(IPaneCompositePartService);
				if (panes.getActivePaneComposite(ViewContainerLocation.Sidebar)?.getId() === id) {
					panes.hideActivePaneComposite(ViewContainerLocation.Sidebar);
					return Promise.resolve(null);
				}
				return accessor.get(IViewsService).openViewContainer(id, !preserveFocus);
			}),
			activityHoverOptions: {
				// Read at display time so a pending hover follows the current host placement.
				position: () => getActivityHoverPosition(
					configuration.getValue<ActivityBarPosition>(WorkbenchConfiguration.activityBarLocation),
					configuration.getValue<SideBarLocation>(WorkbenchConfiguration.sideBarLocation),
				),
			},
			viewDescriptorService: viewDescriptors,
			compositeBarContextMenuProvider: contextMenus,
			contextKeyService: contextKeys,
			localizationService,
			ariaLabelKey: { bundle: "ash.regions", key: "primarySidebar" },
			viewsAriaLabelKey: { bundle: "ash.regions", key: "primarySidebarViews" },
			titleActions: {
				menuService: menus,
				contextMenuProvider: contextMenus,
				menuId: MenuId.SidebarTitle,
				primaryGroup: 'navigation',
			},
		}));
		const globalCompositeBar = this._register(services.createInstance(GlobalCompositeBar, workbenchRoot));
		const activitybar = this._register(services.createInstance(ActivitybarPart, workbenchRoot, sidebar.compositeBar, globalCompositeBar));
		const initialActivityBarLocation = configuration.getValue<ActivityBarPosition>(WorkbenchConfiguration.activityBarLocation);
		sidebar.setActivityBarLocation(initialActivityBarLocation);
		sidebar.domNode.classList.toggle('sidebar-right', configuration.getValue(WorkbenchConfiguration.sideBarLocation) === 'right');
		const activityService = this._register(new ActivityService(sidebar.compositeBar));
		services.registerInstance(IActivityService, activityService);
		const agentSidebar = this._register(services.createInstance(SidebarPart, workbenchRoot, {
			openComposite: (id: string, preserveFocus?: boolean) => services.invokeFunction(accessor => accessor.get(IViewsService).openViewContainer(id, !preserveFocus)),
			viewDescriptorService: viewDescriptors,
			contextKeyService: contextKeys,
			localizationService,
			id: "agentSidebar",
			location: ViewContainerLocation.AgentSidebar,
			ariaLabel: "Agent sidebar",
			ariaLabelKey: { bundle: "ash.regions", key: "agentSidebar" },
			viewsAriaLabel: "Agent sidebar views",
			viewsAriaLabelKey: { bundle: "ash.regions", key: "agentSidebarViews" },
			compositeBarContainerFilter: () => false,
			titleActions: {
				menuService: menus,
				contextMenuProvider: contextMenus,
				menuId: MenuId.AgentSidebarTitle,
			},
		}));
		const breadcrumbsService = new BreadcrumbsService();
		services.registerInstance(IBreadcrumbsService, breadcrumbsService);
		const editorOptions: IEditorPartOptions = {
			beforeCloseEditor: async resource => {
				try { await textModelService.waitForSaveRecovery(resource); return true; }
				catch (error) {
					await services.createInstance(TextFileSaveErrorHandler).onSaveError(error, resource);
					return false;
				}
			},
			breadcrumbsService,
			languageFeaturesService,
			showBreadcrumbSymbolPicker: (symbols, selected, reveal) => {
				const picker = instantiationService.createInstance(BreadcrumbsSymbolPicker, symbols, selected, reveal);
				picker.show();
			},
			configurationService: configuration,
			contextKeyService: contextKeys,
			keybindingService: keybindings,
			keyboardLayoutService: services.get(IKeyboardLayoutService),
			fileService,
			textFileService,
			textMateService,
			languageResolver: languageService,
			diffService,
			accessibilityService,
			languageDiagnosticsService,
			documentCollaborationApi: api.documentCollaboration,
			serverEvents: api.events,
			workingCopyService,
			replaceEditorResource: (source, input, replacement) => editorParts.replaceEditorResource(source, input, replacement),
			dialogService,
			fileDialogService: services.getOptional(IFileDialogService),
			bulkEditService,
			saveAsResource: nativeHostApi || browserFileSystemProvider || webWorkspaceClient && workspace.folders.length > 0
				? defaultName => services.get(IFileDialogService).pickFileToSave(URI.file(`/${defaultName}`))
				: undefined,
			titleActions: {
				menuService: menus,
				contextMenuProvider: contextMenus,
			},
			showBreadcrumbPicker: (element, openFile) => {
				const picker = instantiationService.createInstance(BreadcrumbsFilePicker, element, openFile);
				void picker.show().catch(error => {
					picker.dispose();
					console.error("Could not show breadcrumb files", error);
				});
			},
		};
		const editor = this._register(instantiationService.createInstance(EditorPart, workbenchRoot, editorOptions));
		if (nativeHostApi) {
			this._register(editor.onDidChangeModalVisibility(visible => {
				void nativeHostApi.setWindowDimmed(visible).catch(error => console.error('Failed to update window controls', error));
			}));
		}
		const auxiliaryWindows = this._register(services.createInstance(BrowserAuxiliaryWindowService, ownerWindow, workbenchRoot));
		services.registerInstance(IAuxiliaryWindowService, auxiliaryWindows);
		const editorParts = this._register(services.createInstance(EditorParts, editor, auxiliaryWindows, (container: HTMLElement) => {
			const resources = new DisposableStore();
			const contextKeyService = resources.add(contextKeys.createScoped(container));
			const part = instantiationService.createInstance(EditorPart, container, {
				...editorOptions,
				contextKeyService,
			});
			const windowServices = resources.add(services.createChild());
			windowServices.registerSingleton(IEditorService, () => new BrowserEditorService(part));
			windowServices.registerInstance(IContextKeyService, contextKeyService);
			const titlebar = services.get(ITitleService).createAuxiliaryTitlebarPart(container, part, windowServices);
			return {
				part,
				titlebar,
				resources: [resources],
			};
		}, accessibilityService, storage));
		services.registerInstance(IEditorPartsService, editorParts);
		this._register(new EditorContextKeyController(contextKeys, editorParts, EditorPanes, languageService));
		services.registerInstance(IEditorPart, editorParts);
		const historyService = this._register(instantiationService.createInstance(HistoryService));
		services.registerInstance(IHistoryService, historyService);
		const editorService = this._register(new BrowserEditorService(editorParts));
		services.registerInstance(IEditorService, editorService);
		services.registerInstance(IEditorGroupsService, editorService);
		// The URL opener requires the completed editor service graph before the window announces readiness.
		services.get(IURLService);
		// Commands follow focus across windows; each window title follows only that window's EditorPart.
		const titleService = this._register(services.createInstance(BrowserTitleService, workbenchRoot, productName, createTitlebarPart, editor));
		services.registerInstance(ITitleService, titleService);
		const titlebar = titleService.getPart(workbenchRoot);
		if (initialActivityBarLocation === ActivityBarPosition.TOP || initialActivityBarLocation === ActivityBarPosition.BOTTOM) {
			titlebar.setActivityActions({ bar: globalCompositeBar, showContextMenu: event => activitybar.showContextMenu(event) });
		}
		const panel = this._register(services.createInstance(PanelPart, workbenchRoot));
		this.editor = editorParts;
		const auxiliarybar = this._register(services.createInstance(AuxiliarybarPart, workbenchRoot, {
			openComposite: (id: string, preserveFocus?: boolean) => services.invokeFunction(accessor => accessor.get(IViewsService).openViewContainer(id, !preserveFocus)),
			viewDescriptorService: viewDescriptors,
			contextKeyService: contextKeys,
			localizationService,
		}));
		const statusbar = this._register(services.createInstance(StatusbarPart, workbenchRoot, statusbarService));
		const parts = new Map<WorkbenchPartId, Part>([
			["titlebar", titlebar],
			["statusbar", statusbar],
			["activitybar", activitybar],
			["sidebar", sidebar],
			["auxiliarybar", auxiliarybar],
			["agentSidebar", agentSidebar],
			["editor", editor],
			["panel", panel],
		]);
		const layout = layoutService;
		layout.createParts(parts);
		this._register(configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(WorkbenchConfiguration.layoutStyle)) {
				const style = configuration.getValue<WorkbenchLayoutStyle>(WorkbenchConfiguration.layoutStyle);
				activitybar.setLayoutStyle(style);
			}
			if (event.affectsConfiguration(WorkbenchConfiguration.activityBarCompact)) activitybar.setCompact(configuration.getValue<boolean>(WorkbenchConfiguration.activityBarCompact));
			if (event.affectsConfiguration(WorkbenchConfiguration.activityBarLocation)) {
				const location = configuration.getValue<ActivityBarPosition>(WorkbenchConfiguration.activityBarLocation);
				sidebar.setActivityBarLocation(location);
				if (location === ActivityBarPosition.TOP || location === ActivityBarPosition.BOTTOM) {
					titlebar.setActivityActions({ bar: globalCompositeBar, showContextMenu: event => activitybar.showContextMenu(event) });
				} else {
					activitybar.hostCompositeBar();
					activitybar.hostGlobalActions();
					titlebar.setActivityActions(undefined);
				}
			}
			if (event.affectsConfiguration(WorkbenchConfiguration.sideBarLocation)) {
				const location = configuration.getValue<SideBarLocation>(WorkbenchConfiguration.sideBarLocation);
				activitybar.setSideBarLocation(location);
				sidebar.domNode.classList.toggle('sidebar-right', location === 'right');
			}
		}));
		activitybar.setSidebarVisible(layout.isPartVisible('sidebar'));
		this._register(layout.onDidChangePartVisibility(({ partId, visible }) => {
			if (partId === 'sidebar') activitybar.setSidebarVisible(visible);
		}));
		this._register(new WorkbenchContextKeysHandler(contextKeys, workspaceContext, editorService, editorService, layout, workingCopyService, nativeHostApi !== undefined || webWorkspaceClient !== undefined, browserFileSystemProvider !== undefined));
		const paneParts = new Map<ViewContainerLocation, PaneCompositePart>([
			[ViewContainerLocation.Sidebar, sidebar],
			[ViewContainerLocation.Panel, panel],
			[ViewContainerLocation.AuxiliaryBar, auxiliarybar],
			[ViewContainerLocation.AgentSidebar, agentSidebar],
		]);
		const panes = this._register(instantiationService.createInstance(PaneCompositePartService, paneParts));
		services.registerInstance(IPaneCompositePartService, panes);
		const views = this._register(instantiationService.createInstance(ViewsService));
		services.registerInstance(IViewsService, views);
		// Workspace switches reuse this operation; startup marks describe only its first run.
		let isStartupRestoration = true;
		this.restoreActiveViewContainers = async () => {
			const isStartup = isStartupRestoration;
			isStartupRestoration = false;
			const openings: Promise<unknown>[] = [];
			for (const [location, part] of paneParts) {
				if (location === ViewContainerLocation.AgentSidebar && !layout.isPartVisible('agentSidebar')) { continue; }
				const visible = layout.isPartVisible(panes.getPartId(location));
				const container = requiredViewContainerToRestore(viewDescriptors, location, part.getCompositeIdToRestore());
				// Restore retained content without changing the saved visibility of its region.
				if (isStartup) {
					if (location === ViewContainerLocation.Sidebar) { performance.mark('ash.workbench.sidebar-restore-start'); }
					if (location === ViewContainerLocation.Panel) { performance.mark('ash.workbench.panel-restore-start'); }
					if (location === ViewContainerLocation.AuxiliaryBar) { performance.mark('ash.workbench.auxiliary-restore-start'); }
				}
				openings.push(views.openViewContainer(container.id));
				if (!visible) { views.closeViewContainer(container.id); }
			}
			await Promise.all(openings);
			if (isStartup) { performance.mark('ash.workbench.views-restored'); }
		};
		performance.mark('ash.workbench.shell-ready');
		const paneRestoration = this.restoreActiveViewContainers();
		lifecycleService.phase = LifecyclePhase.Ready;
		contributions.advance(WorkbenchPhase.BlockRestore);
		layoutService.layout();
		this.whenRestored = this.completeStartupRestoration([keybindingsReady, extensionReady, paneRestoration, recentWorkspaces.initialize(), ...serviceContributionReady], workingCopyBackups, editor, editorParts, contributions, saveFontInfo);
		if (createWindow) {
			this._register(createWindow(services));
		}
		void lifecycleService.when(LifecyclePhase.Restored).then(() => {
			if (this.isDisposed) return;
			this._register(disposableWindowTimeout(this.ownerWindow, () => {
				lifecycleService.phase = LifecyclePhase.Eventually;
				contributions.advance(WorkbenchPhase.Eventually);
			}, 2_000));
		});
		performance.mark('ash.workbench.constructor-done');
	}

	private registerErrorHandler(logService: ILogService): void {
		mainWindow.addEventListener("unhandledrejection", event => {
			onUnexpectedError(event.reason);
			event.preventDefault();
		});
		setUnexpectedErrorHandler(error => this.handleUnexpectedError(error, logService));
	}

	private handleUnexpectedError(error: unknown, logService: ILogService): void {
		const message = error instanceof Error ? error.stack || error.message : getErrorMessage(error);
		if (!message) return;

		const now = Date.now();
		if (message === this.previousUnexpectedError.message && now - this.previousUnexpectedError.time <= 1_000) return;
		this.previousUnexpectedError = { message, time: now };
		logService.error("runtime", message);
	}

	shutdown(reason: ShutdownReason): Promise<void> {
		return this.lifecycleService.shutdown(reason);
	}

	private async completeStartupRestoration(extensionReady: readonly Promise<void>[], backups: IWorkingCopyBackupService, editor: IEditorPart, editorParts: IEditorPartsService, contributions: WorkbenchContributionHost, saveFontInfo: () => void): Promise<void> {
		await Promise.allSettled(extensionReady);
		if (this.isDisposed) return;
		await this.restoreEditorParts(editorParts);
		if (this.isDisposed) return;
		await this.restoreWorkingCopyBackups(backups, editor);
		if (this.isDisposed) return;
		// Persist the fonts used by restored editors before navigation can disconnect this document.
		saveFontInfo();
		this.lifecycleService.phase = LifecyclePhase.Restored;
		contributions.advance(WorkbenchPhase.AfterRestored);
		performance.mark('ash.workbench.restored');
		this.logService.info('lifecycle', 'Workbench restored');
	}

	private async restoreEditorParts(editorParts: IEditorPartsService): Promise<void> {
		try {
			await editorParts.restoreSavedState(this.workbenchLayout.shouldRestoreEditors());
		} catch (error) {
			this.logService.error('editor', 'Failed to restore saved editor parts', error);
		}
	}

	private async restoreWorkingCopyBackups(backups: IWorkingCopyBackupService, editor: IEditorPart): Promise<void> {
		let pending: readonly WorkingCopyBackup[];
		try { pending = await backups.list(); }
		catch (error) { this.logService.error("workingCopy", "Failed to list working-copy backups", error); return; }
		for (const backup of pending) {
			if (backup.kind === "text" && this.untitledTextEditorService.isUntitled(backup.resource)) {
				this.untitledTextEditorService.create({ untitledResource: backup.resource, initialValue: backup.content, languageId: backup.languageId, label: backup.label });
			}
		}
		for (const backup of pending) {
			try {
				let pane;
				const untitled = backup.kind === "text" ? this.untitledTextEditorService.get(backup.resource) : undefined;
				if (untitled) {
					pane = await editor.openEditor(new UntitledTextEditorInput(untitled));
				} else {
					try {
						pane = await editor.openEditor({ resource: backup.resource, ...(backup.languageId ? { languageId: backup.languageId } : {}), ...(backup.contentType ? { contentType: backup.contentType } : {}), ...(backup.label ? { label: backup.label } : {}) });
					} catch {
						pane = await editor.openEditor({ resource: backup.resource, initialText: "", ...(backup.languageId ? { languageId: backup.languageId } : {}), ...(backup.contentType ? { contentType: backup.contentType } : {}), ...(backup.label ? { label: backup.label } : {}) });
					}
				}
				const workingCopy = pane.workingCopy;
				if (!workingCopy || workingCopy.backupKind !== backup.kind) throw new Error(`Restored editor does not support ${backup.kind} backups`);
				workingCopy.restoreBackup(backup.content);
			} catch (error) {
				this.logService.error("workingCopy", `Failed to restore working-copy backup '${backup.resource.toString()}'`, error);
			}
		}
	}

	/** Applies a host-authoritative workspace replacement without rebuilding the Workbench. */
	updateWorkspace(workspace: IWorkspace): Promise<void> {
		const switching = this.workspaceSwitchQueue.then(() => this.doUpdateWorkspace(workspace));
		this.workspaceSwitchQueue = switching.then(() => undefined, () => undefined);
		return switching;
	}

	private async doUpdateWorkspace(workspace: IWorkspace): Promise<void> {
		if (this.workspaceContext.getWorkspace().id === workspace.id) return;
		await this.workingCopyBackupTracker.flush();
		await this.storage.flush(WillSaveStateReason.WORKSPACE_CHANGE);
		using editorStatePause = this.editor.pauseStatePersistence();
		if (!await this.editor.closeAllEditors({ reason: "reset" })) throw new CancellationError("Workspace switch was cancelled");
		await this.workingCopyBackupTracker.flush();
		this.untitledTextEditorService.reset();
		this.workingCopyBackups.switchWorkspace(workspace.id);
		await this.storage.switchWorkspace(workspace.id);
		const nextWorkbenchState = workbenchStateFromWorkspace(workspace);
		this.workbenchWindow.setWorkbenchState(nextWorkbenchState);
		this.workspaceContext.updateWorkspace(workspace);
		this.workbenchLayout.restoreWorkspaceState(nextWorkbenchState);
		await this.restoreActiveViewContainers?.();
		await this.restoreEditorParts(this.editor);
		await this.restoreWorkingCopyBackups(this.workingCopyBackups, this.editor);
		await this.contributions.workspaceRestored();
	}
}

function requiredViewContainerToRestore(
	service: IViewDescriptorService,
	location: ViewContainerLocation,
	containerId: string | undefined,
) {
	const container = service
		.getViewContainers(location)
		.find((candidate) => candidate.id === containerId);
	if (!container) {
		throw new Error(
			`Workbench has no ${location} view container to restore`,
		);
	}
	return container;
}
