import type { Event } from '../../../../base/common/event.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import type { IPaneComposite } from '../../../common/panecomposite.js';
import type { IView, IViewContainerDescriptor, IViewDescriptor, IViewPaneContainer, ViewContainerLocation } from '../../../common/views.js';

/** Window-scoped access to registered views and their retained container instances. */
export interface IViewsService {
	readonly onDidChangeViewContainerVisibility: Event<{ id: string; visible: boolean; location: ViewContainerLocation; }>;
	readonly onDidChangeViewVisibility: Event<{ id: string; visible: boolean; }>;
	readonly onDidChangeFocusedView: Event<void>;

	isViewContainerVisible(id: string): boolean;
	isViewContainerActive(id: string): boolean;
	openViewContainer(id: string, focus?: boolean): Promise<IPaneComposite | null>;
	closeViewContainer(id: string): void;
	getVisibleViewContainer(location: ViewContainerLocation): IViewContainerDescriptor | null;
	getActiveViewPaneContainerWithId(id: string): IViewPaneContainer | null;
	getFocusedView(): IViewDescriptor | null;
	getFocusedViewName(): string;

	isViewVisible(id: string): boolean;
	openView<T extends IView>(id: string, focus?: boolean): Promise<T | null>;
	closeView(id: string): void;
	getActiveViewWithId<T extends IView>(id: string): T | null;
	getViewWithId<T extends IView>(id: string): T | null;
	focusView(id: string): Promise<boolean>;
}

export const IViewsService = createServiceIdentifier<IViewsService>('viewsService');
