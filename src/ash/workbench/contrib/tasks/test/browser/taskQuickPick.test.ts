import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { Emitter } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import type { ITaskService } from '../../common/taskService.js';
import type { IWorkspaceTask } from '../../common/tasks.js';
import { TaskQuickPick, type ITaskQuickPickEntry } from '../../browser/taskQuickPick.js';

class Picker extends Disposable {
	readonly accepted = this._register(new Emitter<void>());
	readonly hidden = this._register(new Emitter<void>());
	readonly onDidAccept = this.accepted.event;
	readonly onDidHide = this.hidden.event;
	items: readonly ITaskQuickPickEntry[] = [];
	selectedItems: readonly ITaskQuickPickEntry[] = [];
	placeholder = '';
	ariaLabel = '';
	show(): void { }
	hide(): void { this.hidden.fire(); }
}

suite('TaskQuickPick', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	const task: IWorkspaceTask = { id: 'build', label: 'Build', command: 'build', source: 'vscode', group: 'build' };

	test('follows catalog updates, rejects a removed selection and returns the current task', async () => {
		using changes = new Emitter<readonly IWorkspaceTask[]>();
		using picker = new Picker();
		let catalog = [task];
		const tasks = { get tasks() { return catalog; }, onDidChangeTasks: changes.event } as unknown as ITaskService;
		using controller = new TaskQuickPick(tasks => tasks, tasks, { createQuickPick: () => picker } as unknown as IQuickInputService);
		const result = controller.show('Select task');
		const removed = picker.items[0]!;
		const replacement = { ...task, id: 'check', label: 'Check', command: 'check' };
		catalog = [replacement];
		changes.fire(catalog);
		assert.equal(picker.ariaLabel, 'Select task');
		assert.deepEqual(picker.items.map(item => item.label), ['Check']);
		picker.selectedItems = [removed];
		picker.accepted.fire();
		assert.equal(picker.isDisposed, false);
		picker.selectedItems = [picker.items[0]!];
		picker.accepted.fire();
		assert.equal(await result, replacement);
		assert.equal(picker.isDisposed, true);
		catalog = [];
		changes.fire(catalog);
		assert.deepEqual(picker.items.map(item => item.label), ['Check']);
	});

	for (const action of ['cancel', 'dispose', 'template'] as const) {
		test(`${action} settles selection and releases its listeners`, async () => {
			using changes = new Emitter<readonly IWorkspaceTask[]>();
			using picker = new Picker();
			using controller = new TaskQuickPick(tasks => tasks, { tasks: [task], onDidChangeTasks: changes.event } as unknown as ITaskService, { createQuickPick: () => picker } as unknown as IQuickInputService);
			const result = controller.show('Configure task', { label: 'Create configuration', task: null });
			if (action === 'cancel') picker.hide();
			else if (action === 'dispose') controller.dispose();
			else { picker.selectedItems = [picker.items[1]!]; picker.accepted.fire(); }
			assert.equal(await result, action === 'template' ? null : undefined);
			assert.equal(picker.isDisposed, true);
		});
	}

	test('accepting an old row uses the latest task configuration from the catalog', async () => {
		using changes = new Emitter<readonly IWorkspaceTask[]>();
		using picker = new Picker();
		let catalog = [task];
		using controller = new TaskQuickPick(tasks => tasks, {
			get tasks() { return catalog; }, onDidChangeTasks: changes.event,
		} as unknown as ITaskService, { createQuickPick: () => picker } as unknown as IQuickInputService);
		const result = controller.show('Configure task');
		const oldRow = picker.items[0]!;
		const current = { ...task, cwd: '/updated', detail: 'Updated configuration' };
		catalog = [current];
		changes.fire(catalog);
		picker.selectedItems = [oldRow];
		picker.accepted.fire();
		assert.equal(await result, current);
	});

	test('a task that leaves the selected group cannot be accepted through an old row', async () => {
		using changes = new Emitter<readonly IWorkspaceTask[]>();
		using picker = new Picker();
		let catalog = [task];
		using controller = new TaskQuickPick(tasks => tasks.filter(task => task.group === 'build'), {
			get tasks() { return catalog; }, onDidChangeTasks: changes.event,
		} as unknown as ITaskService, { createQuickPick: () => picker } as unknown as IQuickInputService);
		const result = controller.show('Build task');
		const oldRow = picker.items[0]!;
		catalog = [{ ...task, group: 'test' }];
		changes.fire(catalog);
		picker.selectedItems = [oldRow];
		picker.accepted.fire();
		assert.equal(picker.isDisposed, false);
		assert.deepEqual(picker.items, []);
		picker.hide();
		assert.equal(await result, undefined);
	});
});
