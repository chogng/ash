import { quickInputServiceTestControls } from '../../../../../platform/quickinput/test/browser/testQuickInputService.js';
import { QuickInputType, type IQuickPickDidAcceptEvent } from '../../../../../platform/quickinput/common/quickInput.js';
import { Event as QuickPickTestEvent } from '../../../../../base/common/event.js';
import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import '../../browser/taskActions.js';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IQuickInputService, type IQuickPick, type IQuickPickItem, type IQuickPickSeparator } from '../../../../../platform/quickinput/common/quickInput.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ITaskService, type IWorkspaceTask } from '../../../../services/tasks/common/taskService.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { WorkspaceContextService } from '../../../../services/workspaces/browser/workspaceContextService.js';
import { RUN_BUILD_TASK_COMMAND_ID, RUN_TASK_COMMAND_ID, RUN_TEST_TASK_COMMAND_ID } from '../../common/tasks.js';

interface TaskItem extends IQuickPickItem { readonly task: IWorkspaceTask; }

class Picker extends Disposable implements IQuickPick<TaskItem> {
	readonly type = QuickInputType.QuickPick;
	activeItems: readonly TaskItem[] = [];
	focus(): void { }
	toggle(): void { }
	accept(inBackground = false): void { this.selectedItems = this.activeItems; this.accepted.fire({ inBackground }); }

	canSelectMany = false;
	selectedItems: readonly TaskItem[] = [];
	readonly onDidChangeSelection = QuickPickTestEvent.None;
	sortByLabel = true;
	readonly accepted = this._register(new Emitter<IQuickPickDidAcceptEvent>());
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

	for (const group of ['build', 'test'] as const) {
		for (const currentDefault of [true, '**/*.ts']) {
			test(`${group} matches default globs only in the active folder with fallback ${currentDefault}`, async () => {
				using services = new InstantiationService();
				using picker = new Picker();
				const firstFolder = { id: 'a', uri: URI.file('/workspace/a'), name: 'A', index: 0 };
				const activeFolder = { id: 'b', uri: URI.file('/workspace/b'), name: 'B', index: 1 };
				using workspace = new WorkspaceContextService({ id: 'workspace', folders: [firstFolder, activeFolder] });
				const catalog: readonly IWorkspaceTask[] = [
					{ id: 'a:task', label: 'Task A', command: 'command-a', source: 'vscode', group, dirId: 'a', groupIsDefault: '**/*.ts' },
					{ id: 'b:task', label: 'Task B', command: 'command-b', source: 'vscode', group, dirId: 'b', groupIsDefault: currentDefault },
				];
				const executed: string[] = [];
				const completed = new DeferredPromise<void>();
				services.registerInstance(ITaskService, {
					tasks: catalog, refresh: async () => catalog, onDidChangeTasks: Event.None,
					run: async (task: IWorkspaceTask) => { executed.push(task.id); void completed.complete(undefined); },
				} as unknown as ITaskService);
				services.registerInstance(IQuickInputService, { createQuickPick: () => { void completed.error(new Error('A unique default must run directly')); return picker; } } as unknown as IQuickInputService);
				services.registerInstance(IViewsService, { focusView: async () => { void completed.error(new Error('The selected group has a task')); return false; } } as unknown as IViewsService);
				services.registerInstance(INotificationService, { error: (message: string) => { void completed.error(new Error(message)); } } as unknown as INotificationService);
				services.registerInstance(IWorkspaceContextService, workspace);
				services.registerInstance(IEditorService, { activeEditor: { resource: URI.file('/workspace/b/src/index.ts') } } as IEditorService);
				services.invokeFunction(CommandsRegistry.getCommand(group === 'build' ? RUN_BUILD_TASK_COMMAND_ID : RUN_TEST_TASK_COMMAND_ID)!);
				try {
					await completed.p;
					assert.deepEqual(executed, ['b:task']);
				} finally { picker.hide(); }
			});
		}
	}

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
				get tasks() { return catalog; }, runs: [], start: () => { throw new Error('Not used'); }, describe: async () => { throw new Error('Not used'); }, getRun: () => undefined, activeRuns: [], lastRun: undefined,
				onDidChangeTasks: changes.event, onDidStartTask: Event.None, onDidChangeTaskRun: Event.None,
				registerTaskProvider: () => Disposable.None,
				registerTaskProviders: () => ({ dispose() { }, [Symbol.dispose]() { }, replace() { } }),
				refresh: async () => catalog,
				run: async task => {
					executed.push(task);
					if (failure) throw new Error('Unsupported execution setting');
					return { task, runId: 'fixture-run', readOutput: (cursor: number) => ({ text: '', cursor, nextCursor: cursor, truncated: false, hasMore: false }), terminalId: 'terminal', status: 'running', exitCode: undefined, onDidChangeStatus: Event.None };
				},
				runProvidedTask: async () => { throw new Error('Provided task execution is not expected in this fixture'); },
				terminate: async () => { }, dispose() { }, [Symbol.dispose]() { },
			};
			services.registerInstance(ITaskService, tasks);
			services.registerInstance(IQuickInputService, {
				...quickInputServiceTestControls,
				createQuickPick: () => picker, input: async () => undefined
			} as unknown as IQuickInputService);
			services.registerInstance(IViewsService, { focusView: async (id: string) => { focused.push(id); return true; } } as IViewsService);
			services.registerInstance(INotificationService, { error: (message: string) => { errors.push(message); } } as INotificationService);
			try {
				services.invokeFunction(CommandsRegistry.getCommand(RUN_TASK_COMMAND_ID)!);
				await picker.shown.p;
				catalog = [latest];
				changes.fire(catalog);
				assert.deepEqual(picker.items.map(item => item.label), ['Updated task']);
				picker.selectedItems = [picker.items[0] as TaskItem];
				picker.accepted.fire({ inBackground: false });
				await new Promise<void>(resolve => setImmediate(resolve));
				assert.deepEqual({ executed, focused, errors }, { executed: [latest], focused: [], errors: failure ? ['Unsupported execution setting'] : [] });
				changes.fire([previous]);
				assert.deepEqual(picker.items.map(item => item.label), ['Updated task']);
			} finally { picker.hide(); }
		});
	}
});
