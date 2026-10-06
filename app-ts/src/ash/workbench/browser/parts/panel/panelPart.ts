import "./media/panelpart.css";
import { IStorageService } from "../../../../platform/storage/common/storage.js";
import { IContextKeyService } from "../../../../platform/contextkey/browser/contextKeyService.js";
import { IContextMenuService } from "../../../../platform/contextview/browser/contextView.js";
import { IMenuService, MenuId } from "../../../../platform/actions/common/actions.js";
import { ViewContainerLocation } from "../../../common/views.js";
import { ILocalizationService } from "../../../services/localization/common/localizationService.js";
import { IViewDescriptorService } from "../../../common/views.js";
import { PaneCompositePart } from "../paneCompositePart.js";

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
	) {
		super(container, {
			viewDescriptorService,
			contextKeyService,
			storageService,
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
		});
		this.titleDomNode.classList.add("ash-panel-title-control");
	}

	override showComposite(compositeId: string): void {
		super.showComposite(compositeId);
		this.setTitleProjection(this.getComposite(compositeId)?.partTitleProjection);
	}
}
