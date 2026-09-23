import { localize } from '../../../../nls.js';
import { Extensions as ConfigurationExtensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';

export type GitAutofetch = false | true | 'all';

const configurationRegistry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);

export const GitConfiguration = Object.freeze({
	autofetch: configurationRegistry.registerConfiguration<GitAutofetch>({
		key: 'git.autofetch',
		defaultValue: false,
		parse(value: unknown): GitAutofetch {
			if (value === false || value === true || value === 'all') return value;
			throw new TypeError('git.autofetch must be false, true, or all');
		},
		setting: {
			valueType: 'select',
			get title() { return localize('git.autofetch.title', 'Auto Fetch'); },
			get description() { return localize('git.autofetch.description', 'Periodically fetch updates for every open repository without changing local branches or files.'); },
			get options() { return [
				{ value: false, label: localize('git.autofetch.off', 'Off') },
				{ value: true, label: localize('git.autofetch.default', 'Default remote') },
				{ value: 'all', label: localize('git.autofetch.all', 'All remotes') },
			] as const; },
		},
	}),
	autofetchPeriod: configurationRegistry.registerConfiguration<number>({
		key: 'git.autofetchPeriod',
		defaultValue: 180,
		parse(value: unknown): number {
			if (Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 86_400) return value as number;
			throw new RangeError('git.autofetchPeriod must be an integer from 1 to 86400 seconds');
		},
		setting: {
			valueType: 'number',
			get title() { return localize('git.autofetchPeriod.title', 'Auto Fetch Period'); },
			get description() { return localize('git.autofetchPeriod.description', 'Seconds between automatic fetches for each repository.'); },
			minimum: 1,
			maximum: 86_400,
		},
	}),
});
