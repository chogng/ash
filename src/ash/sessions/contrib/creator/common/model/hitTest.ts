import { designEndpointContours, designStrokeLayers } from './designVectorStroke.js';
import { designVariableStrokeContours } from './designVariableWidth.js';
import { designPathFillContours, type DesignPathContour } from './designVector.js';
import { cubicBezierPoint, toDesignLocal, type DesignPoint } from '../core/geometry.js';
import type { DesignShape } from './document.js';

/** Inverse rotation makes hit testing agree with SVG rendering, including ellipse corners. */
export function hitTestDesignShapes(shapes: readonly DesignShape[], point: DesignPoint, deep = false, vectorContours?: (shape: DesignShape) => readonly DesignPathContour[] | undefined): DesignShape | undefined {
	for (let index = shapes.length - 1; index >= 0; index--) {
		const shape = shapes[index];
		if (shape.visible === false) { continue; }
		const local = toDesignLocal(shape, point);
		const x = local.x - shape.width / 2;
		const y = local.y - shape.height / 2;
		if (shape.kind === 'path') {
			if (hitTestPath(shape, local)) { return shape; }
			continue;
		}
		if (shape.kind === 'group' && shape.booleanOperation && !deep) {
			const contours = vectorContours?.(shape);
			if (contours) {
				if (contours.length && hitTestPath({ ...shape, kind: 'path', nodes: contours[0].nodes, closed: contours[0].closed, subpaths: contours.slice(1), strokeWidth: 0 }, local)) { return shape; }
				continue;
			}
		}
		const inside = shape.kind === 'ellipse'
			? (x / (shape.width / 2)) ** 2 + (y / (shape.height / 2)) ** 2 <= 1
			: Math.abs(x) <= shape.width / 2 && Math.abs(y) <= shape.height / 2;
		if (shape.kind === 'frame') {
			if (inside && !deep && (shape.instance || shape.component?.kind === 'main')) { return shape; }
			if (inside || !shape.clip) {
				const child = hitTestDesignShapes(shape.children, local, deep, vectorContours);
				if (child) { return child; }
			}
		}
		if (shape.kind === 'group' && deep) {
			const scale = shape.width / shape.contentWidth;
			const child = hitTestDesignShapes(shape.children, { x: local.x / scale, y: local.y / scale }, true, vectorContours);
			if (child) { return child; }
		}
		if (inside) {
			return shape;
		}
	}
	return undefined;
}

/** Frame children use local coordinates; selection outlines and input use their world geometry. */
type Container = Extract<DesignShape, { kind: 'frame' | 'group'; }>;
interface ShapeEntry {
	readonly ancestors: readonly string[];
	readonly shape: DesignShape;
	readonly world: DesignShape;
	readonly parent: Container | undefined;
	readonly parentScale: number;
}

export function getDesignShapeEntries(shapes: readonly DesignShape[]): readonly ShapeEntry[] {
	const visit = (shapes: readonly DesignShape[], parent?: Container, placedParent?: Container, ancestors: readonly string[] = [], scale = 1): ShapeEntry[] => shapes.flatMap(shape => {
		let world = shape;
		if (placedParent) {
			const angle = placedParent.rotation * Math.PI / 180;
			const position = (x: number, y: number): DesignPoint => {
				const dx = (x + shape.width / 2) * scale - placedParent.width / 2;
				const dy = (y + shape.height / 2) * scale - placedParent.height / 2;
				return { x: placedParent.x + placedParent.width / 2 + dx * Math.cos(angle) - dy * Math.sin(angle) - shape.width * scale / 2, y: placedParent.y + placedParent.height / 2 + dx * Math.sin(angle) + dy * Math.cos(angle) - shape.height * scale / 2 };
			};
			world = { ...shape, ...position(shape.x, shape.y), width: shape.width * scale, height: shape.height * scale, rotation: shape.rotation + placedParent.rotation };
			if (shape.motion) { world = { ...world, motion: { ...shape.motion, keyframes: shape.motion.keyframes.map(frame => ({ ...frame, ...position(frame.x, frame.y), rotation: frame.rotation + placedParent.rotation })) } }; }
		}
		const entry: ShapeEntry = { shape, world, parent, ancestors, parentScale: scale };
		return [entry, ...(shape.kind === 'frame' || shape.kind === 'group' ? visit(shape.children, shape, world as Container, [...ancestors, shape.id], shape.kind === 'group' ? world.width / shape.contentWidth : scale) : [])];
	});
	return visit(shapes);
}

function hitTestPath(shape: Extract<DesignShape, { kind: 'path'; }>, point: DesignPoint): boolean {
	for (const decorations of [designVariableStrokeContours(shape), designEndpointContours(shape)]) {
		if (decorations.length && hitTestPath({ ...shape, network: undefined, nodes: decorations[0].nodes, closed: true, subpaths: decorations.slice(1), strokeWidth: 0, widthPoints: undefined, strokeAlignment: 'center', fillRule: 'nonzero' }, point)) { return true; }
	}
	const sample = (contour: DesignPathContour): DesignPoint[] => {
		const points: DesignPoint[] = [];
		for (let index = 0; index < contour.nodes.length - (contour.closed ? 0 : 1); index++) {
			const start = contour.nodes[index], end = contour.nodes[(index + 1) % contour.nodes.length];
			for (let step = 0; step <= 64; step++) { const p = cubicBezierPoint(start, start.outgoing, end.incoming, end, step / 64); points.push({ x: p.x * shape.width, y: p.y * shape.height }); }
		}
		return points;
	};
	const inside = (contours: readonly DesignPoint[][]): boolean => {
		let winding = 0, crossings = 0;
		for (const points of contours) { for (let i = 1; i < points.length; i++) { const a = points[i - 1], b = points[i]; if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) { crossings++; winding += b.y > a.y ? 1 : -1; } } }
		return shape.fillRule === 'evenodd' ? crossings % 2 !== 0 : winding !== 0;
	};
	if (inside(designPathFillContours(shape).map(sample))) { return true; }
	for (const layer of designStrokeLayers(shape)) {
		const contours = layer.contours.map(sample), filled = inside(contours.filter((_, i) => layer.contours[i].closed));
		if (layer.alignment === 'inside' && !filled || layer.alignment === 'outside' && filled) { continue; }
		for (const points of contours) {
			for (let i = 1; i < points.length; i++) {
				const a = points[i - 1], b = points[i], dx = b.x - a.x, dy = b.y - a.y, length = dx * dx + dy * dy;
				const t = length === 0 ? 0 : Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / length));
				if (Math.hypot(point.x - a.x - t * dx, point.y - a.y - t * dy) <= (shape.widthPoints?.length ? 0 : layer.width / 2) + 3) { return true; }
			}
		}
	}
	return false;
}
