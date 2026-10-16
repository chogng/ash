import { ScreenshotGlobalShortcutSetting } from '../common/screenshot.js';
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
		get title() { return localize('screenshot.global.title', 'Capture while Ash is in the background'); },
		get description() { return localize('screenshot.global.description', 'Register the screenshot shortcut with the system. If a new shortcut cannot be registered, the previous working global shortcut remains active.'); },
	}
});
