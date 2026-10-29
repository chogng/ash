import { localize } from '../../../../../nls.js';
import { cubicBezierPoint, type DesignPoint } from '../core/geometry.js';
import { designNetworkRegionAt, designNetworkRegions, splitDesignNetworkEdge, type DesignVectorNetwork } from './designVectorNetwork.js';

type Edge = DesignVectorNetwork['edges'][number];
type Cubic = readonly [DesignPoint, DesignPoint, DesignPoint, DesignPoint];
export interface DesignVectorIntersection {
	readonly first: { readonly edge: number; readonly time: number };
	readonly second: { readonly edge: number; readonly time: number };
}
export interface DesignNetworkEdit {
	readonly network: DesignVectorNetwork;
	readonly vertices: ReadonlyMap<number, number>;
}
const distance = (a: DesignPoint, b: DesignPoint) => Math.hypot(a.x - b.x, a.y - b.y);
const keyFor = (ids: Iterable<string>) => [...new Set(ids)].sort().join(',');
function equivalentEdges(a: Edge, b: Edge, vertices: DesignVectorNetwork['vertices']): boolean {
	const forward = a.start === b.start && a.end === b.end,
		reverse = a.start === b.end && a.end === b.start;
	if (!forward && !reverse) {
		return false;
	}
	if (distance(a.outgoing, forward ? b.outgoing : b.incoming) < 1e-9 && distance(a.incoming, forward ? b.incoming : b.outgoing) < 1e-9) {
		return true;
	}
	// Collinear cubics may describe the same line with different parameter speeds after subdivision.
	return [a.outgoing, a.incoming, b.outgoing, b.incoming].every(point => lineDistance(point, vertices[a.start], vertices[a.end]) < 1e-10);
}

/** Boundary identity survives edge replacement. Newly subdivided faces inherit the paint beneath them. */
function retainPaint(before: DesignVectorNetwork, after: DesignVectorNetwork, replacements: ReadonlyMap<string, readonly string[]>): DesignVectorNetwork {
	if (!before.unfilledRegions?.length && !Object.keys(before.regionFills ?? {}).length) {
		return after;
	}
	const remap = (key: string) => keyFor(key.split(',').flatMap(id => replacements.get(id) ?? [id]));
	const empty = new Set(before.unfilledRegions?.map(remap)),
		colors = new Map(Object.entries(before.regionFills ?? {}).map(([key, color]) => [remap(key), color]));
	const unfilledRegions: string[] = [],
		regionFills: Record<string, string> = {};
	for (const region of designNetworkRegions(after)) {
		const a = region.contour.nodes[0],
			b = region.contour.nodes[1];
		const p = cubicBezierPoint(a, a.outgoing, b.incoming, b, 0.1),
			q = cubicBezierPoint(a, a.outgoing, b.incoming, b, 0.1001),
			length = distance(p, q) || 1;
		const previous = designNetworkRegionAt(before, {
			x: p.x - ((q.y - p.y) / length) * 1e-7,
			y: p.y + ((q.x - p.x) / length) * 1e-7,
		});
		if (empty.has(region.key) || previous?.filled === false) {
			unfilledRegions.push(region.key);
		}
		const color = colors.get(region.key) ?? (previous ? before.regionFills?.[previous.key] : undefined);
		if (color) {
			regionFills[region.key] = color;
		}
	}
	return {
		...after,
		...(unfilledRegions.length ? { unfilledRegions } : {}),
		...(Object.keys(regionFills).length ? { regionFills } : {}),
	};
}

