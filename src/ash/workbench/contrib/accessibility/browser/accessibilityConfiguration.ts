import { localize } from '../../../../nls.js';
import { AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { ConfigurationScope, Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { AccessibilitySignal } from '../../../../platform/accessibilitySignal/browser/accessibilitySignalService.js';

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: AccessibilityVerbositySettingId.Terminal,
	defaultValue: true,
	parse(value: unknown): boolean {
		if (typeof value !== 'boolean') throw new TypeError(localize('terminal.accessibility.invalidVerbosity', 'Terminal accessibility verbosity must be boolean.'));
		return value;
	},
	setting: {
		valueType: 'boolean',
		get title() { return localize('terminal.accessibility.verbosityTitle', 'Terminal accessibility help'); },
		get description() { return localize('terminal.accessibility.verbosityDescription', 'Announce how to open accessibility help when the terminal receives focus.'); },
	},
});

for (const signal of AccessibilitySignal.allAccessibilitySignals) {
	const hasAnnouncement = signal.announcementMessage !== undefined;
	Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
		key: signal.settingsKey,
		scope: ConfigurationScope.WINDOW,
		defaultValue: hasAnnouncement ? { sound: 'auto', announcement: 'off' } : { sound: 'auto' },
		parse(value: unknown): { sound: string; announcement?: string; } {
			const invalid = (): TypeError => new TypeError(hasAnnouncement
				? localize('accessibility.signals.policy.invalid', 'Signals require sound (auto, on, off) and announcement (auto, off).')
				: localize('accessibility.signals.sound.invalid', 'This signal requires sound (auto, on, off).'));
			if (typeof value !== 'object' || value === null || Array.isArray(value)) { throw invalid(); }
			const policy = value as Record<string, unknown>;
			if (Object.keys(policy).some(key => key !== 'sound' && (key !== 'announcement' || !hasAnnouncement))
				|| typeof policy.sound !== 'string' || !['auto', 'on', 'off'].includes(policy.sound)
				|| (hasAnnouncement && (typeof policy.announcement !== 'string' || !['auto', 'off'].includes(policy.announcement)))) {
				throw invalid();
			}
			return hasAnnouncement ? { sound: policy.sound, announcement: policy.announcement as string } : { sound: policy.sound };
		},
		schema: {
			type: 'object', additionalProperties: false, required: hasAnnouncement ? ['sound', 'announcement'] : ['sound'],
			properties: {
				sound: { type: 'string', enum: ['auto', 'on', 'off'] },
				...(hasAnnouncement ? { announcement: { type: 'string', enum: ['auto', 'off'] } } : {}),
			},
		},
		setting: {
			valueType: 'stringMap',
			get title() { return signal.name; },
			get description() {
				if (signal === AccessibilitySignal.progress) {
					return localize('accessibility.signals.progress.description', 'Play a cue every five seconds while workspace tasks run, starting after five seconds. Sound accepts auto, on, off; announcement accepts auto, off. Auto follows screen reader optimization. Changes apply immediately.');
				}
				return hasAnnouncement
					? localize('accessibility.signals.policy.description', 'Sound accepts auto, on, off; announcement accepts auto, off. Auto follows screen reader optimization. Changes apply immediately.')
					: localize('accessibility.signals.sound.description', 'Sound accepts auto, on, off. Auto follows screen reader optimization. Changes apply immediately.');
			},
			get keyLabel() { return localize('accessibility.signals.progress.key', 'Modality'); },
			get valueLabel() { return localize('accessibility.signals.progress.value', 'Mode'); },
			get addLabel() { return localize('accessibility.signals.progress.add', 'Add modality'); },
			get removeLabel() { return localize('accessibility.signals.progress.remove', 'Remove modality'); },
			get incompleteMessage() { return localize('accessibility.signals.progress.incomplete', 'Enter a modality and mode.'); },
			get duplicateMessage() { return localize('accessibility.signals.progress.duplicate', 'Each modality can appear only once.'); },
		},
	});
}

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: 'accessibility.signalOptions.volume',
	scope: ConfigurationScope.WINDOW,
	defaultValue: 70,
	parse(value: unknown): number {
		if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
			throw new TypeError(localize('accessibility.signals.volume.invalid', 'Signal volume must be between 0 and 100.'));
		}
		return value;
	},
	schema: { type: 'number', minimum: 0, maximum: 100 },
	setting: {
		valueType: 'number', minimum: 0, maximum: 100,
		get title() { return localize('accessibility.signals.volume.title', 'Signal volume'); },
		get description() { return localize('accessibility.signals.volume.description', 'Set the volume of accessibility sounds from 0 to 100 percent. Changes apply immediately.'); },
	},
});

