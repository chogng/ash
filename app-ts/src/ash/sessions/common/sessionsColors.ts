import { registerColor, transparent } from "../../platform/theme/common/colorUtils.js";
import { primaryButtonBackground } from "../../platform/theme/common/colors/inputColors.js";

export const sessionsAccentGlow = registerColor("sessions.accentGlow", {
	dark: transparent(primaryButtonBackground, 0.16),
	light: transparent(primaryButtonBackground, 0.16),
	highContrastDark: null,
	highContrastLight: null,
}, { description: "Glow around the sessions title bar accent.", owner: "sessions.titlebar", needsTransparency: true });
