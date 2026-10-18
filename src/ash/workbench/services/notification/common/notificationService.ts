import { Disposable } from "../../../../base/common/lifecycle.js";
import { Event } from "../../../../base/common/event.js";
import { NotificationSeverity, type INotificationService, type NotificationAction, type NotificationHandle, type NotificationItem, type NotificationOptions } from "../../../../platform/notification/common/notification.js";
import { NotificationsModel } from "../../../common/notifications.js";

/** Window-scoped service; notification presentation belongs to the Workbench parts. */
export class NotificationService extends Disposable implements INotificationService {
	readonly model = this._register(new NotificationsModel());
	readonly onDidAdd = this.model.onDidAdd;
	readonly onDidRemove = this.model.onDidRemove;

	notify(options: NotificationOptions): NotificationHandle {
		this.assertNotDisposed();
		validateNotification(options);
		const item = this.model.add(options);
		const model = this.model;
		return {
			get item() { return model.get(item.id) ?? item; },
			onDidClose: Event.once((listener, thisArgs, disposables) => this.onDidRemove(removed => {
				if (removed.id === item.id) listener.call(thisArgs, undefined);
			}, undefined, disposables)),
			updateMessage: message => model.update(item.id, { message }),
			progress: {
				infinite: () => model.update(item.id, { progress: { infinite: true } }),
				total: total => model.update(item.id, { progress: { total, worked: 0 } }),
				worked: value => {
					const progress = model.get(item.id)?.progress;
					model.update(item.id, { progress: { total: progress?.total, worked: (progress?.worked ?? 0) + value } });
				},
				done: () => model.update(item.id, { progress: undefined }),
			},
			close: () => { this.remove(item.id); },
		};
	}

	info(message: string, actions?: readonly NotificationAction[]): NotificationHandle { return this.notify({ severity: NotificationSeverity.Info, message, actions: { primary: actions } }); }
	warning(message: string, actions?: readonly NotificationAction[]): NotificationHandle { return this.notify({ severity: NotificationSeverity.Warning, message, actions: { primary: actions } }); }
	error(message: string, actions?: readonly NotificationAction[]): NotificationHandle { return this.notify({ severity: NotificationSeverity.Error, message, actions: { primary: actions } }); }
	getNotifications(): readonly NotificationItem[] { return this.model.getNotifications(); }
	remove(id: number): boolean { return this.isDisposed ? false : this.model.remove(id); }
	clear(): void { if (!this.isDisposed) this.model.clear(); }
}

function validateNotification(options: NotificationOptions): void {
	if (!Object.values(NotificationSeverity).includes(options.severity)) throw new TypeError("Unknown notification severity");
	if (typeof options.message !== "string" || options.message.trim().length === 0) throw new TypeError("Notification message must not be empty");
	if (options.source !== undefined && (typeof options.source !== "string" || options.source.trim().length === 0)) throw new TypeError("Notification source must not be empty");
	const actionIds = new Set<string>();
	for (const action of [...(options.actions?.primary ?? []), ...(options.actions?.secondary ?? [])]) {
		if (!/^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(action.id)) throw new TypeError(`Invalid notification action ID: ${action.id}`);
		if (actionIds.has(action.id)) throw new RangeError(`Duplicate notification action ID: ${action.id}`);
		actionIds.add(action.id);
		if (typeof action.label !== "string" || action.label.trim().length === 0) throw new TypeError("Notification action label must not be empty");
		if (typeof action.run !== "function") throw new TypeError(`Notification action '${action.id}' must provide a callback`);
	}
}
