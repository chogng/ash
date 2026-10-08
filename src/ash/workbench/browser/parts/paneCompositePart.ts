import { IThemeService } from '../../../platform/theme/common/themeService.js';
import type { PaneCompositeOptions } from './views/paneComposite.js';
import type { PaneComposite } from './views/paneComposite.js';
import { HoverPosition } from "../../../base/browser/ui/hover/hoverWidget.js";
import type { IActivityHoverOptions } from "./compositeBarActions.js";
import { toDisposable } from "../../../base/common/lifecycle.js";
import "./paneCompositePart.css";
import type { IContextMenuProvider } from "../../../base/browser/contextmenu.js";
import type { IDimension } from "../../../base/browser/dom.js";
import { localize, type ILocalizationService, type LocalizationKey } from "../../services/localization/common/localizationService.js";
import { MenuWorkbenchToolBar } from "../../../platform/actions/browser/toolbar.js";
import type { IMenuService, MenuId } from "../../../platform/actions/common/actions.js";
import type { IContextKey } from "../../../platform/contextkey/common/contextkey.js";
import type { IContextKeyService } from "../../../platform/contextkey/browser/contextKeyService.js";
import { ActiveAgentSidebarContext, ActiveAuxiliaryContext, ActivePanelContext, ActiveViewletContext } from '../../common/contextkeys.js';
import { ViewContainerLocation, type IViewContainerDescriptor } from "../../common/views.js";
import type { IViewDescriptorService } from "../../common/views.js";
import { CompositePart } from "./compositePart.js";
import { CompositeBar, type CompositeBarPresentation, type ICompositeBarOptions } from "./compositeBar.js";
import type { PartTitleProjection } from "./views/viewPane.js";
import { h } from "../../../base/browser/dom.js";
import { IStorageService, StorageScope, StorageTarget } from "../../../platform/storage/common/storage.js";

/** Menu-backed actions rendered at the right edge of a Pane Composite title. */
export interface PaneCompositeTitleActions {
	readonly menuService: IMenuService;
	readonly contextMenuProvider: IContextMenuProvider;
	readonly menuId: MenuId;
	readonly primaryGroup?: string;
}

/** Construction inputs shared by Sidebars, Auxiliary Bar, and Panel. */
export interface PaneCompositePartOptions {
	readonly openComposite: ICompositeBarOptions['openComposite'];
	readonly activityHoverOptions?: IActivityHoverOptions;
	readonly viewDescriptorService: IViewDescriptorService;
	readonly contextKeyService?: IContextKeyService;
	readonly localizationService?: ILocalizationService;
	readonly id: string;
	readonly location: ViewContainerLocation;
	readonly ariaLabel: string;
	readonly ariaLabelKey?: LocalizationKey;
	readonly viewsAriaLabel: string;
	readonly viewsAriaLabelKey?: LocalizationKey;
	readonly compositeBarPresentation?: CompositeBarPresentation;
	readonly compositeBarOrientation?: "horizontal" | "vertical";
	readonly compositeBarContextMenuProvider?: IContextMenuProvider;
	/** Selects which registered containers receive items in the hosted CompositeBar. */
	readonly compositeBarContainerFilter?: (container: IViewContainerDescriptor) => boolean;
	readonly compositeBarVisible?: boolean;
	readonly titleActions?: PaneCompositeTitleActions;
}

/**
 * Standard Workbench host for a location's retained PaneComposites.
 *
 * It owns the title slot, CompositeBar, and Composite lifecycle. Concrete
 * Parts only supply region constraints and
 * location-specific presentation.
 */
export class PaneCompositePart extends CompositePart<PaneComposite> {
	readonly compositeBar: CompositeBar;
	private readonly viewDescriptorService: IViewDescriptorService;
	private readonly activeCompositeContext: IContextKey<string> | undefined;
	private readonly location: ViewContainerLocation;
	protected readonly titleContentDomNode: HTMLDivElement;
	protected readonly titleActionsSlotDomNode: HTMLDivElement;
	protected readonly viewTitleActionsDomNode: HTMLDivElement;
	private readonly partTitleActionsDomNode: HTMLDivElement;
	private compositeBarVisible = true;
	private hasCustomTitleContent = false;

