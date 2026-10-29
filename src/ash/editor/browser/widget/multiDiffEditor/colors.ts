import { registerColor, mix } from '../../../../platform/theme/common/colorUtils.js';

const owner = 'editor.multiDiffEditor';

export const multiDiffEditorHeaderBackground = registerColor('multiDiffEditor.headerBackground', {
	dark: mix('editor.background', 'foreground', 0.08),
	light: mix('editor.background', 'foreground', 0.08),
	hcDark: 'editor.background',
	hcLight: 'editor.background',
}, {
	description: 'Background of each file header in a multi-file diff editor.',
	owner,
});

export const multiDiffEditorBackground = registerColor('multiDiffEditor.background', {
	dark: 'editor.background',
	light: 'editor.background',
	hcDark: 'editor.background',
	hcLight: 'editor.background',
}, {
	description: 'Background of a multi-file diff editor.',
	owner,
});

export const multiDiffEditorBorder = registerColor('multiDiffEditor.border', {
	dark: 'widget.border',
	light: 'widget.border',
	hcDark: '#ffffff',
	hcLight: '#000000',
}, {
	description: 'Border around a file comparison in a multi-file diff editor.',
	owner,
});
