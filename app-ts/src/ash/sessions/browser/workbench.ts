import "../../workbench/browser/style.js";
import "./media/workbench.css";
import "./actions/sessionsChatActions.js";
import './activityBarAccessibility.js';
import '../../workbench/contrib/accessibility/browser/accessibilityConfiguration.js';
import '../../workbench/browser/parts/notifications/notificationsCommands.js';
import '../../workbench/contrib/accessibility/browser/accessibleViewActions.js';
import { h } from "../../base/browser/dom.js";
import { bindResizableLayout } from "../../base/browser/ui/resizable/resizable.js";
import { Disposable, toDisposable, type IDisposable } from "../../base/common/lifecycle.js";
import { ILanguageService } from "../../editor/common/languages/language.js";
import { LanguageService } from "../../editor/common/services/languageService.js";
import { localize } from '../../nls.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId, IAccessibleViewService } from '../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../platform/accessibility/browser/accessibleViewRegistry.js';
import type { IConfigurationApi, IConfigurationSnapshot } from "../../platform/configuration/common/configurationIpc.js";
import { IConfigurationService } from "../../platform/configuration/common/configuration.js";
import { ContextKeyExpr } from '../../platform/contextkey/common/contextkey.js';
import { ServiceContainer } from "../../platform/instantiation/common/instantiation.js";
import type { IKeybindingsResourceApi } from "../../platform/keybinding/common/keybindingsResource.js";
import { BrowserLayoutService, ILayoutService } from "../../platform/layout/browser/layoutService.js";
import { ILifecycleService, type ShutdownReason } from "../../workbench/services/lifecycle/common/lifecycle.js";
import { NotificationService } from "../../workbench/services/notification/common/notificationService.js";
import { INotificationsCenter, NotificationsCenter } from "../../workbench/browser/parts/notifications/notificationsCenter.js";
import { INotificationService } from "../../platform/notification/common/notification.js";
import type { IRendererHost } from "../../platform/renderer/common/rendererHost.js";
import type { INativeHostApi, IOpenAgentsWindowOptions } from '../../platform/native/common/nativeHost.js';
import { IStorageService, WillSaveStateReason } from "../../platform/storage/common/storage.js";
import { IThemeService } from "../../platform/theme/common/themeService.js";
import { WorkbenchState } from "../../platform/workspace/common/workspace.js";
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
import { IPreferencesService } from "../../workbench/services/preferences/common/preferences.js";
import { PreferencesService } from "../../workbench/services/preferences/browser/preferencesService.js";
import { IEditorService } from "../../workbench/services/editor/common/editorService.js";
import { WorkbenchQuickInputService } from "../../workbench/services/quickinput/browser/quickInputService.js";
import { ChatContextPickService } from "../../workbench/services/chat/browser/chatContextPickService.js";
import { IChatContextPickService } from "../../workbench/services/chat/common/chatContextService.js";
import { WorkbenchWindow } from "../../workbench/browser/window.js";
import { AccessibleViewService } from '../../workbench/contrib/accessibility/browser/accessibleView.js';
import { IAccountService } from '../../platform/accounts/common/accountService.js';
import { BrowserClipboardService } from '../../platform/clipboard/browser/clipboardService.js';
import { INativeHostService } from '../../workbench/common/services.js';
import { WorkbenchModeRegistry, type WorkbenchModeId } from "../../workbench/common/workbenchMode.js";
import type { ActivityBarPosition } from '../../workbench/common/configuration.js';
import { ChatService } from "../../workbench/services/chat/browser/chatService.js";
import { AppServerAccountService } from '../../workbench/services/accounts/browser/appServerAccountService.js';
import { IChatService } from "../../workbench/services/chat/common/chatService.js";
import { WorkbenchConfigurationService } from "../../workbench/services/configuration/browser/configurationService.js";
import { ExtensionColorThemeService } from "../../workbench/services/extensions/browser/extensionColorThemeService.js";
import { BrowserStorageService } from "../../workbench/services/storage/browser/storageService.js";
import { IWorkbenchHostService } from "../../workbench/services/host/common/workbenchHostService.js";
import { WorkbenchThemeService } from "../../workbench/services/themes/browser/workbenchThemeService.js";
import { AppServerSessionsProvider } from "../contrib/providers/appServer/browser/appServerSessionsProvider.js";
import { AppServerTeamsProvider } from '../contrib/providers/appServer/browser/appServerTeamsProvider.js';
import { TeamsManagementService } from '../services/teams/browser/teamsManagementService.js';
import { ITeamsManagementService } from '../services/teams/common/teamsManagement.js';
import { SessionsAccountMenu } from '../contrib/accounts/browser/sessionsAccountMenu.js';
import { SessionsModernUIContribution } from '../contrib/modernUI/browser/modernUI.contribution.js';
import { SessionsPreferences } from '../contrib/preferences/browser/sessionsPreferences.js';
import type { SessionsProfile } from "../common/sessionsProfile.js";
import { RETURN_TO_WORKBENCH_COMMAND_ID } from '../common/windowNavigation.js';
import { SessionsConfiguration } from '../common/configuration.js';
import { SessionsManagementService } from "../services/sessions/browser/sessionsManagementService.js";
import { ISessionsManagementService } from "../services/sessions/common/sessionsManagement.js";
import { ISessionsService, SessionsService } from "../services/sessions/browser/sessionsService.js";
import { SessionsWorkbenchLayout, type SessionsPartId } from "./layoutPolicy.js";
import { AuxiliaryBarPart } from "./parts/auxiliaryBarPart.js";
import { ActivityBarPart, type SessionsActivityPage } from './parts/activityBarPart.js';
import { SessionsPart } from "./parts/sessionsPart.js";
import { SidebarPart } from "./parts/sidebarPart.js";
import { TitlebarPart } from "./parts/titlebarPart.js";

