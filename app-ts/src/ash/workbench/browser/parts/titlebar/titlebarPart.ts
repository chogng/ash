import "./titlebarpart.css";
import { MenuWorkbenchToolBar } from "../../../../platform/actions/browser/toolbar.js";
import { type IMenuService, MenuId } from "../../../../platform/actions/common/actions.js";
import type { IContextMenuService } from "../../../../platform/contextview/browser/contextView.js";
import { WorkbenchPart } from "../../part.js";
import { WorkbenchWindowBarHeight } from "../workbenchPartDimensions.js";
import { BrowserMenubarControl, type IMenubarControl } from "./menubarControl.js";
import { h } from "../../../../base/browser/dom.js";
import type { ILocalizationService } from "../../../services/localization/common/localizationService.js";
import { IInstantiationService } from "../../../../platform/instantiation/common/instantiation.js";
import { CommandCenterControl } from "./commandCenterControl.js";

/** Inputs shared by web and Electron titlebar factories. */
export interface ITitlebarPartFactoryOptions {
	readonly menuService: IMenuService;
	readonly contextMenuService: IContextMenuService;
	readonly localizationService?: ILocalizationService;
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
	private readonly leftActions: MenuWorkbenchToolBar;
	private readonly actions: MenuWorkbenchToolBar;

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
		const leftActionsDomNode = h(ownerDocument, "div");
		leftActionsDomNode.className = "ash-titlebar-left-actions ash-titlebar-interactive-region";
		this.titleDomNode.append(leftActionsDomNode);
		this.leftActions = this._register(
			new MenuWorkbenchToolBar(
				leftActionsDomNode,
				options.menuService,
				options.contextMenuService,
				MenuId.TitleBarLeft,
				{ presentation: "inherit-foreground" },
			),
		);
		const commandCenter = this._register(instantiationService.createInstance(CommandCenterControl, this.domNode, options.localizationService));
		this.contentDomNode.before(commandCenter.domNode);
		const actionsDomNode = h(ownerDocument, "div");
		actionsDomNode.className = "ash-titlebar-actions ash-titlebar-interactive-region";
		this.contentDomNode.append(actionsDomNode);
		this.actions = this._register(
			new MenuWorkbenchToolBar(
				actionsDomNode,
				options.menuService,
				options.contextMenuService,
				MenuId.TitleBar,
				{ presentation: "inherit-foreground" },
			),
		);
		if (this.menubar.domNode) {
			this.menubar.domNode.classList.add("ash-titlebar-interactive-region");
			this.titleDomNode.append(this.menubar.domNode);
		}
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
