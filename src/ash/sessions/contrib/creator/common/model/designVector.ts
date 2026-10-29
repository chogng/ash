import { roundDesignVectorCorners } from './designVectorCorners.js';
import { cubicBezierPoint } from '../core/geometry.js';
import { designNetworkContours, designNetworkNodes, designNetworkFillContours, designNetworkStrokeContours } from './designVectorNetwork.js';
import type { DesignPoint } from '../core/geometry.js';
import type { DesignPathNode, DesignShape } from './document.js';

export type DesignBooleanOperation = 'union' | 'subtract' | 'intersect' | 'exclude';
export interface DesignPathContour {
	readonly nodes: readonly DesignPathNode[];
	readonly closed: boolean;
	readonly fill?: string;
}
export type DesignPath = Extract<DesignShape, { kind: 'path' }>;

/** The first contour retains the original file contract; subpaths contain only additional contours. */
export function designPathContours(path: DesignPath): readonly DesignPathContour[] {
	return path.network ? designNetworkContours(path.network) : [{ nodes: path.nodes, closed: path.closed }, ...(path.subpaths ?? [])];
}
export function designPathEditingContours(path: DesignPath): readonly DesignPathContour[] {
	return path.network ? [{ nodes: designNetworkNodes(path.network), closed: false }] : designPathContours(path);
}
export function designPathFillContours(path: DesignPath): readonly DesignPathContour[] {
	return roundDesignVectorCorners(path.network ? designNetworkFillContours(path.network) : designPathContours(path).filter(contour => contour.closed), path.width, path.height, path.cornerSmoothing);
}
const strokeContoursCache = new WeakMap<DesignPath, readonly DesignPathContour[]>();
export function designPathStrokeContours(path: DesignPath): readonly DesignPathContour[] {
	let contours = strokeContoursCache.get(path);
	if (!contours) {
		contours = roundDesignVectorCorners(path.network ? designNetworkStrokeContours(path.network) : designPathContours(path), path.width, path.height, path.cornerSmoothing);
		strokeContoursCache.set(path, contours);
	}
	return contours;
}
export function withDesignPathContours(path: DesignPath, contours: readonly DesignPathContour[]): DesignPath {
	const { network: _network, ...rest } = path;
	const fill = contours[0]?.fill ?? path.fill;
	return {
		...rest,
		fill,
		nodes: contours[0]?.nodes ?? [],
		closed: contours[0]?.closed ?? false,
		subpaths: contours.slice(1).map(contour => (fill !== path.fill && !contour.fill ? { ...contour, fill: path.fill } : contour)),
	};
}

