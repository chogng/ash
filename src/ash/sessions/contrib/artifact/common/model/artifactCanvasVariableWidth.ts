import type { CanvasPoint } from '../../../canvas/common/canvasGeometry.js';
import { artifactCanvasPathStrokeContours, type ArtifactCanvasPath, type ArtifactCanvasPathContour } from './artifactCanvasVector.js';

export function supportsArtifactCanvasVariableWidth(path: ArtifactCanvasPath): boolean {
	if (path.dashArray?.length) { return false; }
	if (!path.network) { return true; }
	const degree = path.network.vertices.map(() => 0);
	for (const edge of path.network.edges) { if (++degree[edge.start] > 2 || ++degree[edge.end] > 2) { return false; } }
	return true;
}

interface Sample extends CanvasPoint { readonly distance: number; }
const samplesCache = new WeakMap<ArtifactCanvasPath, readonly (readonly Sample[])[]>();
/** Adaptive flattening measures arc length in design pixels, including non-square layer bounds. */
function samples(path: ArtifactCanvasPath): readonly (readonly Sample[])[] {
	const cached = samplesCache.get(path); if (cached) { return cached; }
	const result = artifactCanvasPathStrokeContours(path).map(contour => {
		const result: Sample[] = [];
		const append = (p: CanvasPoint) => { const before = result.at(-1); const distance = before ? Math.hypot(p.x - before.x, p.y - before.y) : 0; if (!before || distance > 1e-9) { result.push({ ...p, distance: (before?.distance ?? 0) + distance }); } };
		const pixel = (p: CanvasPoint) => ({ x: p.x * path.width, y: p.y * path.height });
		for (let i = 0; i < contour.nodes.length - (contour.closed ? 0 : 1); i++) {
			const a = contour.nodes[i], b = contour.nodes[(i + 1) % contour.nodes.length];
			const curve = [a, a.outgoing, b.incoming, b].map(pixel);
			const split = (a: CanvasPoint, b: CanvasPoint, c: CanvasPoint, d: CanvasPoint, depth: number): void => {
				const chord = Math.hypot(d.x - a.x, d.y - a.y), polygon = Math.hypot(b.x - a.x, b.y - a.y) + Math.hypot(c.x - b.x, c.y - b.y) + Math.hypot(d.x - c.x, d.y - c.y);
				const flatness = chord ? Math.max(Math.abs((b.x - a.x) * (d.y - a.y) - (b.y - a.y) * (d.x - a.x)), Math.abs((c.x - a.x) * (d.y - a.y) - (c.y - a.y) * (d.x - a.x))) / chord : polygon;
				if (depth >= 12 || polygon - chord < .02 && flatness < .05) { append(d); return; }
				const mid = (a: CanvasPoint, b: CanvasPoint) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
				const ab = mid(a, b), bc = mid(b, c), cd = mid(c, d), abc = mid(ab, bc), bcd = mid(bc, cd), p = mid(abc, bcd);
				split(a, ab, abc, p, depth + 1); split(p, bcd, cd, d, depth + 1);
			};
			if (!result.length) { append(curve[0]); } split(curve[0], curve[1], curve[2], curve[3], 0);
		}
		return result;
	});
	samplesCache.set(path, result); return result;
}

/** Used by the canvas handles, the numeric editor, and the stroke outline. */
export function artifactCanvasWidthLocation(path: ArtifactCanvasPath, contour: number, position: number): { point: CanvasPoint; normal: CanvasPoint; length: number; } | undefined {
	const points = samples(path)[contour]; if (!points || points.length < 2) { return undefined; }
	const length = points.at(-1)!.distance, distance = Math.max(0, Math.min(1, position)) * length;
	let low = 1, high = points.length - 1;
	while (low < high) { const middle = (low + high) >> 1; if (points[middle].distance < distance) { low = middle + 1; } else { high = middle; } }
	const a = points[low - 1], b = points[low], span = b.distance - a.distance, t = span ? (distance - a.distance) / span : 0;
	return { point: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, normal: { x: -(b.y - a.y) / span, y: (b.x - a.x) / span }, length };
}

export function nearestArtifactCanvasWidthLocation(path: ArtifactCanvasPath, point: CanvasPoint, tolerance = Infinity): { contour: number; position: number; } | undefined {
	let best: { contour: number; position: number; } | undefined, distance = tolerance;
	for (const [contour, points] of samples(path).entries()) {
		for (let i = 1; i < points.length; i++) {
			const a = points[i - 1], b = points[i], dx = b.x - a.x, dy = b.y - a.y, length = b.distance - a.distance;
			const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / (length * length)));
			const gap = Math.hypot(point.x - a.x - dx * t, point.y - a.y - dy * t);
			if (gap < distance) { distance = gap; best = { contour, position: (a.distance + t * length) / points.at(-1)!.distance }; }
		}
	}
	return best;
}

