import { localize } from '../../../../nls.js';
import { registerColor } from '../../../../platform/theme/common/colorUtils.js';

// Preserve the existing theme token so customized selection masks keep their value.
registerColor('screenshot.maskBackground', { dark: '#00000088', light: '#00000088', hcDark: '#000000', hcLight: '#ffffff' }, { description: localize('imageEditor.maskDescription', 'Mask outside the image selection.'), owner: 'workbench.imageEditor' });

/** The Workbench resolves appearance once; isolated views receive semantic values, not host CSS names. */
export function readImageEditorTheme(document: Document) {
	const root = document.querySelector('.ash-workbench') ?? document.body ?? document.documentElement;
	const computed = document.defaultView!.getComputedStyle(root);
	const value = (name: string) => computed.getPropertyValue(`--ash-${name}`);
	return {
		colors: { foreground: value('foreground'), background: value('editor-background'), panelBackground: value('menu-background'), selectionMask: value('screenshot-maskBackground'), border: value('widget-border'), focusBorder: value('focusBorder'), contrastBorder: value('contrastBorder'), inputBackground: value('input-background'), inputForeground: value('input-foreground'), inputBorder: value('input-border'), hoverBackground: value('toolbar-hoverBackground'), buttonForeground: value('button-primaryForeground'), buttonBackground: value('button-primaryBackground') },
		metrics: { fontSize: value('fontSize-body1'), labelFontSize: value('fontSize-label1'), headingFontSize: value('fontSize-heading3'), borderWidth: value('strokeThickness'), smallRadius: value('cornerRadius-small'), largeRadius: value('cornerRadius-large'), spacing: [value('spacing-size40'), value('spacing-size80'), value('spacing-size120'), value('spacing-size160')] as const },
		shadow: value('shadow-lg'),
	};
}
