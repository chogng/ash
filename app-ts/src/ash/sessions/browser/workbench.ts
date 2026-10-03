import { ITextModelService } from '../../editor/common/services/resolverService.js';
import { TextModelResolverService } from '../../workbench/services/textmodelResolver/common/textModelResolverService.js';
import { IWorkspaceEditService } from '../../workbench/services/language/common/workspaceEditService.js';
import { BrowserWorkspaceEditService } from '../../workbench/services/language/browser/browserWorkspaceEditService.js';
import { IBulkEditService } from '../../editor/browser/services/bulkEditService.js';
import { BulkEditService } from '../../workbench/contrib/bulkEdit/browser/bulkEditService.js';
import { IChatEditingService } from '../../workbench/contrib/chat/common/editing/chatEditingService.js';
import { ChatEditingService } from '../../workbench/contrib/chat/browser/chatEditing/chatEditingServiceImpl.js';
import { IHostService } from '../../workbench/services/host/browser/host.js';
import { ServiceCollection } from '../../platform/instantiation/common/serviceCollection.js';
import { getSingletonServiceDescriptors } from '../../platform/instantiation/common/extensions.js';
import { ILanguagePackStore } from "../../platform/languagePacks/common/languagePackStore.js";
import { IAssetService, type AssetVersion } from '../../platform/assets/common/assetService.js';
import { IApprovalEnvironmentService } from '../../platform/approvalEnvironment/common/approvalEnvironmentService.js';
import { ActionWidgetService, IActionWidgetService } from '../../platform/actionWidget/browser/actionWidget.js';
import { IModelApi as ModelApiId } from '../../platform/sessions/common/sessionApi.js';
import { IsSessionsWindowContext, WorkspaceFolderCountContext } from '../../workbench/common/contextkeys.js';
import { IAppServerApi as AppServerApiId, IServerEventApi as ServerEventApiId } from '../../platform/app-server/common/appServerApi.js';
import { ILanguageModelsService, LanguageModelsService } from '../../workbench/contrib/chat/common/languageModels.js';
import { ILanguageModelsConfigurationService } from '../../workbench/contrib/chat/common/languageModelsConfiguration.js';
import { LanguageModelsConfigurationService } from '../../workbench/contrib/chat/browser/languageModelsConfigurationService.js';
import { MarketplaceLanguagePackService } from '../../platform/languagePacks/browser/marketplaceLanguagePackService.js';
import { ILanguagePackService } from '../../platform/languagePacks/common/languagePacksService.js';
import { ILocaleService } from '../../workbench/services/localization/common/locale.js';
import { WorkbenchLocaleService } from '../../workbench/services/localization/browser/localeService.js';
import { ILocalizationService } from '../../workbench/services/localization/common/localizationService.js';
import { WorkbenchLocalizationService } from '../../workbench/services/localization/browser/workbenchLocalizationService.js';
import { builtinLanguagePackCatalogs } from '../../workbench/services/localization/common/localizationCatalogs.js';
import { IHooksService } from '../../platform/hooks/common/hooksService.js';
import { ISkillService } from '../../platform/skills/common/skillService.js';
import { IMarketplaceService, OPEN_MARKETPLACE_COMMAND_ID, OPEN_PLUGINS_COMMAND_ID, type MarketplaceOpenOptions } from '../../platform/marketplace/common/marketplaceService.js';
import { AppServerMarketplaceService } from '../../workbench/services/marketplace/browser/appServerMarketplaceService.js';
import { IRemoteAgentService } from '../../workbench/services/remote/common/remoteAgentService.js';
import { AppServerRemoteAgentService } from '../../workbench/services/remote/browser/appServerRemoteAgentService.js';
import { IChatSessionNavigationService } from '../../workbench/services/chat/common/chatSessionNavigationService.js';
import '../../workbench/contrib/chat/browser/actions/chatSpeechToTextActions.js';
import '../../workbench/contrib/quickaccess/browser/quickAccess.contribution.js';
import { IDictationService } from '../../platform/dictation/common/dictationService.js';
import { ChatSpeechToTextService, IChatSpeechToTextService } from '../../workbench/contrib/chat/browser/speechToText/chatSpeechToTextService.js';
import { DictationOnboardingService, IDictationOnboardingService } from '../../workbench/contrib/chat/browser/speechToText/dictationOnboarding.js';
import "../../workbench/browser/style.js";
import "./media/workbench.css";
import "./actions/sessionsChatActions.js";
import "./actions/approvalEnvironmentActions.js";
import './activityBarAccessibility.js';
import '../../workbench/contrib/accessibility/browser/accessibilityConfiguration.js';
import '../../workbench/browser/parts/notifications/notificationsCommands.js';
import '../../workbench/contrib/accessibility/browser/accessibleViewActions.js';
import { Dimension, getClientArea, h, type IDimension } from "../../base/browser/dom.js";
import type { IPositionedRectangle } from '../../base/browser/geometry.js';
import { SerializableGrid, type SerializedGridDescriptor } from '../../base/browser/ui/grid/grid.js';
import { Emitter, type Event } from '../../base/common/event.js';
import { WorkbenchPartView } from '../../workbench/browser/workbenchPartView.js';
import { SessionsLayoutPolicy } from './layoutPolicy.js';
import { DockedAuxiliaryBarController } from './dockedAuxiliaryBarController.js';
import { SessionsViewRegistry } from '../common/views.js';
import { ViewContainerLocation } from '../../workbench/common/views.js';
import { DesignEditorService, IDesignEditorService } from '../contrib/design/browser/designEditorService.js';
import { sessionsPartIds, SESSION_SIDEBAR_DEFAULT_WIDTH, SESSION_AUXILIARYBAR_DEFAULT_WIDTH, type SessionsPartId } from '../common/layoutConstants.js';
import { Disposable, toDisposable, type IDisposable } from "../../base/common/lifecycle.js";
import { ILanguageService } from "../../editor/common/languages/language.js";
import { LanguageService } from "../../editor/common/services/languageService.js";
import { localize } from '../../nls.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId, IAccessibleViewService } from '../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../platform/accessibility/browser/accessibleViewRegistry.js';
import type { IConfigurationApi, IConfigurationSnapshot } from "../../platform/configuration/common/configurationIpc.js";
import { IConfigurationService } from "../../platform/configuration/common/configuration.js";
import { ContextKeyExpr } from '../../platform/contextkey/common/contextkey.js';
import { refineServiceDecorator, type IInstantiationService } from "../../platform/instantiation/common/instantiation.js";
import { InstantiationService } from "../../platform/instantiation/common/instantiationService.js";
import { ILocalTranscriptionService } from '../../platform/localTranscription/common/localTranscription.js';
import { NullLocalTranscriptionService } from '../../workbench/services/localTranscription/browser/localTranscriptionService.js';
import { ICodeEditorService } from '../../editor/browser/services/codeEditorService.js';
import { StandaloneCodeEditorService } from '../../editor/standalone/browser/standaloneCodeEditorService.js';
import { ILanguageConfigurationService, LanguageConfigurationService } from '../../editor/common/languages/languageConfigurationRegistry.js';
import { ILanguageFeaturesService } from '../../editor/common/services/languageFeatures.js';
import { LanguageFeaturesService } from '../../editor/common/services/languageFeaturesService.js';
import { NewChatInputWidget } from '../contrib/chat/browser/newChatInput.js';
import { ChatTipService, IChatTipService } from '../../workbench/contrib/chat/browser/chatTipService.js';
import { migrateNewChatDraftState, writeNewChatDraftState } from '../contrib/chat/common/newChatDraftState.js';
import { IAccessibilityService } from '../../platform/accessibility/common/accessibility.js';
import { AccessibilityService } from '../../platform/accessibility/browser/accessibilityService.js';
import { ILogService } from '../../platform/log/common/log.js';
import { WorkbenchContributionsRegistry, WorkbenchPhase, type WorkbenchContributionHost } from '../../workbench/common/contributions.js';
import type { LogService } from '../../platform/log/common/logServiceImpl.js';
import type { IKeybindingsResourceApi } from "../../platform/keybinding/common/keybindingsResource.js";
import { BrowserLayoutService, ILayoutService, type ILayoutOffsetInfo } from "../../platform/layout/browser/layoutService.js";
import { ILifecycleService, LifecyclePhase, type ShutdownReason } from "../../workbench/services/lifecycle/common/lifecycle.js";
import { NotificationService } from "../../workbench/services/notification/common/notificationService.js";
import { INotificationsCenter, NotificationsCenter } from "../../workbench/browser/parts/notifications/notificationsCenter.js";
import { INotificationService } from "../../platform/notification/common/notification.js";
import type { IRendererHost } from "../../platform/renderer/common/rendererHost.js";
import type { INativeHostApi, IOpenAgentsWindowOptions } from '../../platform/native/common/nativeHost.js';
import { IStorageService, WillSaveStateReason, StorageScope, StorageTarget } from "../../platform/storage/common/storage.js";
import { IThemeService } from "../../platform/theme/common/themeService.js";
import { WorkbenchState, IWorkspaceContextService, type IWorkspace } from "../../platform/workspace/common/workspace.js";
import { SessionsWorkspaceContextService } from '../services/workspace/browser/workspaceContextService.js';
import { SessionFileService } from '../contrib/providers/appServer/browser/sessionFileService.js';
import { IFileService } from '../../platform/files/common/files.js';
import { ISystemFileTransferService } from '../../platform/files/common/systemFileTransferService.js';
import { IClipboardService } from '../../platform/clipboard/common/clipboardService.js';
import { IDialogService, IFileDialogService } from '../../platform/dialogs/common/dialogs.js';
import type { HTMLFileSystemProvider } from '../../platform/files/browser/htmlFileSystemProvider.js';
import { MultiplexFileService } from '../../platform/files/browser/multiplexFileService.js';
import { DialogService } from '../../workbench/services/dialogs/common/dialogService.js';
import { BrowserDialogHandler } from '../../workbench/browser/parts/dialogs/dialog.js';
import { DialogHandlerContribution } from '../../workbench/browser/parts/dialogs/dialog.web.contribution.js';
import { ILabelService, LabelService } from '../../platform/label/common/labelService.js';
import { IResourceIconRenderer, IResourceLabelService, ResourceLabelService } from '../../workbench/browser/labels.js';
import { IDecorationsService } from '../../workbench/services/decorations/common/decorations.js';
import { DecorationsService } from '../../workbench/services/decorations/browser/decorationsService.js';
import { ITextFileService, TextFileService } from '../../workbench/services/textfile/common/textFileService.js';
import { IWorkingCopyService } from '../../workbench/services/workingCopy/common/workingCopyService.js';
import { BrowserWorkingCopyService } from '../../workbench/services/workingCopy/browser/browserWorkingCopyService.js';
import { IUntitledTextEditorService } from '../../workbench/services/untitled/common/untitledTextEditorService.js';
import { BrowserUntitledTextEditorService } from '../../workbench/services/untitled/browser/browserUntitledTextEditorService.js';
import { IExplorerService } from '../../workbench/contrib/files/browser/files.js';
import { ExplorerService } from '../../workbench/contrib/files/browser/explorerService.js';
import { TextFileEditorTracker } from '../../workbench/contrib/files/browser/editors/textFileEditorTracker.js';
import { ITextModelResourceService, IFileTextModelService } from '../../workbench/services/textmodelResolver/common/textModelResourceService.js';
import { getBrowserTextModelService } from '../../workbench/services/textmodelResolver/browser/browserTextModelService.js';
import { getBrowserTextResourceStore } from '../../workbench/contrib/codeEditor/browser/browserTextResourceStore.js';
import { BrowserTextMateService } from '../../workbench/services/textMate/browser/browserTextMateService.js';
import { ITextMateService } from '../../workbench/services/textMate/common/textMateService.js';
import { DiffService } from '../../workbench/services/diff/browser/diffService.js';
import { EditorPart, IEditorPart } from '../../workbench/browser/parts/editor/editorPart.js';
import { IMultiDiffSourceResolverService, MultiDiffSourceResolverService } from '../../workbench/contrib/multiDiffEditor/browser/multiDiffSourceResolverService.js';
import { BrowserEditorService } from '../../workbench/services/editor/browser/browserEditorService.js';
import { IEditorService } from '../../workbench/services/editor/common/editorService.js';
import { IEditorGroupsService } from '../../workbench/services/editor/common/editorGroupsService.js';
import { IViewDescriptorService, ViewDescriptorService } from '../../workbench/services/views/common/viewDescriptorService.js';
import { IViewsService, ViewsService } from '../../workbench/services/views/browser/viewsService.js';
import type { SessionWorkspaceSelection } from '../services/sessions/common/session.js';
import { pickWorkspaceFolder } from './workspaceSelection.js';
import type { WorkbenchPart } from "../../workbench/browser/part.js";
import type { ContextMenuServiceFactory } from "../../platform/contextview/browser/contextMenuService.js";
import { setHoverDelegate } from "../../base/browser/ui/hover/hoverDelegate.js";
import { IMenuService } from "../../platform/actions/common/actions.js";
import { MenuService } from "../../platform/actions/common/menuService.js";
import { CommandsRegistry, ICommandService } from "../../platform/commands/common/commands.js";
import { IContextKeyService, ContextKeyService } from "../../platform/contextkey/browser/contextKeyService.js";
import { IContextMenuService, IContextViewService } from "../../platform/contextview/browser/contextView.js";
import { BrowserContextViewService } from "../../platform/contextview/browser/contextViewService.js";
import { HoverService, IHoverService } from "../../platform/hover/browser/hoverService.js";
import { IKeybindingService } from "../../platform/keybinding/common/keybinding.js";
import { IKeyboardLayoutService } from "../../platform/keyboardLayout/common/keyboardLayout.js";
import { IUserKeyboardLayoutService, UnavailableUserKeyboardLayoutService } from "../../platform/keyboardLayout/common/userKeyboardLayout.js";
import { IKeybindingsResourceService } from "../../platform/keybinding/common/keybindingsResource.js";
import { IQuickInputService } from "../../platform/quickinput/common/quickInput.js";
import { IQuickAccessController } from "../../platform/quickinput/common/quickAccess.js";
import { QuickAccessController } from "../../platform/quickinput/browser/quickAccess.js";
import { IOpenerService } from "../../platform/opener/common/openerService.js";
import { BrowserOpenerService } from "../../platform/opener/browser/browserOpenerService.js";
import { CommandService } from "../../workbench/services/commands/common/commandService.js";
import { BrowserKeyboardLayoutService } from "../../workbench/services/keybinding/browser/keyboardLayoutService.js";
import { WorkbenchKeybindingService } from "../../workbench/services/keybinding/browser/keybindingService.js";
import { IKeyboardShortcutTroubleshootingService } from "../../workbench/services/keybinding/common/keyboardShortcutTroubleshooting.js";
import { WorkbenchKeybindingsResourceService } from "../../workbench/services/keybinding/browser/keybindingsResourceService.js";
import { KeybindingsResourceContribution } from '../../workbench/services/keybinding/browser/keybindingsResourceContribution.js';
import { IPreferencesService } from "../../workbench/services/preferences/common/preferences.js";
import { PreferencesService } from "../../workbench/services/preferences/browser/preferencesService.js";
import { WorkbenchQuickInputService } from "../../workbench/services/quickinput/browser/quickInputService.js";
import { ChatContextPickService } from "../../workbench/services/chat/browser/chatContextPickService.js";
import { IChatContextPickService } from "../../workbench/services/chat/common/chatContextService.js";
import { WorkbenchWindow } from "../../workbench/browser/window.js";
import { AccessibleViewService } from '../../workbench/contrib/accessibility/browser/accessibleView.js';
import { IAccountService } from '../../platform/accounts/common/accountService.js';
import { BrowserClipboardService } from '../../platform/clipboard/browser/clipboardService.js';
import { INativeHostService } from '../../workbench/common/services.js';
import { WorkbenchModeRegistry, type WorkbenchModeId } from "../../workbench/common/workbenchMode.js";
import { ActivityBarPosition } from '../../workbench/common/configuration.js';
import { ChatService } from "../../workbench/services/chat/browser/chatService.js";
import { AppServerAccountService } from '../../workbench/services/accounts/browser/appServerAccountService.js';
import { IChatService } from "../../workbench/services/chat/common/chatService.js";
import { WorkbenchConfigurationService } from "../../workbench/services/configuration/browser/configurationService.js";
import { ExtensionColorThemeService } from "../../workbench/services/extensions/browser/extensionColorThemeService.js";
import type { BrowserStorageServiceOptions } from "../../workbench/services/storage/browser/storageService.js";
import { IWorkbenchHostService } from "../../workbench/services/host/common/workbenchHostService.js";
import { WorkbenchThemeService } from "../../workbench/services/themes/browser/workbenchThemeService.js";
import { IHostColorSchemeService } from '../../workbench/services/themes/common/hostColorSchemeService.js';
import { AppServerSessionsProvider } from "../contrib/providers/appServer/browser/appServerSessionsProvider.js";
import { AppServerTeamsProvider } from '../contrib/providers/appServer/browser/appServerTeamsProvider.js';
import { TeamsManagementService } from '../services/teams/browser/teamsManagementService.js';
import { ITeamsManagementService } from '../services/teams/common/teamsManagement.js';
import { SessionsAccountMenu } from '../contrib/accounts/browser/sessionsAccountMenu.js';
import { SessionsModernUIContribution } from '../contrib/modernUI/browser/modernUI.contribution.js';
import { SessionsPreferences } from '../contrib/preferences/browser/sessionsPreferences.js';
import type { SessionsProfile } from "../common/sessionsProfile.js";
import { RETURN_TO_WORKBENCH_COMMAND_ID } from '../common/windowNavigation.js';
import { SessionsConfiguration, type SessionsLayoutStyle } from '../common/configuration.js';
import { SessionsManagementService } from "../services/sessions/browser/sessionsManagementService.js";
import { ISessionsManagementService } from "../services/sessions/common/sessionsManagement.js";
import { ISessionsService, SessionsService } from "../services/sessions/browser/sessionsService.js";
import { registerLayoutActions } from './layoutActions.js';
import { DesktopLayoutController } from '../contrib/layout/browser/desktopLayoutController.js';
import { PanelPart } from './parts/panelPart.js';
import { ITerminalService } from '../../workbench/services/terminal/common/terminal.js';
import { TerminalService } from '../../workbench/services/terminal/browser/terminalService.js';
import { AuxiliaryBarPart } from "./parts/auxiliarybar/auxiliaryBarPart.js";
import { disposableWindowTimeout } from '../../base/browser/scheduler.js';
import { ActivityBarPart } from './parts/activitybar/activityBarPart.js';
import { ISessionsPageService } from '../common/pages.js';
import { SessionsPageService } from '../services/pages/browser/sessionsPageService.js';
import { SessionsPageLayoutController } from './pageLayoutController.js';
import { SessionsPart, type SessionsPartOptions } from "./parts/sessionsPart.js";
import { SidebarPart } from "./parts/sidebarPart.js";
import { TitlebarPart } from "./parts/titlebar/titlebarPart.js";

