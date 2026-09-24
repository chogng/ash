import type { ITheme } from "@xterm/xterm";
import { ColorId, type IColorTheme } from "../../../../../platform/theme/common/colorTheme.js";

/** Projects the workbench theme into xterm's renderer theme contract. */
export function terminalTheme(theme: IColorTheme): ITheme {
	return {
		background: theme.getColorCss(ColorId.terminalBackground),
		foreground: theme.getColorCss(ColorId.terminalForeground),
		cursor: theme.getColorCss(ColorId.terminalCursorForeground),
		selectionForeground: theme.getColorCss(ColorId.selectionForeground),
		selectionBackground: theme.getColorCss(ColorId.selectionBackground),
		black: theme.getColorCss(ColorId.terminalAnsiBlack),
		red: theme.getColorCss(ColorId.terminalAnsiRed),
		green: theme.getColorCss(ColorId.terminalAnsiGreen),
		yellow: theme.getColorCss(ColorId.terminalAnsiYellow),
		blue: theme.getColorCss(ColorId.terminalAnsiBlue),
		magenta: theme.getColorCss(ColorId.terminalAnsiMagenta),
		cyan: theme.getColorCss(ColorId.terminalAnsiCyan),
		white: theme.getColorCss(ColorId.terminalAnsiWhite),
		brightBlack: theme.getColorCss(ColorId.terminalAnsiBrightBlack),
		brightRed: theme.getColorCss(ColorId.terminalAnsiBrightRed),
		brightGreen: theme.getColorCss(ColorId.terminalAnsiBrightGreen),
		brightYellow: theme.getColorCss(ColorId.terminalAnsiBrightYellow),
		brightBlue: theme.getColorCss(ColorId.terminalAnsiBrightBlue),
		brightMagenta: theme.getColorCss(ColorId.terminalAnsiBrightMagenta),
		brightCyan: theme.getColorCss(ColorId.terminalAnsiBrightCyan),
		brightWhite: theme.getColorCss(ColorId.terminalAnsiBrightWhite),
	};
}
