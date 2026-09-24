import { registerColor } from "../colorRegistry.js";
import { foreground } from "./baseColors.js";
import { editorBackground, editorForeground } from "./workbenchColors.js";

const owner = "terminal.presentation";
const color = (id: string, dark: string, light: string, description: string): string => registerColor(id, { dark, light }, { description, owner });
const alias = (id: string, value: string, description: string): string => registerColor(id, { dark: value, light: value }, { description, owner });

export const terminalBackground = alias("terminal.background", editorBackground, "Terminal background.");
export const terminalForeground = alias("terminal.foreground", editorForeground, "Terminal default foreground.");
export const terminalCursorForeground = alias("terminal.cursorForeground", foreground, "Terminal cursor foreground.");
export const terminalAnsiBlack = color("terminal.ansiBlack", "#24292f", "#24292f", "Terminal ANSI black.");
export const terminalAnsiRed = color("terminal.ansiRed", "#cf222e", "#cf222e", "Terminal ANSI red.");
export const terminalAnsiGreen = color("terminal.ansiGreen", "#116329", "#116329", "Terminal ANSI green.");
export const terminalAnsiYellow = color("terminal.ansiYellow", "#9a6700", "#9a6700", "Terminal ANSI yellow.");
export const terminalAnsiBlue = color("terminal.ansiBlue", "#0969da", "#0969da", "Terminal ANSI blue.");
export const terminalAnsiMagenta = color("terminal.ansiMagenta", "#8250df", "#8250df", "Terminal ANSI magenta.");
export const terminalAnsiCyan = color("terminal.ansiCyan", "#1b7c83", "#1b7c83", "Terminal ANSI cyan.");
export const terminalAnsiWhite = alias("terminal.ansiWhite", terminalForeground, "Terminal ANSI white.");
export const terminalAnsiBrightBlack = color("terminal.ansiBrightBlack", "#6e7781", "#6e7781", "Terminal ANSI bright black.");
export const terminalAnsiBrightRed = color("terminal.ansiBrightRed", "#a40e26", "#a40e26", "Terminal ANSI bright red.");
export const terminalAnsiBrightGreen = color("terminal.ansiBrightGreen", "#1a7f37", "#1a7f37", "Terminal ANSI bright green.");
export const terminalAnsiBrightYellow = color("terminal.ansiBrightYellow", "#bf8700", "#bf8700", "Terminal ANSI bright yellow.");
export const terminalAnsiBrightBlue = color("terminal.ansiBrightBlue", "#218bff", "#218bff", "Terminal ANSI bright blue.");
export const terminalAnsiBrightMagenta = color("terminal.ansiBrightMagenta", "#a475f9", "#a475f9", "Terminal ANSI bright magenta.");
export const terminalAnsiBrightCyan = color("terminal.ansiBrightCyan", "#3192aa", "#3192aa", "Terminal ANSI bright cyan.");
export const terminalAnsiBrightWhite = color("terminal.ansiBrightWhite", "#8c959f", "#8c959f", "Terminal ANSI bright white.");
