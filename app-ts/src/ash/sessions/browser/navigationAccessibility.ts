import { localize } from '../../nls.js';
import { AccessibilityVerbositySettingId } from '../../platform/accessibility/browser/accessibleView.js';
import { Extensions, type IConfigurationRegistry } from '../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../platform/registry/common/platform.js';

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: AccessibilityVerbositySettingId.SessionsNavigation,
	defaultValue: true,
	parse(value: unknown): boolean {
		if (typeof value !== 'boolean') throw new TypeError('Sessions navigation accessibility verbosity must be boolean');
		return value;
	},
	setting: {
		valueType: 'boolean',
		title: localize('sessions.navigation.verbosityTitle', 'Sessions navigation accessibility help'),
		description: localize('sessions.navigation.verbosityDescription', 'Announce how to open accessibility help when the Sessions navigation bar receives focus.'),
	},
});
