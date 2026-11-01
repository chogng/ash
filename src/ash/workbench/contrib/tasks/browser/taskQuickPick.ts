import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IQuickInputService, type IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { ITaskService } from '../common/taskService.js';
import type { IWorkspaceTask } from '../common/tasks.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { showWithPinnedItems } from '../../../../platform/quickinput/browser/quickPickPin.js';

export interface ITaskQuickPickEntry extends IQuickPickItem {
	readonly task: IWorkspaceTask | undefined | null;
}

/** Selection observes the task catalog; execution remains with the task service. */
export class TaskQuickPick extends Disposable {
	constructor(
		private readonly selectTasks: (catalog: readonly IWorkspaceTask[]) => readonly IWorkspaceTask[],
		@ITaskService private readonly tasks: ITaskService,
		@IQuickInputService private readonly quickInput: IQuickInputService,
		@IStorageService private readonly storage: IStorageService,
	) { super(); }

	show(placeHolder: string, defaultEntry?: ITaskQuickPickEntry): Promise<IWorkspaceTask | undefined | null> {
		return new Promise(resolve => {
			const lifetime = this._register(new DisposableStore());
			const picker = lifetime.add(this.quickInput.createQuickPick<ITaskQuickPickEntry>());
			const pins = lifetime.add(new MutableDisposable());
			picker.ariaLabel = picker.placeholder = placeHolder;
			let shown = false;
			const update = (): void => {
				const selection = shown ? picker.valueSelection : undefined;
				const activeId = picker.activeItems[0]?.id;
				pins.clear();
				picker.sortByLabel = true;
				picker.items = this.selectTasks(this.tasks.tasks).map(task => ({ id: task.id, task, label: task.label, description: task.source, detail: task.detail ?? task.command }));
				if (defaultEntry) picker.items = [...picker.items, defaultEntry];
				pins.value = showWithPinnedItems(this.storage, 'workbench.tasks.pinnedTasks', picker, true);
				if (selection) picker.valueSelection = selection;
				const retained = activeId && picker.items.find(item => !('type' in item) && item.id === activeId);
				if (retained && !('type' in retained)) picker.activeItems = [retained];
				shown = true;
			};
			let selected: IWorkspaceTask | undefined | null;
			lifetime.add(this.tasks.onDidChangeTasks(update));
			lifetime.add(picker.onDidAccept(() => {
				const item = picker.selectedItems[0];
				if (!item) return;
				if (item.task) {
					// A catalog refresh can replace configuration without changing the
					// row identity. Always return the object owned by the current catalog.
					const current = this.selectTasks(this.tasks.tasks).find(task => task.id === item.task!.id && task.command === item.task!.command);
					if (!current) return;
					selected = current;
				} else {
					selected = item.task;
				}
				picker.hide();
			}));
			lifetime.add(picker.onDidHide(() => { resolve(selected); lifetime.dispose(); }));
			lifetime.add(toDisposable(() => resolve(undefined)));
			update();
		});
	}
}
