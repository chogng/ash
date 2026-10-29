import { localize } from '../../../../nls.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { INotificationService, NotificationPriority, NotificationsFilter, Severity, type INotificationHandle } from '../../../../platform/notification/common/notification.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { ProgressLocation, type IProgress, type IProgressService, type IProgressOptions, type IProgressWindowOptions, type IProgressNotificationOptions, type IProgressStep } from '../../../../platform/progress/common/progress.js';
import { IStatusbarService, StatusbarAlignment, type IStatusbarEntryAccessor } from '../../statusbar/browser/statusbar.js';
import { IViewsService } from '../../views/common/viewsService.js';
import { IViewDescriptorService, WorkbenchViewContainerId } from '../../../common/views.js';
import { IPaneCompositePartService } from '../../panecomposite/browser/panecomposite.js';
import type { IProgressCompositeOptions, IProgressIndicator, IProgressRunner } from '../../../../platform/progress/common/progress.js';

interface ProgressTask {
	readonly options: IProgressOptions;
	readonly resources: DisposableStore;
	readonly cancel: (choice?: number) => void;
	readonly finish: () => void;
	message?: string;
	total?: number;
	worked: number;
	cancelled: boolean;
	notification?: INotificationHandle;
	notificationHidden?: boolean;
	/** Work already delivered to the incremental notification progress API. */
	notificationWorked?: number;
}

/** Routes producer-owned Promise lifetimes through the existing Workbench presentations. */
export class ProgressService extends Disposable implements IProgressService {
	private readonly tasks = new Set<ProgressTask>();
	private readonly windowStatus = this._register(new MutableDisposable<IStatusbarEntryAccessor>());

	constructor(
		@IStatusbarService private readonly statusbar: IStatusbarService,
		@INotificationService private readonly notifications: INotificationService,
		@ICommandService private readonly commands: ICommandService,
		@IViewsService private readonly views: IViewsService,
		@IViewDescriptorService private readonly descriptors: IViewDescriptorService,
		@IPaneCompositePartService private readonly panes: IPaneCompositePartService,
	) {
		super();
	}

	withProgress<R>(
		options: IProgressOptions | IProgressWindowOptions | IProgressNotificationOptions | IProgressCompositeOptions,
		task: (progress: IProgress<IProgressStep>) => Promise<R>,
		onDidCancel?: (choice?: number) => void,
	): Promise<R> {
		this.assertNotDisposed();
		if (typeof options.location === 'string' || options.location === ProgressLocation.Explorer || options.location === ProgressLocation.Scm || options.location === ProgressLocation.Extensions) {
			return this.withViewProgress(options as IProgressCompositeOptions, task);
		}
		if (options.location !== ProgressLocation.Window && options.location !== ProgressLocation.Notification) throw new Error(`Bad progress location: ${options.location}`);
		const resources = new DisposableStore();
		const record: ProgressTask = {
			options, resources, total: options.total, worked: 0, cancelled: false,
			cancel: choice => {
				if (record.cancelled || !this.tasks.has(record)) return;
				record.cancelled = true;
				record.notification?.close();
				this.updateWindowProgress();
				onDidCancel?.(choice);
			},
			finish: () => {
				if (!this.tasks.delete(record)) return;
				resources.dispose();
				record.notification?.close();
				this.updateWindowProgress();
			},
		};
		this.tasks.add(record);
		try {
			// Start the producer before publishing controls that can request cancellation.
			const promise = task({
				report: update => {
					if (!this.tasks.has(record) || record.cancelled) return;
					if (update.message !== undefined) record.message = update.message;
					if (update.total !== undefined) record.total = update.total;
					record.worked += update.increment ?? 0;
					this.updateNotification(record);
					this.updateWindowProgress();
				}
			});
			const directWindow = options.location === ProgressLocation.Window && !!(options as IProgressWindowOptions).command;
			if (!directWindow) {
				const delay = options.location === ProgressLocation.Window ? 150 : (options as IProgressNotificationOptions).delay ?? 0;
				if (delay > 0) {
					const timer = setTimeout(() => this.showNotification(record), delay);
					resources.add(toDisposable(() => clearTimeout(timer)));
				} else this.showNotification(record);
			}
			this.updateWindowProgress();
			return Promise.resolve(promise).finally(record.finish);
		} catch (error) {
			record.finish();
			return Promise.reject(error);
		}
	}

