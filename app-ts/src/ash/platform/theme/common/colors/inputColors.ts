import { registerColor } from "../colorUtils.js";
import { contrastBorder, foreground, mutedForeground, selectionBackground, selectionForeground } from "./baseColors.js";
import { listHoverBackground } from "./listColors.js";

const owner = "platform.theme.input";
const color = (id: string, dark: string, light: string, highContrastDark: string, highContrastLight: string, description: string): string =>
	registerColor(id, { dark, light, highContrastDark, highContrastLight }, { description, owner });
const alias = (id: string, value: string, description: string): string => registerColor(id, {
	dark: value, light: value, highContrastDark: value, highContrastLight: value,
}, { description, owner });

export const inputForeground = alias("input.foreground", foreground, "Input text foreground.");
export const inputBackground = color("input.background", "#313131", "#ffffff", "#000000", "#ffffff", "Input background.");
export const inputBorder = color("input.border", "#3c3c3c", "#cecece", contrastBorder, contrastBorder, "Input border.");
export const inputPlaceholderForeground = alias("input.placeholderForeground", mutedForeground, "Input placeholder foreground.");

export const buttonForeground = alias("button.foreground", foreground, "Default button foreground.");
export const buttonBorder = alias("button.border", foreground, "Border around buttons that request an explicit outline.");
export const buttonBackground = color("button.background", "#0e639c", "#0078d4", "#000000", "#ffffff", "Default button background.");
export const buttonHoverBackground = alias("button.hoverBackground", listHoverBackground, "Hovered button background.");
export const buttonActiveBackground = color("button.activeBackground", "#37373d", "#dcdcdc", "#333333", "#dddddd", "Pressed button background.");
export const buttonSecondaryBackground = color("button.secondaryBackground", "#3a3d41", "#e5e5e5", "#000000", "#ffffff", "Secondary button background.");
export const primaryButtonForeground = color("button.primaryForeground", "#ffffff", "#ffffff", selectionForeground, selectionForeground, "Primary button foreground.");
export const primaryButtonBackground = registerColor("button.primaryBackground", {
	dark: buttonBackground, light: buttonBackground,
	highContrastDark: selectionBackground, highContrastLight: selectionBackground,
}, { description: "Primary button background.", owner });
export const primaryButtonHoverBackground = color("button.primaryHoverBackground", "#1177bb", "#006cbe", selectionBackground, selectionBackground, "Hovered primary button background.");

export const keybindingLabelForeground = color("keybindingLabel.foreground", "#cccccc", "#555555", foreground, foreground, "Keybinding label foreground.");
export const keybindingLabelBackground = color("keybindingLabel.background", "#8080802b", "#dddddd66", "#000000", "#ffffff", "Keybinding label background.");
export const keybindingLabelBorder = color("keybindingLabel.border", "#80808033", "#cccccc66", contrastBorder, contrastBorder, "Keybinding label border.");
export const keybindingLabelBottomBorder = color("keybindingLabel.bottomBorder", "#6b6b6b", "#b0b0b0", contrastBorder, contrastBorder, "Keybinding label bottom border.");
