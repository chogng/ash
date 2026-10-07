import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import "./media/panelpart.css";
import { IStorageService } from "../../../../platform/storage/common/storage.js";
import { IContextKeyService } from "../../../../platform/contextkey/browser/contextKeyService.js";
import { IContextMenuService } from "../../../../platform/contextview/browser/contextView.js";
import { IMenuService, MenuId } from "../../../../platform/actions/common/actions.js";
import { ViewContainerLocation } from "../../../common/views.js";
import { ILocalizationService } from "../../../services/localization/common/localizationService.js";
import { IViewDescriptorService } from "../../../common/views.js";
import { PaneCompositePart } from "../paneCompositePart.js";
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';

/** Bottom tool region with Panel tabs and a contextual title toolbar. */
export class PanelPart extends PaneCompositePart {
	override get minimumWidth(): number { return 300; }
	override get minimumHeight(): number { return 77; }

	constructor(
		container: HTMLElement,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IStorageService storageService: IStorageService,
		@ILocalizationService localizationService: ILocalizationService,
		@IMenuService menuService: IMenuService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IThemeService themeService: IThemeService,
	) {
		super(container, {
			openComposite: (id, preserveFocus) => instantiationService.invokeFunction(accessor => accessor.get(IViewsService).openViewContainer(id, !preserveFocus)),
			viewDescriptorService,
			contextKeyService,
			localizationService,
			id: "panel",
			location: ViewContainerLocation.Panel,
			ariaLabel: "Panel",
			ariaLabelKey: { bundle: "ash.regions", key: "panel" },
			viewsAriaLabel: "Panel views",
			viewsAriaLabelKey: { bundle: "ash.regions", key: "panelViews" },
			compositeBarPresentation: "label",
			compositeBarContextMenuProvider: contextMenuService,
			titleActions: { menuService, contextMenuProvider: contextMenuService, menuId: MenuId.PanelTitle },
		}, themeService, storageService);
		this.titleDomNode.classList.add("ash-panel-title-control");
	}

	override showComposite(compositeId: string, focus = false): void {
		super.showComposite(compositeId, focus);
		this.setTitleProjection(this.getComposite(compositeId)?.partTitleProjection);
	}
}
