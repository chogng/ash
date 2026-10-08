import { AppServerAvailableContext } from '../../../common/contextkeys.js';
import { getErrorMessage } from '../../../../base/common/errors.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { localize2 } from '../../../../nls.js';
import { DisposableStore } from "../../../../base/common/lifecycle.js";
import { Keybinding, logicalKey } from "../../../../base/common/keybindings.js";
import { Action2, MenuId, MenusRegistry, registerAction2 } from "../../../../platform/actions/common/actions.js";
import { type ServicesAccessor } from "../../../../platform/instantiation/common/instantiation.js";
import { IQuickInputService, type IQuickPickItem } from "../../../../platform/quickinput/common/quickInput.js";
import { ITaskService, type ITaskRun, type IWorkspaceTask } from "../../../services/tasks/common/taskService.js";
import { IViewsService } from "../../../services/views/common/viewsService.js";
import { TERMINAL_VIEW_ID } from "../../terminal/common/terminal.js";
import { RERUN_LAST_TASK_COMMAND_ID, RUN_TASK_COMMAND_ID, TASKS_VIEW_ID, TERMINATE_TASK_COMMAND_ID } from "../common/tasks.js";

interface TaskQuickPickItem extends IQuickPickItem {
	readonly task: IWorkspaceTask;
}

interface TaskRunQuickPickItem extends IQuickPickItem {
	readonly run: ITaskRun;
}

MenusRegistry.appendMenuItem(MenuId.GlobalActivity, {
	command: { id: RUN_TASK_COMMAND_ID, title: localize2({ bundle: "ash", key: "workbench.manageRunTask" }, "Run Task...") },
	group: "2_configuration",
	order: 6, when: AppServerAvailableContext.isEqualTo(true),
});

registerAction2(class RunTaskAction extends Action2 {
	constructor() {
		super({
			id: RUN_TASK_COMMAND_ID,
			title: localize2({ bundle: 'ash.workbench', key: 'command.RunTaskAction' }, "Run Task"),
			f1: true, precondition: AppServerAvailableContext.isEqualTo(true),
			menu: { id: MenuId.MenubarRunMenu, group: "2_tasks", order: 1 },
			keybinding: { primary: Keybinding.chord(logicalKey("k", { primaryKey: true }), logicalKey("t", { primaryKey: true })) },
		});
	}

	override run(accessor: ServicesAccessor): void {
		const tasks = accessor.get(ITaskService);
		const quickInput = accessor.get(IQuickInputService);
		const views = accessor.get(IViewsService);
		// Async continuations retain services because the command accessor ends with this invocation.
		const notifications = accessor.get(INotificationService);
		void tasks.refresh().then(() => {
			const available = tasks.tasks;
			if (available.length === 0) {
				return views.focusView(TASKS_VIEW_ID);
			}
			const picker = quickInput.createQuickPick<TaskQuickPickItem>();
			const disposables = new DisposableStore();
			disposables.add(picker);
			picker.placeholder = "Select a task to run";
			const updateItems = (catalog: readonly IWorkspaceTask[]) => {
				picker.items = catalog.map(task => ({ task, label: task.label, description: task.source, detail: task.detail ?? task.command }));
			};
			// File watchers and providers can supersede refresh while this picker stays open.
			disposables.add(tasks.onDidChangeTasks(updateItems));
			updateItems(available);
			disposables.add(picker.onDidAccept(item => {
				picker.hide();
				void tasks.run(item.task).then(() => views.focusView(TERMINAL_VIEW_ID)).catch(error => reportTaskError(notifications, error));
			}));
			disposables.add(picker.onDidHide(() => disposables.dispose()));
			picker.show();
		}).catch(error => reportTaskError(notifications, error));
	}
});

registerAction2(class RerunLastTaskAction extends Action2 {
	constructor() {
		super({ id: RERUN_LAST_TASK_COMMAND_ID, title: localize2({ bundle: 'ash.workbench', key: 'command.RerunLastTaskAction' }, "Rerun Last Task"), f1: true, precondition: AppServerAvailableContext.isEqualTo(true), menu: { id: MenuId.MenubarRunMenu, group: "2_tasks", order: 2 } });
	}

	override run(accessor: ServicesAccessor): void {
		const tasks = accessor.get(ITaskService);
		const views = accessor.get(IViewsService);
		const notifications = accessor.get(INotificationService);
		const last = tasks.lastRun;
		if (!last) return;
		void tasks.refresh().then(current => {
			const task = current.find(candidate => candidate.id === last.task.id);
			if (task) return tasks.run(task);
		}).then(run => {
			if (run) return views.focusView(TERMINAL_VIEW_ID);
		}).catch(error => reportTaskError(notifications, error));
	}
});

registerAction2(class TerminateTaskAction extends Action2 {
	constructor() {
		super({ id: TERMINATE_TASK_COMMAND_ID, title: localize2({ bundle: 'ash.workbench', key: 'command.TerminateTaskAction' }, "Terminate Task"), f1: true, precondition: AppServerAvailableContext.isEqualTo(true), menu: { id: MenuId.MenubarRunMenu, group: "2_tasks", order: 3 } });
	}

	override run(accessor: ServicesAccessor): void {
		const tasks = accessor.get(ITaskService);
		const notifications = accessor.get(INotificationService);
		if (tasks.activeRuns.length === 0) return;
		if (tasks.activeRuns.length === 1) {
			void tasks.terminate(tasks.activeRuns[0]!).catch(error => reportTaskError(notifications, error));
			return;
		}
		const picker = accessor.get(IQuickInputService).createQuickPick<TaskRunQuickPickItem>();
		const disposables = new DisposableStore();
		disposables.add(picker);
		picker.placeholder = "Select a running task to terminate";
		picker.items = tasks.activeRuns.map(run => ({ run, label: run.task.label, description: run.task.source, detail: run.task.command }));
		disposables.add(picker.onDidAccept(item => { picker.hide(); void tasks.terminate(item.run).catch(error => reportTaskError(notifications, error)); }));
		disposables.add(picker.onDidHide(() => disposables.dispose()));
		picker.show();
	}
});

function reportTaskError(notifications: INotificationService, error: unknown): void {
	notifications.error(getErrorMessage(error));
}
