import { IAssetService } from '../../platform/assets/common/assetService.js';
import { INetworkDiagnosticsService } from '../../platform/networkDiagnostics/common/networkDiagnosticsService.js';
import { IModelApi as ModelApiId } from '../../platform/sessions/common/sessionApi.js';
import { IAppServerApi as AppServerApiId, IServerEventApi as ServerEventApiId } from '../../platform/app-server/common/appServerApi.js';
import { ILanguageModelsService, LanguageModelsService } from '../contrib/chat/common/languageModels.js';
import { ILanguageModelsConfigurationService } from '../contrib/chat/common/languageModelsConfiguration.js';
import { LanguageModelsConfigurationService } from '../contrib/chat/browser/languageModelsConfigurationService.js';
import { IDictationService } from '../../platform/dictation/common/dictationService.js';
import { IHooksService } from '../../platform/hooks/common/hooksService.js';
import { ExtensionColorThemeService } from '../services/extensions/browser/extensionColorThemeService.js';
import { IWorkbenchThemeService } from '../services/themes/common/workbenchThemeService.js';
import { IHostColorSchemeService, type IHostColorSchemeService as HostColorSchemeService } from '../services/themes/common/hostColorSchemeService.js';
import { BrowserHostColorSchemeService } from '../services/themes/browser/browserHostColorSchemeService.js';
import { getActivityHoverPosition } from "./parts/compositeBarActions.js";
import { ISkillService } from "../../platform/skills/common/skillService.js";
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
import { WorkbenchModeRegistry, type WorkbenchModeId } from "../common/workbenchMode.js";
import { URI } from "../../base/common/uri.js";
import { AccessibilityService } from "../../platform/accessibility/browser/accessibilityService.js";
import { IAccessibilityService } from "../../platform/accessibility/common/accessibility.js";
import { ILogService } from "../../platform/log/common/log.js";
import type { LogService } from "../../platform/log/common/logServiceImpl.js";
import { ILifecycleService, LifecyclePhase, type ShutdownReason } from "../services/lifecycle/common/lifecycle.js";
import { IDebugAdapterProcessService } from "../../platform/debug/common/debugAdapterProcessService.js";
import { ITestExecutionService } from '../../platform/testing/common/testExecutionService.js';
import { IExtensionHostApi } from "../../platform/extensionHost/common/extensionHostApi.js";
import { ISyntaxApi } from "../../platform/syntax/common/syntaxApi.js";
import { IRendererHostService, type IRendererHost } from "../../platform/renderer/common/rendererHost.js";
import { ILocalTranscriptionService } from '../../platform/localTranscription/common/localTranscription.js';
import { NullLocalTranscriptionService } from '../services/localTranscription/browser/localTranscriptionService.js';
import { IAgentCapabilitiesService } from '../../platform/agentCapabilities/common/agentCapabilitiesService.js';
import { IBrowserViewApi } from '../../platform/browser/common/browserView.js';
import { IRemoteConnectionService } from "../../platform/remote/common/remoteConnectionService.js";
import { UnavailableRemoteConnectionService } from "../../platform/remote/common/remoteConnectionService.js";
import { IRemoteTunnelService } from "../../platform/remote/common/remoteTunnelService.js";
import { UnavailableRemoteTunnelService } from "../../platform/remote/common/remoteTunnelService.js";
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
import { ServiceCollection } from '../../platform/instantiation/common/serviceCollection.js';
import { NotificationService } from "../services/notification/common/notificationService.js";
import { IAccessibleViewService, AccessibilityVerbositySettingId } from "../../platform/accessibility/browser/accessibleView.js";
import { INotificationsCenter, NotificationsCenter } from "./parts/notifications/notificationsCenter.js";
import { INotificationService } from "../../platform/notification/common/notification.js";
import { BrowserProgressService } from "../../platform/progress/browser/progressService.js";
import { IProgressService } from "../../platform/progress/common/progress.js";
import { StatusbarHeight } from './parts/workbenchPartDimensions.js';
import { MarkerService, IMarkerService } from "../../platform/markers/common/markers.js";
import type { IKeybindingsResourceApi } from "../../platform/keybinding/common/keybindingsResource.js";
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
	BrowserFileService,
} from "../../platform/files/browser/fileService.js";
import { MultiplexFileService } from "../../platform/files/browser/multiplexFileService.js";
import { IQuickInputService } from "../../platform/quickinput/common/quickInput.js";
import type { HTMLFileSystemProvider } from '../../platform/files/browser/htmlFileSystemProvider.js';
import { IFileSystemProviderService } from "../../platform/files/common/fileSystemProviderService.js";
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
import {
	IViewDescriptorService,
	ViewDescriptorService,
} from "../services/views/common/viewDescriptorService.js";
import {
	IViewsService,
	ViewsService,
} from "../services/views/browser/viewsService.js";
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
import { IContentSearchService } from "../../platform/search/common/search.js";
import { BrowserContentSearchService } from "../../platform/search/browser/searchService.js";
import type { WorkbenchPart } from "./part.js";
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
import type {
	TitlebarPartFactory,
} from "./parts/titlebar/titlebarPart.js";
import { PaneComposite, type PaneCompositeOptions } from "./parts/views/paneComposite.js";
import { WorkbenchWindow } from "./window.js";
import { TerminalService } from "../services/terminal/browser/terminalService.js";
import { BrowserAuxiliaryWindowService, IAuxiliaryWindowService } from "../services/auxiliaryWindow/browser/auxiliaryWindowService.js";
import { ITerminalService } from "../services/terminal/common/terminal.js";
import { ITextFileService, TextFileService } from "../services/textfile/common/textFileService.js";
import { ITextMateService } from "../services/textMate/common/textMateService.js";
import { BrowserTextMateService } from "../services/textMate/browser/browserTextMateService.js";
import { AppServerExtensionService } from "../services/extensions/browser/appServerExtensionService.js";
import { IExtensionService } from "../services/extensions/common/extensionService.js";
import { AppServerRemoteAgentService } from "../services/remote/browser/appServerRemoteAgentService.js";
import { IRemoteAgentService } from "../services/remote/common/remoteAgentService.js";
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
import { IKeybindingsResourceService } from "../../platform/keybinding/common/keybindingsResource.js";
import { IKeyboardLayoutService } from "../../platform/keyboardLayout/common/keyboardLayout.js";
import { AppServerDirPermissionsService } from "../services/dirPermissions/browser/appServerDirPermissionsService.js";
import { IWorkspaceTrustManagementService } from '../../platform/workspace/common/workspaceTrust.js';
import { WorkspaceTrustManagementService } from '../services/workspaces/common/workspaceTrust.js';
import { IConnectorService } from "../../platform/connectors/common/connectorService.js";
import { AppServerConnectorService } from "../services/connectors/browser/appServerConnectorService.js";
import { IAccountService } from "../../platform/accounts/common/accountService.js";
import { AppServerAccountService } from "../services/accounts/browser/appServerAccountService.js";
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
import { BrowserUntitledTextEditorService } from "../services/untitled/browser/browserUntitledTextEditorService.js";
import { IUntitledTextEditorService } from "../services/untitled/common/untitledTextEditorService.js";
import { BrowserWorkingCopyService } from "../services/workingCopy/browser/browserWorkingCopyService.js";
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
import { OutputService } from "../services/output/browser/outputService.js";
import { IOutputService } from "../services/output/common/outputService.js";
import { IWorkbenchHostService } from "../services/host/common/workbenchHostService.js";
import { BrowserEditorService } from "../services/editor/browser/browserEditorService.js";
import { IEditorService } from "../services/editor/common/editorService.js";
import { IEditorGroupsService } from '../services/editor/common/editorGroupsService.js';
import { OUTPUT_VIEW_ID } from "../contrib/output/common/output.js";
import { installWorkbenchServiceContributions } from "./workbenchServiceContributions.js";
import type { ContextMenuServiceFactory } from "../../platform/contextview/browser/contextMenuService.js";
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
import { IOpenerService } from "../../platform/opener/common/openerService.js";
import { BrowserOpenerService } from "../../platform/opener/browser/browserOpenerService.js";
import { CommandService } from "../services/commands/common/commandService.js";
import { BrowserKeyboardLayoutService } from "../services/keybinding/browser/keyboardLayoutService.js";
import { WorkbenchKeybindingService } from "../services/keybinding/browser/keybindingService.js";
import { IKeyboardShortcutTroubleshootingService } from "../services/keybinding/common/keyboardShortcutTroubleshooting.js";
import { WorkbenchKeybindingsResourceService } from "../services/keybinding/browser/keybindingsResourceService.js";
import { IPreferencesService } from "../services/preferences/common/preferences.js";
import { PreferencesService } from "../services/preferences/browser/preferencesService.js";
import { WorkbenchQuickInputService } from "../services/quickinput/browser/quickInputService.js";
import { ChatContextPickService } from "../services/chat/browser/chatContextPickService.js";
import { IChatContextPickService } from "../services/chat/common/chatContextService.js";
import type { IUserKeyboardLayoutApi } from "../../platform/keyboardLayout/common/userKeyboardLayout.js";
import { WorkbenchModeService } from "../services/workbenchMode/browser/workbenchModeService.js";
import { IWorkbenchModeService } from "../services/workbenchMode/common/workbenchModeService.js";
import { WindowTitle } from './parts/titlebar/windowTitle.js';
import { BrowserClipboardService } from "../../platform/clipboard/browser/clipboardService.js";
import { IClipboardService } from "../../platform/clipboard/common/clipboardService.js";

