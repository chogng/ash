import type { ITheme } from "@xterm/xterm";
import { selectionBackground, selectionForeground } from "../../../../../platform/theme/common/colors/baseColors.js";
import type { IColorTheme } from "../../../../../platform/theme/common/themeService.js";
import * as terminalColors from "../../common/terminalColorRegistry.js";

/** Projects the workbench theme into xterm's renderer theme contract. */
export function terminalTheme(theme: IColorTheme): ITheme {
	return {
		background: theme.getColorCss(terminalColors.terminalBackground),
		foreground: theme.getColorCss(terminalColors.terminalForeground),
		cursor: theme.getColorCss(terminalColors.terminalCursorForeground),
		selectionForeground: theme.getColorCss(selectionForeground),
		selectionBackground: theme.getColorCss(selectionBackground),
		black: theme.getColorCss(terminalColors.terminalAnsiBlack),
		red: theme.getColorCss(terminalColors.terminalAnsiRed),
		green: theme.getColorCss(terminalColors.terminalAnsiGreen),
		yellow: theme.getColorCss(terminalColors.terminalAnsiYellow),
		blue: theme.getColorCss(terminalColors.terminalAnsiBlue),
		magenta: theme.getColorCss(terminalColors.terminalAnsiMagenta),
		cyan: theme.getColorCss(terminalColors.terminalAnsiCyan),
		white: theme.getColorCss(terminalColors.terminalAnsiWhite),
		brightBlack: theme.getColorCss(terminalColors.terminalAnsiBrightBlack),
		brightRed: theme.getColorCss(terminalColors.terminalAnsiBrightRed),
		brightGreen: theme.getColorCss(terminalColors.terminalAnsiBrightGreen),
		brightYellow: theme.getColorCss(terminalColors.terminalAnsiBrightYellow),
		brightBlue: theme.getColorCss(terminalColors.terminalAnsiBrightBlue),
		brightMagenta: theme.getColorCss(terminalColors.terminalAnsiBrightMagenta),
		brightCyan: theme.getColorCss(terminalColors.terminalAnsiBrightCyan),
		brightWhite: theme.getColorCss(terminalColors.terminalAnsiBrightWhite),
	};
}