/** Coalesce anchors, carrying their incident handles. Curved loops retain a second anchor; only zero-length edges disappear. */
export function mergeDesignNetworkVertices(network: DesignVectorNetwork, indices: ReadonlySet<number>, target?: number): DesignNetworkEdit {
	const selected = [...indices].filter(index => !!network.vertices[index]);
	if (selected.length < 2) {
		return { network, vertices: new Map(network.vertices.map((_, i) => [i, i])) };
	}
	const anchor =
		target === undefined
			? selected.reduce(
					(sum, i) => ({
						x: sum.x + network.vertices[i].x / selected.length,
						y: sum.y + network.vertices[i].y / selected.length,
					}),
					{ x: 0, y: 0 },
				)
			: network.vertices[target];
	const keep = Math.min(...selected),
		mapping = new Map<number, number>(),
		vertices: DesignVectorNetwork['vertices'][number][] = [];
	for (let i = 0; i < network.vertices.length; i++) {
		if (!indices.has(i) || i === keep) {
			mapping.set(i, vertices.length);
			vertices.push(i === keep ? anchor : network.vertices[i]);
		}
	}
	for (const i of selected) {
		mapping.set(i, mapping.get(keep)!);
	}
	const edges: Edge[] = [],
		replacements = new Map<string, readonly string[]>();
	for (const edge of network.edges) {
		const start = mapping.get(edge.start)!,
			end = mapping.get(edge.end)!;
		const translate = (point: DesignPoint, old: number) => ({
			x: point.x + vertices[mapping.get(old)!].x - network.vertices[old].x,
			y: point.y + vertices[mapping.get(old)!].y - network.vertices[old].y,
		});
		const next = {
			...edge,
			start,
			end,
			outgoing: translate(edge.outgoing, edge.start),
			incoming: translate(edge.incoming, edge.end),
		};
		if (start === end) {
			if (distance(next.outgoing, anchor) + distance(next.incoming, anchor) < 1e-10) {
				replacements.set(edge.id, []);
				continue;
			}
			const split = splitDesignNetworkEdge({ vertices, edges: [next] }, 0, 0.5),
				middle = split.vertices.at(-1)!;
			vertices.push(middle);
			edges.push(...split.edges);
			replacements.set(
				edge.id,
				split.edges.map(edge => edge.id),
			);
			continue;
		}
		const duplicate = edges.find(other => equivalentEdges(next, other, vertices));
		if (duplicate) {
			replacements.set(edge.id, [duplicate.id]);
		} else {
			edges.push(next);
		}
	}
	if (vertices.length > 10000 || edges.length > 10000) {
		throw new Error(localize('sessions.design.networkComplexity', 'This edit exceeds the vector point or segment limit. Simplify the path first.'));
	}
	return { network: retainPaint(network, { vertices, edges }, replacements), vertices: mapping };
}

