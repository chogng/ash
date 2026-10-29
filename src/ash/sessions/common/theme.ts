import { registerColor, transparent } from '../../platform/theme/common/colorUtils.js';
import { primaryButtonBackground } from '../../platform/theme/common/colors/inputColors.js';
import { hoverBorder } from '../../platform/theme/common/colors/componentColors.js';
import { accentForeground } from '../../platform/theme/common/colors/baseColors.js';
import { localize } from '../../nls.js';

// Sessions-only colors stay here; Agent colors shared by both windows belong in workbench/common/agentsColors.ts.
// Sessions keeps black tooltips in every theme; the shared hover defaults belong to Workbench.
registerColor(
	'sessions.tooltip.background',
	{
		dark: '#000000',
		light: '#000000',
		hcDark: '#000000',
		hcLight: '#000000',
	},
	{ description: 'Background of tooltips in the Sessions window.', owner: 'sessions' },
);

registerColor(
	'sessions.tooltip.foreground',
	{
		dark: '#ffffff',
		light: '#ffffff',
		hcDark: '#ffffff',
		hcLight: '#ffffff',
	},
	{ description: 'Text color of tooltips in the Sessions window.', owner: 'sessions' },
);

registerColor(
	'sessions.tooltip.border',
	{
		dark: hoverBorder,
		light: hoverBorder,
		hcDark: '#ffffff',
		hcLight: '#ffffff',
	},
	{ description: 'Border of tooltips in the Sessions window.', owner: 'sessions' },
);

export const sessionsAccentGlow = registerColor(
	'sessions.accentGlow',
	{
		dark: transparent(primaryButtonBackground, 0.16),
		light: transparent(primaryButtonBackground, 0.16),
		hcDark: null,
		hcLight: null,
	},
	{ description: 'Glow around the sessions title bar accent.', owner: 'sessions.titlebar', needsTransparency: true },
);

// Sessions keeps navigation foregrounds stable; hover and selection change the background.
registerColor(
	'sessions.activityBar.foreground',
	{
		dark: '#ffffff',
		light: '#000000',
		hcDark: '#ffffff',
		hcLight: '#000000',
	},
	{ description: 'Activity Bar icon and label color in the Sessions window.', owner: 'sessions.activitybar' },
);

// Retain the legacy inactive color registration for existing product themes.
registerColor(
	'sessions.activityBar.inactiveForeground',
	{
		dark: '#999999',
		light: '#808080',
		hcDark: '#ffffff',
		hcLight: '#000000',
	},
	{ description: 'Unselected Activity Bar icon color in the Sessions window.', owner: 'sessions.activitybar' },
);

registerColor(
	'sessions.selectionBackground',
	{
		dark: '#303030',
		light: '#f0f0f0',
		hcDark: '#333333',
		hcLight: '#dddddd',
	},
	{ description: 'Selected item background in the Sessions window.', owner: 'sessions' },
);

// Input cards keep their elevation when a theme changes the shadow of general floating widgets.
registerColor(
	'sessions.inputShadow',
	{
		dark: '#00000066',
		light: '#00000029',
		hcDark: null,
		hcLight: null,
	},
	{ description: 'Shadow around the Sessions input card.', owner: 'sessions.chat' },
);

registerColor(
	'sessions.modelPicker.maximumForeground',
	{
		dark: '#bf9aff',
		light: '#8242e3',
		hcDark: accentForeground,
		hcLight: accentForeground,
	},
	{
		description: localize('sessions.modelPicker.maximumForeground', 'Text color of an emphasized model preset.'),
		owner: 'sessions.chat',
	},
);

registerColor(
	'sessions.modelPicker.maximumBackground',
	{
		dark: '#a660ff',
		light: '#924ff7',
		hcDark: primaryButtonBackground,
		hcLight: primaryButtonBackground,
	},
	{
		description: localize('sessions.modelPicker.maximumBackground', 'Main fill color of an emphasized model preset.'),
		owner: 'sessions.chat',
	},
);

registerColor(
	'sessions.modelPicker.maximumBackgroundAccent',
	{
		dark: '#7777ff',
		light: '#6670f7',
		hcDark: primaryButtonBackground,
		hcLight: primaryButtonBackground,
	},
	{
		description: localize('sessions.modelPicker.maximumBackgroundAccent', 'Gradient accent color of an emphasized model preset.'),
		owner: 'sessions.chat',
	},
);
