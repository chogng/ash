import { Color } from '../../../../../base/common/color.js';
import { contrastBorder, foreground } from '../../../../../platform/theme/common/colors/baseColors.js';
import { editorBackground } from '../../../../../platform/theme/common/colors/editorColors.js';
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

registerColor('chat.modelSlider.trackBackground', {
	dark: transparent(Color.white, 0.12),
	light: transparent(Color.black, 0.08),
	hcDark: editorBackground,
	hcLight: editorBackground,
}, { description: 'Background of the Chat reasoning effort slider track.', owner: 'chat.modelSlider' });

registerColor('chat.modelSlider.tickBackground', {
	dark: transparent(Color.white, 0.4),
	light: transparent(Color.black, 0.3),
	hcDark: foreground,
	hcLight: foreground,
}, { description: 'Color of the Chat reasoning effort slider tick marks.', owner: 'chat.modelSlider' });

registerColor('chat.modelSlider.thumbBackground', {
	dark: Color.white,
	light: Color.white,
	hcDark: foreground,
	hcLight: foreground,
}, { description: 'Background of the Chat reasoning effort slider thumb.', owner: 'chat.modelSlider' });

registerColor('chat.modelSlider.thumbBorder', {
	dark: null,
	light: transparent(Color.black, 0.1),
	hcDark: contrastBorder,
	hcLight: contrastBorder,
}, { description: 'Border of the Chat reasoning effort slider thumb.', owner: 'chat.modelSlider' });

registerColor('chat.modelSlider.thumbShadow', {
	dark: transparent(Color.black, 0.35),
	light: transparent(Color.black, 0.25),
	hcDark: null,
	hcLight: null,
}, { description: 'Shadow of the Chat reasoning effort slider thumb.', owner: 'chat.modelSlider' });
