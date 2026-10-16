import '../browser/screenshot.contribution.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IScreenshotService } from '../common/screenshot.js';
import { DesktopScreenshotService } from './desktopScreenshotService.js';

import { Disposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IPreferencesService } from '../../../services/preferences/common/preferences.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../common/contributions.js';
import { localize } from '../../../../nls.js';

registerSingleton(IScreenshotService, DesktopScreenshotService, InstantiationType.Delayed);

class ScreenshotShortcutContribution extends Disposable {
	private readonly warning = this._register(new MutableDisposable());
	constructor(
		@IScreenshotService screenshot: IScreenshotService,
		@INotificationService notifications: INotificationService,
		@IPreferencesService preferences: IPreferencesService
	) {
		super();
		this._register(
			screenshot.onDidChangeShortcut(() => {
				if (screenshot.shortcutStatus.availability !== 'unavailable') {
					this.warning.clear();
					return;
				}
				if (this.warning.value) return;
				const warning = notifications.warning(
					localize(
						'screenshot.shortcut.conflictNotice',
						'The screenshot shortcut is unavailable. Another application, such as QQ, or the system may use it. Change the shortcut in Screenshot settings.'
					),
					[
						{
							id: 'screenshot.openSettings',
							label: localize('screenshot.shortcut.openSettings', 'Screenshot Settings'),
							run: () => preferences.openSettings({ section: 'screenshot' })
						}
					]
				);
				this.warning.value = toDisposable(() => warning.close());
			})
		);
		void screenshot.checkShortcut();
	}
}

registerWorkbenchContribution('workbench.contrib.screenshotShortcut', WorkbenchPhase.AfterRestored, (accessor) =>
	accessor.get(IInstantiationService).createInstance(ScreenshotShortcutContribution)
);
