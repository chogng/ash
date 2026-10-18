import { Disposable } from "../../../../base/common/lifecycle.js";
import { Severity, type INotificationService, type INotificationHandle, type INotification, type NotificationMessage } from "../../../../platform/notification/common/notification.js";
import { NotificationsModel } from "../../../common/notifications.js";

/** Window-scoped service; notification presentation belongs to the Workbench parts. */
export class NotificationService extends Disposable implements INotificationService {
	readonly model = this._register(new NotificationsModel());

	notify(options: INotification): INotificationHandle {
		this.assertNotDisposed();
		validateNotification(options);
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
}

function validateNotification(options: INotification): void {
	if (![Severity.Info, Severity.Warning, Severity.Error].includes(options.severity)) throw new TypeError("Unknown notification severity");
	const message = options.message instanceof Error ? options.message.message : options.message;
	if (typeof message !== "string" || message.trim().length === 0) throw new TypeError("Notification message must not be empty");
	const source = typeof options.source === "object" ? options.source?.label : options.source;
	if (options.source !== undefined && (typeof source !== "string" || source.trim().length === 0)) throw new TypeError("Notification source must not be empty");
	const actionIds = new Set<string>();
	for (const action of [...(options.actions?.primary ?? []), ...(options.actions?.secondary ?? [])]) {
		if (!/^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(action.id)) throw new TypeError(`Invalid notification action ID: ${action.id}`);
		if (actionIds.has(action.id)) throw new RangeError(`Duplicate notification action ID: ${action.id}`);
		actionIds.add(action.id);
		if (typeof action.label !== "string" || action.label.trim().length === 0) throw new TypeError("Notification action label must not be empty");
		if (typeof action.run !== "function") throw new TypeError(`Notification action '${action.id}' must provide a callback`);
	}
}
