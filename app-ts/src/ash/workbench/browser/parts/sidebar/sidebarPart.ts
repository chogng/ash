import "./sidebarpart.css";
import { h } from "../../../../base/browser/dom.js";
import type { IContextMenuProvider } from '../../../../base/browser/contextmenu.js';
import { ViewContainerLocation, type IViewContainerDescriptor } from "../../../common/views.js";
import type { IStorageService } from "../../../../platform/storage/common/storage.js";
import type { IContextKeyService } from "../../../../platform/contextkey/browser/contextKeyService.js";
import { localize, type ILocalizationService, type LocalizationKey } from "../../../services/localization/common/localizationService.js";
import type { IViewDescriptorService } from "../../../services/views/common/viewDescriptorService.js";
import { PaneCompositePart, type PaneCompositeTitleActions } from "../paneCompositePart.js";
import type { ActivityBarLocation } from '../../../common/configuration.js';

/** Construction inputs for a Sidebar Composite host. */
export interface SidebarPartOptions {
	readonly viewDescriptorService: IViewDescriptorService;
	readonly contextKeyService?: IContextKeyService;
	readonly storageService?: IStorageService;
	readonly localizationService?: ILocalizationService;
	readonly id?: string;
	readonly location?: ViewContainerLocation;
	readonly ariaLabel?: string;
	readonly ariaLabelKey?: LocalizationKey;
	readonly viewsAriaLabel?: string;
	readonly viewsAriaLabelKey?: LocalizationKey;
	/** Selects which registered containers receive items in the hosted CompositeBar. */
	readonly compositeBarContainerFilter?: (container: IViewContainerDescriptor) => boolean;
	readonly compositeBarVisible?: boolean;
	readonly compositeBarContextMenuProvider?: IContextMenuProvider;
	readonly titleActions?: PaneCompositeTitleActions;
}

/** Reusable Pane Composite Part presented at the side of the Workbench. */
export class SidebarPart extends PaneCompositePart {
	private readonly viewDescriptors: IViewDescriptorService;
	private readonly localization: ILocalizationService | undefined;
	private readonly activeTitleDomNode: HTMLSpanElement | undefined;
	private readonly topCompositeBarDomNode: HTMLDivElement | undefined;
	private readonly bottomCompositeBarDomNode: HTMLDivElement | undefined;
	override get minimumWidth(): number { return 180; }
	override get maximumWidth(): number { return 600; }

	constructor(container: HTMLElement, options: SidebarPartOptions) {
		const location = options.location ?? ViewContainerLocation.Sidebar;
		super(container, {
			viewDescriptorService: options.viewDescriptorService,
			contextKeyService: options.contextKeyService,
			storageService: options.storageService,
			localizationService: options.localizationService,
			id: options.id ?? "sidebar",
			location,
			ariaLabel: options.ariaLabel ?? "Primary sidebar",
			ariaLabelKey: options.ariaLabelKey,
			viewsAriaLabel: options.viewsAriaLabel ?? "Primary side bar views",
			viewsAriaLabelKey: options.viewsAriaLabelKey,
			compositeBarContainerFilter: options.compositeBarContainerFilter,
			compositeBarVisible: options.compositeBarVisible,
			compositeBarContextMenuProvider: options.compositeBarContextMenuProvider,
			compositeBarOrientation: location === ViewContainerLocation.Sidebar ? "vertical" : "horizontal",
			titleActions: options.titleActions,
		});
		this.viewDescriptors = options.viewDescriptorService;
		this.localization = options.localizationService;
		this.domNode.classList.add("ash-sidebar-part");
		if (location === ViewContainerLocation.Sidebar) {
			// In top and bottom mode the view selector belongs to the sidebar, so the sidebar keeps its full grid height.
			this.topCompositeBarDomNode = h(container.ownerDocument, 'div');
			this.topCompositeBarDomNode.className = 'ash-sidebar-composite-bar-top';
			this.topCompositeBarDomNode.hidden = true;
			this.domNode.insertBefore(this.topCompositeBarDomNode, this.titleDomNode);
			this.bottomCompositeBarDomNode = h(container.ownerDocument, 'div');
			this.bottomCompositeBarDomNode.className = 'ash-sidebar-composite-bar-bottom';
			this.bottomCompositeBarDomNode.hidden = true;
			this.domNode.append(this.bottomCompositeBarDomNode);
			this.activeTitleDomNode = h(container.ownerDocument, "span");
			this.activeTitleDomNode.className = "ash-sidebar-title-label";
			this.titleContentDomNode.replaceChildren(this.activeTitleDomNode);
			if (this.localization) this._register(this.localization.onDidChange(() => this.updateActiveTitle()));
		}
	}

	public setActivityBarLocation(location: ActivityBarLocation): void {
		if (!this.topCompositeBarDomNode || !this.bottomCompositeBarDomNode) return;
		const isTop = location === 'top';
		const isBottom = location === 'bottom';
		this.topCompositeBarDomNode.hidden = !isTop;
		this.bottomCompositeBarDomNode.hidden = !isBottom;
		if (isTop || isBottom) {
			this.compositeBar.setOrientation('horizontal');
			(isTop ? this.topCompositeBarDomNode : this.bottomCompositeBarDomNode).append(this.compositeBar.domNode);
		} else {
			this.compositeBar.setOrientation('vertical');
		}
	}

	override showComposite(compositeId: string): void {
		super.showComposite(compositeId);
		this.updateActiveTitle();
	}

	private updateActiveTitle(): void {
		if (!this.activeTitleDomNode || !this.activeCompositeId) return;
		const container = this.viewDescriptors.getViewContainers(ViewContainerLocation.Sidebar)
			.find(candidate => candidate.id === this.activeCompositeId);
		if (container) this.activeTitleDomNode.textContent = localize(this.localization, container.localizationKey, container.title);
	}
}
