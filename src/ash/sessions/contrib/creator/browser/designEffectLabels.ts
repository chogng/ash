import { localize } from '../../../../nls.js';
import type { DesignEffect } from '../common/model/designEffects.js';
import { designBlendLabel } from './designPaintLabels.js';

export function designEffectTypeLabel(
	type: DesignEffect['type']): string {
	return {
		'drop-shadow': localize('sessions.design.effectDropShadow', 'Drop shadow'),
		'inner-shadow': localize('sessions.design.effectInnerShadow', 'Inner shadow'),
		'layer-blur': localize('sessions.design.effectLayerBlur', 'Layer blur'),
		'background-blur': localize('sessions.design.effectBackgroundBlur', 'Background blur'),
	}[type];
}

export function describeDesignEffect(
	effect: DesignEffect): string {
	const details = [designEffectTypeLabel(effect.type)];
	if (effect.visible === false) {
		details.push(localize('sessions.design.hidden', 'Hidden'));
	}
	if (effect.type === 'drop-shadow' || effect.type === 'inner-shadow') {
		details.push(localize('sessions.design.shadowReview', 'Shadow: X {0}, Y {1}, blur {2}, color {3}', effect.x, effect.y, effect.blur, effect.color));
		details.push(localize('sessions.design.effectSpreadReview', 'Spread: {0}', effect.spread ?? 0), designBlendLabel(effect.blendMode ?? 'normal'));
		if (effect.type === 'drop-shadow' && effect.showBehind) {
			details.push(localize('sessions.design.effectShowBehind', 'Show shadow behind transparent areas'));
		}
	} else if ('progressive' in effect && effect.progressive) {
		const { startBlur, start, end } = effect.progressive;
		details.push(localize(
			'sessions.design.blurProgressiveReview',
			'Progressive blur: {0} to {1}; start ({2}%, {3}%); end ({4}%, {5}%)',
			startBlur, effect.blur, start.x * 100, start.y * 100, end.x * 100, end.y * 100
		));
	} else {
		details.push(localize('sessions.design.effectBlurReview', 'Blur: {0}', effect.blur));
	}
	return details.join(', ');
}
