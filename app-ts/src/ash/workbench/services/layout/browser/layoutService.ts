import type { Event } from "../../../../base/common/event.js";
import type { ISize } from "../../../../base/common/layout.js";
import type { IDimension } from "../../../../base/browser/dom.js";
import { refineServiceDecorator } from "../../../../platform/instantiation/common/instantiation.js";
import { ILayoutService } from "../../../../platform/layout/browser/layoutService.js";
import type { WorkbenchLayoutStyle } from "../../../common/configuration.js";
import type { Direction } from '../../../../base/browser/ui/grid/grid.js';

export const workbenchPartIds = ["titlebar", "statusbar", "activitybar", "sidebar", "auxiliarybar", "agentSidebar", "editor", "panel"] as const;
export type WorkbenchPartId = typeof workbenchPartIds[number];

export interface WorkbenchPartVisibilityChangeEvent {
	readonly partId: WorkbenchPartId;
	readonly visible: boolean;
}

/** Container geometry and Part operations share one window-scoped layout owner. */
export interface IWorkbenchLayoutService extends ILayoutService {
	layout(dimension?: IDimension): void;
	setLayoutStyle(style: WorkbenchLayoutStyle): void;
	readonly onDidChangePartVisibility: Event<WorkbenchPartVisibilityChangeEvent>;
	isPartVisible(partId: WorkbenchPartId): boolean;
	hasFocus(partId: WorkbenchPartId): boolean;
	getVisibleNeighborPart(partId: WorkbenchPartId, direction: Direction): WorkbenchPartId | undefined;
	isPanelMaximized(): boolean;
	/** Shows and maximizes the Panel, or restores the Editor and the previous Panel height. */
	toggleMaximizedPanel(): void;
	showPart(partId: WorkbenchPartId): void;
	showParts(partIds: readonly WorkbenchPartId[]): void;
	hidePart(partId: WorkbenchPartId): void;
	hideParts(partIds: readonly WorkbenchPartId[]): void;
	getPartSize(partId: WorkbenchPartId): ISize;
	resizePart(partId: WorkbenchPartId, dimension: ISize): void;
}

export const IWorkbenchLayoutService = refineServiceDecorator<ILayoutService, IWorkbenchLayoutService>(ILayoutService);
