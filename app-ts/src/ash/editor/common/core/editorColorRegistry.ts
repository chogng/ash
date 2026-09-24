import { registerColor, transparent } from '../../../platform/theme/common/colorUtils.js';
import { editorBackground, editorForeground } from '../../../platform/theme/common/colors/editorColors.js';

import { descriptionForeground, mutedForeground, selectionBackground } from '../../../platform/theme/common/colors/baseColors.js';

const owner = 'editor.presentation';
const alias = (id: string, value: string, description: string): string => registerColor(id, { dark: value, light: value }, { description, owner });

function editorColor(id: string, value: string, description: string): string {
	return registerColor(id, { dark: value, light: value, highContrastDark: value, highContrastLight: value }, { description, owner });
}

export const editorSelectionBackground = editorColor('editor.selectionBackground', selectionBackground, 'Background of editor text selections.');
export const editorInactiveSelection = registerColor('editor.inactiveSelectionBackground', {
	dark: transparent(selectionBackground, 0.65), light: transparent(selectionBackground, 0.65),
	highContrastDark: selectionBackground, highContrastLight: selectionBackground,
}, { description: 'Background of selections in an unfocused editor.', owner });
export const editorGutter = editorColor('editorGutter.background', editorBackground, 'Background of the editor gutter.');
export const editorWhitespace = editorColor('editorWhitespace.foreground', mutedForeground, 'Foreground of visible editor whitespace.');
export const editorLineNumbers = editorColor('editorLineNumber.foreground', descriptionForeground, 'Foreground of editor line numbers.');
export const editorActiveLineNumber = editorColor('editorLineNumber.activeForeground', editorForeground, 'Foreground of the current editor line number.');

export const editorCursorForeground = registerColor(
	'editorCursor.foreground',
	{ dark: '#aeafad', light: '#000000', highContrastDark: '#ffffff', highContrastLight: '#0f4a85' },
	{ description: 'Foreground for the editor cursor.', owner },
);
export const editorCursorBackground = alias('editorCursor.background', editorBackground, 'Foreground for a character covered by a block editor cursor.');
export const editorMultiCursorPrimaryForeground = alias('editorMultiCursor.primary.foreground', editorCursorForeground, 'Foreground for the primary cursor when multiple cursors are active.');
export const editorMultiCursorPrimaryBackground = alias('editorMultiCursor.primary.background', editorCursorBackground, 'Foreground for a character covered by the primary cursor when multiple cursors are active.');
export const editorMultiCursorSecondaryForeground = alias('editorMultiCursor.secondary.foreground', editorCursorForeground, 'Foreground for secondary cursors when multiple cursors are active.');
export const editorMultiCursorSecondaryBackground = alias('editorMultiCursor.secondary.background', editorCursorBackground, 'Foreground for a character covered by a secondary cursor when multiple cursors are active.');
export const editorOverviewRulerBorder = registerColor(
	'editorOverviewRuler.border',
	{ dark: '#7f7f7f4d', light: '#7f7f7f4d', highContrastDark: '#7f7f7f4d', highContrastLight: '#666666' },
	{ description: 'Color of the editor overview ruler border.', owner },
);
export const editorOverviewRulerBackground = registerColor(
	'editorOverviewRuler.background',
	{
		dark: transparent(editorBackground, 0),
		light: transparent(editorBackground, 0),
		highContrastDark: transparent(editorBackground, 0),
		highContrastLight: transparent(editorBackground, 0),
	},
	{ description: 'Background color of the editor overview ruler.', owner, needsTransparency: true },
);
export const editorLineHighlight = registerColor(
	'editor.lineHighlightBackground',
	{ dark: '#00000000', light: '#00000000', highContrastDark: '#00000000', highContrastLight: '#00000000' },
	{ description: 'Background for the line at the primary cursor position.', owner },
);
export const editorInactiveLineHighlight = registerColor(
	'editor.inactiveLineHighlightBackground',
	{ dark: editorLineHighlight, light: editorLineHighlight, highContrastDark: editorLineHighlight, highContrastLight: editorLineHighlight },
	{ description: 'Background for the line at the primary cursor position when the editor is not focused.', owner },
);
export const editorLineHighlightBorder = registerColor(
	'editor.lineHighlightBorder',
	{ dark: '#282828', light: '#eeeeee', highContrastDark: '#f38518', highContrastLight: '#0f4a85' },
	{ description: 'Border around the line at the primary cursor position.', owner },
);
export const editorRuler = registerColor(
	'editorRuler.foreground',
	{ dark: '#5a5a5a', light: '#d3d3d3', highContrastDark: '#ffffff', highContrastLight: '#292929' },
	{ description: 'Color of editor rulers.', owner },
);

