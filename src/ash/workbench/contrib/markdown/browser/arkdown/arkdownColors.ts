import { localize } from '../../../../../nls.js';
import { registerColor } from '../../../../../platform/theme/common/colorUtils.js';
import { contrastBorder, foreground, selectionBackground } from '../../../../../platform/theme/common/colors/baseColors.js';
import { editorBackground } from '../../../../../platform/theme/common/colors/editorColors.js';
import type { ArkdownTextColor } from './arkdownRuntime.js';

function textColor(id: string, light: string, dark: string, description: string): string {
	return registerColor(id, { light, dark, hcDark: foreground, hcLight: foreground }, { owner: 'sessions.docs', description });
}

/** Semantic document colors keep saved palette names independent of the active theme. */
export const docsTextColorIds: Readonly<Record<ArkdownTextColor, string>> = {
	red: textColor('sessions.docs.textRed', '#8e2626', '#ec7e7e', localize({ bundle: 'ash.docs', key: 'textRedDescription' }, 'Red document text.')),
	yellow: textColor('sessions.docs.textYellow', '#734500', '#db9300', localize({ bundle: 'ash.docs', key: 'textYellowDescription' }, 'Yellow document text.')),
	green: textColor('sessions.docs.textGreen', '#006300', '#55bf50', localize({ bundle: 'ash.docs', key: 'textGreenDescription' }, 'Green document text.')),
	teal: textColor('sessions.docs.textTeal', '#065f49', '#3bbd8c', localize({ bundle: 'ash.docs', key: 'textTealDescription' }, 'Teal document text.')),
	purple: textColor('sessions.docs.textPurple', '#4a3aa7', '#a096eb', localize({ bundle: 'ash.docs', key: 'textPurpleDescription' }, 'Purple document text.')),
};

registerColor('sessions.docs.highlightBackground', { light: '#f5e4b5', dark: '#3b301b', hcDark: selectionBackground, hcLight: selectionBackground }, { owner: 'sessions.docs', description: localize({ bundle: 'ash.docs', key: 'highlightDescription' }, 'Document text highlight background.') });

registerColor('sessions.docs.commentBackground', { light: 'sessions.docs.highlightBackground', dark: 'sessions.docs.highlightBackground', hcDark: null, hcLight: null }, { owner: 'sessions.docs', description: localize({ bundle: 'ash.docs', key: 'commentBackgroundDescription' }, 'Background of text with open document comments.') });

registerColor('sessions.docs.tableBorder', { light: '#e8e5dc', dark: 'border', hcDark: contrastBorder, hcLight: contrastBorder }, { owner: 'sessions.docs', description: localize({ bundle: 'ash.docs', key: 'tableBorderDescription' }, 'Document table borders.') });
registerColor('sessions.docs.tableHeaderBackground', { light: '#f3f3f3', dark: '#191919', hcDark: editorBackground, hcLight: editorBackground }, { owner: 'sessions.docs', description: localize({ bundle: 'ash.docs', key: 'tableHeaderBackgroundDescription' }, 'Document table header background.') });

for (const [name, light, dark, description] of [
	['Gray', '#f2f2f2', '#20201f', localize({ bundle: 'ash.docs', key: 'cellGrayDescription' }, 'Gray document table cells.')],
	['Red', '#fbe4e4', '#3c0e0e', localize({ bundle: 'ash.docs', key: 'cellRedDescription' }, 'Red document table cells.')],
	['Orange', '#f8e7da', '#371407', localize({ bundle: 'ash.docs', key: 'cellOrangeDescription' }, 'Orange document table cells.')],
	['Yellow', '#fbf0d2', '#311a00', localize({ bundle: 'ash.docs', key: 'cellYellowDescription' }, 'Yellow document table cells.')],
	['Green', '#e2f2dc', '#11260f', localize({ bundle: 'ash.docs', key: 'cellGreenDescription' }, 'Green document table cells.')],
	['Blue', '#e0edf9', '#032042', localize({ bundle: 'ash.docs', key: 'cellBlueDescription' }, 'Blue document table cells.')],
	['Purple', '#eee5fa', '#1d1649', localize({ bundle: 'ash.docs', key: 'cellPurpleDescription' }, 'Purple document table cells.')],
] as const) {
	registerColor(`sessions.docs.cell${name}`, { light, dark, hcDark: editorBackground, hcLight: editorBackground }, { owner: 'sessions.docs', description });
}