/** Split exact cubics at every hit before identifying shared anchors, so crossing order cannot change the geometry. */
export function intersectDesignNetwork(network: DesignVectorNetwork, intersections: readonly DesignVectorIntersection[], paintSource = network): DesignNetworkEdit {
	if (!intersections.length) {
		return { network, vertices: new Map(network.vertices.map((_, i) => [i, i])) };
	}
	const vertices = [...network.vertices],
		parents = vertices.map((_, i) => i),
		cuts = new Map<number, { time: number; vertex: number }[]>();
	const root = (index: number): number => {
		while (parents[index] !== index) {
			parents[index] = parents[parents[index]];
			index = parents[index];
		}
		return index;
	};
	const locate = ({ edge: index, time }: DesignVectorIntersection['first']) => {
		const edge = network.edges[index];
		if (time <= 1e-8) {
			return edge.start;
		}
		if (time >= 1 - 1e-8) {
			return edge.end;
		}
		const entries = cuts.get(index) ?? [],
			same = entries.find(cut => Math.abs(cut.time - time) < 1e-8);
		if (same) {
			return same.vertex;
		}
		const vertex = vertices.length;
		vertices.push(cubicBezierPoint(network.vertices[edge.start], edge.outgoing, edge.incoming, network.vertices[edge.end], time));
		parents.push(vertex);
		entries.push({ time, vertex });
		cuts.set(index, entries);
		return vertex;
	};
	for (const hit of intersections) {
		const a = root(locate(hit.first)),
			b = root(locate(hit.second));
		parents[Math.max(a, b)] = Math.min(a, b);
	}
	if (vertices.length > 10000 || network.edges.length + vertices.length - network.vertices.length > 10000) {
		throw new Error(localize('sessions.design.networkComplexity', 'This edit exceeds the vector point or segment limit. Simplify the path first.'));
	}
	const mapping = new Map<number, number>(),
		compact: DesignVectorNetwork['vertices'][number][] = [];
	for (let i = 0; i < vertices.length; i++) {
		const representative = root(i);
		if (!mapping.has(representative)) {
			mapping.set(representative, compact.length);
			compact.push(vertices[representative]);
		}
		mapping.set(i, mapping.get(representative)!);
	}
	const edges: Edge[] = [],
		replacements = new Map<string, readonly string[]>();
	for (const [index, original] of network.edges.entries()) {
		let remaining = original,
			previous = 0;
		const ids: string[] = [];
		for (const cut of [...(cuts.get(index) ?? [])].sort((a, b) => a.time - b.time)) {
			const split = splitDesignNetworkEdge({ vertices, edges: [remaining] }, 0, (cut.time - previous) / (1 - previous));
			const left = { ...split.edges[0], end: cut.vertex },
				right = { ...split.edges[1], start: cut.vertex };
			edges.push({ ...left, start: mapping.get(left.start)!, end: mapping.get(left.end)! });
			ids.push(left.id);
			remaining = right;
			previous = cut.time;
		}
		edges.push({ ...remaining, start: mapping.get(remaining.start)!, end: mapping.get(remaining.end)! });
		ids.push(remaining.id);
		replacements.set(original.id, ids);
	}
	// A self-crossing cubic can create an edge returning to the same intersection. Give that loop an editable midpoint.
	for (let i = 0; i < edges.length; i++) {
		if (edges[i].start !== edges[i].end) {
			continue;
		}
		const edge = edges[i],
			split = splitDesignNetworkEdge({ vertices: compact, edges: [edge] }, 0, 0.5);
		if (distance(compact[edge.start], edge.outgoing) + distance(compact[edge.end], edge.incoming) < 1e-10) {
			edges.splice(i--, 1);
			for (const [id, values] of replacements) {
				replacements.set(
					id,
					values.filter(value => value !== edge.id),
				);
			}
			continue;
		}
		compact.push(split.vertices.at(-1)!);
		edges[i] = split.edges[0];
		edges.push(split.edges[1]);
		for (const [id, values] of replacements) {
			if (values.includes(edge.id)) {
				replacements.set(id, [...values, split.edges[1].id]);
			}
		}
	}
	// Overlapping segments become one edge after their overlap endpoints have been split.
	const deduplicated: Edge[] = [];
	for (const edge of edges) {
		const same = deduplicated.find(other => equivalentEdges(edge, other, compact));
		if (same) {
			for (const [id, values] of replacements) {
				replacements.set(
					id,
					values.map(value => (value === edge.id ? same.id : value)),
				);
			}
		} else {
			deduplicated.push(edge);
		}
	}
	if (compact.length > 10000 || deduplicated.length > 10000) {
		throw new Error(localize('sessions.design.networkComplexity', 'This edit exceeds the vector point or segment limit. Simplify the path first.'));
	}
	return {
		network: retainPaint(paintSource, { vertices: compact, edges: deduplicated }, replacements),
		vertices: new Map(network.vertices.map((_, i) => [i, mapping.get(i)!])),
	};
}