export const accessibilityHelpIsShown = new RawContextKey<boolean>('accessibilityHelpIsShown', false);
export const accessibleViewIsShown = new RawContextKey<boolean>('accessibleViewIsShown', false);
export const accessibleViewVerbosityEnabled = new RawContextKey<boolean>('accessibleViewVerbosityEnabled', false);
export const accessibleViewCurrentProviderId = new RawContextKey<string>('accessibleViewCurrentProviderId', '');

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: AccessibilityVerbositySettingId.ProcessExplorer, defaultValue: true,
	parse(value: unknown): boolean {
		if (typeof value !== 'boolean') { throw new TypeError(localize('processExplorer.verbosityInvalid', 'Process explorer accessibility verbosity must be a boolean.')); }
		return value;
	},
	setting: {
		valueType: 'boolean',
		get title() { return localize('processExplorer.verbosityTitle', 'Process explorer accessibility help'); },
		get description() { return localize('processExplorer.verbosityDescription', 'Announce how to open accessibility help when the process explorer receives focus.'); },
	},
});

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: AccessibilityVerbositySettingId.Scm,
	defaultValue: true,
	parse(value: unknown): boolean {
		if (typeof value !== 'boolean') throw new TypeError(localize('scm.welcome.verbosityInvalid', 'Source control accessibility verbosity must be a boolean.'));
		return value;
	},
	setting: {
		valueType: 'boolean',
		get title() { return localize('scm.welcome.verbosityTitle', 'Source control accessibility help'); },
		get description() { return localize('scm.welcome.verbosityDescription', 'Announce how to open accessibility help when source control receives focus.'); },
	},
});

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: AccessibilityVerbositySettingId.Disassembly, defaultValue: true,
	parse(value: unknown): boolean {
		if (typeof value !== 'boolean') { throw new TypeError(localize('debug.disassemblyVerbosityInvalid', 'Disassembly accessibility verbosity must be a boolean.')); }
		return value;
	},
	setting: {
		valueType: 'boolean',
		get title() { return localize('debug.disassemblyVerbosityTitle', 'Disassembly accessibility help'); },
		get description() { return localize('debug.disassemblyVerbosityDescription', 'Announce how to open accessibility help when disassembly receives focus.'); },
	},
});

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: AccessibilityVerbositySettingId.WebviewEditor,
	defaultValue: true,
	parse(value: unknown): boolean {
		if (typeof value !== 'boolean') throw new TypeError(localize('webview.verbosity.invalid', 'Webview editor accessibility verbosity must be a boolean.'));
		return value;
	},
	setting: {
		valueType: 'boolean',
		get title() { return localize('webview.verbosity.title', 'Webview editor accessibility help'); },
		get description() { return localize('webview.verbosity.description', 'Announce how to open accessibility help when a webview editor receives focus.'); },
	},
});

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: AccessibilityVerbositySettingId.ScmInput,
	defaultValue: true,
	parse(value: unknown): boolean {
		if (typeof value !== 'boolean') {
			throw new TypeError(localize('scm.input.verbosityInvalid', 'Source control input accessibility verbosity must be a boolean.'));
		}
		return value;
	},
	setting: {
		valueType: 'boolean',
		get title() { return localize('scm.input.verbosityTitle', 'Source control input accessibility help'); },
		get description() { return localize('scm.input.verbosityDescription', 'Announce how to open accessibility help when the commit message receives focus.'); },
	},
});

export const enum AccessibilityWorkbenchSettingId {
	DimUnfocusedEnabled = 'accessibility.dimUnfocused.enabled',
	DimUnfocusedOpacity = 'accessibility.dimUnfocused.opacity',
}

