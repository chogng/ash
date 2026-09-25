import { registerColor } from "../colorUtils.js";

const owner = "platform.theme";
const color = (id: string, dark: string, light: string, highContrastDark: string | null, highContrastLight: string | null, description: string): string =>
	registerColor(id, { dark, light, highContrastDark, highContrastLight }, { description, owner });

export const foreground = color("foreground", "#cccccc", "#3b3b3b", "#ffffff", "#000000", "Default foreground color.");
export const descriptionForeground = color("description.foreground", "#b8b8b8", "#616161", foreground, foreground, "Foreground for descriptive text.");
export const mutedForeground = color("muted.foreground", "#8f8f8f", "#767676", foreground, foreground, "Foreground for de-emphasized text.");
export const accentForeground = color("accent.foreground", "#4daafc", "#005fb8", "#ffff00", "#0000ee", "Foreground for links and accent content.");
export const accentBackground = color("accent.background", "#328eb9", "#328eb9", "#000000", "#ffffff", "Background for accented controls and indicators.");
export const errorForeground = color("error.foreground", "#f48771", "#a1260d", "#ff8080", "#a1260d", "Foreground for errors.");
export const warningForeground = color("warning.foreground", "#cca700", "#895503", "#ffff00", "#654000", "Foreground for warnings.");
export const successForeground = color("success.foreground", "#89d185", "#107c10", "#80ff80", "#006b00", "Foreground for successful states.");
export const focusBorder = color("focusBorder", "#007fd4", "#0078d4", "#ffffff", "#000000", "Border for focused controls.");
export const border = color("border", "#2b2b2b", "#e5e5e5", "contrastBorder", "contrastBorder", "Default separator border.");
export const contrastBorder = registerColor("contrastBorder", {
	dark: null,
	light: null,
	highContrastDark: "#ffffff",
	highContrastLight: "#000000",
}, { description: "Extra border separating elements in high contrast themes.", owner });
export const widgetBorder = color("widget.border", "#454545", "#d4d4d4", contrastBorder, contrastBorder, "Border around floating widgets.");
export const widgetShadow = color("widget.shadow", "#00000066", "#00000029", null, null, "Shadow around floating widgets.");
export const selectionForeground = color("selection.foreground", "#ffffff", "#000000", "#000000", "#ffffff", "Selected text foreground.");
export const selectionBackground = color("selection.background", "#264f78", "#add6ff", "#ffffff", "#000000", "Selected text background.");
export const textLinkActiveForeground = color("textLink.activeForeground", "#4e94ce", "#006ab1", accentForeground, accentForeground, "Foreground for active links and link-like editor actions.");
