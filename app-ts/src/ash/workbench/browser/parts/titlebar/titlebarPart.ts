import "./titlebarpart.css";
import { addDisposableListener, h } from "../../../../base/browser/dom.js";
import { MutableDisposable } from "../../../../base/common/lifecycle.js";
import { MenuWorkbenchToolBar } from "../../../../platform/actions/browser/toolbar.js";
import { type IMenuService, MenuId } from "../../../../platform/actions/common/actions.js";
import type { IContextMenuService } from "../../../../platform/contextview/browser/contextView.js";
import { IInstantiationService } from "../../../../platform/instantiation/common/instantiation.js";
import { WorkbenchPart } from "../../part.js";
import type { GlobalCompositeBar } from "../globalCompositeBar.js";
import { WorkbenchWindowBarHeight } from "../workbenchPartDimensions.js";
import { BrowserMenubarControl, type IMenubarControl } from "./menubarControl.js";
import type { ILocalizationService } from "../../../services/localization/common/localizationService.js";
import { CommandCenterControl } from "./commandCenterControl.js";

/** Inputs shared by web and Electron titlebar factories. */
export interface ITitlebarPartFactoryOptions {
	readonly menuService: IMenuService;
	readonly contextMenuService: IContextMenuService;
	readonly localizationService: ILocalizationService;
}

/** Creates the titlebar implementation selected by the current host. */
export type TitlebarPartFactory = (
	container: HTMLElement,
	options: ITitlebarPartFactoryOptions,
	instantiationService: IInstantiationService,
) => BrowserTitlebarPart;

/** The host-neutral workbench title area and its actions. */
export class BrowserTitlebarPart extends WorkbenchPart {
	private readonly menubar: IMenubarControl;
	private readonly centerAdjacentActions: MenuWorkbenchToolBar;
	private readonly actions: MenuWorkbenchToolBar;
	private readonly activityActionsListener = this._register(new MutableDisposable());
	private activityActions: { bar: GlobalCompositeBar; showContextMenu: (event: MouseEvent | KeyboardEvent) => void } | undefined;

	override get minimumHeight(): number { return WorkbenchWindowBarHeight; }
	override get maximumHeight(): number { return WorkbenchWindowBarHeight; }

	constructor(
		container: HTMLElement,
		options: ITitlebarPartFactoryOptions,
		menubar: IMenubarControl,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super(container, "titlebar");
		const ownerDocument = container.ownerDocument;
		this.menubar = this._register(menubar);
		const appIconDomNode = h(ownerDocument, "span");
		appIconDomNode.className = "ash-titlebar-app-icon";
		appIconDomNode.setAttribute("aria-hidden", "true");
		this.titleDomNode.append(appIconDomNode);
		if (this.menubar.domNode) {
			this.menubar.domNode.classList.add("ash-titlebar-interactive-region");
			this.titleDomNode.append(this.menubar.domNode);
		}
		const centerDomNode = h(ownerDocument, "div");
		centerDomNode.className = "ash-titlebar-center";
		this.contentDomNode.before(centerDomNode);
		this._register(instantiationService.createInstance(CommandCenterControl, centerDomNode, options.localizationService));
		const centerAdjacentActionsDomNode = h(ownerDocument, "div");
		centerAdjacentActionsDomNode.className = "ash-titlebar-center-adjacent-actions ash-titlebar-interactive-region";
		centerDomNode.append(centerAdjacentActionsDomNode);
		this.centerAdjacentActions = this._register(
			new MenuWorkbenchToolBar(
				centerAdjacentActionsDomNode,
				options.menuService,
				options.contextMenuService,
				MenuId.TitleBarAdjacentCenter,
				{ presentation: "inherit-foreground" },
			),
		);
		const actionsDomNode = h(ownerDocument, "div");
		actionsDomNode.className = "ash-titlebar-actions ash-titlebar-interactive-region";
		this.contentDomNode.append(actionsDomNode);
		this.actions = this._register(
			new MenuWorkbenchToolBar(
				actionsDomNode,
				options.menuService,
				options.contextMenuService,
				MenuId.TitleBar,
				{
					ariaLabel: options.localizationService.translate("ash", "workbench.titleBarGlobalActions", "Title Bar global actions"),
					presentation: "inherit-foreground",
					actionViewItemProvider: (action, actionOptions) => this.activityActions?.bar.createActionViewItem(action, actionOptions),
				},
			),
		);
		this._register(options.localizationService.onDidChange(() => {
			this.actions.element.setAttribute("aria-label", options.localizationService.translate("ash", "workbench.titleBarGlobalActions", "Title Bar global actions"));
		}));
		const isActivityAction = (target: EventTarget | null) =>
			(target as Element | null)?.closest('[data-action-id="ash.activityBar.accounts"], [data-action-id="ash.activityBar.manage"]') !== null;
		this._register(addDisposableListener(actionsDomNode, "contextmenu", event => {
			if (this.activityActions && isActivityAction(event.target)) this.activityActions.showContextMenu(event);
		}));
		this._register(addDisposableListener(actionsDomNode, "keydown", event => {
			if (this.activityActions && isActivityAction(event.target) && (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey))) {
				this.activityActions.showContextMenu(event);
			}
		}));
	}

	public setActivityActions(actions: { bar: GlobalCompositeBar; showContextMenu: (event: MouseEvent | KeyboardEvent) => void } | undefined): void {
		if (this.activityActions?.bar === actions?.bar) return;
		this.activityActions = actions;
		this.activityActionsListener.value = actions?.bar.onDidChangeActions(() => this.actions.setTrailingActions(actions.bar.getActions()));
		this.actions.setTrailingActions(actions?.bar.getActions() ?? []);
	}
}

/** Creates the titlebar used by a regular web workbench. */
export const createBrowserTitlebarPart: TitlebarPartFactory = (container, options, instantiationService) =>
	instantiationService.createInstance(BrowserTitlebarPart,
		container,
		options,
		new BrowserMenubarControl(
			container,
			options.menuService,
			options.contextMenuService,
			options.localizationService,
		),
	);
