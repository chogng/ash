import { registerColor } from "../colorUtils.js";

const owner = "platform.theme.list";
const color = (id: string, dark: string, light: string, highContrastDark: string, highContrastLight: string, description: string): string =>
	registerColor(id, { dark, light, highContrastDark, highContrastLight }, { description, owner });

export const listHoverBackground = color("list.hoverBackground", "#2a2d2e", "#e8e8e8", "#333333", "#dddddd", "Hovered list row background.");
export const listActiveSelectionForeground = color("list.activeSelectionForeground", "#ffffff", "#ffffff", "#000000", "#ffffff", "Active list selection foreground.");
export const listActiveSelectionBackground = color("list.activeSelectionBackground", "#04395e", "#0060c0", "#ffffff", "#000000", "Active list selection background.");
export const treeIndentGuidesStroke = color("tree.indentGuidesStroke", "#585858", "#a9a9a9", "#ffffff", "#000000", "Tree indentation guide stroke.");