export function snapArtifactCanvasWidthPosition(path: ArtifactCanvasPath, contour: number, position: number, tolerance: number): number {
	const value = artifactCanvasPathStrokeContours(path)[contour], length = samples(path)[contour]?.at(-1)?.distance;
	if (!value || !length) { return position; }
	const anchors = value.nodes.map(node => nearestArtifactCanvasWidthLocation(path, { x: node.x * path.width, y: node.y * path.height })).filter(point => point?.contour === contour).map(point => point!.position);
	const widths = (path.widthPoints ?? []).filter(point => point.contour === contour).map(point => point.position).sort((a, b) => a - b);
	const stops = [...new Set([0, 1, ...anchors, ...widths])].sort((a, b) => a - b);
	const candidates = [...stops, ...stops.slice(1).map((value, i) => (value + stops[i]) / 2)];
	return candidates.sort((a, b) => Math.abs(a - position) - Math.abs(b - position)).find(value => Math.abs(value - position) * length <= tolerance) ?? position;
}

const widthsCache = new WeakMap<ArtifactCanvasPath, Map<number, readonly { position: number; width: number; slope?: number; }[]>>();
export function artifactCanvasWidthAt(path: ArtifactCanvasPath, contour: number, position: number): number { return artifactCanvasWidthPointAt(path, contour, position).width * path.strokeWidth; }
/** Hermite derivatives make insertion a subdivision of the existing width curve, with no visible change. */
export function artifactCanvasWidthPointAt(path: ArtifactCanvasPath, contour: number, position: number): { width: number; slope: number; } {
	let byContour = widthsCache.get(path); if (!byContour) { byContour = new Map(); widthsCache.set(path, byContour); }
	let stops = byContour.get(contour);
	if (!stops) {
		const closed = artifactCanvasPathStrokeContours(path)[contour]?.closed;
		const unique = new Map<number, { width: number; slope?: number; }>();
		for (const point of path.widthPoints ?? []) { if (point.contour === contour) { unique.set(closed && point.position === 1 ? 0 : point.position, point); } }
		const points = [...unique].map(([position, point]) => ({ ...point, position })).sort((a, b) => a.position - b.position);
		if (!points.length) { stops = [{ position: 0, width: 1 }, { position: 1, width: 1 }]; }
		else { stops = closed ? [{ ...points.at(-1)!, position: points.at(-1)!.position - 1 }, ...points, { ...points[0], position: points[0].position + 1 }] : [...(points[0].position ? [{ position: 0, width: 1 }] : []), ...points, ...(points.at(-1)!.position !== 1 ? [{ position: 1, width: 1 }] : [])]; }
		byContour.set(contour, stops);
	}
	let low = 0, high = stops.length - 1;
	while (low < high) { const middle = (low + high) >> 1; if (stops[middle].position < position) { low = middle + 1; } else { high = middle; } }
	const a = stops[Math.max(0, low - 1)], b = stops[low];
	const t = a.position === b.position ? 0 : Math.max(0, Math.min(1, (position - a.position) / (b.position - a.position)));
	const span = b.position - a.position, left = (a.slope ?? 0) * span, right = (b.slope ?? 0) * span;
	const width = (2 * t ** 3 - 3 * t * t + 1) * a.width + (t ** 3 - 2 * t * t + t) * left + (-2 * t ** 3 + 3 * t * t) * b.width + (t ** 3 - t * t) * right;
	const slope = span ? ((6 * t * t - 6 * t) * a.width + (3 * t * t - 4 * t + 1) * left + (-6 * t * t + 6 * t) * b.width + (3 * t * t - 2 * t) * right) / span : a.slope ?? 0;
	return { width: Math.max(0, width), slope };

}

