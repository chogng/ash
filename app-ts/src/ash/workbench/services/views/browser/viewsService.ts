import type { IView } from '../../../common/views.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import { IViewDescriptorService } from '../common/viewDescriptorService.js';
import { IPaneCompositePartService } from '../../panecomposite/browser/panecomposite.js';

/** View identity belongs to descriptors; container activation belongs to the pane-composite service. */
export interface IViewsService {
	openView(viewId: string): Promise<IView | undefined>;
	focusView(viewId: string): Promise<boolean>;
	getViewWithId(viewId: string): IView | undefined;
}

export const IViewsService = createServiceIdentifier<IViewsService>('viewsService');

export class ViewsService implements IViewsService {
	constructor(
		@IViewDescriptorService private readonly descriptors: IViewDescriptorService,
		@IPaneCompositePartService private readonly panes: IPaneCompositePartService,
	) { }

	public async openView(viewId: string): Promise<IView | undefined> {
		const container = this.descriptors.getViewContainerForView(viewId);
		if (!container) { return undefined; }
		const composite = await this.panes.openPaneComposite(container.id, container.location);
		return composite?.openView(viewId);
	}

	public async focusView(viewId: string): Promise<boolean> {
		const view = await this.openView(viewId);
		if (!view) { return false; }
		view.focus();
		return true;
	}

	public getViewWithId(viewId: string): IView | undefined {
		const container = this.descriptors.getViewContainerForView(viewId);
		const active = container && this.panes.getActivePaneComposite(container.location);
		return active?.id === container?.id ? active?.getView(viewId) : undefined;
	}
}
