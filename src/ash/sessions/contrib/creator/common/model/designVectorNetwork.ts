import { isRecord } from '../../../../../base/common/types.js';
import { generateUuid, isUuid } from '../../../../../base/common/uuid.js';
import { localize } from '../../../../../nls.js';
import type { DesignPoint } from '../core/geometry.js';
import { designEndpointStyles, type DesignEndpoint, type DesignPathNode } from './document.js';
import type { DesignPath, DesignPathContour } from './designVector.js';

/** Edges own their handles. A junction is one vertex, regardless of its degree. */
export interface DesignVectorNetwork {
	readonly vertices: readonly (DesignPoint & {
		readonly mirroring?: DesignPathNode['mirroring'];
		readonly cornerRadius?: number;
		readonly endpoint?: DesignEndpoint;
	})[];
	readonly edges: readonly {
		readonly id: string;
		readonly start: number;
		readonly end: number;
		readonly outgoing: DesignPoint;
		readonly incoming: DesignPoint;
	}[];
	/** Canonical boundary keys identify regions whose fill was removed with the paint tool. */
	readonly unfilledRegions?: readonly string[];
	readonly regionFills?: Readonly<Record<string, string>>;
}
export interface DesignVectorRegion {
	readonly key: string;
	readonly contour: DesignPathContour;
	readonly filled: boolean;
	readonly area: number;
}

