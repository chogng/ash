import { registerColor, transparent } from "../colorUtils.js";
import { accentForeground, errorForeground, foreground, successForeground, warningForeground } from "./baseColors.js";

const owner = "platform.theme.charts";
const alias = (id: string, value: string, description: string): string => registerColor(id, {
	dark: value,
	light: value,
	highContrastDark: value,
	highContrastLight: value,
}, { description, owner });

export const chartsForeground = alias("charts.foreground", foreground, "Chart label foreground.");
export const chartsLines = registerColor("charts.lines", {
	dark: transparent(foreground, 0.5),
	light: transparent(foreground, 0.5),
	highContrastDark: foreground,
	highContrastLight: foreground,
}, { description: "Chart guide lines.", owner });
export const chartsRed = alias("charts.red", errorForeground, "Red chart series.");
export const chartsBlue = alias("charts.blue", accentForeground, "Blue chart series.");
export const chartsYellow = alias("charts.yellow", warningForeground, "Yellow chart series.");
export const chartsOrange = registerColor("charts.orange", {
	dark: "#d18616",
	light: "#a65b00",
	highContrastDark: "#ffb454",
	highContrastLight: "#804400",
}, { description: "Orange chart series.", owner });
export const chartsGreen = alias("charts.green", successForeground, "Green chart series.");
export const chartsPurple = registerColor("charts.purple", {
	dark: "#b180d7",
	light: "#652d90",
	highContrastDark: "#d6a5ff",
	highContrastLight: "#652d90",
}, { description: "Purple chart series.", owner });
