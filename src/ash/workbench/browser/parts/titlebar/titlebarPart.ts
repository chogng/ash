import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { localize } from '../../../../nls.js';
import "./titlebarpart.css";
import { addDisposableListener, h } from "../../../../base/browser/dom.js";
import { Emitter, type Event } from "../../../../base/common/event.js";
import { CommandsRegistry } from "../../../../platform/commands/common/commands.js";
import { Disposable, DisposableMap, MutableDisposable, toDisposable, type IDisposable } from "../../../../base/common/lifecycle.js";
import { MenuWorkbenchToolBar } from "../../../../platform/actions/browser/toolbar.js";
import { IMenuService, MenuId } from "../../../../platform/actions/common/actions.js";
import { IContextMenuService } from "../../../../platform/contextview/browser/contextView.js";
import { IInstantiationService } from "../../../../platform/instantiation/common/instantiation.js";
import { Part } from "../../part.js";
import type { GlobalCompositeBar } from "../globalCompositeBar.js";
import { WorkbenchWindowBarHeight } from "../workbenchPartDimensions.js";
import { BrowserMenubarControl, type IMenubarControl } from "./menubarControl.js";
import { ILocalizationService } from "../../../services/localization/common/localizationService.js";
import { CommandCenterControl } from "./commandCenterControl.js";
import { WindowTitle } from './windowTitle.js';
import type { IView } from '../../../../base/browser/ui/grid/grid.js';
import type { IEditorGroupsContainer } from '../../../services/editor/common/editorGroupsService.js';
import type { ITitleService } from '../../../services/title/browser/titleService.js';

export interface ITitleVariable {
	readonly name: string;
	readonly contextKey: string;
}

export interface ITitleProperties {
	isPure?: boolean;
	isAdmin?: boolean;
	prefix?: string;
}

export interface ITitlebarPart extends IDisposable {
	readonly onMenubarVisibilityChange: Event<boolean>;
	updateProperties(properties: ITitleProperties): void;
	registerVariables(variables: ITitleVariable[]): void;
}

/** Inputs shared by web and Electron titlebar factories. */
export interface ITitlebarPartFactoryOptions {
	readonly windowTitle: Pick<WindowTitle, 'value' | 'onDidChange' | 'updateProperties' | 'registerVariables'>;
}

/** Creates the titlebar implementation selected by the current host. */
export type TitlebarPartFactory = (
	container: HTMLElement,
	options: ITitlebarPartFactoryOptions,
	instantiationService: IInstantiationService,
) => BrowserTitlebarPart;

export class BrowserTitleService extends Disposable implements ITitleService {
	declare readonly _serviceBrand: undefined;
	public readonly windowTitle: WindowTitle;
	private readonly mainPart: BrowserTitlebarPart;
	private readonly auxiliaryParts = this._register(new DisposableMap<Document, AuxiliaryBrowserTitlebarPart>());
	private readonly variables = new Map<string, ITitleVariable>();
	private properties: ITitleProperties = {};
	public get onMenubarVisibilityChange(): Event<boolean> { return this.mainPart.onMenubarVisibilityChange; }

	constructor(
		private readonly container: HTMLElement,
		private readonly productName: string,
		createTitlebarPart: TitlebarPartFactory,
		editorGroupsContainer: IEditorGroupsContainer,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		// Window chrome reads its own groups; global editor commands may follow another window's focus.
		this.windowTitle = this._register(instantiationService.createInstance(WindowTitle, container.ownerDocument.defaultView!, productName, editorGroupsContainer));
		this.mainPart = this._register(createTitlebarPart(container, {
			windowTitle: this.windowTitle,
		}, instantiationService));
		this._register(CommandsRegistry.register('registerWindowTitleVariable', (_accessor, name, contextKey) => {
			if (typeof name !== 'string' || typeof contextKey !== 'string') {
				throw new TypeError(localize('window.title.invalidVariable', 'Window title variables require a name and a context key.'));
			}
			this.registerVariables([{ name, contextKey }]);
		}));
	}

	public updateProperties(properties: ITitleProperties): void {
		this.properties = { ...this.properties, ...properties };
		this.mainPart.updateProperties(properties);
		for (const [, part] of this.auxiliaryParts) {
			part.updateProperties(properties);
		}
	}

	public registerVariables(variables: ITitleVariable[]): void {
		for (const variable of variables) {
			this.variables.set(variable.name, variable);
		}
		this.mainPart.registerVariables(variables);
		for (const [, part] of this.auxiliaryParts) {
			part.registerVariables(variables);
		}
	}

	public getPart(container: HTMLElement): BrowserTitlebarPart {
		const part = container.ownerDocument === this.container.ownerDocument ? this.mainPart : this.auxiliaryParts.get(container.ownerDocument);
		if (!part) {
			throw new Error('This window has no titlebar registered with the title service');
		}
		return part;
	}

	public createAuxiliaryTitlebarPart(container: HTMLElement, editorGroupsContainer: IEditorGroupsContainer, instantiationService: IInstantiationService): IAuxiliaryTitlebarPart {
		const document = container.ownerDocument;
		if (document === this.container.ownerDocument || this.auxiliaryParts.has(document)) {
			throw new Error('This window already has a titlebar registered with the title service');
		}
		const part = instantiationService.createInstance(AuxiliaryBrowserTitlebarPart, container, this.productName,
			editorGroupsContainer, () => { this.auxiliaryParts.deleteAndLeak(document); });
		this.auxiliaryParts.set(document, part);
		part.updateProperties(this.properties);
		part.registerVariables([...this.variables.values()]);
		// The window owns sibling order; its editor and status bar follow the title area.
		container.prepend(part.domNode);
		return part;
	}
}

