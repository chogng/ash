import { setHoverDelegate } from "../../base/browser/ui/hover/hoverDelegate.js";
import { Disposable, type IDisposable } from "../../base/common/lifecycle.js";
import { IMenuService } from "../../platform/actions/common/actions.js";
import { MenuService } from "../../platform/actions/common/menuService.js";
import { ICommandService } from "../../platform/commands/common/commands.js";
import { type IConfigurationService as IConfigurationServiceContract } from "../../platform/configuration/common/configuration.js";
import { IContextKeyService, ContextKeyService } from "../../platform/contextkey/browser/contextKeyService.js";
import { BrowserContextMenuService } from "../../platform/contextview/browser/contextMenuService.js";
import { IContextMenuService, IContextViewService } from "../../platform/contextview/browser/contextView.js";
import { BrowserContextViewService } from "../../platform/contextview/browser/contextViewService.js";
import { HoverService, IHoverService } from "../../platform/hover/browser/hoverService.js";
import type { ServiceContainer } from "../../platform/instantiation/common/instantiation.js";
import { IKeybindingService } from "../../platform/keybinding/common/keybinding.js";
import type { INotificationService } from "../../platform/notification/common/notification.js";
import { type IKeybindingsResourceApi, IKeybindingsResourceService } from "../../platform/keybinding/common/keybindingsResource.js";
import { IKeyboardLayoutService, type IKeyboardLayoutProvider } from "../../platform/keyboardLayout/common/keyboardLayout.js";
import {
	IUserKeyboardLayoutService,
	type IUserKeyboardLayoutApi,
	UnavailableUserKeyboardLayoutService,
} from "../../platform/keyboardLayout/common/userKeyboardLayout.js";
import { type ILayoutService as ILayoutServiceContract } from "../../platform/layout/browser/layoutService.js";
import { IQuickInputService } from "../../platform/quickinput/common/quickInput.js";
import { IQuickAccessController } from "../../platform/quickinput/common/quickAccess.js";
import { QuickAccessController } from "../../platform/quickinput/browser/quickAccess.js";
import { CommandService } from "../services/commands/common/commandService.js";
import { BrowserKeyboardLayoutService } from "../services/keybinding/browser/keyboardLayoutService.js";
import { WorkbenchKeybindingService } from "../services/keybinding/browser/keybindingService.js";
import { IKeyboardShortcutTroubleshootingService } from "../services/keybinding/common/keyboardShortcutTroubleshooting.js";
import { WorkbenchKeybindingsResourceService } from "../services/keybinding/browser/keybindingsResourceService.js";
import { IPreferencesService } from "../services/preferences/common/preferences.js";
import { PreferencesService } from "../services/preferences/browser/preferencesService.js";
import { IEditorService } from "../services/editor/common/editorService.js";
import { WorkbenchQuickInputService } from "../services/quickinput/browser/quickInputService.js";
import { ChatContextPickService } from "../services/chat/browser/chatContextPickService.js";
import { IChatContextPickService, type IChatContextPickService as IChatContextPickServiceContract } from "../services/chat/common/chatContextService.js";
import type { IStatusbarService } from "../services/statusbar/browser/statusbar.js";

export interface WorkbenchContextMenuServiceOptions {
	readonly menuService: IMenuService;
	readonly contextKeyService: IContextKeyService;
	readonly keybindingService: IKeybindingService;
	readonly contextViewService: IContextViewService;
	readonly notificationService: INotificationService;
}

export type WorkbenchContextMenuServiceFactory = (
	options: WorkbenchContextMenuServiceOptions,
) => IContextMenuService & IDisposable;

export function createBrowserWorkbenchContextMenuService(
	options: WorkbenchContextMenuServiceOptions,
): BrowserContextMenuService {
	return new BrowserContextMenuService(
		options.menuService,
		options.contextKeyService,
		options.keybindingService,
		options.contextViewService,
		options.notificationService,
	);
}

export interface WorkbenchInteractionServicesOptions {
	readonly container: ServiceContainer;
	readonly layoutService: ILayoutServiceContract;
	readonly configurationService: IConfigurationServiceContract;
	readonly keybindingsResourceApi?: IKeybindingsResourceApi;
	readonly keyboardLayoutProvider?: IKeyboardLayoutProvider;
	readonly userKeyboardLayoutApi?: IUserKeyboardLayoutApi;
	readonly statusbarService?: IStatusbarService;
	readonly notificationService: INotificationService;
	readonly createContextMenuService: WorkbenchContextMenuServiceFactory;
}

