import { MarkerDecorationsService } from '../../editor/common/services/markerDecorationsService.js';
import { IMarkerDecorationsService } from '../../editor/common/services/markerDecorations.js';
import { IMemoriesService } from '../../platform/memories/common/memoriesService.js';
import { IMemoryDiagnosticsService } from '../../platform/memory/common/memoryDiagnosticsService.js';
import "./style.js";
import { IAutomationService } from '../../platform/automation/common/automationService.js';
import { IChatSessionNavigationService } from '../services/chat/common/chatSessionNavigationService.js';
import type { FsChanged } from "../../../../generated/app-server/index.js";
import { bindResizableLayout } from "../../base/browser/ui/resizable/resizable.js";
import { disposableWindowTimeout } from "../../base/browser/scheduler.js";
import { mainWindow } from "../../base/browser/window.js";
import {
	type IDisposable,
	Disposable,
} from "../../base/common/lifecycle.js";
import { CancellationError, getErrorMessage, onUnexpectedError, setUnexpectedErrorHandler } from "../../base/common/errors.js";
import { assertDefined } from "../../base/common/types.js";
import { WorkbenchModeRegistry, type WorkbenchModeId } from "../common/workbenchMode.js";
import { URI } from "../../base/common/uri.js";
import { AccessibilityService } from "../../platform/accessibility/browser/accessibilityService.js";
import { IAccessibilityService } from "../../platform/accessibility/common/accessibility.js";
import { ConsoleLogSink } from "../../platform/log/common/consoleLogSink.js";
import { ILogService } from "../../platform/log/common/log.js";
import { LogService } from "../../platform/log/common/logServiceImpl.js";
import { BrowserLifecycleService } from "../../platform/lifecycle/browser/browserLifecycleService.js";
import { ILifecycleService, type ShutdownReason } from "../../platform/lifecycle/common/lifecycleService.js";
import { IDebugAdapterProcessService } from "../../platform/debug/common/debugAdapterProcessService.js";
import { IExtensionHostApi } from "../../platform/extensionHost/common/extensionHostApi.js";
import { ISyntaxApi } from "../../platform/syntax/common/syntaxApi.js";
import type { IRendererHost } from "../../platform/renderer/common/rendererHost.js";
import { IRemoteConnectionService } from "../../platform/remote/common/remoteConnectionService.js";
import { UnavailableRemoteConnectionService } from "../../platform/remote/common/remoteConnectionService.js";
import { IRemoteTunnelService } from "../../platform/remote/common/remoteTunnelService.js";
import { UnavailableRemoteTunnelService } from "../../platform/remote/common/remoteTunnelService.js";
import type {
	INativeHostApi,
} from "../../platform/native/common/nativeHost.js";
import { MenuId } from "../../platform/actions/common/actions.js";
import type { IConfigurationApi } from "../../platform/configuration/common/configurationIpc.js";
import { IConfigurationResourceService } from "../../platform/configuration/common/configurationResourceService.js";
import { IConfigurationService } from "../../platform/configuration/common/configuration.js";
import { IStorageService, WillSaveStateReason } from "../../platform/storage/common/storage.js";
import { BrowserLayoutService } from "../../platform/layout/browser/layoutService.js";
import { ILayoutService } from "../../platform/layout/common/layoutService.js";
import "../../platform/layout/browser/zIndexRegistry.js";
import {
	ServiceContainer,
} from "../../platform/instantiation/common/instantiation.js";
import { BrowserNotificationService } from "../../platform/notification/browser/notificationService.js";
import { INotificationService } from "../../platform/notification/common/notification.js";
import { BrowserProgressService } from "../../platform/progress/browser/progressService.js";
import { IProgressService } from "../../platform/progress/common/progress.js";
import { MarkerService, IMarkerService } from "../../platform/markers/common/markers.js";
import type { IKeybindingsResourceApi } from "../../platform/keybinding/common/keybindingsResource.js";
import type { IKeyboardLayoutProvider } from "../../platform/keyboardLayout/common/keyboardLayout.js";
import {
	BrowserDialogHandler,
} from "../../platform/dialogs/browser/browserDialogHandler.js";
import {
	IDialogService,
} from "../../platform/dialogs/common/dialogs.js";
import {
	BrowserFileService,
} from "../../platform/files/browser/fileService.js";
import { MultiplexFileService } from "../../platform/files/browser/multiplexFileService.js";
import { IFileSystemProviderService } from "../../platform/files/common/fileSystemProviderService.js";
import {
	IFileService,
} from "../../platform/files/common/files.js";
import {
	bindColorTheme,
} from "../../platform/theme/browser/themeStyles.js";
import {
	IFileIconThemeService,
} from "../../platform/theme/browser/fileIconThemeService.js";
import {
	SetiFileIconThemeService,
} from "../../platform/theme/browser/setiFileIconTheme.js";
import { FileLabelDecorationService } from "../services/labels/browser/fileLabelDecorationService.js";
import { IFileLabelDecorationService } from "../services/labels/common/fileLabelDecorationService.js";
import {
	IThemeService,
	ThemeService,
} from "../../platform/theme/common/themeService.js";
import { type IWorkspace, IWorkspaceContextService, WorkbenchState, workbenchStateFromWorkspace, workspaceOpenTarget } from "../../platform/workspace/common/workspace.js";
import { WorkbenchConfiguration } from "../common/configuration.js";
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
import { resolveWorkbenchColorTheme } from "../common/theme.js";
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
import { AppServerSessionsManagementService } from "../../sessions/services/sessions/browser/appServerSessionsManagementService.js";
import { AppServerSessionsProvider } from "../../sessions/services/sessions/browser/appServerSessionsProvider.js";
import { ISessionsManagementService } from "../../sessions/services/sessions/common/sessionsManagementService.js";
import {
	WorkbenchConfigurationService,
} from "../services/configuration/browser/configurationService.js";
import {
	DialogService,
} from "../services/dialogs/common/dialogService.js";
import { WorkbenchContextKeysHandler } from './contextkeys.js';
import { WorkbenchThemeController } from "./theme.js";
import { IResourceLabelService, ResourceLabelService } from "./labels.js";
import { ILabelService, LabelService } from "../../platform/label/common/labelService.js";
import { WorkbenchLayout, type WorkbenchDefaultLayout } from "./layout.js";
import { IWorkbenchLayoutService, type WorkbenchPartId } from "../services/layout/browser/layoutService.js";
import { IWorkbenchLayoutStyleService } from "../services/layout/common/workbenchLayoutStyleService.js";
import { BrowserStorageService } from "../services/storage/browser/storageService.js";
import { SystemOutputService } from "../services/output/browser/systemOutputService.js";
import { IContentSearchService } from "../../platform/search/common/search.js";
import { BrowserContentSearchService } from "../../platform/search/browser/searchService.js";
import type { WorkbenchPart } from "./part.js";
import { AuxiliarybarPart } from "./parts/auxiliarybar/auxiliarybarPart.js";
import { EditorContextKeyController } from './parts/editor/editorContextKeys.js';
import { EditorPart, IEditorPart, type IEditorPartOptions } from "./parts/editor/editorPart.js";
import { EditorParts, IEditorPartsService } from "./parts/editor/editorParts.js";
import { EditorPanes } from './parts/editor/editorRegistry.js';
import { PanelPart } from "./parts/panel/panelPart.js";
import { SidebarPart } from "./parts/sidebar/sidebarPart.js";
import { StatusbarPart } from "./parts/statusbar/statusbarPart.js";
import type {
	TitlebarPartFactory,
} from "./parts/titlebar/titlebarPart.js";
import { PaneComposite } from "./parts/views/paneComposite.js";
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
import { ICodeEditorService } from '../../editor/browser/services/codeEditorService.js';
import { editorBrowserServices } from '../contrib/codeEditor/browser/browserEditorPart.js';
import { LanguageFeaturesService } from '../../editor/common/services/languageFeaturesService.js';
import { ILanguageService } from '../../editor/common/languages/language.js';
import { LanguageService } from '../../editor/common/services/languageService.js';
import { ILanguageConfigurationService, LanguageConfigurationService } from '../../editor/common/languages/languageConfigurationRegistry.js';
import { WorkbenchLanguageFeatures } from '../services/language/browser/workbenchLanguageFeatures.js';
import { GitService } from "../services/git/browser/gitService.js";
import { IGitService } from "../services/git/common/gitService.js";
import { ChatService } from "../services/chat/browser/chatService.js";
import { IChatService } from "../services/chat/common/chatService.js";
import { ICodebaseService } from "../../platform/codebase/common/codebaseService.js";
import { AppServerCodebaseService } from "../services/codebase/browser/appServerCodebaseService.js";
import { IToolSearchService } from "../../platform/toolSearch/common/toolSearchService.js";
import { IDirPermissionsService } from "../../platform/dirPermissions/common/dirPermissionsService.js";
import { IKeybindingsResourceService } from "../../platform/keybinding/common/keybindingsResource.js";
import { IKeyboardLayoutService } from "../../platform/keyboardLayout/common/keyboardLayout.js";
import { AppServerDirPermissionsService } from "../services/dirPermissions/browser/appServerDirPermissionsService.js";
import { IConnectorService } from "../../platform/connectors/common/connectorService.js";
import { AppServerConnectorService } from "../services/connectors/browser/appServerConnectorService.js";
import { IAccountService } from "../../platform/accounts/common/accountService.js";
import { AppServerAccountService } from "../services/accounts/browser/appServerAccountService.js";
import { IPluginService } from "../../platform/plugins/common/pluginService.js";
import { AppServerPluginService } from "../services/plugins/browser/appServerPluginService.js";
import { IMarketplaceService } from "../../platform/marketplace/common/marketplaceService.js";
import { AppServerMarketplaceService } from "../services/marketplace/browser/appServerMarketplaceService.js";
import { MarketplaceLanguagePackService } from "../../platform/languagePacks/browser/marketplaceLanguagePackService.js";
import { ILanguagePackService } from "../../platform/languagePacks/common/languagePacksService.js";
import { ILocaleService, WorkbenchLocaleService } from "../services/localization/common/locale.js";
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
import { IndexedDbWorkingCopyBackupService } from "../services/workingCopy/browser/indexedDbWorkingCopyBackupService.js";
import { WorkingCopyBackupTracker } from "../services/workingCopy/browser/workingCopyBackupTracker.js";
import { IWorkingCopyBackupService, type WorkingCopyBackup } from "../services/workingCopy/common/workingCopyBackupService.js";
import { projectExtensionTokenTheme } from "../services/textMate/common/textMateThemeProjection.js";
import { BrowserWorkspaceEditService } from "../services/language/browser/browserWorkspaceEditService.js";
import { IWorkspaceEditService } from "../services/language/common/workspaceEditService.js";
import { ITextModelResourceService } from "../../editor/common/services/textModelResourceService.js";
import { registerTreeViewsDnDService } from '../../editor/common/services/treeViewsDndService.js';
import { BrowserBulkEditService } from "../contrib/bulkEdit/browser/bulkEditService.js";
import { IBulkEditService } from "../../editor/browser/services/bulkEditService.js";
import { getBrowserTextModelService } from "../services/textmodelResolver/browser/browserTextModelService.js";
import { getBrowserTextResourceStore } from "../contrib/codeEditor/browser/browserTextResourceStore.js";
import { AppServerLanguageProviders } from "../services/language/browser/appServerLanguageProviders.js";
import { AppServerDiffService } from "../services/diff/browser/appServerDiffService.js";
import { IDiffService } from "../services/diff/common/diffService.js";
import { AppServerLanguageDiagnosticsService } from "../services/language/browser/appServerLanguageDiagnosticsService.js";
import { AppServerCodeIntelligenceDocumentService } from "../services/codeIntelligence/browser/appServerCodeIntelligenceDocumentService.js";
import { ICodeIntelligenceDocumentService } from "../services/codeIntelligence/common/codeIntelligenceDocumentService.js";
import { AppServerLanguageServerStatusService } from "../services/language/browser/appServerLanguageServerStatusService.js";
import { ILanguageServerStatusService } from "../services/language/common/languageServerStatusService.js";
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
import { type WorkbenchContextMenuServiceFactory, WorkbenchInteractionServices } from "./workbenchInteractionServices.js";
import { ConnectToRemoteCommandId } from "../contrib/remote/browser/remoteActions.js";
import type { IUserKeyboardLayoutApi } from "../../platform/keyboardLayout/common/userKeyboardLayout.js";
import { WorkbenchModeService } from "../services/workbenchMode/browser/workbenchModeService.js";
import { IWorkbenchModeService } from "../services/workbenchMode/common/workbenchModeService.js";
import { BrowserClipboardService } from "../../platform/clipboard/browser/browserClipboardService.js";
import { IClipboardService } from "../../platform/clipboard/common/clipboardService.js";

