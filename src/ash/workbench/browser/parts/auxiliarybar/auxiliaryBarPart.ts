import { IActivityService } from '../../../services/activity/common/activity.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import "./media/auxiliaryBarPart.css";
import { IStorageService } from "../../../../platform/storage/common/storage.js";
import { IContextKeyService } from "../../../../platform/contextkey/browser/contextKeyService.js";
import { ViewContainerLocation } from "../../../common/views.js";
import { ILocalizationService } from "../../../services/localization/common/localizationService.js";
import { IViewDescriptorService } from "../../../common/views.js";
import { PaneCompositePart } from "../paneCompositePart.js";
import { IMenuService, MenuId } from '../../../../platform/actions/common/actions.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';

/**
 * Secondary Pane Composite region.
 *
 * Its fixed Chat container still owns session navigation, while this Part
 * owns the retained Composite lifecycle shared by all pane-like regions.
 */
export class AuxiliaryBarPart extends PaneCompositePart {

	override get minimumWidth(): number {
		// The content minimum excludes this Part's one-pixel left border; Grid adds frame insets.
		return Math.max(180, super.minimumWidth + 1);
	}
	override get maximumWidth(): number { return Number.POSITIVE_INFINITY; }
	override get preferredWidth(): number | undefined {
		const active = this.activeCompositeId;
		return active ? Math.max(this.getComposite(active)!.getOptimalWidth(), 300) : undefined;
	}

	constructor(
		container: HTMLElement,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@ILocalizationService localizationService: ILocalizationService,
		@IMenuService menuService: IMenuService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IActivityService activityService: IActivityService,
	) {
		super(container, {
			openComposite: (id, preserveFocus) => instantiationService.invokeFunction(accessor => accessor.get(IViewsService).openViewContainer(id, !preserveFocus)),
			viewDescriptorService,
			contextKeyService,
			localizationService,
			id: "auxiliarybar",
			location: ViewContainerLocation.AuxiliaryBar,
			ariaLabel: "Auxiliary sidebar",
			ariaLabelKey: { bundle: "ash.regions", key: "auxiliarySidebar" },
			viewsAriaLabel: "Auxiliary sidebar views",
			viewsAriaLabelKey: { bundle: "ash.regions", key: "auxiliarySidebarViews" },
			compositeBarVisible: false,
			compositeBarContextMenuProvider: contextMenuService,
			titleActions: { menuService, contextMenuProvider: contextMenuService, menuId: MenuId.AuxiliaryBarTitle },
		}, themeService, storageService, activityService);
		this.contentDomNode.classList.add("ash-auxiliarybar-content");
	}

	override showComposite(compositeId: string, focus = false): void {
		super.showComposite(compositeId, focus);
		const composite = this.getComposite(compositeId);
		this.setTitleProjection(composite?.partTitleProjection);
	}
}
