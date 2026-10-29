import { isRecord } from '../../../../../base/common/types.js';
import { generateUuid, isUuid } from '../../../../../base/common/uuid.js';
import { localize } from '../../../../../nls.js';
import type { DesignPoint } from '../core/geometry.js';
import type { DesignShape } from './document.js';

export const designBlendModes = [
	'normal',
	'darken',
	'multiply',
	'plus-darker',
	'color-burn',
	'lighten',
	'screen',
	'plus-lighter',
	'color-dodge',
	'overlay',
	'soft-light',
	'hard-light',
	'difference',
	'exclusion',
	'hue',
	'saturation',
	'color',
	'luminosity'
] as const;
export type DesignBlendMode = typeof designBlendModes[number];
export interface DesignGradientStop {
	readonly id: string;
	readonly position: number;
	readonly color: string;
}
export type DesignPaint = {
	readonly id: string;
	readonly visible?: boolean;
	readonly opacity?: number;
	readonly blendMode?: DesignBlendMode;
} & ({
	readonly type: 'solid';
	readonly color: string;
} | {
	readonly type: 'linear' | 'radial' | 'angular' | 'diamond';
	readonly stops: readonly DesignGradientStop[];
	/** Three normalized handles map the gradient's origin and two unit axes into the layer. */
	readonly handles: readonly [DesignPoint, DesignPoint, DesignPoint];
});
const color = (value: unknown): value is string => typeof value === 'string' && /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/iu.test(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const fail = (): never => {
	throw new TypeError(localize('sessions.design.invalidPaint', 'Invalid design fill, gradient, or blend mode'));
};

export function parseDesignPaints(value: unknown): readonly DesignPaint[] {
	if (!Array.isArray(value) || value.length > 64) {
		return fail();
	}
	const ids = new Set<string>();
	return value.map(paint => {
		if (!isRecord(paint) ||
			!isUuid(paint.id) ||
			ids.has(paint.id) ||
			!['solid', 'linear', 'radial', 'angular', 'diamond'].includes(String(paint.type)) ||
			Object.keys(paint).some(key => !['id', 'type', 'visible', 'opacity', 'blendMode', ...(paint.type === 'solid' ? ['color'] : ['stops', 'handles'])].includes(key)) ||
			paint.visible !== undefined && typeof paint.visible !== 'boolean' ||
			paint.opacity !== undefined && (!finite(paint.opacity) ||
				paint.opacity < 0 ||
				paint.opacity > 1) ||
			paint.blendMode !== undefined && !designBlendModes.includes(paint.blendMode as DesignBlendMode)) {
			return fail();
		}
		ids.add(paint.id);
		const base = {
			id: paint.id,
			...(paint.visible !== undefined ? { visible: paint.visible as boolean } : {}),
			...(paint.opacity !== undefined ? { opacity: paint.opacity as number } : {}),
			...(paint.blendMode !== undefined ? { blendMode: paint.blendMode as DesignBlendMode } : {})
		};
		if (paint.type === 'solid') {
			if (!color(paint.color)) {
				return fail();
			}
			return { ...base, type: 'solid', color: paint.color };
		}
		if (!Array.isArray(paint.handles) || paint.handles.length !== 3 || !Array.isArray(paint.stops) || paint.stops.length < 2 || paint.stops.length > 256) {
			return fail();
		}
		const handles = paint.handles.map(p => {
			if (!isRecord(p) || Object.keys(p).some(key => !['x', 'y'].includes(key)) || !finite(p.x) || !finite(p.y) || Math.abs(p.x) > 10000 || Math.abs(p.y) > 10000) {
				return fail();
			}
			return { x: p.x, y: p.y };
		}) as [DesignPoint, DesignPoint, DesignPoint];
		const [a, b, c] = handles;
		if (Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) < 1e-8) {
			return fail();
		}
		const stopIds = new Set<string>();
		let position = -1;
		const stops = paint.stops.map(stop => {
			if (!isRecord(stop) ||
				Object.keys(stop).some(key => !['id', 'position', 'color'].includes(key)) ||
				!isUuid(stop.id) ||
				stopIds.has(stop.id) ||
				!finite(stop.position) ||
				stop.position < position ||
				stop.position < 0 ||
				stop.position > 1 ||
				!color(stop.color)) {
				return fail();
			}
			position = stop.position;
			stopIds.add(stop.id);
			return { id: stop.id, position: stop.position, color: stop.color };
		});
		return { ...base, type: paint.type as Exclude<DesignPaint['type'], 'solid'>, handles, stops };
	});
}
/** Explicit stacks are authoritative; absent stacks keep legacy single-color files editable without migration. Topmost paint is first. */

