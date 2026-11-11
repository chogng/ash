import { localize } from '../../nls.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, type IConfigurationRegistry } from '../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../platform/registry/common/platform.js';
import { ActivityBarPosition } from '../../workbench/common/configuration.js';

export type SessionsLayoutStyle = 'modern' | 'flat';

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

export const SESSIONS_GENERAL_SETTINGS_TAG = 'sessionsGeneral';

export type SessionsActivityBarLocation = Exclude<ActivityBarPosition, ActivityBarPosition.HIDDEN>;

/** Appearance preferences owned by the dedicated Sessions window. */
export const SessionsConfiguration = Object.freeze({
	interfaceFontFamily: configurationRegistry.registerConfiguration<'ash-sans' | 'system'>({
		key: 'sessions.interfaceFontFamily',
		defaultValue: 'ash-sans',
		scope: ConfigurationScope.APPLICATION,
		parse(value: unknown) {
			if (value === 'ash-sans' || value === 'system') return value;
			throw new TypeError(localize('sessions.interfaceFontFamily.invalid', 'Choose Ash Sans or System font.'));
		},
		setting: {
			included: false,
			valueType: 'select',
			get title() { return localize('sessions.interfaceFontFamily.title', 'Interface font'); },
			get description() { return localize('sessions.interfaceFontFamily.description', 'Choose the font for Agent Window navigation, menus, tabs, and controls.'); },
			get options() {
				return [
					{ value: 'ash-sans', label: 'Ash Sans' },
					{ value: 'system', label: localize('sessions.interfaceFontFamily.system', 'System font') },
				] as const;
			},
		},
	}),
	activityBarLocation: configurationRegistry.registerConfiguration<SessionsActivityBarLocation>({
		key: 'sessions.activityBar.location',
		defaultValue: ActivityBarPosition.DEFAULT,
		parse(value: unknown): SessionsActivityBarLocation {
			if (value === ActivityBarPosition.DEFAULT) return ActivityBarPosition.DEFAULT;
			if (value === ActivityBarPosition.TOP) return ActivityBarPosition.TOP;
			if (value === ActivityBarPosition.BOTTOM) return ActivityBarPosition.BOTTOM;
			// Restore navigation for profiles that saved the former Hidden option.
			if (value === ActivityBarPosition.HIDDEN) return ActivityBarPosition.DEFAULT;
			throw new TypeError(`Unknown Sessions Activity Bar location: ${String(value)}`);
		},
		setting: {
			included: false,
			valueType: 'select',
			get title() { return localize('sessions.activityBar.location.title', 'Activity Bar position'); },
			get description() { return localize('sessions.activityBar.location.description', 'Place the Activity Bar on the side, top, or bottom.'); },
			get options() {
				return [
					{ value: ActivityBarPosition.DEFAULT, label: localize('workbench.activityBar.location.side', 'Side') },
					{ value: ActivityBarPosition.TOP, label: localize('workbench.activityBar.location.top', 'Top') },
					{ value: ActivityBarPosition.BOTTOM, label: localize('workbench.activityBar.location.bottom', 'Bottom') },
				] as const;
			}
		},
	}),
	showSessionActivityBar: configurationRegistry.registerConfiguration<boolean>({
		key: 'sessions.showSessionActivityBar',
		defaultValue: false,
		schema: { type: 'boolean' },
		parse(value: unknown): boolean {
			if (typeof value !== 'boolean') throw new TypeError(localize('sessions.sessionActivityBar.invalid', 'Choose whether to show the Session Activity Bar.'));
			return value;
		},
		setting: {
			included: false,
			valueType: 'boolean',
			get title() { return localize('sessions.sessionActivityBar.title', 'Session Activity Bar'); },
			get description() { return localize('sessions.sessionActivityBar.description', 'Show Code tool shortcuts beside the conversation.'); },
		},
	}),
	layoutStyle: configurationRegistry.registerConfiguration<SessionsLayoutStyle>({
		key: 'sessions.layoutStyle',
		defaultValue: 'modern',
		parse(value: unknown): SessionsLayoutStyle {
			if (value === 'modern' || value === 'flat') return value;
			throw new TypeError(`Unknown Sessions layout style: ${String(value)}`);
		},
		setting: {
			included: false,
			valueType: 'select',
			get title() { return localize('sessions.layoutStyle.title', 'Layout style'); },
			get description() { return localize('sessions.layoutStyle.description', 'Flat places panes edge to edge. Modern uses inset tool cards and rounded lower corners.'); },
			get options() {
				return [
					{ value: 'modern', label: localize('sessions.layoutStyle.modern', 'Modern') },
					{ value: 'flat', label: localize('sessions.layoutStyle.flat', 'Flat') },
				] as const;
			}
		},
	}),
});
