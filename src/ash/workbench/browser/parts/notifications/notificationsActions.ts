import { SubmenuAction, type IAction, type IActionRunner } from '../../../../base/common/actions.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import type { NotificationItem } from '../../../common/notifications.js';
import type { INotificationAction } from '../../../../platform/notification/common/notification.js';
import { localize } from '../../../../nls.js';

/** Invoke the producer before firing close listeners. The runner owns late failures. */
export function runPrimaryNotificationAction(action: INotificationAction, runner: IActionRunner, close: () => void): Promise<void> {
	return Promise.resolve().then(() => {
		if (!action.enabled) return;
		const completion = runner.run({
			id: action.id, label: action.label, tooltip: action.tooltip,
			enabled: action.enabled, checked: action.checked, icon: action.icon,
			run: () => action.run(),
		});
		if (!action.keepOpen) close();
		return completion;
	});
}

/** Groups source policy and the notification producer's secondary operations. */
export class ConfigureNotificationAction extends SubmenuAction {
	static readonly ID = 'workbench.action.configureNotification';

	constructor(actions: readonly IAction[]) {
		super(ConfigureNotificationAction.ID, localize('notifications.moreActions', 'More Actions'), actions, Lxicon.gear);
	}
}

/** Copies the model's message; the menu execution owner reports clipboard failures. */
export class CopyNotificationMessageAction implements IAction {
	static readonly ID = 'workbench.action.copyNotificationMessage';
	static readonly LABEL = localize('notifications.copyText', 'Copy Text');
	readonly tooltip = '';
	readonly enabled = true;

	constructor(
		readonly id: string,
		readonly label: string,
		@IClipboardService private readonly clipboardService: IClipboardService,
	) { }

	async run(notification: NotificationItem): Promise<void> {
		await this.clipboardService.writeText(notification.message);
	}
}
