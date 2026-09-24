import { registerColor, transparent } from '../colorRegistry.js';

const owner = 'workbench.preferences';

export const itemBackground = registerColor('settings.itemBackground', { dark: '#252526', light: '#f3f3f3' }, {
	description: 'Background for configuration items in the Settings editor.',
	owner,
});

export const itemSeparator = registerColor('settings.itemSeparator', { dark: '#383838', light: '#e0e0e0' }, {
	description: 'Separator between configuration items in the Settings editor.',
	owner,
});

export const headerForeground = registerColor('settings.headerForeground', { dark: 'foreground', light: 'foreground' }, {
	description: 'Foreground for Settings editor section headers.',
	owner,
});

export const headerBorder = registerColor('settings.headerBorder', { dark: 'widget.border', light: 'widget.border' }, {
	description: 'Border below sticky Settings editor section headers.',
	owner,
});

export const modifiedItemIndicator = registerColor('settings.modifiedItemIndicator', { dark: '#0c7d9d', light: '#2f7ead' }, {
	description: 'Indicator for a setting changed from its default value.',
	owner,
});

export const focusedRowBackground = registerColor('settings.focusedRowBackground', {
	dark: transparent('list.hoverBackground', 0.6),
	light: transparent('list.hoverBackground', 0.6),
}, {
	description: 'Background for a Settings row containing keyboard focus.',
	owner,
	needsTransparency: true,
});

export const rowHoverBackground = registerColor('settings.rowHoverBackground', {
	dark: transparent('list.hoverBackground', 0.3),
	light: transparent('list.hoverBackground', 0.3),
}, {
	description: 'Background for a hovered Settings row.',
	owner,
	needsTransparency: true,
});
