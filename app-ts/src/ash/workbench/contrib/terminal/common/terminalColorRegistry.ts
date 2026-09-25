import { registerColor } from '../../../../platform/theme/common/colorUtils.js';
import { foreground } from '../../../../platform/theme/common/colors/baseColors.js';
import { editorBackground, editorForeground } from '../../../../platform/theme/common/colors/editorColors.js';

const owner = 'terminal.presentation';
const color = (id: string, dark: string, light: string, highContrastDark: string, highContrastLight: string, description: string): string =>
	registerColor(id, { dark, light, highContrastDark, highContrastLight }, { description, owner });
const alias = (id: string, value: string, description: string): string => registerColor(id, {
	dark: value, light: value, highContrastDark: value, highContrastLight: value,
}, { description, owner });

export const terminalBackground = alias('terminal.background', editorBackground, 'Terminal background.');
export const terminalForeground = alias('terminal.foreground', editorForeground, 'Terminal default foreground.');
export const terminalCursorForeground = alias('terminal.cursorForeground', foreground, 'Terminal cursor foreground.');
export const terminalAnsiBlack = color('terminal.ansiBlack', '#24292f', '#24292f', '#808080', '#333333', 'Terminal ANSI black.');
export const terminalAnsiRed = color('terminal.ansiRed', '#cf222e', '#cf222e', '#ff8080', '#a00000', 'Terminal ANSI red.');
export const terminalAnsiGreen = color('terminal.ansiGreen', '#116329', '#116329', '#80ff80', '#006b00', 'Terminal ANSI green.');
export const terminalAnsiYellow = color('terminal.ansiYellow', '#9a6700', '#9a6700', '#ffff80', '#654000', 'Terminal ANSI yellow.');
export const terminalAnsiBlue = color('terminal.ansiBlue', '#0969da', '#0969da', '#80bfff', '#0044aa', 'Terminal ANSI blue.');
export const terminalAnsiMagenta = color('terminal.ansiMagenta', '#8250df', '#8250df', '#ff80ff', '#800080', 'Terminal ANSI magenta.');
export const terminalAnsiCyan = color('terminal.ansiCyan', '#1b7c83', '#1b7c83', '#80ffff', '#006070', 'Terminal ANSI cyan.');
export const terminalAnsiWhite = alias('terminal.ansiWhite', terminalForeground, 'Terminal ANSI white.');
export const terminalAnsiBrightBlack = color('terminal.ansiBrightBlack', '#6e7781', '#6e7781', '#aaaaaa', '#555555', 'Terminal ANSI bright black.');
export const terminalAnsiBrightRed = color('terminal.ansiBrightRed', '#a40e26', '#a40e26', '#ffaaaa', '#800000', 'Terminal ANSI bright red.');
export const terminalAnsiBrightGreen = color('terminal.ansiBrightGreen', '#1a7f37', '#1a7f37', '#aaffaa', '#005500', 'Terminal ANSI bright green.');
export const terminalAnsiBrightYellow = color('terminal.ansiBrightYellow', '#bf8700', '#bf8700', '#ffffaa', '#554400', 'Terminal ANSI bright yellow.');
export const terminalAnsiBrightBlue = color('terminal.ansiBrightBlue', '#218bff', '#218bff', '#aaccff', '#003388', 'Terminal ANSI bright blue.');
export const terminalAnsiBrightMagenta = color('terminal.ansiBrightMagenta', '#a475f9', '#a475f9', '#ffaaff', '#660066', 'Terminal ANSI bright magenta.');
export const terminalAnsiBrightCyan = color('terminal.ansiBrightCyan', '#3192aa', '#3192aa', '#aaffff', '#004455', 'Terminal ANSI bright cyan.');
export const terminalAnsiBrightWhite = color('terminal.ansiBrightWhite', '#8c959f', '#8c959f', '#ffffff', '#000000', 'Terminal ANSI bright white.');
