import { Schemas } from '../../base/common/network.js';
import type { IFileSystemProvider } from '../../platform/files/common/fileSystemProviderService.js';
import { IUserDataProfileService } from '../../workbench/services/userDataProfile/common/userDataProfile.js';
import { UserDataProfileService } from '../../workbench/services/userDataProfile/browser/userDataProfileService.js';
import { IKeybindingEditingService, KeybindingsEditingService } from '../../workbench/services/keybinding/common/keybindingEditing.js';
import { ITextModelService } from '../../editor/common/services/resolverService.js';
import { TextModelResolverService } from '../../workbench/services/textmodelResolver/common/textModelResolverService.js';
import { ServiceCollection } from '../../platform/instantiation/common/serviceCollection.js';
import { getSingletonServiceDescriptors } from '../../platform/instantiation/common/extensions.js';
import { IAssetService, type AssetVersion } from '../../platform/assets/common/assetService.js';
import { IApprovalEnvironmentService } from '../../platform/approvalEnvironment/common/approvalEnvironmentService.js';
import { IModelApi as ModelApiId } from '../../platform/sessions/common/sessionApi.js';
import { AppServerAvailableContext, IsSessionsWindowContext, WorkspaceFolderCountContext } from '../../workbench/common/contextkeys.js';
import { EditorPanes } from '../../workbench/browser/editor.js';
import { EditorContextKeyController } from '../../workbench/browser/parts/editor/editorContextKeys.js';
import { IAppServerApi as AppServerApiId, IServerEventApi as ServerEventApiId } from '../../platform/app-server/common/appServerApi.js';
import { ILanguageModelsService, LanguageModelsService } from '../../workbench/contrib/chat/common/languageModels.js';
import { ILanguageModelsConfigurationService } from '../../workbench/contrib/chat/common/languageModelsConfiguration.js';
import { ChatModelPreferences, LanguageModelsConfigurationService } from '../../workbench/contrib/chat/browser/languageModelsConfigurationService.js';
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
import { h, type IDimension } from "../../base/browser/dom.js";
import type { Event } from '../../base/common/event.js';
import { SessionsViewRegistry } from '../common/views.js';
import { ViewContainerLocation } from '../../workbench/common/views.js';
import { DesignEditorService, IDesignEditorService } from '../contrib/creator/browser/designEditorService.js';
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
import { ILanguageConfigurationService } from '../../editor/common/languages/languageConfigurationRegistry.js';
import { ILanguageFeaturesService } from '../../editor/common/services/languageFeatures.js';
import { LanguageFeaturesService } from '../../editor/common/services/languageFeaturesService.js';
import { NewChatInputWidget } from '../contrib/chat/browser/newChatInput.js';
import { CoworkPaneFactory } from '../contrib/cowork/browser/cowork.contribution.js';
import { ISessionsConversationService } from '../services/sessions/common/sessionsConversation.js';
import { ChatTipService, IChatTipService } from '../../workbench/contrib/chat/browser/chatTipService.js';
import { migrateNewChatDraftState, writeNewChatDraftState } from '../contrib/chat/common/newChatDraftState.js';
import { IAccessibilityService } from '../../platform/accessibility/common/accessibility.js';
import { AccessibilityService } from '../../platform/accessibility/browser/accessibilityService.js';
import { ILogService } from '../../platform/log/common/log.js';
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
import type { INativeHostApi, IOpenAgentsWindowOptions } from '../../platform/native/common/nativeHost.js';
import { IStorageService, WillSaveStateReason, StorageScope } from "../../platform/storage/common/storage.js";
import { IThemeService } from "../../platform/theme/common/themeService.js";
import { WorkbenchState, IWorkspaceContextService, type IWorkspace } from "../../platform/workspace/common/workspace.js";
import { SessionsWorkspaceContextService } from '../services/workspace/browser/workspaceContextService.js';
import { GitService } from '../../workbench/contrib/git/browser/gitService.js';
import { IGitService } from '../../workbench/contrib/git/common/gitService.js';
import { SessionFileService } from '../contrib/providers/appServer/browser/sessionFileService.js';
import { IFileService } from '../../platform/files/common/files.js';
import { ISystemFileTransferService } from '../../platform/files/common/systemFileTransferService.js';
import { IClipboardService } from '../../platform/clipboard/common/clipboardService.js';
import { IDialogService, IFileDialogService } from '../../platform/dialogs/common/dialogs.js';
import type { HTMLFileSystemProvider } from '../../platform/files/browser/htmlFileSystemProvider.js';
import { MultiplexFileService } from '../../platform/files/browser/multiplexFileService.js';
import type { DialogService } from '../../workbench/services/dialogs/common/dialogService.js';
import { IDialogsModel } from '../../workbench/common/dialogs.js';
import { BrowserDialogHandler } from '../../workbench/browser/parts/dialogs/dialog.js';
import { DialogHandlerContribution } from '../../workbench/browser/parts/dialogs/dialog.web.contribution.js';
import { ILabelService, LabelService } from '../../platform/label/common/labelService.js';
import { IResourceIconRenderer, IResourceLabelService, ResourceLabelService } from '../../workbench/browser/labels.js';
import { IDecorationsService } from '../../workbench/services/decorations/common/decorations.js';
import { DecorationsService } from '../../workbench/services/decorations/browser/decorationsService.js';
import { ITextFileService, TextFileService } from '../../workbench/services/textfile/common/textFileService.js';
import { IWorkingCopyService } from '../../workbench/services/workingCopy/common/workingCopyService.js';
import { BrowserWorkingCopyService } from '../../workbench/services/workingCopy/browser/browserWorkingCopyService.js';
import { IUntitledTextEditorService, UntitledTextEditorService } from '../../workbench/services/untitled/common/untitledTextEditorService.js';
import { TextFileEditorTracker } from '../../workbench/contrib/files/browser/editors/textFileEditorTracker.js';
import { ITextModelResourceService, IFileTextModelService } from '../../workbench/services/textmodelResolver/common/textModelResourceService.js';
import { getBrowserTextModelService } from '../../workbench/services/textmodelResolver/browser/browserTextModelService.js';
import { getBrowserTextResourceStore } from '../../workbench/contrib/codeEditor/browser/browserTextResourceStore.js';
import { BrowserTextMateService } from '../../workbench/services/textMate/browser/browserTextMateService.js';
import { ITextMateService } from '../../workbench/services/textMate/common/textMateService.js';
import { AppServerExtensionService } from '../../workbench/services/extensions/browser/appServerExtensionService.js';
import { IExtensionService } from '../../workbench/services/extensions/common/extensionService.js';
import { DiffService } from '../../workbench/services/diff/browser/diffService.js';
import { IDiffService } from '../../workbench/services/diff/common/diffService.js';
import { IEditorPart } from '../../workbench/browser/parts/editor/editorPart.js';
import { EditorPart } from './parts/editor/editorPart.js';
import { BrowserEditorService } from '../../workbench/services/editor/browser/browserEditorService.js';
import { IEditorService } from '../../workbench/services/editor/common/editorService.js';
import { IEditorGroupsService } from '../../workbench/services/editor/common/editorGroupsService.js';
import { IViewDescriptorService } from '../../workbench/common/views.js';
import { ViewDescriptorService } from '../../workbench/services/views/browser/viewDescriptorService.js';
import { IViewsService } from '../../workbench/services/views/common/viewsService.js';
import { ViewsService } from '../../workbench/services/views/browser/viewsService.js';
import type { SessionWorkspaceSelection } from '../services/sessions/common/session.js';
import { pickWorkspaceFolder } from './workspaceSelection.js';
import type { Part } from "../../workbench/browser/part.js";
import type { ContextMenuServiceFactory } from "../../platform/contextview/browser/contextMenuService.js";
import { setHoverDelegate } from "../../base/browser/ui/hover/hoverDelegate.js";
import { IMenuService } from "../../platform/actions/common/actions.js";
import { MenuService } from "../../platform/actions/common/menuService.js";
import { CommandsRegistry, ICommandService } from "../../platform/commands/common/commands.js";
import { IContextKeyService, ContextKeyService } from "../../platform/contextkey/browser/contextKeyService.js";
import { IExtensionHostApi } from '../../platform/extensionHost/common/extensionHostApi.js';
import { ITelemetryService } from '../../platform/telemetry/common/telemetry.js';
import { NullTelemetryService } from '../../platform/telemetry/common/telemetryUtils.js';
import { IContextMenuService, IContextViewService } from "../../platform/contextview/browser/contextView.js";
import { BrowserContextViewService } from "../../platform/contextview/browser/contextViewService.js";
import { HoverService, IHoverService } from "../../platform/hover/browser/hoverService.js";
import { IKeybindingService } from "../../platform/keybinding/common/keybinding.js";
import { IKeyboardLayoutService } from "../../platform/keyboardLayout/common/keyboardLayout.js";
import { IUserKeyboardLayoutService, UnavailableUserKeyboardLayoutService } from "../../platform/keyboardLayout/common/userKeyboardLayout.js";
import { IQuickInputService } from "../../platform/quickinput/common/quickInput.js";
import { IQuickAccessController } from "../../platform/quickinput/common/quickAccess.js";
import { QuickAccessController } from "../../platform/quickinput/browser/quickAccess.js";
import { IOpenerService } from "../../platform/opener/common/opener.js";
import { IBrowserViewService } from '../../platform/browserView/common/browserView.js';
import '../../workbench/contrib/externalUriOpener/common/externalUriOpener.contribution.js';
import { OpenerService } from '../../editor/browser/services/openerService.js';
import { CommandService } from "../../workbench/services/commands/common/commandService.js";
import { BrowserKeyboardLayoutService } from "../../workbench/services/keybinding/browser/keyboardLayoutService.js";
import { WorkbenchKeybindingService } from "../../workbench/services/keybinding/browser/keybindingService.js";
import { IKeyboardShortcutTroubleshootingService } from "../../workbench/services/keybinding/common/keyboardShortcutTroubleshooting.js";
import { IPreferencesService } from "../../workbench/services/preferences/common/preferences.js";
import { PreferencesService } from "../../workbench/services/preferences/browser/preferencesService.js";
import { WorkbenchQuickInputService } from "../../workbench/services/quickinput/browser/quickInputService.js";
import { ChatContextPickService } from "../../workbench/services/chat/browser/chatContextPickService.js";
import { IChatContextPickService } from "../../workbench/services/chat/common/chatContextService.js";
import { WorkbenchWindow } from "../../workbench/browser/window.js";
import { AccessibleViewService } from '../../workbench/contrib/accessibility/browser/accessibleView.js';
import { IAccountService } from '../../platform/accounts/common/accountService.js';
import { IGitHubService } from '../../platform/github/common/githubService.js';
import { GitHubConnectionService } from '../../workbench/services/accounts/browser/gitHubConnectionService.js';
import { IGitHubConnectionService } from '../../workbench/services/accounts/common/gitHubConnectionService.js';
import { BrowserClipboardService } from '../../platform/clipboard/browser/clipboardService.js';
import { INativeHostService } from '../../workbench/common/services.js';
import { ActivityBarPosition } from '../../workbench/common/configuration.js';
import { ChatService } from "../../workbench/services/chat/browser/chatService.js";
import { AppServerAccountService } from '../../workbench/services/accounts/browser/appServerAccountService.js';
import { IChatService } from "../../workbench/services/chat/common/chatService.js";
import { ConfigurationService } from '../services/configuration/browser/configurationService.js';
import type { ExtensionColorThemeService } from "../../workbench/services/extensions/browser/extensionColorThemeService.js";
import type { BrowserStorageServiceOptions } from "../../workbench/services/storage/browser/storageService.js";
import { IWorkbenchHostService } from "../../workbench/services/host/common/workbenchHostService.js";
import { WorkbenchThemeService } from "../../workbench/services/themes/browser/workbenchThemeService.js";
import { IHostColorSchemeService } from '../../workbench/services/themes/common/hostColorSchemeService.js';
import { AppServerSessionsProvider, type AppServerSessionsProviderHost } from "../contrib/providers/appServer/browser/appServerSessionsProvider.js";
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
import { ISessionsLayoutService } from '../services/layout/common/sessionsLayoutService.js';
import { registerLayoutActions } from './layoutActions.js';
import { PanelPart } from './parts/panel/panelPart.js';
import { ITerminalProcessService } from '../../platform/terminal/common/terminal.js';
import { installWorkbenchServiceContributions } from '../../workbench/browser/workbenchServiceContributions.js';
import { AuxiliaryBarPart } from "./parts/auxiliarybar/auxiliaryBarPart.js";
import { disposableWindowTimeout } from '../../base/browser/scheduler.js';
import { ActivityBarPart } from './parts/activitybar/activityBarPart.js';
import type { PaneCompositePart } from '../../workbench/browser/parts/paneCompositePart.js';
import { PaneCompositePartService } from '../../workbench/browser/parts/paneCompositePartService.js';
import { IPaneCompositePartService } from '../../workbench/services/panecomposite/browser/panecomposite.js';
import { SessionsPart, type SessionsPartOptions } from "./parts/sessions/sessionsPart.js";
import { CreatorMode } from '../contrib/creator/common/creator.js';
import { SidebarPart, registerSessionsNavigation } from "./parts/sidebar/sidebarPart.js";
import type { TitlebarPart } from "./parts/titlebar/titlebarPart.js";