/** Host-specific inputs required to construct a workbench. */
export interface IStartWorkbenchOptions {
	readonly modeId: WorkbenchModeId;
	readonly defaultLayout?: WorkbenchDefaultLayout;
	readonly api: IRendererHost;
	readonly browserFileSystemProvider?: HTMLFileSystemProvider;
	readonly webWorkspaceClient?: IWebWorkspaceClient;
	readonly browserViewApi?: IBrowserViewApi;
	readonly container: HTMLElement;
	readonly workspace: IWorkspace;
	/** The host selects its implementation; the Workbench supplies initialized window services. */
	readonly createLifecycleService: (services: IInstantiationService) => ILifecycleService & IDisposable;
	readonly createTextDocumentHost?: (services: IInstantiationService) => IDisposable;
	readonly createWindow?: (services: IInstantiationService) => IDisposable;
	readonly createStorageService: (options: BrowserStorageServiceOptions) => Promise<IStorageService & IDisposable & { switchWorkspace(workspaceId: string): void | Promise<void> }>;
	readonly createWorkingCopyBackupService: (services: IInstantiationService, workspaceId: string) => IWorkingCopyBackupService;
	readonly createLogService: () => LogService;
	readonly configurationApi?: IConfigurationApi;
	readonly initialConfigurationSnapshot?: IConfigurationSnapshot;
	readonly keybindingsResourceApi?: IKeybindingsResourceApi;
	readonly keyboardLayoutProvider?: IKeyboardLayoutProvider;
	readonly userKeyboardLayoutApi?: IUserKeyboardLayoutApi;
	readonly nativeHostApi?: INativeHostApi;
	readonly createHostColorSchemeService?: (services: IInstantiationService) => HostColorSchemeService & IDisposable;
	readonly clipboardService?: IClipboardService;
	readonly dialogHandler?: IDialogHandler;
	readonly userThemeService?: IUserThemeServiceContract;
	readonly createContextMenuService: ContextMenuServiceFactory;
	readonly createTitlebarPart: TitlebarPartFactory;
	readonly switchWorkbenchMode: (modeId: WorkbenchModeId) => Promise<void>;
}

