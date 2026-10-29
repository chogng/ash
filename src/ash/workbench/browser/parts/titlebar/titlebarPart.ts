import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { getWCOTitlebarAreaRect, isStandalone, isWCOEnabled } from '../../../../base/browser/browser.js';
import { isWeb } from '../../../../base/common/platform.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { localize } from '../../../../nls.js';
import { appendIcon } from '../../../../base/browser/ui/lxicons/lxicon.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import './media/titlebarpart.css';
import { addDisposableListener, getWindow, h, type IDimension } from '../../../../base/browser/dom.js';
import { observeResize } from '../../../../base/browser/observer.js';
import { Emitter, type Event } from '../../../../base/common/event.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { Disposable, DisposableStore, DisposableMap, MutableDisposable, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { MenuWorkbenchToolBar, WorkbenchToolBar } from '../../../../platform/actions/browser/toolbar.js';
import { IMenuService, MenuId, SubmenuItemAction, type IMenu } from '../../../../platform/actions/common/actions.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { createActionViewItem, getActionBarActions } from '../../../../platform/actions/browser/menuEntryActionViewItem.js';
import { IsAuxiliaryWindowContext, IsCompactTitleBarContext } from '../../../common/contextkeys.js';
import { Part } from '../../part.js';
import type { GlobalCompositeBar } from '../globalCompositeBar.js';
import { WorkbenchWindowBarHeight } from '../workbenchPartDimensions.js';
import { BrowserMenubarControl, type IMenubarControl } from './menubarControl.js';
import { ILocalizationService } from '../../../services/localization/common/localizationService.js';
import { CommandCenterControl } from './commandCenterControl.js';
import { WindowTitle } from './windowTitle.js';
import type { IView } from '../../../../base/browser/ui/grid/grid.js';
import type { IActiveEditorActions, IEditorGroupsContainer } from '../../../services/editor/common/editorGroupsService.js';
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
	readonly editorGroupsContainer?: IEditorGroupsContainer;
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
		protected readonly productName: string,
		createTitlebarPart: TitlebarPartFactory,
		editorGroupsContainer: IEditorGroupsContainer,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		// Window chrome reads its own groups; global editor commands may follow another window's focus.
		this.windowTitle = this._register(instantiationService.createInstance(WindowTitle, container.ownerDocument.defaultView!, productName, editorGroupsContainer));
		this.mainPart = this._register(createTitlebarPart(container, {
			windowTitle: this.windowTitle,
			editorGroupsContainer,
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
		const part = this.doCreateAuxiliaryTitlebarPart(container, editorGroupsContainer, instantiationService,
			() => { this.auxiliaryParts.deleteAndLeak(document); });
		this.auxiliaryParts.set(document, part);
		part.updateProperties(this.properties);
		part.registerVariables([...this.variables.values()]);
		// The window owns sibling order; its editor and status bar follow the title area.
		container.prepend(part.domNode);
		return part;
	}

	protected doCreateAuxiliaryTitlebarPart(container: HTMLElement, editorGroupsContainer: IEditorGroupsContainer, instantiationService: IInstantiationService, onDispose: () => void): AuxiliaryBrowserTitlebarPart {
		return instantiationService.createInstance(AuxiliaryBrowserTitlebarPart, container, this.productName, editorGroupsContainer, onDispose, 'application-menu');
	}
}

/** Shares browser window geometry while each product retains its titlebar content. */
export abstract class WebTitlebarPart extends Part {
	private webTitlebarHeight = WorkbenchWindowBarHeight;

	override get minimumHeight(): number { return this.webTitlebarHeight; }
	override get maximumHeight(): number { return this.minimumHeight; }

	protected constructor(
		container: HTMLElement,
		themeService: IThemeService,
		storageService: IStorageService,
		private readonly horizontalPadding: number = 12,
	) {
		super(container, 'titlebar', themeService, storageService);
		if (isWeb) {
			const targetWindow = container.ownerDocument.defaultView!;
			const refresh = (): void => this.updateWebWindowControls();
			const overlay = (targetWindow.navigator as Navigator & { windowControlsOverlay?: EventTarget; }).windowControlsOverlay;
			if (overlay) this._register(addDisposableListener(overlay, 'geometrychange', refresh));
			this._register(addDisposableListener(targetWindow, 'resize', refresh));
			for (const mode of ['standalone', 'window-controls-overlay', 'fullscreen']) {
				const query = targetWindow.matchMedia?.(`(display-mode: ${mode})`);
				if (query) this._register(addDisposableListener(query, 'change', refresh));
			}
			refresh();
		}
	}

	public override layout(_dimension: IDimension): void {
		if (isWeb) this.updateWebWindowControls();
	}

	private updateWebWindowControls(): void {
		const targetWindow = this.domNode.ownerDocument.defaultView!;
		const area = isWCOEnabled(targetWindow) ? getWCOTitlebarAreaRect(targetWindow) : undefined;
		// In fullscreen the API can remain enabled while its titlebar rectangle is empty.
		const overlay = area !== undefined && area.width > 0 && area.height > 0;
		this.domNode.classList.toggle('ash-web-titlebar-overlay', overlay);
		this.domNode.classList.toggle('ash-web-titlebar-compact', overlay && area.width < 800);
		this.domNode.classList.toggle('ash-web-titlebar-standalone', isStandalone(targetWindow));
		const height = overlay ? Math.max(WorkbenchWindowBarHeight, area.height) : WorkbenchWindowBarHeight;
		if (overlay) {
			const bounds = this.domNode.getBoundingClientRect();
			this.domNode.style.paddingLeft = `${this.horizontalPadding + Math.max(0, area.x - bounds.x)}px`;
			this.domNode.style.paddingRight = `${this.horizontalPadding + Math.max(0, bounds.right - area.right)}px`;
		} else {
			this.domNode.style.removeProperty('padding-left');
			this.domNode.style.removeProperty('padding-right');
		}
		if (height !== this.webTitlebarHeight) {
			this.webTitlebarHeight = height;
			this.notifyConstraintsChanged();
		}
	}
}

/** The host-neutral workbench title area and its actions. */
export class BrowserTitlebarPart extends WebTitlebarPart implements ITitlebarPart {
	protected readonly menubarVisibilityChanged = this._register(new Emitter<boolean>());
	public readonly onMenubarVisibilityChange = this.menubarVisibilityChanged.event;
	private readonly menubar: IMenubarControl;
	private readonly centerAdjacentActions: MenuWorkbenchToolBar;
	private readonly actions: WorkbenchToolBar;
	private readonly actionsDomNode: HTMLElement;
	private readonly centerDomNode: HTMLElement;
	private readonly editorTitleControlHost: HTMLElement;
	private readonly editorActionsLifetime = this._register(new DisposableStore());
	private readonly editorGroupListener = this._register(new MutableDisposable());
	private editorActions: IActiveEditorActions | undefined;
	private readonly layoutMenu: IMenu;
	private readonly globalMenu: IMenu;
	protected readonly contextKeyService: IContextKeyService;
	protected isCompact = false;
	private readonly activityActionsListener = this._register(new MutableDisposable());
	private activityActions: { bar: GlobalCompositeBar; showContextMenu: (event: MouseEvent | KeyboardEvent) => void; } | undefined;

	constructor(
		container: HTMLElement,
		private readonly options: ITitlebarPartFactoryOptions,
		createMenubar: (menuService: IMenuService, contextMenuService: IContextMenuService, localizationService: ILocalizationService, contextKeyService: IContextKeyService) => IMenubarControl,
		@IInstantiationService instantiationService: IInstantiationService,
		@IMenuService menuService: IMenuService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@ILocalizationService localizationService: ILocalizationService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super(container, themeService, storageService);
		this.contextKeyService = this._register(contextKeyService.createScoped(this.domNode));
		IsAuxiliaryWindowContext.bindTo(this.contextKeyService);
		IsCompactTitleBarContext.bindTo(this.contextKeyService);
		const ownerDocument = container.ownerDocument;
		this.menubar = this._register(createMenubar(menuService, contextMenuService, localizationService, this.contextKeyService));
		const appIconDomNode = h(ownerDocument, 'span');
		appIconDomNode.className = 'ash-titlebar-app-icon';
		appIconDomNode.setAttribute('aria-hidden', 'true');
		appendIcon(Lxicon.ashMark, appIconDomNode);
		this.titleDomNode.append(appIconDomNode);
		if (this.menubar.domNode) {
			this.menubar.domNode.classList.add('ash-titlebar-interactive-region');
			this.titleDomNode.append(this.menubar.domNode);
		}
		const centerDomNode = h(ownerDocument, 'div');
		this.centerDomNode = centerDomNode;
		centerDomNode.className = 'ash-titlebar-center';
		this.contentDomNode.before(centerDomNode);
		this._register(instantiationService.createInstance(CommandCenterControl, centerDomNode, options.windowTitle, localizationService, undefined));
		this.editorTitleControlHost = h(ownerDocument, 'div');
		this.editorTitleControlHost.className = 'ash-titlebar-editor-control';
		centerDomNode.append(this.editorTitleControlHost);
		this._register(toDisposable(() => this.editorTitleControlHost.replaceChildren()));
		const windowTitleDomNode = h(ownerDocument, 'span');
		windowTitleDomNode.className = 'ash-titlebar-window-title';
		centerDomNode.append(windowTitleDomNode);
		const updateWindowTitle = (): void => {
			windowTitleDomNode.textContent = options.windowTitle.value;
			windowTitleDomNode.title = options.windowTitle.value;
		};
		this._register(options.windowTitle.onDidChange(updateWindowTitle));
		updateWindowTitle();
		const centerAdjacentActionsDomNode = h(ownerDocument, 'div');
		centerAdjacentActionsDomNode.className = 'ash-titlebar-center-adjacent-actions ash-titlebar-interactive-region';
		centerDomNode.append(centerAdjacentActionsDomNode);
		this.centerAdjacentActions = this._register(
			new MenuWorkbenchToolBar(
				centerAdjacentActionsDomNode,
				menuService,
				contextMenuService,
				MenuId.TitleBarAdjacentCenter,
				{ presentation: 'inherit-foreground', contextKeyService: this.contextKeyService },
			),
		);
		const actionsDomNode = h(ownerDocument, 'div');
		this.actionsDomNode = actionsDomNode;
		actionsDomNode.className = 'ash-titlebar-actions ash-titlebar-interactive-region';
		this.contentDomNode.append(actionsDomNode);
		this.actions = this._register(new WorkbenchToolBar(actionsDomNode, contextMenuService, {
			ariaLabel: localizationService.translate('ash', 'workbench.titleBarGlobalActions', 'Title Bar global actions'),
			presentation: 'inherit-foreground',
			actionViewItemProvider: (action, actionOptions) => this.activityActions?.bar.createActionViewItem(action, actionOptions)
				?? (action instanceof SubmenuItemAction && action.item.isSplitButton
					? createActionViewItem(action, contextMenuService, { ...actionOptions, buttonPresentation: 'primary' })
					: undefined),
		}));
		this._register(observeResize([this.domNode, actionsDomNode, this.editorTitleControlHost], () => this.layoutCommandCenter()));
		this.layoutMenu = this._register(menuService.createMenu(MenuId.LayoutControlMenu, this.contextKeyService));
		this.globalMenu = this._register(menuService.createMenu(MenuId.TitleBar, this.contextKeyService));
		this._register(this.layoutMenu.onDidChange(() => this.updateToolbarActions()));
		this._register(this.globalMenu.onDidChange(() => this.updateToolbarActions()));
		this.updateToolbarActions();
		const editorGroupsContainer = options.editorGroupsContainer;
		if (editorGroupsContainer) {
			const watchGroup = (): void => {
				this.editorGroupListener.value = editorGroupsContainer.activeGroup.onDidChangeEditors(() => this.updateEditorActions());
				this.updateEditorActions();
			};
			this._register(editorGroupsContainer.onDidChangeActiveGroup(watchGroup));
			watchGroup();
		}
		const isActivityAction = (target: EventTarget | null) =>
			(target as Element | null)?.closest('[data-action-id="ash.activityBar.accounts"], [data-action-id="ash.activityBar.manage"]') !== null;
		this._register(addDisposableListener(actionsDomNode, 'contextmenu', event => {
			if (this.activityActions && isActivityAction(event.target)) this.activityActions.showContextMenu(event);
		}));
		this._register(addDisposableListener(actionsDomNode, 'keydown', event => {
			if (this.activityActions && isActivityAction(event.target) && (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey))) {
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
		this.activityActionsListener.value = actions?.bar.onDidChangeActions(() => this.updateToolbarActions());
		this.updateToolbarActions();
	}

	public updateOptions(options: { compact: boolean; }): void {
		this.isCompact = options.compact;
		IsCompactTitleBarContext.bindTo(this.contextKeyService).set(this.isCompact);
		this.updateEditorActions();
	}

	private updateEditorActions(): void {
		this.editorActionsLifetime.clear();
		this.editorActions = this.isCompact ? this.options.editorGroupsContainer?.activeGroup.createEditorActions(this.editorActionsLifetime, MenuId.CompactWindowEditorTitle) : undefined;
		if (this.editorActions) this.editorActionsLifetime.add(this.editorActions.onDidChange(() => this.updateToolbarActions()));
		this.updateToolbarActions();
	}

	private updateToolbarActions(): void {
		// The pane retains ownership; window chrome only mounts its current title control.
		const titleControl = this.editorActions?.titleControl as HTMLElement | undefined;
		if (this.editorTitleControlHost.firstElementChild !== (titleControl ?? null)) {
			this.editorTitleControlHost.replaceChildren(...(titleControl ? [titleControl] : []));
		}
		this.centerDomNode.classList.toggle('ash-titlebar-center-custom', titleControl !== undefined);
		const layout = getActionBarActions(this.layoutMenu.getActions(), 'navigation');
		const global = getActionBarActions(this.isCompact ? [] : this.globalMenu.getActions());
		const editor = this.editorActions?.actions;
		this.actions.setActions(
			[...(editor?.primary ?? []), ...layout.primary, ...global.primary],
			[...(editor?.secondary ?? []), ...layout.secondary, ...global.secondary],
			this.isCompact ? [] : this.activityActions?.bar.getActions() ?? [],
		);
		this.layoutCommandCenter();
	}

	private layoutCommandCenter(): void {
		if (!this.isCompact || !this.editorTitleControlHost.firstElementChild) {
			this.centerDomNode.style.removeProperty('max-width');
			return;
		}
		const bounds = this.domNode.getBoundingClientRect();
		if (!bounds.width) return;
		const style = getWindow(this.domNode).getComputedStyle(this.domNode);
		const center = bounds.left + bounds.width / 2;
		const navigation = this.editorTitleControlHost.querySelector<HTMLElement>('.ash-titlebar-command-center-navigation');
		const leadingWidth = navigation?.getClientRects().length
			? this.centerDomNode.getBoundingClientRect().left - navigation.getBoundingClientRect().left
			: 0;
		const gap = parseFloat(style.getPropertyValue('--ash-spacing-size80')) || 0;
		// Keep both edges equally far from the window center. The narrower side
		// limits the search width, including native controls and editor navigation.
		const available = Math.min(
			center - bounds.left - parseFloat(style.paddingLeft) - leadingWidth,
			this.actionsDomNode.getBoundingClientRect().left - gap - center,
		);
		const maxWidth = `${Math.max(0, Math.floor(2 * available))}px`;
		if (this.centerDomNode.style.maxWidth !== maxWidth) this.centerDomNode.style.maxWidth = maxWidth;
	}

}

/** Creates the titlebar used by a regular web workbench. */
export const createBrowserTitlebarPart: TitlebarPartFactory = (container, options, instantiationService) =>
	instantiationService.createInstance(BrowserTitlebarPart, container, options,
		(menuService: IMenuService, contextMenuService: IContextMenuService, localizationService: ILocalizationService, contextKeyService: IContextKeyService) => new BrowserMenubarControl(container, menuService, contextMenuService, localizationService, {}, contextKeyService));

export interface IAuxiliaryTitlebarPart extends ITitlebarPart, IView {
	readonly container: HTMLElement;
	readonly height: number;
	updateOptions(options: { compact: boolean; }): void;
}

/** Uses the shared title UI without calling the main window's host-control API. */
export class AuxiliaryBrowserTitlebarPart extends BrowserTitlebarPart implements IAuxiliaryTitlebarPart {
	public get container(): HTMLElement { return this.domNode; }
	public get element(): HTMLElement { return this.domNode; }
	public get height(): number { return this.minimumHeight; }
	public readonly onDidChange = this.onDidChangeConstraints;

	constructor(
		container: HTMLElement,
		productName: string,
		editorGroupsContainer: IEditorGroupsContainer,
		onDispose: () => void,
		menubarPresentation: 'application-menu' | 'actions-only',
		@IInstantiationService instantiationService: IInstantiationService,
		@IMenuService menuService: IMenuService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@ILocalizationService localizationService: ILocalizationService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		const windowTitle = instantiationService.createInstance(WindowTitle, container.ownerDocument.defaultView!, productName, editorGroupsContainer);
		super(container, { windowTitle, editorGroupsContainer },
			(menus, contextMenus, localization, contextKeys) => new BrowserMenubarControl(container, menus, contextMenus, localization, { presentation: menubarPresentation }, contextKeys),
			instantiationService, menuService, contextMenuService, localizationService, themeService, storageService, contextKeyService);
		this._register(windowTitle);
		this._register(toDisposable(onDispose));
		IsAuxiliaryWindowContext.bindTo(this.contextKeyService).set(true);
		this.domNode.classList.add('ash-auxiliary-titlebar');
		this.domNode.style.height = `${this.height}px`;
	}

	public override updateOptions(options: { compact: boolean; }): void {
		if (this.isCompact === options.compact) {
			return;
		}
		super.updateOptions(options);
		this.domNode.classList.toggle('ash-auxiliary-titlebar-compact', this.isCompact);
		this.menubarVisibilityChanged.fire(!this.isCompact);
		this.notifyConstraintsChanged();
	}
}
