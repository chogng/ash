import { localize } from '../../../../nls.js';
import { Extensions as ConfigurationExtensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';

const configurationRegistry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);

function registerEditorPreference<const T extends string>(key: string, defaultValue: T, values: readonly T[], title: () => string, description: () => string, labels: Readonly<Record<T, () => string>>): string {
	return configurationRegistry.registerConfiguration<string>({
		key, defaultValue,
		schema: { type: 'string', enum: [...values] },
		parse(value: unknown): T {
			if (typeof value === 'string' && (values as readonly string[]).includes(value)) return value as T;
			throw new TypeError(localize({ bundle: 'ash.workbench', key: 'sessions.editor.invalidPreference' }, 'Invalid editor preference.'));
		},
		setting: {
			included: false,
			valueType: 'select',
			get title() { return title(); },
			get description() { return description(); },
			get options() { return values.map(value => ({ value, label: labels[value]() })); },
		},
	});
}

const inherit = () => localize({ bundle: 'ash.workbench', key: 'sessions.editor.inherit' }, 'Use Workbench Setting');
const wordWrapLabels = {
	inherit,
	on: () => localize({ bundle: 'ash.workbench', key: 'sessions.editor.wrapOn' }, 'On'),
	off: () => localize({ bundle: 'ash.workbench', key: 'sessions.editor.wrapOff' }, 'Off'),
} as const;
export const SESSIONS_DIFF_VIEW_MODE = registerEditorPreference('sessions.diffEditor.viewMode', 'inherit', ['inherit', 'automatic', 'inline', 'sideBySide'],
	() => localize({ bundle: 'ash.workbench', key: 'sessions.editor.diffViewMode' }, 'Diff View'),
	() => localize({ bundle: 'ash.workbench', key: 'sessions.editor.diffViewMode.description' }, 'Choose how comparisons are displayed in the Agents Window.'), {
	inherit,
	automatic: () => localize({ bundle: 'ash.workbench', key: 'diffView.automatic' }, 'Automatic'),
	inline: () => localize({ bundle: 'ash.workbench', key: 'diffView.inline' }, 'Inline'),
	sideBySide: () => localize({ bundle: 'ash.workbench', key: 'diffView.sideBySide' }, 'Side by Side'),
});
export const SESSIONS_DIFF_WORD_WRAP = registerEditorPreference('sessions.diffEditor.wordWrap', 'inherit', ['inherit', 'on', 'off'],
	() => localize({ bundle: 'ash.workbench', key: 'sessions.editor.diffWordWrap' }, 'Diff Word Wrap'),
	() => localize({ bundle: 'ash.workbench', key: 'sessions.editor.diffWordWrap.description' }, 'Control line wrapping in Agents Window comparisons.'), wordWrapLabels);
export const SESSIONS_EDITOR_WORD_WRAP = registerEditorPreference('sessions.editor.wordWrap', 'inherit', ['inherit', 'on', 'off'],
	() => localize({ bundle: 'ash.workbench', key: 'sessions.editor.wordWrap' }, 'Editor Word Wrap'),
	() => localize({ bundle: 'ash.workbench', key: 'sessions.editor.wordWrap.description' }, 'Control line wrapping in Agents Window file editors.'), wordWrapLabels);
