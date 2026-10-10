import { AppServerAvailableContext } from '../../../common/contextkeys.js';
import { match } from '../../../../base/common/glob.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { getErrorMessage, isCancellationError } from '../../../../base/common/errors.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { localize, localize2 } from '../../../../nls.js';
import { DisposableStore } from "../../../../base/common/lifecycle.js";
import { Keybinding, logicalKey } from "../../../../base/common/keybindings.js";
import { Action2, MenuId, MenusRegistry, registerAction2 } from "../../../../platform/actions/common/actions.js";
import { type ServicesAccessor } from "../../../../platform/instantiation/common/instantiation.js";
import { IQuickInputService, type IQuickPickItem } from "../../../../platform/quickinput/common/quickInput.js";
import { ITaskService, type ITaskRun, type IWorkspaceTask } from "../../../services/tasks/common/taskService.js";
import { IViewsService } from "../../../services/views/common/viewsService.js";
import { RERUN_LAST_TASK_COMMAND_ID, RUN_BUILD_TASK_COMMAND_ID, RUN_TEST_TASK_COMMAND_ID, RUN_TASK_COMMAND_ID, TASKS_VIEW_ID, TERMINATE_TASK_COMMAND_ID } from "../common/tasks.js";

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
		runTaskCommand(accessor);
	}
});

registerAction2(class RunBuildTaskAction extends Action2 {
	constructor() {
		super({ id: RUN_BUILD_TASK_COMMAND_ID, title: localize2('command.RunBuildTaskAction', 'Run Build Task'), f1: true, precondition: AppServerAvailableContext.isEqualTo(true), keybinding: { primary: Keybinding.single(logicalKey('b', { primaryKey: true, shiftKey: true })) } });
	}
	override run(accessor: ServicesAccessor): void { runTaskCommand(accessor, 'build'); }
});

registerAction2(class RunTestTaskAction extends Action2 {
	constructor() {
		super({ id: RUN_TEST_TASK_COMMAND_ID, title: localize2('command.RunTestTaskAction', 'Run Test Task'), f1: true, precondition: AppServerAvailableContext.isEqualTo(true) });
	}
	override run(accessor: ServicesAccessor): void { runTaskCommand(accessor, 'test'); }
});

function runTaskCommand(accessor: ServicesAccessor, group?: 'build' | 'test'): void {
	// Capture dependencies before the command accessor's synchronous lifetime ends.
	const tasks = accessor.get(ITaskService);
	const quickInput = accessor.get(IQuickInputService);
	const views = accessor.get(IViewsService);
	const notifications = accessor.get(INotificationService);
	const editors = group ? accessor.get(IEditorService) : undefined;
	const workspace = group ? accessor.get(IWorkspaceContextService) : undefined;
	const candidates = (catalog: readonly IWorkspaceTask[]): { tasks: readonly IWorkspaceTask[]; isDefault: boolean; } => {
		if (!group) return { tasks: catalog, isDefault: false };
		const grouped = catalog.filter(task => task.group === group);
		const resource = editors!.activeEditor?.resource;
		const folder = resource && workspace!.getWorkspaceFolder(resource);
		if (folder && resource) {
			const relative = resource.path.slice(folder.uri.path.replace(/\/+$/, '').length + 1).toLowerCase();
			const matching = grouped.filter(task => typeof task.groupIsDefault === 'string' && match(task.groupIsDefault.toLowerCase(), relative));
			if (matching.length) return { tasks: matching, isDefault: true };
		}
		const defaults = grouped.filter(task => task.groupIsDefault === true);
		return { tasks: defaults.length ? defaults : grouped, isDefault: defaults.length > 0 };
	};
	const run = (task: IWorkspaceTask): Promise<unknown> => tasks.run(task);
	void tasks.refresh().then(() => {
		const selection = candidates(tasks.tasks);
		const available = selection.tasks;
		if (selection.isDefault && available.length === 1) return run(available[0]!);
		if (available.length === 0) {
			if (group) notifications.info(group === 'build' ? localize('tasks.noBuildTask', 'No build task is available.') : localize('tasks.noTestTask', 'No test task is available.'));
			return views.focusView(TASKS_VIEW_ID);
		}
		const disposables = new DisposableStore();
		const picker = disposables.add(quickInput.createQuickPick<TaskQuickPickItem>());
		picker.placeholder = group === 'build' ? localize('tasks.selectBuildTask', 'Select the build task to run') : group === 'test' ? localize('tasks.selectTestTask', 'Select the test task to run') : localize('tasks.selectTask', 'Select a task to run');
		picker.ariaLabel = picker.placeholder;
		const updateItems = (catalog: readonly IWorkspaceTask[]): void => {
			picker.items = candidates(catalog).tasks.map(task => ({ task, label: task.label, description: task.source, detail: task.detail ?? task.command }));
		};
		// An open picker follows catalog changes without turning a refresh into execution.
		disposables.add(tasks.onDidChangeTasks(updateItems));
		updateItems(tasks.tasks);
		disposables.add(picker.onDidAccept(item => { picker.hide(); void run(item.task).catch(error => reportTaskError(notifications, error)); }));
		disposables.add(picker.onDidHide(() => disposables.dispose()));
		picker.show();
	}).catch(error => reportTaskError(notifications, error));
}

registerAction2(class RerunLastTaskAction extends Action2 {
	constructor() {
		super({ id: RERUN_LAST_TASK_COMMAND_ID, title: localize2({ bundle: 'ash.workbench', key: 'command.RerunLastTaskAction' }, "Rerun Last Task"), f1: true, precondition: AppServerAvailableContext.isEqualTo(true), menu: { id: MenuId.MenubarRunMenu, group: "2_tasks", order: 2 } });
	}

	override run(accessor: ServicesAccessor): void {
		const tasks = accessor.get(ITaskService);
		const notifications = accessor.get(INotificationService);
		const last = tasks.lastRun;
		if (!last) return;
		void tasks.rerun(last.terminalId).catch(error => reportTaskError(notifications, error));
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
	if (isCancellationError(error)) return;
	notifications.error(getErrorMessage(error));
}