/** Reframe baked geometry without moving it on the canvas, including rotated layers and Bézier extrema. */
export function fitDesignPathBounds(path: DesignPath): DesignPath {
	const contours = designPathContours(path),
		points: DesignPoint[] = [];
	for (const contour of contours) {
		points.push(...contour.nodes);
		for (let i = 0; i < contour.nodes.length - (contour.closed ? 0 : 1); i++) {
			const a = contour.nodes[i],
				b = contour.nodes[(i + 1) % contour.nodes.length];
			for (const key of ['x', 'y'] as const) {
				const p = a[key],
					q = a.outgoing[key],
					r = b.incoming[key],
					s = b[key];
				const A = -p + 3 * q - 3 * r + s,
					B = 2 * (p - 2 * q + r),
					C = q - p,
					discriminant = B * B - 4 * A * C;
				const roots =
					Math.abs(A) < 1e-12 ? (Math.abs(B) < 1e-12 ? [] : [-C / B]) : discriminant < 0 ? [] : [(-B + Math.sqrt(discriminant)) / (2 * A), (-B - Math.sqrt(discriminant)) / (2 * A)];
				for (const t of roots) {
					if (t > 0 && t < 1) {
						points.push(cubicBezierPoint(a, a.outgoing, b.incoming, b, t));
					}
				}
			}
		}
	}
	if (!points.length) {
		return path;
	}
	let left = Infinity,
		top = Infinity,
		right = -Infinity,
		bottom = -Infinity;
	for (const point of points) {
		left = Math.min(left, point.x * path.width);
		top = Math.min(top, point.y * path.height);
		right = Math.max(right, point.x * path.width);
		bottom = Math.max(bottom, point.y * path.height);
	}
	const width = Math.max(1e-6, right - left),
		height = Math.max(1e-6, bottom - top),
		angle = (path.rotation * Math.PI) / 180;
	const dx = left + width / 2 - path.width / 2,
		dy = top + height / 2 - path.height / 2;
	const point = (p: DesignPoint) => ({ x: (p.x * path.width - left) / width, y: (p.y * path.height - top) / height });
	return withDesignPathContours(
		{
			...path,
			...(path.widthPoints ? { widthPoints: path.widthPoints.map(point => ({ ...point })) } : {}),
			x: path.x + path.width / 2 + dx * Math.cos(angle) - dy * Math.sin(angle) - width / 2,
			y: path.y + path.height / 2 + dx * Math.sin(angle) + dy * Math.cos(angle) - height / 2,
			width,
			height,
		},
		contours.map(contour => ({
			...contour,
			nodes: contour.nodes.map(node => ({
				...node,
				...point(node),
				incoming: point(node.incoming),
				outgoing: point(node.outgoing),
			})),
		})),
	);
}
export function designPathData(contours: readonly DesignPathContour[], frame: { x: number; y: number; width: number; height: number }): string {
	const point = (p: DesignPoint): string => `${frame.x + p.x * frame.width} ${frame.y + p.y * frame.height}`;
	return contours
		.filter(contour => contour.nodes.length)
		.map(({ nodes, closed }) => {
			let data = `M ${point(nodes[0])}`;
			for (let index = 0; index < nodes.length - (closed ? 0 : 1); index++) {
				const start = nodes[index],
					end = nodes[(index + 1) % nodes.length];
				data += ` C ${point(start.outgoing)} ${point(end.incoming)} ${point(end)}`;
			}
			return data + (closed ? ' Z' : '');
		})
		.join(' ');
}
export function isDesignVector(shape: DesignShape): boolean {
	return shape.kind === 'rectangle' || shape.kind === 'ellipse' || shape.kind === 'path' || (shape.kind === 'group' && shape.children.every(isDesignVector));
}
/** Basic shapes become cubic contours without sampling their curves. */
export function designShapeContours(shape: DesignShape): readonly DesignPathContour[] {
	if (shape.kind === 'path') {
		return designPathContours(shape);
	}
	const node = (x: number, y: number): DesignPathNode => ({ x, y, incoming: { x, y }, outgoing: { x, y } });
	if (shape.kind === 'rectangle') {
		return [{ closed: true, nodes: [node(0, 0), node(1, 0), node(1, 1), node(0, 1)] }];
	}
	if (shape.kind === 'ellipse') {
		const k = 0.5522847498307936 / 2;
		return [
			{
				closed: true,
				nodes: [
					{ x: 0.5, y: 0, incoming: { x: 0.5 - k, y: 0 }, outgoing: { x: 0.5 + k, y: 0 } },
					{ x: 1, y: 0.5, incoming: { x: 1, y: 0.5 - k }, outgoing: { x: 1, y: 0.5 + k } },
					{ x: 0.5, y: 1, incoming: { x: 0.5 + k, y: 1 }, outgoing: { x: 0.5 - k, y: 1 } },
					{ x: 0, y: 0.5, incoming: { x: 0, y: 0.5 + k }, outgoing: { x: 0, y: 0.5 - k } },
				],
			},
		];
	}
	return [];
}

