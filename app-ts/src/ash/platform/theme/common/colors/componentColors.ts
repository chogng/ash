import { registerColor } from "../colorUtils.js";
import { contrastBorder, foreground, widgetBorder } from "./baseColors.js";

const owner = "platform.theme.components";
const color = (id: string, dark: string, light: string, highContrastDark: string | null, highContrastLight: string | null, description: string): string =>
	registerColor(id, { dark, light, highContrastDark, highContrastLight }, { description, owner });
const alias = (id: string, value: string, description: string): string => registerColor(id, {
	dark: value, light: value, highContrastDark: value, highContrastLight: value,
}, { description, owner });

export const hoverForeground = color("hover.foreground", "#f5f5f7", "#f5f5f7", foreground, foreground, "Foreground for managed Hovers.");
export const hoverBackground = color("hover.background", "#2d2e33", "#2d2e33", "#000000", "#ffffff", "Background for managed Hovers.");
export const hoverBorder = color("hover.border", "#ffffff18", "#ffffff18", contrastBorder, contrastBorder, "Border around managed Hovers.");
export const hoverShadow = color("hover.shadow", "#00000030", "#00000030", null, null, "Shadow around managed Hovers.");
export const actionBarBackground = color("actionBar.background", "#313136", "#f5f5f6", "#000000", "#ffffff", "Background behind an inline ActionBar.");
export const actionBarToggledBackground = color("actionBar.toggledBackground", "#37373d", "#E4E6F2", "#333333", "#dddddd", "Background for a checked ActionBar item.");
export const tabListHoverBackground = color("tabList.hoverBackground", "#45454b", "#e2e2e4", "#333333", "#dddddd", "Background for a hovered TabList tab.");
export const tabListActiveBackground = color("tabList.activeBackground", "#37373d", "#e4e6f2", "#333333", "#dddddd", "Background for a selected TabList tab.");
export const toolbarHoverBackground = color("toolbar.hoverBackground", "#5a5d5e50", "#5a5d5e29", "#333333", "#dddddd", "Hovered toolbar item background.");
export const dialogBackground = color("dialog.background", "#252526", "#ffffff", "#000000", "#ffffff", "Dialog background.");
export const dialogBorder = alias("dialog.border", widgetBorder, "Dialog border.");
export const dialogBackdropBackground = color("dialog.backdropBackground", "#00000073", "#00000059", "#000000", "#ffffff", "Backdrop behind modal dialogs.");
export const dialogShadow = color("dialog.shadow", "#00000073", "#0000003d", null, null, "Shadow around modal dialogs.");
export const textCodeBlockBackground = color("text.codeBlockBackground", "#0f0f0f", "#f2f2f2", "#000000", "#ffffff", "Inline and block code background.");
