import { registerColor } from "../colorRegistry.js";
import { accentBackground } from "./baseColors.js";

const owner = "files.presentation";
const alias = (id: string, value: string, description: string): string => registerColor(id, { dark: value, light: value }, { description, owner });

export const emptyExplorerOpenFolderBackground = alias("files.emptyExplorerOpenFolderBackground", accentBackground, "Background for the Empty Explorer Open Folder action.");
export const emptyExplorerOpenFolderHoverBackground = alias("files.emptyExplorerOpenFolderHoverBackground", emptyExplorerOpenFolderBackground, "Hovered background for the Empty Explorer Open Folder action.");