export function parseDesignVectorNetwork(value: unknown): DesignVectorNetwork {
	const fail = (): never => {
		throw new TypeError(localize('sessions.design.invalidNetwork', 'Invalid vector network'));
	};
	const point = (value: unknown): DesignPoint => {
		if (
			!isRecord(value) ||
			Object.keys(value).some(key => !['x', 'y'].includes(key)) ||
			typeof value.x !== 'number' ||
			!Number.isFinite(value.x) ||
			typeof value.y !== 'number' ||
			!Number.isFinite(value.y)
		) {
			return fail();
		}
		return { x: value.x, y: value.y };
	};
	if (
		!isRecord(value) ||
		Object.keys(value).some(key => !['vertices', 'edges', 'unfilledRegions', 'regionFills'].includes(key)) ||
		!Array.isArray(value.vertices) ||
		value.vertices.length < 2 ||
		value.vertices.length > 10000 ||
		!Array.isArray(value.edges) ||
		!value.edges.length ||
		value.edges.length > 10000
	) {
		return fail();
	}
	const vertices = value.vertices.map(vertex => {
			if (
				!isRecord(vertex) ||
				(vertex.endpoint !== undefined && !designEndpointStyles.includes(vertex.endpoint as DesignEndpoint)) ||
				(vertex.cornerRadius !== undefined && (typeof vertex.cornerRadius !== 'number' || !Number.isFinite(vertex.cornerRadius) || vertex.cornerRadius < 0)) ||
				Object.keys(vertex).some(key => !['x', 'y', 'mirroring', 'cornerRadius', 'endpoint'].includes(key)) ||
				(vertex.mirroring !== undefined && !['none', 'angle', 'angle-length'].includes(String(vertex.mirroring)))
			) {
				return fail();
			}
			return {
				...point({ x: vertex.x, y: vertex.y }),
				...(vertex.mirroring ? { mirroring: vertex.mirroring as DesignPathNode['mirroring'] } : {}),
				...(vertex.cornerRadius !== undefined ? { cornerRadius: vertex.cornerRadius as number } : {}),
				...(vertex.endpoint !== undefined ? { endpoint: vertex.endpoint as DesignEndpoint } : {}),
			};
		}),
		ids = new Set<string>();
	const edges = value.edges.map(edge => {
		if (
			!isRecord(edge) ||
			Object.keys(edge).some(key => !['id', 'start', 'end', 'outgoing', 'incoming'].includes(key)) ||
			!isUuid(edge.id) ||
			ids.has(edge.id) ||
			!Number.isInteger(edge.start) ||
			!Number.isInteger(edge.end) ||
			Number(edge.start) < 0 ||
			Number(edge.end) < 0 ||
			Number(edge.start) >= vertices.length ||
			Number(edge.end) >= vertices.length ||
			edge.start === edge.end
		) {
			return fail();
		}
		ids.add(edge.id);
		return {
			id: edge.id,
			start: Number(edge.start),
			end: Number(edge.end),
			outgoing: point(edge.outgoing),
			incoming: point(edge.incoming),
		};
	});
	if (
		value.unfilledRegions !== undefined &&
		(!Array.isArray(value.unfilledRegions) ||
			value.unfilledRegions.length > 10000 ||
			value.unfilledRegions.some(key => typeof key !== 'string' || key.length > 380000 || key.split(',').some(id => !ids.has(id))))
	) {
		return fail();
	}
	const regionFills = value.regionFills;
	if (
		regionFills !== undefined &&
		(!isRecord(regionFills) ||
			Object.entries(regionFills).some(([key, fill]) => key.split(',').some(id => !ids.has(id)) || typeof fill !== 'string' || !/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/iu.test(fill)))
	) {
		return fail();
	}
	if ([...((value.unfilledRegions as string[]) ?? []), ...Object.keys(regionFills ?? {})].reduce((sum, key) => sum + key.length, 0) > edges.length * 150) {
		return fail();
	}
	return {
		vertices,
		edges,
		...(value.unfilledRegions ? { unfilledRegions: value.unfilledRegions as string[] } : {}),
		...(regionFills ? { regionFills: regionFills as Record<string, string> } : {}),
	};
}
export function freezeDesignVectorNetwork(network: DesignVectorNetwork): DesignVectorNetwork {
	return Object.freeze({
		vertices: Object.freeze(network.vertices.map(point => Object.freeze({ ...point }))),
		edges: Object.freeze(
			network.edges.map(edge =>
				Object.freeze({
					...edge,
					incoming: Object.freeze({ ...edge.incoming }),
					outgoing: Object.freeze({ ...edge.outgoing }),
				}),
			),
		),
		...(network.unfilledRegions ? { unfilledRegions: Object.freeze([...network.unfilledRegions]) } : {}),
		...(network.regionFills ? { regionFills: Object.freeze({ ...network.regionFills }) } : {}),
	});
}
export function designNetworkContours(network: DesignVectorNetwork): readonly DesignPathContour[] {
	return network.edges.map(edge => ({
		closed: false,
		nodes: [
			{ ...network.vertices[edge.start], incoming: network.vertices[edge.start], outgoing: edge.outgoing },
			{ ...network.vertices[edge.end], incoming: edge.incoming, outgoing: network.vertices[edge.end] },
		],
	}));
}
export function designNetworkNodes(network: DesignVectorNetwork): readonly DesignPathNode[] {
	return network.vertices.map(point => ({ ...point, incoming: point, outgoing: point }));
}
export function toDesignVectorNetwork(path: DesignPath): DesignVectorNetwork {
	if (path.network) {
		return path.network;
	}
	const vertices: DesignVectorNetwork['vertices'][number][] = [],
		edges: DesignVectorNetwork['edges'][number][] = [];
	for (const contour of [{ nodes: path.nodes, closed: path.closed }, ...(path.subpaths ?? [])]) {
		const offset = vertices.length;
		vertices.push(
			...contour.nodes.map(({ x, y, mirroring, cornerRadius, endpoint }) => ({
				x,
				y,
				...(mirroring ? { mirroring } : {}),
				...(cornerRadius !== undefined ? { cornerRadius } : {}),
				...(endpoint !== undefined ? { endpoint } : {}),
			})),
		);
		for (let i = 0; i < contour.nodes.length - (contour.closed ? 0 : 1); i++) {
			const end = (i + 1) % contour.nodes.length;
			edges.push({
				id: generateUuid(),
				start: offset + i,
				end: offset + end,
				outgoing: contour.nodes[i].outgoing,
				incoming: contour.nodes[end].incoming,
			});
		}
	}
	return paintDesignNetworkFromPath(path, { vertices, edges });
}
/** Re-evaluate the source fill rule on split faces; inserting intersections must not fill compound-path holes. */
export function paintDesignNetworkFromPath(path: DesignPath, network: DesignVectorNetwork): DesignVectorNetwork {
	const source = [{ nodes: path.nodes, closed: path.closed }, ...(path.subpaths ?? [])].filter(contour => contour.closed);
	const unfilledRegions = designNetworkRegions(network)
		.filter(region => {
			const points = sampleContour(region.contour),
				a = points[0],
				b = points[1];
			const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
			const point = {
				x: (a.x + b.x) / 2 - ((b.y - a.y) / length) * 1e-7,
				y: (a.y + b.y) / 2 + ((b.x - a.x) / length) * 1e-7,
			};
			let crossings = 0,
				winding = 0;
			for (const contour of source) {
				const polygon = sampleContour(contour);
				for (let i = 0; i < polygon.length; i++) {
					const a = polygon[i],
						b = polygon[(i + 1) % polygon.length];
					if (a.y > point.y !== b.y > point.y && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) {
						crossings++;
						winding += b.y > a.y ? 1 : -1;
					}
				}
			}
			return path.fillRule === 'evenodd' ? crossings % 2 === 0 : winding === 0;
		})
		.map(region => region.key);
	const regionFills: Record<string, string> = {};
	for (const region of designNetworkRegions(network)) {
		if (unfilledRegions.includes(region.key)) {
			continue;
		}
		const points = sampleContour(region.contour),
			a = points[0],
			b = points[1],
			length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
		const point = {
			x: (a.x + b.x) / 2 - ((b.y - a.y) / length) * 1e-7,
			y: (a.y + b.y) / 2 + ((b.x - a.x) / length) * 1e-7,
		};
		const fill = source.filter(contour => contourContains(contour, point)).at(-1)?.fill;
		if (fill && fill !== path.fill) {
			regionFills[region.key] = fill;
		}
	}
	const { unfilledRegions: _unfilled, regionFills: _colors, ...geometry } = network;
	return {
		...geometry,
		...(unfilledRegions.length ? { unfilledRegions } : {}),
		...(Object.keys(regionFills).length ? { regionFills } : {}),
	};
}
/** Legacy contour fields are empty in network mode: geometry has exactly one owner. */
export function withDesignVectorNetwork(path: DesignPath, network: DesignVectorNetwork): DesignPath {
	const { subpaths: _subpaths, ...rest } = path;
	return { ...rest, nodes: [], closed: false, network };
}
export function moveDesignNetworkVertices(network: DesignVectorNetwork, indices: ReadonlySet<number>, dx: number, dy: number): DesignVectorNetwork {
	const move = (point: DesignPoint) => ({ ...point, x: point.x + dx, y: point.y + dy });
	return {
		...network,
		vertices: network.vertices.map((point, i) => (indices.has(i) ? move(point) : point)),
		edges: network.edges.map(edge => ({
			...edge,
			outgoing: indices.has(edge.start) ? move(edge.outgoing) : edge.outgoing,
			incoming: indices.has(edge.end) ? move(edge.incoming) : edge.incoming,
		})),
	};
}
export function moveDesignNetworkHandle(
	network: DesignVectorNetwork,
	index: number,
	point: 'incoming' | 'outgoing',
	target: DesignPoint,
	width: number,
	height: number,
	independent = false,
): DesignVectorNetwork {
	const edge = network.edges[index],
		vertexIndex = point === 'outgoing' ? edge.start : edge.end,
		vertex = network.vertices[vertexIndex];
	const others = network.edges.map((edge, i) => ({ edge, i })).filter(item => item.i !== index && (item.edge.start === vertexIndex || item.edge.end === vertexIndex));
	const mode = independent ? 'none' : (vertex.mirroring ?? 'none');
	const other = others.length === 1 ? others[0] : undefined;
	const opposite = other?.edge.start === vertexIndex ? 'outgoing' : 'incoming';
	const dx = (target.x - vertex.x) * width,
		dy = (target.y - vertex.y) * height,
		length = Math.hypot(dx, dy);
	const ratio = mode === 'angle-length' ? 1 : other && length ? Math.hypot((other.edge[opposite].x - vertex.x) * width, (other.edge[opposite].y - vertex.y) * height) / length : 0;
	return {
		...network,
		vertices: independent ? network.vertices.map((value, i) => (i === vertexIndex ? { ...value, mirroring: 'none' } : value)) : network.vertices,
		edges: network.edges.map((value, i) =>
			i === index
				? { ...value, [point]: target }
				: mode !== 'none' && other?.i === i
					? {
							...value,
							[opposite]: { x: vertex.x - (dx * ratio) / width, y: vertex.y - (dy * ratio) / height },
						}
					: value,
		),
	};
}
export function connectDesignNetwork(network: DesignVectorNetwork, start: number, end: number | DesignPoint): DesignVectorNetwork {
	const vertices = typeof end === 'number' ? network.vertices : [...network.vertices, end];
	const target = typeof end === 'number' ? end : vertices.length - 1;
	if (start === target) {
		return network;
	}
	const incident = network.edges.filter(edge => edge.start === start || edge.end === start);
	const handle = incident.length === 1 ? (incident[0].start === start ? incident[0].outgoing : incident[0].incoming) : vertices[start];
	const outgoing = { x: 2 * vertices[start].x - handle.x, y: 2 * vertices[start].y - handle.y };
	const next = {
		...network,
		vertices,
		edges: [
			...network.edges,
			{
				id: generateUuid(),
				start,
				end: target,
				outgoing,
				incoming: { x: vertices[target].x, y: vertices[target].y },
			},
		],
	};
	if (!network.unfilledRegions?.length && !network.regionFills) {
		return next;
	}
	// A chord subdivides the existing face; both pieces inherit its paint state.
	const regionFills: Record<string, string> = {};
	const unfilledRegions = designNetworkRegions(next)
		.filter(region => {
			if (network.regionFills?.[region.key]) {
				regionFills[region.key] = network.regionFills[region.key];
			}
			if (network.unfilledRegions?.includes(region.key)) {
				return true;
			}
			const points = sampleContour(region.contour),
				a = points[0],
				b = points[1],
				length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
			const point = {
				x: (a.x + b.x) / 2 - ((b.y - a.y) / length) * 1e-7,
				y: (a.y + b.y) / 2 + ((b.x - a.x) / length) * 1e-7,
			};
			const previous = designNetworkRegionAt(network, point);
			if (previous && network.regionFills?.[previous.key]) {
				regionFills[region.key] = network.regionFills[previous.key];
			}
			return previous?.filled === false;
		})
		.map(region => region.key);
	return { ...next, unfilledRegions, regionFills };
}
export function splitDesignNetworkEdge(network: DesignVectorNetwork, index: number, t: number): DesignVectorNetwork {
	const edge = network.edges[index],
		a = network.vertices[edge.start],
		b = network.vertices[edge.end];
	const lerp = (a: DesignPoint, b: DesignPoint): DesignPoint => ({
		x: a.x + (b.x - a.x) * t,
		y: a.y + (b.y - a.y) * t,
	});
	const p = lerp(a, edge.outgoing),
		q = lerp(edge.outgoing, edge.incoming),
		r = lerp(edge.incoming, b),
		s = lerp(p, q),
		u = lerp(q, r),
		anchor = lerp(s, u);
	const next = { id: generateUuid(), start: network.vertices.length, end: edge.end, outgoing: u, incoming: r };
	const splitKey = (key: string) => (key.split(',').includes(edge.id) ? [...key.split(','), next.id].sort().join(',') : key);
	return {
		...network,
		vertices: [...network.vertices, anchor],
		edges: [...network.edges.map((value, i) => (i === index ? { ...value, end: next.start, outgoing: p, incoming: s } : value)), next],
		unfilledRegions: network.unfilledRegions?.map(splitKey),
		...(network.regionFills
			? {
					regionFills: Object.fromEntries(Object.entries(network.regionFills).map(([key, fill]) => [splitKey(key), fill])),
				}
			: {}),
	};
}
export function removeDesignNetworkVertices(network: DesignVectorNetwork, indices: ReadonlySet<number>): DesignVectorNetwork {
	const remap = new Map<number, number>();
	const vertices = network.vertices.filter((_, i) => {
		if (indices.has(i)) {
			return false;
		}
		remap.set(i, remap.size);
		return true;
	});
	const edges = network.edges.filter(edge => remap.has(edge.start) && remap.has(edge.end)).map(edge => ({ ...edge, start: remap.get(edge.start)!, end: remap.get(edge.end)! }));
	const ids = new Set(edges.map(edge => edge.id));
	return {
		vertices,
		edges,
		unfilledRegions: network.unfilledRegions?.filter(key => key.split(',').every(id => ids.has(id))),
		...(network.regionFills
			? {
					regionFills: Object.fromEntries(Object.entries(network.regionFills).filter(([key]) => key.split(',').every(id => ids.has(id)))),
				}
			: {}),
	};
}

