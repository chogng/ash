import { DisposableStore } from "../../../../base/common/lifecycle.js";
import { Keybinding, logicalKey } from "../../../../base/common/keybindings.js";
import { Action2, MenuId, registerAction2 } from "../../../../platform/actions/common/actions.js";
import { type ServicesAccessor } from "../../../../platform/instantiation/common/instantiation.js";
import { IQuickInputService, type IQuickPickItem } from "../../../../platform/quickinput/common/quickInput.js";
import { ITaskService, type ITaskRun, type IWorkspaceTask } from "../../../services/tasks/common/taskService.js";
import { IViewsService } from "../../../services/views/browser/viewsService.js";
import { TERMINAL_VIEW_ID } from "../../terminal/common/terminal.js";
import { RERUN_LAST_TASK_COMMAND_ID, RUN_TASK_COMMAND_ID, TASKS_VIEW_ID, TERMINATE_TASK_COMMAND_ID } from "../common/tasks.js";

interface TaskQuickPickItem extends IQuickPickItem {
	readonly task: IWorkspaceTask;
}

interface TaskRunQuickPickItem extends IQuickPickItem {
	readonly run: ITaskRun;
}

registerAction2(class RunTaskAction extends Action2 {
	constructor() {
		super({
			id: RUN_TASK_COMMAND_ID,
			title: "Run Task",
			f1: true,
			menu: { id: MenuId.MenubarRunMenu, group: "2_tasks", order: 1 },
			keybinding: { primary: Keybinding.chord(logicalKey("k", { primaryKey: true }), logicalKey("t", { primaryKey: true })) },
		});
	}

	override run(accessor: ServicesAccessor): void {
		const tasks = accessor.get(ITaskService);
		const quickInput = accessor.get(IQuickInputService);
		const views = accessor.get(IViewsService);
		void tasks.refresh().then(available => {
			if (available.length === 0) {
				views.focusView(TASKS_VIEW_ID);
				return;
			}
			const picker = quickInput.createQuickPick<TaskQuickPickItem>();
			const disposables = new DisposableStore();
			disposables.add(picker);
			picker.placeholder = "Select a task to run";
			picker.items = available.map(task => ({ task, label: task.label, description: task.source, detail: task.detail ?? task.command }));
			disposables.add(picker.onDidAccept(item => {
				picker.hide();
				void tasks.run(item.task).then(() => views.focusView(TERMINAL_VIEW_ID)).catch(reportTaskError);
			}));
			disposables.add(picker.onDidHide(() => disposables.dispose()));
			picker.show();
		}).catch(reportTaskError);
	}
});

registerAction2(class RerunLastTaskAction extends Action2 {
	constructor() {
		super({ id: RERUN_LAST_TASK_COMMAND_ID, title: "Rerun Last Task", f1: true, menu: { id: MenuId.MenubarRunMenu, group: "2_tasks", order: 2 } });
	}

	override run(accessor: ServicesAccessor): void {
		const tasks = accessor.get(ITaskService);
		const last = tasks.lastRun;
		if (!last) return;
		void tasks.refresh().then(current => {
			const task = current.find(candidate => candidate.id === last.task.id);
			if (task) return tasks.run(task);
		}).then(run => {
			if (run) accessor.get(IViewsService).focusView(TERMINAL_VIEW_ID);
		}).catch(reportTaskError);
	}
});

registerAction2(class TerminateTaskAction extends Action2 {
	constructor() {
		super({ id: TERMINATE_TASK_COMMAND_ID, title: "Terminate Task", f1: true, menu: { id: MenuId.MenubarRunMenu, group: "2_tasks", order: 3 } });
	}

	override run(accessor: ServicesAccessor): void {
		const tasks = accessor.get(ITaskService);
		if (tasks.activeRuns.length === 0) return;
		if (tasks.activeRuns.length === 1) {
			void tasks.terminate(tasks.activeRuns[0]!).catch(reportTaskError);
			return;
		}
		const picker = accessor.get(IQuickInputService).createQuickPick<TaskRunQuickPickItem>();
		const disposables = new DisposableStore();
		disposables.add(picker);
		picker.placeholder = "Select a running task to terminate";
		picker.items = tasks.activeRuns.map(run => ({ run, label: run.task.label, description: run.task.source, detail: run.task.command }));
		disposables.add(picker.onDidAccept(item => { picker.hide(); void tasks.terminate(item.run).catch(reportTaskError); }));
		disposables.add(picker.onDidHide(() => disposables.dispose()));
		picker.show();
	}
});

function reportTaskError(error: unknown): void {
	console.error("Task command failed", error);
}
