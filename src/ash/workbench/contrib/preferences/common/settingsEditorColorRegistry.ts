import { registerColor, transparent } from '../../../../platform/theme/common/colorUtils.js';

const owner = 'workbench.preferences';

export const itemBackground = registerColor('settings.itemBackground', { dark: '#252526', light: '#f3f3f3', hcDark: '#000000', hcLight: '#ffffff' }, {
	description: 'Background for configuration items in the Settings editor.',
	owner,
});

export const itemSeparator = registerColor('settings.itemSeparator', { dark: '#383838', light: '#e0e0e0', hcDark: 'contrastBorder', hcLight: 'contrastBorder' }, {
	description: 'Separator between configuration items in the Settings editor.',
	owner,
});

export const settingsHeaderForeground = registerColor('settings.headerForeground', { dark: 'foreground', light: 'foreground', hcDark: 'foreground', hcLight: 'foreground' }, {
	description: 'Foreground for Settings editor section headers.',
	owner,
});

export const settingsHeaderBorder = registerColor('settings.headerBorder', { dark: 'widget.border', light: 'widget.border', hcDark: 'contrastBorder', hcLight: 'contrastBorder' }, {
	description: 'Border below sticky Settings editor section headers.',
	owner,
});

export const focusedRowBackground = registerColor('settings.focusedRowBackground', {
	dark: transparent('list.hoverBackground', 0.6),
	light: transparent('list.hoverBackground', 0.6),
	hcDark: null,
	hcLight: null,
}, {
	description: 'Background for a Settings row containing keyboard focus.',
	owner,
	needsTransparency: true,
});

export const rowHoverBackground = registerColor('settings.rowHoverBackground', {
	dark: transparent('list.hoverBackground', 0.3),
	light: transparent('list.hoverBackground', 0.3),
	hcDark: null,
	hcLight: null,
}, {
	description: 'Background for a hovered Settings row.',
	owner,
	needsTransparency: true,
});
