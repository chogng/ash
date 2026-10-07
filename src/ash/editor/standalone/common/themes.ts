import { Color } from '../../../base/common/color.js';
import { darkColorTheme, highContrastDarkColorTheme, highContrastLightColorTheme, lightColorTheme } from '../../../platform/theme/common/colorTheme.js';
import type { IColorTheme } from '../../../platform/theme/common/themeService.js';
import * as editorColors from '../../../platform/theme/common/colors/editorColors.js';
import type { BuiltinTheme, IStandaloneThemeData } from './standaloneTheme.js';

/** Standard theme inputs use the same registered colors as the rest of Ash. */
function themeData(base: BuiltinTheme, theme: IColorTheme): IStandaloneThemeData {
	const foreground = theme.getColor('editor.foreground')!;
	const background = theme.getColor('editor.background')!;
	const scopes = [
		['comment', editorColors.tokenCommentForeground],
		['keyword', editorColors.tokenKeywordForeground],
		['string', editorColors.tokenStringForeground],
		['number', editorColors.tokenNumberForeground],
		['regexp', editorColors.tokenRegexpForeground],
		['type', editorColors.tokenTypeForeground],
		['function', editorColors.tokenFunctionForeground],
		['variable', editorColors.tokenVariableForeground],
		['operator', editorColors.tokenOperatorForeground],
	] as const;
	return {
		base,
		inherit: false,
		colors: {},
		rules: [
			{ token: '', foreground: Color.Format.CSS.formatHex(foreground), background: Color.Format.CSS.formatHex(background) },
			...scopes.map(([token, color]) => ({ token, foreground: Color.Format.CSS.formatHex(theme.getColor(color)!) })),
		],
	};
}

export const vs = themeData('vs', lightColorTheme);
export const vs_dark = themeData('vs-dark', darkColorTheme);
export const hc_black = themeData('hc-black', highContrastDarkColorTheme);
export const hc_light = themeData('hc-light', highContrastLightColorTheme);
