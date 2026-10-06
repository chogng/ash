import { registerColor, transparent } from "../../platform/theme/common/colorUtils.js";
import { primaryButtonBackground } from "../../platform/theme/common/colors/inputColors.js";
import { hoverBorder } from '../../platform/theme/common/colors/componentColors.js';

// Sessions-only colors stay here; Agent colors shared by both windows belong in workbench/common/agentsColors.ts.
// Sessions keeps black tooltips in every theme; the shared hover defaults belong to Workbench.
registerColor('sessions.tooltip.background', {
	dark: '#000000',
	light: '#000000',
	highContrastDark: '#000000',
	highContrastLight: '#000000',
}, { description: 'Background of tooltips in the Sessions window.', owner: 'sessions' });

registerColor('sessions.tooltip.foreground', {
	dark: '#ffffff',
	light: '#ffffff',
	highContrastDark: '#ffffff',
	highContrastLight: '#ffffff',
}, { description: 'Text color of tooltips in the Sessions window.', owner: 'sessions' });

registerColor('sessions.tooltip.border', {
	dark: hoverBorder,
	light: hoverBorder,
	highContrastDark: '#ffffff',
	highContrastLight: '#ffffff',
}, { description: 'Border of tooltips in the Sessions window.', owner: 'sessions' });

export const sessionsAccentGlow = registerColor("sessions.accentGlow", {
	dark: transparent(primaryButtonBackground, 0.16),
	light: transparent(primaryButtonBackground, 0.16),
	highContrastDark: null,
	highContrastLight: null,
}, { description: "Glow around the sessions title bar accent.", owner: "sessions.titlebar", needsTransparency: true });

// Sessions owns navigation feedback independently of Workbench. Keep explicit defaults
// instead of aliasing toolbar colors so changes to either window do not recolor the other.
registerColor('sessions.activityBar.hoverBackground', {
	dark: '#5a5d5e50',
	light: '#5a5d5e29',
	highContrastDark: '#333333',
	highContrastLight: '#dddddd',
}, { description: 'Hovered Activity Bar item background in the Sessions window.', owner: 'sessions.activitybar' });

registerColor('sessions.selectionBackground', {
	dark: '#303030',
	light: '#f0f0f0',
	highContrastDark: '#333333',
	highContrastLight: '#dddddd',
}, { description: 'Selected item background in the Sessions window.', owner: 'sessions' });

// Input cards keep their elevation when a theme changes the shadow of general floating widgets.
registerColor('sessions.inputShadow', {
	dark: '#00000066',
	light: '#00000029',
	highContrastDark: null,
	highContrastLight: null,
}, { description: 'Shadow around the Sessions input card.', owner: 'sessions.chat' });
