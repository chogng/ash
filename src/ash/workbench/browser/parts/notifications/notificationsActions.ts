import type { IAction } from '../../../../base/common/actions.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import type { NotificationItem } from '../../../../platform/notification/common/notification.js';
import { localize } from '../../../../nls.js';

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
