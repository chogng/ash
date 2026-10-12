import { environment } from '../../../../base/common/platform.js';
import { localize } from '../../../../nls.js';
import { ConfigurationScope, Extensions, type IConfigurationPropertySchema, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { terminalHistoryConfiguration } from '../../terminalContrib/history/common/terminal.history.js';
import { TERMINAL_CONFIG_SECTION } from './terminal.js';

const properties: Record<string, IConfigurationPropertySchema> = {};
function numberSetting(name: string, defaultValue: number, minimum: number, maximum: number, title: () => string, description: () => string, integer = false): void {
	properties[`${TERMINAL_CONFIG_SECTION}.${name}`] = {
		type: integer ? 'integer' : 'number', default: defaultValue, minimum, maximum,
		get description() { return description(); },
		ashSetting: { valueType: 'number', minimum, maximum, get title() { return title(); }, get description() { return description(); } },
	};
}
numberSetting('fontSize', environment.os === 'mac' ? 12 : 14, 6, 100,
	() => localize('terminal.config.fontSize', 'Terminal font size'),
	() => localize('terminal.config.fontSizeDescription', 'Font size in pixels.'));
numberSetting('letterSpacing', 0, -5, 100,
	() => localize('terminal.config.letterSpacing', 'Terminal letter spacing'),
	() => localize('terminal.config.letterSpacingDescription', 'Additional pixels between terminal characters.'), true);
numberSetting('lineHeight', environment.os === 'linux' ? 1.1 : 1, 1, 10,
	() => localize('terminal.config.lineHeight', 'Terminal line height'),
	() => localize('terminal.config.lineHeightDescription', 'Line height as a multiple of the font size.'));
numberSetting('cursorWidth', 1, 1, 20,
	() => localize('terminal.config.cursorWidth', 'Terminal cursor width'),
	() => localize('terminal.config.cursorWidthDescription', 'Width in pixels of the line cursor.'), true);
numberSetting('scrollback', 1000, 0, 1000000,
	() => localize('terminal.config.scrollback', 'Terminal scrollback'),
	() => localize('terminal.config.scrollbackDescription', 'Maximum number of lines retained above the visible terminal.'), true);
numberSetting('minimumContrastRatio', 4.5, 1, 21,
	() => localize('terminal.config.contrast', 'Terminal minimum contrast'),
	() => localize('terminal.config.contrastDescription', 'Minimum contrast ratio for terminal text. Set to 1 to use the theme colors directly.'));
properties[`${TERMINAL_CONFIG_SECTION}.fontFamily`] = {
	type: 'string', default: '', maxLength: 4096,
	get description() { return localize('terminal.config.fontFamilyDescription', 'Terminal font family. An empty value uses the editor font.'); },
	ashSetting: { valueType: 'text', placeholder: '', get title() { return localize('terminal.config.fontFamily', 'Terminal font family'); }, get description() { return localize('terminal.config.fontFamilyDescription', 'Terminal font family. An empty value uses the editor font.'); } },
};
properties[`${TERMINAL_CONFIG_SECTION}.cursorBlinking`] = {
	type: 'boolean', default: false,
	get description() { return localize('terminal.config.cursorBlinkingDescription', 'Blink the terminal cursor.'); },
	ashSetting: { valueType: 'boolean', get title() { return localize('terminal.config.cursorBlinking', 'Terminal cursor blinking'); }, get description() { return localize('terminal.config.cursorBlinkingDescription', 'Blink the terminal cursor.'); } },
};
for (const [name, defaultValue, choices] of [
	['cursorStyle', 'block', ['block', 'line', 'underline']],
	['cursorStyleInactive', 'outline', ['outline', 'block', 'line', 'underline', 'none']],
] as const) {
	const labels = {
		get block() { return localize('terminal.config.cursor.block', 'Block'); },
		get line() { return localize('terminal.config.cursor.line', 'Line'); },
		get underline() { return localize('terminal.config.cursor.underline', 'Underline'); },
		get outline() { return localize('terminal.config.cursor.outline', 'Outline'); },
		get none() { return localize('terminal.config.cursor.none', 'Hidden'); },
	};
	const title = () => name === 'cursorStyle' ? localize('terminal.config.cursorStyle', 'Terminal cursor style') : localize('terminal.config.cursorStyleInactive', 'Inactive terminal cursor style');
	const description = () => name === 'cursorStyle' ? localize('terminal.config.cursorStyleDescription', 'Cursor shape when the terminal has focus.') : localize('terminal.config.cursorStyleInactiveDescription', 'Cursor shape when the terminal does not have focus.');
	properties[`${TERMINAL_CONFIG_SECTION}.${name}`] = {
		type: 'string', default: defaultValue, enum: [...choices], get description() { return description(); },
		ashSetting: { valueType: 'select', get title() { return title(); }, get description() { return description(); }, get options() { return choices.map(value => ({ value, label: labels[value] })); } },
	};
}
for (const platform of ['linux', 'osx', 'windows']) {
	properties[`${TERMINAL_CONFIG_SECTION}.defaultProfile.${platform}`] = {
		type: ['string', 'null'], default: null, maxLength: 4096,
		get description() { return localize('terminal.config.defaultProfileDescription', 'Default interactive terminal profile name on {0}. An unavailable name uses the execution host default.', platform); },
	};
}
const environmentSchema = {
	type: 'object' as const, maxProperties: 128,
	patternProperties: { '^[^=\\u0000]{1,256}$': { type: ['string', 'null'] as const, maxLength: 32768 } }, additionalProperties: false,
};
const profileSchema = {
	type: 'object' as const, additionalProperties: false,
	properties: {
		path: { anyOf: [{ type: 'string' as const, minLength: 1, maxLength: 32768 }, { type: 'array' as const, minItems: 1, maxItems: 32, items: { type: 'string' as const, minLength: 1, maxLength: 32768 } }] },
		source: { type: 'string' as const, enum: ['PowerShell', 'Git Bash'] },
		args: { anyOf: [{ type: 'array' as const, maxItems: 1024, items: { type: 'string' as const, maxLength: 32768, pattern: '^[^\\u0000]*$' } }, { type: 'string' as const, maxLength: 32768, pattern: '^[^\\u0000]*$' }] },
		env: environmentSchema, overrideName: { type: 'boolean' as const },
		icon: { type: 'string' as const, pattern: '^[a-zA-Z0-9_-]{1,256}$' },
		color: { type: 'string' as const, pattern: '^[a-zA-Z0-9_.]{1,256}$' },
		extensionIdentifier: { type: 'string' as const, minLength: 1, maxLength: 256 },
		id: { type: 'string' as const, minLength: 1, maxLength: 256 }, title: { type: 'string' as const, minLength: 1, maxLength: 256 },
	},
	oneOf: [{ required: ['path'] }, { required: ['source'] }, { required: ['extensionIdentifier', 'id', 'title'] }],
};
for (const platform of ['linux', 'osx', 'windows']) {
	const platformProfileSchema = platform === 'windows' ? profileSchema : { ...profileSchema, properties: { ...profileSchema.properties, args: profileSchema.properties.args.anyOf[0] } };
	properties[`${TERMINAL_CONFIG_SECTION}.profiles.${platform}`] = {
		type: 'object', default: {}, maxProperties: 128,
		patternProperties: { '^[^\\u0000-\\u001f\\u007f]{1,256}$': { anyOf: [{ type: 'null' }, platformProfileSchema] } }, additionalProperties: false,
		get description() { return localize('terminal.profile.configurationDescription', 'Terminal profiles on {0}. Define executable paths, literal arguments and environment overrides. Set a discovered profile to null to hide it.', platform); },
	};
	properties[`${TERMINAL_CONFIG_SECTION}.env.${platform}`] = {
		...environmentSchema, default: {}, get description() { return localize('terminal.profile.environmentDescription', 'Environment overrides for new terminals on {0}. Null removes an inherited variable.', platform); },
	};
	for (const kind of ['automationProfile', 'agentHostProfile']) {
		properties[`${TERMINAL_CONFIG_SECTION}.${kind}.${platform}`] = {
			anyOf: [{ type: 'null' }, { ...platformProfileSchema, required: ['path'] }], default: null,
			get description() { return localize('terminal.profile.executionDescription', 'Shell profile for {0} on {1}. An empty value uses the interactive default.', kind, platform); },
		};
	}
}
properties[`${TERMINAL_CONFIG_SECTION}.cwd`] = { type: 'string', default: '', maxLength: 32768, get description() { return localize('terminal.profile.cwdDescription', 'Starting directory of a new terminal. Execution authorization still applies.'); } };
Object.assign(properties, terminalHistoryConfiguration);
Registry.as<IConfigurationRegistry>(Extensions.Configuration).updateConfigurations({
	add: [{ id: 'terminal', scope: ConfigurationScope.WINDOW, properties }], remove: [],
});
