import { Extensions as ConfigurationExtensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';

export type GitAutofetch = false | true | 'all';

const configurationRegistry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);

/** Former Desktop settings retained only to migrate persisted values to shared Git config. */
export const GitConfiguration = Object.freeze({
	autofetch: configurationRegistry.registerConfiguration<GitAutofetch>({
		key: 'git.autofetch',
		defaultValue: false,
		parse(value: unknown): GitAutofetch {
			if (value === false || value === true || value === 'all') return value;
			throw new TypeError('git.autofetch must be false, true, or all');
		},
	}),
	autofetchPeriod: configurationRegistry.registerConfiguration<number>({
		key: 'git.autofetchPeriod',
		defaultValue: 180,
		parse(value: unknown): number {
			if (Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 86_400) return value as number;
			throw new RangeError('git.autofetchPeriod must be an integer from 1 to 86400 seconds');
		},
	}),
});
