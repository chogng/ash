import { localize } from "../../../../nls.js";
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from "../../../../platform/accessibility/browser/accessibleView.js";
import { AccessibleViewRegistry } from "../../../../platform/accessibility/browser/accessibleViewRegistry.js";
import { INotificationService } from "../../../../platform/notification/common/notification.js";
import { INotificationsCenter, NotificationsFocusedContext } from "./notificationsCenter.js";

AccessibleViewRegistry.register({
	type: AccessibleViewType.Help,
	priority: 100,
	name: "notificationsHelp",
	when: NotificationsFocusedContext.isEqualTo(true),
	getProvider: accessor => new AccessibleContentProvider(
		AccessibleViewProviderId.Notifications,
		{ type: AccessibleViewType.Help },
		() => localize('notifications.accessibilityHelp', 'Notification Center\nUse Tab and Shift+Tab to move between notifications and actions. Press Delete on a notification to remove it. Press Escape to close the center. Press Alt+F2 to read the notification history.'),
		() => accessor.get(INotificationsCenter).show(),
		AccessibilityVerbositySettingId.Notifications,
	),
});

AccessibleViewRegistry.register({
	type: AccessibleViewType.View,
	priority: 100,
	name: "notificationsView",
	when: NotificationsFocusedContext.isEqualTo(true),
	getProvider: accessor => new AccessibleContentProvider(
		AccessibleViewProviderId.Notifications,
		{ type: AccessibleViewType.View },
		() => accessor.get(INotificationService).getNotifications().map(item => `${item.severity}: ${item.message}`).join('\n') || localize('notifications.empty', 'No notifications'),
		() => accessor.get(INotificationsCenter).show(),
		AccessibilityVerbositySettingId.Notifications,
	),
});
