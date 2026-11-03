import { searchMatchBackground } from '../../../../../platform/theme/common/colors/searchColors.js';
import { registerColor, transparent } from '../../../../../platform/theme/common/colorUtils.js';
import { localize } from '../../../../../nls.js';

export const chatSlashCommandBackground = registerColor('chat.slashCommandBackground', {
	dark: '#26477866', light: '#adceff7a', hcDark: '#ffffff', hcLight: '#0f4a85',
}, { description: localize('chat.slashCommandBackground', 'Background of inline Chat references and slash commands.'), owner: 'chat.presentation' });

export const chatSlashCommandForeground = registerColor('chat.slashCommandForeground', {
	dark: '#85b6ff', light: '#26569e', hcDark: '#000000', hcLight: '#ffffff',
}, { description: localize('chat.slashCommandForeground', 'Foreground of inline Chat references and slash commands.'), owner: 'chat.presentation' });

export const chatTabBackground = registerColor('chat.tabBackground', {
	dark: '#EEEEEE',
	light: '#EEEEEE',
	hcDark: '#000000',
	hcLight: '#ffffff',
}, { description: 'Background for inactive Chat session tabs.', owner: 'chat.presentation' });

export const chatFindMatchBackground = registerColor('chat.findMatchBackground', {
	dark: searchMatchBackground,
	light: searchMatchBackground,
	hcDark: searchMatchBackground,
	hcLight: searchMatchBackground,
}, {
	description: localize('chat.findMatchBackground', 'Background of the current search match in Chat.'),
	owner: 'chat.presentation',
});

export const chatFindMatchHighlightBackground = registerColor('chat.findMatchHighlightBackground', {
	dark: transparent(searchMatchBackground, 0.6),
	light: transparent(searchMatchBackground, 0.6),
	hcDark: searchMatchBackground,
	hcLight: searchMatchBackground,
}, {
	description: localize('chat.findMatchHighlightBackground', 'Background of other search matches in Chat.'),
	owner: 'chat.presentation',
});
