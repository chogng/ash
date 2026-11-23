import { INotificationService } from '../../../../platform/notification/common/notification.js';

/** Error feedback for an admitted resource editor, scoped to its provider and window. */
export class ResourceEditorNotifications {
	constructor(
		private readonly signal: AbortSignal,
		@INotificationService private readonly notifications: INotificationService,
	) { }

	error(message: string): void {
		if (this.signal.aborted) return;
		if (typeof message !== 'string') throw new TypeError('Resource editor notification must be text');
		this.notifications.error(message);
	}
}
