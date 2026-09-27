import { localize } from '../../nls.js';
import { Extensions as ConfigurationExtensions, type IConfigurationRegistry } from '../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../platform/registry/common/platform.js';

export type SessionsLayoutStyle = 'modern' | 'flat';

const configurationRegistry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);

/** Appearance preferences owned by the dedicated Sessions window. */
export const SessionsConfiguration = Object.freeze({
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
