import { registerColor } from "../colorRegistry.js";

const owner = "chat.presentation";
const color = (id: string, dark: string, light: string, description: string): string => registerColor(id, { dark, light }, { description, owner });

export const chatTabBackground = color("chat.tabBackground", "#EEEEEE", "#EEEEEE", "Background for inactive Chat session tabs.");
