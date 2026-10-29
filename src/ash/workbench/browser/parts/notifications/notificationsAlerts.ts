import type { NotificationsModel } from '../../../common/notifications.js';
import { Disposable, DisposableMap } from '../../../../base/common/lifecycle.js';
import { IAccessibilityService } from '../../../../platform/accessibility/common/accessibility.js';
import { NotificationPriority, Severity } from '../../../../platform/notification/common/notification.js';
import type { NotificationItem } from '../../../common/notifications.js';

/** Announces arrivals and message updates, independently of toast visibility. */
export class NotificationsAlerts extends Disposable {
	private readonly itemListeners = this._register(new DisposableMap<number>());

	constructor(model: NotificationsModel, @IAccessibilityService private readonly accessibilityService: IAccessibilityService) {
		super();
		this._register(model.onDidAdd(item => this.observe(item)));
		this._register(model.onDidRemove(item => this.itemListeners.deleteAndDispose(item.id)));
		for (const item of model.getNotifications()) {
			this.observe(item);
		}
	}

	private observe(item: NotificationItem): void {
		let message = item.message;
		this.itemListeners.set(item.id, item.onDidChange(current => {
			if (current.message === message) return;
			message = current.message;
			this.announce(current);
		}));
		this.announce(item);
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
