import { ActionRunner, type IAction } from "../../../../base/common/actions.js";
import { getErrorMessage, isCancellationError } from "../../../../base/common/errors.js";
import { Keybinding, logicalKey } from "../../../../base/common/keybindings.js";
import { localize2 } from "../../../../nls.js";
import { Action2, registerAction2 } from "../../../../platform/actions/common/actions.js";
import type { ServicesAccessor } from "../../../../platform/instantiation/common/instantiation.js";
import { INotificationService } from "../../../../platform/notification/common/notification.js";
import { INotificationsCenter } from "./notificationsCenter.js";
import "./notificationAccessibleView.js";

/** One window's error boundary for notification actions in both presentations. */
export class NotificationActionRunner extends ActionRunner {
	constructor(@INotificationService private readonly notificationService: INotificationService) {
		super();
	}

	protected override async runAction(action: IAction, context?: unknown): Promise<void> {
		if (this.isDisposed) return;
		try {
			await super.runAction(action, context);
		} catch (error) {
			// Producers own cancellation and handled failures. Window disposal also
			// suppresses late feedback without taking ownership of the producer's task.
			if (!this.isDisposed && !isCancellationError(error)) this.notificationService.error(getErrorMessage(error));
		}
	}
}

registerAction2(class ShowNotificationsAction extends Action2 {
	constructor() {
		super({
			id: "notifications.showList",
			title: localize2("notifications.showList", "Show Notifications"),
			f1: true,
			keybinding: { primary: Keybinding.chord(logicalKey("k", { primaryKey: true }), logicalKey("n", { primaryKey: true, shiftKey: true })) },
		});
	}
	override run(accessor: ServicesAccessor): void { accessor.get(INotificationsCenter).show(); }
});

registerAction2(class HideNotificationsAction extends Action2 {
	constructor() { super({ id: "notifications.hideList", title: localize2("notifications.hideList", "Hide Notifications"), f1: true }); }
	override run(accessor: ServicesAccessor): void { accessor.get(INotificationsCenter).hide(); }
});

registerAction2(class ClearNotificationsAction extends Action2 {
	constructor() { super({ id: "notifications.clearAll", title: localize2("notifications.clearAllCommand", "Clear All Notifications"), f1: true }); }
	override run(accessor: ServicesAccessor): void { accessor.get(INotificationsCenter).clearAll(); }
});
