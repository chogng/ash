import { registerColor } from '../colorUtils.js';
import { foreground } from './baseColors.js';

const owner = 'platform.theme';
const color = (id: string, dark: string, light: string, highContrastDark: string | null, highContrastLight: string | null, description: string): string =>
	registerColor(id, { dark, light, highContrastDark, highContrastLight }, { description, owner });

registerColor('sash.hoverBackground', {
	dark: '#007acc', light: '#007acc',
	highContrastDark: foreground, highContrastLight: foreground,
}, { description: 'Hovered sash background.', owner });

export const scrollbarShadow = color('scrollbar.shadow', '#000000', '#dddddd', null, null, 'Scrollbar shadow indicating that the editor is scrolled.');
export const scrollbarSliderBackground = color('scrollbar.sliderBackground', '#79797966', '#64646433', foreground, foreground, 'Scrollbar slider background.');
export const scrollbarSliderHoverBackground = color('scrollbar.sliderHoverBackground', '#646464b3', '#64646459', foreground, foreground, 'Hovered scrollbar slider background.');
export const scrollbarSliderActiveBackground = color('scrollbar.sliderActiveBackground', '#bfbfbf66', '#00000033', '#ffff00', '#0000ee', 'Active scrollbar slider background.');
