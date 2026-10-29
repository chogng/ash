import { registerColor } from '../../../../platform/theme/common/colorUtils.js';

const owner = 'workbench.welcomeGettingStarted';

registerColor('editorWelcome.cardBackground', {
	dark: '#303030', light: '#f3f3f3', hcDark: '#000000', hcLight: '#ffffff',
}, { description: 'Background for welcome page action cards.', owner });

registerColor('editorWelcome.cardHoverBackground', {
	dark: '#3d3d3d', light: '#e4e4e4', hcDark: '#333333', hcLight: '#dddddd',
}, { description: 'Background for hovered welcome page action cards.', owner });

registerColor('editorWelcome.cardBorder', {
	dark: '#555555', light: '#d4d4d4', hcDark: 'contrastBorder', hcLight: 'contrastBorder',
}, { description: 'Border around welcome page action cards.', owner });

registerColor('editorWelcome.featuredCardBackground', {
	dark: '#000000', light: '#000000', hcDark: '#000000', hcLight: '#000000',
}, { description: 'Background for the featured welcome page action.', owner });

registerColor('editorWelcome.featuredCardBorder', {
	dark: '#000000', light: '#000000', hcDark: 'contrastBorder', hcLight: 'contrastBorder',
}, { description: 'Border around the featured welcome page action.', owner });

registerColor('editorWelcome.featuredCardHoverBackground', {
	dark: '#262626', light: '#262626', hcDark: '#333333', hcLight: '#333333',
}, { description: 'Hovered background for the featured welcome page action.', owner });

registerColor('editorWelcome.featuredCardForeground', {
	dark: '#ffffff', light: '#ffffff', hcDark: '#ffffff', hcLight: '#ffffff',
}, { description: 'Text and icon color for the featured welcome page action.', owner });
