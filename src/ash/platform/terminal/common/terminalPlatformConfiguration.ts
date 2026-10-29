import { localize } from '../../../nls.js';
import { ConfigurationScope, Extensions, type IConfigurationNode, type IConfigurationPropertySchema, type IConfigurationRegistry } from '../../configuration/common/configurationRegistry.js';
import { Registry } from '../../registry/common/platform.js';
import { TerminalSettingId, TerminalSettingPrefix } from './terminal.js';
import type { ITerminalProfile, IExtensionTerminalProfile } from './terminal.js';
import { OperatingSystem } from '../../../base/common/platform.js';
import { createProfileSchemaEnums } from './terminalProfiles.js';

const TERMINAL_CONFIG_SECTION = 'terminal.integrated';
const properties: Record<string, IConfigurationPropertySchema> = {};
for (const platform of ['linux', 'osx', 'windows']) {
	properties[`${TerminalSettingPrefix.DefaultProfile}${platform}`] = {
		type: ['string', 'null'],
		default: null,
		maxLength: 4096,
		get description() {
			return localize('terminal.config.defaultProfileDescription', 'Default interactive terminal profile name on {0}. An unavailable name uses the execution host default.', platform);
		},
	};
}
const environmentSchema = {
	type: 'object' as const,
	maxProperties: 128,
	patternProperties: { '^[^=\\u0000]{1,256}$': { type: ['string', 'null'] as const, maxLength: 32768 } },
	additionalProperties: false,
};
const profileSchema = {
	type: 'object' as const,
	additionalProperties: false,
	properties: {
		path: {
			anyOf: [
				{ type: 'string' as const, minLength: 1, maxLength: 32768 },
				{
					type: 'array' as const,
					minItems: 1,
					maxItems: 32,
					items: { type: 'string' as const, minLength: 1, maxLength: 32768 },
				},
			],
		},
		source: { type: 'string' as const, enum: ['PowerShell', 'Git Bash'] },
		args: {
			anyOf: [
				{
					type: 'array' as const,
					maxItems: 1024,
					items: { type: 'string' as const, maxLength: 32768, pattern: '^[^\\u0000]*$' },
				},
				{ type: 'string' as const, maxLength: 32768, pattern: '^[^\\u0000]*$' },
			],
		},
		env: environmentSchema,
		overrideName: { type: 'boolean' as const },
		icon: { type: 'string' as const, pattern: '^[a-zA-Z0-9_-]{1,256}$' },
		color: { type: 'string' as const, pattern: '^[a-zA-Z0-9_.]{1,256}$' },
		extensionIdentifier: { type: 'string' as const, minLength: 1, maxLength: 256 },
		id: { type: 'string' as const, minLength: 1, maxLength: 256 },
		title: { type: 'string' as const, minLength: 1, maxLength: 256 },
	},
	oneOf: [{ required: ['path'] }, { required: ['source'] }, { required: ['extensionIdentifier', 'id', 'title'] }],
};
for (const platform of ['linux', 'osx', 'windows']) {
	const platformProfileSchema =
		platform === 'windows'
			? profileSchema
			: {
					...profileSchema,
					properties: { ...profileSchema.properties, args: profileSchema.properties.args.anyOf[0] },
				};
	properties[`${TerminalSettingPrefix.Profiles}${platform}`] = {
		type: 'object',
		default: {},
		maxProperties: 128,
		patternProperties: {
			'^[^\\u0000-\\u001f\\u007f]{1,256}$': { anyOf: [{ type: 'null' }, platformProfileSchema] },
		},
		additionalProperties: false,
		get description() {
			return localize(
				'terminal.profile.configurationDescription',
				'Terminal profiles on {0}. Define executable paths, literal arguments and environment overrides. Set a discovered profile to null to hide it.',
				platform,
			);
		},
	};
	properties[`${TERMINAL_CONFIG_SECTION}.env.${platform}`] = {
		...environmentSchema,
		default: {},
		get description() {
			return localize('terminal.profile.environmentDescription', 'Environment overrides for new terminals on {0}. Null removes an inherited variable.', platform);
		},
	};
	for (const kind of ['automationProfile', 'agentHostProfile']) {
		const key = kind === 'automationProfile' ? `${TerminalSettingPrefix.AutomationProfile}${platform}` : `${TERMINAL_CONFIG_SECTION}.${kind}.${platform}`;
		properties[key] = {
			anyOf: [{ type: 'null' }, { ...platformProfileSchema, required: ['path'] }],
			default: null,
			get description() {
				return localize('terminal.profile.executionDescription', 'Shell profile for {0} on {1}. An empty value uses the interactive default.', kind, platform);
			},
		};
	}
}
properties[TerminalSettingId.Cwd] = {
	type: 'string',
	default: '',
	scope: ConfigurationScope.RESOURCE,
	maxLength: 32768,
	get description() {
		return localize('terminal.profile.cwdDescription', 'Starting directory of a new terminal. Execution authorization still applies.');
	},
};

let terminalPlatformConfiguration: IConfigurationNode = {
	id: 'terminal',
	scope: ConfigurationScope.WINDOW,
	properties,
};

/** Registers launch settings consumed by the execution-host profile and environment resolvers. */
export function registerTerminalPlatformConfiguration(): void {
	// The registry tracks node identity, so repeated host assembly is idempotent.
	Registry.as<IConfigurationRegistry>(Extensions.Configuration).updateConfigurations({
		add: [terminalPlatformConfiguration],
		remove: [],
	});
}

/** Updates the active execution host's default-profile suggestions in the settings schema. */
export function registerTerminalDefaultProfileConfiguration(
	detectedProfiles?: { os: OperatingSystem; profiles: readonly ITerminalProfile[] },
	extensionContributedProfiles?: readonly IExtensionTerminalProfile[],
): void {
	if (!detectedProfiles) return;
	const platform = detectedProfiles.os === OperatingSystem.Macintosh ? 'osx' : detectedProfiles.os;
	const key = `${TerminalSettingPrefix.DefaultProfile}${platform}`;
	const candidates = createProfileSchemaEnums(detectedProfiles.profiles, extensionContributedProfiles);
	const current = terminalPlatformConfiguration.properties![key]!;
	const anyOf: IConfigurationPropertySchema['anyOf'] = [{ enum: candidates.values, markdownEnumDescriptions: candidates.markdownDescriptions }, { type: ['string', 'null'] }];
	if (JSON.stringify(current.anyOf) === JSON.stringify(anyOf)) return;
	const previous = terminalPlatformConfiguration;
	terminalPlatformConfiguration = {
		...previous,
		properties: { ...previous.properties, [key]: { ...current, anyOf } },
	};
	Registry.as<IConfigurationRegistry>(Extensions.Configuration).updateConfigurations({
		add: [terminalPlatformConfiguration],
		remove: [previous],
	});
}
