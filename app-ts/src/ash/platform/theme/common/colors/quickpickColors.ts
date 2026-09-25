import { registerColor } from "../colorUtils.js";

const owner = "platform.theme.quickpick";

export const quickInputBackground = registerColor("quickInput.background", {
	dark: "#252526", light: "#f8f8f8",
}, { description: "Quick input background.", owner });
