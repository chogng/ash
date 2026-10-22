import { BrowserStorageService } from '../../../src/ash/workbench/services/storage/browser/storageService.js';
import { NotificationService } from '../../../src/ash/workbench/services/notification/common/notificationService.js';

/** Browser component fixtures own their real notification service and state store together. */
export class TestNotificationService extends NotificationService {
	constructor() {
		const storage = new BrowserStorageService({ ownerWindow: window, workspaceId: 'notifications-integration', flushInterval: 0 });
		super(storage);
		this._register(storage);
	}
}