/** Starts the browser workbench and binds its commands to the initial UI. */
export async function startWorkbench({
	modeId,
	defaultLayout,
	api,
	browserFileSystemProvider,
	webWorkspaceClient,
	container,
	workspace,
	createLifecycleService,
	createWindow,
	createTextDocumentHost,
	createStorageService,
	createWorkingCopyBackupService,
	createLogService,
	configurationApi,
	initialConfigurationSnapshot,
	keybindingsResourceApi,
	keyboardLayoutProvider,
	userKeyboardLayoutApi,
	nativeHostApi,
	createHostColorSchemeService,
	clipboardService,
	dialogHandler,
	userThemeService,
	createContextMenuService,
	createTitlebarPart,
	switchWorkbenchMode,
	browserViewApi,
}: IStartWorkbenchOptions): Promise<Workbench> {
	const themes = new ExtensionColorThemeService(api.extensions, api.events);
	const logger = createLogService();
	let storage: Awaited<ReturnType<IStartWorkbenchOptions['createStorageService']>> | undefined;
	try {
		await themes.start();
		const ownerWindow = container.ownerDocument.defaultView;
		if (!ownerWindow) { throw new Error('Workbench requires an owner window'); }
		storage = await createStorageService({ ownerWindow, applicationId: WorkbenchModeRegistry.get(modeId).storageNamespace, workspaceId: workspace.id });
		return new Workbench(
			modeId,
			defaultLayout,
			api,
			container,
			workspace,
			createLifecycleService,
			configurationApi,
			initialConfigurationSnapshot,
			keybindingsResourceApi,
			keyboardLayoutProvider,
			userKeyboardLayoutApi,
			nativeHostApi,
			createHostColorSchemeService,
			clipboardService,
			dialogHandler,
			userThemeService,
			createContextMenuService,
			createTitlebarPart,
			switchWorkbenchMode,
			browserViewApi,
			browserFileSystemProvider,
			webWorkspaceClient,
			themes,
			storage,
			logger,
			createWorkingCopyBackupService,
			createWindow,
			createTextDocumentHost,
		);
	} catch (error) {
		logger.error('startup', 'Workbench startup failed', error);
		logger.dispose();
		storage?.dispose();
		themes.dispose();
		throw error;
	}
}

/** Owns the renderer workbench, its parts, commands, and runtime layout. */
export class Workbench extends Disposable {
	/** Resolves after dirty working copies are restored and AfterRestored contributions are active. */
	readonly whenRestored: Promise<void>;
	private readonly workspaceContext: WorkspaceContextService;
	private readonly configurationService: IConfigurationService;
	private readonly storage: IStorageService & { switchWorkspace(workspaceId: string): void | Promise<void> };
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
	private restoreActiveViewContainers: (() => void) | undefined;
	private workspaceSwitchQueue: Promise<void> = Promise.resolve();
	private previousUnexpectedError: { message: string | undefined; time: number } = { message: undefined, time: 0 };

