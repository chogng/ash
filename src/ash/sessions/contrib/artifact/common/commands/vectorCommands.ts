import { moveArtifactCanvasNetworkVertices, removeArtifactCanvasNetworkVertices, splitArtifactCanvasNetworkEdge, toArtifactCanvasVectorNetwork, withArtifactCanvasVectorNetwork } from '../model/artifactCanvasVectorNetwork.js';
import { mergeArtifactCanvasNetworkVertices, simplifyArtifactCanvasNetwork } from '../model/artifactCanvasVectorTopology.js';
import type { ArtifactCanvasModel } from '../model/artifactCanvasModel.js';
import { flattenArtifactCanvasShapes, type ArtifactCanvasEndpoint, type ArtifactCanvasPathNode, type ArtifactCanvasShape } from '../model/artifactCanvasDocument.js';
import { artifactCanvasWidthLocation, nearestArtifactCanvasWidthLocation, supportsArtifactCanvasVariableWidth } from '../model/artifactCanvasVariableWidth.js';
import { artifactCanvasPathContours, artifactCanvasShapeContours, splitArtifactCanvasPathSegment, withArtifactCanvasPathContours, type ArtifactCanvasPath, type ArtifactCanvasPathContour } from '../model/artifactCanvasVector.js';

/** Path topology edits commit once, preserving the layer identity and its component override boundary. */
export class VectorCommands {
	constructor(private readonly model: ArtifactCanvasModel) { }
	public replace(shape: ArtifactCanvasShape, contours: readonly ArtifactCanvasPathContour[], outline = false): void {
		if (!contours.length) { return; }
		this.update(flattenArtifactCanvasVector(shape, contours, outline));
	}

	public convert(shape: ArtifactCanvasShape): void {
		if (shape.kind === 'rectangle' || shape.kind === 'ellipse') { this.replace(shape, artifactCanvasShapeContours(shape)); }
	}
	public update(path: ArtifactCanvasPath): void {
		const before = flattenArtifactCanvasShapes(this.model.value.shapes).find(shape => shape.id === path.id);
		if (path.widthPoints?.length && !supportsArtifactCanvasVariableWidth(path)) { path = { ...path, widthPoints: undefined }; }
		else if (before?.kind === 'path' && before.widthPoints?.length && path.widthPoints === before.widthPoints) {
			// Topology changes can reorder contours. Keep width points at their geometric positions on the new path.
			const signature = (value: ArtifactCanvasPath) => value.network ? value.network.edges.map(edge => `${edge.start}:${edge.end}`).join(',') : artifactCanvasPathContours(value).map(contour => `${contour.closed}:${contour.nodes.length}`).join(';');
			if (signature(before) !== signature(path)) {
				path = remapWidthPoints(before, path);
			}
		}
		if (path.widthPoints?.length) {
			// Figma's dynamic strokes are centered and remove arrow tips when a width profile is applied.
			const clean = <T extends { readonly endpoint?: ArtifactCanvasEndpoint; }>(node: T): T => node.endpoint?.includes('arrow') || node.endpoint === 'reverse-triangle' ? { ...node, endpoint: undefined } : node;
			path = { ...path, strokeAlignment: 'center', nodes: path.nodes.map(clean), ...(path.subpaths ? { subpaths: path.subpaths.map(contour => ({ ...contour, nodes: contour.nodes.map(clean) })) } : {}), ...(path.network ? { network: { ...path.network, vertices: path.network.vertices.map(clean) } } : {}) };
		}
		const visit = (shape: ArtifactCanvasShape): ArtifactCanvasShape => shape.id === path.id ? path : shape.kind === 'group' || shape.kind === 'frame' ? { ...shape, children: shape.children.map(visit) } : shape;
		this.model.applyEdit(this.model.value.shapes.map(visit));
	}
	public setEndpoints(path: ArtifactCanvasPath, endpoints: readonly { contour: number; index: number; }[], style: ArtifactCanvasEndpoint | undefined): void {
		const selected = (ci: number, index: number) => endpoints.some(endpoint => endpoint.contour === ci && endpoint.index === index);
		const edit = style === undefined ? path : { ...path, widthPoints: undefined };
		if (edit.network) { this.update(withArtifactCanvasVectorNetwork(edit, { ...edit.network, vertices: edit.network.vertices.map((node, index) => selected(0, index) ? { ...node, endpoint: style } : node) })); }
		else { this.update(withArtifactCanvasPathContours(edit, artifactCanvasPathContours(edit).map((contour, ci) => ({ ...contour, nodes: contour.nodes.map((node, index) => selected(ci, index) ? { ...node, endpoint: style } : node) })))); }
	}

