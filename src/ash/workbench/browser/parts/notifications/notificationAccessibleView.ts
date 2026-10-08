import { localize } from "../../../../nls.js";
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from "../../../../platform/accessibility/browser/accessibleView.js";
import { AccessibleViewRegistry } from "../../../../platform/accessibility/browser/accessibleViewRegistry.js";
import { INotificationService } from "../../../../platform/notification/common/notification.js";
import { INotificationsCenter, NotificationsFocusedContext } from "./notificationsCenter.js";
import { DisposableStore } from '../../../../base/common/lifecycle.js';

AccessibleViewRegistry.register({
	type: AccessibleViewType.Help,
	priority: 100,
	name: "notificationsHelp",
	when: NotificationsFocusedContext.isEqualTo(true),
	getProvider: accessor => new AccessibleContentProvider(
		AccessibleViewProviderId.Notifications,
		{ type: AccessibleViewType.Help },
		() => localize('notifications.accessibilityHelp', 'Notification Center\nUse Tab and Shift+Tab to move between notifications and actions. Right-click a notification, or press the Context Menu key or Shift+F10, and choose Copy Text to copy its message. Press Escape to close the menu and return to the notification. Press Delete on a notification to remove it. Press Escape to close the center. When the Remove notification button in a toast has focus, press Escape to hide the toasts without removing them from history. Press <keybinding:editor.action.accessibleView> to read the notification history.'),
		() => accessor.get(INotificationsCenter).show(),
		AccessibilityVerbositySettingId.Notifications,
	),
});

AccessibleViewRegistry.register({
	type: AccessibleViewType.View,
	priority: 100,
	name: "notificationsView",
	when: NotificationsFocusedContext.isEqualTo(true),
	getProvider: accessor => {
		const notifications = accessor.get(INotificationService);
		const provider = new AccessibleContentProvider(
			AccessibleViewProviderId.Notifications,
			{ type: AccessibleViewType.View },
			() => notifications.getNotifications().map(item => `${item.severity}: ${item.message}`).join('\n') || localize('notifications.empty', 'No notifications'),
			() => accessor.get(INotificationsCenter).show(),
			AccessibilityVerbositySettingId.Notifications,
		);
		provider.onDidChangeContent = (listener, thisArgs, disposables) => {
			const lifetime = new DisposableStore();
			lifetime.add(notifications.onDidAdd(() => listener.call(thisArgs), undefined, disposables));
			lifetime.add(notifications.onDidRemove(() => listener.call(thisArgs), undefined, disposables));
			return lifetime;
		};
		return provider;
	},
});
