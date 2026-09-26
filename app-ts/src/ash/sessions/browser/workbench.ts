import "./media/workbench.css";
import "./actions/sessionsChatActions.js";
import { h } from "../../base/browser/dom.js";
import { bindResizableLayout } from "../../base/browser/ui/resizable/resizable.js";
import { onUnexpectedError } from "../../base/common/errors.js";
import { Emitter, Event } from "../../base/common/event.js";
import { combinedDisposable, Disposable, toDisposable, type IDisposable } from "../../base/common/lifecycle.js";
import type { IConfigurationApi } from "../../platform/configuration/common/configurationIpc.js";
import { IConfigurationService } from "../../platform/configuration/common/configuration.js";
import { ServiceContainer } from "../../platform/instantiation/common/instantiation.js";
import type { IKeybindingsResourceApi } from "../../platform/keybinding/common/keybindingsResource.js";
import { BrowserLayoutService, ILayoutService } from "../../platform/layout/browser/layoutService.js";
import { BrowserLifecycleService } from "../../platform/lifecycle/browser/browserLifecycleService.js";
import { ILifecycleService, type ShutdownReason } from "../../platform/lifecycle/common/lifecycleService.js";
import { BrowserNotificationService } from "../../platform/notification/browser/notificationService.js";
import { INotificationService } from "../../platform/notification/common/notification.js";
import type { IRendererHost } from "../../platform/renderer/common/rendererHost.js";
import { IStorageService, WillSaveStateReason } from "../../platform/storage/common/storage.js";
import { bindColorTheme } from "../../platform/theme/browser/themeStyles.js";
import { Colors } from "../../platform/theme/common/colorRegistry.js";
import { defaultProductIconTheme, type IColorTheme, type IThemeService } from "../../platform/theme/common/themeService.js";
import { WorkbenchState } from "../../platform/workspace/common/workspace.js";
import type { WorkbenchPart } from "../../workbench/browser/part.js";
import { WorkbenchInteractionServices, type WorkbenchContextMenuServiceFactory } from "../../workbench/browser/workbenchInteractionServices.js";
import { WorkbenchWindow } from "../../workbench/browser/window.js";
import { WorkbenchModeRegistry, type WorkbenchModeId } from "../../workbench/common/workbenchMode.js";
import { SystemColorThemePreference, WorkbenchThemesRegistry, resolveWorkbenchColorTheme } from "../../workbench/common/theme.js";
import { WorkbenchConfiguration } from "../../workbench/common/configuration.js";
import { ChatService } from "../../workbench/services/chat/browser/chatService.js";
import { IChatService } from "../../workbench/services/chat/common/chatService.js";
import { WorkbenchConfigurationService } from "../../workbench/services/configuration/browser/configurationService.js";
import { ExtensionColorThemeService } from "../../workbench/services/extensions/browser/extensionColorThemeService.js";
import { BrowserStorageService } from "../../workbench/services/storage/browser/storageService.js";
import { IWorkbenchHostService } from "../../workbench/services/host/common/workbenchHostService.js";
import { AppServerSessionsProvider } from "../contrib/providers/appServer/browser/appServerSessionsProvider.js";
import type { SessionsProfile } from "../common/sessionsProfile.js";
import { SessionsManagementService } from "../services/sessions/browser/sessionsManagementService.js";
import { ISessionsManagementService } from "../services/sessions/common/sessionsManagement.js";
import { ISessionsService, SessionsService } from "../services/sessions/browser/sessionsService.js";
import { SessionsWorkbenchLayout, type SessionsPartId } from "./layoutPolicy.js";
import { AuxiliaryBarPart } from "./parts/auxiliaryBarPart.js";
import { SessionsPart } from "./parts/sessionsPart.js";
import { SidebarPart } from "./parts/sidebarPart.js";
import { TitlebarPart } from "./parts/titlebarPart.js";

export interface IWorkbenchOptions {
	readonly modeId: WorkbenchModeId;
	readonly profile: SessionsProfile;
	readonly api: IRendererHost;
	readonly returnToWorkbench: () => void;
	readonly configurationApi?: IConfigurationApi;
	readonly keybindingsResourceApi?: IKeybindingsResourceApi;
	readonly createContextMenuService: WorkbenchContextMenuServiceFactory;
	readonly container: HTMLElement;
}

/** Owns the dedicated Sessions window's services, Parts, layout, and disposal. */
export class Workbench extends Disposable {
	readonly domNode: HTMLElement;
	private readonly layoutService: BrowserLayoutService;
	private readonly lifecycleService: ILifecycleService;