	/** The host chooses presentation; the shared service only creates and activates containers. */
	public getPaneCompositeOptions(): Pick<PaneCompositeOptions, 'paneHeaders' | 'paneLayout' | 'mergeViewWithContainerWhenSingleView'> {
		const fill = this.location === ViewContainerLocation.Panel || this.location === ViewContainerLocation.AuxiliaryBar;
		return { paneHeaders: fill ? 'hidden' : 'visible', paneLayout: fill ? 'fill' : 'stack' };
	}
	constructor(
		container: HTMLElement,
		options: PaneCompositePartOptions,
		@IThemeService themeService: IThemeService,
		@IStorageService private readonly storageService: IStorageService,
	) {
		super(container, options.id, themeService, storageService);
		this.viewDescriptorService = options.viewDescriptorService;
		this.activeCompositeContext = options.contextKeyService
			? activeCompositeContextKeys[options.location].bindTo(options.contextKeyService)
			: undefined;
		this._register(toDisposable(() => this.activeCompositeContext?.reset()));
		this.location = options.location;
		this._register(this.onDidCompositeOpen(({ composite }) => {
			const id = composite.getId();
			this.activeCompositeContext?.set(id);
			this.compositeBar.setActiveComposite(id);
			this.storeActiveComposite(id);
		}));
		this._register(this.onDidCompositeClose(() => {
			this.activeCompositeContext?.reset();
			this.compositeBar.setActiveComposite(undefined);
		}));
		const ownerDocument = container.ownerDocument;
		const ariaLabel = localize(options.localizationService, options.ariaLabelKey, options.ariaLabel);
		const viewsAriaLabel = localize(options.localizationService, options.viewsAriaLabelKey, options.viewsAriaLabel);
		this.domNode.setAttribute("aria-label", ariaLabel);
		this.titleDomNode.classList.add("ash-pane-composite-title");
		this.titleContentDomNode = h(ownerDocument, "div");
		this.titleContentDomNode.className = "ash-pane-composite-title-content";
		this.compositeBar = this._register(new CompositeBar(this.titleContentDomNode, {
			openComposite: options.openComposite,
			activityHoverOptions: options.activityHoverOptions ?? { position: () => HoverPosition.ABOVE },
			viewDescriptorService: options.viewDescriptorService,
			localizationService: options.localizationService,
			location: options.location,
			ariaLabel: viewsAriaLabel,
			presentation: options.compositeBarPresentation,
			orientation: options.compositeBarOrientation,
			contextMenuProvider: options.compositeBarContextMenuProvider,
			storageService,
			containerFilter: options.compositeBarContainerFilter,
		}));
		this.titleActionsSlotDomNode = h(ownerDocument, "div");
		this.titleActionsSlotDomNode.className = "ash-pane-composite-title-actions";
		this.viewTitleActionsDomNode = h(ownerDocument, "div");
		this.viewTitleActionsDomNode.className = "ash-pane-composite-title-view-actions";
		this.partTitleActionsDomNode = h(ownerDocument, "div");
		this.partTitleActionsDomNode.className = "ash-pane-composite-title-part-actions";
		this.titleActionsSlotDomNode.append(this.viewTitleActionsDomNode, this.partTitleActionsDomNode);
		this.titleDomNode.append(this.titleContentDomNode, this.titleActionsSlotDomNode);
		const compositeActions = h(ownerDocument, 'div');
		compositeActions.className = 'ash-pane-composite-title-view-actions';
		this.titleActionsSlotDomNode.insertBefore(compositeActions, this.viewTitleActionsDomNode);
		const contextMenus = options.titleActions?.contextMenuProvider ?? options.compositeBarContextMenuProvider;
		if (contextMenus) this.createCompositeToolBar(compositeActions, contextMenus, ariaLabel);

		if (options.titleActions) {
			const actions = this._register(new MenuWorkbenchToolBar(
				this.partTitleActionsDomNode,
				options.titleActions.menuService,
				options.titleActions.contextMenuProvider,
				options.titleActions.menuId,
				{ highlightToggledItems: true, toolbarOptions: { primaryGroup: options.titleActions.primaryGroup } },
			));
			actions.element.classList.add("ash-pane-composite-title-menu-actions");
		}

		this.setCompositeBarVisible(options.compositeBarVisible ?? true);
		this._register(this.viewDescriptorService.onDidChangeViewContainers(({ removed }) => {
			for (const container of removed) {
				if (container.location !== this.location) continue;
				const active = this.activeCompositeId === container.id;
				this.removeComposite(container.id);
				if (active) {
					this.activeCompositeContext?.reset();
					this.setTitleProjection(undefined);
				}
			}
		}));
	}