export interface IWorkbenchOptions {
	readonly modeId: WorkbenchModeId;
	readonly profile: SessionsProfile;
	readonly api: IRendererHost;
	readonly workspaceSelection: () => SessionWorkspaceSelection;
	readonly lifecycleService: ILifecycleService & IDisposable;
	readonly nativeHostApi?: INativeHostApi;
	readonly returnToWorkbench: () => void;
	readonly configurationApi?: IConfigurationApi;
	readonly initialConfigurationSnapshot?: IConfigurationSnapshot;
	readonly keybindingsResourceApi?: IKeybindingsResourceApi;
	readonly createContextMenuService: ContextMenuServiceFactory;
	readonly container: HTMLElement;
}

/** Owns the dedicated Sessions window's services, Parts, layout, and disposal. */
export class Workbench extends Disposable {
	readonly domNode: HTMLElement;
	readonly configurationService: WorkbenchConfigurationService;
	readonly themeService: WorkbenchThemeService;
	private readonly layoutService: BrowserLayoutService;
	private readonly lifecycleService: ILifecycleService;
	private readonly sessionsManagement: SessionsManagementService;
	private readonly sessionsView: SessionsService;
	private readonly sessionsPart: SessionsPart;
	private readonly showChat: () => void;
	private readonly workspaceSelection: () => SessionWorkspaceSelection;
	private readonly initialized: Promise<void>;

