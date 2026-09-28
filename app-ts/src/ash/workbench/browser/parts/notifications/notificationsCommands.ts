import { Keybinding, logicalKey } from "../../../../base/common/keybindings.js";
import { localize2 } from "../../../../nls.js";
import { Action2, registerAction2 } from "../../../../platform/actions/common/actions.js";
import type { ServicesAccessor } from "../../../../platform/instantiation/common/instantiation.js";
import { INotificationService } from "../../../../platform/notification/common/notification.js";
import { INotificationsCenter } from "./notificationsCenter.js";
import "./notificationAccessibleView.js";

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
	override run(accessor: ServicesAccessor): void { accessor.get(INotificationService).clear(); }
});