export interface IWorkbenchOptions {
	readonly createTextDocumentHost?: (services: IInstantiationService) => IDisposable;
	readonly contributionIds: readonly string[];
	readonly modeId: WorkbenchModeId;
	readonly profile: SessionsProfile;
	readonly api: IRendererHost;
	readonly workspaceSelection: () => SessionWorkspaceSelection;
	readonly workspace: () => IWorkspace;
	readonly browserFileSystemProvider?: HTMLFileSystemProvider;
	readonly createFileDialogService: (services: IInstantiationService) => IFileDialogService;
	readonly createLifecycleService: (services: IInstantiationService) => ILifecycleService & IDisposable;
	readonly createStorageService: (options: BrowserStorageServiceOptions) => Promise<IStorageService & IDisposable>;
	readonly createLogService: () => LogService;
	readonly nativeHostApi?: INativeHostApi;
	readonly returnToWorkbench: () => void;
	readonly configurationApi?: IConfigurationApi;
	readonly initialConfigurationSnapshot?: IConfigurationSnapshot;
	readonly keybindingsResourceApi?: IKeybindingsResourceApi;
	readonly createContextMenuService: ContextMenuServiceFactory;
	readonly createHostColorSchemeService: (services: IInstantiationService) => IHostColorSchemeService & IDisposable;
	readonly container: HTMLElement;
}

