import { bindResizableLayout } from "../../../base/browser/ui/resizable/resizable.js";
import { Disposable, toDisposable } from "../../../base/common/lifecycle.js";
import { BrowserLayoutService, ILayoutService } from "../../../platform/layout/browser/layoutService.js";
import { IConfigurationService, type IConfigurationService as IConfigurationServiceContract } from "../../../platform/configuration/common/configuration.js";
import type { IKeybindingsResourceApi } from "../../../platform/keybinding/common/keybindingsResource.js";
import type { IStorageService } from "../../../platform/storage/common/storage.js";
import type { WorkbenchPart } from "../../../workbench/browser/part.js";
import { WorkbenchInteractionServices } from "../../../workbench/browser/workbenchInteractionServices.js";
import type { WorkbenchContextMenuServiceFactory } from "../../../workbench/browser/workbenchInteractionServices.js";
import type { ISessionsWindowApi } from "../../common/sessionsWindow.js";
import type { SessionsProfile } from "../../common/sessionsProfile.js";
import { SessionsWorkbenchLayout } from "../layout.js";
import { ISessionsLayoutService, type SessionsPartId } from "../../services/layout/common/sessionsLayoutService.js";
import { returnToWorkbench } from "../common/sessionNavigation.js";
import type { SessionsRuntime } from "../common/sessionsRuntime.js";
import { SessionsAuxiliarybarPart } from "../parts/sessionsAuxiliarybarPart.js";
import { SessionsPart } from "../parts/sessionsPart.js";
import { SessionsSidebarPart } from "../parts/sessionsSidebarPart.js";
import { SessionsTitlebarPart } from "../parts/sessionsTitlebarPart.js";
import { h } from "../../../base/browser/dom.js";
import { BrowserNotificationService } from "../../../platform/notification/browser/notificationService.js";
import { INotificationService } from "../../../platform/notification/common/notification.js";

export interface CodeSessionsWorkbenchOptions {
	readonly profile: SessionsProfile;
	readonly runtime: SessionsRuntime;
	readonly sessionsWindowApi?: ISessionsWindowApi;
	readonly configurationService: IConfigurationServiceContract;
	readonly keybindingsResourceApi?: IKeybindingsResourceApi;
	readonly createContextMenuService: WorkbenchContextMenuServiceFactory;
	readonly storageService: IStorageService;
}

/** Fixed, VS Code-inspired Workbench composition for Code agent Sessions. */
export class CodeSessionsWorkbench extends Disposable {
	readonly domNode: HTMLElement;
	private readonly layoutService: BrowserLayoutService;

	constructor(container: HTMLElement, options: CodeSessionsWorkbenchOptions) {
		super();
		const ownerDocument = container.ownerDocument;
		const profile = options.profile;
		const runtime = options.runtime;
		this.domNode = h(ownerDocument, "main");
		this.domNode.className = "ash-sessions-window ash-code-sessions-window";
		container.append(this.domNode);
		this._register(toDisposable(() => this.domNode.remove()));
		let layout: SessionsWorkbenchLayout | undefined;
		let sessionsPart: SessionsPart | undefined;
		const layoutService = this._register(new BrowserLayoutService({
			root: this.domNode,
			getContainerOffset: () => layout?.mainContainerOffset ?? { top: 0, quickInputTop: 0 },
			focus: () => sessionsPart?.focus(),
		}));
		this.layoutService = layoutService;
		runtime.container.registerInstance(ILayoutService, layoutService);
		runtime.container.registerInstance(IConfigurationService, options.configurationService);
		const notificationService = this._register(new BrowserNotificationService(this.domNode));
		runtime.container.registerInstance(INotificationService, notificationService);
		const interactionServices = this._register(new WorkbenchInteractionServices({
			container: runtime.container,
			layoutService,
			configurationService: options.configurationService,
			keybindingsResourceApi: options.keybindingsResourceApi,
			notificationService,
			createContextMenuService: options.createContextMenuService,
		}));
		const titlebar = this._register(new SessionsTitlebarPart(this.domNode, profile, runtime.view, {
			returnToWorkbench: () => returnToWorkbench(profile.workbenchRelativePath, options.sessionsWindowApi, ownerDocument.location),
			focusSessions: () => sessionsPart?.focus(),
		}));
		const sidebar = this._register(new SessionsSidebarPart(this.domNode, runtime.sessions, runtime.view));
		sessionsPart = this._register(new SessionsPart(this.domNode, {
			sessionService: runtime.sessions,
			chatService: runtime.chat,
			contextMenuService: interactionServices.contextMenuService,
			contextViewService: interactionServices.contextViewService,
			commandService: interactionServices.commandService,
			contextPickService: interactionServices.chatContextPickService,
			quickInputService: interactionServices.quickInputService,
			activateSelection: selection => runtime.view.activateSelection(selection),
			closeSelection: selection => runtime.view.closeVisibleSelection(selection),
		}));
		const updateSessionsPart = (): void => sessionsPart?.updateVisibleSelections(runtime.view.visibleSelections, runtime.view.activeSelection);
		this._register(runtime.view.onDidChange(updateSessionsPart));
		updateSessionsPart();
		const auxiliarybar = this._register(new SessionsAuxiliarybarPart(this.domNode, runtime.sessions, runtime.view));
		const parts = new Map<SessionsPartId, WorkbenchPart>([
			["titlebar", titlebar],
			["sidebar", sidebar],
			["sessions", sessionsPart],
			["auxiliarybar", auxiliarybar],
		]);
		layout = this._register(new SessionsWorkbenchLayout(this.domNode, parts, {
			initialDimension: layoutService.mainContainerDimension,
			storageService: options.storageService,
		}));
		runtime.container.registerInstance(ISessionsLayoutService, layout);
		this._register(bindResizableLayout(layoutService.onDidLayoutMainContainer, layout));
		void runtime.initialize();
	}

	/** Measures the connected Sessions host and lays out its fixed Part grid. */
	layout(): void {
		this.layoutService.layout();
	}
}
