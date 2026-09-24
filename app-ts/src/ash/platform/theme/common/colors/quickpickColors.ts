import { registerColor } from "../colorUtils.js";

const owner = "platform.theme.quickpick";

export const quickInputBackground = registerColor("quickInput.background", {
	dark: "#252526", light: "#f8f8f8",
}, { description: "Quick input background.", owner });

export const quickInputBackdropBackground = registerColor("quickInput.backdropBackground", {
	dark: "#00000026", light: "#0000001f",
}, { description: "Backdrop behind quick input.", owner });