	public mergeNodes(path: ArtifactCanvasPath, contour: number, indices: ReadonlySet<number>): number {
		const offset = path.network ? 0 : artifactCanvasPathContours(path).slice(0, contour).reduce((sum, value) => sum + value.nodes.length, 0);
		const selected = new Set([...indices].map(index => index + offset));
		const result = mergeArtifactCanvasNetworkVertices(toArtifactCanvasVectorNetwork(path), selected);
		if (result.network.edges.length) { this.update(withArtifactCanvasVectorNetwork(path, result.network)); }
		else { this.removeNodes(path, contour, new Set((path.network?.vertices ?? artifactCanvasPathContours(path)[contour]?.nodes ?? []).map((_, i) => i))); }
		return result.vertices.get([...selected][0]) ?? 0;
	}
	public healNodes(path: ArtifactCanvasPath, contour: number, indices: ReadonlySet<number>): void {
		const offset = path.network ? 0 : artifactCanvasPathContours(path).slice(0, contour).reduce((sum, value) => sum + value.nodes.length, 0);
		const network = toArtifactCanvasVectorNetwork(path), result = simplifyArtifactCanvasNetwork(network, path.width, path.height, 1, new Set([...indices].map(index => index + offset)));
		if (result.network !== network) { this.update(withArtifactCanvasVectorNetwork(path, result.network)); }
	}
	public editContour(path: ArtifactCanvasPath, index: number, edit: (contour: ArtifactCanvasPathContour) => ArtifactCanvasPathContour): void {
		if (path.network) {
			const before = path.network.vertices, after = edit({ nodes: before.map(point => ({ ...point, incoming: point, outgoing: point })), closed: false }).nodes;
			let network = path.network;
			for (let i = 0; i < before.length; i++) { if (after[i] && (after[i].x !== before[i].x || after[i].y !== before[i].y)) { network = moveArtifactCanvasNetworkVertices(network, new Set([i]), after[i].x - before[i].x, after[i].y - before[i].y); } }
			this.update(withArtifactCanvasVectorNetwork(path, network)); return;
		}
		this.update(withArtifactCanvasPathContours(path, artifactCanvasPathContours(path).map((contour, i) => i === index ? edit(contour) : contour)));
	}
	public insertNode(path: ArtifactCanvasPath, contour: number, segment: number, t = .5): void {
		if (path.network) { this.update(withArtifactCanvasVectorNetwork(path, splitArtifactCanvasNetworkEdge(path.network, contour, t))); return; }
		this.editContour(path, contour, value => splitArtifactCanvasPathSegment(value, segment, t));
	}
	public removeNodes(path: ArtifactCanvasPath, contour: number, indices: ReadonlySet<number>): void {
		if (path.network) {
			const network = removeArtifactCanvasNetworkVertices(path.network, indices);
			if (network.edges.length) { this.update(withArtifactCanvasVectorNetwork(path, network)); return; }
		}
		const contours = path.network ? [] : artifactCanvasPathContours(path).flatMap((value, index) => {
			if (index !== contour) { return [value]; }
			const nodes = value.nodes.filter((_, i) => !indices.has(i));
			return nodes.length >= 2 ? [{ ...value, nodes }] : [];
		});
		if (contours.length) { this.update(withArtifactCanvasPathContours(path, contours)); }
		else {
			const remove = (shapes: readonly ArtifactCanvasShape[]): readonly ArtifactCanvasShape[] => shapes.flatMap<ArtifactCanvasShape>(shape => {
				if (shape.id === path.id) { return []; }
				if (shape.kind !== 'group' && shape.kind !== 'frame') { return [shape]; }
				const children = remove(shape.children);
				return shape.kind === 'group' && !children.length ? [] : [{ ...shape, children }];
			});
			this.model.applyEdit(remove(this.model.value.shapes));
		}
	}
	public reverse(path: ArtifactCanvasPath, contour: number): void {
		if (path.network) { this.update(withArtifactCanvasVectorNetwork(path, { ...path.network, edges: path.network.edges.map(edge => ({ ...edge, start: edge.end, end: edge.start, incoming: edge.outgoing, outgoing: edge.incoming })) })); return; }
		const reversed = withArtifactCanvasPathContours(path, artifactCanvasPathContours(path).map((value, i) => i === contour ? { ...value, nodes: value.nodes.slice().reverse().map(node => ({ ...node, incoming: node.outgoing, outgoing: node.incoming })) } : value));
		this.update(remapWidthPoints(path, reversed));
	}
	public cut(path: ArtifactCanvasPath, contour: number, index: number): void {
		if (path.network) {
			const vertices = [...path.network.vertices]; let first = true;
			const edges = path.network.edges.map(edge => {
				if (edge.start !== index && edge.end !== index) { return edge; }
				if (first) { first = false; return edge; }
				const next = vertices.push({ ...vertices[index] }) - 1;
				return { ...edge, start: edge.start === index ? next : edge.start, end: edge.end === index ? next : edge.end };
			});
			this.update(withArtifactCanvasVectorNetwork(path, { ...path.network, vertices, edges })); return;
		}
		const contours = artifactCanvasPathContours(path).flatMap((value, i) => {
			if (i !== contour) { return [value]; }
			// Cutting an anchor opens a loop, or creates two open contours that share its position.
			if (value.closed) { return [{ closed: false, nodes: [...value.nodes.slice(index), ...value.nodes.slice(0, index + 1)] }]; }
			return [value.nodes.slice(0, index + 1), value.nodes.slice(index)].filter(nodes => nodes.length >= 2).map(nodes => ({ closed: false, nodes }));
		});
		this.update(withArtifactCanvasPathContours(path, contours));
	}
	public join(path: ArtifactCanvasPath, first: number, second: number): void {
		const contours = artifactCanvasPathContours(path), a = contours[first], b = contours[second];
		if (!a || !b || a.closed || b.closed) { return; }
		if (first === second) { this.editContour(path, first, value => ({ ...value, closed: true })); return; }
		const reverse = (nodes: readonly ArtifactCanvasPathNode[]) => nodes.slice().reverse().map(node => ({ ...node, incoming: node.outgoing, outgoing: node.incoming }));
		const pairs = [a.nodes.length - 1, 0].flatMap(ai => [0, b.nodes.length - 1].map(bi => ({ ai, bi, distance: Math.hypot((a.nodes[ai].x - b.nodes[bi].x) * path.width, (a.nodes[ai].y - b.nodes[bi].y) * path.height) }))).sort((a, b) => a.distance - b.distance);
		const nearest = pairs[0], left = nearest.ai === 0 ? reverse(a.nodes) : [...a.nodes], right = nearest.bi === 0 ? [...b.nodes] : reverse(b.nodes);
		// Reorient complete contours before joining their nearest endpoints; preserve both cubic handles.
		if (nearest.distance < 1e-8) { left[left.length - 1] = { ...left.at(-1)!, outgoing: right[0].outgoing, mirroring: 'none' }; right.shift(); }
		const merged = { closed: false, nodes: [...left, ...right] };
		this.update(withArtifactCanvasPathContours(path, contours.flatMap((contour, index) => index === first ? [merged] : index === second ? [] : [contour])));
	}
	public setMirroring(path: ArtifactCanvasPath, contour: number, indices: ReadonlySet<number>, mode: NonNullable<ArtifactCanvasPathNode['mirroring']>): void {
		if (path.network) {
			const network = path.network; let edges = [...network.edges];
			for (const index of indices) {
				const incident = edges.map((edge, i) => ({ edge, i })).filter(({ edge }) => edge.start === index || edge.end === index);
				if (incident.length !== 2 || mode === 'none') { continue; }
				const [a, b] = incident, vertex = network.vertices[index], left = network.vertices[a.edge.start === index ? a.edge.end : a.edge.start], right = network.vertices[b.edge.start === index ? b.edge.end : b.edge.start];
				const dx = (right.x - left.x) / 6, dy = (right.y - left.y) / 6;
				edges = edges.map((edge, i) => i === a.i || i === b.i ? { ...edge, [edge.start === index ? 'outgoing' : 'incoming']: { x: vertex.x + dx * (i === a.i ? -1 : 1), y: vertex.y + dy * (i === a.i ? -1 : 1) } } : edge);
			}
			this.update(withArtifactCanvasVectorNetwork(path, { ...network, vertices: network.vertices.map((point, i) => indices.has(i) ? { ...point, mirroring: mode } : point), edges })); return;
		}
		this.editContour(path, contour, value => ({
			...value, nodes: value.nodes.map((node, index) => {
				if (!indices.has(index)) { return node; }
				if (mode === 'none') { return { ...node, mirroring: mode }; }
				const previous = value.nodes[index > 0 ? index - 1 : value.closed ? value.nodes.length - 1 : index], next = value.nodes[index < value.nodes.length - 1 ? index + 1 : value.closed ? 0 : index];
				let dx = (node.outgoing.x - node.x) * path.width, dy = (node.outgoing.y - node.y) * path.height;
				let length = Math.hypot(dx, dy);
				if (!length) { const divisor = !value.closed && (index === 0 || index === value.nodes.length - 1) ? 3 : 6; dx = (next.x - previous.x) * path.width / divisor; dy = (next.y - previous.y) * path.height / divisor; length = Math.hypot(dx, dy); }
				const incoming = mode === 'angle-length' ? length : Math.hypot((node.incoming.x - node.x) * path.width, (node.incoming.y - node.y) * path.height) || length;
				const ratio = length ? incoming / length : 0;
				return { ...node, mirroring: mode, outgoing: { x: node.x + dx / path.width, y: node.y + dy / path.height }, incoming: { x: node.x - dx * ratio / path.width, y: node.y - dy * ratio / path.height } };
			})
		}));
	}
	public corner(path: ArtifactCanvasPath, contour: number, indices: ReadonlySet<number>): void {
		if (path.network) { const network = path.network; this.update(withArtifactCanvasVectorNetwork(path, { ...network, vertices: network.vertices.map((point, i) => indices.has(i) ? { ...point, mirroring: 'none' } : point), edges: network.edges.map(edge => ({ ...edge, outgoing: indices.has(edge.start) ? { x: network.vertices[edge.start].x, y: network.vertices[edge.start].y } : edge.outgoing, incoming: indices.has(edge.end) ? { x: network.vertices[edge.end].x, y: network.vertices[edge.end].y } : edge.incoming })) })); return; }
		this.editContour(path, contour, value => ({ ...value, nodes: value.nodes.map((node, index) => indices.has(index) ? { ...node, incoming: { x: node.x, y: node.y }, outgoing: { x: node.x, y: node.y }, mirroring: 'none' } : node) }));
	}
}

