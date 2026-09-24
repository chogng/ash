import type {
	IView,
	IViewContainerDescriptor,
} from "../../../common/views.js";
import type {
	ViewPaneContainer,
} from "../../../browser/parts/views/viewPaneContainer.js";
import type {
	IViewDescriptorService,
} from "../common/viewDescriptorService.js";
import {
	createServiceIdentifier,
} from "../../../../platform/instantiation/common/instantiation.js";

/** Opens the host for a registered View Container in the current window. */
export type OpenViewContainer = (
	container: IViewContainerDescriptor,
) => ViewPaneContainer | undefined;

/**
 * Window-scoped operations for revealing registered views.
 *
 * The service resolves contribution identity. Its host callback owns Part
 * visibility and Composite activation for each workbench location.
 */
export interface IViewsService {
	openView(viewId: string): IView | undefined;
	focusView(viewId: string): boolean;
}

export const IViewsService =
	createServiceIdentifier<IViewsService>("viewsService");

export interface ViewsServiceOptions {
	readonly viewDescriptorService: IViewDescriptorService;
	readonly openViewContainer: OpenViewContainer;
}

/** Default browser implementation of the registered-view operations. */
export class ViewsService implements IViewsService {
	private readonly viewDescriptorService: IViewDescriptorService;
	private readonly openViewContainer: OpenViewContainer;

	constructor(options: ViewsServiceOptions) {
		this.viewDescriptorService = options.viewDescriptorService;
		this.openViewContainer = options.openViewContainer;
	}

	openView(viewId: string): IView | undefined {
		const container = this.viewDescriptorService
			.getViewContainerForView(viewId);
		if (!container) return undefined;
		return this.openViewContainer(container)?.openView(viewId);
	}

	focusView(viewId: string): boolean {
		const view = this.openView(viewId);
		if (!view) return false;
		view.focus();
		return true;
	}
}