	public override showComposite(compositeId: string, focus = false): void {
		if (this.activeCompositeId) this.getComposite(this.activeCompositeId)?.setMergedTitleActionsHost();
		super.showComposite(compositeId, focus);
	}

	protected override updateTitleArea(): void {
		super.updateTitleArea();
		if (this.activeCompositeId) {
			this.getComposite(this.activeCompositeId)?.setMergedTitleActionsHost(this.viewTitleActionsDomNode, this.compositeToolBar?.element);
		}
	}

	/** Resolves the last valid workspace selection, then falls back to the Registry default. */
	getCompositeIdToRestore(): string | undefined {
		const stored = this.storageService.get(
			activeCompositeStorageKeys[this.location],
			StorageScope.WORKSPACE,
		);
		if (stored && this.viewDescriptorService
			.getViewContainers(this.location)
			.some((container) => container.id === stored)) {
			return stored;
		}
		return this.viewDescriptorService.getDefaultViewContainer(this.location)?.id;
	}

	setCompositeBarVisible(visible: boolean): void {
		this.compositeBarVisible = visible;
		this.compositeBar.domNode.hidden = !visible;
		this.updateTitleVisibility();
	}

	/** Projects one View's title content and actions into the Part's fixed slots. */
	protected setTitleProjection(projection: PartTitleProjection | undefined): void {
		this.hasCustomTitleContent = projection?.content !== undefined;
		const content = projection?.content ?? this.compositeBar.domNode;
		if (this.titleContentDomNode.firstChild !== content || this.titleContentDomNode.childNodes.length !== 1) {
			this.titleContentDomNode.replaceChildren(content);
		}
		const actions = projection?.actions;
		if (this.viewTitleActionsDomNode.firstChild !== (actions ?? null) || this.viewTitleActionsDomNode.childNodes.length !== (actions ? 1 : 0)) {
			this.viewTitleActionsDomNode.replaceChildren(...(actions ? [actions] : []));
		}
		this.updateTitleVisibility();
	}

	override layout(_dimension: IDimension): void {
		this.compositeBar.layout();
	}

	private updateTitleVisibility(): void {
		this.titleDomNode.hidden = !this.compositeBarVisible && !this.hasCustomTitleContent && this.viewTitleActionsDomNode.childElementCount === 0 && this.partTitleActionsDomNode.childElementCount === 0;
	}

	private storeActiveComposite(compositeId: string): void {
		const storage = this.storageService;
		const key = activeCompositeStorageKeys[this.location];
		if (compositeId === this.viewDescriptorService.getDefaultViewContainer(this.location)?.id) {
			storage.remove(key, StorageScope.WORKSPACE);
			return;
		}
		storage.store(key, compositeId, StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}
}

const activeCompositeStorageKeys = {
	[ViewContainerLocation.Sidebar]: "workbench.sidebar.activeViewContainer",
	[ViewContainerLocation.Panel]: "workbench.panel.activeViewContainer",
	[ViewContainerLocation.AuxiliaryBar]: "workbench.auxiliarybar.activeViewContainer",
	[ViewContainerLocation.AgentSidebar]: "workbench.agentSidebar.activeViewContainer",
} as const satisfies Record<ViewContainerLocation, string>;

const activeCompositeContextKeys = {
	[ViewContainerLocation.Sidebar]: ActiveViewletContext,
	[ViewContainerLocation.Panel]: ActivePanelContext,
	[ViewContainerLocation.AuxiliaryBar]: ActiveAuxiliaryContext,
	[ViewContainerLocation.AgentSidebar]: ActiveAgentSidebarContext,
} as const satisfies Record<ViewContainerLocation, typeof ActiveViewletContext>;
