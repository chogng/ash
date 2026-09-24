import { registerColor } from "../colorRegistry.js";

const owner = "collaboration.presentation";
const color = (id: string, dark: string, light: string, description: string): string => registerColor(id, { dark, light }, { description, owner });

export const selection0Background = color("collaboration.selection0Background", "#3584e4", "#3584e4", "Background tint for the first concurrent collaborator selection.");
export const selection1Background = color("collaboration.selection1Background", "#9141ac", "#9141ac", "Background tint for the second concurrent collaborator selection.");
export const selection2Background = color("collaboration.selection2Background", "#26a269", "#26a269", "Background tint for the third concurrent collaborator selection.");
export const selection3Background = color("collaboration.selection3Background", "#c64600", "#c64600", "Background tint for the fourth concurrent collaborator selection.");
