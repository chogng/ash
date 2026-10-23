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
			included: false,
			valueType: 'select',
			get title() { return localize('sessions.activityBar.location.title', 'Activity Bar position'); },
			get description() { return localize('sessions.activityBar.location.description', 'Place the Activity Bar on the side, top, or bottom, or hide it.'); },
			get options() {
				return [
					{ value: ActivityBarPosition.DEFAULT, label: localize('workbench.activityBar.location.side', 'Side') },
					{ value: ActivityBarPosition.TOP, label: localize('workbench.activityBar.location.top', 'Top') },
					{ value: ActivityBarPosition.BOTTOM, label: localize('workbench.activityBar.location.bottom', 'Bottom') },
					{ value: ActivityBarPosition.HIDDEN, label: localize('workbench.activityBar.location.hidden', 'Hidden') },
				] as const;
			}
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
			get description() { return localize('sessions.layoutStyle.description', 'Choose an inset frame (Modern) or edge-to-edge regions (Flat).'); },
			get options() {
				return [
					{ value: 'modern', label: localize('sessions.layoutStyle.modern', 'Modern') },
					{ value: 'flat', label: localize('sessions.layoutStyle.flat', 'Flat') },
				] as const;
			}
		},
	}),
});
