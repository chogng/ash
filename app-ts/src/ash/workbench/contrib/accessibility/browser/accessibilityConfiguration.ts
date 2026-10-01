import { localize } from '../../../../nls.js';
import { AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: AccessibilityVerbositySettingId.Chat,
	defaultValue: true,
	parse(value: unknown): boolean {
		if (typeof value !== 'boolean') throw new TypeError('Chat accessibility verbosity must be boolean');
		return value;
	},
	setting: {
		valueType: 'boolean',
		title: localize('accessibility.chatVerbosityTitle', 'Chat accessibility help'),
		description: localize('accessibility.chatVerbosityDescription', 'Announce how to open accessibility help when the Chat input receives focus.'),
	},
});

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: AccessibilityVerbositySettingId.ChatModelConfiguration,
	defaultValue: true,
	parse(value: unknown): boolean {
		if (typeof value !== 'boolean') throw new TypeError('Chat model configuration accessibility verbosity must be boolean');
		return value;
	},
	setting: {
		valueType: 'boolean',
		title: localize('accessibility.chatModelConfigurationVerbosityTitle', 'Chat model configuration accessibility help'),
		description: localize('accessibility.chatModelConfigurationVerbosityDescription', 'Announce how to open accessibility help when the thinking effort control receives focus.'),
	},
});

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: AccessibilityVerbositySettingId.DiffEditor,
	defaultValue: true,
	parse(value: unknown): boolean {
		if (typeof value !== 'boolean') throw new TypeError('Diff editor accessibility verbosity must be boolean');
		return value;
	},
	setting: {
		valueType: 'boolean',
		title: localize('accessibility.diffEditorVerbosityTitle', 'Diff editor accessibility help'),
		description: localize('accessibility.diffEditorVerbosityDescription', 'Announce how to open accessibility help when the diff editor receives focus.'),
	},
});

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: AccessibilityVerbositySettingId.Notifications,
	defaultValue: true,
	parse(value: unknown): boolean {
		if (typeof value !== 'boolean') throw new TypeError('Notifications accessibility verbosity must be boolean');
		return value;
	},
	setting: {
		valueType: 'boolean',
		title: localize('accessibility.notificationsVerbosityTitle', 'Notifications accessibility help'),
		description: localize('accessibility.notificationsVerbosityDescription', 'Announce how to open notification accessibility help when the Notification Center receives focus.'),
	},
});

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: AccessibilityVerbositySettingId.ScmMerge,
	defaultValue: true,
	parse(value: unknown): boolean {
		if (typeof value !== 'boolean') throw new TypeError('SCM merge accessibility verbosity must be boolean');
		return value;
	},
	setting: {
		valueType: 'boolean',
		title: localize({ bundle: 'ash', key: 'git.mergeVerbosityTitle' }, 'Merge editor accessibility help'),
		description: localize({ bundle: 'ash', key: 'git.mergeVerbosityDescription' }, 'Announce how to open merge editor accessibility help when the editor receives focus.'),
	},
});

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: AccessibilityVerbositySettingId.Explorer,
	defaultValue: true,
	parse(value: unknown): boolean {
		if (typeof value !== 'boolean') throw new TypeError('Explorer accessibility verbosity must be boolean');
		return value;
	},
	setting: {
		valueType: 'boolean',
		title: localize('accessibility.explorerVerbosityTitle', 'Explorer accessibility help'),
		description: localize('accessibility.explorerVerbosityDescription', 'Announce how to open accessibility help when the file tree receives focus.'),
	},
});

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: AccessibilityVerbositySettingId.GettingStarted,
	defaultValue: true,
	parse(value: unknown): boolean {
		if (typeof value !== 'boolean') throw new TypeError('Welcome accessibility verbosity must be boolean');
		return value;
	},
	setting: {
		valueType: 'boolean',
		title: localize('accessibility.gettingStartedVerbosityTitle', 'Welcome accessibility help'),
		description: localize('accessibility.gettingStartedVerbosityDescription', 'Announce how to open accessibility help when the Welcome page receives focus.'),
	},
});

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: AccessibilityVerbositySettingId.OpenEditors,
	defaultValue: true,
	parse(value: unknown): boolean {
		if (typeof value !== 'boolean') throw new TypeError('Open Editors accessibility verbosity must be boolean');
		return value;
	},
	setting: {
		valueType: 'boolean',
		title: localize('accessibility.openEditorsVerbosityTitle', 'Open Editors accessibility help'),
		description: localize('accessibility.openEditorsVerbosityDescription', 'Announce how to open accessibility help when the Open Editors list receives focus.'),
	},
});

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: AccessibilityVerbositySettingId.InspectEditorTokens,
	defaultValue: true,
	parse(value: unknown): boolean {
		if (typeof value !== 'boolean') throw new TypeError(localize('inspectEditorTokens.invalidVerbosity', 'Token inspection accessibility verbosity must be boolean'));
		return value;
	},
	setting: {
		valueType: 'boolean',
		get title() { return localize('inspectEditorTokens.verbosityTitle', 'Token inspection accessibility help'); },
		get description() { return localize('inspectEditorTokens.verbosityDescription', 'Announce how to open accessibility help in token inspection.'); },
	},
});
