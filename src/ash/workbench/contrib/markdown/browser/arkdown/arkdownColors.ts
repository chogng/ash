import { localize } from '../../../../../nls.js';
import type { ColorDefaults } from '../../../../../platform/theme/common/colorRegistry.js';
import { colorCssVariable, registerColor } from '../../../../../platform/theme/common/colorUtils.js';
import { contrastBorder, foreground, selectionBackground } from '../../../../../platform/theme/common/colors/baseColors.js';
import { editorBackground } from '../../../../../platform/theme/common/colors/editorColors.js';
import type { ArkdownTextColor } from './arkdownRuntime.js';

const editorColorVariables: [name: string, value: string][] = [];

function registerDocumentColor(name: string, defaults: ColorDefaults, description: string): string {
	const id = registerColor(`sessions.docs.${name}`, defaults, { owner: 'sessions.docs', description });
	editorColorVariables.push([colorCssVariable(`arkdown.${name}`), `var(${colorCssVariable(id)})`]);
	return id;
}

function textColor(name: string, light: string, dark: string, description: string): string {
	return registerDocumentColor(name, { light, dark, hcDark: foreground, hcLight: foreground }, description);
}

/** Semantic document colors keep saved palette names independent of the active theme. */
export const docsTextColorIds: Readonly<Record<ArkdownTextColor, string>> = {
	red: textColor('textRed', '#8e2626', '#ec7e7e', localize({ bundle: 'ash.docs', key: 'textRedDescription' }, 'Red document text.')),
	yellow: textColor('textYellow', '#734500', '#db9300', localize({ bundle: 'ash.docs', key: 'textYellowDescription' }, 'Yellow document text.')),
	green: textColor('textGreen', '#006300', '#55bf50', localize({ bundle: 'ash.docs', key: 'textGreenDescription' }, 'Green document text.')),
	teal: textColor('textTeal', '#065f49', '#3bbd8c', localize({ bundle: 'ash.docs', key: 'textTealDescription' }, 'Teal document text.')),
	purple: textColor('textPurple', '#4a3aa7', '#a096eb', localize({ bundle: 'ash.docs', key: 'textPurpleDescription' }, 'Purple document text.')),
};

registerDocumentColor('highlightBackground', { light: '#f5e4b5', dark: '#3b301b', hcDark: selectionBackground, hcLight: selectionBackground }, localize({ bundle: 'ash.docs', key: 'highlightDescription' }, 'Document text highlight background.'));

registerDocumentColor('commentBackground', { light: 'sessions.docs.highlightBackground', dark: 'sessions.docs.highlightBackground', hcDark: null, hcLight: null }, localize({ bundle: 'ash.docs', key: 'commentBackgroundDescription' }, 'Background of text with open document comments.'));

registerDocumentColor('tableBorder', { light: '#e8e5dc', dark: 'border', hcDark: contrastBorder, hcLight: contrastBorder }, localize({ bundle: 'ash.docs', key: 'tableBorderDescription' }, 'Document table borders.'));
registerDocumentColor('tableHeaderBackground', { light: '#f3f3f3', dark: '#191919', hcDark: editorBackground, hcLight: editorBackground }, localize({ bundle: 'ash.docs', key: 'tableHeaderBackgroundDescription' }, 'Document table header background.'));

for (const [name, light, dark, description] of [
	['Gray', '#f2f2f2', '#20201f', localize({ bundle: 'ash.docs', key: 'cellGrayDescription' }, 'Gray document table cells.')],
	['Red', '#fbe4e4', '#3c0e0e', localize({ bundle: 'ash.docs', key: 'cellRedDescription' }, 'Red document table cells.')],
	['Orange', '#f8e7da', '#371407', localize({ bundle: 'ash.docs', key: 'cellOrangeDescription' }, 'Orange document table cells.')],
	['Yellow', '#fbf0d2', '#311a00', localize({ bundle: 'ash.docs', key: 'cellYellowDescription' }, 'Yellow document table cells.')],
	['Green', '#e2f2dc', '#11260f', localize({ bundle: 'ash.docs', key: 'cellGreenDescription' }, 'Green document table cells.')],
	['Blue', '#e0edf9', '#032042', localize({ bundle: 'ash.docs', key: 'cellBlueDescription' }, 'Blue document table cells.')],
	['Purple', '#eee5fa', '#1d1649', localize({ bundle: 'ash.docs', key: 'cellPurpleDescription' }, 'Purple document table cells.')],
] as const) {
	registerDocumentColor(`cell${name}`, { light, dark, hcDark: editorBackground, hcLight: editorBackground }, description);
}

/** Expose the existing theme color IDs through variables scoped to each Arkdown editor. */
export function applyArkdownThemeColors(editor: HTMLElement): void {
	for (const [name, value] of editorColorVariables) {
		editor.style.setProperty(name, value);
	}
}