const outlineCache = new WeakMap<ArtifactCanvasPath, readonly ArtifactCanvasPathContour[]>();
/** Filled ribbons keep variable width identical in canvas, hit testing, booleans, and SVG export. */
export function artifactCanvasVariableStrokeContours(path: ArtifactCanvasPath): readonly ArtifactCanvasPathContour[] {
	if (!path.widthPoints?.length || !path.strokeWidth || !supportsArtifactCanvasVariableWidth(path)) { return []; }
	const cached = outlineCache.get(path); if (cached) { return cached; }
	const result: ArtifactCanvasPathContour[] = [], contours = artifactCanvasPathStrokeContours(path);
	const contour = (points: readonly CanvasPoint[]): ArtifactCanvasPathContour => ({ closed: true, nodes: points.map(point => { const p = { x: point.x / path.width, y: point.y / path.height }; return { ...p, incoming: p, outgoing: p }; }) });
	for (const [index, source] of samples(path).entries()) {
		if (source.length < 2) { continue; }
		const length = source.at(-1)!.distance, closed = contours[index].closed;
		const positions = new Set(source.map(point => point.distance / length));
		for (const point of path.widthPoints) { if (point.contour === index) { positions.add(point.position); } }
		// Width interpolation also needs samples on straight lines, where geometric flattening has only endpoints.
		const ordered = [...positions].sort((a, b) => a - b), refined: number[] = [];
		for (let i = 1; i < ordered.length; i++) {
			const count = Math.min(128, Math.max(1, Math.ceil((ordered[i] - ordered[i - 1]) * length / 2)));
			for (let step = 0; step < count; step++) { refined.push(ordered[i - 1] + (ordered[i] - ordered[i - 1]) * step / count); }
		}
		if (!closed) { refined.push(1); }
		const centers = refined.map(position => artifactCanvasWidthLocation(path, index, position)!.point);
		const sides: CanvasPoint[][] = [[], []];
		const unit = (a: CanvasPoint, b: CanvasPoint) => { const length = Math.hypot(b.x - a.x, b.y - a.y) || 1; return { x: (b.x - a.x) / length, y: (b.y - a.y) / length }; };
		for (let i = 0; i < centers.length; i++) {
			const p = centers[i], first = i === 0, last = i === centers.length - 1, radius = artifactCanvasWidthAt(path, index, refined[i]) / 2;
			const before = unit(first ? closed ? centers.at(-1)! : p : centers[i - 1], first && !closed ? centers[1] : p);
			const after = last && !closed ? before : unit(p, centers[(i + 1) % centers.length]);
			for (const [side, sign] of [1, -1].entries()) {
				const n1 = { x: -before.y * sign, y: before.x * sign }, n2 = { x: -after.y * sign, y: after.x * sign };
				const dot = Math.max(-1, Math.min(1, n1.x * n2.x + n1.y * n2.y)), cross = before.x * after.y - before.y * after.x;
				const append = (normal: CanvasPoint) => sides[side].push({ x: p.x + normal.x * radius, y: p.y + normal.y * radius });
				if (path.strokeJoin === 'round' && cross * sign < -1e-6) {
					const start = Math.atan2(n1.y, n1.x), angle = Math.atan2(n1.x * n2.y - n1.y * n2.x, dot), steps = Math.max(1, Math.ceil(Math.abs(angle) / Math.max(.001, Math.min(.15, 2 * Math.acos(Math.max(-1, 1 - .05 / Math.max(.05, radius)))))));
					for (let step = 0; step <= steps; step++) { append({ x: Math.cos(start + angle * step / steps), y: Math.sin(start + angle * step / steps) }); }
				} else if (dot < -.875 || (path.strokeJoin === 'bevel' && cross * sign < -1e-6)) { append(n1); append(n2); }
				else { append({ x: (n1.x + n2.x) / (1 + dot), y: (n1.y + n2.y) / (1 + dot) }); }
			}
		}
		if (closed) { result.push(contour(sides[0]), contour(sides[1].reverse())); continue; }
		const cap = (end: boolean): CanvasPoint[] => {
			const i = end ? centers.length - 1 : 0, p = centers[i], tangent = end ? unit(centers[i - 1], p) : unit(centers[1], p), radius = artifactCanvasWidthAt(path, index, end ? 1 : 0) / 2;
			const across = { x: -tangent.y, y: tangent.x };
			if (path.strokeCap === 'round') { const steps = Math.max(20, Math.ceil(Math.PI / Math.max(.001, 2 * Math.acos(Math.max(-1, 1 - .05 / Math.max(.05, radius)))))); return Array.from({ length: steps + 1 }, (_, i) => { const angle = Math.PI * i / steps; return { x: p.x + radius * (across.x * Math.cos(angle) + tangent.x * Math.sin(angle)), y: p.y + radius * (across.y * Math.cos(angle) + tangent.y * Math.sin(angle)) }; }); }
			if (path.strokeCap === 'square') { return [1, -1].map(sign => ({ x: p.x + radius * (tangent.x + across.x * sign), y: p.y + radius * (tangent.y + across.y * sign) })); }
			return [];
		};
		result.push(contour([...sides[0], ...cap(true), ...sides[1].reverse(), ...cap(false)]));
	}
	outlineCache.set(path, result); return result;
}
