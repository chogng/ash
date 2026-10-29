import type { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import type { ITerminalAutoReply } from '../../../../platform/terminal/common/terminal.js';
import { environment } from '../../../../base/common/platform.js';
import { localize } from '../../../../nls.js';
import { ConfigurationScope, Extensions, type IConfigurationPropertySchema, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { terminalContribConfiguration } from '../terminalContribExports.js';
import { TERMINAL_CONFIG_SECTION } from './terminal.js';
import { TerminalSettingId } from '../../../../platform/terminal/common/terminal.js';
import { registerTerminalPlatformConfiguration } from '../../../../platform/terminal/common/terminalPlatformConfiguration.js';

const properties: Record<string, IConfigurationPropertySchema> = {};
function numberSetting(name: string, defaultValue: number, minimum: number, maximum: number, title: () => string, description: () => string, integer = false): void {
	properties[`${TERMINAL_CONFIG_SECTION}.${name}`] = {
		type: integer ? 'integer' : 'number',
		default: defaultValue,
		minimum,
		maximum,
		get description() {
			return description();
		},
		ashSetting: {
			valueType: 'number',
			minimum,
			maximum,
			get title() {
				return title();
			},
			get description() {
				return description();
			},
		},
	};
}
numberSetting(
	'fontSize',
	environment.os === 'mac' ? 12 : 14,
	6,
	100,
	() => localize('terminal.config.fontSize', 'Terminal font size'),
	() => localize('terminal.config.fontSizeDescription', 'Font size in pixels.'),
);
numberSetting(
	'letterSpacing',
	0,
	-5,
	100,
	() => localize('terminal.config.letterSpacing', 'Terminal letter spacing'),
	() => localize('terminal.config.letterSpacingDescription', 'Additional pixels between terminal characters.'),
	true,
);
numberSetting(
	'lineHeight',
	environment.os === 'linux' ? 1.1 : 1,
	1,
	10,
	() => localize('terminal.config.lineHeight', 'Terminal line height'),
	() => localize('terminal.config.lineHeightDescription', 'Line height as a multiple of the font size.'),
);
numberSetting(
	'cursorWidth',
	1,
	1,
	20,
	() => localize('terminal.config.cursorWidth', 'Terminal cursor width'),
	() => localize('terminal.config.cursorWidthDescription', 'Width in pixels of the line cursor.'),
	true,
);
numberSetting(
	'scrollback',
	1000,
	0,
	1000000,
	() => localize('terminal.config.scrollback', 'Terminal scrollback'),
	() => localize('terminal.config.scrollbackDescription', 'Maximum number of lines retained above the visible terminal.'),
	true,
);
numberSetting(
	'minimumContrastRatio',
	4.5,
	1,
	21,
	() => localize('terminal.config.contrast', 'Terminal minimum contrast'),
	() => localize('terminal.config.contrastDescription', 'Minimum contrast ratio for terminal text. Set to 1 to use the theme colors directly.'),
);
properties[`${TERMINAL_CONFIG_SECTION}.fontFamily`] = {
	type: 'string',
	default: '',
	maxLength: 4096,
	get description() {
		return localize('terminal.config.fontFamilyDescription', 'Terminal font family. An empty value uses the editor font.');
	},
	ashSetting: {
		valueType: 'text',
		placeholder: '',
		get title() {
			return localize('terminal.config.fontFamily', 'Terminal font family');
		},
		get description() {
			return localize('terminal.config.fontFamilyDescription', 'Terminal font family. An empty value uses the editor font.');
		},
	},
};
properties[`${TERMINAL_CONFIG_SECTION}.fontRendering`] = {
	type: 'string',
	default: 'auto',
	enum: ['auto', 'grayscale'],
	get description() {
		return localize('terminal.config.fontRendering', 'Terminal font smoothing on macOS. Grayscale uses antialiased text.');
	},
};
properties[`${TERMINAL_CONFIG_SECTION}.cursorBlinking`] = {
	type: 'boolean',
	default: false,
	get description() {
		return localize('terminal.config.cursorBlinkingDescription', 'Blink the terminal cursor.');
	},
	ashSetting: {
		valueType: 'boolean',
		get title() {
			return localize('terminal.config.cursorBlinking', 'Terminal cursor blinking');
		},
		get description() {
			return localize('terminal.config.cursorBlinkingDescription', 'Blink the terminal cursor.');
		},
	},
};
properties[`${TERMINAL_CONFIG_SECTION}.showLinkHover`] = {
	type: 'boolean',
	default: true,
	get description() {
		return localize('terminal.config.showLinkHover', 'Show a hover with the file path or URL when pointing at a terminal link.');
	},
};
properties[`${TERMINAL_CONFIG_SECTION}.enableFileLinks`] = {
	type: 'string',
	default: 'on',
	enum: ['off', 'on', 'notRemote'],
	get description() {
		return localize('terminal.config.enableFileLinks', 'Enable terminal file links always, never, or only in local workspaces.');
	},
};
properties[`${TERMINAL_CONFIG_SECTION}.shellIntegration.decorationsEnabled`] = {
	type: 'string',
	default: 'both',
	enum: ['both', 'gutter', 'overviewRuler', 'never'],
	get description() {
		return localize('terminal.config.decorations', 'Controls command decorations when shell integration is enabled.');
	},
	get enumDescriptions() {
		return [
			localize('terminal.config.decorations.both', 'Show command decorations in the gutter and overview ruler.'),
			localize('terminal.config.decorations.gutter', 'Show command decorations in the gutter.'),
			localize('terminal.config.decorations.overviewRuler', 'Show command decorations in the overview ruler.'),
			localize('terminal.config.decorations.never', 'Hide command decorations.'),
		];
	},
};
properties[`${TERMINAL_CONFIG_SECTION}.wordSeparators`] = {
	type: 'string',
	default: ' ()[]{}\',"`─‘’“”|',
	get description() {
		return localize('terminal.config.wordSeparators', 'Characters separating words for terminal word selection and workspace file links.');
	},
};
for (const [name, defaultValue, choices] of [
	['cursorStyle', 'block', ['block', 'line', 'underline']],
	['cursorStyleInactive', 'outline', ['outline', 'block', 'line', 'underline', 'none']],
] as const) {
	const labels = {
		get block() {
			return localize('terminal.config.cursor.block', 'Block');
		},
		get line() {
			return localize('terminal.config.cursor.line', 'Line');
		},
		get underline() {
			return localize('terminal.config.cursor.underline', 'Underline');
		},
		get outline() {
			return localize('terminal.config.cursor.outline', 'Outline');
		},
		get none() {
			return localize('terminal.config.cursor.none', 'Hidden');
		},
	};
	const title = () => (name === 'cursorStyle' ? localize('terminal.config.cursorStyle', 'Terminal cursor style') : localize('terminal.config.cursorStyleInactive', 'Inactive terminal cursor style'));
	const description = () =>
		name === 'cursorStyle'
			? localize('terminal.config.cursorStyleDescription', 'Cursor shape when the terminal has focus.')
			: localize('terminal.config.cursorStyleInactiveDescription', 'Cursor shape when the terminal does not have focus.');
	properties[`${TERMINAL_CONFIG_SECTION}.${name}`] = {
		type: 'string',
		default: defaultValue,
		enum: [...choices],
		get description() {
			return description();
		},
		ashSetting: {
			valueType: 'select',
			get title() {
				return title();
			},
			get description() {
				return description();
			},
			get options() {
				return choices.map(value => ({ value, label: labels[value] }));
			},
		},
	};
}
for (const name of ['showActiveTerminal', 'showActions'] as const) {
	properties[`${TERMINAL_CONFIG_SECTION}.tabs.${name}`] = {
		type: 'string',
		default: 'singleTerminalOrNarrow',
		enum: ['always', 'singleTerminal', 'singleTerminalOrNarrow', 'never'],
		get description() {
			return name === 'showActiveTerminal'
				? localize('terminal.config.tabs.showActiveTerminal', 'Controls when the active terminal is shown in the terminal title toolbar.')
				: localize('terminal.config.tabs.showActions', 'Controls when split and kill actions are shown in the terminal title toolbar.');
		},
	};
}
registerTerminalPlatformConfiguration();
properties[`${TERMINAL_CONFIG_SECTION}.confirmOnKill`] = {
	type: 'string',
	default: 'editor',
	enum: ['never', 'editor', 'panel', 'always'],
	get description() {
		return localize('terminal.config.confirmOnKill', 'Confirm before closing a terminal with child processes: never, in the editor, in the panel, or always.');
	},
};
properties[`${TERMINAL_CONFIG_SECTION}.confirmOnExit`] = {
	type: 'string',
	default: 'never',
	enum: ['never', 'always', 'hasChildProcesses'],
	get description() {
		return localize('terminal.config.confirmOnExit', 'Confirm before closing the window: never, whenever terminals exist, or when terminals have child processes.');
	},
};
properties[`${TERMINAL_CONFIG_SECTION}.enablePersistentSessions`] = {
	type: 'boolean',
	default: true,
	get description() {
		return localize('terminal.config.enablePersistentSessions', 'Preserve terminal sessions across window reloads and recreate them after eligible shutdowns.');
	},
};
properties[`${TERMINAL_CONFIG_SECTION}.persistentSessionReviveProcess`] = {
	type: 'string',
	enum: ['onExit', 'onExitAndWindowClose', 'never'],
	default: 'onExit',
	get description() {
		return localize(
			'terminal.config.reviveProcess',
			'Recreate shells with their saved output, working directory and layout after application exit, after application exit and window close, or never. Running commands are not resumed.',
		);
	},
};
properties[TerminalSettingId.EnableMultiLinePasteWarning] = {
	type: 'string',
	default: 'auto',
	enum: ['auto', 'always', 'never'],
	get description() {
		return localize(
			'terminal.config.multiLinePasteWarning',
			'Use auto to skip confirmation in bracketed paste mode and remove a single command’s trailing newline. Use always to confirm any newline, or never to disable the warning.',
		);
	},
};
properties[TerminalSettingId.CopyOnSelection] = {
	type: 'boolean',
	default: false,
	get description() {
		return localize('terminal.config.copyOnSelection', 'Copy text selected in the terminal to the clipboard.');
	},
};
properties[TerminalSettingId.RightClickBehavior] = {
	type: 'string',
	enum: ['default', 'copyPaste', 'paste', 'selectWord', 'nothing'],
	default: environment.os === 'mac' ? 'selectWord' : environment.os === 'windows' ? 'copyPaste' : 'default',
	get description() {
		return localize('terminal.config.rightClickBehavior', 'Controls how the terminal handles right click. Hold Shift to open the context menu.');
	},
	get enumDescriptions() {
		return [
			localize('terminal.config.rightClickBehavior.default', 'Show the context menu.'),
			localize('terminal.config.rightClickBehavior.copyPaste', 'Copy and clear the selection, or paste when there is no selection.'),
			localize('terminal.config.rightClickBehavior.paste', 'Paste clipboard text.'),
			localize('terminal.config.rightClickBehavior.selectWord', 'Select the word under the pointer and show the context menu.'),
			localize('terminal.config.rightClickBehavior.nothing', 'Pass the click to the terminal without opening a context menu.'),
		];
	},
};
Object.assign(properties, terminalContribConfiguration);
Registry.as<IConfigurationRegistry>(Extensions.Configuration).updateConfigurations({
	add: [{ id: 'terminal', scope: ConfigurationScope.WINDOW, properties }],
	remove: [],
});

/** Converts the current configuration once for creation and live rule updates. */
export function getTerminalAutoReplyRules(configuration: IConfigurationService): readonly ITerminalAutoReply[] {
	const replies = configuration.getValue<Readonly<Record<string, string | null>>>('terminal.integrated.autoReplies');
	return Object.entries(replies ?? {})
		.filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length > 0)
		.map(([matchText, reply]) => ({ matchText, reply }));
}
