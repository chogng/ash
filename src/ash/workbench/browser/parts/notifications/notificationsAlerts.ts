import type { NotificationsModel } from '../../../common/notifications.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IAccessibilityService } from '../../../../platform/accessibility/common/accessibility.js';
import { NotificationPriority, Severity } from '../../../../platform/notification/common/notification.js';
import type { NotificationItem } from '../../../common/notifications.js';

/** Announces arrivals even when the notification center has suppressed its toasts. */
export class NotificationsAlerts extends Disposable {
	constructor(model: NotificationsModel, @IAccessibilityService private readonly accessibilityService: IAccessibilityService) {
		super();
		this._register(model.onDidAdd(item => this.announce(item)));
		for (const item of model.getNotifications()) {
			this.announce(item);
		}
	}

	private announce(item: NotificationItem): void {
		if (item.priority === NotificationPriority.SILENT) return;
		if (item.severity === Severity.Info) {
			this.accessibilityService.status(item.message);
		} else {
			this.accessibilityService.alert(item.message);
		}
	}
}