export function designPaints(shape: Pick<DesignShape, 'fill' | 'fills' | 'id'>): readonly DesignPaint[] {
	return shape.fills ?? [{ id: shape.id, type: 'solid', color: shape.fill }];
}

export function createDesignPaint(type: DesignPaint['type'], color = '#808080'): DesignPaint {
	const id = generateUuid();
	return type === 'solid' ? { id, type, color } : {
		id,
		type,
		stops: [{ id: generateUuid(), position: 0, color }, { id: generateUuid(), position: 1, color: '#ffffff' }],
		handles: type === 'linear' ? [{ x: 0, y: .5 }, { x: 1, y: .5 }, { x: 0, y: 1.5 }] : [{ x: .5, y: .5 }, { x: 1, y: .5 }, { x: .5, y: 1 }]
	};
}

export function designGradientPosition(paint: Exclude<DesignPaint, { type: 'solid'; }>, point: DesignPoint): number {
	const [a, b, c] = paint.handles, xx = b.x - a.x, xy = b.y - a.y, yx = c.x - a.x, yy = c.y - a.y, determinant = xx * yy - xy * yx;
	const x = ((point.x - a.x) * yy - (point.y - a.y) * yx) / determinant, y = ((point.y - a.y) * xx - (point.x - a.x) * xy) / determinant;
	return paint.type === 'linear' ? x : paint.type === 'radial' ? Math.hypot(x, y) : paint.type === 'diamond' ? Math.abs(x) + Math.abs(y) : ((Math.atan2(y, x) / (2 * Math.PI)) % 1 + 1) % 1;
}
function rgba(color: string): readonly number[] {
	return [parseInt(color.slice(1, 3), 16), parseInt(color.slice(3, 5), 16), parseInt(color.slice(5, 7), 16), color.length === 9 ? parseInt(color.slice(7, 9), 16) : 255];
}
/** Premultiplied interpolation avoids dark fringes next to transparent stops; equal-position stops make a hard edge. */

export function sampleDesignPaint(paint: DesignPaint, position: number): readonly number[] {
	if (paint.type === 'solid') {
		return rgba(paint.color);
	}
	const stops = paint.stops;
	let low = 0, high = stops.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if (stops[middle].position <= position) {
			low = middle + 1;
		}
		else {
			high = middle;
		}
	}
	if (low === 0) {
		return rgba(stops[0].color);
	}
	if (low === stops.length) {
		return rgba(stops.at(-1)!.color);
	}
	const left = stops[low - 1];
	const right = stops[low];
	const a = rgba(left.color);
	const b = rgba(right.color);
	const t = (position - left.position) / (right.position - left.position);
	const alpha = a[3] * (1 - t) + b[3] * t;
	return [...[0, 1, 2].map(i => alpha ? (a[i] * a[3] * (1 - t) + b[i] * b[3] * t) / alpha : 0), alpha];
}

export function withDesignPaintColor(shape: DesignShape, paintId: string | undefined, stopId: string | undefined, color: string): DesignShape {
	if (!shape.fills) {
		return { ...shape, fill: color };
	}
	if (!shape.fills.length) {
		return { ...shape, fills: [createDesignPaint('solid', color)] };
	}
	// A library update may replace paint identities while an inspector selection is still active.
	const selected = shape.fills.find(paint => paint.id === paintId) ?? shape.fills[0];
	const selectedStop = selected.type === 'solid' ? undefined : selected.stops.find(stop => stop.id === stopId) ?? selected.stops[0];
	return {
		...shape,
		fills: shape.fills.map(paint => paint.id !== selected.id ? paint : paint.type === 'solid' ? { ...paint, color } : { ...paint, stops: paint.stops.map(stop => stop.id === selectedStop?.id ? { ...stop, color } : stop) })
	};
}
