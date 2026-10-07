import { registerColor } from '../../../../../platform/theme/common/colorUtils.js';

export const chatTabBackground = registerColor('chat.tabBackground', {
	dark: '#EEEEEE',
	light: '#EEEEEE',
	hcDark: '#000000',
	hcLight: '#ffffff',
}, { description: 'Background for inactive Chat session tabs.', owner: 'chat.presentation' });
