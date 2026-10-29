import { colorCssVariable } from '../../../../platform/theme/common/colorUtils.js';
import { asCssVariableName, sizeValueToCss } from '../../../../platform/theme/common/sizeUtils.js';
import { ColorScheme, isDarkColorScheme } from '../../../../platform/theme/common/theme.js';
import type { IColorTheme } from '../../../../platform/theme/common/themeService.js';

/** CSS emitted by the theme service, also used by pre-workbench window hosts. */
export class CSSValue {
	constructor(readonly code: string) {}
}

/** Serializes a resolved theme without retaining a document or mutating its nodes. */
export function generateColorThemeCSS(theme: IColorTheme, scopeSelector: string): CSSValue {
	const declarations = theme.colorEntries.map(({ id, value }) => `${colorCssVariable(id)}: ${value?.toString() ?? 'initial'};`);
	for (const { id, value } of theme.sizeEntries) {
		declarations.push(`${asCssVariableName(id)}: ${sizeValueToCss(value)};`);
	}
	const highContrast = theme.colorScheme === ColorScheme.HighContrastDark || theme.colorScheme === ColorScheme.HighContrastLight;
	declarations.push(
		`color-scheme: ${isDarkColorScheme(theme.colorScheme) ? 'dark' : 'light'};`,
		`forced-color-adjust: ${highContrast ? 'none' : 'auto'};`,
		`--ash-shadow-lg: ${highContrast ? 'none' : '0 0 12px rgba(0, 0, 0, 0.14)'};`,
	);
	return new CSSValue(`${scopeSelector} {\n${declarations.join('\n')}\n}`);
}
