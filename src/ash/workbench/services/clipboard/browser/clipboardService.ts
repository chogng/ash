import { getWindow } from '../../../../base/browser/dom.js';
import { DisposableMap, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { BrowserClipboardService as BaseBrowserClipboardService } from '../../../../platform/clipboard/browser/clipboardService.js';
import type { IClipboardItem } from '../../../../platform/clipboard/common/clipboardService.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';

/** Adds window-scoped permission recovery to the browser clipboard adapter. */
export class BrowserClipboardService extends BaseBrowserClipboardService {
	private readonly pendingReads = this._register(new DisposableMap<number>());

	constructor(
		@INotificationService private readonly notificationService: INotificationService,
		@IOpenerService private readonly openerService: IOpenerService,
		@ILogService private readonly logService: ILogService,
		@ILayoutService layoutService: ILayoutService,
	) {
		super(getWindow(layoutService.mainContainer).navigator.clipboard);
	}

	public override async readText(type?: string): Promise<string> {
		return this.readWithRetry(() => super.readText(type), '');
	}

	public override async read(): Promise<readonly IClipboardItem[]> {
		return this.readWithRetry(() => super.read(), []);
	}

	private async readWithRetry<T>(read: () => Promise<T>, empty: T): Promise<T> {
		while (!this.isDisposed) {
			try {
				const value = await read();
				return this.isDisposed ? empty : value;
			} catch (error) {
				if (this.isDisposed) {
					return empty;
				}
				this.logService.warn('Unable to read the browser clipboard', error);
				if (!await this.waitForRetry()) {
					return empty;
				}
			}
		}
		return empty;
	}

	private waitForRetry(): Promise<boolean> {
		return new Promise(resolve => {
			const handle = this.notificationService.error(
				localize('clipboard.readError', 'Unable to read the clipboard. Allow this website to access your clipboard, then retry.'),
				[
					{
						id: 'clipboard.retry',
						label: localize('clipboard.retry', 'Retry'),
						run: () => {
							resolve(true);
							this.pendingReads.deleteAndDispose(handle.item.id);
						},
					},
					{
						id: 'clipboard.learnMore',
						label: localize('clipboard.learnMore', 'Learn More'),
						run: async () => {
							await this.openerService.open('https://support.google.com/chrome/answer/114662', { openExternal: true });
						},
					},
				],
			);
			const listener = this.notificationService.onDidRemove(item => {
				if (item.id === handle.item.id) {
					this.pendingReads.deleteAndDispose(item.id);
				}
			});
			// Closing the prompt or disposing its window completes the waiting paste.
			this.pendingReads.set(handle.item.id, toDisposable(() => {
				listener.dispose();
				handle.close();
				resolve(false);
			}));
			if (!this.notificationService.getNotifications().some(item => item.id === handle.item.id)) {
				this.pendingReads.deleteAndDispose(handle.item.id);
			}
		});
	}
}