/** Strip container-only fields while keeping shared layer metadata when geometry becomes a path. */
export function flattenArtifactCanvasVector(shape: ArtifactCanvasShape, contours: readonly ArtifactCanvasPathContour[], outline = false): ArtifactCanvasPath {
	const { kind: _kind, ...geometry } = shape;
	// Copy shared properties explicitly: container fields must not leak into the persisted path contract.
	const path: ArtifactCanvasPath = {
		id: geometry.id, kind: 'path', x: geometry.x, y: geometry.y, width: geometry.width, height: geometry.height, rotation: geometry.rotation, fill: outline && shape.kind === 'path' ? shape.stroke ?? shape.fill : shape.fill,
		fills: outline ? undefined : geometry.fills, blendMode: geometry.blendMode, name: geometry.name, visible: geometry.visible, opacity: geometry.opacity, effects: geometry.effects, constraints: geometry.constraints, sizing: geometry.sizing, sizeLimits: geometry.sizeLimits, layoutPositioning: geometry.layoutPositioning, gridCell: geometry.gridCell, motion: geometry.motion, interactions: geometry.interactions, flowStart: geometry.flowStart, scrollPosition: geometry.scrollPosition, bindings: geometry.bindings ? Object.fromEntries(Object.entries(geometry.bindings).filter(([key]) => key !== 'strokeWidth' && !(outline && shape.kind === 'path' && shape.stroke && key === 'fill'))) : undefined, styleBindings: outline && shape.kind === 'path' && shape.stroke && geometry.styleBindings ? Object.fromEntries(Object.entries(geometry.styleBindings).filter(([key]) => key !== 'fill')) : geometry.styleBindings, variableModes: geometry.variableModes,
		nodes: contours[0].nodes, closed: contours[0].closed, subpaths: contours.slice(1), strokeWidth: 0, fillRule: 'nonzero',
	};
	return Object.fromEntries(Object.entries(path).filter(([, value]) => value !== undefined)) as unknown as ArtifactCanvasPath;
}

/** Retain profile placement across topology changes; ordinary anchor movement keeps fractional positions. */
function remapWidthPoints(before: ArtifactCanvasPath, after: ArtifactCanvasPath): ArtifactCanvasPath {
	if (!before.widthPoints?.length) { return after; }
	return { ...after, widthPoints: before.widthPoints.flatMap(point => { const location = artifactCanvasWidthLocation(before, point.contour, point.position); const next = location && nearestArtifactCanvasWidthLocation(after, location.point); const target = next && artifactCanvasWidthLocation(after, next.contour, next.position); const direction = location && target && location.normal.x * target.normal.x + location.normal.y * target.normal.y < 0 ? -1 : 1; return next ? [{ ...point, ...next, ...(point.slope !== undefined ? { slope: point.slope * direction } : {}) }] : []; }) };
}