/** Owns the dedicated Sessions window's services, Parts, layout, and disposal. */
export class Workbench extends Disposable {
	readonly domNode: HTMLElement;
	readonly configurationService: WorkbenchConfigurationService;
	readonly themeService: WorkbenchThemeService;
	private readonly layoutService: SessionsWorkbenchLayout;
	private readonly lifecycleService: ILifecycleService;
	private readonly sessionsView: SessionsService;
	private readonly sessionsPart: SessionsPart;
	private readonly showChat: () => void;
	private readonly workspaceSelection: () => SessionWorkspaceSelection;
	/** Saved page and session layout are restored before the host completes startup. */
	public readonly whenRestored: Promise<void>;
	private readonly logService: ILogService;

	public static async create(options: IWorkbenchOptions): Promise<Workbench> {
		const themes = new ExtensionColorThemeService(options.api.extensions, options.api.events);
		const logger = options.createLogService();
		let storage: IStorageService & IDisposable | undefined;
		try {
			await themes.start();
			const ownerWindow = options.container.ownerDocument.defaultView;
			if (!ownerWindow) { throw new Error('Sessions renderer requires an owner window'); }
			storage = await options.createStorageService({ ownerWindow, applicationId: WorkbenchModeRegistry.get(options.modeId).storageNamespace, workspaceId: 'sessions', profileId: options.profile.id });
			return new Workbench(options, themes, storage, logger);
		} catch (error) {
			logger.error('startup', 'Agents startup failed', error);
			logger.dispose();
			storage?.dispose();
			themes.dispose();
			throw error;
		}
	}

