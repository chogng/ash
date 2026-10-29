import { localize } from '../../../../nls.js';
import {
	AccessibleContentProvider,
	AccessibleViewProviderId,
	AccessibleViewType,
	AccessibilityVerbositySettingId,
} from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';

import { INotificationsCenter, NotificationsFocusedContext } from './notificationsCenter.js';
import { DisposableMap, DisposableStore } from '../../../../base/common/lifecycle.js';
import { Severity } from '../../../../platform/notification/common/notification.js';
import type { NotificationItem } from '../../../common/notifications.js';

AccessibleViewRegistry.register({
	type: AccessibleViewType.Help,
	priority: 100,
	name: 'notificationsHelp',
	when: NotificationsFocusedContext.isEqualTo(true),
	getProvider: accessor =>
		new AccessibleContentProvider(
			AccessibleViewProviderId.Notifications,
			{ type: AccessibleViewType.Help },
			() =>
				localize(
					'notifications.accessibilityHelp',
					'Notification Center\nUse Tab and Shift+Tab to move between notifications and actions. On a notification, use Up and Down Arrow or Home and End to navigate, Right and Left Arrow to expand or collapse, and Enter or Space to toggle details. Use Ctrl+Enter (Command+Enter on macOS) to run its first action. Delete, Command+Backspace on macOS, or a middle-click removes a notification when it is not running. In the header toolbar, use Left and Right Arrow to move between actions, Home and End to jump to the first and last actions, and Up or Down Arrow to open a configuration menu. When a notification has more actions, focus its More Actions button and press Enter or an arrow key to open the menu. Right-click a notification, or press the Context Menu key or Shift+F10, and choose Copy Text to copy its message. Press Escape to close the menu and return to the notification. Press Delete on a notification to remove it. Press Escape to close the center. When a notification toast or one of its actions has focus, press Escape to hide the toasts without removing them from history. Press <keybinding:editor.action.accessibleView> to read the notification history.',
				) +
				'\n' +
				localize(
					'notifications.doNotDisturbHelp',
					'Use Configure Do Not Disturb to silence information and warning notifications globally or by source. Checked sources allow all notifications. Errors still appear, and all notifications remain available in the center. Opening the center marks notifications as read.',
				) +
				'\n' +
				localize(
					'notifications.positionProgressHelp',
					'Use Configure Notifications Position to choose Bottom Right, Bottom Left, or Top Right. The top-right notification button is in the title bar. Running notifications cannot be removed with Delete or Clear All; use their Cancel action when available. Hidden progress appears in the status bar. Select it to open the notification center.',
				) +
				'\n' +
				localize(
					'notifications.toastLifetimeHelp',
					'Ordinary notification toasts hide automatically and remain in history. Hover or focus a toast to keep it visible. Running progress, pinned notifications, and errors with primary actions stay visible until their pending state ends or you dismiss them.',
				) +
				'\n' +
				localize(
					'notifications.agentsWindowInvitationHelp',
					'An Agents Window invitation has a Continue in Agents Window action. Use Tab to reach it and Enter or Space to open the conversation. The unsent draft transfers only after the target window confirms receipt; a failed handoff preserves it.',
				),
			() => accessor.get(INotificationsCenter).show(),
			AccessibilityVerbositySettingId.Notifications,
		),
});

AccessibleViewRegistry.register({
	type: AccessibleViewType.View,
	priority: 100,
	name: 'notificationsView',
	when: NotificationsFocusedContext.isEqualTo(true),
	getProvider: accessor => {
		const notifications = accessor.get(INotificationsCenter).model;
		const provider = new AccessibleContentProvider(
			AccessibleViewProviderId.Notifications,
			{ type: AccessibleViewType.View },
			() =>
				notifications
					.getNotifications()
					.map(item => {
						const details = [`${Severity[item.severity].toLowerCase()}: ${item.message}`];
						if (item.source) details.push(localize('notifications.source', 'Source: {0}', item.source));
						if (item.hasActiveProgress) {
							details.push(
								item.progress?.total && item.progress.total > 0
									? localize(
											'notifications.progressPercent',
											'{0}% complete',
											Math.round(
												Math.max(
													0,
													Math.min(1, (item.progress.worked ?? 0) / item.progress.total),
												) * 100,
											),
										)
									: localize('notifications.progressDescription', 'In progress'),
							);
						}
						return details.join('\n');
					})
					.join('\n') || localize('notifications.empty', 'No notifications'),
			() => accessor.get(INotificationsCenter).show(),
			AccessibilityVerbositySettingId.Notifications,
		);
		provider.onDidChangeContent = (listener, thisArgs, disposables) => {
			const lifetime = new DisposableStore();
			const items = lifetime.add(new DisposableMap<number>());
			const observe = (item: NotificationItem): void => {
				items.set(
					item.id,
					item.onDidChange(() => listener.call(thisArgs)),
				);
			};
			for (const item of notifications.getNotifications()) observe(item);
			lifetime.add(
				notifications.onDidAdd(item => {
					observe(item);
					listener.call(thisArgs);
				}),
			);
			lifetime.add(
				notifications.onDidRemove(item => {
					items.deleteAndDispose(item.id);
					listener.call(thisArgs);
				}),
			);
			if (Array.isArray(disposables)) disposables.push(lifetime);
			else disposables?.add(lifetime);
			return lifetime;
		};
		return provider;
	},
});
