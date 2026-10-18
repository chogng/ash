import { registerWorkbenchContribution, WorkbenchPhase } from '../../../common/contributions.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { registerAction2 } from '../../../../platform/actions/common/actions.js';
import { RunAutomaticTasks, ManageAutomaticTaskRunning } from './runAutomaticTasks.js';
import { SyncDescriptor } from "../../../../platform/instantiation/common/descriptors.js";
import { ViewContainerLocation, type WorkbenchViewRegistry, WorkbenchViewContainerId, ViewsRegistry } from "../../../common/views.js";
import { TASKS_VIEW_ID } from "../common/tasks.js";
import { TasksViewPane } from "./tasksViewPane.js";
import "./taskActions.js";
import "./taskService.js";
import "./media/tasks.css";

/** Contributes the Code task catalog as its own Panel destination. */
export function registerTasksView(registry: WorkbenchViewRegistry = ViewsRegistry): void {
	registry.registerStaticViewContainer({
		id: WorkbenchViewContainerId.Tasks,
		title: "Tasks",
		localizationKey: { bundle: "ash.views", key: "tasks" },
		location: ViewContainerLocation.Panel,
		order: 2.5,
	});
	registry.registerStaticViews(WorkbenchViewContainerId.Tasks, [{
		id: TASKS_VIEW_ID,
		title: "Tasks",
		localizationKey: { bundle: "ash.views", key: "tasks" },
		order: 2,
		canToggleVisibility: false,
		ctorDescriptor: new SyncDescriptor(TasksViewPane),
	}]);
}

registerWorkbenchContribution('workbench.contrib.runAutomaticTasks', WorkbenchPhase.AfterRestored, accessor => accessor.get(IInstantiationService).createInstance(RunAutomaticTasks));
registerAction2(ManageAutomaticTaskRunning);