const DEFAULT_WORKBENCH_LAYOUT = {
	parts: {
		sidebar: false,
		auxiliarybar: false,
		agentSidebar: false,
		panel: false,
	},
} as const satisfies WorkbenchDefaultLayout;

/** Host-specific inputs required to construct a workbench. */
export interface IStartWorkbenchOptions {
	readonly modeId: WorkbenchModeId;
	readonly defaultLayout?: WorkbenchDefaultLayout;
	readonly api: IRendererHost;
	readonly container: HTMLElement;
	readonly workspace: IWorkspace;
	readonly configurationApi?: IConfigurationApi;
	readonly keybindingsResourceApi?: IKeybindingsResourceApi;
	readonly keyboardLayoutProvider?: IKeyboardLayoutProvider;
	readonly userKeyboardLayoutApi?: IUserKeyboardLayoutApi;
	readonly nativeHostApi?: INativeHostApi;
	readonly userThemeService?: IUserThemeServiceContract;
	readonly createContextMenuService: WorkbenchContextMenuServiceFactory;
	readonly createTitlebarPart: TitlebarPartFactory;
	readonly switchWorkbenchMode: (modeId: WorkbenchModeId) => Promise<void>;
}

/** Starts the browser workbench and binds its commands to the initial UI. */
export function startWorkbench({
	modeId,
	defaultLayout,
	api,
	container,
	workspace,
	configurationApi,
	keybindingsResourceApi,
	keyboardLayoutProvider,
	userKeyboardLayoutApi,
	nativeHostApi,
	userThemeService,
	createContextMenuService,
	createTitlebarPart,
	switchWorkbenchMode,
}: IStartWorkbenchOptions): Workbench {
	return new Workbench(
		modeId,
		defaultLayout,
		api,
		container,
		workspace,
		configurationApi,
		keybindingsResourceApi,
		keyboardLayoutProvider,
		userKeyboardLayoutApi,
		nativeHostApi,
		userThemeService,
		createContextMenuService,
		createTitlebarPart,
		switchWorkbenchMode,
	);
}

