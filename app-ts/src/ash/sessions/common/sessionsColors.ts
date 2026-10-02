import { registerColor, transparent } from "../../platform/theme/common/colorUtils.js";
import { primaryButtonBackground } from "../../platform/theme/common/colors/inputColors.js";

export const sessionsAccentGlow = registerColor("sessions.accentGlow", {
	dark: transparent(primaryButtonBackground, 0.16),
	light: transparent(primaryButtonBackground, 0.16),
	highContrastDark: null,
	highContrastLight: null,
}, { description: "Glow around the sessions title bar accent.", owner: "sessions.titlebar", needsTransparency: true });

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
