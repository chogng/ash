import { localize } from '../../../../nls.js';
import { registerColor } from '../../../../platform/theme/common/colorUtils.js';
import { darkColorTheme, highContrastDarkColorTheme, highContrastLightColorTheme, lightColorTheme } from '../../../../platform/theme/common/colorTheme.js';
import { sizeValueToCss } from '../../../../platform/theme/common/sizeUtils.js';

// Preserve the existing theme token so customized selection masks keep their value.
registerColor('screenshot.maskBackground', { dark: '#00000088', light: '#00000088', hcDark: '#000000', hcLight: '#ffffff' }, { description: localize('imageEditor.maskDescription', 'Mask outside the image selection.'), owner: 'workbench.imageEditor' });

/** The Workbench resolves appearance once; isolated views receive semantic values, not host CSS names. */
export function readImageEditorTheme(document: Document, root = document.querySelector('.ash-workbench') ?? document.body ?? document.documentElement) {
	const computed = document.defaultView!.getComputedStyle(root);
	const value = (name: string) => computed.getPropertyValue(`--ash-${name.replaceAll('.', '-')}`);
	return imageEditorTheme(value, value, value('shadow-lg'));
}

export function defaultImageEditorTheme(scheme: unknown) {
	const theme = getDefaultImageEditorColorTheme(scheme);
	return imageEditorTheme(id => theme.getColorCss(id) ?? 'transparent', id => {
		const value = theme.getSize(id);
		return value ? sizeValueToCss(value) : '0px';
	}, 'none');
}

export function getDefaultImageEditorColorTheme(scheme: unknown) {
	return scheme === 'light' ? lightColorTheme : scheme === 'hcDark' ? highContrastDarkColorTheme : scheme === 'hcLight' ? highContrastLightColorTheme : darkColorTheme;
}

function imageEditorTheme(color: (id: string) => string, size: (id: string) => string, shadow: string) {
	return {
		colors: { foreground: color('foreground'), background: color('editor.background'), panelBackground: color('menu.background'), selectionMask: color('screenshot.maskBackground'), border: color('widget.border'), focusBorder: color('focusBorder'), contrastBorder: color('contrastBorder'), inputBackground: color('input.background'), inputForeground: color('input.foreground'), inputBorder: color('input.border'), hoverBackground: color('toolbar.hoverBackground'), buttonForeground: color('button.primaryForeground'), buttonBackground: color('button.primaryBackground') },
		metrics: { fontSize: size('fontSize.body1'), labelFontSize: size('fontSize.label1'), headingFontSize: size('fontSize.heading3'), borderWidth: size('strokeThickness'), smallRadius: size('cornerRadius.small'), largeRadius: size('cornerRadius.large'), spacing: [size('spacing.size40'), size('spacing.size80'), size('spacing.size120'), size('spacing.size160')] as const },
		shadow,
	};
}
