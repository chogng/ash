import { localize } from "../../../../nls.js";
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from "../../../../platform/accessibility/browser/accessibleView.js";
import { AccessibleViewRegistry } from "../../../../platform/accessibility/browser/accessibleViewRegistry.js";

import { INotificationsCenter, NotificationsFocusedContext } from "./notificationsCenter.js";
import { DisposableMap, DisposableStore } from '../../../../base/common/lifecycle.js';
import { Severity } from '../../../../platform/notification/common/notification.js';
import type { NotificationItem } from '../../../common/notifications.js';

AccessibleViewRegistry.register({
	type: AccessibleViewType.Help,
	priority: 100,
	name: "notificationsHelp",
	when: NotificationsFocusedContext.isEqualTo(true),
	getProvider: accessor => new AccessibleContentProvider(
		AccessibleViewProviderId.Notifications,
		{ type: AccessibleViewType.Help },
		() => localize('notifications.accessibilityHelp', 'Notification Center\nUse Tab and Shift+Tab to move between notifications and actions. When a notification has more actions, focus its More Actions button and press Enter or an arrow key to open the menu. Right-click a notification, or press the Context Menu key or Shift+F10, and choose Copy Text to copy its message. Press Escape to close the menu and return to the notification. Press Delete on a notification to remove it. Press Escape to close the center. When the Remove notification button in a toast has focus, press Escape to hide the toasts without removing them from history. Press <keybinding:editor.action.accessibleView> to read the notification history.') + '\n' + localize('notifications.agentsWindowInvitationHelp', 'An Agents Window invitation has a Continue in Agents Window action. Use Tab to reach it and Enter or Space to open the conversation. The unsent draft transfers only after the target window confirms receipt; a failed handoff preserves it.'),
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
		const notifications = accessor.get(INotificationsCenter).model;
		const provider = new AccessibleContentProvider(
			AccessibleViewProviderId.Notifications,
			{ type: AccessibleViewType.View },
			() => notifications.getNotifications().map(item => `${Severity[item.severity].toLowerCase()}: ${item.message}`).join('\n') || localize('notifications.empty', 'No notifications'),
			() => accessor.get(INotificationsCenter).show(),
			AccessibilityVerbositySettingId.Notifications,
		);
		provider.onDidChangeContent = (listener, thisArgs, disposables) => {
			const lifetime = new DisposableStore();
			const items = lifetime.add(new DisposableMap<number>());
			const observe = (item: NotificationItem): void => {
				items.set(item.id, item.onDidChange(() => listener.call(thisArgs)));
			};
			for (const item of notifications.getNotifications()) observe(item);
			lifetime.add(notifications.onDidAdd(item => { observe(item); listener.call(thisArgs); }));
			lifetime.add(notifications.onDidRemove(item => { items.deleteAndDispose(item.id); listener.call(thisArgs); }));
			if (Array.isArray(disposables)) disposables.push(lifetime);
			else disposables?.add(lifetime);
			return lifetime;
		};
		return provider;
	},
});
