import { localize } from "../../../../nls.js";
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from "../../../../base/common/lifecycle.js";
import { ICommandService } from "../../../../platform/commands/common/commands.js";
import { INotificationService, NotificationPriority, Severity, type INotificationHandle } from "../../../../platform/notification/common/notification.js";
import { ProgressLocation, type IProgress, type IProgressService, type IProgressOptions, type IProgressWindowOptions, type IProgressNotificationOptions, type IProgressStep } from "../../../../platform/progress/common/progress.js";
import { IStatusbarService, StatusbarAlignment, type IStatusbarEntryAccessor } from "../../statusbar/browser/statusbar.js";

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
}

/** Routes producer-owned Promise lifetimes through the existing Workbench presentations. */
export class ProgressService extends Disposable implements IProgressService {
	private readonly tasks = new Set<ProgressTask>();
	private readonly windowStatus = this._register(new MutableDisposable<IStatusbarEntryAccessor>());

	constructor(
		@IStatusbarService private readonly statusbar: IStatusbarService,
		@INotificationService private readonly notifications: INotificationService,
		@ICommandService private readonly commands: ICommandService,
	) {
		super();
	}

	withProgress<R>(
		options: IProgressOptions | IProgressWindowOptions | IProgressNotificationOptions,
		task: (progress: IProgress<IProgressStep>) => Promise<R>,
		onDidCancel?: (choice?: number) => void,
	): Promise<R> {
		this.assertNotDisposed();
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

	protected override disposeCore(): void {
		const errors: unknown[] = [];
		for (const record of [...this.tasks]) {
			try { record.cancel(); }
			catch (error) { errors.push(error); }
			finally { record.finish(); }
		}
		super.disposeCore();
		if (errors.length) throw new AggregateError(errors, "Failed to cancel progress tasks");
	}

	private showNotification(record: ProgressTask): void {
		if (!this.tasks.has(record) || record.cancelled || this.isDisposed) return;
		const { options } = record;
		record.notification = this.notifications.notify({
			severity: Severity.Info,
			message: this.taskText(record) || localize('progress.running', "Working…"),
			source: typeof options.source === 'string' ? options.source : options.source?.label,
			priority: options.location === ProgressLocation.Window ? NotificationPriority.SILENT : (options as IProgressNotificationOptions).priority,
			progress: record.total === undefined ? { infinite: true } : { total: record.total, worked: record.worked },
			actions: options.cancellable ? {
				primary: [{
					tooltip: '',
					enabled: true,
					id: 'progress.cancel',
					label: typeof options.cancellable === 'string' ? options.cancellable : localize('progress.cancel', "Cancel"),
					run: () => record.cancel(),
				}]
			} : undefined,
		});
		record.resources.add(record.notification.onDidClose(() => {
			record.notification = undefined;
			this.updateWindowProgress();
		}));
		this.updateWindowProgress();
	}

	private updateNotification(record: ProgressTask): void {
		const handle = record.notification;
		if (!handle) return;
		handle.updateMessage(this.taskText(record) || localize('progress.running', "Working…"));
		if (record.total === undefined) handle.progress.infinite();
		else {
			handle.progress.total(record.total);
			handle.progress.worked(record.worked);
		}
	}

	private taskText(record: ProgressTask): string {
		const title = record.options.title;
		return title && record.message
			? localize('progress.titleMessage', "{0}: {1}", title, record.message)
			: title || record.message || '';
	}

	private updateWindowProgress(): void {
		if (this.isDisposed) return;
		const active = [...this.tasks].filter(record => record.options.location === ProgressLocation.Window
			&& !record.cancelled && !!this.taskText(record)
			&& (!!(record.options as IProgressWindowOptions).command || !!record.notification));
		// Completing the most recent task reveals the previous operation.
		const record = active.at(-1);
		if (!record) { this.windowStatus.clear(); return; }
		const text = this.taskText(record);
		const source = typeof record.options.source === 'string' ? record.options.source : record.options.source?.label;
		const command = (record.options as IProgressWindowOptions).command ?? 'notifications.showList';
		const entry = {
			text, ariaLabel: text,
			tooltip: source ? localize('progress.sourceTooltip', "[{0}] {1}", source, text) : text,
			run: () => this.commands.executeCommand(command),
		};
		if (this.windowStatus.value) this.windowStatus.value.update(entry);
		else this.windowStatus.value = this.statusbar.addEntry(entry, { id: "status.progress", alignment: StatusbarAlignment.Right, priority: 20 });
	}
}