	private withViewProgress<R>(options: IProgressCompositeOptions, task: (progress: IProgress<IProgressStep>) => Promise<R>): Promise<R> {
		const id = typeof options.location === 'string' ? options.location
			: options.location === ProgressLocation.Explorer ? WorkbenchViewContainerId.Sidebar
				: options.location === ProgressLocation.Scm ? WorkbenchViewContainerId.SourceControl : 'ash.extensions';
		const container = this.descriptors.getViewContainerById(id);
		let indicator: IProgressIndicator | undefined;
		if (container) {
			indicator = this.panes.getProgressIndicator(id, container.location);
		} else if (this.descriptors.getViewDescriptorById(id)) {
			indicator = this.views.getViewProgressIndicator(id);
		} else {
			throw new Error(`Bad progress location: ${options.location}`);
		}
		// A valid unopened view does not acquire UI or turn a background read into a notification.
		let runner: IProgressRunner | undefined;
		let total = options.total;
		let finished = false;
		const lifetime = toDisposable(() => { finished = true; runner?.done(); });
		const finish = (): void => { this._store.delete(lifetime); lifetime.dispose(); };
		this._register(lifetime);
		try {
			runner = total === undefined ? indicator?.show(true, options.delay) : indicator?.show(total, options.delay);
			const promise = task({
				report: step => {
					if (finished || !runner) return;
					if (step.total !== undefined || step.increment !== undefined && total === undefined) {
						total = step.total ?? 100;
						runner.total(total);
					}
					if (step.increment !== undefined) runner.worked(step.increment);
				}
			});
			return Promise.resolve(promise).finally(finish);
		} catch (error) {
			finish();
			return Promise.reject(error);
		}
	}

	protected override disposeCore(): void {
		const errors: unknown[] = [];
		for (const record of [...this.tasks]) {
			try { record.cancel(); }
			catch (error) { errors.push(error); }
			finally { record.finish(); }
		}
		super.disposeCore();
		if (errors.length) throw new AggregateError(errors, 'Failed to cancel progress tasks');
	}

	private showNotification(record: ProgressTask): void {
		if (!this.tasks.has(record) || record.cancelled || this.isDisposed) return;
		const { options } = record;
		const filtered = this.notifications.getFilter() === NotificationsFilter.ERROR || (typeof options.source === 'object' && this.notifications.getFilter(options.source) === NotificationsFilter.ERROR);
		const requestedPriority = (options as IProgressNotificationOptions).priority;
		const priority = options.location === ProgressLocation.Window || (filtered && requestedPriority !== NotificationPriority.URGENT) ? NotificationPriority.SILENT : requestedPriority;
		record.notificationHidden = priority === NotificationPriority.SILENT;
		record.notificationWorked = record.total === undefined ? 0 : record.worked;
		record.notification = this.notifications.notify({
			severity: Severity.Info,
			message: this.taskText(record) || localize('progress.running', 'Working…'),
			source: options.source,
			priority,
			progress: record.total === undefined ? { infinite: true } : { total: record.total, worked: record.worked },
			actions: options.cancellable ? {
				primary: [{
					tooltip: '',
					enabled: true,
					id: 'progress.cancel',
					label: typeof options.cancellable === 'string' ? options.cancellable : localize('progress.cancel', 'Cancel'),
					run: () => record.cancel(),
				}]
			} : undefined,
		});
		// The center can render synchronously during notify(), before the handle is returned.
		if (record.notification.visible) record.notificationHidden = false;
		record.resources.add(record.notification.onDidClose(() => {
			record.notification = undefined;
			this.updateWindowProgress();
		}));
		if (record.notification) record.resources.add(record.notification.onDidChangeVisibility(visible => {
			record.notificationHidden = !visible;
			this.updateWindowProgress();
		}));
		this.updateWindowProgress();
	}

	private updateNotification(record: ProgressTask): void {
		const handle = record.notification;
		if (!handle) return;
		handle.updateMessage(this.taskText(record) || localize('progress.running', 'Working…'));
		if (record.total === undefined) { handle.progress.infinite(); record.notificationWorked = 0; }
		else {
			handle.progress.total(record.total);
			const increment = record.worked - (record.notificationWorked ?? 0);
			if (increment !== 0) handle.progress.worked(increment);
			record.notificationWorked = record.worked;
		}
	}

	private taskText(record: ProgressTask): string {
		const title = record.options.title;
		return title && record.message
			? localize('progress.titleMessage', '{0}: {1}', title, record.message)
			: title || record.message || '';
	}

	private updateWindowProgress(): void {
		if (this.isDisposed) return;
		const active = [...this.tasks].filter(record => !record.cancelled && !!this.taskText(record)
			&& ((record.options.location === ProgressLocation.Window && !!(record.options as IProgressWindowOptions).command) || (!!record.notification && record.notificationHidden)));
		// A producer can reach its numeric total before settling its Promise. Keep
		// that lifetime intact, but only show work that still reports as unfinished.
		const record = active.filter(record => record.total === undefined || record.worked < record.total).at(-1);
		if (!record) { this.windowStatus.clear(); return; }
		const text = this.taskText(record);
		const source = typeof record.options.source === 'string' ? record.options.source : record.options.source?.label;
		const command = (record.options as IProgressWindowOptions).command ?? 'notifications.showList';
		const entry = {
			text, ariaLabel: text,
			icon: Lxicon.sync, showProgress: true,
			tooltip: source ? localize('progress.sourceTooltip', '[{0}] {1}', source, text) : text,
			run: () => this.commands.executeCommand(command),
		};
		if (this.windowStatus.value) this.windowStatus.value.update(entry);
		else this.windowStatus.value = this.statusbar.addEntry(entry, { id: 'status.progress', alignment: StatusbarAlignment.Left, priority: -Number.MAX_SAFE_INTEGER });
	}
}