export const enum ViewDimUnfocusedOpacityProperties {
	Default = 0.75,
	Minimum = 0.2,
	Maximum = 1,
}

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: AccessibilityWorkbenchSettingId.DimUnfocusedEnabled,
	defaultValue: false,
	parse(value: unknown): boolean {
		if (typeof value !== 'boolean') {
			throw new TypeError(localize('accessibility.invalidDimmingEnabled', 'Unfocused view dimming must be a boolean.'));
		}
		return value;
	},
	setting: {
		valueType: 'boolean',
		get title() { return localize('accessibility.dimmingTitle', 'Dim unfocused views'); },
		get description() { return localize('accessibility.dimmingDescription', 'Keep the focused part prominent by reducing the opacity of other parts.'); },
	},
});

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: AccessibilityWorkbenchSettingId.DimUnfocusedOpacity,
	defaultValue: ViewDimUnfocusedOpacityProperties.Default,
	parse(value: unknown): number {
		if (typeof value !== 'number' || !Number.isFinite(value) || value < ViewDimUnfocusedOpacityProperties.Minimum || value > ViewDimUnfocusedOpacityProperties.Maximum) {
			throw new TypeError(localize('accessibility.invalidDimmingOpacity', 'Unfocused view opacity must be between {0} and {1}.', ViewDimUnfocusedOpacityProperties.Minimum, ViewDimUnfocusedOpacityProperties.Maximum));
		}
		return value;
	},
	setting: {
		valueType: 'number',
		minimum: ViewDimUnfocusedOpacityProperties.Minimum,
		maximum: ViewDimUnfocusedOpacityProperties.Maximum,
		get title() { return localize('accessibility.dimmingOpacityTitle', 'Unfocused view opacity'); },
		get description() { return localize('accessibility.dimmingOpacityDescription', 'Choose how visible unfocused parts remain when dimming is enabled.'); },
	},
});

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: AccessibilityVerbositySettingId.Editor,
	defaultValue: true,
	parse(value: unknown): boolean {
		if (typeof value !== 'boolean') {
			throw new TypeError(localize('accessibility.invalidEditorVerbosity', 'Editor accessibility verbosity must be a boolean.'));
		}
		return value;
	},
	setting: {
		valueType: 'boolean',
		get title() { return localize('accessibility.editorVerbosityTitle', 'Editor accessibility help'); },
		get description() { return localize('accessibility.editorVerbosityDescription', 'Announce how to open accessibility help when the editor receives focus.'); },
	},
});

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: AccessibilityVerbositySettingId.ScmRepositories,
	defaultValue: true,
	parse(value: unknown): boolean {
		if (typeof value !== 'boolean') throw new TypeError(localize('scm.repositories.verbosityInvalid', 'Repositories accessibility verbosity must be a boolean.'));
		return value;
	},
	setting: {
		valueType: 'boolean',
		title: localize('scm.repositories.verbosityTitle', 'Repositories accessibility help'),
		description: localize('scm.repositories.verbosityDescription', 'Announce how to open accessibility help when source control repositories receive focus.'),
	},
});

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: AccessibilityVerbositySettingId.ScmHistoryDetails,
	defaultValue: true,
	parse(value: unknown): boolean {
		if (typeof value !== 'boolean') throw new TypeError('SCM history details verbosity must be boolean');
		return value;
	},
	setting: {
		valueType: 'boolean',
		title: localize('scm.history.verbosityTitle', 'Commit details accessibility help'),
		description: localize('scm.history.verbosityDescription', 'Announce how to open accessibility help when commit details receive focus.'),
	},
});

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
	key: AccessibilityVerbositySettingId.Find,
	defaultValue: true,
	parse(value: unknown): boolean {
		if (typeof value !== 'boolean') { throw new TypeError('Search accessibility verbosity must be boolean'); }
		return value;
	},
	setting: {
		valueType: 'boolean',
		title: localize('search.verbosityTitle', 'Search accessibility help'),
		description: localize('search.verbosityDescription', 'Announce how to open accessibility help when search receives focus.'),
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
