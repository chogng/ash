import { registerColor } from '../../../../platform/theme/common/colorUtils.js';

const owner = 'workbench.welcomeGettingStarted';

registerColor('editorWelcome.cardBackground', {
	dark: '#303030', light: '#f3f3f3', highContrastDark: '#000000', highContrastLight: '#ffffff',
}, { description: 'Background for welcome page action cards.', owner });

registerColor('editorWelcome.cardHoverBackground', {
	dark: '#3d3d3d', light: '#e4e4e4', highContrastDark: '#333333', highContrastLight: '#dddddd',
}, { description: 'Background for hovered welcome page action cards.', owner });

registerColor('editorWelcome.cardBorder', {
	dark: '#555555', light: '#d4d4d4', highContrastDark: 'contrastBorder', highContrastLight: 'contrastBorder',
}, { description: 'Border around welcome page action cards.', owner });

registerColor('editorWelcome.featuredCardBackground', {
	dark: '#000000', light: '#000000', highContrastDark: '#000000', highContrastLight: '#000000',
}, { description: 'Background for the featured welcome page action.', owner });

registerColor('editorWelcome.featuredCardBorder', {
	dark: '#000000', light: '#000000', highContrastDark: 'contrastBorder', highContrastLight: 'contrastBorder',
}, { description: 'Border around the featured welcome page action.', owner });

registerColor('editorWelcome.featuredCardHoverBackground', {
	dark: '#262626', light: '#262626', highContrastDark: '#333333', highContrastLight: '#333333',
}, { description: 'Hovered background for the featured welcome page action.', owner });

registerColor('editorWelcome.featuredCardForeground', {
	dark: '#ffffff', light: '#ffffff', highContrastDark: '#ffffff', highContrastLight: '#ffffff',
}, { description: 'Text and icon color for the featured welcome page action.', owner });
