import { Disposable } from "../../../../base/common/lifecycle.js";
import { Emitter } from "../../../../base/common/event.js";
import { NotificationPriority, NotificationsFilter, Severity, type INotificationService, type INotificationHandle, type INotification, type NotificationMessage, type INotificationSource, type INotificationSourceFilter, type IStatusMessageOptions, type IStatusHandle } from "../../../../platform/notification/common/notification.js";
import { IStorageService, StorageScope, StorageTarget } from "../../../../platform/storage/common/storage.js";
import { NotificationsModel } from "../../../common/notifications.js";

/** Window-scoped service; notification presentation belongs to the Workbench parts. */
export class NotificationService extends Disposable implements INotificationService {
	readonly model = this._register(new NotificationsModel());
	private readonly filterChanges = this._register(new Emitter<void>());
	readonly onDidChangeFilter = this.filterChanges.event;
	private static readonly filterKey = 'notifications.doNotDisturbMode';
	private static readonly sourcesKey = 'notifications.perSourceDoNotDisturbMode';
	private filter: NotificationsFilter;
	private sources: Map<string, INotificationSourceFilter>;

	constructor(@IStorageService private readonly storageService: IStorageService) {
		super();
		this.filter = this.readFilter();
		this.sources = this.readSources();
		this._register(storageService.onDidChangeValue(event => {
			if (event.scope !== StorageScope.APPLICATION) { return; }
			if (event.key === NotificationService.sourcesKey) {
				const sources = this.readSources();
				if (JSON.stringify([...sources.values()]) === JSON.stringify([...this.sources.values()])) { return; }
				this.sources = sources;
				this.filterChanges.fire();
				return;
			}
			if (event.key !== NotificationService.filterKey) { return; }
			const filter = this.readFilter();
			if (filter === this.filter) { return; }
			this.filter = filter;
			this.filterChanges.fire();
		}));
	}

	setFilter(filter: NotificationsFilter | INotificationSourceFilter): void {
		this.assertNotDisposed();
		if (typeof filter === 'object') {
			if (!isSourceFilter(filter)) { throw new TypeError('Invalid notification source filter'); }
			const previous = this.sources.get(filter.id);
			if (previous?.label === filter.label && previous.filter === filter.filter) { return; }
			this.sources.set(filter.id, { id: filter.id, label: filter.label, filter: filter.filter });
			this.saveSources();
			return;
		}
		if (filter !== NotificationsFilter.OFF && filter !== NotificationsFilter.ERROR) { throw new TypeError('Unknown notification filter'); }
		if (this.filter === filter) { return; }
		this.storageService.store(NotificationService.filterKey, filter === NotificationsFilter.ERROR, StorageScope.APPLICATION, StorageTarget.MACHINE);
		// Storage implementations may deliver the local change synchronously.
		if (this.filter !== filter) {
			this.filter = filter;
			this.filterChanges.fire();
		}
	}

	getFilter(source?: INotificationSource): NotificationsFilter { return source ? this.sources.get(source.id)?.filter ?? NotificationsFilter.OFF : this.filter; }

	getFilters(): INotificationSourceFilter[] { return [...this.sources.values()].map(source => ({ ...source })); }

	removeFilter(sourceId: string): void {
		this.assertNotDisposed();
		if (this.sources.delete(sourceId)) { this.saveSources(); }
	}

	private saveSources(): void {
		this.storageService.store(NotificationService.sourcesKey, JSON.stringify([...this.sources.values()]), StorageScope.APPLICATION, StorageTarget.MACHINE);
		this.filterChanges.fire();
	}

	private readSources(): Map<string, INotificationSourceFilter> {
		try {
			const stored: unknown = JSON.parse(this.storageService.get(NotificationService.sourcesKey, StorageScope.APPLICATION, '[]'));
			if (Array.isArray(stored) && stored.every(isSourceFilter)) { return new Map(stored.map(source => [source.id, { id: source.id, label: source.label, filter: source.filter }])); }
		} catch { /* A damaged state entry must not prevent the workbench from starting. */ }
		return new Map();
	}

