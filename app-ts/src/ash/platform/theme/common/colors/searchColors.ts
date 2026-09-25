import { registerColor } from "../colorUtils.js";

export const searchMatchBackground = registerColor("search.matchBackground", {
	dark: "#f9c74f8c", light: "#f9c74f8c",
	highContrastDark: "#555500", highContrastLight: "#ffff00",
}, { description: "Highlighted search match background.", owner: "platform.theme.search" });
