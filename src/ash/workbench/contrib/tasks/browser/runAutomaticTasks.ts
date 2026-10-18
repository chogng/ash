import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { getErrorMessage, isCancellationError } from '../../../../base/common/errors.js';
import { localize, localize2 } from '../../../../nls.js';
import { IConfigurationService, ConfigurationTarget } from '../../../../platform/configuration/common/configuration.js';
import { ConfigurationScope, Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustManagementService } from '../../../../platform/workspace/common/workspaceTrust.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { Action2 } from '../../../../platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ITaskService } from '../common/taskService.js';
import type { IWorkbenchContribution } from '../../../common/contributions.js';

const allowAutomaticTasks = 'task.allowAutomaticTasks';

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: allowAutomaticTasks, defaultValue: 'off', scope: ConfigurationScope.APPLICATION,
	schema: { type: 'string', enum: ['on', 'off'] },
	parse(value: unknown): 'on' | 'off' {
		if (value !== 'on' && value !== 'off') throw new TypeError(localize('tasks.invalidAutomaticPolicy', 'Automatic tasks must be on or off.'));
		return value;
	},
	setting: {
		valueType: 'select',
		get title() { return localize('tasks.automaticTitle', 'Automatic tasks'); },
		get description() { return localize('tasks.automaticDescription', 'Run folder-open tasks in trusted workspaces. Disabled by default.'); },
		get options() { return [{ value: 'on', label: localize('tasks.automaticOn', 'Always') }, { value: 'off', label: localize('tasks.automaticOff', 'Never') }]; },
	},
});

/** Launches configured folder-open tasks once per workspace entry, through the normal Task owner. */
export class RunAutomaticTasks extends Disposable implements IWorkbenchContribution {
	private generation = 0;
	private readonly attempted = new Set<string>();
	private operation = Promise.resolve();
	private preparing: { readonly taskId: string; readonly controller: AbortController; } | undefined;

	constructor(
		@ITaskService private readonly tasks: ITaskService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IWorkspaceContextService workspace: IWorkspaceContextService,
		@IWorkspaceTrustManagementService private readonly trust: IWorkspaceTrustManagementService,
		@INotificationService private readonly notifications: INotificationService,
	) {
		super();
		this._register(tasks.onDidChangeTasks(() => this.schedule(false)));
		this._register(tasks.onDidStartTask(run => {
			if (this.preparing && run.task.runOptions?.runOn === 'folderOpen') this.attempted.add(run.task.id);
			// Start is published before run() finishes revealing the terminal. From
			// that point a policy refresh must not abort or repeat this execution.
			if (this.preparing?.taskId === run.task.id) this.preparing = undefined;
		}));
		this._register(configuration.onDidChangeConfiguration(event => { if (event.affectsConfiguration(allowAutomaticTasks)) this.schedule(true); }));
		this._register(trust.onDidChangeTrust(() => this.schedule(true)));
		this._register(workspace.onDidChangeWorkspace(() => {
			this.attempted.clear();
			this.schedule(true);
		}));
		this.schedule(true);
	}

	onWorkspaceRestored(): void { this.schedule(true); }

	private schedule(refresh: boolean): void {
		const generation = ++this.generation;
		this.preparing?.controller.abort();
		// A replacement waits for canceled preparation to release its capacity and
		// clear its attempt. Published runs retain their normal Task lifetime.
		this.operation = this.operation.then(() => this.run(generation, refresh)).catch(error => {
			if (!this.isDisposed && generation === this.generation && !isCancellationError(error)) this.notifications.error(getErrorMessage(error));
		});
	}

	private async run(generation: number, refresh: boolean): Promise<void> {
		const current = (): boolean => !this.isDisposed && generation === this.generation && this.configuration.getValue(allowAutomaticTasks) === 'on';
		if (!current() || !(await this.trust.getWorkspaceTrustInfo())?.isTrusted || !current()) return;
		if (refresh) await this.tasks.refresh();
		if (!current()) return;
		for (const task of this.tasks.tasks) {
			if (task.runOptions?.runOn !== 'folderOpen' || this.attempted.has(task.id)) continue;
			if (!current()) return;
			const controller = new AbortController();
			const preparing = { taskId: task.id, controller };
			this.preparing = preparing;
			this.attempted.add(task.id);
			try {
				await this.tasks.run(task, controller.signal);
			} catch (error) {
				this.attempted.delete(task.id);
				if (!controller.signal.aborted && generation === this.generation && !isCancellationError(error)) this.notifications.error(localize('tasks.automaticFailed', "Automatic task '{0}' could not start: {1}", task.label, getErrorMessage(error)));
			} finally {
				if (this.preparing === preparing) this.preparing = undefined;
			}
		}
	}

	protected override disposeCore(): void {
		this.generation++;
		this.preparing?.controller.abort();
		this.attempted.clear();
		super.disposeCore();
	}
}

export class ManageAutomaticTaskRunning extends Action2 {
	public static readonly ID = 'workbench.action.tasks.manageAutomaticRunning';
	constructor() {
		super({ id: ManageAutomaticTaskRunning.ID, title: localize2('tasks.manageAutomatic', 'Manage Automatic Tasks'), f1: true });
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const quickInput = accessor.get(IQuickInputService);
		const configuration = accessor.get(IConfigurationService);
		const notifications = accessor.get(INotificationService);
		const selected = await new Promise<'on' | 'off' | undefined>(resolve => {
			const resources = new DisposableStore();
			const picker = resources.add(quickInput.createQuickPick<{ label: string; value: 'on' | 'off'; }>());
			picker.placeholder = localize('tasks.automaticPlaceholder', 'Choose whether trusted workspaces may run folder-open tasks');
			picker.items = [
				{ label: localize('tasks.allowAutomatic', 'Allow Automatic Tasks'), value: 'on' },
				{ label: localize('tasks.disallowAutomatic', 'Disallow Automatic Tasks'), value: 'off' },
			];
			resources.add(picker.onDidAccept(() => {
				const item = picker.selectedItems[0];
				if (item) { resolve(item.value); picker.hide(); }
			}));
			resources.add(picker.onDidHide(() => { resolve(undefined); resources.dispose(); }));
			picker.show();
		});
		if (selected) {
			await configuration.updateValue(allowAutomaticTasks, selected, ConfigurationTarget.USER);
			notifications.info(selected === 'on' ? localize('tasks.automaticEnabled', 'Automatic tasks enabled.') : localize('tasks.automaticDisabled', 'Automatic tasks disabled.'));
		}
	}
}
