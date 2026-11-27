import { localize } from '../../nls.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, type IConfigurationRegistry } from '../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../platform/registry/common/platform.js';
import { ActivityBarPosition, type SideBarLocation } from '../../workbench/common/configuration.js';

export type SessionsLayoutStyle = 'modern' | 'flat';
export type SessionsBackgroundColor = 'warm' | 'cool';
const detailsPositions = ['top', 'bottom', 'left', 'right', 'floating'] as const;
export type SessionsDetailsPosition = (typeof detailsPositions)[number];

const configurationRegistry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);

export const SESSIONS_GENERAL_SETTINGS_TAG = 'sessionsGeneral';

export type SessionsActivityBarLocation = Exclude<ActivityBarPosition, ActivityBarPosition.HIDDEN> | SideBarLocation;

export function getSessionsActivityBarLocationOptions(): readonly { value: SessionsActivityBarLocation; label: string; }[] {
	return [
		{ value: ActivityBarPosition.DEFAULT, get label() { return localize('workbench.activityBarPositionDefault', 'Default'); } },
		{ value: 'left', get label() { return localize('workbench.sideBar.location.left', 'Left'); } },
		{ value: 'right', get label() { return localize('workbench.sideBar.location.right', 'Right'); } },
		{ value: ActivityBarPosition.TOP, get label() { return localize('workbench.activityBarPositionTop', 'Top'); } },
		{ value: ActivityBarPosition.BOTTOM, get label() { return localize('workbench.activityBarPositionBottom', 'Bottom'); } },
	];
}

/** Appearance preferences owned by the dedicated Sessions window. */
export const SessionsConfiguration = Object.freeze({
	detailsPosition: configurationRegistry.registerConfiguration<SessionsDetailsPosition>({
		key: 'sessions.detailsPosition',
		defaultValue: 'right',
		scope: ConfigurationScope.APPLICATION,
		schema: { type: 'string', enum: [...detailsPositions] },
		parse(value: unknown): SessionsDetailsPosition {
			const position = detailsPositions.find(position => position === value);
			if (position) return position;
			throw new TypeError(`Unknown Sessions details position: ${String(value)}`);
		},
	}),
	chatInputLayout: configurationRegistry.registerConfiguration<'compact' | 'stacked'>({
		key: 'sessions.chat.inputLayout',
		defaultValue: 'compact',
		scope: ConfigurationScope.APPLICATION,
		schema: { type: 'string', enum: ['compact', 'stacked'] },
		parse(value: unknown) {
			if (value === 'compact' || value === 'stacked') return value;
			throw new TypeError(localize('sessions.chat.inputLayout.invalid', 'Choose Single line or Stacked.'));
		},
		setting: {
			included: false,
			valueType: 'select',
			get title() { return localize('sessions.chat.inputLayout.title', 'Chat input layout'); },
			get description() { return localize('sessions.chat.inputLayout.description', 'Single line expands as text grows. Stacked keeps the controls below the text.'); },
			get options() {
				return [
					{ value: 'compact', label: localize('sessions.chat.inputLayout.compact', 'Single line') },
					{ value: 'stacked', label: localize('sessions.chat.inputLayout.stacked', 'Stacked') },
				] as const;
			},
		},
	}),
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
	backgroundColor: configurationRegistry.registerConfiguration<SessionsBackgroundColor>({
		key: 'sessions.backgroundColor',
		defaultValue: 'warm',
		scope: ConfigurationScope.APPLICATION,
		schema: { type: 'string', enum: ['warm', 'cool'] },
		parse(value: unknown): SessionsBackgroundColor {
			if (value === 'warm' || value === 'cool') return value;
			throw new TypeError(localize('sessions.backgroundColor.invalid', 'Choose Warm or Cool.'));
		},
		setting: {
			included: false,
			valueType: 'select',
			get title() { return localize('sessions.backgroundColor.title', 'Background color'); },
			get description() { return localize('sessions.backgroundColor.description', 'Choose a warm or pure white background for the conversation and editor area in light themes.'); },
			get options() {
				return [
					{ value: 'warm', label: localize('sessions.backgroundColor.warm', 'Warm') },
					{ value: 'cool', label: localize('sessions.backgroundColor.cool', 'Cool') },
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
			if (value === 'left' || value === 'right') return value;
			// Restore navigation for profiles that saved the former Hidden option.
			if (value === ActivityBarPosition.HIDDEN) return ActivityBarPosition.DEFAULT;
			throw new TypeError(`Unknown Sessions Activity Bar location: ${String(value)}`);
		},
		setting: {
			included: false,
			valueType: 'select',
			get title() { return localize('sessions.activityBar.location.title', 'Activity Bar position'); },
			get description() { return localize('sessions.activityBar.location.description', 'Choose the default layout or place the Activity Bar on the left, right, top, or bottom of the sidebar.'); },
			get options() { return getSessionsActivityBarLocationOptions(); },
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
		defaultValue: 'flat',
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