	constructor(options: IWorkbenchOptions) {
		super();
		if (options.profile.modeId !== options.modeId) {
			throw new TypeError(`Sessions profile '${options.profile.id}' belongs to '${options.profile.modeId}', not '${options.modeId}'`);
		}
		if (options.profile.id !== "code-sessions") {
			throw new TypeError(`Unsupported Code Sessions profile '${options.profile.id}'`);
		}
		const ownerDocument = options.container.ownerDocument;
		const ownerWindow = ownerDocument.defaultView;
		if (!ownerWindow) throw new Error("Sessions renderer requires an owner window");

		const configurationService = this._register(new WorkbenchConfigurationService({ api: options.configurationApi }));
		this._register(bindSessionsTheme(options.container, configurationService));
		const extensionColorThemes = this._register(new ExtensionColorThemeService(options.api.extensions, options.api.events));
		void extensionColorThemes.start().catch(error => console.error('Sessions extension color themes failed to load', error));
		const services = this._register(new ServiceContainer());
		const workbenchWindow = this._register(new WorkbenchWindow({
			root: options.container,
			modeId: options.modeId,
			workbenchState: WorkbenchState.EMPTY,
		}));
		services.registerInstance(IWorkbenchHostService, workbenchWindow);
		const sessions = this._register(new SessionsManagementService(new AppServerSessionsProvider({
			session: options.api.session,
			model: options.api.model,
			turn: options.api.turn,
			events: options.api.events,
		})));
		const view = this._register(new SessionsService(sessions));
		const chat = this._register(new ChatService({
			modelApi: options.api.model,
			threadApi: options.api.thread,
			turnApi: options.api.turn,
			turnChangesApi: options.api.turnChanges,
			skillApi: options.api.skills,
			appServerApi: options.api.appServer,
			eventApi: options.api.events,
			configurationService,
		}));
		const storage = this._register(new BrowserStorageService({
			ownerWindow,
			applicationId: WorkbenchModeRegistry.get(options.modeId).storageNamespace,
			workspaceId: "sessions",
			profileId: options.profile.id,
		}));
		services.registerInstance(ISessionsManagementService, sessions);
		services.registerInstance(ISessionsService, view);
		services.registerInstance(IChatService, chat);
		services.registerInstance(IStorageService, storage);
		services.registerInstance(IConfigurationService, configurationService);
		this.lifecycleService = this._register(new BrowserLifecycleService({ ownerWindow, onError: onUnexpectedError }));
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
		const notificationService = this._register(new BrowserNotificationService(this.domNode));
		services.registerInstance(INotificationService, notificationService);
		const interactionServices = this._register(new WorkbenchInteractionServices({
			container: services,
			layoutService: this.layoutService,
			configurationService,
			keybindingsResourceApi: options.keybindingsResourceApi,
			notificationService,
			createContextMenuService: options.createContextMenuService,
		}));

		const titlebar = this._register(new TitlebarPart(this.domNode, options.profile, view, {
			returnToWorkbench: options.returnToWorkbench,
			focusSessions: () => sessionsPart?.focus(),
		}));
		const sidebar = this._register(new SidebarPart(this.domNode, sessions, view));
		sessionsPart = this._register(new SessionsPart(this.domNode, {
			sessionService: sessions,
			chatService: chat,
			contextMenuService: interactionServices.contextMenuService,
			contextViewService: interactionServices.contextViewService,
			commandService: interactionServices.commandService,
			contextPickService: interactionServices.chatContextPickService,
			quickInputService: interactionServices.quickInputService,
			activateSelection: selection => view.activateSelection(selection),
			closeSelection: selection => view.closeVisibleSelection(selection),
		}));
		const updateSessionsPart = (): void => sessionsPart?.updateVisibleSelections(view.visibleSelections, view.activeSelection);
		this._register(view.onDidChange(updateSessionsPart));
		updateSessionsPart();
		const auxiliarybar = this._register(new AuxiliaryBarPart(this.domNode, sessions, view));
		const parts = new Map<SessionsPartId, WorkbenchPart>([
			["titlebar", titlebar],
			["sidebar", sidebar],
			["sessions", sessionsPart],
			["auxiliarybar", auxiliarybar],
		]);
		layout = this._register(new SessionsWorkbenchLayout(this.domNode, parts, {
			initialDimension: this.layoutService.mainContainerDimension,
			storageService: storage,
		}));
		this._register(bindResizableLayout(this.layoutService.onDidLayoutMainContainer, layout));
		this.layoutService.layout();
		void this.initialize(view, configurationService);
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

const darkColorSchemeQuery = "(prefers-color-scheme: dark)";

/** Applies the profile theme selection to the dedicated Sessions window. */
function bindSessionsTheme(root: HTMLElement, configurationService: WorkbenchConfigurationService): IDisposable {
	const ownerWindow = root.ownerDocument.defaultView;
	if (!ownerWindow) throw new Error("Sessions theme requires an owner window");
	const systemColorScheme = ownerWindow.matchMedia(darkColorSchemeQuery);
	const themeChanges = new Emitter<IColorTheme>();
	const getColorTheme = (): IColorTheme => {
		const preference = configurationService.getValue<string>(WorkbenchConfiguration.colorTheme);
		return WorkbenchThemesRegistry.getColorTheme(preference)
			?? resolveWorkbenchColorTheme(SystemColorThemePreference, systemColorScheme.matches);
	};
	const themeService: IThemeService = {
		onDidColorThemeChange: themeChanges.event,
		onDidProductIconThemeChange: Event.None,
		getColorTheme,
		getProductIconTheme: () => defaultProductIconTheme,
	};
	const handleSystemColorSchemeChange = (): void => themeChanges.fire(themeService.getColorTheme());
	systemColorScheme.addEventListener("change", handleSystemColorSchemeChange);
	return combinedDisposable(
		themeChanges,
		bindColorTheme(themeService, root),
		configurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(WorkbenchConfiguration.colorTheme)) themeChanges.fire(getColorTheme());
		}),
		WorkbenchThemesRegistry.onDidChange(() => themeChanges.fire(getColorTheme())),
		Colors.onDidChange(() => themeChanges.fire(getColorTheme())),
		toDisposable(() => systemColorScheme.removeEventListener("change", handleSystemColorSchemeChange)),
	);
}
