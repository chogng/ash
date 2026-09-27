import { localize } from '../../nls.js';
import { Extensions as ConfigurationExtensions, type IConfigurationRegistry } from '../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../platform/registry/common/platform.js';
import { ActivityBarPosition } from '../../workbench/common/configuration.js';

export type SessionsLayoutStyle = 'modern' | 'flat';

const configurationRegistry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);

/** Appearance preferences owned by the dedicated Sessions window. */
export const SessionsConfiguration = Object.freeze({
	activityBarLocation: configurationRegistry.registerConfiguration<ActivityBarPosition>({
		key: 'sessions.activityBar.location',
		defaultValue: ActivityBarPosition.DEFAULT,
		parse(value: unknown): ActivityBarPosition {
			if (value === ActivityBarPosition.DEFAULT) return ActivityBarPosition.DEFAULT;
			if (value === ActivityBarPosition.TOP) return ActivityBarPosition.TOP;
			if (value === ActivityBarPosition.BOTTOM) return ActivityBarPosition.BOTTOM;
			if (value === ActivityBarPosition.HIDDEN) return ActivityBarPosition.HIDDEN;
			throw new TypeError(`Unknown Sessions Activity Bar location: ${String(value)}`);
		},
		setting: {
			valueType: 'select',
			get title() { return localize('sessions.activityBar.location.title', 'Sessions Activity Bar Position'); },
			get description() { return localize('sessions.activityBar.location.description', 'Choose where the Sessions Activity Bar appears.'); },
			get options() {
				return [
					{ value: ActivityBarPosition.DEFAULT, label: localize('workbench.activityBar.location.side', 'Side') },
					{ value: ActivityBarPosition.TOP, label: localize('workbench.activityBar.location.top', 'Top') },
					{ value: ActivityBarPosition.BOTTOM, label: localize('workbench.activityBar.location.bottom', 'Bottom') },
					{ value: ActivityBarPosition.HIDDEN, label: localize('workbench.activityBar.location.hidden', 'Hidden') },
				] as const;
			},
		},
	}),
	activityBarCompact: configurationRegistry.registerConfiguration<boolean>({
		key: 'sessions.activityBar.compact',
		defaultValue: false,
		parse(value: unknown): boolean {
			if (typeof value === 'boolean') return value;
			throw new TypeError(`Invalid Sessions Activity Bar compact value: ${String(value)}`);
		},
		setting: {
			valueType: 'boolean',
			get title() { return localize('sessions.activityBar.compact.title', 'Compact Sessions Activity Bar'); },
			get description() { return localize('sessions.activityBar.compact.description', 'Use smaller buttons when the Sessions Activity Bar is on the side.'); },
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
			valueType: 'select',
			get title() { return localize('sessions.layoutStyle.title', 'Sessions layout style'); },
			get description() { return localize('sessions.layoutStyle.description', 'Choose floating Modern surfaces or edge-to-edge Flat regions in the Sessions window.'); },
			get options() {
				return [
					{ value: 'modern', label: localize('sessions.layoutStyle.modern', 'Modern') },
					{ value: 'flat', label: localize('sessions.layoutStyle.flat', 'Flat') },
				] as const;
			},
		},
	}),
});