/** The host-neutral workbench title area and its actions. */
export class BrowserTitlebarPart extends Part implements ITitlebarPart {
	protected readonly menubarVisibilityChanged = this._register(new Emitter<boolean>());
	public readonly onMenubarVisibilityChange = this.menubarVisibilityChanged.event;
	private readonly menubar: IMenubarControl;
	private readonly centerAdjacentActions: MenuWorkbenchToolBar;
	private readonly actions: MenuWorkbenchToolBar;
	private readonly activityActionsListener = this._register(new MutableDisposable());
	private activityActions: { bar: GlobalCompositeBar; showContextMenu: (event: MouseEvent | KeyboardEvent) => void; } | undefined;

	override get minimumHeight(): number { return WorkbenchWindowBarHeight; }
	override get maximumHeight(): number { return WorkbenchWindowBarHeight; }

	constructor(
		container: HTMLElement,
		private readonly options: ITitlebarPartFactoryOptions,
		createMenubar: (menuService: IMenuService, contextMenuService: IContextMenuService, localizationService: ILocalizationService) => IMenubarControl,
		@IInstantiationService instantiationService: IInstantiationService,
		@IMenuService menuService: IMenuService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@ILocalizationService localizationService: ILocalizationService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
	) {
		super(container, "titlebar", themeService, storageService);
		const ownerDocument = container.ownerDocument;
		this.menubar = this._register(createMenubar(menuService, contextMenuService, localizationService));
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
		this._register(instantiationService.createInstance(CommandCenterControl, centerDomNode, options.windowTitle, localizationService));
		const centerAdjacentActionsDomNode = h(ownerDocument, "div");
		centerAdjacentActionsDomNode.className = "ash-titlebar-center-adjacent-actions ash-titlebar-interactive-region";
		centerDomNode.append(centerAdjacentActionsDomNode);
		this.centerAdjacentActions = this._register(
			new MenuWorkbenchToolBar(
				centerAdjacentActionsDomNode,
				menuService,
				contextMenuService,
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
				menuService,
				contextMenuService,
				MenuId.TitleBar,
				{
					ariaLabel: localizationService.translate("ash", "workbench.titleBarGlobalActions", "Title Bar global actions"),
					presentation: "inherit-foreground",
					actionViewItemProvider: (action, actionOptions) => this.activityActions?.bar.createActionViewItem(action, actionOptions),
				},
			),
		);
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

	public updateProperties(properties: ITitleProperties): void {
		this.options.windowTitle.updateProperties(properties);
	}

	public registerVariables(variables: ITitleVariable[]): void {
		this.options.windowTitle.registerVariables(variables);
	}

	public setActivityActions(actions: { bar: GlobalCompositeBar; showContextMenu: (event: MouseEvent | KeyboardEvent) => void; } | undefined): void {
		if (this.activityActions?.bar === actions?.bar) return;
		this.activityActions = actions;
		this.activityActionsListener.value = actions?.bar.onDidChangeActions(() => this.actions.setTrailingActions(actions.bar.getActions()));
		this.actions.setTrailingActions(actions?.bar.getActions() ?? []);
	}
}

/** Creates the titlebar used by a regular web workbench. */
export const createBrowserTitlebarPart: TitlebarPartFactory = (container, options, instantiationService) =>
	instantiationService.createInstance(BrowserTitlebarPart, container, options,
		(menuService: IMenuService, contextMenuService: IContextMenuService, localizationService: ILocalizationService) => new BrowserMenubarControl(container, menuService, contextMenuService, localizationService));

export interface IAuxiliaryTitlebarPart extends ITitlebarPart, IView {
	readonly container: HTMLElement;
	readonly height: number;
	updateOptions(options: { compact: boolean; }): void;
}

/** Uses the shared title UI without calling the main window's host-control API. */
export class AuxiliaryBrowserTitlebarPart extends BrowserTitlebarPart implements IAuxiliaryTitlebarPart {
	private compact = false;
	public get container(): HTMLElement { return this.domNode; }
	public get element(): HTMLElement { return this.domNode; }
	public get height(): number { return this.minimumHeight; }
	public readonly onDidChange = this.onDidChangeConstraints;

	constructor(
		container: HTMLElement,
		productName: string,
		editorGroupsContainer: IEditorGroupsContainer,
		onDispose: () => void,
		@IInstantiationService instantiationService: IInstantiationService,
		@IMenuService menuService: IMenuService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@ILocalizationService localizationService: ILocalizationService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
	) {
		const windowTitle = instantiationService.createInstance(WindowTitle, container.ownerDocument.defaultView!, productName, editorGroupsContainer);
		super(container, { windowTitle },
			(menus, contextMenus, localization) => new BrowserMenubarControl(container, menus, contextMenus, localization),
			instantiationService, menuService, contextMenuService, localizationService, themeService, storageService);
		this._register(windowTitle);
		this._register(toDisposable(onDispose));
		this.domNode.classList.add('ash-auxiliary-titlebar');
		this.domNode.style.height = `${this.height}px`;
	}

	public updateOptions(options: { compact: boolean; }): void {
		if (this.compact === options.compact) {
			return;
		}
		this.compact = options.compact;
		this.domNode.classList.toggle('ash-auxiliary-titlebar-compact', this.compact);
		this.menubarVisibilityChanged.fire(!this.compact);
		this.notifyConstraintsChanged();
	}
}
