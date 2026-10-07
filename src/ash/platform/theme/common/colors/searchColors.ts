import { registerColor } from "../colorUtils.js";

export const searchMatchBackground = registerColor("search.matchBackground", {
	dark: "#f9c74f8c", light: "#f9c74f8c",
	hcDark: "#555500", hcLight: "#ffff00",
}, { description: "Highlighted search match background.", owner: "platform.theme.search" });
