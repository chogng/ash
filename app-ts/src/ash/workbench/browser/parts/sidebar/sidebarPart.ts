import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import type { IActivityHoverOptions } from "../compositeBarActions.js";
import "./sidebarpart.css";
import { h } from "../../../../base/browser/dom.js";
import { MutableDisposable } from "../../../../base/common/lifecycle.js";
import type { IContextMenuProvider } from '../../../../base/browser/contextmenu.js';
import { ViewContainerLocation, type IViewContainerDescriptor } from "../../../common/views.js";
import { IStorageService } from "../../../../platform/storage/common/storage.js";
import type { IContextKeyService } from "../../../../platform/contextkey/browser/contextKeyService.js";
import type { ILocalizationService, LocalizationKey } from "../../../services/localization/common/localizationService.js";
import type { IViewDescriptorService } from "../../../common/views.js";
import { PaneCompositePart, type PaneCompositeTitleActions } from "../paneCompositePart.js";
import { ActivityBarPosition } from '../../../common/configuration.js';
import type { ICompositeBarOptions } from '../compositeBar.js';

/** Construction inputs for a Sidebar Composite host. */
export interface SidebarPartOptions {
	readonly openComposite: ICompositeBarOptions['openComposite'];
	readonly activityHoverOptions?: IActivityHoverOptions;
	readonly viewDescriptorService: IViewDescriptorService;
	readonly contextKeyService?: IContextKeyService;
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
	private readonly activeTitleDomNode: HTMLSpanElement | undefined;
	private readonly topCompositeBarDomNode: HTMLDivElement | undefined;
	private readonly bottomCompositeBarDomNode: HTMLDivElement | undefined;
	private readonly activeTitleListener = this._register(new MutableDisposable());
	override get minimumWidth(): number { return 180; }
	override get maximumWidth(): number { return 600; }
	override get preferredWidth(): number | undefined {
		const active = this.activeCompositeId;
		const width = active ? this.getComposite(active)?.getOptimalWidth() : undefined;
		return width === undefined ? undefined : Math.max(width, 300);
	}

	constructor(
		container: HTMLElement,
		options: SidebarPartOptions,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
	) {
		const location = options.location ?? ViewContainerLocation.Sidebar;
		super(container, {
			openComposite: options.openComposite,
			activityHoverOptions: options.activityHoverOptions,
			viewDescriptorService: options.viewDescriptorService,
			contextKeyService: options.contextKeyService,
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
		}, themeService, storageService);
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
		}
	}

	public setActivityBarLocation(location: ActivityBarPosition): void {
		if (!this.topCompositeBarDomNode || !this.bottomCompositeBarDomNode) return;
		const isTop = location === ActivityBarPosition.TOP;
		const isBottom = location === ActivityBarPosition.BOTTOM;
		this.topCompositeBarDomNode.hidden = !isTop;
		this.bottomCompositeBarDomNode.hidden = !isBottom;
		if (isTop || isBottom) {
			this.compositeBar.setOrientation('horizontal');
			(isTop ? this.topCompositeBarDomNode : this.bottomCompositeBarDomNode).append(this.compositeBar.domNode);
		} else {
			this.compositeBar.setOrientation('vertical');
		}
	}

	override showComposite(compositeId: string, focus = false): void {
		const previousId = this.activeCompositeId;
		if (previousId) this.getComposite(previousId)?.setMergedTitleActionsHost();
		super.showComposite(compositeId, focus);
		this.activeTitleListener.value = this.getComposite(compositeId)?.onDidChangeTitle(() => this.updateActiveTitle());
		this.updateActiveTitle();
	}

	private updateActiveTitle(): void {
		if (!this.activeTitleDomNode || !this.activeCompositeId) return;
		const composite = this.getComposite(this.activeCompositeId);
		if (!composite) return;
		this.activeTitleDomNode.textContent = composite.getTitle();
		composite.setMergedTitleActionsHost(this.viewTitleActionsDomNode);
	}
}