export const editorBracketHighlightingForeground1 = registerColor(
	'editorBracketHighlight.foreground1',
	{ dark: '#e5c07b', light: '#795e00', highContrastDark: '#ffff00', highContrastLight: '#795e00' },
	{ description: 'Foreground for the first bracket nesting color.', owner },
);
export const editorBracketHighlightingForeground2 = registerColor(
	'editorBracketHighlight.foreground2',
	{ dark: '#c678dd', light: '#8841a0', highContrastDark: '#ff70e8', highContrastLight: '#8841a0' },
	{ description: 'Foreground for the second bracket nesting color.', owner },
);
export const editorBracketHighlightingForeground3 = registerColor(
	'editorBracketHighlight.foreground3',
	{ dark: '#56b6c2', light: '#007681', highContrastDark: '#00ffff', highContrastLight: '#007681' },
	{ description: 'Foreground for the third bracket nesting color.', owner },
);
export const editorBracketHighlightingForeground4 = registerColor(
	'editorBracketHighlight.foreground4',
	{ dark: '#98c379', light: '#387d22', highContrastDark: '#8cff66', highContrastLight: '#387d22' },
	{ description: 'Foreground for the fourth bracket nesting color.', owner },
);
export const editorBracketHighlightingForeground5 = registerColor(
	'editorBracketHighlight.foreground5',
	{ dark: '#e06c75', light: '#a12c40', highContrastDark: '#ff9d9d', highContrastLight: '#a12c40' },
	{ description: 'Foreground for the fifth bracket nesting color.', owner },
);
export const editorBracketHighlightingForeground6 = registerColor(
	'editorBracketHighlight.foreground6',
	{ dark: '#61afef', light: '#005fb8', highContrastDark: '#9ac8ff', highContrastLight: '#005fb8' },
	{ description: 'Foreground for the sixth bracket nesting color.', owner },
);

export const editorIndentGuide1 = registerColor(
	'editorIndentGuide.background1',
	{ dark: '#454545', light: '#c4c4c4', highContrastDark: '#a0a0a0', highContrastLight: '#666666' },
	{ description: 'Color of editor indentation guides.', owner },
);
export const editorActiveIndentGuide1 = registerColor(
	'editorIndentGuide.activeBackground1',
	{ dark: '#909090', light: '#707070', highContrastDark: '#ffffff', highContrastLight: '#000000' },
	{ description: 'Color of the active editor indentation guide.', owner },
);

function bracketGuideColor(id: string, foreground: string): string {
	return registerColor(id, {
		dark: transparent(foreground, 0.4),
		light: transparent(foreground, 0.4),
		highContrastDark: foreground,
		highContrastLight: foreground,
	}, { description: 'Color of an inactive bracket pair guide.', owner });
}

export const editorBracketPairGuideBackground1 = bracketGuideColor('editorBracketPairGuide.background1', editorBracketHighlightingForeground1);
export const editorBracketPairGuideBackground2 = bracketGuideColor('editorBracketPairGuide.background2', editorBracketHighlightingForeground2);
export const editorBracketPairGuideBackground3 = bracketGuideColor('editorBracketPairGuide.background3', editorBracketHighlightingForeground3);
export const editorBracketPairGuideBackground4 = bracketGuideColor('editorBracketPairGuide.background4', editorBracketHighlightingForeground4);
export const editorBracketPairGuideBackground5 = bracketGuideColor('editorBracketPairGuide.background5', editorBracketHighlightingForeground5);
export const editorBracketPairGuideBackground6 = bracketGuideColor('editorBracketPairGuide.background6', editorBracketHighlightingForeground6);

export const editorBracketPairGuideActiveBackground1 = alias('editorBracketPairGuide.activeBackground1', editorBracketHighlightingForeground1, 'Color of the first active bracket pair guide.');
export const editorBracketPairGuideActiveBackground2 = alias('editorBracketPairGuide.activeBackground2', editorBracketHighlightingForeground2, 'Color of the second active bracket pair guide.');
export const editorBracketPairGuideActiveBackground3 = alias('editorBracketPairGuide.activeBackground3', editorBracketHighlightingForeground3, 'Color of the third active bracket pair guide.');
export const editorBracketPairGuideActiveBackground4 = alias('editorBracketPairGuide.activeBackground4', editorBracketHighlightingForeground4, 'Color of the fourth active bracket pair guide.');
export const editorBracketPairGuideActiveBackground5 = alias('editorBracketPairGuide.activeBackground5', editorBracketHighlightingForeground5, 'Color of the fifth active bracket pair guide.');
export const editorBracketPairGuideActiveBackground6 = alias('editorBracketPairGuide.activeBackground6', editorBracketHighlightingForeground6, 'Color of the sixth active bracket pair guide.');
