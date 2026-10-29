import { isRecord } from '../../../../../base/common/types.js';
import { generateUuid, isUuid } from '../../../../../base/common/uuid.js';
import { localize } from '../../../../../nls.js';
import { designBlendModes, designPaints, type DesignBlendMode } from './designPaint.js';
import type { DesignShape } from './document.js';

/** Positions use the unrotated layer's normalized coordinates and may lie outside its bounds. */
export interface DesignProgressiveBlur {
	readonly startBlur: number;
	readonly start: { readonly x: number; readonly y: number; };
	readonly end: { readonly x: number; readonly y: number; };
}

export type DesignEffect = {
	readonly id: string;
	readonly visible?: boolean;
} & ({
	readonly type: 'drop-shadow' | 'inner-shadow';
	readonly x: number;
	readonly y: number;
	readonly blur: number;
	readonly spread?: number;
	readonly color: string;
	readonly blendMode?: DesignBlendMode;
	/** Drop shadows normally exclude the layer's interior, even when its paint is translucent. */
	readonly showBehind?: boolean;
} | {
	readonly type: 'layer-blur' | 'background-blur';
	/** End radius in progressive mode, or the uniform radius otherwise. */
	readonly blur: number;
	readonly progressive?: DesignProgressiveBlur;
});

/** The object form is retained for files created before effect stacks were introduced. */

export type DesignEffects = readonly DesignEffect[] | {
	readonly x: number;
	readonly y: number;
	readonly blur: number;
	readonly color: string;
};

export function designEffects(
	shape: { readonly id: string; readonly effects?: DesignEffects; }): readonly DesignEffect[] {
	const effects = shape.effects;
	if (!effects) {
		return [];
	}
	if ('x' in effects) {
		return [{ ...effects, id: shape.id, type: 'drop-shadow', showBehind: true }];
	}
	return effects;
}

export function createDesignEffect(
	type: DesignEffect['type']): DesignEffect {
	const id = generateUuid();
	return type === 'drop-shadow' || type === 'inner-shadow'
		? { id, type, x: 0, y: 4, blur: 4, spread: 0, color: '#00000040' }
		: { id, type, blur: 4 };
}

export function canAddDesignEffect(
	effects: readonly DesignEffect[],
	type: DesignEffect['type']): boolean {
	return effects.filter(effect => effect.type === type).length < (type === 'drop-shadow' || type === 'inner-shadow' ? 8 : 1);
}

export function designEffectMaxBlur(effect: DesignEffect): number {
	return Math.max(effect.blur, 'progressive' in effect ? effect.progressive?.startBlur ?? 0 : 0);
}

export function supportsDesignShadowSpread(
	shape: DesignShape): boolean {
	if (shape.kind === 'rectangle' || shape.kind === 'ellipse') {
		return true;
	}
	if (shape.kind !== 'frame' || !shape.clip) {
		return false;
	}
	return designPaints(shape).some(paint => {
		if (paint.visible === false) {
			return false;
		}
		const colors = paint.type === 'solid' ? [paint.color] : paint.stops.map(stop => stop.color);
		return colors.some(color => parseInt(color.slice(7) || 'ff', 16) / 255 * (paint.opacity ?? 1) >= .01);
	});
}

/** A conservative symmetric inset, including nested effects, keeps filters and exports unclipped. */

export function designEffectPadding(
	shape: DesignShape): number {
	const effects = designEffects(shape).filter(effect => effect.visible !== false);
	const shadow = Math.max(0, ...effects.map(effect => {
		if (effect.type !== 'drop-shadow') {
			return 0;
		}
		const spread = supportsDesignShadowSpread(shape) ? effect.spread ?? 0 : 0;
		return Math.max(Math.abs(effect.x), Math.abs(effect.y)) + effect.blur * 2 + Math.max(0, spread);
	}));
	const layerBlur = effects.find(effect => effect.type === 'layer-blur');
	const blur = layerBlur ? designEffectMaxBlur(layerBlur) : 0;
	let children = 0;
	if (shape.kind === 'group' || shape.kind === 'frame' && !shape.clip) {
		children = Math.max(0, ...shape.children.map(designEffectPadding));
		if (shape.kind === 'group') {
			children *= Math.max(shape.width / shape.contentWidth, shape.height / shape.contentHeight);
		}
	}
	return (shadow + blur * 2 + children) * (Math.abs(Math.cos(shape.rotation * Math.PI / 180)) + Math.abs(Math.sin(shape.rotation * Math.PI / 180)));
}

export function parseDesignEffects(
	value: unknown): DesignEffects {
	const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
	const color = (value: unknown): boolean => typeof value === 'string' && /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/iu.test(value);
	const fail = (): never => {
		throw new TypeError(localize('sessions.design.invalidEffects', 'Invalid design effect, shadow, or blur.'));
	};
	if (isRecord(value) && Object.keys(value).every(key => ['x', 'y', 'blur', 'color'].includes(key)) &&
		finite(value.x) && finite(value.y) && finite(value.blur) && value.blur >= 0 && color(value.color)) {
		return value as DesignEffects;
	}
	if (!Array.isArray(value) || value.length > 18) {
		return fail();
	}
	const ids = new Set<string>();
	const effects: DesignEffect[] = [];
	for (const entry of value) {
		if (!isRecord(entry) || !isUuid(entry.id) || ids.has(entry.id) ||
			!['drop-shadow', 'inner-shadow', 'layer-blur', 'background-blur'].includes(String(entry.type)) ||
			!finite(entry.blur) || entry.blur < 0 || entry.visible !== undefined && typeof entry.visible !== 'boolean') {
			return fail();
		}
		const shadow = entry.type === 'drop-shadow' || entry.type === 'inner-shadow';
		const allowed = ['id', 'type', 'blur', 'visible', ...(shadow ? ['x', 'y', 'color', 'spread', 'blendMode', ...(entry.type === 'drop-shadow' ? ['showBehind'] : [])] : ['progressive'])];
		if (Object.keys(entry).some(key => !allowed.includes(key))) {
			return fail();
		}
		if (shadow && (!finite(entry.x) || !finite(entry.y) || !color(entry.color) ||
			entry.spread !== undefined && !finite(entry.spread) ||
			entry.showBehind !== undefined && typeof entry.showBehind !== 'boolean' ||
			entry.blendMode !== undefined && !designBlendModes.includes(entry.blendMode as DesignBlendMode))) {
			return fail();
		}
		if (!shadow && entry.progressive !== undefined) {
			const progressive = entry.progressive;
			const point = (value: unknown): boolean => isRecord(value) &&
				Object.keys(value).every(key => key === 'x' || key === 'y') && finite(value.x) && finite(value.y);
			if (!isRecord(progressive) || Object.keys(progressive).some(key => !['startBlur', 'start', 'end'].includes(key)) ||
				!finite(progressive.startBlur) || progressive.startBlur < 0 || !point(progressive.start) || !point(progressive.end)) {
				return fail();
			}
		}
		const effect = entry as unknown as DesignEffect;
		if (!canAddDesignEffect(effects, effect.type)) {
			return fail();
		}
		ids.add(effect.id);
		effects.push(effect);
	}
	return effects;
}
