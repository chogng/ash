import { registerColor } from "../colorUtils.js";
import { foreground, mutedForeground } from "./baseColors.js";
import { listHoverBackground } from "./listColors.js";

const owner = "platform.theme.input";
const color = (id: string, dark: string, light: string, description: string): string => registerColor(id, { dark, light }, { description, owner });
const alias = (id: string, value: string, description: string): string => registerColor(id, { dark: value, light: value }, { description, owner });

export const inputForeground = alias("input.foreground", foreground, "Input text foreground.");
export const inputBackground = color("input.background", "#313131", "#ffffff", "Input background.");
export const inputBorder = color("input.border", "#3c3c3c", "#cecece", "Input border.");
export const inputPlaceholderForeground = alias("input.placeholderForeground", mutedForeground, "Input placeholder foreground.");

export const buttonForeground = alias("button.foreground", foreground, "Default button foreground.");
export const buttonBorder = alias("button.border", foreground, "Border around buttons that request an explicit outline.");
export const buttonBackground = color("button.background", "#0e639c", "#0078d4", "Default button background.");
export const buttonHoverBackground = alias("button.hoverBackground", listHoverBackground, "Hovered button background.");
export const buttonActiveBackground = color("button.activeBackground", "#37373d", "#dcdcdc", "Pressed button background.");
export const buttonSecondaryBackground = color("button.secondaryBackground", "#3a3d41", "#e5e5e5", "Secondary button background.");
export const primaryButtonForeground = color("button.primaryForeground", "#ffffff", "#ffffff", "Primary button foreground.");
export const primaryButtonBackground = alias("button.primaryBackground", buttonBackground, "Primary button background.");
export const primaryButtonHoverBackground = color("button.primaryHoverBackground", "#1177bb", "#006cbe", "Hovered primary button background.");

export const keybindingLabelForeground = color("keybindingLabel.foreground", "#cccccc", "#555555", "Keybinding label foreground.");
export const keybindingLabelBackground = color("keybindingLabel.background", "#8080802b", "#dddddd66", "Keybinding label background.");
export const keybindingLabelBorder = color("keybindingLabel.border", "#80808033", "#cccccc66", "Keybinding label border.");
export const keybindingLabelBottomBorder = color("keybindingLabel.bottomBorder", "#6b6b6b", "#b0b0b0", "Keybinding label bottom border.");
