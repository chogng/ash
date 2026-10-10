import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import '../../browser/taskActions.js';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IQuickInputService, type IQuickPick, type IQuickPickItem, type IQuickPickSeparator } from '../../../../../platform/quickinput/common/quickInput.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ITaskService, type IWorkspaceTask } from '../../../../services/tasks/common/taskService.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import { RUN_TASK_COMMAND_ID } from '../../common/tasks.js';

interface TaskItem extends IQuickPickItem { readonly task: IWorkspaceTask; }

class Picker extends Disposable implements IQuickPick<TaskItem> {
	readonly accepted = this._register(new Emitter<TaskItem>());
	readonly hidden = this._register(new Emitter<void>());
	readonly onDidAccept = this.accepted.event;
	readonly onDidHide = this.hidden.event;
	readonly onDidChangeValue = Event.None;
	readonly onDidBlur = Event.None;
	readonly onDidTriggerItemButton = Event.None;
	readonly shown = new DeferredPromise<void>();
	items: readonly (TaskItem | IQuickPickSeparator)[] = [];
	ariaLabel = '';
	placeholder = '';
	value = '';
	valueSelection = { start: 0, end: 0 };
	filterValue = (value: string) => value;
	show(): void { void this.shown.complete(); }
	hide(): void { this.hidden.fire(); }
}

suite('Tasks command catalog and async service lifetime', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	for (const failure of [false, true]) {
		test(`Run Task uses the latest open picker catalog and ${failure ? 'reports failure' : 'leaves presentation to the execution owner'} after command invocation ends`, async () => {
			using changes = new Emitter<readonly IWorkspaceTask[]>();
			using picker = new Picker();
			using services = new InstantiationService();
			const previous: IWorkspaceTask = { id: 'old', label: 'Old task', command: 'old', source: 'vscode', group: 'other' };
			const latest: IWorkspaceTask = { ...previous, id: 'new', label: 'Updated task', command: 'updated' };
			let catalog: readonly IWorkspaceTask[] = [previous];
			const executed: IWorkspaceTask[] = [];
			const focused: string[] = [];
			const errors: string[] = [];
			const tasks: ITaskService = {
				rerun: async () => undefined,
				get tasks() { return catalog; }, activeRuns: [], lastRun: undefined,
				onDidChangeTasks: changes.event, onDidStartTask: Event.None, onDidChangeTaskRun: Event.None,
				registerTaskProvider: () => Disposable.None,
				registerTaskProviders: () => ({ dispose() { }, [Symbol.dispose]() { }, replace() { } }),
				refresh: async () => catalog,
				run: async task => {
					executed.push(task);
					if (failure) throw new Error('Unsupported execution setting');
					return { task, terminalId: 'terminal', status: 'running', exitCode: undefined, onDidChangeStatus: Event.None };
				},
				runProvidedTask: async () => { throw new Error('Provided task execution is not expected in this fixture'); },
				terminate: async () => { }, dispose() { }, [Symbol.dispose]() { },
			};
			services.registerInstance(ITaskService, tasks);
			services.registerInstance(IQuickInputService, { createQuickPick: () => picker, input: async () => undefined } as unknown as IQuickInputService);
			services.registerInstance(IViewsService, { focusView: async (id: string) => { focused.push(id); return true; } } as IViewsService);
			services.registerInstance(INotificationService, { error: (message: string) => { errors.push(message); } } as INotificationService);
			try {
				services.invokeFunction(CommandsRegistry.getCommand(RUN_TASK_COMMAND_ID)!);
				await picker.shown.p;
				catalog = [latest];
				changes.fire(catalog);
				assert.deepEqual(picker.items.map(item => item.label), ['Updated task']);
				picker.accepted.fire(picker.items[0] as TaskItem);
				await new Promise<void>(resolve => setImmediate(resolve));
				assert.deepEqual({ executed, focused, errors }, { executed: [latest], focused: [], errors: failure ? ['Unsupported execution setting'] : [] });
				changes.fire([previous]);
				assert.deepEqual(picker.items.map(item => item.label), ['Updated task']);
			} finally { picker.hide(); }
		});
	}
});
