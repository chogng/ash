import { Disposable } from "../../../../base/common/lifecycle.js";
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
		return { item, close: () => { this.remove(item.id); } };
	}

	info(message: string, actions?: readonly NotificationAction[]): NotificationHandle { return this.notify({ severity: NotificationSeverity.Info, message, actions }); }
	warning(message: string, actions?: readonly NotificationAction[]): NotificationHandle { return this.notify({ severity: NotificationSeverity.Warning, message, actions }); }
	error(message: string, actions?: readonly NotificationAction[]): NotificationHandle { return this.notify({ severity: NotificationSeverity.Error, message, actions }); }
	getNotifications(): readonly NotificationItem[] { return this.model.getNotifications(); }
	remove(id: number): boolean { return this.isDisposed ? false : this.model.remove(id); }
	clear(): void { if (!this.isDisposed) this.model.clear(); }
}

function validateNotification(options: NotificationOptions): void {
	if (!Object.values(NotificationSeverity).includes(options.severity)) throw new TypeError("Unknown notification severity");
	if (typeof options.message !== "string" || options.message.trim().length === 0) throw new TypeError("Notification message must not be empty");
	const actionIds = new Set<string>();
	for (const action of options.actions ?? []) {
		if (!/^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(action.id)) throw new TypeError(`Invalid notification action ID: ${action.id}`);
		if (!actionIds.add(action.id)) throw new RangeError(`Duplicate notification action ID: ${action.id}`);
		if (typeof action.label !== "string" || action.label.trim().length === 0) throw new TypeError("Notification action label must not be empty");
		if (typeof action.run !== "function") throw new TypeError(`Notification action '${action.id}' must provide a callback`);
	}
}