	constructor(options: IWorkbenchOptions) {
		super();
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
		const services = this._register(new ServiceContainer());
		services.registerInstance(IConfigurationService, configurationService);
		if (options.nativeHostApi) services.registerInstance(INativeHostService, options.nativeHostApi);
		const languageService = this._register(new LanguageService());
		services.registerInstance(ILanguageService, languageService);
		const themeService = this.themeService = this._register(services.createInstance(WorkbenchThemeService, options.container));
		services.registerInstance(IThemeService, themeService);
		themeService.initialize();
		const extensionColorThemes = this._register(new ExtensionColorThemeService(options.api.extensions, options.api.events));
		void extensionColorThemes.start().catch(error => console.error('Sessions extension color themes failed to load', error));
		const workbenchWindow = this._register(new WorkbenchWindow({
			root: options.container,
			modeId: options.modeId,
			workbenchState: WorkbenchState.EMPTY,
		}));
		services.registerInstance(IWorkbenchHostService, workbenchWindow);
		const sessions = this.sessionsManagement = this._register(new SessionsManagementService(new AppServerSessionsProvider({
			session: options.api.session,
			workspace: options.workspaceSelection,
			selectWorkspace: folders => pickWorkspaceFolder(services.get(IQuickInputService), folders),
			model: options.api.model,
			turn: options.api.turn,
			events: options.api.events,
		})));
		const teams = new TeamsManagementService(new AppServerTeamsProvider(options.api.teams));
		services.registerInstance(ITeamsManagementService, teams);
		const view = this.sessionsView = this._register(new SessionsService(sessions));
		const storage = this._register(new BrowserStorageService({
			ownerWindow,
			applicationId: WorkbenchModeRegistry.get(options.modeId).storageNamespace,
			workspaceId: "sessions",
			profileId: options.profile.id,
		}));
		const chat = this._register(new ChatService({
			modelApi: options.api.model,
			threadApi: options.api.thread,
			turnApi: options.api.turn,
			turnChangesApi: options.api.turnChanges,
			skillApi: options.api.skills,
			appServerApi: options.api.appServer,
			eventApi: options.api.events,
			configurationService,
			storageService: storage,
		}));
		services.registerInstance(ISessionsManagementService, sessions);
		services.registerInstance(ISessionsService, view);
		services.registerInstance(IChatService, chat);
		const accountService = this._register(new AppServerAccountService(options.api.accounts, options.api.events));
		services.registerInstance(IAccountService, accountService);
		services.registerInstance(IStorageService, storage);
		this.lifecycleService = this._register(options.lifecycleService);
		services.registerInstance(ILifecycleService, this.lifecycleService);
		this._register(this.lifecycleService.onWillShutdown(event => {
			event.join(storage.flush(WillSaveStateReason.SHUTDOWN), "Sessions storage flush");
		}));

		options.container.replaceChildren();
		this.domNode = h(ownerDocument, "main");
		this.domNode.className = "ash-sessions-window ash-code-sessions-window";
		options.container.append(this.domNode);
		this._register(toDisposable(() => this.domNode.remove()));

		let layout: SessionsWorkbenchLayout | undefined;
		let sessionsPart: SessionsPart | undefined;
		this.layoutService = this._register(new BrowserLayoutService({
			root: this.domNode,
			getContainerOffset: () => layout?.mainContainerOffset ?? { top: 0, quickInputTop: 0 },
			focus: () => sessionsPart?.focus(),
		}));
		services.registerInstance(ILayoutService, this.layoutService);
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
		services.registerInstance(IContextKeyService, contextKeys);
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
		const quickInputService = this._register(new WorkbenchQuickInputService({
			container: this.layoutService.activeContainer,
			contextKeyService: contextKeys,
			layoutService: this.layoutService,
		}));
		services.registerInstance(IQuickInputService, quickInputService);
		services.registerInstance(IQuickAccessController, this._register(services.createInstance(QuickAccessController)));
		services.registerInstance(IChatContextPickService, new ChatContextPickService());
		services.registerInstance(IPreferencesService, this._register(new PreferencesService(() => services.get(IEditorService))));
		const contextMenus = this._register(options.createContextMenuService({
			configurationService,
			menuService: menus,
			contextKeyService: contextKeys,
			keybindingService: keybindings,
			contextViewService: contextViews,
			notificationService,
		}));
		services.registerInstance(IContextMenuService, contextMenus);
		const hoverService = this._register(new HoverService(configurationService, contextViews, contextMenus));
		services.registerInstance(IHoverService, hoverService);
		this._register(setHoverDelegate(hoverService));
		void configurationService.reloadConfiguration().catch((error: unknown) => console.error("Failed to initialize configuration", error));
		void keybindingsResourceService.reload().catch((error: unknown) => console.error("Failed to initialize keybindings resource", error));
		const accessibleViewService = this._register(services.createInstance(AccessibleViewService));
		services.registerInstance(IAccessibleViewService, accessibleViewService);
		const preferences = this._register(new SessionsPreferences(
			this.domNode,
			configurationService,
			new BrowserClipboardService(ownerWindow.navigator.clipboard),
			contextMenus,
			contextKeys,
			accessibleViewService,
			chat,
		));
		const accountMenu = this._register(new SessionsAccountMenu(accountService, contextMenus, preferences, options.returnToWorkbench));

		let auxiliarybar: AuxiliaryBarPart | undefined;
		const titlebar = this._register(new TitlebarPart(this.domNode, view, menus, contextMenus, {
			toggleSidebar: () => {
				if (layout!.isPartVisible('sidebar')) layout!.hidePart('sidebar');
				else layout!.showPart('sidebar');
			},
		}));
		const sidebar = this._register(new SidebarPart(this.domNode, sessions, view, teams, quickInputService, async () => {
			const catalog = await options.api.session.listAgents();
			return catalog.agents.map(agent => ({
				name: agent.name,
				description: agent.description,
				role: { type: 'exact' as const, name: agent.name, source: agent.source },
			}));
		}));
		let activitybar: ActivityBarPart;
		const selectActivityPage = (page: SessionsActivityPage): void => {
			activitybar.selectPage(page);
			sidebar.setEmptyPage(page === 'colab' || page === 'library');
			if (page === 'chat' || page === 'code') sessionsPart?.setPage(page);
			else sessionsPart?.setPage('empty');
			auxiliarybar?.setEmptyPage(page !== 'chat');
		};
		this.showChat = () => selectActivityPage('chat');
		activitybar = this._register(services.createInstance(ActivityBarPart, this.domNode, {
			focusList: () => sidebar.focusChats(),
			selectPage: selectActivityPage,
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
					() => localize('sessions.activity.help', 'Sessions Activity Bar\nUse Tab and Shift+Tab to move between available buttons. Press Enter or Space to activate a button. Use the Context Menu key or Shift+F10 for position and size options. Chat focuses the sessions list. Code opens the Code page without losing the Chat draft. Collaboration and Library open empty pages. Accounts opens the account menu, which includes Return to Workbench. Mobile devices is not available yet.'),
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
		sessionsPart = this.sessionsPart = this._register(new SessionsPart(this.domNode, {
			sessionService: sessions,
			chatService: chat,
			dictation: options.api.dictation,
			contextMenuService: contextMenus,
			contextViewService: contextViews,
			accessibleViewService,
			notifications: notificationService,
			commandService,
			activateSelection: selection => view.activateSelection(selection),
			closeSelection: selection => view.closeVisibleSelection(selection),
		}));
		const updateSessionsPart = (): void => sessionsPart?.updateVisibleSelections(view.visibleSelections, view.activeSelection);
		this._register(view.onDidChange(updateSessionsPart));
		updateSessionsPart();
		auxiliarybar = this._register(new AuxiliaryBarPart(this.domNode, sessions, view));
		const parts = new Map<SessionsPartId, WorkbenchPart>([
			["titlebar", titlebar],
			['activitybar', activitybar],
			["sidebar", sidebar],
			["sessions", sessionsPart],
			["auxiliarybar", auxiliarybar],
		]);
		layout = this._register(new SessionsWorkbenchLayout(this.domNode, parts, {
			initialDimension: this.layoutService.mainContainerDimension,
			storageService: storage,
			activityBarLocation,
		}));
		this._register(configurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(SessionsConfiguration.activityBarLocation)) {
				const location = configurationService.getValue<ActivityBarPosition>(SessionsConfiguration.activityBarLocation);
				activitybar.setLocation(location, sidebar.setActivityBarLocation(location));
				layout!.setActivityBarLocation(location);
			}
			if (event.affectsConfiguration(SessionsConfiguration.activityBarCompact)) {
				activitybar.setCompact(configurationService.getValue<boolean>(SessionsConfiguration.activityBarCompact));
			}
		}));
		this._register(new SessionsModernUIContribution(this.domNode, layout, configurationService));
		titlebar.updateSidebarVisibility(layout.isPartVisible('sidebar'));
		this._register(layout.onDidChangePartVisibility(event => {
			if (event.partId === 'sidebar') titlebar.updateSidebarVisibility(event.visible);
		}));
		this._register(bindResizableLayout(this.layoutService.onDidLayoutMainContainer, layout));
		this.layoutService.layout();
		this.initialized = this.initialize(view, configurationService);
		void this.initialized.catch(error => console.error('Failed to initialize Sessions Workbench', error));
	}

