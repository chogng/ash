import { ConfigurationScope, Extensions, type IConfigurationRegistry } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { localize } from '../../../../../nls.js';

/** Canvas input preferences follow the UI profile, independently of the active workspace or Session. */
export const DesignConfiguration = Object.freeze({
	usePointerCursor: Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration<boolean>({
		key: 'sessions.design.usePointerCursor',
		defaultValue: true,
		scope: ConfigurationScope.APPLICATION,
		schema: { type: 'boolean' },
		parse(value: unknown): boolean {
			if (typeof value !== 'boolean') {
				throw new TypeError(localize('sessions.design.usePointerCursor.invalid', 'Canvas pointer cursor must be boolean.'));
			}
			return value;
		},
	}),
});