	private constructor(options: IWorkbenchOptions, themes: ExtensionColorThemeService, storageService: IStorageService & IDisposable, logger: LogService) {
		super();
		this._register(themes);
		this.workspaceSelection = options.workspaceSelection;
		if (options.profile.modeId !== options.modeId) {
			throw new TypeError(`Sessions profile '${options.profile.id}' belongs to '${options.profile.modeId}', not '${options.modeId}'`);
		}
		if (options.profile.id !== "code-sessions") {
			throw new TypeError(`Unsupported Code Sessions profile '${options.profile.id}'`);
		}
		const ownerDocument = options.container.ownerDocument;
		const ownerWindow = ownerDocument.defaultView;
		if (!ownerWindow) throw new Error("Sessions renderer requires an owner window");

		const configurationService = this.configurationService = this._register(new WorkbenchConfigurationService({ api: options.configurationApi, initialSnapshot: options.initialConfigurationSnapshot }));
		const serviceCollection = new ServiceCollection();
		// Sessions owns its editor services; the runtime registers host and local language storage.
		for (const [id, descriptor] of getSingletonServiceDescriptors()) {
			if (id === IHostService || id === ILanguagePackStore) serviceCollection.set(id, descriptor);
		}
		const services = this._register(new InstantiationService(serviceCollection));
		services.registerInstance(IAssetService, options.api.assets);
		if (options.api.approvalEnvironment) { services.registerInstance(IApprovalEnvironmentService, options.api.approvalEnvironment); }
		services.registerInstance(IDictationService, options.api.dictation);
		services.registerSingleton(IChatSpeechToTextService, () => services.createInstance(ChatSpeechToTextService));
		services.registerSingleton(IDictationOnboardingService, () => services.createInstance(DictationOnboardingService));
		services.registerInstance(ILocalTranscriptionService, options.api.localTranscription ?? this._register(new NullLocalTranscriptionService()));
		services.registerInstance(IConfigurationService, configurationService);
		if (options.nativeHostApi) services.registerInstance(INativeHostService, options.nativeHostApi);
		const languageService = this._register(new LanguageService());
		services.registerInstance(ILanguageService, languageService);
		services.registerInstance(ILanguageConfigurationService, this._register(new LanguageConfigurationService(configurationService, languageService)));
		services.registerInstance(ILanguageFeaturesService, this._register(new LanguageFeaturesService()));
		services.registerInstance(ICodeEditorService, this._register(new StandaloneCodeEditorService()));
		this.logService = this._register(logger);
		services.registerInstance(ILogService, this.logService);
		services.registerInstance(IHostColorSchemeService, this._register(options.createHostColorSchemeService(services)));
		const themeService = this.themeService = this._register(services.createInstance(WorkbenchThemeService, options.container));
		services.registerInstance(IThemeService, themeService);
		themeService.initialize();
		const workbenchWindow = this._register(new WorkbenchWindow({
			root: options.container,
			modeId: options.modeId,
			workbenchState: WorkbenchState.EMPTY,
		}));
		services.registerInstance(IWorkbenchHostService, workbenchWindow);
		const sessions = this._register(new SessionsManagementService(new AppServerSessionsProvider({
			session: options.api.session,
			workspace: options.workspaceSelection,
			selectWorkspace: folders => pickWorkspaceFolder(services.get(IQuickInputService), folders),
			model: options.api.model,
			turn: options.api.turn,
			events: options.api.events,
		})));
		const teams = new TeamsManagementService(new AppServerTeamsProvider(options.api.teams));
		services.registerInstance(ITeamsManagementService, teams);
		const storage = this._register(storageService);
		services.registerInstance(IStorageService, storage);
		services.registerInstance(ISessionsManagementService, sessions);
		const view = this.sessionsView = this._register(services.createInstance(SessionsService));
		const chat = this._register(new ChatService({
			modelApi: options.api.model,
			threadApi: options.api.thread,
			turnApi: options.api.turn,
			turnChangesApi: options.api.turnChanges,
			skillApi: options.api.skills,
			appServerApi: options.api.appServer,
			eventApi: options.api.events,
		}));
		services.registerInstance(ISessionsService, view);
		const workspace = this._register(services.createInstance(SessionsWorkspaceContextService, options.workspace));
		services.registerInstance(IWorkspaceContextService, workspace);
		const files = this._register(services.createInstance(SessionFileService, options.api));
		const fileService = this._register(new MultiplexFileService(files));
		if (options.browserFileSystemProvider) {
			this._register(fileService.registerProvider('file', options.browserFileSystemProvider));
		}
		services.registerInstance(IFileService, fileService);
		services.registerInstance(ISystemFileTransferService, files);
		services.registerInstance(ILabelService, this._register(new LabelService(workspace)));
		services.registerInstance(IResourceIconRenderer, themeService);
		services.registerInstance(IDecorationsService, this._register(services.createInstance(DecorationsService, ownerDocument)));
		services.registerSingleton(IResourceLabelService, () => services.createInstance(ResourceLabelService));
		services.registerSingleton(IExplorerService, () => services.createInstance(ExplorerService));
		services.registerSingleton(IUntitledTextEditorService, () => services.createInstance(BrowserUntitledTextEditorService));
		services.registerSingleton(IMultiDiffSourceResolverService, () => services.createInstance(MultiDiffSourceResolverService));
		services.registerInstance(IClipboardService, new BrowserClipboardService(ownerWindow.navigator.clipboard));
		const textFiles = new TextFileService(files);
		services.registerInstance(ITextFileService, textFiles);
		const workingCopies = this._register(new BrowserWorkingCopyService());
		services.registerInstance(IWorkingCopyService, workingCopies);
		const textMate = this._register(new BrowserTextMateService());
		services.registerInstance(ITextMateService, textMate);
		const textModels = this._register(getBrowserTextModelService(getBrowserTextResourceStore(textFiles), {
			languageService,
			languageConfigurationService: services.get(ILanguageConfigurationService),
			languageFeaturesService: services.get(ILanguageFeaturesService),
			syntaxService: { workerFactory: textMate.syntaxWorkerFactory },
			onDidChangeLanguageSupport: textMate.onDidChange,
		}));
		services.registerInstance(ITextModelResourceService, textModels);
		services.registerInstance(IFileTextModelService, textModels);
		services.registerSingleton(ITextModelService, () => services.createInstance(TextModelResolverService));
		const workspaceEdits = this._register(new BrowserWorkspaceEditService(textModels, workingCopies, fileService));
		services.registerInstance(IWorkspaceEditService, workspaceEdits);
		services.registerInstance(IBulkEditService, this._register(new BulkEditService(workspaceEdits)));
		services.registerInstance(IChatEditingService, this._register(services.createInstance(ChatEditingService)));
		if (options.createTextDocumentHost) { this._register(options.createTextDocumentHost(services)); }
		services.registerInstance(IChatService, chat);
		services.registerInstance(ModelApiId, options.api.model);
		services.registerInstance(AppServerApiId, options.api.appServer);
		services.registerInstance(ServerEventApiId, options.api.events);
		services.registerInstance(ILanguageModelsConfigurationService, this._register(services.createInstance(LanguageModelsConfigurationService)));
		services.registerInstance(ILanguageModelsService, this._register(services.createInstance(LanguageModelsService)));
		services.registerInstance(ISkillService, options.api.skills);
		services.registerInstance(IHooksService, options.api.hooks);
		const marketplaceService = this._register(new AppServerMarketplaceService(options.api.marketplace, options.api.events));
		services.registerInstance(IMarketplaceService, marketplaceService);
		const languagePacks = this._register(services.createInstance(MarketplaceLanguagePackService, builtinLanguagePackCatalogs));
		services.registerInstance(ILanguagePackService, languagePacks);
		const localization = this._register(new WorkbenchLocalizationService());
		services.registerInstance(ILocalizationService, localization);
		services.registerInstance(IRemoteAgentService, this._register(new AppServerRemoteAgentService({ api: options.api.appServer, remoteApi: options.api.remote })));
		const accountService = this._register(new AppServerAccountService(options.api.accounts, options.api.events));
		services.registerInstance(IAccountService, accountService);
		services.registerInstance(IChatTipService, this._register(services.createInstance(ChatTipService)));
		this.lifecycleService = this._register(options.createLifecycleService(services));
		services.registerInstance(ILifecycleService, this.lifecycleService);
		this._register(this.lifecycleService.onWillShutdown(event => {
			event.join(storage.flush(WillSaveStateReason.SHUTDOWN), "Sessions storage flush");
		}));

		options.container.replaceChildren();
		this.domNode = h(ownerDocument, "main");
		this.domNode.className = "ash-sessions-window ash-code-sessions-window";
		options.container.append(this.domNode);
		this._register(toDisposable(() => this.domNode.remove()));
		const dialogs = this._register(new DialogService());
		services.registerInstance(IDialogService, dialogs);
		services.registerInstance(ILocaleService, this._register(services.createInstance(WorkbenchLocaleService)));
		this._register(new DialogHandlerContribution(dialogs.model, new BrowserDialogHandler(this.domNode)));

		let sessionsPart: SessionsPart | undefined;
		const layout = this.layoutService = this._register(services.createInstance(SessionsWorkbenchLayout, this.domNode, {
			activityBarLocation: configurationService.getValue<ActivityBarPosition>(SessionsConfiguration.activityBarLocation),
			focus: () => sessionsPart?.focus(),
		}));
		services.registerInstance(IAgentWorkbenchLayoutService, layout);
		const notificationService = this._register(new NotificationService());
		services.registerInstance(INotificationService, notificationService);
		const feedbackHost = h(ownerDocument, "div");
		feedbackHost.className = "ash-feedback-host";
		this.domNode.append(feedbackHost);
		this._register(toDisposable(() => feedbackHost.remove()));
		services.registerInstance(IOpenerService, new BrowserOpenerService(ownerWindow));
		services.registerInstance(IUserKeyboardLayoutService, UnavailableUserKeyboardLayoutService);
		const commandService = this._register(new CommandService(services));
		services.registerInstance(ICommandService, commandService);
		this._register(CommandsRegistry.register(RETURN_TO_WORKBENCH_COMMAND_ID, () => options.returnToWorkbench()));
		const contextKeys = this._register(new ContextKeyService());
		IsSessionsWindowContext.bindTo(contextKeys).set(true);
		const workspaceFolderCount = WorkspaceFolderCountContext.bindTo(contextKeys);
		workspaceFolderCount.set(workspace.getWorkspace().folders.length);
		this._register(workspace.onDidChangeWorkspace(() => workspaceFolderCount.set(workspace.getWorkspace().folders.length)));
		services.registerInstance(IContextKeyService, contextKeys);
		services.registerInstance(IAccessibilityService, this._register(new AccessibilityService({
			root: this.domNode,
			contextKeyService: contextKeys,
			configurationService,
		})));
		const notificationsCenter = this._register(new NotificationsCenter(this.domNode, feedbackHost, notificationService, undefined, contextKeys, () => services.get(IAccessibleViewService).getOpenAriaHint(AccessibilityVerbositySettingId.Notifications)));
		services.registerInstance(INotificationsCenter, notificationsCenter);
		const keyboardLayoutService = this._register(new BrowserKeyboardLayoutService({
			navigator: ownerWindow.navigator,
			configurationService,
			userLayoutProvider: UnavailableUserKeyboardLayoutService,
		}));
		services.registerInstance(IKeyboardLayoutService, keyboardLayoutService);
		const keybindingsResourceService = this._register(new WorkbenchKeybindingsResourceService({ api: options.keybindingsResourceApi }));
		services.registerInstance(IKeybindingsResourceService, keybindingsResourceService);
		this._register(services.createInstance(KeybindingsResourceContribution, {}));
		const keybindings = this._register(services.createInstance(WorkbenchKeybindingService, {
			ownerDocument,
			commandService,
			contextKeyService: contextKeys,
			keyboardLayoutService,
		}));
		services.registerInstance(IKeybindingService, keybindings);
		services.registerInstance(IKeyboardShortcutTroubleshootingService, keybindings);
		const menus = new MenuService(commandService, contextKeys);
		services.registerInstance(IMenuService, menus);
		const contextViews = this._register(new BrowserContextViewService(this.layoutService.activeContainer, this.layoutService));
		services.registerInstance(IContextViewService, contextViews);
		services.registerSingleton(IActionWidgetService, () => services.createInstance(ActionWidgetService));
		const quickInputService = this._register(new WorkbenchQuickInputService({
			container: this.layoutService.activeContainer,
			contextKeyService: contextKeys,
			layoutService: this.layoutService,
		}));
		services.registerInstance(IQuickInputService, quickInputService);
		services.registerInstance(IQuickAccessController, this._register(services.createInstance(QuickAccessController)));
		services.registerInstance(IChatContextPickService, new ChatContextPickService());
		const contextMenus = this._register(options.createContextMenuService({
			configurationService,
			menuService: menus,
			contextKeyService: contextKeys,
			keybindingService: keybindings,
			contextViewService: contextViews,
			notificationService,
		}));
		services.registerInstance(IContextMenuService, contextMenus);
		services.registerInstance(IFileDialogService, options.createFileDialogService(services));
		const hoverService = this._register(new HoverService(configurationService, contextViews, contextMenus));
		services.registerInstance(IHoverService, hoverService);
		this._register(setHoverDelegate(hoverService));
		void configurationService.reloadConfiguration().catch((error: unknown) => console.error("Failed to initialize configuration", error));
		void keybindingsResourceService.reload().catch((error: unknown) => console.error("Failed to initialize keybindings resource", error));
		const accessibleViewService = this._register(services.createInstance(AccessibleViewService));
		services.registerInstance(IAccessibleViewService, accessibleViewService);
		const preferences = this._register(services.createInstance(SessionsPreferences, this.domNode, () => { selectActivityPage('code'); editors.focusActiveEditor(); }));
		this._register(CommandsRegistry.register(OPEN_PLUGINS_COMMAND_ID, () => preferences.open('plugins', { mode: 'installed' })));
		this._register(CommandsRegistry.register(OPEN_MARKETPLACE_COMMAND_ID, (_accessor, value: unknown) => {
			const options = value as MarketplaceOpenOptions | string | undefined;
			return preferences.open('plugins', typeof options === 'string' ? { query: options.trim() } : { mode: 'browse', ...options });
		}));
		const accountMenu = this._register(new SessionsAccountMenu(accountService, contextMenus, preferences, options.returnToWorkbench));

		let auxiliarybar: AuxiliaryBarPart | undefined;
		const titlebar = this._register(new TitlebarPart(this.domNode, menus, contextMenus));
		const viewDescriptors = this._register(new ViewDescriptorService({ contextKeyService: contextKeys, registry: SessionsViewRegistry }));
		services.registerInstance(IViewDescriptorService, viewDescriptors);
		services.registerSingleton(IDesignEditorService, () => services.createInstance(DesignEditorService));
		const sidebar = this._register(services.createInstance(SidebarPart, this.domNode, sessions, view, teams, quickInputService, async () => {
			const catalog = await options.api.session.listAgents();
			return catalog.agents.map(agent => ({
				name: agent.name,
				description: agent.description,
				role: { type: 'exact' as const, name: agent.name, source: agent.source },
			}));
		}));
		const pages = this._register(services.createInstance(SessionsPageService));
		services.registerInstance(ISessionsPageService, pages);
		let pageLayoutController: SessionsPageLayoutController;
		const selectActivityPage = (page: string): void => pages.openPage(page);
		this._register(CommandsRegistry.register('sessions.library.useInDesign', async (_accessor, value) => {
			const version = value as AssetVersion;
			const design = services.get(IDesignEditorService);
			await editors.openEditor(design.input, { pinned: true, preserveFocus: true });
			selectActivityPage('design');
			await design.activeEditor.get()!.adoptAssetVersion(version);
		}));
		this._register(CommandsRegistry.register('sessions.library.addToChat', async (_accessor, value) => {
			const version = value as AssetVersion;
			const bytes = await options.api.assets.readVersion(version);
			let binary = '';
			for (let offset = 0; offset < bytes.length; offset += 8192) { binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192)); }
			const content = `data:${version.mediaType};base64,${btoa(binary)}`;
			selectActivityPage('chat');
			sessionsPart!.addContext({ id: version.versionId, name: version.name, kind: 'image', resolve: async () => ({ name: version.name, content, kind: 'image' }) }, 'chat');
			sessionsPart!.focus();
		}));
		this.showChat = () => selectActivityPage('chat');
		const activitybar = this._register(services.createInstance(ActivityBarPart, this.domNode, {
			focusList: () => sidebar.focusChats(),
			showAccountMenu: (anchor: HTMLElement) => accountMenu.show(anchor),
		}));
		const activityBarLocation = configurationService.getValue<ActivityBarPosition>(SessionsConfiguration.activityBarLocation);
		activitybar.setCompact(configurationService.getValue<boolean>(SessionsConfiguration.activityBarCompact));
		activitybar.setLocation(activityBarLocation, sidebar.setActivityBarLocation(activityBarLocation));
		const activityBarContext = this._register(contextKeys.createScoped(activitybar.focusContainer));
		activityBarContext.createKey('sessionsActivityBarFocused', true);
		this._register(AccessibleViewRegistry.register({
			type: AccessibleViewType.Help,
			priority: 100,
			name: 'sessionsActivityBarHelp',
			when: ContextKeyExpr.has('sessionsActivityBarFocused'),
			getProvider: () => {
				const focused = activitybar.focusContainer.ownerDocument.activeElement as HTMLElement;
				return new AccessibleContentProvider(
					AccessibleViewProviderId.SessionsActivityBar,
					{ type: AccessibleViewType.Help },
					() => localize('sessions.activity.help', 'Sessions Activity Bar\nUse Tab and Shift+Tab to enter page navigation and Accounts. Use arrow keys, Home and End to move between pages. Press Enter or Space to open the focused page. Drag page icons to reorder them, or use Move earlier and Move later in the Context Menu key or Shift+F10 menu. Page order is saved across restarts and Activity Bar positions. The menu also offers position and size options. Chat focuses the sessions list. Chat and Code keep separate selected sessions, navigation history, unsent text, and attachments when you switch pages. Code sessions restore their own editor tabs when you navigate between them. Toggle Code panel shows or hides the bottom tools. Toggle details, Hide editor and Show editor change the Code side panel. Toggle Code side panel closes and reopens the whole composition. Changes and Files tabs remain available in Details-only mode. Use arrow keys on separators to resize. Collaboration opens an empty page. Library browses imported images, favorites and collections. Design opens an infinite canvas. Accounts opens the account menu, which includes Return to Workbench.'),
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
		sessionsPart = this.sessionsPart = this._register(services.createInstance(SessionsPart, this.domNode, {
			sessionService: sessions,
			chatService: chat,
			contextMenuService: contextMenus,
			contextViewService: contextViews,
			accessibleViewService,
			notifications: notificationService,
			commandService,
			createInputPart: (container, delegate, model, page) => {
				if (model.untitledSessionId) {
					migrateNewChatDraftState(storage, page, model.untitledSessionId);
				}
				return services.createInstance(NewChatInputWidget, container, delegate, model, undefined, page);
			},
			activateSelection: (selection, page) => view.activateSelection(selection, page),
			closeSelection: (selection, page) => {
				view.closeVisibleSelection(selection, page);
				if (selection.kind === 'untitled') {
					writeNewChatDraftState(storage, page, undefined, `untitled:${selection.session.untitledSessionId}`);
				}
			},
			createNewSession: page => { view.openNewSession(page === 'code' ? 'New code session' : 'New chat', page); },
		} satisfies SessionsPartOptions));
		const updateSessionsPart = (): void => {
			for (const page of ['chat', 'code'] as const) {
				const selection = view.getPageSelection(page);
				sessionsPart?.updateVisibleSelections(selection.visibleSelections, selection.activeSelection, page);
			}
		};
		this._register(view.onDidChange(updateSessionsPart));
		updateSessionsPart();
		services.registerInstance(IChatSessionNavigationService, {
			getActiveConversation: () => {
				const selected = view.activeSelection;
				return selected?.kind === 'session' ? { sessionId: selected.active.session.sessionId, threadId: selected.active.threadId } : undefined;
			},
			getConversations: () => sessions.sessions.filter(session => session.status === 'active').flatMap(session => session.chats.filter(chat => chat.status === 'active').map(chat => ({ sessionId: session.sessionId, threadId: chat.threadId, title: chat.title ?? session.title }))),
			appendToActiveDraft: text => {
				selectActivityPage(view.page.get());
				sessionsPart!.appendToDraft(text, view.page.get());
				sessionsPart!.focus();
			},
			captureActiveDraft: () => sessionsPart!.captureActiveDraft(view.page.get()),
			openConversation: async (sessionId, threadId) => { selectActivityPage(view.page.get()); await view.openThread(sessionId, threadId); },
		});

		const editor = this._register(services.createInstance(EditorPart, this.domNode, {
			configurationService,
			contextKeyService: contextKeys,
			keybindingService: keybindings,
			keybindingsResourceService,
			keyboardLayoutService,
			fileService: files,
			textFileService: textFiles,
			textMateService: textMate,
			languageResolver: languageService,
			languageFeaturesService: services.get(ILanguageFeaturesService),
			diffService: new DiffService(),
			workingCopyService: workingCopies,
			accessibilityService: services.get(IAccessibilityService),
			dialogService: dialogs,
			fileDialogService: services.get(IFileDialogService),
			titleActions: { menuService: menus, contextMenuProvider: contextMenus },
		}));
		services.registerInstance(IEditorPart, editor);
		const editors = this._register(new BrowserEditorService(editor));
		services.registerInstance(IEditorService, editors);
		const workbenchPreferences = this._register(services.createInstance(PreferencesService));
		services.registerInstance(IPreferencesService, {
			openSettings: category => preferences.open(category),
			openUserSettings: options => workbenchPreferences.openUserSettings(options),
			openKeybindings: () => workbenchPreferences.openKeybindings(),
		});
		services.registerInstance(IEditorGroupsService, editors);
		this._register(services.createInstance(TextFileEditorTracker, ownerWindow));
		auxiliarybar = this._register(services.createInstance(AuxiliaryBarPart, this.domNode));
		services.registerInstance(ITerminalService, this._register(new TerminalService(options.api.terminal, workspace)));
		const panel = this._register(services.createInstance(PanelPart, this.domNode));
		services.registerInstance(IViewsService, new ViewsService({
			viewDescriptorService: viewDescriptors,
			getViewContainer: container => {
				switch (container.location) {
					case ViewContainerLocation.Sidebar: return sidebar.getComposite(container.id);
					case ViewContainerLocation.Panel: return panel.getComposite(container.id);
					case ViewContainerLocation.AuxiliaryBar: return auxiliarybar!.getComposite(container.id);
				}
			},
			openViewContainer: container => {
				pageLayoutController.openContainerPage(container.id, container.location);
				switch (container.location) {
					case ViewContainerLocation.Sidebar:
						layout.showPart('sidebar');
						sidebar.showComposite(container.id);
						return sidebar.getComposite(container.id);
					case ViewContainerLocation.Panel:
						layout.showPart('panel');
						panel.showComposite(container.id);
						return panel.getComposite(container.id);
					case ViewContainerLocation.AuxiliaryBar:
						layout.showPart('auxiliarybar');
						auxiliarybar!.showComposite(container.id);
						return auxiliarybar!.getComposite(container.id);
				}
			},
		}));
		sidebar.initialize();
		auxiliarybar.initialize();
		const parts = new Map<SessionsPartId, WorkbenchPart>([
			["titlebar", titlebar],
			['activitybar', activitybar],
			["sidebar", sidebar],
			["sessions", sessionsPart],
			['editor', editor],
			["auxiliarybar", auxiliarybar],
			['panel', panel],
		]);
		layout.createWorkbenchLayout(parts);
		pageLayoutController = this._register(services.createInstance(SessionsPageLayoutController, sidebar, sessionsPart, auxiliarybar));
		const layoutController = this._register(services.createInstance(DesktopLayoutController, panel, auxiliarybar));
		layoutController.start();
		this._register(this.lifecycleService.onBeforeShutdown(event => {
			event.veto(editor.confirmCloseAllEditors().then(confirmed => !confirmed), 'Sessions unsaved files');
		}));
		this._register(configurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(SessionsConfiguration.activityBarLocation)) {
				const location = configurationService.getValue<ActivityBarPosition>(SessionsConfiguration.activityBarLocation);
				activitybar.setLocation(location, sidebar.setActivityBarLocation(location));
				layout.setActivityBarLocation(location);
			}
			if (event.affectsConfiguration(SessionsConfiguration.activityBarCompact)) {
				activitybar.setCompact(configurationService.getValue<boolean>(SessionsConfiguration.activityBarCompact));
			}
		}));
		this._register(new SessionsModernUIContribution(this.domNode, layout, configurationService));
		this._register(registerLayoutActions(layout, view, contextKeys));
		this.layoutService.layout();
		const contributions = this._register(WorkbenchContributionsRegistry.createHost(services, undefined, options.contributionIds));
		contributions.advance(WorkbenchPhase.BlockStartup);
		contributions.advance(WorkbenchPhase.BlockRestore);
		this.lifecycleService.phase = LifecyclePhase.Ready;
		this.whenRestored = this.initialize(view, configurationService, ownerWindow, layoutController, contributions, pageLayoutController);
	}

	async acceptHandoff(options: IOpenAgentsWindowOptions): Promise<void> {
		await this.whenRestored;
		this.showChat();
		if (options.conversation) {
			await this.sessionsView.openThread(options.conversation.sessionId, options.conversation.threadId);
		}
		else if (options.draft) {
			const selected = this.sessionsView.activeSelection;
			if (selected?.kind !== 'untitled' || !sameWorkspace(selected.session.workspace, this.workspaceSelection())) {
				this.sessionsView.openNewSession('New code session');
			}
		}
		this.showChat();
		if (options.draft) this.sessionsPart.restoreDraft(options.draft, 'chat');
	}

	shutdown(reason: ShutdownReason): Promise<void> {
		return this.lifecycleService.shutdown(reason);
	}

	private async initialize(view: SessionsService, configurationService: WorkbenchConfigurationService, ownerWindow: Window, layoutController: DesktopLayoutController, contributions: WorkbenchContributionHost, pages: SessionsPageLayoutController): Promise<void> {
		await configurationService.reloadConfiguration();
		await view.initialize();
		if (this.isDisposed) return;
		// Page activation may create a draft; restored selections must exist before the saved page opens.
		pages.start();
		if (!view.activeSelection) view.openNewSession("New code session");
		await layoutController.whenSettled();
		if (this.isDisposed) return;
		this.lifecycleService.phase = LifecyclePhase.Restored;
		contributions.advance(WorkbenchPhase.AfterRestored);
		await contributions.workspaceRestored();
		if (this.isDisposed) return;
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
	return first.type === 'ssh' && second.type === 'ssh' && first.host === second.host && first.root === second.root;
}

export interface IAgentWorkbenchLayoutService extends ILayoutService {
	readonly onDidChangePartVisibility: Event<SessionsPartVisibilityChangeEvent>;
	setLayoutStyle(style: SessionsLayoutStyle): void;
	isPartVisible(partId: SessionsPartId): boolean;
	isPartAvailable(partId: SessionsPartId): boolean;
	showPart(partId: SessionsPartId): void;
	hidePart(partId: SessionsPartId): void;
}

export const IAgentWorkbenchLayoutService = refineServiceDecorator<ILayoutService, IAgentWorkbenchLayoutService>(ILayoutService);

export interface SessionsPartVisibilityChangeEvent {
	readonly partId: SessionsPartId;
	readonly visible: boolean;
}


/** Persisted, Sessions-owned dimensions and visibility for the dedicated window. */
export interface SessionsWorkbenchLayoutState {
	readonly version: 1;
	readonly sidebar: {
		readonly width: number;
		readonly visible: boolean;
	};
	readonly auxiliarybar: {
		readonly width: number;
		readonly visible: boolean;
	};
	readonly editor: {
		readonly width: number;
		readonly visible: boolean;
	};
	readonly panel: {
		readonly height: number;
		readonly visible: boolean;
	};
}

function createDefaultSessionsWorkbenchLayoutState(): SessionsWorkbenchLayoutState {
	return {
		version: 1,
		sidebar: { width: SESSION_SIDEBAR_DEFAULT_WIDTH, visible: true },
		auxiliarybar: { width: SESSION_AUXILIARYBAR_DEFAULT_WIDTH, visible: true },
		editor: { width: 480, visible: false },
		panel: { height: 240, visible: false },
	};
}

/** Bridges the Sessions layout schema to the generic scoped storage service. */
class SessionsWorkbenchLayoutStateModel {
	constructor(
		private readonly storageService: IStorageService,
		private readonly defaults: SessionsWorkbenchLayoutState,
	) {}

	get state(): SessionsWorkbenchLayoutState {
		const storage = this.storageService;
		return {
			version: 1,
			sidebar: {
				width: storedDimension(storage.getNumber(SessionsWorkbenchLayoutStorageKeys.SIDEBAR_WIDTH.key, SessionsWorkbenchLayoutStorageKeys.SIDEBAR_WIDTH.scope), this.defaults.sidebar.width),
				visible: storage.getBoolean(SessionsWorkbenchLayoutStorageKeys.SIDEBAR_VISIBLE.key, SessionsWorkbenchLayoutStorageKeys.SIDEBAR_VISIBLE.scope, this.defaults.sidebar.visible),
			},
			auxiliarybar: {
				width: storedDimension(storage.getNumber(SessionsWorkbenchLayoutStorageKeys.AUXILIARYBAR_WIDTH.key, SessionsWorkbenchLayoutStorageKeys.AUXILIARYBAR_WIDTH.scope), this.defaults.auxiliarybar.width),
				visible: storage.getBoolean(SessionsWorkbenchLayoutStorageKeys.AUXILIARYBAR_VISIBLE.key, SessionsWorkbenchLayoutStorageKeys.AUXILIARYBAR_VISIBLE.scope, this.defaults.auxiliarybar.visible),
			},
			editor: {
				width: storedDimension(storage.getNumber(SessionsWorkbenchLayoutStorageKeys.EDITOR_WIDTH.key, SessionsWorkbenchLayoutStorageKeys.EDITOR_WIDTH.scope), this.defaults.editor.width),
				visible: storage.getBoolean(SessionsWorkbenchLayoutStorageKeys.EDITOR_VISIBLE.key, SessionsWorkbenchLayoutStorageKeys.EDITOR_VISIBLE.scope, this.defaults.editor.visible),
			},
			panel: {
				height: storedDimension(storage.getNumber(SessionsWorkbenchLayoutStorageKeys.PANEL_HEIGHT.key, SessionsWorkbenchLayoutStorageKeys.PANEL_HEIGHT.scope), this.defaults.panel.height),
				visible: storage.getBoolean(SessionsWorkbenchLayoutStorageKeys.PANEL_VISIBLE.key, SessionsWorkbenchLayoutStorageKeys.PANEL_VISIBLE.scope, this.defaults.panel.visible),
			},
		};
	}

	save(state: SessionsWorkbenchLayoutState): void {
		const storage = this.storageService;
		storeLayoutValue(storage, SessionsWorkbenchLayoutStorageKeys.SIDEBAR_WIDTH, state.sidebar.width);
		storeLayoutValue(storage, SessionsWorkbenchLayoutStorageKeys.SIDEBAR_VISIBLE, state.sidebar.visible);
		storeLayoutValue(storage, SessionsWorkbenchLayoutStorageKeys.AUXILIARYBAR_WIDTH, state.auxiliarybar.width);
		storeLayoutValue(storage, SessionsWorkbenchLayoutStorageKeys.AUXILIARYBAR_VISIBLE, state.auxiliarybar.visible);
		storeLayoutValue(storage, SessionsWorkbenchLayoutStorageKeys.EDITOR_WIDTH, state.editor.width);
		storeLayoutValue(storage, SessionsWorkbenchLayoutStorageKeys.EDITOR_VISIBLE, state.editor.visible);
		storeLayoutValue(storage, SessionsWorkbenchLayoutStorageKeys.PANEL_HEIGHT, state.panel.height);
		storeLayoutValue(storage, SessionsWorkbenchLayoutStorageKeys.PANEL_VISIBLE, state.panel.visible);
	}
}

interface SessionsWorkbenchLayoutStorageKey {
	readonly key: string;
	readonly scope: StorageScope;
	readonly target: StorageTarget;
}

const SessionsWorkbenchLayoutStorageKeys = {
	PANEL_HEIGHT: {
		key: 'sessions.layout.panel.height',
		scope: StorageScope.PROFILE,
		target: StorageTarget.MACHINE,
	},
	PANEL_VISIBLE: {
		key: 'sessions.layout.panel.visible',
		scope: StorageScope.PROFILE,
		target: StorageTarget.MACHINE,
	},
	EDITOR_WIDTH: {
		key: 'sessions.layout.editor.width',
		scope: StorageScope.PROFILE,
		target: StorageTarget.MACHINE,
	},
	EDITOR_VISIBLE: {
		key: 'sessions.layout.editor.visible',
		scope: StorageScope.PROFILE,
		target: StorageTarget.MACHINE,
	},
	SIDEBAR_WIDTH: {
		key: 'sessions.layout.sidebar.width',
		scope: StorageScope.PROFILE,
		target: StorageTarget.MACHINE,
	},
	SIDEBAR_VISIBLE: {
		key: 'sessions.layout.sidebar.visible',
		scope: StorageScope.PROFILE,
		target: StorageTarget.MACHINE,
	},
	AUXILIARYBAR_WIDTH: {
		key: 'sessions.layout.auxiliarybar.width',
		scope: StorageScope.PROFILE,
		target: StorageTarget.MACHINE,
	},
	AUXILIARYBAR_VISIBLE: {
		key: 'sessions.layout.auxiliarybar.visible',
		scope: StorageScope.PROFILE,
		target: StorageTarget.MACHINE,
	},
} as const satisfies Record<string, SessionsWorkbenchLayoutStorageKey>;

function storeLayoutValue(storage: IStorageService, key: SessionsWorkbenchLayoutStorageKey, value: number | boolean): void {
	storage.store(key.key, value, key.scope, key.target);
}

function storedDimension(value: number | undefined, fallback: number): number {
	return value !== undefined && value >= 0 ? value : fallback;
}

const SESSIONS_LAYOUT_PRIORITY = 'high' as const;
const DEFAULT_LAYOUT_WIDTH = 1_024;
const DEFAULT_LAYOUT_HEIGHT = 768;

function createSessionsWorkbenchGridDescriptor(
	views: ReadonlyMap<SessionsPartId, WorkbenchPartView<SessionsPartId>>,
	dimension: IDimension,
	state: SessionsWorkbenchLayoutState,
	activityBarLocation: ActivityBarPosition = ActivityBarPosition.DEFAULT,
): SerializedGridDescriptor {
	const leaf = (partId: SessionsPartId, size: number, visible = true, priority: 'normal' | 'high' = 'normal'): SerializedGridDescriptor => ({
		type: 'leaf',
		data: partId,
		size,
		visible,
		priority,
	});
	const titlebarHeight = requiredView(views, 'titlebar').minimumHeight;
	const bodyHeight = Math.max(0, dimension.height - titlebarHeight);
	const activityBarWidth = requiredView(views, 'activitybar').minimumWidth;
	const mainWidth = Math.max(0, dimension.width - (activityBarLocation === ActivityBarPosition.DEFAULT ? activityBarWidth : 0) - (state.sidebar.visible ? state.sidebar.width : 0));
	const sidePaneWidth = state.editor.visible ? state.editor.width : state.auxiliarybar.visible ? state.auxiliarybar.width : 0;
	const sessionsWidth = Math.max(0, mainWidth - sidePaneWidth);
	return {
		type: 'branch',
		orientation: 'vertical',
		size: dimension.height,
		priority: 'normal',
		children: [
			leaf('titlebar', titlebarHeight),
			{
				type: 'branch',
				orientation: 'horizontal',
				size: bodyHeight,
				priority: SESSIONS_LAYOUT_PRIORITY,
				children: [
					leaf('activitybar', activityBarWidth, activityBarLocation === ActivityBarPosition.DEFAULT),
					leaf('sidebar', state.sidebar.width, state.sidebar.visible),
					{
						type: 'branch',
						orientation: 'vertical',
						size: mainWidth,
						priority: SESSIONS_LAYOUT_PRIORITY,
						children: [
							{
								type: 'branch',
								orientation: 'horizontal',
								size: Math.max(0, bodyHeight - (state.panel.visible ? state.panel.height : 0)),
								priority: SESSIONS_LAYOUT_PRIORITY,
								children: [
									leaf('sessions', sessionsWidth, true, SESSIONS_LAYOUT_PRIORITY),
									leaf('editor', state.editor.visible ? state.editor.width : state.auxiliarybar.width, state.editor.visible || state.auxiliarybar.visible),
									leaf('auxiliarybar', state.auxiliarybar.width, false),
								],
							},
							leaf('panel', state.panel.height, state.panel.visible),
						],
					},
				],
			},
		],
	};
}

function resolveSessionsInitialDimension(container: HTMLElement, dimension: IDimension | undefined): Dimension {
	if (dimension) {
		assertDimension(dimension);
		if (dimension.width > 0 && dimension.height > 0) return new Dimension(dimension.width, dimension.height);
	}
	return new Dimension(container.clientWidth > 0 ? container.clientWidth : DEFAULT_LAYOUT_WIDTH, container.clientHeight > 0 ? container.clientHeight : DEFAULT_LAYOUT_HEIGHT);
}

function parseSessionsPartId(value: unknown): SessionsPartId {
	if (value === 'titlebar' || value === 'activitybar' || value === 'sidebar' || value === 'sessions' || value === 'editor' || value === 'auxiliarybar' || value === 'panel') return value;
	throw new TypeError('Sessions Grid contains an unknown Part');
}

function requiredView(
	views: ReadonlyMap<SessionsPartId, WorkbenchPartView<SessionsPartId>>,
	partId: SessionsPartId,
): WorkbenchPartView<SessionsPartId> {
	const view = views.get(partId);
	if (!view) throw new Error(`Sessions Part view is not registered: ${partId}`);
	return view;
}

function assertDimension(dimension: IDimension): void {
	if (!Number.isFinite(dimension.width) || dimension.width < 0 || !Number.isFinite(dimension.height) || dimension.height < 0) {
		throw new RangeError('Sessions layout dimensions must be non-negative and finite');
	}
}

export interface SessionsWorkbenchLayoutOptions {
	readonly initialDimension?: IDimension;
	readonly initialState?: SessionsWorkbenchLayoutState;
	readonly focus?: () => void;
	readonly layoutStyle?: SessionsLayoutStyle;
	readonly activityBarLocation?: ActivityBarPosition;
}

/** Owns the fixed Part topology and mutable geometry of one dedicated Sessions window. */
class SessionsWorkbenchPartView extends WorkbenchPartView<SessionsPartId> {
	constructor(partId: SessionsPartId, part: WorkbenchPart, private readonly isEditorPrimary: () => boolean, private readonly isLayoutDeferred: () => boolean, private readonly dockedMinimumWidth: () => number, private readonly compositionChanged: Event<void>) { super(partId, part); }
	public override get minimumWidth(): number {
		return this.partId === 'editor' && !this.isEditorPrimary() ? Math.max(super.minimumWidth, this.dockedMinimumWidth()) : super.minimumWidth;
	}
	public override get onDidChange(): Event<void> { return this.partId === 'editor' ? this.compositionChanged : super.onDidChange; }
	public get priority(): 'high' | 'normal' {
		return this.partId === 'sessions' || (this.partId === 'editor' && this.isEditorPrimary()) ? 'high' : 'normal';
	}

	public override layout(bounds: IPositionedRectangle): void {
		// Page changes resize the Grid several times; sash drags still lay out Parts immediately.
		if (!this.isLayoutDeferred()) super.layout(bounds);
	}
}

export class SessionsWorkbenchLayout extends BrowserLayoutService implements IAgentWorkbenchLayoutService {
	private readonly views = new Map<SessionsPartId, SessionsWorkbenchPartView>();
	private grid!: SerializableGrid<SessionsWorkbenchPartView>;
	private partUpdateDepth = 0;
	private readonly unavailableParts = new Set<SessionsPartId>();
	private readonly desiredVisibility: { sessions: boolean; sidebar: boolean; auxiliarybar: boolean; editor: boolean; panel: boolean };
	private titlebarHeight = 0;
	private readonly initialDimension: Dimension;
	private readonly stateModel: SessionsWorkbenchLayoutStateModel;
	private readonly partVisibility = new Map<SessionsPartId, boolean>();
	private readonly _onDidChangePartVisibility = this._register(new Emitter<SessionsPartVisibilityChangeEvent>());
	private readonly compositionChanged = this._register(new Emitter<void>());
	private layoutStyle: SessionsLayoutStyle;
	private activityBarLocation: ActivityBarPosition;
	private readonly layoutPolicy = new SessionsLayoutPolicy();
	private readonly cardDomNode: HTMLDivElement;
	private dockedAuxiliaryBar!: DockedAuxiliaryBarController;
	private sidePaneWidth: number;
	private detailsWidth: number;
	private get isDocked(): boolean { return !this.unavailableParts.has('sessions'); }

	readonly onDidChangePartVisibility = this._onDidChangePartVisibility.event;
	readonly domNode: HTMLDivElement;

	constructor(container: HTMLElement, options: SessionsWorkbenchLayoutOptions, @IStorageService storageService: IStorageService) {
		super({ root: container, focus: options.focus });
		this.initialDimension = resolveSessionsInitialDimension(container, options.initialDimension);
		this.layoutStyle = options.layoutStyle ?? 'modern';
		this.activityBarLocation = options.activityBarLocation ?? ActivityBarPosition.DEFAULT;
		this.domNode = h(container.ownerDocument, 'div');
		this.domNode.className = 'ash-sessions-workbench-layout';
		container.append(this.domNode);
		this._register(toDisposable(() => this.domNode.remove()));
		this.cardDomNode = h(container.ownerDocument, 'div');
		this.cardDomNode.className = 'ash-sessions-content-card';
		this.cardDomNode.setAttribute('aria-hidden', 'true');
		this.domNode.append(this.cardDomNode);
		this.stateModel = new SessionsWorkbenchLayoutStateModel(storageService, options.initialState ?? createDefaultSessionsWorkbenchLayoutState());
		const state = this.stateModel.state;
		this.sidePaneWidth = state.editor.width;
		this.detailsWidth = state.auxiliarybar.width;
		this.desiredVisibility = { sessions: true, sidebar: state.sidebar.visible, auxiliarybar: state.auxiliarybar.visible, editor: state.editor.visible, panel: state.panel.visible };
		this._register(storageService.onWillSaveState(() => this.saveState()));
	}

	public createWorkbenchLayout(parts: ReadonlyMap<SessionsPartId, WorkbenchPart>): void {
		validateParts(parts);
		if (this.grid) {
			throw new Error('Sessions Parts are already attached');
		}
		for (const partId of sessionsPartIds) {
			this.views.set(partId, new SessionsWorkbenchPartView(partId, requiredPart(parts, partId), () => this.unavailableParts.has('sessions'), () => this.partUpdateDepth > 0, () => {
				const editorWidth = this.desiredVisibility.editor && !this.unavailableParts.has('editor') ? requiredPart(parts, 'editor').minimumWidth : 0;
				const detailsWidth = this.desiredVisibility.auxiliarybar && !this.unavailableParts.has('auxiliarybar') ? requiredPart(parts, 'auxiliarybar').minimumWidth : 0;
				return editorWidth + detailsWidth + this.layoutPolicy.getFrameMetrics(this.layoutStyle).rightEdge;
			}, this.compositionChanged.event));
		}
		this.titlebarHeight = this.view('titlebar').minimumHeight;
		this._register(requiredPart(parts, 'editor').onDidChangeConstraints(() => this.compositionChanged.fire()));
		this._register(this.view('activitybar').part.onDidChangeConstraints(() => this.projectFrameInsets()));
		const state = this.stateModel.state;
		this.projectFrameInsets(state.auxiliarybar.visible);
		this.grid = this._register(SerializableGrid.deserialize(
			this.domNode,
			createSessionsWorkbenchGridDescriptor(this.views, this.initialDimension, state, this.activityBarLocation),
			{ fromJSON: data => this.view(parseSessionsPartId(data)) },
		));
		this._register(this.grid.onDidChange(() => {
			if (this.partUpdateDepth === 0) { this.saveState(); }
		}));
		this.dockedAuxiliaryBar = this._register(new DockedAuxiliaryBarController(
			requiredPart(parts, 'editor') as EditorPart,
			this.view('auxiliarybar'),
			() => this.detailsWidth,
			width => this.resizePart('auxiliarybar', new Dimension(Math.min(460, Math.max(180, width)), this.getPartSize('auxiliarybar').height)),
		));
		// Save before the Grid is disposed; hidden views retain their cached user sizes.
		this._register(toDisposable(() => this.saveState()));
	}

	override get mainContainerOffset(): ILayoutOffsetInfo {
		return { top: this.titlebarHeight, quickInputTop: 0 };
	}

	get state(): SessionsWorkbenchLayoutState {
		return {
			version: 1,
			sidebar: { width: this.getPartSize('sidebar').width, visible: this.desiredVisibility.sidebar },
			auxiliarybar: {
				width: this.getPartSize('auxiliarybar').width,
				visible: this.desiredVisibility.auxiliarybar,
			},
			editor: {
				width: this.sidePaneWidth,
				visible: this.desiredVisibility.editor,
			},
			panel: {
				height: this.getPartSize('panel').height,
				visible: this.desiredVisibility.panel,
			},
		};
	}

	setLayoutStyle(style: SessionsLayoutStyle): void {
		if (this.layoutStyle === style) return;
		this.layoutStyle = style;
		this.projectFrameInsets();
		if (this.grid.width > 0 && this.grid.height > 0) {
			this.layout(new Dimension(this.grid.width, this.grid.height));
		}
	}

	setActivityBarLocation(location: ActivityBarPosition): void {
		if (this.activityBarLocation === location) return;
		this.activityBarLocation = location;
		this.projectFrameInsets();
		this.grid.setViewVisible(this.view('activitybar'), location === ActivityBarPosition.DEFAULT);
		if (this.grid.width > 0 && this.grid.height > 0) this.layout(new Dimension(this.grid.width, this.grid.height));
		else this.publishPartVisibility();
	}

	override layout(dimension: IDimension = getClientArea(this.mainContainer)): void {
		assertDimension(dimension);
		this.grid.layout(dimension.width, dimension.height);
		if (this.partUpdateDepth > 0) return;
		if (this.isDocked && this.desiredVisibility.editor && this.grid.isViewVisible(this.view('editor'))) {
			this.sidePaneWidth = this.grid.getViewSize(this.view('editor')).width;
		}
		const editorSize = this.grid.getViewSize(this.view('editor'));
		this.dockedAuxiliaryBar.layout(this.view('editor').getContentSize(editorSize), this.isDocked, this.desiredVisibility.editor && !this.unavailableParts.has('editor'), this.desiredVisibility.auxiliarybar && !this.unavailableParts.has('auxiliarybar'));
		this.publishPartVisibility();
		// Overlay consumers observe completed Part and nested Chat geometry.
		super.layout(dimension);
		// Reload can precede the periodic storage save; commit only the completed Part arrangement.
		this.saveState();
	}

	/** Composite and editor events can reenter page selection; only the outer selection commits Part geometry. */
	public updateParts(update: () => void): void {
		this.partUpdateDepth++;
		try {
			update();
		} finally {
			this.partUpdateDepth--;
			if (this.partUpdateDepth === 0) this.layout(new Dimension(this.grid.width, this.grid.height));
		}
	}

	isPartVisible(partId: SessionsPartId): boolean {
		if (this.isDocked && (partId === 'editor' || partId === 'auxiliarybar')) {
			return this.desiredVisibility[partId] && !this.unavailableParts.has(partId) && this.grid.isViewVisible(this.view('editor'));
		}
		return this.grid.isViewVisible(this.view(partId));
	}
	isPartAvailable(partId: SessionsPartId): boolean { return !this.unavailableParts.has(partId); }
	showPart(partId: SessionsPartId): void { this.updatePartVisibility(partId, true); }
	hidePart(partId: SessionsPartId): void { this.updatePartVisibility(partId, false); }
	getPartSize(partId: SessionsPartId): Dimension {
		if (this.isDocked && partId === 'auxiliarybar') {
			return new Dimension(this.detailsWidth, this.grid.getViewSize(this.view('editor')).height);
		}
		const size = this.grid.getViewSize(this.view(partId));
		return new Dimension(size.width, size.height);
	}
	resizePart(partId: SessionsPartId, dimension: IDimension): void {
		assertDimension(dimension);
		if (this.isDocked && partId === 'auxiliarybar') {
			this.detailsWidth = dimension.width;
			if (!this.desiredVisibility.editor) this.grid.resizeView(this.view('editor'), new Dimension(this.detailsWidth, this.grid.getViewSize(this.view('editor')).height));
			this.layout(new Dimension(this.grid.width, this.grid.height));
			return;
		}
		if (this.isDocked && partId === 'editor') this.sidePaneWidth = dimension.width;
		this.grid.resizeView(this.view(partId), dimension);
		this.layout(new Dimension(this.grid.width, this.grid.height));
	}

	private updatePartVisibility(partId: SessionsPartId, visible: boolean): void {
		if (partId === 'titlebar' || partId === 'activitybar' || partId === 'sessions') throw new Error(`Required Sessions Part cannot be hidden: ${partId}`);
		this.desiredVisibility[partId] = visible;
		if (this.isDocked && (partId === 'editor' || partId === 'auxiliarybar')) {
			this.updateDockedVisibility();
		} else {
			this.grid.setViewVisible(this.view(partId), visible && !this.unavailableParts.has(partId));
		}
		this.projectFrameInsets();
		this.layout(new Dimension(this.grid.width, this.grid.height));
	}

	public setPartAvailable(partId: 'sessions' | 'sidebar' | 'auxiliarybar' | 'editor' | 'panel', available: boolean): void {
		if (available === !this.unavailableParts.has(partId)) {
			return;
		}
		if (partId === 'sessions') {
			if (available) this.unavailableParts.delete(partId);
			else this.unavailableParts.add(partId);
			this.grid.setViewVisible(this.view('sessions'), available);
			if (this.isDocked) {
				this.updateDockedVisibility();
			} else {
				this.grid.setViewVisible(this.view('editor'), this.desiredVisibility.editor && !this.unavailableParts.has('editor'));
				this.grid.setViewVisible(this.view('auxiliarybar'), this.desiredVisibility.auxiliarybar && !this.unavailableParts.has('auxiliarybar'));
				this.grid.resizeView(this.view('auxiliarybar'), new Dimension(this.detailsWidth, this.grid.getViewSize(this.view('auxiliarybar')).height));
			}
		} else if (this.isDocked && (partId === 'editor' || partId === 'auxiliarybar')) {
			if (available) this.unavailableParts.delete(partId);
			else this.unavailableParts.add(partId);
			this.updateDockedVisibility();
		} else if (available) {
			// The outgoing center absorbs the restored center's cached width before priorities switch.
			this.grid.setViewVisible(this.view(partId), this.desiredVisibility[partId]);
			this.unavailableParts.delete(partId);
		} else {
			this.unavailableParts.add(partId);
			this.grid.setViewVisible(this.view(partId), false);
		}
		this.projectFrameInsets();
		this.layout(new Dimension(this.grid.width, this.grid.height));
	}

	private updateDockedVisibility(): void {
		const editorVisible = this.desiredVisibility.editor && !this.unavailableParts.has('editor');
		const detailsVisible = this.desiredVisibility.auxiliarybar && !this.unavailableParts.has('auxiliarybar');
		this.compositionChanged.fire();
		this.grid.setViewVisible(this.view('auxiliarybar'), false);
		this.grid.setViewVisible(this.view('editor'), editorVisible || detailsVisible);
		if (editorVisible || detailsVisible) {
			this.grid.resizeView(this.view('editor'), new Dimension(editorVisible ? this.sidePaneWidth : this.detailsWidth, this.grid.getViewSize(this.view('editor')).height));
		}
	}

	private saveState(): void { this.stateModel.save(this.state); }

	private projectFrameInsets(auxiliarybarVisible = this.isPartVisible('auxiliarybar')): void {
		const { leftEdge, rightEdge } = this.layoutPolicy.getFrameMetrics(this.layoutStyle);
		this.view('titlebar').setFrameInsets({ top: 0, right: 0, bottom: 0, left: 0 });
		// The leading menu and side navigation share a center line in both density modes.
		this.view('titlebar').part.domNode.style.setProperty('--ash-sessions-titlebar-leading-width', `${this.view('activitybar').part.minimumWidth}px`);
		this.view('activitybar').setFrameInsets({ top: 0, right: 0, bottom: 0, left: 0 });
		this.view('panel').setFrameInsets({ top: 0, right: rightEdge, bottom: rightEdge, left: 0 });
		const sidebarVisible = this.desiredVisibility.sidebar && !this.unavailableParts.has('sidebar');
		const editorVisible = this.desiredVisibility.editor && !this.unavailableParts.has('editor');
		const sessionsVisible = !this.unavailableParts.has('sessions');
		const contentLeftEdge = this.activityBarLocation === ActivityBarPosition.DEFAULT ? 0 : leftEdge;
		this.view('sidebar').setFrameInsets({ top: 0, right: 0, bottom: rightEdge, left: contentLeftEdge });
		this.view('sessions').setFrameInsets({ top: 0, right: auxiliarybarVisible || editorVisible ? 0 : rightEdge, bottom: rightEdge, left: sidebarVisible ? 0 : contentLeftEdge });
		this.view('auxiliarybar').setFrameInsets({ top: 0, right: rightEdge, bottom: rightEdge, left: 0 });
		this.view('editor').setFrameInsets({ top: 0, right: this.isDocked || !auxiliarybarVisible ? rightEdge : 0, bottom: rightEdge, left: !sidebarVisible && !sessionsVisible ? contentLeftEdge : 0 });
		const firstPart = sidebarVisible ? 'sidebar' : sessionsVisible ? 'sessions' : 'editor';
		let lastPart: SessionsPartId = 'sessions';
		if (editorVisible) lastPart = 'editor';
		if (auxiliarybarVisible) lastPart = this.isDocked ? 'editor' : 'auxiliarybar';
		for (const partId of ['sidebar', 'sessions', 'editor', 'auxiliarybar'] as const) {
			this.view(partId).part.domNode.classList.toggle('ash-sessions-frame-start', partId === firstPart);
			this.view(partId).part.domNode.classList.toggle('ash-sessions-frame-end', partId === lastPart);
		}
		// One decorative outline spans the retained Parts; it never intercepts their input or sashes.
		const activityBarWidth = this.activityBarLocation === ActivityBarPosition.DEFAULT ? this.view('activitybar').minimumWidth : 0;
		this.cardDomNode.style.top = `${this.titlebarHeight}px`;
		this.cardDomNode.style.left = `${activityBarWidth + contentLeftEdge}px`;
		this.cardDomNode.style.right = `${rightEdge}px`;
		this.cardDomNode.style.bottom = `${rightEdge}px`;
	}

	private publishPartVisibility(): void {
		for (const partId of sessionsPartIds) {
			const visible = this.isPartVisible(partId);
			if (this.partVisibility.get(partId) === visible) continue;
			this.partVisibility.set(partId, visible);
			this._onDidChangePartVisibility.fire({ partId, visible });
		}
	}

	private view(partId: SessionsPartId): SessionsWorkbenchPartView {
		const view = this.views.get(partId);
		if (!view) throw new Error(`Unknown Sessions Part: ${partId}`);
		return view;
	}
}

function validateParts(parts: ReadonlyMap<SessionsPartId, WorkbenchPart>): void {
	const missing = sessionsPartIds.filter(partId => !parts.has(partId));
	if (missing.length > 0) throw new TypeError(`Sessions layout is missing Parts: ${missing.join(', ')}`);
}

function requiredPart(parts: ReadonlyMap<SessionsPartId, WorkbenchPart>, partId: SessionsPartId): WorkbenchPart {
	const part = parts.get(partId);
	if (!part) throw new Error(`Sessions Part is not registered: ${partId}`);
	return part;
}