	constructor(
		modeId: WorkbenchModeId,
		defaultLayout: WorkbenchDefaultLayout | undefined,
		api: IRendererHost,
		workbenchRoot: HTMLElement,
		workspace: IWorkspace,
		createLifecycleService: (services: IInstantiationService) => ILifecycleService & IDisposable,
		configurationApi: IConfigurationApi | undefined,
		initialConfigurationSnapshot: IConfigurationSnapshot | undefined,
		keybindingsResourceApi: IKeybindingsResourceApi | undefined,
		keyboardLayoutProvider: IKeyboardLayoutProvider | undefined,
		userKeyboardLayoutApi: IUserKeyboardLayoutApi | undefined,
		nativeHostApi: INativeHostApi | undefined,
		createHostColorSchemeService: ((services: IInstantiationService) => HostColorSchemeService & IDisposable) | undefined,
		clipboardService: IClipboardService | undefined,
		dialogHandler: IDialogHandler | undefined,
		userThemeService: IUserThemeServiceContract | undefined,
		createContextMenuService: ContextMenuServiceFactory,
		createTitlebarPart: TitlebarPartFactory,
		switchWorkbenchMode: (modeId: WorkbenchModeId) => Promise<void>,
		browserViewApi: IBrowserViewApi | undefined,
		browserFileSystemProvider: HTMLFileSystemProvider | undefined,
		webWorkspaceClient: IWebWorkspaceClient | undefined,
		themes: ExtensionColorThemeService,
		storageService: IStorageService & IDisposable & { switchWorkspace(workspaceId: string): void | Promise<void> },
		logger: LogService,
		createWorkingCopyBackupService: IStartWorkbenchOptions['createWorkingCopyBackupService'],
		createWindow?: (services: IInstantiationService) => IDisposable,
		createTextDocumentHost?: (services: IInstantiationService) => IDisposable,
	) {
		super();
		this._register(themes);
		this._register(FormattingConflicts.setFormatterSelector(async formatters => formatters[0]));
		const mode = WorkbenchModeRegistry.get(modeId);
		const serviceCollection = new ServiceCollection();
		for (const [id, descriptor] of getSingletonServiceDescriptors()) {
			serviceCollection.set(id, descriptor);
		}
		const services = this._register(new InstantiationService(serviceCollection));
		if (browserViewApi) { services.registerInstance(IBrowserViewApi, browserViewApi); }
		const instantiationService = services;
		const logService = this._register(logger);
		this.logService = logService;
		this.registerErrorHandler(logService);
		services.registerInstance(ILogService, logService);
		services.registerInstance(IRendererHostService, api);
		services.registerInstance(IDictationService, api.dictation);
		services.registerInstance(ILocalTranscriptionService, api.localTranscription ?? this._register(new NullLocalTranscriptionService()));
		services.registerInstance(IAgentCapabilitiesService, api.agentCapabilities);
		services.registerInstance(INetworkDiagnosticsService, api.networkDiagnostics);
		services.registerInstance(IHooksService, api.hooks);
		services.registerInstance(IExtensionHostApi, api.extensionHost);
		services.registerInstance(ICodebaseSymbolsApi, api.codebaseSymbols);
		services.registerInstance(ISyntaxApi, api.syntax);
		if (api.debugAdapter) services.registerInstance(IDebugAdapterProcessService, api.debugAdapter);
		services.registerInstance(IAssetService, api.assets);
		services.registerInstance(ITestExecutionService, api.testing);
		if (api.approvalEnvironment) { services.registerInstance(IApprovalEnvironmentService, api.approvalEnvironment); }
		if (api.memories) { services.registerInstance(IMemoriesService, api.memories); }
		if (api.memoryDiagnostics) { services.registerInstance(IMemoryDiagnosticsService, api.memoryDiagnostics); }
		if (api.calls) { services.registerInstance(ICallService, api.calls); }
		if (api.automation) {
			services.registerInstance(IAutomationService, api.automation);
		}
		const remoteAgentService = this._register(new AppServerRemoteAgentService({ api: api.appServer, remoteApi: api.remote }));
		services.registerInstance(IRemoteAgentService, remoteAgentService);
		services.registerInstance(IRemoteConnectionService, api.remoteConnections ?? UnavailableRemoteConnectionService);
		services.registerInstance(IRemoteTunnelService, api.remoteTunnels ?? UnavailableRemoteTunnelService);
		const dialogService = services.get(IDialogService) as DialogService;
		services.registerInstance(IDialogsModel, dialogService.model);
		if (nativeHostApi) {
			services.registerInstance(INativeHostService, nativeHostApi);
			services.registerSingleton(IFileDialogService, () => services.createInstance(FileDialogService));
		}
		if (browserFileSystemProvider) this._register(browserFileSystemProvider);
		if (browserFileSystemProvider) {
			services.registerInstance(IFileDialogService, new BrowserFileDialogService({
				kind: 'local',
				provider: browserFileSystemProvider,
				pickDirectory: startIn => (window as unknown as { showDirectoryPicker: (options?: { startIn?: FileSystemDirectoryHandle }) => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker(startIn ? { startIn } : undefined),
				quickInput: () => services.get(IQuickInputService),
				fileService: () => services.get(IFileService),
				workspaceRoot: () => services.get(IWorkspaceContextService).getWorkspace().folders[0]?.uri,
			}, () => services.get(IDialogService)));
		} else if (webWorkspaceClient) {
			services.registerInstance(IFileDialogService, new BrowserFileDialogService({
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
				? new WebWorkspaceOpenService(
					webWorkspaceClient,
					services.get(IFileDialogService),
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
		const workspaceContext = this._register(new WorkspaceContextService(workspace));
		this.workspaceContext = workspaceContext;
		services.registerInstance(IWorkspaceContextService, workspaceContext);
		const labelService = this._register(new LabelService(workspaceContext));
		services.registerInstance(ILabelService, labelService);
		services.registerInstance(IDecorationsService, this._register(services.createInstance(DecorationsService, workbenchRoot.ownerDocument)));
		const dirPermissionsService = this._register(new AppServerDirPermissionsService(api.dirPermissions, api.events));
		services.registerInstance(IDirPermissionsService, dirPermissionsService);
		const workspaceTrustService = this._register(services.createInstance(WorkspaceTrustManagementService));
		services.registerInstance(IWorkspaceTrustManagementService, workspaceTrustService);
		const workspaceFileService = new BrowserFileService({
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
		const fileService = this._register(new MultiplexFileService(workspaceFileService));
		if (browserFileSystemProvider) this._register(fileService.registerProvider('file', browserFileSystemProvider));
		services.registerInstance(IFileService, fileService);
		services.registerInstance(ISystemFileTransferService, workspaceFileService);
		services.registerInstance(IFileSystemProviderService, fileService);
		const textFileService = new TextFileService(fileService);
		services.registerInstance(ITextFileService, textFileService);
		const workingCopyService = this._register(new BrowserWorkingCopyService());
		services.registerInstance(IWorkingCopyService, workingCopyService);
		const documentTextModelService = this._register(services.createInstance(DocumentEditorTextModelService));
		services.registerInstance(IDocumentEditorTextModelService, documentTextModelService);
		const untitledTextEditorService = this._register(services.createInstance(BrowserUntitledTextEditorService));
		this.untitledTextEditorService = untitledTextEditorService;
		services.registerInstance(IUntitledTextEditorService, untitledTextEditorService);
		const workingCopyBackups = this._register(createWorkingCopyBackupService(services, workspace.id));
		this.workingCopyBackups = workingCopyBackups;
		services.registerInstance(IWorkingCopyBackupService, workingCopyBackups);
		const configuration = this._register(new WorkbenchConfigurationService({
			api: configurationApi,
			initialSnapshot: initialConfigurationSnapshot,
		}));
		this.configurationService = configuration;
		services.registerInstance(IConfigurationService, configuration);
		services.registerInstance(IConfigurationResourceService, configuration);
		const languageService = this._register(new LanguageService());
		services.registerInstance(ILanguageService, languageService);
		const languageConfigurationService = services.get(ILanguageConfigurationService);
		const languageFeaturesService = this._register(new LanguageFeaturesService());
		services.registerInstance(ILanguageFeaturesService, languageFeaturesService);
		this._register(new DefaultPasteProvidersFeature(languageFeaturesService, workspaceContext));
		this._register(new DefaultDropProvidersFeature(languageFeaturesService, workspaceContext));
		services.registerSingleton(ICodeEditorService, () => services.createInstance(CodeEditorService));
		services.registerSingleton(IInlineCompletionsService, () => services.createInstance(InlineCompletionsService));
		services.registerSingleton(ILanguageFeatureDebounceService, () => services.createInstance(LanguageFeatureDebounceService));
		const textMateService = this._register(new BrowserTextMateService());
		services.registerInstance(ITextMateService, textMateService);
		const textResourceStore = getBrowserTextResourceStore(textFileService);
		const textModelService = this._register(getBrowserTextModelService(textResourceStore, {
			languageService,
			languageConfigurationService,
			languageFeaturesService,
			syntaxService: { workerFactory: textMateService.syntaxWorkerFactory },
			onDidChangeLanguageSupport: textMateService.onDidChange,
		}));
		services.registerInstance(ITextModelResourceService, textModelService);
		services.registerInstance(IFileTextModelService, textModelService);
		services.registerSingleton(ITextModelService, () => services.createInstance(TextModelResolverService));
		const bulkEditService = services.get(IBulkEditService);
		if (createTextDocumentHost) { this._register(createTextDocumentHost(services)); }
		this._register(services.createInstance(WorkbenchLanguageFeatures));
		// Only the desktop host may inspect directory grants. Web language requests
		// are authorized by the server for the authenticated workspace.
		const languageDirPermissions = nativeHostApi ? dirPermissionsService : undefined;
		this._register(new AppServerLanguageProviders(languageFeaturesService, api.language, workspaceContext, { dirPermissions: languageDirPermissions, events: api.events }));
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
		services.registerInstance(
			IContentSearchService,
			new BrowserContentSearchService(api.contentSearch, workspaceContext),
		);
		const terminalService = this._register(new TerminalService(api.terminal, workspaceContext));
		services.registerInstance(ITerminalService, terminalService);
		const gitService = this._register(services.createInstance(GitService, { api: api.git, appServerApi: api.appServer, eventApi: api.events, workspaceContext, canCloneRepository: nativeHostApi !== undefined }));
		services.registerInstance(IGitService, gitService);
		services.registerInstance(ICodebaseService, new AppServerCodebaseService(api.codebase));
		services.registerInstance(IConnectorService, this._register(new AppServerConnectorService(api.connectors, api.events)));
		services.registerInstance(IAccountService, this._register(new AppServerAccountService(api.accounts, api.events)));
		services.registerInstance(IPluginService, this._register(new AppServerPluginService(api.plugins, api.events)));
		const marketplaceService = this._register(new AppServerMarketplaceService(api.marketplace, api.events));
		services.registerInstance(IMarketplaceService, marketplaceService);
		services.registerInstance(ISkillService, api.skills);
		services.registerInstance(ILanguageServerService, api.languageServers);
		services.registerInstance(IToolSearchService, new AppServerToolSearchService(api.toolSearch));
		const workbenchState = workspaceContext.getWorkbenchState();
		const workbenchWindow = this._register(new WorkbenchWindow({
			root: workbenchRoot,
			modeId,
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
		const workingCopyBackupTracker = this._register(new WorkingCopyBackupTracker(workingCopyService, workingCopyBackups, ownerWindow));
		this.workingCopyBackupTracker = workingCopyBackupTracker;
		const storage = this._register(storageService);
		this.workbenchWindow = workbenchWindow;
		this.storage = storage;
		services.registerInstance(IStorageService, storage);
		const lifecycleService = this.lifecycleService = this._register(createLifecycleService(services));
		services.registerInstance(ILifecycleService, lifecycleService);
		services.registerInstance(ILocaleService, this._register(services.createInstance(WorkbenchLocaleService)));
		services.registerInstance(IWorkbenchModeService, this._register(new WorkbenchModeService({
			currentModeId: modeId,
			configurationService: configuration,
			lifecycleService,
			switchHostMode: switchWorkbenchMode,
		})));
		const layoutService = this._register(services.createInstance(WorkbenchLayout, workbenchRoot, {
			workbenchState,
			defaultLayout,
			focus: () => this.editor.focus(),
		}));
		this.workbenchLayout = layoutService;
		services.registerInstance(IWorkbenchLayoutService, layoutService);
		const chatService = this._register(new ChatService({ modelApi: api.model, threadApi: api.thread, turnApi: api.turn, turnChangesApi: api.turnChanges, skillApi: api.skills, appServerApi: api.appServer, eventApi: api.events }));
		services.registerInstance(IChatService, chatService);
		services.registerInstance(ModelApiId, api.model);
		services.registerInstance(AppServerApiId, api.appServer);
		services.registerInstance(ServerEventApiId, api.events);
		services.registerInstance(ILanguageModelsConfigurationService, this._register(services.createInstance(LanguageModelsConfigurationService)));
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
			if (event.reason === 'load') event.veto(editorParts.confirmCloseAllEditors().then(confirmed => !confirmed), 'workspace editor changes');
			event.veto(workingCopyBackupTracker.flush().then(() => false), 'working-copy backup flush');
		}));
		this._register(lifecycleService.onWillShutdown(event => {
			event.join(workingCopyBackupTracker.flush().then(() => storage.flush(WillSaveStateReason.SHUTDOWN)), "Workbench storage flush");
		}));
		const outputService = this._register(new OutputService({ storageService: storage }));
		services.registerInstance(IOutputService, outputService);
		const systemOutputService = this._register(new SystemOutputService(outputService, api.appServer));
		this._register(logService.registerSink(systemOutputService));
		const serviceContributionReady: Promise<void>[] = [];
		installWorkbenchServiceContributions({ container: services, register: value => this._register(value), blockRestorationUntil: operation => serviceContributionReady.push(operation) });
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
		services.registerInstance(IOpenerService, new BrowserOpenerService(ownerWindow));
		const userKeyboardLayoutService = userKeyboardLayoutApi ?? UnavailableUserKeyboardLayoutService;
		services.registerInstance(IUserKeyboardLayoutService, userKeyboardLayoutService);
		const commandService = this._register(new CommandService(services));
		services.registerInstance(ICommandService, commandService);
		const contextKeys = this._register(new ContextKeyService());
		services.registerInstance(IContextKeyService, contextKeys);
		const notificationsCenter = this._register(new NotificationsCenter(workbenchRoot, feedbackHost, notificationService, statusbarService, contextKeys, () => services.get(IAccessibleViewService).getOpenAriaHint(AccessibilityVerbositySettingId.Notifications)));
		services.registerInstance(INotificationsCenter, notificationsCenter);
		const keyboardLayoutService = this._register(new BrowserKeyboardLayoutService({
			navigator: ownerWindow.navigator,
			configurationService: configuration,
			layoutProvider: keyboardLayoutProvider,
			userLayoutProvider: userKeyboardLayoutService,
		}));
		services.registerInstance(IKeyboardLayoutService, keyboardLayoutService);
		const keybindingsResourceService = this._register(new WorkbenchKeybindingsResourceService({ api: keybindingsResourceApi }));
		services.registerInstance(IKeybindingsResourceService, keybindingsResourceService);
		const keybindings = this._register(services.createInstance(WorkbenchKeybindingService, {
			ownerDocument: workbenchRoot.ownerDocument,
			commandService,
			contextKeyService: contextKeys,
			keyboardLayoutService,
			statusbarService,
		}));
		services.registerInstance(IKeybindingService, keybindings);
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
		services.registerInstance(IQuickAccessController, this._register(services.createInstance(QuickAccessController)));
		services.registerInstance(IChatContextPickService, new ChatContextPickService());
		services.registerSingleton(IPreferencesService, () => services.createInstance(PreferencesService));
		const contextMenus = this._register(createContextMenuService({
			configurationService: configuration,
			menuService: menus,
			contextKeyService: contextKeys,
			keybindingService: keybindings,
			contextViewService: contextViews,
			notificationService,
		}));
		services.registerInstance(IContextMenuService, contextMenus);
		const hoverService = this._register(new HoverService(configuration, contextViews, contextMenus));
		services.registerInstance(IHoverService, hoverService);
		this._register(setHoverDelegate(hoverService));
		void configuration.reloadConfiguration().catch((error: unknown) => console.error("Failed to initialize configuration", error));
		void keybindingsResourceService.reload().catch((error: unknown) => console.error("Failed to initialize keybindings resource", error));
		const accessibilityService = this._register(nativeHostApi
			? new NativeAccessibilityService({
				root: workbenchRoot,
				contextKeyService: contextKeys,
				configurationService: configuration,
				nativeHostApi,
			})
			: new AccessibilityService({
				root: workbenchRoot,
				contextKeyService: contextKeys,
				configurationService: configuration,
			}));
		services.registerInstance(IAccessibilityService, accessibilityService);
		services.registerInstance(IGitHubConnectionService, this._register(services.createInstance(GitHubConnectionService)));
		const viewDescriptors = this._register(new ViewDescriptorService({
			contextKeyService: contextKeys,
		}));
		services.registerInstance(IViewDescriptorService, viewDescriptors);
		const contributions = this._register(
			WorkbenchContributionsRegistry.createHost(services),
		);
		this.contributions = contributions;
		contributions.advance(WorkbenchPhase.BlockStartup);

		const sidebar = this._register(new SidebarPart(workbenchRoot, {
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
			storageService: storage,
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
		const agentSidebar = this._register(new SidebarPart(workbenchRoot, {
			viewDescriptorService: viewDescriptors,
			contextKeyService: contextKeys,
			storageService: storage,
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
			breadcrumbsService,
			languageFeaturesService,
			showBreadcrumbSymbolPicker: (symbols, selected, reveal) => {
				const picker = instantiationService.createInstance(BreadcrumbsSymbolPicker, symbols, selected, reveal);
				picker.show();
			},
			configurationService: configuration,
			contextKeyService: contextKeys,
			keybindingService: keybindings,
			keybindingsResourceService: services.get(IKeybindingsResourceService),
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
		const editorParts = this._register(new EditorParts(editor, auxiliaryWindows, container => {
			const resources = new DisposableStore();
			const contextKeyService = resources.add(contextKeys.createScoped(container));
			const part = instantiationService.createInstance(EditorPart, container, {
				...editorOptions,
				contextKeyService,
			});
			const windowServices = resources.add(services.createChild());
			windowServices.registerSingleton(IEditorService, () => new BrowserEditorService(part));
			resources.add(windowServices.createInstance(WindowTitle, getWindow(container)));
			return {
				part,
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
		// Commands follow focus across windows; each window title follows only that window's EditorPart.
		const mainWindowServices = this._register(services.createChild());
		mainWindowServices.registerSingleton(IEditorService, () => new BrowserEditorService(editor));
		const windowTitle = this._register(mainWindowServices.createInstance(WindowTitle, ownerWindow));
		const titlebar = this._register(createTitlebarPart(workbenchRoot, {
			windowTitle,
			menuService: menus,
			contextMenuService: contextMenus,
			localizationService,
		}, services));
		if (initialActivityBarLocation === ActivityBarPosition.TOP || initialActivityBarLocation === ActivityBarPosition.BOTTOM) {
			titlebar.setActivityActions({ bar: globalCompositeBar, showContextMenu: event => activitybar.showContextMenu(event) });
		}
		const createPaneComposite = (parent: HTMLElement, options: PaneCompositeOptions): PaneComposite => {
			const descriptor = options.viewContainer.ctorDescriptor;
			if (!descriptor) {
				return instantiationService.createInstance(PaneComposite, parent, options);
			}
			const composite = instantiationService.createInstance(descriptor, parent, options);
			if (!(composite instanceof PaneComposite)) {
				throw new TypeError(`View container did not create a PaneComposite: ${options.viewContainer.id}`);
			}
			return composite;
		};
		const openSidebarComposite = (
			compositeId: string,
		): PaneComposite => {
			const viewContainer = viewDescriptors
				.getViewContainers(ViewContainerLocation.Sidebar)
				.find((candidate) => candidate.id === compositeId);
			if (!viewContainer) {
				throw new Error(
					`Sidebar Composite is not registered: ${compositeId}`,
				);
			}
			if (!sidebar.getComposite(viewContainer.id)) {
				sidebar.addComposite(createPaneComposite(sidebar.domNode, {
					viewContainer,
					model: viewDescriptors.getViewContainerModel(viewContainer.id),
					instantiationService,
					contextKeyService: contextKeys,
					localizationService,
				}));
			}
			sidebar.showComposite(viewContainer.id);
			const composite = sidebar.getComposite(viewContainer.id);
			assertDefined(composite, `Sidebar Composite is not available: ${viewContainer.id}`);
			return composite;
		};
		const openAgentSidebarComposite = (
			compositeId: string,
		): PaneComposite => {
			const viewContainer = viewDescriptors
				.getViewContainers(ViewContainerLocation.AgentSidebar)
				.find((candidate) => candidate.id === compositeId);
			if (!viewContainer) {
				throw new Error(
					`Agent Sidebar Composite is not registered: ${compositeId}`,
				);
			}
			if (!agentSidebar.getComposite(viewContainer.id)) {
				agentSidebar.addComposite(createPaneComposite(agentSidebar.domNode, {
					viewContainer,
					model: viewDescriptors.getViewContainerModel(viewContainer.id),
					instantiationService,
					contextKeyService: contextKeys,
					localizationService,
				}));
			}
			agentSidebar.showComposite(viewContainer.id);
			const composite = agentSidebar.getComposite(viewContainer.id);
			assertDefined(composite, `Agent Sidebar Composite is not available: ${viewContainer.id}`);
			return composite;
		};
		const panel = this._register(new PanelPart(workbenchRoot, {
			viewDescriptorService: viewDescriptors,
			contextKeyService: contextKeys,
			storageService: storage,
			localizationService,
			contextMenuProvider: contextMenus,
			titleActions: {
				menuService: menus,
				contextMenuProvider: contextMenus,
				menuId: MenuId.PanelTitle,
			},
		}));
		this.editor = editorParts;
		const openPanelComposite = (
			compositeId: string,
		): PaneComposite => {
			const viewContainer = viewDescriptors
				.getViewContainers(ViewContainerLocation.Panel)
				.find((candidate) => candidate.id === compositeId);
			if (!viewContainer) {
				throw new Error(
					`Panel Composite is not registered: ${compositeId}`,
				);
			}
			if (!panel.getComposite(viewContainer.id)) {
				panel.addComposite(createPaneComposite(panel.domNode, {
					viewContainer,
					model: viewDescriptors.getViewContainerModel(viewContainer.id),
					instantiationService,
					contextKeyService: contextKeys,
					localizationService,
					paneHeaders: "hidden",
					paneLayout: "fill",
				}));
			}
			panel.showComposite(viewContainer.id);
			const composite = panel.getComposite(viewContainer.id);
			assertDefined(composite, `Panel Composite is not available: ${viewContainer.id}`);
			return composite;
		};
		const auxiliarybar = this._register(new AuxiliarybarPart(workbenchRoot, {
			viewDescriptorService: viewDescriptors,
			contextKeyService: contextKeys,
			storageService: storage,
			localizationService,
		}));
		const statusbar = this._register(new StatusbarPart(workbenchRoot, statusbarService));
		const parts = new Map<WorkbenchPartId, WorkbenchPart>([
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
		const openAuxiliaryComposite = (compositeId: string): PaneComposite => {
			const viewContainer = viewDescriptors
				.getViewContainers(ViewContainerLocation.AuxiliaryBar)
				.find((candidate) => candidate.id === compositeId);
			if (!viewContainer) {
				throw new Error(
					`Auxiliary Bar Composite is not registered: ${compositeId}`,
				);
			}
			if (!auxiliarybar.getComposite(viewContainer.id)) {
				auxiliarybar.addComposite(createPaneComposite(auxiliarybar.domNode, {
					viewContainer,
					model: viewDescriptors.getViewContainerModel(viewContainer.id),
					instantiationService,
					contextKeyService: contextKeys,
					localizationService,
					paneHeaders: "hidden",
					paneLayout: "fill",
				}));
			}
			auxiliarybar.showComposite(viewContainer.id);
			const composite = auxiliarybar.getComposite(viewContainer.id);
			assertDefined(composite, `Auxiliary Bar Composite is not available: ${viewContainer.id}`);
			return composite;
		};
		this.restoreActiveViewContainers = () => {
			openSidebarComposite(requiredViewContainerToRestore(
				viewDescriptors,
				ViewContainerLocation.Sidebar,
				sidebar.getCompositeIdToRestore(),
			).id);
			// Fixed Panel and Auxiliary Bar views may depend on the host layout during construction.
			openPanelComposite(requiredViewContainerToRestore(
				viewDescriptors,
				ViewContainerLocation.Panel,
				panel.getCompositeIdToRestore(),
			).id);
			openAuxiliaryComposite(requiredViewContainerToRestore(
				viewDescriptors,
				ViewContainerLocation.AuxiliaryBar,
				auxiliarybar.getCompositeIdToRestore(),
			).id);
			if (layout.isPartVisible("agentSidebar")) {
				openAgentSidebarComposite(requiredViewContainerToRestore(
					viewDescriptors,
					ViewContainerLocation.AgentSidebar,
					agentSidebar.getCompositeIdToRestore(),
				).id);
			}
		};
		this.restoreActiveViewContainers();
		const viewsService = new ViewsService({
			viewDescriptorService: viewDescriptors,
			getViewContainer: (container) => {
				switch (container.location) {
					case ViewContainerLocation.Sidebar: return sidebar.getComposite(container.id);
					case ViewContainerLocation.AuxiliaryBar: return auxiliarybar.getComposite(container.id);
					case ViewContainerLocation.AgentSidebar: return agentSidebar.getComposite(container.id);
					case ViewContainerLocation.Panel: return panel.getComposite(container.id);
				}
			},
			openViewContainer: (container) => {
				switch (container.location) {
					case ViewContainerLocation.Sidebar:
						layout.showPart("sidebar");
						return openSidebarComposite(container.id);
					case ViewContainerLocation.AuxiliaryBar:
						layout.showPart("auxiliarybar");
						return openAuxiliaryComposite(container.id);
					case ViewContainerLocation.AgentSidebar:
						layout.showPart("agentSidebar");
						return openAgentSidebarComposite(container.id);
					case ViewContainerLocation.Panel:
						layout.showPart("panel");
						return openPanelComposite(container.id);
				}
			},
		});
		services.registerInstance(IViewsService, viewsService);
		this._register(outputService.onDidRequestShowChannel(request => {
			if (request.focus === "take") viewsService.focusView(OUTPUT_VIEW_ID);
			else viewsService.openView(OUTPUT_VIEW_ID);
		}));
		this._register(sidebar.onDidSelectComposite(
			({ compositeId }) => {
				if (sidebar.activeCompositeId === compositeId && layout.isPartVisible("sidebar")) {
					layout.hidePart("sidebar");
					return;
				}
				layout.showPart("sidebar");
				if (sidebar.activeCompositeId === compositeId) return;
				openSidebarComposite(compositeId);
			},
		));
		this._register(agentSidebar.onDidSelectComposite(
			({ compositeId }) => {
				if (agentSidebar.activeCompositeId === compositeId) return;
				openAgentSidebarComposite(compositeId);
			},
		));
		this._register(panel.onDidSelectComposite(
			({ compositeId }) => {
				if (panel.activeCompositeId === compositeId) return;
				openPanelComposite(compositeId);
			},
		));
		lifecycleService.phase = LifecyclePhase.Ready;
		contributions.advance(WorkbenchPhase.BlockRestore);
		layoutService.layout();
		this.whenRestored = this.completeStartupRestoration([extensionReady, recentWorkspaces.initialize(), ...serviceContributionReady], workingCopyBackups, editor, editorParts, contributions, saveFontInfo);
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
				this.untitledTextEditorService.create({ untitledResource: backup.resource, initialText: backup.content, languageId: backup.languageId, label: backup.label });
			}
		}
		for (const backup of pending) {
			try {
				let pane;
				const untitled = backup.kind === "text" ? this.untitledTextEditorService.get(backup.resource) : undefined;
				if (untitled) {
					pane = await editor.openEditor(untitled);
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
		this.restoreActiveViewContainers?.();
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
