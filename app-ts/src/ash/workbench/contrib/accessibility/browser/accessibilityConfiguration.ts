import { localize } from '../../../../nls.js';
import { AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: AccessibilityVerbositySettingId.BulkEditPreview,
	defaultValue: true,
	parse(value: unknown): boolean {
		if (typeof value !== 'boolean') throw new TypeError('Refactor preview verbosity must be boolean');
		return value;
	},
	setting: {
		title: localize('bulkEdit.verbosityTitle', 'Refactor preview accessibility help'),
		description: localize('bulkEdit.verbosityDescription', 'Announce how to open accessibility help in the refactor preview.'),
		valueType: 'boolean',
	},
});

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: AccessibilityVerbositySettingId.ChatEditing,
	defaultValue: true,
	parse(value: unknown): boolean { if (typeof value !== 'boolean') { throw new TypeError('Chat Editing verbosity must be boolean'); } return value; },
	setting: { valueType: 'boolean', title: localize('chatEditing.verbosity', 'Agent changes accessibility help'), description: localize('chatEditing.verbosityDescription', 'Announce how to open accessibility help when reviewing Agent changes.') },
});

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: AccessibilityVerbositySettingId.Dictation, defaultValue: true,
	parse(value: unknown): boolean { if (typeof value !== 'boolean') throw new TypeError('Dictation verbosity must be boolean'); return value; },
	setting: { valueType: 'boolean', title: localize('dictation.targetVerbosity', 'Dictation accessibility help'), description: localize('dictation.targetVerbosityDescription', 'Announce how to open accessibility help while dictating in an editor or terminal.') },
});

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: AccessibilityVerbositySettingId.DictationOnboarding, defaultValue: true,
	parse(value: unknown): boolean { if (typeof value !== 'boolean') { throw new TypeError('Dictation introduction verbosity must be boolean'); } return value; },
	setting: { valueType: 'boolean', title: localize({ bundle: 'ash', key: 'dictation.verbosity' }, 'Dictation introduction accessibility help'), description: localize({ bundle: 'ash', key: 'dictation.verbosityDescription' }, 'Announce how to open accessibility help in the dictation introduction.') },
});

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: AccessibilityVerbositySettingId.SessionsChanges,
	defaultValue: true,
	parse(value: unknown): boolean {
		if (typeof value !== 'boolean') { throw new TypeError('Changes accessibility verbosity must be boolean'); }
		return value;
	},
	setting: {
		valueType: 'boolean',
		title: localize('sessions.changes.verbosity.title', 'Changes accessibility help'),
		description: localize('sessions.changes.verbosity.description', 'Announce how to open accessibility help when the Changes view receives focus.'),
	},
});

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
		description: localize('accessibility.chatModelConfigurationVerbosityDescription', 'Announce how to open accessibility help when the model menu or thinking effort control receives focus.'),
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

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: AccessibilityVerbositySettingId.Testing, defaultValue: true,
	parse(value: unknown): boolean { if (typeof value !== 'boolean') { throw new TypeError('Testing verbosity must be boolean'); } return value; },
	setting: { valueType: 'boolean', title: localize('testing.verbosityTitle', 'Testing accessibility help'), description: localize('testing.verbosityDescription', 'Announce how to open accessibility help when the test tree receives focus.') },
});
