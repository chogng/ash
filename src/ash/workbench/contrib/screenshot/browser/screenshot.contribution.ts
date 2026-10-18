import { Disposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { Severity, INotificationService } from '../../../../platform/notification/common/notification.js';
import { IPreferencesService } from '../../../services/preferences/common/preferences.js';
import { IScreenshotService, ScreenshotCommandId, ScreenshotGlobalShortcutSetting } from '../common/screenshot.js';
import { localize } from '../../../../nls.js';
import { AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import {
	ConfigurationScope,
	Extensions,
	type IConfigurationRegistry
} from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';

const configurationRegistry = Registry.as<IConfigurationRegistry>(Extensions.Configuration);

configurationRegistry.registerConfiguration<boolean>({
	key: AccessibilityVerbositySettingId.ChatScreenshot,
	defaultValue: true,
	scope: ConfigurationScope.WINDOW,
	schema: { type: 'boolean' },
	parse(value: unknown): boolean {
		if (typeof value !== 'boolean')
			throw new TypeError(
				localize('chat.screenshot.verbosityInvalid', 'Screenshot accessibility hints must be boolean.')
			);
		return value;
	},
	setting: {
		valueType: 'boolean',
		get title() {
			return localize('chat.screenshot.verbosityTitle', 'Screenshot accessibility help');
		},
		get description() {
			return localize(
				'chat.screenshot.verbosityDescription',
				'Announce how to open accessibility help during screen capture.'
			);
		}
	}
});


configurationRegistry.registerConfiguration<boolean>({
	key: ScreenshotGlobalShortcutSetting,
	defaultValue: false,
	scope: ConfigurationScope.APPLICATION,
	schema: { type: 'boolean' },
	parse(value: unknown): boolean {
		if (typeof value !== 'boolean') throw new TypeError(localize('screenshot.global.invalid', 'The background screenshot shortcut setting must be boolean.'));
		return value;
	},
	setting: {
		valueType: 'boolean',
		get title() { return localize('screenshot.global.title', 'Global screenshot shortcut'); },
		get description() { return localize('screenshot.global.description', 'Allow the screenshot shortcut to work while Ash is in the background.'); },
	}
});

/** Reports global registration failures without interrupting capture or asking for screen access. */
export class ScreenshotShortcutContribution extends Disposable {
	private readonly warning = this._register(new MutableDisposable());
	private warningMessage = '';

	constructor(
		@IScreenshotService private readonly screenshot: IScreenshotService,
		@INotificationService private readonly notifications: INotificationService,
		@IPreferencesService private readonly preferences: IPreferencesService
	) {
		super();
		this._register(screenshot.onDidChangeShortcut(() => this.updateWarning()));
		void screenshot.checkShortcut();
	}

	private updateWarning(): void {
		const status = this.screenshot.shortcutStatus;
		let message = '';
		if (status.global) {
			switch (status.availability) {
				case 'unavailable':
					message = localize('screenshot.shortcut.conflictNotice', 'The global screenshot shortcut could not be registered. Another application or the system may use it.');
					break;
				case 'unsupported':
					message = localize('screenshot.shortcut.unsupportedNotice', 'This screenshot shortcut cannot be used globally. Choose another key combination.');
					break;
				case 'unassigned':
					message = localize('screenshot.shortcut.unassignedNotice', 'Assign a screenshot shortcut to use global screenshots.');
					break;
				case 'unknown':
					message = localize('screenshot.shortcut.failedNotice', 'Could not enable the global screenshot shortcut. Try changing the shortcut.');
					break;
			}
		}
		if (message && status.activeLabel) {
			message += ' ' + localize('screenshot.shortcut.previousActive', 'The previous shortcut still works: {0}.', status.activeLabel);
		}
		// Dismissed failures stay quiet until the state changes; a changed retained
		// shortcut replaces the notice so it never describes an obsolete binding.
		if (message === this.warningMessage) return;
		this.warningMessage = message;
		this.warning.clear();
		if (!message) return;
		const warning = this.notifications.notify({
			severity: Severity.Warning, message: message, actions: {
				primary: [{
					tooltip: '',
					enabled: true,
					id: 'screenshot.changeShortcut',
					label: localize('screenshot.shortcut.changeKeybinding', 'Change Shortcut'),
					run: () => this.preferences.openGlobalKeybindingSettings(false, { query: `@command:${ScreenshotCommandId}` })
				}]
			}
		});
		this.warning.value = toDisposable(() => warning.close());
	}
}
