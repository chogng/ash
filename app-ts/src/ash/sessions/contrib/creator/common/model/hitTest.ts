import { cubicBezierPoint, toDesignLocal, type DesignPoint } from '../core/geometry.js';
import type { DesignShape } from './document.js';

/** Inverse rotation makes hit testing agree with SVG rendering, including ellipse corners. */
export function hitTestDesignShapes(shapes: readonly DesignShape[], point: DesignPoint): DesignShape | undefined {
	for (let index = shapes.length - 1; index >= 0; index--) {
		const shape = shapes[index];
		const local = toDesignLocal(shape, point);
		const x = local.x - shape.width / 2;
		const y = local.y - shape.height / 2;
		if (shape.kind === 'path') {
			if (hitTestPath(shape, local)) { return shape; }
			continue;
		}
		const inside = shape.kind === 'ellipse'
			? (x / (shape.width / 2)) ** 2 + (y / (shape.height / 2)) ** 2 <= 1
			: Math.abs(x) <= shape.width / 2 && Math.abs(y) <= shape.height / 2;
		if (shape.kind === 'frame') {
			if (inside || !shape.clip) {
				const child = hitTestDesignShapes(shape.children, local);
				if (child) { return child; }
			}
		}
		if (inside) {
			return shape;
		}
	}
	return undefined;
}

/** Frame children use local coordinates; selection outlines and input use their world geometry. */
export function getDesignShapeEntries(shapes: readonly DesignShape[], parent?: Extract<DesignShape, { kind: 'frame' }>, ancestors: readonly string[] = []): readonly { readonly ancestors: readonly string[]; readonly shape: DesignShape; readonly world: DesignShape; readonly parent: Extract<DesignShape, { kind: 'frame' }> | undefined }[] {
	return shapes.flatMap(shape => {
		let world = shape;
		if (parent) {
			const angle = parent.rotation * Math.PI / 180;
			const dx = shape.x + shape.width / 2 - parent.width / 2;
			const dy = shape.y + shape.height / 2 - parent.height / 2;
			world = { ...shape, x: parent.x + parent.width / 2 + dx * Math.cos(angle) - dy * Math.sin(angle) - shape.width / 2, y: parent.y + parent.height / 2 + dx * Math.sin(angle) + dy * Math.cos(angle) - shape.height / 2, rotation: shape.rotation + parent.rotation };
			if (shape.motion) {
				world = { ...world, motion: { ...shape.motion, keyframes: shape.motion.keyframes.map(frame => {
					const dx = frame.x + shape.width / 2 - parent.width / 2;
					const dy = frame.y + shape.height / 2 - parent.height / 2;
					return { ...frame, x: parent.x + parent.width / 2 + dx * Math.cos(angle) - dy * Math.sin(angle) - shape.width / 2, y: parent.y + parent.height / 2 + dx * Math.sin(angle) + dy * Math.cos(angle) - shape.height / 2, rotation: frame.rotation + parent.rotation };
				}) } };
			}
		}
		return [{ shape, world, parent, ancestors }, ...(shape.kind === 'frame' ? getDesignShapeEntries(shape.children, world as Extract<DesignShape, { kind: 'frame' }>, [...ancestors, shape.id]) : [])];
	});
}

function hitTestPath(shape: Extract<DesignShape, { kind: 'path' }>, point: DesignPoint): boolean {
	const points: DesignPoint[] = [];
	const count = shape.closed ? shape.nodes.length : shape.nodes.length - 1;
	for (let index = 0; index < count; index++) {
		const start = shape.nodes[index];
		const end = shape.nodes[(index + 1) % shape.nodes.length];
		for (let step = 0; step <= 64; step++) {
			const t = step / 64;
			const sample = cubicBezierPoint(start, start.outgoing, end.incoming, end, t);
			points.push({ x: sample.x * shape.width, y: sample.y * shape.height });
		}
	}
	let inside = false;
	for (let index = 1; index < points.length; index++) {
		const a = points[index - 1];
		const b = points[index];
		const dx = b.x - a.x;
		const dy = b.y - a.y;
		const length = dx * dx + dy * dy;
		const t = length === 0 ? 0 : Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / length));
		if (Math.hypot(point.x - a.x - t * dx, point.y - a.y - t * dy) <= shape.strokeWidth / 2 + 3) { return true; }
		if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) { inside = !inside; }
	}
	return shape.closed && inside;
}
