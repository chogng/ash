import { registerColor } from "../colorUtils.js";
import { foreground, selectionBackground, selectionForeground } from "./baseColors.js";
import { listHoverBackground } from "./listColors.js";

const owner = "platform.theme.menu";
const color = (id: string, dark: string, light: string, highContrastDark: string, highContrastLight: string, description: string): string =>
	registerColor(id, { dark, light, highContrastDark, highContrastLight }, { description, owner });
const alias = (id: string, value: string, highContrastValue: string, description: string): string => registerColor(id, {
	dark: value, light: value, highContrastDark: highContrastValue, highContrastLight: highContrastValue,
}, { description, owner });

export const menuForeground = color("menu.foreground", "#cccccc", "#000000", foreground, foreground, "Command menu item foreground.");
export const menuSelectionForeground = alias("menu.selectionForeground", foreground, selectionForeground, "Selected menu item foreground.");
export const menuSelectionBackground = alias("menu.selectionBackground", listHoverBackground, selectionBackground, "Selected menu item background.");
export const menuBackground = color("menu.background", "#252526", "#ffffff", "#000000", "#ffffff", "Command menu background.");
export const menuHoverBackground = color("menu.hoverBackground", "#45454b", "#e2e2e4", "#333333", "#dddddd", "Hovered command menu item background.");