/**
 * Window-scoped interaction runtime shared by the regular and specialized
 * Workbenches. Product hosts provide layout and configuration ownership while
 * this runtime owns the canonical command, context, menu, keybinding, overlay,
 * quick-input, settings, and hover service graph.
 */
export class WorkbenchInteractionServices extends Disposable {
	readonly commandService: CommandService;
	readonly contextKeyService: ContextKeyService;
	readonly menuService: MenuService;
	readonly contextViewService: BrowserContextViewService;
	readonly contextMenuService: IContextMenuService;
	readonly keybindingService: WorkbenchKeybindingService;
	readonly quickInputService: WorkbenchQuickInputService;
	readonly chatContextPickService: IChatContextPickServiceContract;

	constructor(options: WorkbenchInteractionServicesOptions) {
		super();
		const ownerDocument = options.layoutService.activeContainer.ownerDocument;
		const ownerWindow = ownerDocument.defaultView;
		if (!ownerWindow) throw new Error("Workbench interaction services require an owner window");
		const container = options.container;
		const userKeyboardLayoutService = options.userKeyboardLayoutApi ?? UnavailableUserKeyboardLayoutService;
		container.registerInstance(IUserKeyboardLayoutService, userKeyboardLayoutService);

		this.commandService = this._register(new CommandService(container));
		container.registerInstance(ICommandService, this.commandService);
		this.contextKeyService = this._register(new ContextKeyService());
		container.registerInstance(IContextKeyService, this.contextKeyService);

		const keyboardLayoutService = this._register(new BrowserKeyboardLayoutService({
			navigator: ownerWindow.navigator,
			configurationService: options.configurationService,
			layoutProvider: options.keyboardLayoutProvider,
			userLayoutProvider: userKeyboardLayoutService,
		}));
		container.registerInstance(IKeyboardLayoutService, keyboardLayoutService);
		const keybindingsResourceService = this._register(new WorkbenchKeybindingsResourceService({
			api: options.keybindingsResourceApi,
		}));
		container.registerInstance(IKeybindingsResourceService, keybindingsResourceService);
		this.keybindingService = this._register(new WorkbenchKeybindingService({
			ownerDocument,
			commandService: this.commandService,
			contextKeyService: this.contextKeyService,
			keyboardLayoutService,
			statusbarService: options.statusbarService,
		}));
		container.registerInstance(IKeybindingService, this.keybindingService);
		container.registerInstance(IKeyboardShortcutTroubleshootingService, this.keybindingService);

		this.menuService = new MenuService(this.commandService, this.contextKeyService);
		container.registerInstance(IMenuService, this.menuService);
		this.contextViewService = this._register(new BrowserContextViewService(options.layoutService.activeContainer, options.layoutService));
		container.registerInstance(IContextViewService, this.contextViewService);
		const quickInputService = this._register(new WorkbenchQuickInputService({
			container: options.layoutService.activeContainer,
			contextKeyService: this.contextKeyService,
			layoutService: options.layoutService,
		}));
		this.quickInputService = quickInputService;
		container.registerInstance(IQuickInputService, quickInputService);
		container.registerInstance(IQuickAccessController, this._register(container.createInstance(QuickAccessController)));
		this.chatContextPickService = new ChatContextPickService();
		container.registerInstance(IChatContextPickService, this.chatContextPickService);
		container.registerInstance(IPreferencesService, this._register(new PreferencesService(() => container.get(IEditorService))));
		this.contextMenuService = this._register(options.createContextMenuService({
			menuService: this.menuService,
			contextKeyService: this.contextKeyService,
			keybindingService: this.keybindingService,
			contextViewService: this.contextViewService,
			notificationService: options.notificationService,
		}));
		container.registerInstance(IContextMenuService, this.contextMenuService);
		const hoverService = this._register(new HoverService(options.configurationService, this.contextViewService, this.contextMenuService));
		container.registerInstance(IHoverService, hoverService);
		this._register(setHoverDelegate(hoverService));

		void options.configurationService.reloadConfiguration().catch((error: unknown) => {
			console.error("Failed to initialize configuration", error);
		});
		void keybindingsResourceService.reload().catch((error: unknown) => {
			console.error("Failed to initialize keybindings resource", error);
		});
	}
}
