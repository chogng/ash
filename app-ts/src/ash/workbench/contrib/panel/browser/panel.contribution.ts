import { ServiceConstructionDescriptor } from "../../../../platform/instantiation/common/instantiation.js";
import { IContextMenuService } from "../../../../platform/contextview/browser/contextView.js";
import { IStorageService } from "../../../../platform/storage/common/storage.js";
import { IWorkspaceContextService } from "../../../../platform/workspace/common/workspace.js";
import { IEditorService } from "../../../services/editor/common/editorService.js";
import { IWorkbenchHostService } from "../../../services/host/common/workbenchHostService.js";
import { ViewContainerLocation, type WorkbenchViewRegistry, WorkbenchViewContainerId, ViewsRegistry } from "../../../common/views.js";
import { IOutputService } from "../../../services/output/common/outputService.js";
import { OUTPUT_VIEW_ID } from "../../output/common/output.js";
import { OutputViewPane } from "../../output/browser/outputViewPane.js";
import "../../output/browser/outputActions.js";

/** Registers the fixed Workbench-owned Panel destinations. */
export function registerPanelViews(registry: WorkbenchViewRegistry = ViewsRegistry): void {
	registry.registerStaticViewContainer({ id: WorkbenchViewContainerId.Output, title: "Output", localizationKey: { bundle: "ash.views", key: "output" }, location: ViewContainerLocation.Panel, order: 2 });
	registry.registerStaticViews(WorkbenchViewContainerId.Output, [{ id: OUTPUT_VIEW_ID, title: "Output", localizationKey: { bundle: "ash.views", key: "output" }, order: 1, canToggleVisibility: false, ctorDescriptor: new ServiceConstructionDescriptor(OutputViewPane, { serviceDependencies: [IOutputService, IContextMenuService, IStorageService, IEditorService, IWorkspaceContextService, IWorkbenchHostService] }) }]);
}