	private readFilter(): NotificationsFilter {
		return this.storageService.getBoolean(NotificationService.filterKey, StorageScope.APPLICATION, false) ? NotificationsFilter.ERROR : NotificationsFilter.OFF;
	}

	notify(options: INotification): INotificationHandle {
		this.assertNotDisposed();
		validateNotification(options);
		if (typeof options.source === 'object') {
			this.setFilter({ ...options.source, filter: this.getFilter(options.source) });
		}
		if (options.priority !== NotificationPriority.URGENT && options.severity !== Severity.Error && (this.filter === NotificationsFilter.ERROR || (typeof options.source === 'object' && this.getFilter(options.source) === NotificationsFilter.ERROR))) {
			return this.model.addNotification({ ...options, priority: NotificationPriority.SILENT });
		}
		return this.model.addNotification(options);
	}

	info(message: NotificationMessage | NotificationMessage[]): void {
		for (const entry of Array.isArray(message) ? message : [message]) {
			this.notify({ severity: Severity.Info, message: entry });
		}
	}

	warn(message: NotificationMessage | NotificationMessage[]): void {
		for (const entry of Array.isArray(message) ? message : [message]) {
			this.notify({ severity: Severity.Warning, message: entry });
		}
	}

	error(message: NotificationMessage | NotificationMessage[]): void {
		for (const entry of Array.isArray(message) ? message : [message]) {
			this.notify({ severity: Severity.Error, message: entry });
		}
	}

	status(message: NotificationMessage, options?: IStatusMessageOptions): IStatusHandle {
		this.assertNotDisposed();
		const text = message instanceof Error ? message.message : message;
		if (typeof text !== 'string' || !text.trim()) { throw new TypeError('Status message must not be empty'); }
		for (const delay of [options?.showAfter, options?.hideAfter]) {
			if (delay !== undefined && (!Number.isFinite(delay) || delay < 0)) { throw new TypeError('Status message delay must be a non-negative number'); }
		}
		return this.model.showStatusMessage(text, options);
	}
}

function isSourceFilter(value: unknown): value is INotificationSourceFilter {
	if (!value || typeof value !== 'object') { return false; }
	const source = value as Partial<INotificationSourceFilter>;
	return typeof source.id === 'string' && !!source.id.trim() && typeof source.label === 'string' && !!source.label.trim()
		&& (source.filter === NotificationsFilter.OFF || source.filter === NotificationsFilter.ERROR);
}

function validateNotification(options: INotification): void {
	if (![Severity.Info, Severity.Warning, Severity.Error].includes(options.severity)) throw new TypeError("Unknown notification severity");
	const message = options.message instanceof Error ? options.message.message : options.message;
	if (typeof message !== "string" || message.trim().length === 0) throw new TypeError("Notification message must not be empty");
	if (options.sticky !== undefined && typeof options.sticky !== 'boolean') throw new TypeError('Notification sticky state must be a boolean');
	const source = typeof options.source === "object" ? options.source?.label : options.source;
	if (options.source !== undefined && (typeof source !== "string" || source.trim().length === 0)) throw new TypeError("Notification source must not be empty");
	if (typeof options.source === 'object' && (typeof options.source.id !== 'string' || !options.source.id.trim())) throw new TypeError('Notification source ID must not be empty');
	const actionIds = new Set<string>();
	for (const action of [...(options.actions?.primary ?? []), ...(options.actions?.secondary ?? [])]) {
		if (!/^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(action.id)) throw new TypeError(`Invalid notification action ID: ${action.id}`);
		if (actionIds.has(action.id)) throw new RangeError(`Duplicate notification action ID: ${action.id}`);
		actionIds.add(action.id);
		if (typeof action.label !== "string" || action.label.trim().length === 0) throw new TypeError("Notification action label must not be empty");
		if (typeof action.run !== "function") throw new TypeError(`Notification action '${action.id}' must provide a callback`);
	}
}