export interface IWorkbenchOptions {
	readonly createTextDocumentHost?: (services: IInstantiationService) => IDisposable;
	readonly contributionIds: readonly string[];
	readonly profile: SessionsProfile;
	readonly api: IRendererHost;
	readonly workspaceSelection: () => SessionWorkspaceSelection;
	readonly workspace: () => IWorkspace;
	readonly browserFileSystemProvider?: HTMLFileSystemProvider;
	readonly browserViewService?: IBrowserViewService;
	readonly createFileDialogService: (services: IInstantiationService) => IFileDialogService;
	readonly createLifecycleService: (services: IInstantiationService) => ILifecycleService & IDisposable;
	readonly createStorageService: (options: BrowserStorageServiceOptions) => Promise<IStorageService & IDisposable>;
	readonly createLogService: () => LogService;
	readonly nativeHostApi?: INativeHostApi;
	readonly returnToWorkbench: () => void;
	readonly configurationApi?: IConfigurationApi;
	readonly initialConfigurationSnapshot?: IConfigurationSnapshot;
	readonly createUserDataFileSystemProvider: () => Promise<IFileSystemProvider & IDisposable>;
	readonly createContextMenuService: ContextMenuServiceFactory;
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

		const configurationService = this.configurationService = this._register(new ConfigurationService({ api: options.configurationApi, initialSnapshot: options.initialConfigurationSnapshot }));
		const serviceCollection = new ServiceCollection();
		// Load service descriptions before consumers so shared dependencies resolve in this window's scope.
		for (const [id, descriptor] of getSingletonServiceDescriptors()) {
			serviceCollection.set(id, descriptor);
		}
		const services = this._register(new InstantiationService(serviceCollection));
		const serviceContributionReady: Promise<void>[] = [];
		if (options.browserViewService) { services.registerInstance(IBrowserViewService, options.browserViewService); }
		services.registerInstance(IAssetService, options.api.assets);
		services.registerInstance(IExtensionHostApi, options.api.extensionHost);
		services.registerInstance(ITelemetryService, NullTelemetryService);
		if (options.api.approvalEnvironment) { services.registerInstance(IApprovalEnvironmentService, options.api.approvalEnvironment); }
		services.registerInstance(IDictationService, options.api.dictation);
		services.registerSingleton(IChatSpeechToTextService, () => services.createInstance(ChatSpeechToTextService));
		services.registerSingleton(IDictationOnboardingService, () => services.createInstance(DictationOnboardingService));
		services.registerInstance(ILocalTranscriptionService, options.api.localTranscription ?? this._register(new NullLocalTranscriptionService()));
		services.registerInstance(IConfigurationService, configurationService);
		if (options.nativeHostApi) services.registerInstance(INativeHostService, options.nativeHostApi);
		const languageService = this._register(new LanguageService());
		services.registerInstance(ILanguageService, languageService);
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
			workbenchState: WorkbenchState.EMPTY,
		}));
		services.registerInstance(IWorkbenchHostService, workbenchWindow);
		services.registerInstance(AppServerApiId, options.api.appServer);
		services.registerInstance(IRendererHostService, options.api);
		const sessions = this._register(new SessionsManagementService(services.createInstance(AppServerSessionsProvider, {
			session: options.api.session,
			workspace: options.workspaceSelection,
			selectWorkspace: folders => pickWorkspaceFolder(services.get(IQuickInputService), folders),
			model: options.api.model,
			turn: options.api.turn,
			events: options.api.events,
		} satisfies AppServerSessionsProviderHost)));
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
		services.registerInstance(IGitService, this._register(services.createInstance(GitService, { api: options.api.git, appServerApi: options.api.appServer, eventApi: options.api.events, workspaceContext: workspace, canCloneRepository: options.nativeHostApi !== undefined })));
		const files = this._register(services.createInstance(SessionFileService, options.api));
		const fileService = this._register(new MultiplexFileService(files));
		this._register(userDataFileSystemProvider);
		this._register(fileService.registerProvider(Schemas.vscodeUserData, userDataFileSystemProvider));
		services.registerInstance(IUserDataProfileService, new UserDataProfileService());
		if (options.browserFileSystemProvider) {
			this._register(fileService.registerProvider('file', options.browserFileSystemProvider));
		}
		services.registerInstance(IFileService, fileService);
		services.registerInstance(ISystemFileTransferService, files);
		services.registerInstance(ILabelService, this._register(new LabelService(workspace)));
		services.registerInstance(IResourceIconRenderer, themeService);
		services.registerInstance(IDecorationsService, this._register(services.createInstance(DecorationsService, ownerDocument)));
		services.registerSingleton(IResourceLabelService, () => services.createInstance(ResourceLabelService));
		services.registerSingleton(IUntitledTextEditorService, () => services.createInstance(UntitledTextEditorService));
		services.registerInstance(IClipboardService, new BrowserClipboardService(ownerWindow.navigator.clipboard));
		const textFiles = this._register(services.createInstance(TextFileService, fileService));
		services.registerInstance(ITextFileService, textFiles);
		const workingCopies = this._register(new BrowserWorkingCopyService());
		services.registerInstance(IWorkingCopyService, workingCopies);
		const textMate = this._register(new BrowserTextMateService());
		services.registerInstance(ITextMateService, textMate);
		const extensionService = this._register(new AppServerExtensionService({ api: options.api.extensions, eventApi: options.api.events, textMateService: textMate, languageService, languageConfigurationService: services.get(ILanguageConfigurationService), languageFeaturesService: services.get(ILanguageFeaturesService) }));
		services.registerInstance(IExtensionService, extensionService);
		const extensionReady = extensionService.start();
		void extensionReady.catch(error => logger.error('extensions', 'Declarative extension activation failed', error));
		const textModels = this._register(getBrowserTextModelService(getBrowserTextResourceStore(textFiles), {
			languageService,
			languageConfigurationService: services.get(ILanguageConfigurationService),
			languageFeaturesService: services.get(ILanguageFeaturesService),
			syntaxService: { workerFactory: textMate.syntaxWorkerFactory },
			onDidChangeLanguageSupport: textMate.onDidChange,
		}));
		services.registerInstance(ITextModelResourceService, textModels);
		services.registerInstance(IFileTextModelService, textModels);
		services.registerSingleton(IKeybindingEditingService, () => services.createInstance(KeybindingsEditingService));
		services.registerSingleton(ITextModelService, () => services.createInstance(TextModelResolverService));
		if (options.createTextDocumentHost) { this._register(options.createTextDocumentHost(services)); }
		services.registerInstance(IChatService, chat);
		services.registerInstance(ModelApiId, options.api.model);
		services.registerInstance(ServerEventApiId, options.api.events);
		services.registerInstance(ILanguageModelsConfigurationService, this._register(services.createInstance(LanguageModelsConfigurationService, ChatModelPreferences)));
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
		services.registerInstance(IGitHubService, options.api.github);
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
		const dialogs = services.get(IDialogService) as DialogService;
		services.registerInstance(IDialogsModel, dialogs.model);
		services.registerInstance(ILocaleService, this._register(services.createInstance(WorkbenchLocaleService)));
		this._register(new DialogHandlerContribution(dialogs.model, new BrowserDialogHandler(this.domNode)));

		let sessionsPart: SessionsPart | undefined;
		const layout = this.layoutService = this._register(services.createInstance(layoutConstructor, this.domNode, {
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
		const commandService = this._register(new CommandService(services));
		services.registerInstance(ICommandService, commandService);
		const openerService = this._register(services.createInstance(OpenerService));
		if (options.nativeHostApi) {
			openerService.setDefaultExternalOpener({ openExternal: options.nativeHostApi.openExternal.bind(options.nativeHostApi) });
		}
		services.registerInstance(IOpenerService, openerService);
		services.registerInstance(IUserKeyboardLayoutService, UnavailableUserKeyboardLayoutService);
		this._register(CommandsRegistry.register(RETURN_TO_WORKBENCH_COMMAND_ID, () => options.returnToWorkbench()));
		const contextKeys = this._register(new ContextKeyService());
		AppServerAvailableContext.bindTo(contextKeys).set(options.api.hasAppServer);
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
		services.registerInstance(IGitHubConnectionService, this._register(services.createInstance(GitHubConnectionService)));
		const notificationsCenter = this._register(new NotificationsCenter(this.domNode, feedbackHost, notificationService, undefined, contextKeys, () => services.get(IAccessibleViewService).getOpenAriaHint(AccessibilityVerbositySettingId.Notifications)));
		services.registerInstance(INotificationsCenter, notificationsCenter);
		const keyboardLayoutService = this._register(new BrowserKeyboardLayoutService({
			navigator: ownerWindow.navigator,
			configurationService,
			userLayoutProvider: UnavailableUserKeyboardLayoutService,
		}));
		services.registerInstance(IKeyboardLayoutService, keyboardLayoutService);
		const keybindings = this._register(services.createInstance(WorkbenchKeybindingService, {
			ownerDocument,
			commandService,
			contextKeyService: contextKeys,
			keyboardLayoutService,
		}));
		services.registerInstance(IKeybindingService, keybindings);
		const keybindingsReady = keybindings.initialize().catch(error => { notificationService.warning(localize({ bundle: 'ash', key: 'keybindings.invalid' }, 'Could not load keybindings.json: {0}', String(error))); });
		services.registerInstance(IKeyboardShortcutTroubleshootingService, keybindings);
		const menus = new MenuService(commandService, contextKeys);
		services.registerInstance(IMenuService, menus);
		const contextViews = this._register(new BrowserContextViewService(this.layoutService.activeContainer, this.layoutService));
		services.registerInstance(IContextViewService, contextViews);
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
		const accessibleViewService = this._register(services.createInstance(AccessibleViewService));
		services.registerInstance(IAccessibleViewService, accessibleViewService);
		const preferences = this._register(services.createInstance(SessionsPreferences, this.domNode, () => { void commandService.executeCommand('sessions.open.code').catch(error => notificationService.error(String(error))); }));
		this._register(CommandsRegistry.register(OPEN_PLUGINS_COMMAND_ID, () => preferences.open('plugins', { mode: 'installed' })));
		this._register(CommandsRegistry.register(OPEN_MARKETPLACE_COMMAND_ID, (_accessor, value: unknown) => {
			const options = value as MarketplaceOpenOptions | string | undefined;
			return preferences.open('plugins', typeof options === 'string' ? { query: options.trim() } : { mode: 'browse', ...options });
		}));
		const accountMenu = this._register(new SessionsAccountMenu(accountService, contextMenus, preferences, options.returnToWorkbench));

		let auxiliarybar: AuxiliaryBarPart | undefined;
		const titlebar = this._register(options.createTitlebarPart(this.domNode, services));
		const viewDescriptors = this._register(services.createInstance(ViewDescriptorService, { registry: SessionsViewRegistry }));
		services.registerInstance(IViewDescriptorService, viewDescriptors);
		services.registerSingleton(IDesignEditorService, () => services.createInstance(DesignEditorService));
		this._register(registerSessionsNavigation(async () => {
			const catalog = await options.api.session.listAgents();
			return catalog.agents.map(agent => ({ name: agent.name, description: agent.description, role: { type: 'exact' as const, name: agent.name, source: agent.source } }));
		}));
		const sidebar = this._register(services.createInstance(SidebarPart, this.domNode));
		const recoveredDrafts = migrateNewChatDraftState(storage);
		this._register(CommandsRegistry.register('sessions.library.useInDesign', async (_accessor, value) => {
			const version = value as AssetVersion;
			const design = services.get(IDesignEditorService);
			await commandService.executeCommand('sessions.creator.openMode', CreatorMode.Design);
			await design.activeEditor.get()!.adoptAssetVersion(version);
		}));
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
		this._register(CommandsRegistry.register('sessions.library.addToChat', async (_accessor, value) => {
			const version = value as AssetVersion;
			const bytes = await options.api.assets.readVersion(version);
			let binary = '';
			for (let offset = 0; offset < bytes.length; offset += 8192) { binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192)); }
			const content = `data:${version.mediaType};base64,${btoa(binary)}`;
			await this.showChat();
			sessionsPart!.addContext({ id: version.versionId, name: version.name, kind: 'image', resolve: async () => ({ name: version.name, content, kind: 'image' }) });
			sessionsPart!.focus();
		}));
		this.showChat = () => commandService.executeCommand<void>('sessions.open.chat');
		const activitybar = this._register(services.createInstance(ActivityBarPart, this.domNode, {
			showAccountMenu: (anchor: HTMLElement) => accountMenu.show(anchor),
		}));
		const activityBarLocation = configurationService.getValue<ActivityBarPosition>(SessionsConfiguration.activityBarLocation);
		activitybar.setCompact(configurationService.getValue<boolean>(SessionsConfiguration.activityBarCompact));
		const setActivityBarLocation = (location: ActivityBarPosition): void => {
			activitybar.setLocation(location, sidebar.setActivityBarLocation(location));
			titlebar.setActivityActions(
				location === ActivityBarPosition.TOP || location === ActivityBarPosition.BOTTOM ? [activitybar.accountAction] : [],
				(action, options) => activitybar.createAccountActionViewItem(action, options, 'titlebar'),
			);
		};
		setActivityBarLocation(activityBarLocation);
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
					() => localize('sessions.activity.help', 'Sessions Activity Bar\nUse Tab and Shift+Tab to enter navigation and Accounts. Use arrow keys, Home and End to move between actions. Press Enter or Space to open the focused action. Drag icons to reorder them, or choose Move earlier and Move later with the Context Menu key or Shift+F10. Navigation order is saved across restarts and Activity Bar positions. The menu also offers position and size options. Chat focuses the sessions list. Chat and Code share the selected session, navigation history, unsent text and attachments; switching changes the layout. Each session restores its editor tabs. Toggle Code panel shows or hides the bottom tools. Toggle details, Hide editor and Show editor change the side panel. Toggle Code side panel closes and reopens the composition. Changes and Files tabs remain available in Details-only mode. Use arrow keys on separators to resize. Collaboration opens Teams in the sidebar. Library and Creator are product pages selected from the Activity Bar. Library retains its search, categories and view choice. Creator opens seven workspaces. Creator home returns to the mode list. Each workspace retains its document, selection and viewport. Code retains its own file and comparison tabs when you leave the page. Accounts opens the account menu, which includes Return to Workbench.'),
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
			chatService: chat,
			contextMenuService: contextMenus,
			contextViewService: contextViews,
			accessibleViewService,
			notifications: notificationService,
			commandService,
			createInputPart: (container, delegate, model) => services.createInstance(NewChatInputWidget, container, delegate, model),
			createCoworkPane: (container, panelId, selection) => cowork.createPane(container, panelId, selection, () => { view.openNewSession(); }),
			activateSelection: selection => view.activateSelection(selection),
			closeSelection: selection => {
				view.closeVisibleSelection(selection);
				if (selection.kind === 'untitled') {
					writeNewChatDraftState(storage, undefined, `untitled:${selection.session.untitledSessionId}`);
				}
			},
			createNewSession: () => { view.openNewSession(); },
		} satisfies SessionsPartOptions));
		services.registerInstance(ISessionsConversationService, sessionsPart);
		const updateSessionsPart = (): void => {
			const selection = view.getSelection();
			sessionsPart?.updateVisibleSelections(selection.visibleSelections, selection.activeSelection);
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
				void this.showChat().then(() => {
					sessionsPart!.appendToDraft(text);
					sessionsPart!.focus();
				}).catch(error => notificationService.error(String(error)));
			},
			captureActiveDraft: () => sessionsPart!.captureActiveDraft(),
			openConversation: async (sessionId, threadId) => { await this.showChat(); await view.openThread(sessionId, threadId); },
		});

		const diffService = new DiffService();
		services.registerInstance(IDiffService, diffService);
		const editor = this._register(services.createInstance(EditorPart, this.domNode, {
			configurationService,
			contextKeyService: contextKeys,
			keybindingService: keybindings,
			keyboardLayoutService,
			fileService,
			textFileService: textFiles,
			textMateService: textMate,
			languageResolver: languageService,
			languageFeaturesService: services.get(ILanguageFeaturesService),
			diffService,
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
		const workbenchPreferences = this._register(services.createInstance(PreferencesService));
		services.registerInstance(IPreferencesService, {
			openSettings: category => preferences.open(category),
			openUserSettings: options => workbenchPreferences.openUserSettings(options),
			openGlobalKeybindingSettings: textual => workbenchPreferences.openGlobalKeybindingSettings(textual),
		});
		services.registerInstance(IEditorGroupsService, editors);
		this._register(services.createInstance(TextFileEditorTracker, ownerWindow));
		auxiliarybar = this._register(services.createInstance(AuxiliaryBarPart, this.domNode));
		services.registerInstance(ITerminalProcessService, options.api.terminal);
		installWorkbenchServiceContributions({ container: services, register: value => this._register(value), blockRestorationUntil: operation => serviceContributionReady.push(operation) });
		const panel = this._register(services.createInstance(PanelPart, this.domNode));
		const panes = this._register(services.createInstance(PaneCompositePartService, new Map<ViewContainerLocation, PaneCompositePart>([
			[ViewContainerLocation.Sidebar, sidebar],
			[ViewContainerLocation.Panel, panel],
			[ViewContainerLocation.AuxiliaryBar, auxiliarybar],
		])));
		services.registerInstance(IPaneCompositePartService, panes);
		const views = this._register(services.createInstance(ViewsService));
		services.registerInstance(IViewsService, views);
		const parts = new Map<SessionsPartId, Part>([
			["titlebar", titlebar],
			['activitybar', activitybar],
			["sidebar", sidebar],
			["sessions", sessionsPart],
			['editor', editor],
			["auxiliarybar", auxiliarybar],
			['panel', panel],
		]);
		layout.createWorkbenchLayout(parts);
		this._register(this.lifecycleService.onBeforeShutdown(event => {
			event.veto(editor.confirmCloseAllEditors().then(confirmed => !confirmed), 'Sessions unsaved files');
		}));
		this._register(configurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(SessionsConfiguration.activityBarLocation)) {
				const location = configurationService.getValue<ActivityBarPosition>(SessionsConfiguration.activityBarLocation);
				setActivityBarLocation(location);
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
		const entryLayout = services.get(ISessionsLayoutService);
		this.lifecycleService.phase = LifecyclePhase.Ready;
		this.whenRestored = Promise.all([keybindingsReady, extensionReady, ...serviceContributionReady]).then(() => this.initialize(view, configurationService, ownerWindow, entryLayout, contributions, storage, recoveredDrafts));
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

	private async initialize(view: SessionsService, configurationService: ConfigurationService, ownerWindow: Window, entryLayout: ISessionsLayoutService, contributions: WorkbenchContributionHost, storage: IStorageService, recoveredDrafts: ReturnType<typeof migrateNewChatDraftState>): Promise<void> {
		await configurationService.reloadConfiguration();
		await view.initialize();
		if (this.isDisposed) return;
		if (!view.activeSelection) view.openNewSession();
		const selected = view.activeSelection!;
		for (const recovered of recoveredDrafts) {
			const session = view.openNewSession(undefined, { sideBySide: true });
			writeNewChatDraftState(storage, recovered.draft, `untitled:${session.untitledSessionId}`);
			this.sessionsPart.restoreDraft(recovered.draft);
			storage.remove(recovered.key, StorageScope.WORKSPACE);
		}
		view.activateSelection(selected);
		await entryLayout.restore();
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
	createWorkbenchLayout(parts: ReadonlyMap<SessionsPartId, Part>): void;
	setActivityBarLocation(location: ActivityBarPosition): void;
	layout(dimension?: IDimension): void;
	readonly onDidChangePartVisibility: Event<SessionsPartVisibilityChangeEvent>;
	setLayoutStyle(style: SessionsLayoutStyle): void;
	/** Determines which center absorbs window resizing; supporting Parts retain their user widths. */
	setPrimaryPart(partId: 'sessions' | 'editor'): void;
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
