import { Extensions as ConfigurationExtensions, type IConfigurationRegistry } from '../../configuration/common/configurationRegistry.js';
import { Registry } from '../../registry/common/platform.js';
import { KeyboardDispatchMode } from './keyboardLayout.js';

const configurationRegistry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);

export const KeyboardConfiguration = Object.freeze({
	layout: configurationRegistry.registerConfiguration<string>({
		key: 'keyboard.layout',
		defaultValue: 'autodetect',
		parse(value: unknown): string {
			if (typeof value !== 'string' || !/^(?:autodetect|[a-z0-9][a-z0-9._-]*)$/iu.test(value)) {
				throw new TypeError(`Invalid keyboard layout: ${String(value)}`);
			}
			return value;
		},
	}),
	dispatch: configurationRegistry.registerConfiguration<KeyboardDispatchMode>({
		key: 'keyboard.dispatch',
		defaultValue: KeyboardDispatchMode.Code,
		parse(value: unknown): KeyboardDispatchMode {
			if (value !== KeyboardDispatchMode.Code && value !== KeyboardDispatchMode.KeyCode) {
				throw new TypeError(`Invalid keyboard dispatch mode: ${String(value)}`);
			}
			return value;
		},
	}),
	mapAltGrToCtrlAlt: configurationRegistry.registerConfiguration<boolean>({
		key: 'keyboard.mapAltGrToCtrlAlt',
		defaultValue: false,
		parse(value: unknown): boolean {
			if (typeof value !== 'boolean') {
				throw new TypeError(`Invalid AltGr mapping value: ${String(value)}`);
			}
			return value;
		},
	}),
});
