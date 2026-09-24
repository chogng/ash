import { registerColor } from '../colorUtils.js';

const owner = 'platform.theme';
const color = (id: string, dark: string, light: string, description: string): string => registerColor(id, { dark, light }, { description, owner });

registerColor('sash.hoverBackground', {
	dark: '#007acc', light: '#007acc',
	highContrastDark: '#007acc', highContrastLight: '#007acc',
}, { description: 'Hovered sash background.', owner });

export const scrollbarShadow = color('scrollbar.shadow', '#000000', '#dddddd', 'Scrollbar shadow indicating that the editor is scrolled.');
export const scrollbarSliderBackground = color('scrollbar.sliderBackground', '#79797966', '#64646433', 'Scrollbar slider background.');
export const scrollbarSliderHoverBackground = color('scrollbar.sliderHoverBackground', '#646464b3', '#64646459', 'Hovered scrollbar slider background.');
export const scrollbarSliderActiveBackground = color('scrollbar.sliderActiveBackground', '#bfbfbf66', '#00000033', 'Active scrollbar slider background.');
