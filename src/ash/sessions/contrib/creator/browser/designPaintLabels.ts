import { localize } from '../../../../nls.js';
import type { DesignBlendMode } from '../common/model/designPaint.js';
export function designBlendLabel(mode: DesignBlendMode | 'pass-through'): string {
	const labels = {
		'pass-through': localize('sessions.design.blendPass', 'Pass through'),
		normal: localize('sessions.design.blendNormal', 'Normal'),
		darken: localize('sessions.design.blendDarken', 'Darken'),
		multiply: localize('sessions.design.blendMultiply', 'Multiply'),
		'plus-darker': localize('sessions.design.blendPlusDarker', 'Plus darker'),
		'color-burn': localize('sessions.design.blendBurn', 'Color burn'),
		lighten: localize('sessions.design.blendLighten', 'Lighten'),
		screen: localize('sessions.design.blendScreen', 'Screen'),
		'plus-lighter': localize('sessions.design.blendPlusLighter', 'Plus lighter'),
		'color-dodge': localize('sessions.design.blendDodge', 'Color dodge'),
		overlay: localize('sessions.design.blendOverlay', 'Overlay'),
		'soft-light': localize('sessions.design.blendSoft', 'Soft light'),
		'hard-light': localize('sessions.design.blendHard', 'Hard light'),
		difference: localize('sessions.design.blendDifference', 'Difference'),
		exclusion: localize('sessions.design.blendExclusion', 'Exclusion'),
		hue: localize('sessions.design.blendHue', 'Hue'),
		saturation: localize('sessions.design.blendSaturation', 'Saturation'),
		color: localize('sessions.design.blendColor', 'Color'),
		luminosity: localize('sessions.design.blendLuminosity', 'Luminosity'),
	};
	return labels[mode];
}
