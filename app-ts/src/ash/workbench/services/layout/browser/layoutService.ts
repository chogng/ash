import type { Event } from "../../../../base/common/event.js";
import type { ISize } from "../../../../base/common/layout.js";
import { createServiceIdentifier } from "../../../../platform/instantiation/common/instantiation.js";
import type { WorkbenchPartId, WorkbenchPartVisibilityChangeEvent } from "../common/workbenchLayoutService.js";

export { workbenchPartIds, type WorkbenchPartId, type WorkbenchPartVisibilityChangeEvent } from "../common/workbenchLayoutService.js";

/** Window-scoped Part operations implemented by the Workbench layout owner. */
export interface IWorkbenchLayoutService {
	readonly onDidChangePartVisibility: Event<WorkbenchPartVisibilityChangeEvent>;
	isPartVisible(partId: WorkbenchPartId): boolean;
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

export const IWorkbenchLayoutService = createServiceIdentifier<IWorkbenchLayoutService>("workbenchLayoutService");
