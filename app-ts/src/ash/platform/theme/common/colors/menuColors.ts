import { registerColor } from "../colorUtils.js";
import { foreground } from "./baseColors.js";
import { listHoverBackground } from "./listColors.js";

const owner = "platform.theme.menu";
const color = (id: string, dark: string, light: string, description: string): string => registerColor(id, { dark, light }, { description, owner });
const alias = (id: string, value: string, description: string): string => registerColor(id, { dark: value, light: value }, { description, owner });

export const menuForeground = color("menu.foreground", "#cccccc", "#000000", "Command menu item foreground.");
export const menuSelectionForeground = alias("menu.selectionForeground", foreground, "Selected menu item foreground.");
export const menuSelectionBackground = alias("menu.selectionBackground", listHoverBackground, "Selected menu item background.");
export const menuBackground = color("menu.background", "#252526", "#ffffff", "Command menu background.");
export const menuHoverBackground = color("menu.hoverBackground", "#45454b", "#e2e2e4", "Hovered command menu item background.");
