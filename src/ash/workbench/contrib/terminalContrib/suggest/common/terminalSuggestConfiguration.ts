import { localize } from '../../../../../nls.js';
import type { IConfigurationPropertySchema } from '../../../../../platform/configuration/common/configurationRegistry.js';

export const enum TerminalSuggestSettingId {
	Enabled = 'terminal.integrated.suggest.enabled',
	QuickSuggestions = 'terminal.integrated.suggest.quickSuggestions',
	SuggestOnTriggerCharacters = 'terminal.integrated.suggest.suggestOnTriggerCharacters',
}
export interface TerminalQuickSuggestions { readonly commands?: 'on' | 'off'; readonly arguments?: 'on' | 'off'; readonly unknown?: 'on' | 'off'; }
export const terminalSuggestConfiguration: Readonly<Record<string, IConfigurationPropertySchema>> = {
	[TerminalSuggestSettingId.Enabled]: {
		type: 'boolean', default: true, restricted: true,
		get description() { return localize('terminal.suggest.enabled', 'Enable terminal suggestions when shell integration is working.'); },
	},
	[TerminalSuggestSettingId.QuickSuggestions]: {
		type: ['boolean', 'object'], default: { commands: 'on', arguments: 'on', unknown: 'off' }, restricted: true,
		properties: Object.fromEntries(['commands', 'arguments', 'unknown'].map(key => [key, { type: 'string', enum: ['on', 'off'] }])), additionalProperties: false,
		get description() { return localize('terminal.suggest.quickSuggestions', 'Automatically show terminal suggestions while typing commands, arguments, or unknown input.'); },
	},
	[TerminalSuggestSettingId.SuggestOnTriggerCharacters]: {
		type: 'boolean', default: false, restricted: true,
		get description() { return localize('terminal.suggest.triggerCharacters', 'Automatically show terminal suggestions when typing a provider trigger character.'); },
	},
};
