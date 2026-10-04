import type { Event } from '../../../../base/common/event.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import type { PaneComposite } from '../../../browser/parts/views/paneComposite.js';
import type { ViewContainerLocation } from '../../../common/views.js';
import type { WorkbenchPartId } from '../../layout/browser/layoutService.js';

export interface PaneCompositeEvent {
	readonly composite: PaneComposite;
	readonly viewContainerLocation: ViewContainerLocation;
}

/** Window-scoped operations for the Parts that retain registered view containers. */
export interface IPaneCompositePartService {
	readonly onDidPaneCompositeOpen: Event<PaneCompositeEvent>;
	readonly onDidPaneCompositeClose: Event<PaneCompositeEvent>;
	openPaneComposite(id: string | undefined, viewContainerLocation: ViewContainerLocation, focus?: boolean): Promise<PaneComposite | undefined>;
	getActivePaneComposite(viewContainerLocation: ViewContainerLocation): PaneComposite | undefined;
	getPartId(viewContainerLocation: ViewContainerLocation): WorkbenchPartId;
	hideActivePaneComposite(viewContainerLocation: ViewContainerLocation): void;
	getLastActivePaneCompositeId(viewContainerLocation: ViewContainerLocation): string | undefined;
}

export const IPaneCompositePartService = createServiceIdentifier<IPaneCompositePartService>('paneCompositePartService');
