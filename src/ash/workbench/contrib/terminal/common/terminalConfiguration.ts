import { environment } from '../../../../base/common/platform.js';
import { localize } from '../../../../nls.js';
import { ConfigurationScope, Extensions, type IConfigurationPropertySchema, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { terminalContribConfiguration } from '../terminalContribExports.js';
import { TERMINAL_CONFIG_SECTION } from './terminal.js';
import { registerTerminalPlatformConfiguration } from '../../../../platform/terminal/common/terminalPlatformConfiguration.js';

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
properties[`${TERMINAL_CONFIG_SECTION}.fontRendering`] = {
	type: 'string', default: 'auto', enum: ['auto', 'grayscale'],
	get description() { return localize('terminal.config.fontRendering', 'Terminal font smoothing on macOS. Grayscale uses antialiased text.'); },
};
properties[`${TERMINAL_CONFIG_SECTION}.cursorBlinking`] = {
	type: 'boolean', default: false,
	get description() { return localize('terminal.config.cursorBlinkingDescription', 'Blink the terminal cursor.'); },
	ashSetting: { valueType: 'boolean', get title() { return localize('terminal.config.cursorBlinking', 'Terminal cursor blinking'); }, get description() { return localize('terminal.config.cursorBlinkingDescription', 'Blink the terminal cursor.'); } },
};
properties[`${TERMINAL_CONFIG_SECTION}.showLinkHover`] = {
	type: 'boolean', default: true,
	get description() { return localize('terminal.config.showLinkHover', 'Show a hover with the URL when pointing at a terminal link.'); },
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
for (const name of ['showActiveTerminal', 'showActions'] as const) {
	properties[`${TERMINAL_CONFIG_SECTION}.tabs.${name}`] = {
		type: 'string', default: 'singleTerminalOrNarrow',
		enum: ['always', 'singleTerminal', 'singleTerminalOrNarrow', 'never'],
		get description() {
			return name === 'showActiveTerminal'
				? localize('terminal.config.tabs.showActiveTerminal', 'Controls when the active terminal is shown in the terminal title toolbar.')
				: localize('terminal.config.tabs.showActions', 'Controls when split and kill actions are shown in the terminal title toolbar.');
		},
	};
}
registerTerminalPlatformConfiguration();
Object.assign(properties, terminalContribConfiguration);
Registry.as<IConfigurationRegistry>(Extensions.Configuration).updateConfigurations({
	add: [{ id: 'terminal', scope: ConfigurationScope.WINDOW, properties }], remove: [],
});