/** Owns the renderer workbench, its parts, commands, and runtime layout. */
export class Workbench extends Disposable {
	/** Resolves after dirty working copies are restored and AfterRestored contributions are active. */
	readonly whenRestored: Promise<void>;
	private readonly workspaceContext: WorkspaceContextService;
	private readonly storage: BrowserStorageService;
	private readonly editor: IEditorPartsService;
	private readonly workbenchLayout: WorkbenchLayout;
	private readonly workingCopyBackups: IndexedDbWorkingCopyBackupService;
	private readonly workingCopyBackupTracker: WorkingCopyBackupTracker;
	private readonly workbenchWindow: WorkbenchWindow;
	private readonly logService: ILogService;
	private readonly lifecycleService: ILifecycleService;
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
		configurationApi: IConfigurationApi | undefined,
		keybindingsResourceApi: IKeybindingsResourceApi | undefined,
		keyboardLayoutProvider: IKeyboardLayoutProvider | undefined,
		userKeyboardLayoutApi: IUserKeyboardLayoutApi | undefined,
		nativeHostApi: INativeHostApi | undefined,
		userThemeService: IUserThemeServiceContract | undefined,
		createContextMenuService: WorkbenchContextMenuServiceFactory,
		createTitlebarPart: TitlebarPartFactory,
		switchWorkbenchMode: (modeId: WorkbenchModeId) => Promise<void>,
	) {
		super();
		const mode = WorkbenchModeRegistry.get(modeId);
		const services = this._register(new ServiceContainer());
		registerTreeViewsDnDService(services);
		const instantiationService = services;
		const logService = this._register(new LogService({ sinks: [new ConsoleLogSink()] }));
		this.logService = logService;
		this.registerErrorHandler(logService);
		services.registerInstance(ILogService, logService);
		services.registerInstance(IExtensionHostApi, api.extensionHost);
		services.registerInstance(ICodebaseSymbolsApi, api.codebaseSymbols);
		services.registerInstance(ISyntaxApi, api.syntax);
		if (api.debugAdapter) services.registerInstance(IDebugAdapterProcessService, api.debugAdapter);
		if (api.memories) { services.registerInstance(IMemoriesService, api.memories); }
		if (api.memoryDiagnostics) { services.registerInstance(IMemoryDiagnosticsService, api.memoryDiagnostics); }
		if (api.automation) {
			services.registerInstance(IAutomationService, api.automation);
		}
		const remoteAgentService = this._register(new AppServerRemoteAgentService({ api: api.appServer, remoteApi: api.remote }));
		services.registerInstance(IRemoteAgentService, remoteAgentService);
		services.registerInstance(IRemoteConnectionService, api.remoteConnections ?? UnavailableRemoteConnectionService);
		services.registerInstance(IRemoteTunnelService, api.remoteTunnels ?? UnavailableRemoteTunnelService);
		if (nativeHostApi) {
			services.registerInstance(INativeHostService, nativeHostApi);
		}
		const workspaceOpenService = new WorkspaceOpenService(nativeHostApi);
		services.registerInstance(IWorkspaceOpenService, workspaceOpenService);
		const workspaceContext = this._register(new WorkspaceContextService(workspace));
		this.workspaceContext = workspaceContext;
		services.registerInstance(IWorkspaceContextService, workspaceContext);
		const labelService = this._register(new LabelService(workspaceContext));
		services.registerInstance(ILabelService, labelService);
		services.registerInstance(IFileLabelDecorationService, this._register(new FileLabelDecorationService()));
		const dirPermissionsService = new AppServerDirPermissionsService(api.dirPermissions);
		services.registerInstance(IDirPermissionsService, dirPermissionsService);
		const workspaceFileService = new BrowserFileService({
			api: api.fs,
			resourceApi: api.resource,
			workspaceContextService: workspaceContext,
			onDidChange: listener => {
				const subscription = api.events.subscribe(event => {
					if (event.method === "fs/changed") listener(event.params as FsChanged);
				});
				return {
					dispose: () => subscription.dispose(),
					[Symbol.dispose]: () => subscription.dispose(),
				};
			},
		});
		this._register(workspaceFileService);
		const fileService = this._register(new MultiplexFileService(workspaceFileService));
		services.registerInstance(IFileService, fileService);
		services.registerInstance(IFileSystemProviderService, fileService);
		const textFileService = new TextFileService(fileService);
		services.registerInstance(ITextFileService, textFileService);
		const untitledTextEditorService = this._register(new BrowserUntitledTextEditorService());
		services.registerInstance(IUntitledTextEditorService, untitledTextEditorService);
		const workingCopyService = this._register(new BrowserWorkingCopyService());
		services.registerInstance(IWorkingCopyService, workingCopyService);
		const workingCopyBackups = this._register(new IndexedDbWorkingCopyBackupService(workspace.id));
		this.workingCopyBackups = workingCopyBackups;
		services.registerInstance(IWorkingCopyBackupService, workingCopyBackups);
		const configuration = this._register(new WorkbenchConfigurationService({
			api: configurationApi,
		}));
		services.registerInstance(IConfigurationService, configuration);
		services.registerInstance(IConfigurationResourceService, configuration);
		const languageService = this._register(new LanguageService());
		services.registerInstance(ILanguageService, languageService);
		const languageConfigurationService = this._register(new LanguageConfigurationService(configuration, languageService));
		services.registerInstance(ILanguageConfigurationService, languageConfigurationService);
		const languageFeaturesService = this._register(new LanguageFeaturesService(languageConfigurationService));
		services.registerInstance(ILanguageFeaturesService, languageFeaturesService);
		services.registerInstance(ICodeEditorService, editorBrowserServices.codeEditorService);
		const textMateService = this._register(new BrowserTextMateService());
		services.registerInstance(ITextMateService, textMateService);
		const textResourceStore = getBrowserTextResourceStore(textFileService);
		const textModelService = this._register(getBrowserTextModelService(textResourceStore, {
			languageService,
			languageFeaturesService,
			syntaxService: { workerFactory: textMateService.syntaxWorkerFactory },
			onDidChangeLanguageSupport: textMateService.onDidChange,
		}));
		services.registerInstance(ITextModelResourceService, textModelService);
		const workspaceEditService = this._register(new BrowserWorkspaceEditService(textModelService, workingCopyService, fileService));
		services.registerInstance(IWorkspaceEditService, workspaceEditService);
		const bulkEditService = this._register(new BrowserBulkEditService(workspaceEditService));
		services.registerInstance(IBulkEditService, bulkEditService);
		this._register(new WorkbenchLanguageFeatures(languageService, languageConfigurationService, languageFeaturesService));
		this._register(new AppServerLanguageProviders(languageFeaturesService, api.language, workspaceContext, { dirPermissions: dirPermissionsService, events: api.events }));
		const diffService = new AppServerDiffService(api.diff);
		services.registerInstance(IDiffService, diffService);
		const codeIntelligenceDocuments = new AppServerCodeIntelligenceDocumentService(api.codebaseSymbols);
		services.registerInstance(ICodeIntelligenceDocumentService, codeIntelligenceDocuments);
		const languageDiagnosticsService = this._register(new AppServerLanguageDiagnosticsService(api.language, api.events, workspaceContext, codeIntelligenceDocuments, dirPermissionsService));
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
		const gitService = this._register(new GitService({ api: api.git, appServerApi: api.appServer, eventApi: api.events, workspaceContext }));
		services.registerInstance(IGitService, gitService);
		services.registerInstance(ICodebaseService, new AppServerCodebaseService(api.codebase));
		services.registerInstance(IConnectorService, this._register(new AppServerConnectorService(api.connectors, api.events)));
		services.registerInstance(IAccountService, this._register(new AppServerAccountService(api.accounts, api.events)));
		services.registerInstance(IPluginService, this._register(new AppServerPluginService(api.plugins, api.events)));
		const marketplaceService = this._register(new AppServerMarketplaceService(api.marketplace, api.events));
		services.registerInstance(IMarketplaceService, marketplaceService);
		services.registerInstance(IToolSearchService, new AppServerToolSearchService(api.toolSearch));
		const workbenchState = workspaceContext.getWorkbenchState();
		const workbenchWindow = this._register(new WorkbenchWindow({
			root: workbenchRoot,
			modeId,
			workbenchState,
		}));
		services.registerInstance(IWorkbenchHostService, workbenchWindow);
		const ownerDocument = workbenchWindow.ownerDocument;
		let workbenchLayout: WorkbenchLayout | undefined;
		const layoutService = this._register(new BrowserLayoutService({
			root: workbenchRoot,
			getContainerOffset: () => workbenchLayout?.mainContainerOffset ?? {
				top: 0,
				quickInputTop: 0,
			},
			focus: () => this.editor.focus(),
		}));
		services.registerInstance(ILayoutService, layoutService);

		const chatService = this._register(new ChatService({ modelApi: api.model, threadApi: api.thread, turnApi: api.turn, turnChangesApi: api.turnChanges, skillApi: api.skills, appServerApi: api.appServer, eventApi: api.events, configurationService: configuration }));
		services.registerInstance(IChatService, chatService);
		const languagePackService = this._register(new MarketplaceLanguagePackService(marketplaceService, builtinLanguagePackCatalogs));
		services.registerInstance(ILanguagePackService, languagePackService);
		const localeService = this._register(new WorkbenchLocaleService(configuration, languagePackService));
		services.registerInstance(ILocaleService, localeService);
		const localizationService = this._register(new WorkbenchLocalizationService(localeService, languagePackService));
		services.registerInstance(ILocalizationService, localizationService);
		const ownerWindow = ownerDocument.defaultView;
		if (!ownerWindow) {
			throw new Error("Workbench requires an owner window");
		}
		this.ownerWindow = ownerWindow;
		const notificationService = this._register(new BrowserNotificationService(workbenchRoot));
		services.registerInstance(INotificationService, notificationService);
		const progressService = this._register(new BrowserProgressService(workbenchRoot));
		services.registerInstance(IProgressService, progressService);
		services.registerInstance(IClipboardService, new BrowserClipboardService(ownerWindow.navigator.clipboard));
		const lifecycleService = this._register(new BrowserLifecycleService({ ownerWindow, onError: error => logService.error("lifecycle", "Workbench shutdown failed", error) }));
		this.lifecycleService = lifecycleService;
		services.registerInstance(ILifecycleService, lifecycleService);
		services.registerInstance(IWorkbenchModeService, this._register(new WorkbenchModeService({
			currentModeId: modeId,
			configurationService: configuration,
			lifecycleService,
			switchHostMode: switchWorkbenchMode,
		})));
		const workingCopyBackupTracker = this._register(new WorkingCopyBackupTracker(workingCopyService, workingCopyBackups, ownerWindow));
		this.workingCopyBackupTracker = workingCopyBackupTracker;
		const storage = this._register(new BrowserStorageService({
			ownerWindow,
			applicationId: mode.storageNamespace,
			workspaceId: workspace.id,
		}));
		this.workbenchWindow = workbenchWindow;
		this.storage = storage;
		services.registerInstance(IStorageService, storage);
		const recentWorkspaces = this._register(new RecentWorkspacesService(storage, workspaceContext, workspaceOpenService));
		services.registerInstance(IRecentWorkspacesService, recentWorkspaces);
		this._register(lifecycleService.onWillShutdown(event => {
			event.join(workingCopyBackupTracker.flush(), "working-copy backup flush");
			event.join(storage.flush(WillSaveStateReason.SHUTDOWN), "Workbench storage flush");
		}));
		const outputService = this._register(new OutputService({ storageService: storage }));
		services.registerInstance(IOutputService, outputService);
		const systemOutputService = this._register(new SystemOutputService(outputService, api.appServer));
		this._register(logService.registerSink(systemOutputService));
		const serviceContributionReady: Promise<void>[] = [];
		installWorkbenchServiceContributions({ container: services, register: value => this._register(value), blockRestorationUntil: operation => serviceContributionReady.push(operation) });
		services.registerInstance(IAccessibleViewInformationService, this._register(new AccessibleViewInformationService(storage)));
		const themeService = this._register(new ThemeService(
			resolveWorkbenchColorTheme(
				configuration.getValue(WorkbenchConfiguration.colorTheme),
				ownerWindow.matchMedia("(prefers-color-scheme: dark)").matches,
			),
		));
		services.registerInstance(IThemeService, themeService);
		let textMateThemeRevision = 0;
		const updateTextMateTheme = (): void => {
			const model = textMateService.mutableScopeTheme;
			if (!model) return;
			const activeTheme = themeService.getColorTheme();
			try { model.replace(projectExtensionTokenTheme(extensionService.themes.currentCatalog, activeTheme.colorScheme, ++textMateThemeRevision, activeTheme.id)); }
			catch (error) { logService.error("theme", "Failed to apply extension token theme", error); }
		};
		this._register(extensionService.themes.onDidChange(() => updateTextMateTheme()));
		this._register(themeService.onDidColorThemeChange(() => updateTextMateTheme()));
		services.registerInstance(IUserThemeService, userThemeService ?? UnavailableUserThemeService);
		const fileIconThemeService = this._register(new SetiFileIconThemeService(themeService));
		services.registerInstance(IFileIconThemeService, fileIconThemeService);
		services.registerInstance(IResourceLabelService, this._register(new ResourceLabelService({
			workspaceContextService: workspaceContext,
			fileIconThemeService,
			untitledTextEditorService,
			fileLabelDecorationService: services.get(IFileLabelDecorationService),
			labelService,
		})));
		const workbenchThemeController = this._register(new WorkbenchThemeController(
			configuration,
			themeService,
			ownerWindow,
		));
		this._register(extensionService.onDidChange(() => workbenchThemeController.refresh()));
		this._register(bindColorTheme(themeService, workbenchRoot));
		const statusbarService = this._register(new StatusbarService());
		services.registerInstance(IStatusbarService, statusbarService);
		const dialogService = this._register(new DialogService());
		services.registerInstance(IDialogService, dialogService);
		services.registerInstance(IDialogsModel, dialogService.model);
		const languageServerStatusService = this._register(new AppServerLanguageServerStatusService(api.events, dialogService, outputService, statusbarService, workspaceContext));
		services.registerInstance(ILanguageServerStatusService, languageServerStatusService);
		services.registerInstance(
			IWorkbenchDialogHandler,
			new BrowserDialogHandler(workbenchRoot),
		);
		const interactionServices = this._register(new WorkbenchInteractionServices({
			container: services,
			layoutService,
			configurationService: configuration,
			keybindingsResourceApi,
			keyboardLayoutProvider,
			userKeyboardLayoutApi,
			statusbarService,
			notificationService,
			createContextMenuService,
		}));
		const commands = interactionServices.commandService;
		const contextKeys = interactionServices.contextKeyService;
		const menus = interactionServices.menuService;
		const contextViews = interactionServices.contextViewService;
		const contextMenus = interactionServices.contextMenuService;
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
		const viewDescriptors = this._register(new ViewDescriptorService({
			contextKeyService: contextKeys,
		}));
		services.registerInstance(IViewDescriptorService, viewDescriptors);
		const sessionService = this._register(new AppServerSessionsManagementService(new AppServerSessionsProvider({
			session: api.session,
			model: api.model,
			turn: api.turn,
			events: api.events,
		})));
		services.registerInstance(ISessionsManagementService, sessionService);
		services.registerInstance(IChatSessionNavigationService, {
			getConversations: () => sessionService.sessions.filter(session => session.status === 'active').flatMap(session =>
				session.chats.filter(chat => chat.status === 'active').map(chat => ({ sessionId: session.sessionId, threadId: chat.threadId, title: `${session.title} · ${chat.title ?? 'Conversation'}` }))),
			openConversation: (sessionId, threadId) => sessionService.openThread(sessionId, threadId),
		});
		const keybindings = interactionServices.keybindingService;
		const contributions = this._register(
			WorkbenchContributionsRegistry.createHost(services),
		);
		contributions.advance(WorkbenchPhase.BlockStartup);

		const titlebar = this._register(createTitlebarPart(workbenchRoot, {
			menuService: menus,
			contextMenuService: contextMenus,
			localizationService,
		}));
		const sidebar = this._register(new SidebarPart(workbenchRoot, {
			viewDescriptorService: viewDescriptors,
			contextKeyService: contextKeys,
			storageService: storage,
			localizationService,
			ariaLabelKey: { bundle: "ash.regions", key: "primarySidebar" },
			viewsAriaLabelKey: { bundle: "ash.regions", key: "primarySidebarViews" },
		}));
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
		const welcomeRecentProjects = () => recentWorkspaces.recentWorkspaces.map(project => ({
			name: project.name,
			path: project.path,
			...(workspaceOpenService.canOpenWorkspace ? {
				onOpen: () => recentWorkspaces.openWorkspace(project.root),
			} : {}),
		}));
		const editorOptions: IEditorPartOptions = {
			configurationService: configuration,
			contextKeyService: contextKeys,
			keybindingService: keybindings,
			keybindingsResourceService: services.get(IKeybindingsResourceService),
			keyboardLayoutService: services.get(IKeyboardLayoutService),
			fileService,
			textFileService,
			textMateService,
			languageFeaturesService,
			languageConfigurationService,
			languageResolver: languageService,
			diffService,
			instantiationService,
			accessibilityService,
			languageDiagnosticsService,
			documentCollaborationApi: api.documentCollaboration,
			serverEvents: api.events,
			workingCopyService,
			dialogService,
			bulkEditService,
			saveAsResource: nativeHostApi
				? async (defaultName) => {
					const filePath = await nativeHostApi.saveFile({ defaultName });
					return filePath ? URI.file(filePath) : undefined;
				}
				: undefined,
			titleActions: {
				menuService: menus,
				contextMenuProvider: contextMenus,
			},
			welcomeVisible: workbenchState === WorkbenchState.EMPTY,
			welcome: {
				productName: mode.title,
				recentProjects: welcomeRecentProjects(),
				actions: {
					openFolder: workspaceOpenService.canOpenFolder
						? () => workspaceOpenService.openFolder()
						: undefined,
					connectViaSsh: () => commands.executeCommand(ConnectToRemoteCommandId),
				},
			},
		};
		const editor = this._register(new EditorPart(workbenchRoot, editorOptions));
		const auxiliaryWindows = this._register(new BrowserAuxiliaryWindowService(ownerWindow));
		services.registerInstance(IAuxiliaryWindowService, auxiliaryWindows);
		const editorParts = this._register(new EditorParts(editor, auxiliaryWindows, container => {
			const contextKeyService = contextKeys.createScoped(container);
			return {
				part: new EditorPart(container, {
					...editorOptions,
					contextKeyService,
					welcomeVisible: false,
				}),
				resources: [contextKeyService],
			};
		}));
		services.registerInstance(IEditorPartsService, editorParts);
		this._register(new EditorContextKeyController(contextKeys, editorParts, EditorPanes, languageService));
		services.registerInstance(IEditorPart, editorParts);
		const editorService = this._register(new BrowserEditorService(editorParts));
		services.registerInstance(IEditorService, editorService);
		services.registerInstance(IEditorGroupsService, editorService);
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
				sidebar.addComposite(new PaneComposite(sidebar.domNode, {
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
				agentSidebar.addComposite(new PaneComposite(agentSidebar.domNode, {
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
		this._register(recentWorkspaces.onDidChange(() => {
			editor.setWelcomeRecentProjects(welcomeRecentProjects());
		}));
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
				panel.addComposite(new PaneComposite(panel.domNode, {
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
			["sidebar", sidebar],
			["auxiliarybar", auxiliarybar],
			["agentSidebar", agentSidebar],
			["editor", editor],
			["panel", panel],
		]);
		const layout = this._register(new WorkbenchLayout(workbenchRoot, parts, {
			initialDimension: layoutService.mainContainerDimension,
			fallbackPartVisibility: DEFAULT_WORKBENCH_LAYOUT.parts,
			defaultLayout,
			storageService: storage,
			layoutStyle: configuration.getValue(WorkbenchConfiguration.layoutStyle),
		}));
		workbenchLayout = layout;
		this.workbenchLayout = layout;
		services.registerInstance(IWorkbenchLayoutService, layout);
		services.registerInstance(IWorkbenchLayoutStyleService, layout);
		this._register(new WorkbenchContextKeysHandler(contextKeys, workspaceContext, editorService, editorService, layout, workingCopyService));
		this._register(bindResizableLayout(layoutService.onDidLayoutMainContainer, layout));
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
				auxiliarybar.addComposite(new PaneComposite(auxiliarybar.domNode, {
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
		void sessionService.initialize();
		contributions.advance(WorkbenchPhase.BlockRestore);
		layoutService.layout();
		this.whenRestored = this.completeStartupRestoration([extensionReady, ...serviceContributionReady], workingCopyBackups, editor, contributions);
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

	private async completeStartupRestoration(extensionReady: readonly Promise<void>[], backups: IWorkingCopyBackupService, editor: IEditorPart, contributions: WorkbenchContributionHost): Promise<void> {
		await Promise.allSettled(extensionReady);
		if (this.isDisposed) return;
		await this.restoreWorkingCopyBackups(backups, editor);
		if (this.isDisposed) return;
		contributions.advance(WorkbenchPhase.AfterRestored);
		this._register(disposableWindowTimeout(this.ownerWindow, () => contributions.advance(WorkbenchPhase.Eventually), 2_000));
	}

	private async restoreWorkingCopyBackups(backups: IWorkingCopyBackupService, editor: IEditorPart): Promise<void> {
		let pending: readonly WorkingCopyBackup[];
		try { pending = await backups.list(); }
		catch (error) { this.logService.error("workingCopy", "Failed to list working-copy backups", error); return; }
		for (const backup of pending) {
			try {
				let pane;
				try {
					pane = await editor.openEditor({ resource: backup.resource, ...(backup.languageId ? { languageId: backup.languageId } : {}), ...(backup.contentType ? { contentType: backup.contentType } : {}), ...(backup.label ? { label: backup.label } : {}) });
				} catch {
					pane = await editor.openEditor({ resource: backup.resource, initialText: "", ...(backup.languageId ? { languageId: backup.languageId } : {}), ...(backup.contentType ? { contentType: backup.contentType } : {}), ...(backup.label ? { label: backup.label } : {}) });
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
		if (!await this.editor.closeAllEditors({ reason: "reset" })) throw new CancellationError("Workspace switch was cancelled");
		await this.workingCopyBackupTracker.flush();
		this.workingCopyBackups.switchWorkspace(workspace.id);
		await this.storage.flush(WillSaveStateReason.WORKSPACE_CHANGE);
		this.storage.switchWorkspace(workspace.id);
		const nextWorkbenchState = workbenchStateFromWorkspace(workspace);
		this.workbenchWindow.setWorkbenchState(nextWorkbenchState);
		this.workspaceContext.updateWorkspace(workspace);
		this.editor.setWelcomeVisible(nextWorkbenchState === WorkbenchState.EMPTY);
		this.workbenchLayout.restoreWorkspaceState();
		this.restoreActiveViewContainers?.();
		await this.restoreWorkingCopyBackups(this.workingCopyBackups, this.editor);
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
