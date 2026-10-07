import { registerColor, transparent } from "../../platform/theme/common/colorUtils.js";
import { primaryButtonBackground } from "../../platform/theme/common/colors/inputColors.js";
import { hoverBorder } from '../../platform/theme/common/colors/componentColors.js';

// Sessions-only colors stay here; Agent colors shared by both windows belong in workbench/common/agentsColors.ts.
// Sessions keeps black tooltips in every theme; the shared hover defaults belong to Workbench.
registerColor('sessions.tooltip.background', {
	dark: '#000000',
	light: '#000000',
	hcDark: '#000000',
	hcLight: '#000000',
}, { description: 'Background of tooltips in the Sessions window.', owner: 'sessions' });

registerColor('sessions.tooltip.foreground', {
	dark: '#ffffff',
	light: '#ffffff',
	hcDark: '#ffffff',
	hcLight: '#ffffff',
}, { description: 'Text color of tooltips in the Sessions window.', owner: 'sessions' });

registerColor('sessions.tooltip.border', {
	dark: hoverBorder,
	light: hoverBorder,
	hcDark: '#ffffff',
	hcLight: '#ffffff',
}, { description: 'Border of tooltips in the Sessions window.', owner: 'sessions' });

export const sessionsAccentGlow = registerColor("sessions.accentGlow", {
	dark: transparent(primaryButtonBackground, 0.16),
	light: transparent(primaryButtonBackground, 0.16),
	hcDark: null,
	hcLight: null,
}, { description: "Glow around the sessions title bar accent.", owner: "sessions.titlebar", needsTransparency: true });

// Sessions owns navigation colors independently of Workbench: idle icons are muted,
// while hover and selection use the same strong foreground and Sessions selection background.
registerColor('sessions.activityBar.foreground', {
	dark: '#ffffff',
	light: '#000000',
	hcDark: '#ffffff',
	hcLight: '#000000',
}, { description: 'Hovered or selected Activity Bar icon color in the Sessions window.', owner: 'sessions.activitybar' });

// High-contrast themes retain full icon contrast; the outline also identifies hover and selection.
registerColor('sessions.activityBar.inactiveForeground', {
	dark: '#999999',
	light: '#808080',
	hcDark: '#ffffff',
	hcLight: '#000000',
}, { description: 'Unselected Activity Bar icon color in the Sessions window.', owner: 'sessions.activitybar' });

registerColor('sessions.selectionBackground', {
	dark: '#303030',
	light: '#f0f0f0',
	hcDark: '#333333',
	hcLight: '#dddddd',
}, { description: 'Selected item background in the Sessions window.', owner: 'sessions' });

// Input cards keep their elevation when a theme changes the shadow of general floating widgets.
registerColor('sessions.inputShadow', {
	dark: '#00000066',
	light: '#00000029',
	hcDark: null,
	hcLight: null,
}, { description: 'Shadow around the Sessions input card.', owner: 'sessions.chat' });