function lineDistance(point: DesignPoint, a: DesignPoint, b: DesignPoint): number {
	const dx = b.x - a.x,
		dy = b.y - a.y,
		length = dx * dx + dy * dy;
	const t = length ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / length)) : 0;
	return distance(point, { x: a.x + t * dx, y: a.y + t * dy });
}
function flattenCurve(curve: Cubic, tolerance: number, depth = 0): DesignPoint[] {
	if (depth >= 10 || Math.max(lineDistance(curve[1], curve[0], curve[3]), lineDistance(curve[2], curve[0], curve[3])) <= tolerance) {
		return [curve[0], curve[3]];
	}
	const mid = (a: DesignPoint, b: DesignPoint) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
	const a = mid(curve[0], curve[1]),
		b = mid(curve[1], curve[2]),
		c = mid(curve[2], curve[3]),
		d = mid(a, b),
		e = mid(b, c),
		f = mid(d, e);
	return [...flattenCurve([curve[0], a, d, f], tolerance, depth + 1).slice(0, -1), ...flattenCurve([f, e, c, curve[3]], tolerance, depth + 1)];
}
function fitCurve(points: readonly DesignPoint[], incoming: DesignPoint, outgoing: DesignPoint): Cubic {
	const a = points[0],
		b = points.at(-1)!;
	const unit = (dx: number, dy: number) => {
		const length = Math.hypot(dx, dy) || 1;
		return { x: dx / length, y: dy / length };
	};
	const startHandle = distance(incoming, a) > 1e-10 ? incoming : points[1],
		endHandle = distance(outgoing, b) > 1e-10 ? outgoing : points.at(-2)!;
	const start = unit(startHandle.x - a.x, startHandle.y - a.y),
		end = unit(endHandle.x - b.x, endHandle.y - b.y);
	const lengths = [0];
	for (let i = 1; i < points.length; i++) {
		lengths.push(lengths[i - 1] + distance(points[i - 1], points[i]));
	}
	const total = lengths.at(-1)! || 1;
	let aa = 0,
		ab = 0,
		bb = 0,
		ax = 0,
		bx = 0;
	for (let i = 0; i < points.length; i++) {
		const t = lengths[i] / total,
			u = 1 - t,
			left = 3 * u * u * t,
			right = 3 * u * t * t;
		const x = points[i].x - a.x * (u ** 3 + left) - b.x * (right + t ** 3),
			y = points[i].y - a.y * (u ** 3 + left) - b.y * (right + t ** 3);
		aa += left * left;
		ab += left * right * (start.x * end.x + start.y * end.y);
		bb += right * right;
		ax += left * (start.x * x + start.y * y);
		bx += right * (end.x * x + end.y * y);
	}
	const det = aa * bb - ab * ab,
		fallback = distance(a, b) / 3;
	const alpha = det > 1e-12 ? (ax * bb - bx * ab) / det : fallback,
		beta = det > 1e-12 ? (bx * aa - ax * ab) / det : fallback;
	return [
		a,
		{
			x: a.x + start.x * Math.max(0, Math.min(total, alpha)),
			y: a.y + start.y * Math.max(0, Math.min(total, alpha)),
		},
		{ x: b.x + end.x * Math.max(0, Math.min(total, beta)), y: b.y + end.y * Math.max(0, Math.min(total, beta)) },
		b,
	];
}
function reuniteCurve(left: Cubic, right: Cubic): Cubic | undefined {
	const before = distance(left[2], left[3]),
		after = distance(right[0], right[1]),
		t = before / (before + after);
	if (!(t > 1e-8 && t < 1 - 1e-8)) {
		return undefined;
	}
	const control = (a: DesignPoint, b: DesignPoint, scale: number) => ({
		x: a.x + (b.x - a.x) / scale,
		y: a.y + (b.y - a.y) / scale,
	});
	const curve: Cubic = [left[0], control(left[0], left[1], t), control(right[3], right[2], 1 - t), right[3]];
	// Recover an exact subdivision before trying an approximation; this also retains endpoint tangents.
	for (let i = 0; i <= 8; i++) {
		const u = i / 8;
		if (distance(cubicBezierPoint(...curve, u * t), cubicBezierPoint(...left, u)) > 1e-7 || distance(cubicBezierPoint(...curve, t + u * (1 - t)), cubicBezierPoint(...right, u)) > 1e-7) {
			return undefined;
		}
	}
	return curve;
}