	async acceptHandoff(options: IOpenAgentsWindowOptions): Promise<void> {
		await this.initialized;
		if (options.conversation) await this.sessionsManagement.openThread(options.conversation.sessionId, options.conversation.threadId);
		else if (options.draft) {
			const selected = this.sessionsView.activeSelection;
			if (selected?.kind !== 'untitled' || !sameWorkspace(selected.session.workspace, this.workspaceSelection())) {
				this.sessionsView.openNewSession('New code session');
			}
		}
		this.showChat();
		if (options.draft) this.sessionsPart.restoreDraft(options.draft);
	}

	shutdown(reason: ShutdownReason): Promise<void> {
		return this.lifecycleService.shutdown(reason);
	}

	private async initialize(view: SessionsService, configurationService: WorkbenchConfigurationService): Promise<void> {
		await configurationService.reloadConfiguration();
		await view.initialize();
		if (!view.activeSelection) view.openNewSession("New code session");
	}
}

function sameWorkspace(first: SessionWorkspaceSelection, second: SessionWorkspaceSelection): boolean {
	if (first.type !== second.type) return false;
	if (first.type === 'current') return true;
	if (first.type === 'multiple' && second.type === 'multiple') return first.folders.length === second.folders.length && first.folders.every((folder, index) => folder.label === second.folders[index]?.label && sameWorkspace(folder.target, second.folders[index]!.target));
	if (first.type === 'local' && second.type === 'local') return first.root === second.root;
	return first.type === 'ssh' && second.type === 'ssh' && first.host === second.host && first.root === second.root;
}
