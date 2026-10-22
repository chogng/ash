import { registerColor } from '../../../../platform/theme/common/colorUtils.js';

export const debugIconStartForeground = registerColor(
	'debugIcon.startForeground',
	{ dark: '#89d185', light: '#388a34', hcDark: '#89d185', hcLight: '#388a34' },
	{ owner: 'debug', description: 'Foreground color of the Start Debugging icon.' },
);
