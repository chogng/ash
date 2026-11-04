import { toDesignLocal, type DesignPoint } from '../core/geometry.js';
import { flattenDesignShapes, type DesignShape } from './document.js';
import { prototypeScrollScope, type PrototypeFrame } from './prototype.js';

export type PrototypeScrollPositions = Readonly<Record<string, DesignPoint>>;
const zero: DesignPoint = Object.freeze({ x: 0, y: 0 });
export function prototypePath(shapes: readonly DesignShape[], id: string): readonly DesignShape[] {
	for (const shape of shapes) {
		if (shape.id === id) { return [shape]; }
		if (shape.kind === 'frame' || shape.kind === 'group') { const path = prototypePath(shape.children, id); if (path.length) { return [shape, ...path]; } }
	}
	return [];
}
export function prototypeScrollFrames(shapes: readonly DesignShape[]): readonly PrototypeFrame[] {
	return flattenDesignShapes(shapes).filter((shape): shape is PrototypeFrame => shape.kind === 'frame' && !!shape.overflowDirection && shape.overflowDirection !== 'none');
}
function localPoint(shape: DesignShape, point: DesignPoint): DesignPoint {
	const local = toDesignLocal(shape, point);
	return shape.kind === 'group' ? { x: local.x * shape.contentWidth / shape.width, y: local.y * shape.contentHeight / shape.height } : local;
}
function parentPoint(shape: DesignShape, point: DesignPoint): DesignPoint {
	const x = (shape.kind === 'group' ? point.x * shape.width / shape.contentWidth : point.x) - shape.width / 2;
	const y = (shape.kind === 'group' ? point.y * shape.height / shape.contentHeight : point.y) - shape.height / 2;
	const angle = shape.rotation * Math.PI / 180;
	return { x: shape.x + shape.width / 2 + x * Math.cos(angle) - y * Math.sin(angle), y: shape.y + shape.height / 2 + x * Math.sin(angle) + y * Math.cos(angle) };
}
function corners(shape: DesignShape): readonly DesignPoint[] {
	const width = shape.kind === 'group' ? shape.contentWidth : shape.width, height = shape.kind === 'group' ? shape.contentHeight : shape.height;
	return [{ x: 0, y: 0 }, { x: width, y: 0 }, { x: width, y: height }, { x: 0, y: height }].map(point => parentPoint(shape, point));
}
/** A nested viewport contributes its bounds, not the independently scrollable content behind it. */
export function prototypeScrollRange(frame: PrototypeFrame): DesignPoint {
	const extent = (shape: DesignShape): readonly DesignPoint[] => {
		if (shape.visible === false || shape.scrollPosition === 'fixed') { return []; }
		const own = corners(shape);
		if (shape.kind === 'group' || shape.kind === 'frame' && !shape.clip && (!shape.overflowDirection || shape.overflowDirection === 'none')) { return [...own, ...shape.children.flatMap(extent).map(point => parentPoint(shape, point))]; }
		return own;
	};
	const points = frame.children.flatMap(extent);
	return { x: frame.overflowDirection === 'horizontal' || frame.overflowDirection === 'both' ? Math.max(0, ...points.map(point => point.x - frame.width)) : 0, y: frame.overflowDirection === 'vertical' || frame.overflowDirection === 'both' ? Math.max(0, ...points.map(point => point.y - frame.height)) : 0 };
}
export function prototypeScrollOffset(frame: PrototypeFrame, positions: PrototypeScrollPositions): DesignPoint {
	const range = prototypeScrollRange(frame), value = positions[frame.id] ?? zero;
	return { x: Math.max(0, Math.min(range.x, value.x)), y: Math.max(0, Math.min(range.y, value.y)) };
}

/** Geometry is derived for playback only. Sticky layers keep paint order and their direct parent's bounds. */
export function applyPrototypeScroll(frame: PrototypeFrame, positions: PrototypeScrollPositions): PrototypeFrame {
	type Viewport = { origin: DesignPoint; compensation: DesignPoint; vertical: boolean; owner: boolean; };
	const visit = (shape: DesignShape, inherited?: Viewport): DesignShape => {
		if (shape.kind !== 'frame' && shape.kind !== 'group') { return shape; }
		const scrolls = shape.kind === 'frame' && shape.overflowDirection && shape.overflowDirection !== 'none';
		const offset = scrolls ? prototypeScrollOffset(shape as PrototypeFrame, positions) : zero;
		const viewport: Viewport | undefined = scrolls ? { origin: zero, compensation: offset, vertical: shape.overflowDirection !== 'horizontal', owner: true } : inherited;
		const height = shape.kind === 'group' ? shape.contentHeight : shape.height;
		const children = shape.children.map(child => {
			let x = child.x - offset.x, y = child.y - offset.y;
			const fixed = child.scrollPosition === 'fixed' && (!('autoLayout' in shape) || !shape.autoLayout || child.layoutPositioning === 'absolute');
			if (viewport && fixed) { x += viewport.compensation.x; y += viewport.compensation.y; }
			else if (viewport?.vertical && child.scrollPosition === 'sticky') { y += Math.max(0, Math.min(viewport.origin.y - y, viewport.owner ? Infinity : height - child.height - y)); }
			const placed = { ...child, x, y };
			let next: Viewport | undefined;
			if (viewport && !fixed) {
				const origin = localPoint(placed, viewport.origin), a = localPoint(placed, zero), b = localPoint(placed, { x: viewport.compensation.x - (x - child.x + offset.x), y: viewport.compensation.y - (y - child.y + offset.y) });
				next = { origin, compensation: { x: b.x - a.x, y: b.y - a.y }, vertical: viewport.vertical, owner: false };
			}
			return visit(placed, next);
		});
		return { ...shape, children: [...children.filter(child => child.scrollPosition !== 'fixed'), ...children.filter(child => child.scrollPosition === 'fixed')] };
	};
	return visit(frame) as PrototypeFrame;
}