const regionsCache = new WeakMap<DesignVectorNetwork, readonly DesignVectorRegion[]>();
/** Walk directed half-edges in angular order. Bridges appear twice and never create a filled face. */
export function designNetworkRegions(network: DesignVectorNetwork): readonly DesignVectorRegion[] {
	const cached = regionsCache.get(network);
	if (cached) {
		return cached;
	}
	const outgoing: number[][] = network.vertices.map(() => []);
	const start = (half: number) => {
		const edge = network.edges[half >> 1];
		return half % 2 ? edge.end : edge.start;
	};
	const end = (half: number) => {
		const edge = network.edges[half >> 1];
		return half % 2 ? edge.start : edge.end;
	};
	const angle = (half: number) => {
		const edge = network.edges[half >> 1],
			a = network.vertices[start(half)],
			b = network.vertices[end(half)];
		const handle = half % 2 ? edge.incoming : edge.outgoing;
		return Math.atan2((handle.y === a.y && handle.x === a.x ? b.y : handle.y) - a.y, (handle.y === a.y && handle.x === a.x ? b.x : handle.x) - a.x);
	};
	for (let half = 0; half < network.edges.length * 2; half++) {
		outgoing[start(half)].push(half);
	}
	for (const list of outgoing) {
		list.sort((a, b) => angle(a) - angle(b));
	}
	const visited = new Set<number>(),
		regions: DesignVectorRegion[] = [];
	for (let first = 0; first < network.edges.length * 2; first++) {
		if (visited.has(first)) {
			continue;
		}
		const boundary: number[] = [];
		let half = first;
		while (!visited.has(half)) {
			visited.add(half);
			boundary.push(half);
			const list = outgoing[end(half)],
				reverse = list.indexOf(half ^ 1);
			half = list[(reverse + list.length - 1) % list.length];
		}
		if (half !== first) {
			continue;
		}
		const nodes: DesignPathNode[] = boundary.map((half, i) => {
			const edge = network.edges[half >> 1],
				previous = boundary[(i + boundary.length - 1) % boundary.length],
				before = network.edges[previous >> 1];
			return {
				...network.vertices[start(half)],
				outgoing: half % 2 ? edge.incoming : edge.outgoing,
				incoming: previous % 2 ? before.outgoing : before.incoming,
			};
		});
		// Cubic sampling is used only to determine orientation; the actual boundary retains exact handles.
		const polygon = sampleContour({ nodes, closed: true });
		const area = polygon.reduce((sum, a, i) => {
			const b = polygon[(i + 1) % polygon.length];
			return sum + a.x * b.y - b.x * a.y;
		}, 0);
		if (area <= 1e-12) {
			continue;
		}
		const key = boundary
			.filter(half => !boundary.includes(half ^ 1))
			.map(half => network.edges[half >> 1].id)
			.sort()
			.join(',');
		regions.push({ key, contour: { nodes, closed: true }, area, filled: !network.unfilledRegions?.includes(key) });
	}
	regionsCache.set(network, regions);
	return regions;
}
function sampleContour(contour: DesignPathContour): DesignPoint[] {
	return contour.nodes.flatMap((a, i) => {
		const b = contour.nodes[(i + 1) % contour.nodes.length];
		return Array.from({ length: 24 }, (_, step) => {
			const t = step / 24,
				u = 1 - t;
			return {
				x: u ** 3 * a.x + 3 * u * u * t * a.outgoing.x + 3 * u * t * t * b.incoming.x + t ** 3 * b.x,
				y: u ** 3 * a.y + 3 * u * u * t * a.outgoing.y + 3 * u * t * t * b.incoming.y + t ** 3 * b.y,
			};
		});
	});
}
function contourContains(contour: DesignPathContour, point: DesignPoint): boolean {
	const polygon = sampleContour(contour);
	let inside = false;
	for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
		const a = polygon[i],
			b = polygon[j];
		if (a.y > point.y !== b.y > point.y && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) {
			inside = !inside;
		}
	}
	return inside;
}
export function designNetworkRegionAt(network: DesignVectorNetwork, point: DesignPoint): DesignVectorRegion | undefined {
	return [...designNetworkRegions(network)].sort((a, b) => a.area - b.area).find(region => contourContains(region.contour, point));
}
/** Nested disconnected loops bound holes. Adjacent faces have equal shared boundaries, never holes. */
export function designNetworkFillContours(network: DesignVectorNetwork): readonly DesignPathContour[] {
	const regions = designNetworkRegions(network);
	const parent = regions.map(
		region =>
			regions
				.filter(other => other.area > region.area && !region.key.split(',').some(id => other.key.split(',').includes(id)) && contourContains(other.contour, region.contour.nodes[0]))
				.sort((a, b) => a.area - b.area)[0],
	);
	return regions.flatMap(region =>
		region.filled
			? [
					{
						...region.contour,
						...(network.regionFills?.[region.key] ? { fill: network.regionFills[region.key] } : {}),
					},
					...regions
						.filter((_, i) => parent[i] === region)
						.map(hole => ({
							closed: true,
							...(network.regionFills?.[region.key] ? { fill: network.regionFills[region.key] } : {}),
							nodes: hole.contour.nodes
								.slice()
								.reverse()
								.map(node => ({ ...node, incoming: node.outgoing, outgoing: node.incoming })),
						})),
				]
			: [],
	);
}
/** Degree-two vertices remain continuous strokes, preserving joins and dash phase along each branch. */
export function designNetworkStrokeContours(network: DesignVectorNetwork): readonly DesignPathContour[] {
	const adjacent: number[][] = network.vertices.map(() => []);
	for (const [i, edge] of network.edges.entries()) {
		adjacent[edge.start].push(i);
		adjacent[edge.end].push(i);
	}
	const seen = new Set<number>(),
		contours: DesignPathContour[] = [];
	const walk = (first: number, start: number) => {
		const nodes: DesignPathNode[] = [];
		let index = first,
			vertex = start;
		while (!seen.has(index)) {
			seen.add(index);
			const edge = network.edges[index],
				forward = edge.start === vertex;
			const anchor = network.vertices[vertex],
				outgoing = forward ? edge.outgoing : edge.incoming;
			if (!nodes.length) {
				nodes.push({
					...anchor,
					...(adjacent[vertex].length === 1 ? {} : { endpoint: undefined }),
					incoming: anchor,
					outgoing,
				});
			} else {
				nodes[nodes.length - 1] = { ...nodes.at(-1)!, outgoing };
			}
			vertex = forward ? edge.end : edge.start;
			const end = network.vertices[vertex],
				incoming = forward ? edge.incoming : edge.outgoing;
			if (vertex === start) {
				nodes[0] = { ...nodes[0], incoming };
				contours.push({ nodes, closed: true });
				return;
			}
			nodes.push({
				...end,
				...(adjacent[vertex].length === 1 ? {} : { endpoint: undefined }),
				incoming,
				outgoing: end,
			});
			if (adjacent[vertex].length !== 2) {
				break;
			}
			index = adjacent[vertex].find(next => next !== index)!;
		}
		contours.push({ nodes, closed: false });
	};
	for (const [vertex, edges] of adjacent.entries()) {
		if (edges.length !== 2) {
			for (const edge of edges) {
				if (!seen.has(edge)) {
					walk(edge, vertex);
				}
			}
		}
	}
	for (const [i, edge] of network.edges.entries()) {
		if (!seen.has(i)) {
			walk(i, edge.start);
		}
	}
	return contours;
}