/** Handles follow a moved anchor. Mirroring is evaluated in design pixels, not normalized fractions. */
export function moveDesignPathNode(node: DesignPathNode, point: 'anchor' | 'incoming' | 'outgoing', target: DesignPoint, width: number, height: number, independent = false): DesignPathNode {
	if (point === 'anchor') {
		const dx = target.x - node.x,
			dy = target.y - node.y;
		return {
			...node,
			...target,
			incoming: { x: node.incoming.x + dx, y: node.incoming.y + dy },
			outgoing: { x: node.outgoing.x + dx, y: node.outgoing.y + dy },
		};
	}
	const opposite = point === 'incoming' ? 'outgoing' : 'incoming';
	const mode = independent ? 'none' : (node.mirroring ?? 'none');
	if (mode === 'none') {
		return { ...node, [point]: target, ...(independent ? { mirroring: 'none' as const } : {}) };
	}
	const dx = (target.x - node.x) * width,
		dy = (target.y - node.y) * height;
	const length = Math.hypot(dx, dy);
	const ratio = mode === 'angle-length' ? 1 : length ? Math.hypot((node[opposite].x - node.x) * width, (node[opposite].y - node.y) * height) / length : 0;
	return {
		...node,
		[point]: target,
		[opposite]: { x: node.x - (dx * ratio) / width, y: node.y - (dy * ratio) / height },
	};
}

/** de Casteljau splitting preserves the original cubic exactly, including both neighbouring handles. */
export function splitDesignPathSegment(contour: DesignPathContour, index: number, t = 0.5): DesignPathContour {
	const nodes = contour.nodes.slice(),
		next = (index + 1) % nodes.length;
	if (!nodes.length || (!contour.closed && next === 0)) {
		return contour;
	}
	const a = nodes[index],
		b = nodes[next];
	const lerp = (a: DesignPoint, b: DesignPoint): DesignPoint => ({
		x: a.x + (b.x - a.x) * t,
		y: a.y + (b.y - a.y) * t,
	});
	const p = lerp(a, a.outgoing),
		q = lerp(a.outgoing, b.incoming),
		r = lerp(b.incoming, b);
	const s = lerp(p, q),
		u = lerp(q, r),
		anchor = lerp(s, u);
	nodes[index] = { ...a, outgoing: p };
	nodes[next] = { ...b, incoming: r };
	nodes.splice(index + 1, 0, { ...anchor, incoming: s, outgoing: u, mirroring: 'angle' });
	return { ...contour, nodes };
}

/** Locate a cubic for point insertion; splitting still uses the exact curve, never the hit-test samples. */
export function nearestDesignPathSegment(path: DesignPath, point: DesignPoint, tolerance: number): { contour: number; segment: number; t: number } | undefined {
	let best: { contour: number; segment: number; t: number } | undefined,
		distance = tolerance;
	for (const [contour, value] of designPathContours(path).entries()) {
		for (let segment = 0; segment < value.nodes.length - (value.closed ? 0 : 1); segment++) {
			const a = value.nodes[segment],
				b = value.nodes[(segment + 1) % value.nodes.length];
			const at = (t: number) => {
				const u = 1 - t;
				return {
					x: (u ** 3 * a.x + 3 * u * u * t * a.outgoing.x + 3 * u * t * t * b.incoming.x + t ** 3 * b.x) * path.width,
					y: (u ** 3 * a.y + 3 * u * u * t * a.outgoing.y + 3 * u * t * t * b.incoming.y + t ** 3 * b.y) * path.height,
				};
			};
			const gap = (t: number) => {
				const value = at(t);
				return Math.hypot(value.x - point.x, value.y - point.y);
			};
			for (let step = 0; step < 32; step++) {
				let low = step / 32,
					high = (step + 1) / 32;
				for (let iteration = 0; iteration < 12; iteration++) {
					const a = low + (high - low) / 3,
						b = high - (high - low) / 3;
					if (gap(a) < gap(b)) {
						high = b;
					} else {
						low = a;
					}
				}
				const t = (low + high) / 2,
					current = gap(t);
				if (current < distance) {
					distance = current;
					best = { contour, segment, t };
				}
			}
		}
	}
	return best;
}
