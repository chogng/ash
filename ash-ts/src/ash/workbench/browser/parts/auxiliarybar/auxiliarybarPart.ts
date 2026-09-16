import "./auxiliarybarpart.css";
import type { IStorageService } from "../../../../platform/storage/common/storage.js";
import type { IContextKeyService } from "../../../../platform/contextkey/browser/contextKeyService.js";
import { ViewContainerLocation } from "../../../common/views.js";
import type { ILocalizationService } from "../../../services/localization/common/localizationService.js";
import type { IViewDescriptorService } from "../../../services/views/common/viewDescriptorService.js";
import { PaneCompositePart } from "../paneCompositePart.js";

/** Construction inputs for the fixed Auxiliary Bar Pane Composite host. */
export interface AuxiliarybarPartOptions {
	readonly viewDescriptorService: IViewDescriptorService;
	readonly contextKeyService?: IContextKeyService;
	readonly storageService?: IStorageService;
	readonly localizationService?: ILocalizationService;
}

/**
 * Secondary Pane Composite region.
 *
 * Its fixed Chat container still owns session navigation, while this Part
 * owns the retained Composite lifecycle shared by all pane-like regions.
 */
export class AuxiliarybarPart extends PaneCompositePart {

	override get minimumWidth(): number { return 180; }
	override get maximumWidth(): number { return 600; }

	constructor(container: HTMLElement, options: AuxiliarybarPartOptions) {
		super(container, {
			viewDescriptorService: options.viewDescriptorService,
			contextKeyService: options.contextKeyService,
			storageService: options.storageService,
			localizationService: options.localizationService,
			id: "auxiliarybar",
			location: ViewContainerLocation.AuxiliaryBar,
			ariaLabel: "Auxiliary sidebar",
			ariaLabelKey: { bundle: "ash.regions", key: "auxiliarySidebar" },
			viewsAriaLabel: "Auxiliary sidebar views",
			viewsAriaLabelKey: { bundle: "ash.regions", key: "auxiliarySidebarViews" },
			compositeBarVisible: false,
		});
		this.contentDomNode.classList.add("ash-auxiliarybar-content");
	}

	override showComposite(compositeId: string): void {
		super.showComposite(compositeId);
		const composite = this.getComposite(compositeId);
		this.setTitleProjection(composite?.partTitleProjection);
	}
}
