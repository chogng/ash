import { registerColor } from "../colorUtils.js";

const owner = "platform.theme.list";
const color = (id: string, dark: string, light: string, description: string): string => registerColor(id, { dark, light }, { description, owner });

export const listHoverBackground = color("list.hoverBackground", "#2a2d2e", "#e8e8e8", "Hovered list row background.");
export const listActiveSelectionForeground = color("list.activeSelectionForeground", "#ffffff", "#ffffff", "Active list selection foreground.");
export const listActiveSelectionBackground = color("list.activeSelectionBackground", "#04395e", "#0060c0", "Active list selection background.");
export const treeIndentGuidesStroke = color("tree.indentGuidesStroke", "#585858", "#a9a9a9", "Tree indentation guide stroke.");
