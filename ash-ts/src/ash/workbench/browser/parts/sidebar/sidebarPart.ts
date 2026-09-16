import "./sidebarpart.css";
import { ViewContainerLocation, type IViewContainerDescriptor } from "../../../common/views.js";
import type { IStorageService } from "../../../../platform/storage/common/storage.js";
import type { IContextKeyService } from "../../../../platform/contextkey/browser/contextKeyService.js";
import type { ILocalizationService, LocalizationKey } from "../../../services/localization/common/localizationService.js";
import type { IViewDescriptorService } from "../../../services/views/common/viewDescriptorService.js";
import { PaneCompositePart, type PaneCompositeTitleActions } from "../paneCompositePart.js";

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
	readonly titleActions?: PaneCompositeTitleActions;
}

/** Reusable Pane Composite Part presented at the side of the Workbench. */
export class SidebarPart extends PaneCompositePart {
	override get minimumWidth(): number { return 180; }
	override get maximumWidth(): number { return 600; }

	constructor(container: HTMLElement, options: SidebarPartOptions) {
		super(container, {
			viewDescriptorService: options.viewDescriptorService,
			contextKeyService: options.contextKeyService,
			storageService: options.storageService,
			localizationService: options.localizationService,
			id: options.id ?? "sidebar",
			location: options.location ?? ViewContainerLocation.Sidebar,
			ariaLabel: options.ariaLabel ?? "Primary sidebar",
			ariaLabelKey: options.ariaLabelKey,
			viewsAriaLabel: options.viewsAriaLabel ?? "Primary side bar views",
			viewsAriaLabelKey: options.viewsAriaLabelKey,
			compositeBarContainerFilter: options.compositeBarContainerFilter,
			compositeBarVisible: options.compositeBarVisible,
			titleActions: options.titleActions,
		});
		this.domNode.classList.add("ash-sidebar-part");
	}
}
