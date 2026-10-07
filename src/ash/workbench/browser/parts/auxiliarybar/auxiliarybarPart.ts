import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import "./auxiliarybarpart.css";
import { IStorageService } from "../../../../platform/storage/common/storage.js";
import type { IContextKeyService } from "../../../../platform/contextkey/browser/contextKeyService.js";
import { ViewContainerLocation } from "../../../common/views.js";
import type { ILocalizationService } from "../../../services/localization/common/localizationService.js";
import type { IViewDescriptorService } from "../../../common/views.js";
import { PaneCompositePart } from "../paneCompositePart.js";
import type { ICompositeBarOptions } from '../compositeBar.js';

/** Construction inputs for the fixed Auxiliary Bar Pane Composite host. */
export interface AuxiliarybarPartOptions {
	readonly openComposite: ICompositeBarOptions['openComposite'];
	readonly viewDescriptorService: IViewDescriptorService;
	readonly contextKeyService?: IContextKeyService;
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
	override get preferredWidth(): number | undefined {
		const active = this.activeCompositeId;
		return active ? Math.max(this.getComposite(active)!.getOptimalWidth(), 300) : undefined;
	}

	constructor(
		container: HTMLElement,
		options: AuxiliarybarPartOptions,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
	) {
		super(container, {
			openComposite: options.openComposite,
			viewDescriptorService: options.viewDescriptorService,
			contextKeyService: options.contextKeyService,
			localizationService: options.localizationService,
			id: "auxiliarybar",
			location: ViewContainerLocation.AuxiliaryBar,
			ariaLabel: "Auxiliary sidebar",
			ariaLabelKey: { bundle: "ash.regions", key: "auxiliarySidebar" },
			viewsAriaLabel: "Auxiliary sidebar views",
			viewsAriaLabelKey: { bundle: "ash.regions", key: "auxiliarySidebarViews" },
			compositeBarVisible: false,
		}, themeService, storageService);
		this.contentDomNode.classList.add("ash-auxiliarybar-content");
	}

	override showComposite(compositeId: string, focus = false): void {
		super.showComposite(compositeId, focus);
		const composite = this.getComposite(compositeId);
		this.setTitleProjection(composite?.partTitleProjection);
	}
}
