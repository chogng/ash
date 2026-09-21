import { registerColor, transparent } from '../../../platform/theme/common/colorRegistry.js';
import { editorBackground } from '../../../platform/theme/common/colors/workbenchColors.js';

const owner = 'editor.presentation';
const alias = (id: string, value: string, description: string): string => registerColor(id, { dark: value, light: value }, { description, owner });

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