/** Simplify only degree-two anchors. Original samples, not the previous approximation, bound cumulative error in design pixels. */
export function simplifyDesignNetwork(network: DesignVectorNetwork, width: number, height: number, tolerance: number, heal?: ReadonlySet<number>): DesignNetworkEdit {
	if (!heal && tolerance <= 0) {
		return { network, vertices: new Map(network.vertices.map((_, i) => [i, i])) };
	}
	const pixels = (p: DesignPoint) => ({ x: p.x * width, y: p.y * height }),
		normalized = (p: DesignPoint) => ({ x: p.x / width, y: p.y / height });
	const edges = new Map(network.edges.map(edge => [edge.id, edge])),
		incident = network.vertices.map(() => new Set<string>()),
		samples = new Map<string, DesignPoint[]>(),
		replacements = new Map(network.edges.map(edge => [edge.id, [edge.id]]));
	const precision = Math.max(0.001, Math.min(0.05, tolerance / 8));
	for (const edge of edges.values()) {
		incident[edge.start].add(edge.id);
		incident[edge.end].add(edge.id);
		samples.set(edge.id, flattenCurve([network.vertices[edge.start], edge.outgoing, edge.incoming, network.vertices[edge.end]].map(pixels) as unknown as Cubic, precision));
	}
	const removed = new Set<number>();
	for (let pass = 0; pass < 3; pass++) {
		let changed = false;
		for (let vertex = 0; vertex < network.vertices.length; vertex++) {
			if (incident[vertex].size !== 2 || (heal && !heal.has(vertex))) {
				continue;
			}
			const [first, second] = [...incident[vertex]].map(id => edges.get(id)!);
			const a = first.start === vertex ? first.end : first.start,
				b = second.start === vertex ? second.end : second.start;
			if (a === b) {
				continue;
			} // Keep a real loop, never collapse it to an unsupported self-edge.
			const left = first.end === vertex ? samples.get(first.id)! : samples.get(first.id)!.slice().reverse(),
				right = second.start === vertex ? samples.get(second.id)! : samples.get(second.id)!.slice().reverse();
			const points = [...left, ...right.slice(1)];
			if (points.length > 4096) {
				continue;
			}
			// Subdivide straight samples too, otherwise two-segment corners have no interior error probes.
			const dense = points.flatMap((point, i) => (i ? [{ x: (point.x + points[i - 1].x) / 2, y: (point.y + points[i - 1].y) / 2 }, point] : [point]));
			const startHandle = pixels(first.end === vertex ? first.outgoing : first.incoming),
				endHandle = pixels(second.start === vertex ? second.incoming : second.outgoing);
			const curve =
				reuniteCurve(
					[pixels(network.vertices[a]), startHandle, pixels(first.end === vertex ? first.incoming : first.outgoing), pixels(network.vertices[vertex])],
					[pixels(network.vertices[vertex]), pixels(second.start === vertex ? second.outgoing : second.incoming), endHandle, pixels(network.vertices[b])],
				) ?? fitCurve(dense, startHandle, endHandle);
			if (!heal) {
				const approximation = flattenCurve(curve, precision);
				const within = (from: readonly DesignPoint[], to: readonly DesignPoint[]) =>
					from.every(point => to.slice(1).some((end, i) => lineDistance(point, to[i], end) <= Math.max(0, tolerance - precision * 2)));
				if (!within(dense, approximation) || !within(approximation, dense)) {
					continue;
				}
			}
			const edge: Edge = {
				id: first.id,
				start: a,
				end: b,
				outgoing: normalized(curve[1]),
				incoming: normalized(curve[2]),
			};
			edges.set(first.id, edge);
			edges.delete(second.id);
			samples.set(first.id, points);
			samples.delete(second.id);
			incident[a].delete(first.id);
			incident[a].delete(second.id);
			incident[a].add(edge.id);
			incident[b].delete(first.id);
			incident[b].delete(second.id);
			incident[b].add(edge.id);
			incident[vertex].clear();
			removed.add(vertex);
			changed = true;
			for (const [id, values] of replacements) {
				replacements.set(
					id,
					values.map(value => (value === second.id ? first.id : value)),
				);
			}
		}
		if (!changed) {
			break;
		}
	}
	if (!removed.size) {
		return { network, vertices: new Map(network.vertices.map((_, i) => [i, i])) };
	}
	const mapping = new Map<number, number>(),
		vertices = network.vertices.filter((_, i) => {
			if (removed.has(i)) {
				return false;
			}
			mapping.set(i, mapping.size);
			return true;
		});
	const result = {
		vertices,
		edges: [...edges.values()].map(edge => ({
			...edge,
			start: mapping.get(edge.start)!,
			end: mapping.get(edge.end)!,
		})),
	};
	return { network: retainPaint(network, result, replacements), vertices: mapping };
}
