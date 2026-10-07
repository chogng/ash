import { registerColor, transparent } from '../colorUtils.js';
import { foreground } from './baseColors.js';

const owner = 'platform.theme';
const color = (id: string, dark: string, light: string, hcDark: string | null, hcLight: string | null, description: string): string =>
	registerColor(id, { dark, light, hcDark, hcLight }, { description, owner });

registerColor('sash.hoverBackground', {
	dark: '#007acc', light: '#007acc',
	hcDark: foreground, hcLight: foreground,
}, { description: 'Hovered sash background.', owner });

export const scrollbarShadow = color('scrollbar.shadow', '#000000', '#dddddd', null, null, 'Scrollbar shadow indicating that the editor is scrolled.');
export const scrollbarBackground = registerColor('scrollbar.background', {
	dark: null, light: null, hcDark: null, hcLight: null,
}, { description: 'Scrollbar track background.', owner });
export const scrollbarSliderBackground = registerColor('scrollbarSlider.background', {
	dark: transparent('#797979', 0.4), light: transparent('#646464', 0.4),
	hcDark: foreground, hcLight: foreground,
}, { description: 'Scrollbar slider background.', owner });
export const scrollbarSliderHoverBackground = registerColor('scrollbarSlider.hoverBackground', {
	dark: transparent('#646464', 0.7), light: transparent('#646464', 0.7),
	hcDark: foreground, hcLight: foreground,
}, { description: 'Hovered scrollbar slider background.', owner });
export const scrollbarSliderActiveBackground = registerColor('scrollbarSlider.activeBackground', {
	dark: transparent('#bfbfbf', 0.4), light: transparent('#000000', 0.6),
	hcDark: '#ffff00', hcLight: '#0000ee',
}, { description: 'Active scrollbar slider background.', owner });

export const badgeBackground = color('badge.background', '#37373d', '#e4e6f2', '#000000', '#ffffff', 'Background for count badges.');
export const badgeForeground = color('badge.foreground', '#ffffff', '#333333', '#ffffff', '#000000', 'Foreground for count badges.');