/** Picker targets are direct children of scrolling frames; wires may target deeper descendants. */
export function prototypeScrollTargets(shapes: readonly DesignShape[], source: string, direct = true): readonly DesignShape[] {
	const owner = prototypeScrollScope(shapes, source);
	if (!owner) { return []; }
	return flattenDesignShapes([owner]).filter(shape => {
		const path = prototypePath([owner], shape.id);
		return shape.id !== source && path.every(item => item.visible !== false) && path.slice(0, -1).some((item, index) => item.kind === 'frame' && !!item.overflowDirection && item.overflowDirection !== 'none' && (!direct || index === path.length - 2));
	});
}

/** Resolve inner viewports first so ancestors scroll to the target's resulting visual position. */
export function prototypeScrollTo(frame: PrototypeFrame, target: string, positions: PrototypeScrollPositions): PrototypeScrollPositions {
	const path = prototypePath([frame], target);
	if (!path.length || path.some(shape => shape.visible === false) || path.at(-1)?.scrollPosition === 'fixed') { return positions; }
	let result = positions;
	for (const ancestor of path.slice(0, -1).reverse()) {
		if (ancestor.scrollPosition === 'fixed' && (ancestor.kind !== 'frame' || !ancestor.overflowDirection || ancestor.overflowDirection === 'none')) { break; }
		if (ancestor.kind !== 'frame' || !ancestor.overflowDirection || ancestor.overflowDirection === 'none') { continue; }
		const visual = applyPrototypeScroll(ancestor, { ...result, [ancestor.id]: zero });
		const local = prototypePath([visual], target).slice(1);
		let points = corners(local.at(-1)!);
		for (const parent of local.slice(0, -1).reverse()) { points = points.map(point => parentPoint(parent, point)); }
		result = { ...result, [ancestor.id]: prototypeScrollOffset(ancestor, { [ancestor.id]: { x: Math.min(...points.map(point => point.x)), y: Math.min(...points.map(point => point.y)) } }) };
		if (ancestor.scrollPosition === 'fixed') { break; }
	}
	return result;
}

/** Clipping also limits keyboard hotspots; invisible controls must not receive focus. */
export function prototypeVisibleShapes(frame: PrototypeFrame): readonly DesignShape[] {
	return flattenDesignShapes([frame]).filter(shape => {
		const path = prototypePath([frame], shape.id);
		if (path.some(item => item.visible === false)) { return false; }
		let points = corners(shape);
		for (const parent of path.slice(0, -1).reverse()) {
			if (parent.kind === 'frame' && (parent.clip || parent === frame) && (Math.max(...points.map(point => point.x)) <= 0 || Math.min(...points.map(point => point.x)) >= parent.width || Math.max(...points.map(point => point.y)) <= 0 || Math.min(...points.map(point => point.y)) >= parent.height)) { return false; }
			points = points.map(point => parentPoint(parent, point));
		}
		return true;
	});
}

/** Convert scroll input vectors through rotated frames and scaled groups without translating them. */
export function prototypeScrollVector(path: readonly DesignShape[], delta: DesignPoint, toRoot = false): DesignPoint {
	let result = delta;
	for (const shape of toRoot ? [...path].reverse() : path) {
		const transform = toRoot ? parentPoint : localPoint, a = transform(shape, zero), b = transform(shape, result);
		result = { x: b.x - a.x, y: b.y - a.y };
	}
	return result;
}

/** Wires can reach descendants inside groups without changing the editor's group selection contract. */
export function prototypeShapeEntries(shapes: readonly DesignShape[]): readonly { shape: DesignShape; world: DesignShape; ancestors: readonly DesignShape[]; }[] {
	return flattenDesignShapes(shapes).map(shape => {
		const ancestors = prototypePath(shapes, shape.id).slice(0, -1);
		let center = { x: shape.x + shape.width / 2, y: shape.y + shape.height / 2 }, scale = 1, rotation = shape.rotation;
		for (const parent of [...ancestors].reverse()) { center = parentPoint(parent, center); rotation += parent.rotation; if (parent.kind === 'group') { scale *= parent.width / parent.contentWidth; } }
		const width = shape.width * scale, height = shape.height * scale;
		return { shape, world: { ...shape, x: center.x - width / 2, y: center.y - height / 2, width, height, rotation }, ancestors };
	});
}
