import { Disposable } from '../../../../base/common/lifecycle.js';
import { IAccessibilityService } from '../../../../platform/accessibility/common/accessibility.js';
import { NotificationSeverity, type INotificationService, type NotificationItem } from '../../../../platform/notification/common/notification.js';

/** Announces arrivals even when the notification center has suppressed its toasts. */
export class NotificationsAlerts extends Disposable {
	constructor(model: INotificationService, @IAccessibilityService private readonly accessibilityService: IAccessibilityService) {
		super();
		this._register(model.onDidAdd(item => this.announce(item)));
		for (const item of model.getNotifications()) {
			this.announce(item);
		}
	}

	private announce(item: NotificationItem): void {
		if (item.severity === NotificationSeverity.Info) {
			this.accessibilityService.status(item.message);
		} else {
			this.accessibilityService.alert(item.message);
		}
	}
}
