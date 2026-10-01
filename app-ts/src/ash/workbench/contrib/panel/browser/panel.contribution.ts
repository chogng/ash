import { SyncDescriptor } from "../../../../platform/instantiation/common/descriptors.js";
import { ViewContainerLocation, type WorkbenchViewRegistry, WorkbenchViewContainerId, ViewsRegistry } from "../../../common/views.js";
import { OUTPUT_VIEW_ID } from "../../output/common/output.js";
import { OutputViewPane } from "../../output/browser/outputViewPane.js";
import "../../output/browser/outputActions.js";

/** Registers the fixed Workbench-owned Panel destinations. */
export function registerPanelViews(registry: WorkbenchViewRegistry = ViewsRegistry): void {
	registry.registerStaticViewContainer({ id: WorkbenchViewContainerId.Output, title: "Output", localizationKey: { bundle: "ash.views", key: "output" }, location: ViewContainerLocation.Panel, order: 2 });
	registry.registerStaticViews(WorkbenchViewContainerId.Output, [{ id: OUTPUT_VIEW_ID, title: "Output", localizationKey: { bundle: "ash.views", key: "output" }, order: 1, canToggleVisibility: false, ctorDescriptor: new SyncDescriptor(OutputViewPane) }]);
}
