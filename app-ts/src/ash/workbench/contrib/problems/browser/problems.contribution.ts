import { ServiceConstructionDescriptor } from "../../../../platform/instantiation/common/instantiation.js";
import { registerWorkbenchContribution, WorkbenchPhase } from "../../../common/contributions.js";
import { ViewContainerLocation, type WorkbenchViewRegistry, WorkbenchViewContainerId, ViewsRegistry } from "../../../common/views.js";
import { IEditorService } from "../../../services/editor/common/editorService.js";
import { IMarkerService } from "../../../../platform/markers/common/markers.js";
import { IStatusbarService } from "../../../services/statusbar/browser/statusbar.js";
import { IViewsService } from "../../../services/views/browser/viewsService.js";
import { ProblemsStatusContribution } from "./problemsStatus.js";
import { ProblemsViewPane } from "./problemsViewPane.js";
import "./media/problems.css";

export const PROBLEMS_VIEW_ID = "ash.problems";

/** Registers the Workbench-owned Problems panel. */
export function registerProblemsView(registry: WorkbenchViewRegistry = ViewsRegistry): void {
	registry.registerStaticViewContainer({
		id: WorkbenchViewContainerId.Problems,
		title: "Problems",
		localizationKey: { bundle: "ash.views", key: "problems" },
		location: ViewContainerLocation.Panel,
		order: 1,
	});
	registry.registerStaticViews(WorkbenchViewContainerId.Problems, [{
		id: PROBLEMS_VIEW_ID,
		title: "Problems",
		localizationKey: { bundle: "ash.views", key: "problems" },
		order: 1,
		canToggleVisibility: false,
		ctorDescriptor: new ServiceConstructionDescriptor(ProblemsViewPane, {
			serviceDependencies: [IMarkerService, IEditorService],
		}),
	}]);
}

registerWorkbenchContribution("workbench.contrib.problemsStatus", WorkbenchPhase.BlockRestore, accessor => new ProblemsStatusContribution({
	statusbarService: accessor.get(IStatusbarService),
	markerService: accessor.get(IMarkerService),
	viewsService: accessor.get(IViewsService),
}));
