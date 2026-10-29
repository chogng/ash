import { ActionRunner, type IAction } from '../../../../base/common/actions.js';
import { getErrorMessage, isCancellationError } from '../../../../base/common/errors.js';
import { Keybinding, logicalKey } from '../../../../base/common/keybindings.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IQuickInputService, type IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { NotificationsPosition, NotificationsSettings } from '../../../common/notifications.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService, NotificationsFilter, type INotificationSourceFilter } from '../../../../platform/notification/common/notification.js';
import { INotificationsCenter } from './notificationsCenter.js';
import './notificationAccessibleView.js';

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

registerAction2(
	class ShowNotificationsAction extends Action2 {
		constructor() {
			super({
				id: 'notifications.showList',
				title: localize2('notifications.showList', 'Show Notifications'),
				f1: true,
				keybinding: {
					primary: Keybinding.chord(logicalKey('k', { primaryKey: true }), logicalKey('n', { primaryKey: true, shiftKey: true })),
				},
			});
		}
		override run(accessor: ServicesAccessor): void {
			accessor.get(INotificationsCenter).show();
		}
	},
);

registerAction2(
	class HideNotificationsAction extends Action2 {
		constructor() {
			super({
				id: 'notifications.hideList',
				title: localize2('notifications.hideList', 'Hide Notifications'),
				f1: true,
			});
		}
		override run(accessor: ServicesAccessor): void {
			accessor.get(INotificationsCenter).hide();
		}
	},
);

registerAction2(
	class ClearNotificationsAction extends Action2 {
		constructor() {
			super({
				id: 'notifications.clearAll',
				title: localize2('notifications.clearAllCommand', 'Clear All Notifications'),
				f1: true,
			});
		}
		override run(accessor: ServicesAccessor): void {
			accessor.get(INotificationsCenter).clearAll();
		}
	},
);

registerAction2(
	class ToggleDoNotDisturbAction extends Action2 {
		constructor() {
			super({
				id: 'notifications.toggleDoNotDisturbMode',
				title: localize2('notifications.toggleDoNotDisturb', 'Toggle Do Not Disturb Mode'),
				f1: true,
			});
		}
		override run(accessor: ServicesAccessor): void {
			const service = accessor.get(INotificationService);
			service.setFilter(service.getFilter() === NotificationsFilter.ERROR ? NotificationsFilter.OFF : NotificationsFilter.ERROR);
		}
	},
);

registerAction2(
	class ToggleDoNotDisturbBySourceAction extends Action2 {
		constructor() {
			super({
				id: 'notifications.toggleDoNotDisturbModeBySource',
				title: localize2('notifications.toggleDoNotDisturbBySource', 'Toggle Do Not Disturb Mode By Source...'),
				f1: true,
			});
		}
		override run(accessor: ServicesAccessor): void {
			const service = accessor.get(INotificationService);
			const lifetime = new DisposableStore();
			const picker = lifetime.add(accessor.get(IQuickInputService).createQuickPick<IQuickPickItem & INotificationSourceFilter>());
			const sources = service.getFilters().sort((a, b) => a.label.localeCompare(b.label));
			picker.items = sources.map(source => ({ ...source, description: source.id }));
			picker.canSelectMany = true;
			picker.ariaLabel = picker.placeholder = localize('notifications.selectSources', 'Select sources to enable all notifications from');
			picker.selectedItems = sources
				.filter(source => source.filter === NotificationsFilter.OFF)
				.map(source => picker.items.find(item => 'id' in item && item.id === source.id) as IQuickPickItem & INotificationSourceFilter);
			lifetime.add(
				picker.onDidAccept(() => {
					const enabled = new Set(picker.selectedItems.map(item => item.id));
					const current = new Map(service.getFilters().map(source => [source.id, source]));
					// Commit only the snapshot the user reviewed. New arrivals retain their own policy.
					for (const source of sources) {
						const latest = current.get(source.id);
						if (latest)
							service.setFilter({
								...latest,
								filter: enabled.has(source.id) ? NotificationsFilter.OFF : NotificationsFilter.ERROR,
							});
					}
					picker.hide();
				}),
			);
			lifetime.add(picker.onDidHide(() => lifetime.dispose()));
			try {
				picker.show();
			} catch (error) {
				lifetime.dispose();
				throw error;
			}
		}
	},
);

registerAction2(
	class ToggleNotificationsAction extends Action2 {
		constructor() {
			super({
				id: 'notifications.toggleList',
				title: localize2('notifications.toggleList', 'Toggle Notifications'),
				icon: Lxicon.bell,
				menu: {
					id: MenuId.TitleBar,
					group: 'navigation',
					order: 10000,
					when: ContextKeyExpr.and(
						ContextKeyExpr.equals(`config.${NotificationsSettings.NOTIFICATIONS_POSITION}`, NotificationsPosition.TOP_RIGHT),
						ContextKeyExpr.equals(`config.${NotificationsSettings.NOTIFICATIONS_BUTTON}`, true),
					),
				},
			});
		}
		override run(accessor: ServicesAccessor): void {
			accessor.get(INotificationsCenter).toggle();
		}
	},
);

for (const [suffix, value, title, order] of [
	['bottomRight', NotificationsPosition.BOTTOM_RIGHT, localize2('notifications.position.bottomRight', 'Bottom Right'), 1],
	['bottomLeft', NotificationsPosition.BOTTOM_LEFT, localize2('notifications.position.bottomLeft', 'Bottom Left'), 2],
	['topRight', NotificationsPosition.TOP_RIGHT, localize2('notifications.position.topRight', 'Top Right'), 3],
] as const) {
	registerAction2(
		class SetNotificationsPositionAction extends Action2 {
			constructor() {
				super({
					id: `workbench.action.setNotificationsPosition.${suffix}`,
					title,
					toggled: ContextKeyExpr.equals(`config.${NotificationsSettings.NOTIFICATIONS_POSITION}`, value),
					menu: { id: MenuId.NotificationsCenterPositionMenu, order },
				});
			}
			override async run(accessor: ServicesAccessor): Promise<void> {
				await accessor.get(IConfigurationService).updateValue(NotificationsSettings.NOTIFICATIONS_POSITION, value);
			}
		},
	);
}
