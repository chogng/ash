import { SubmenuAction, type IAction } from '../../../../base/common/actions.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import type { NotificationItem } from '../../../common/notifications.js';
import { localize } from '../../../../nls.js';

/** Groups source policy and the notification producer's secondary operations. */
export class ConfigureNotificationAction extends SubmenuAction {
	static readonly ID = 'workbench.action.configureNotification';

	constructor(actions: readonly IAction[]) {
		super(
			ConfigureNotificationAction.ID,
			localize('notifications.moreActions', 'More Actions'),
			actions,
			Lxicon.gear,
		);
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
	) {}

	async run(notification: NotificationItem): Promise<void> {
		await this.clipboardService.writeText(notification.message);
	}
}
