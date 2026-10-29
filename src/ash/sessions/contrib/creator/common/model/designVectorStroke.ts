import { cubicBezierPoint, type DesignPoint } from '../core/geometry.js';
import type { DesignEndpoint } from './document.js';
import { designPathContours, designPathStrokeContours, splitDesignPathSegment, type DesignPath, type DesignPathContour } from './designVector.js';

/** Endpoint identity follows its anchor through reversal and network conversion, not the traversal order. */
export function designPathEndpoints(path: DesignPath): readonly {
	contour: number;
	index: number;
	style: DesignEndpoint;
	explicit: boolean;
	point: DesignPoint;
	direction: DesignPoint;
}[] {
	const endpoint = (contour: number, index: number, points: readonly DesignPoint[], style?: DesignEndpoint) => {
		const point = points[0],
			next = points.slice(1).find(p => Math.hypot((p.x - point.x) * path.width, (p.y - point.y) * path.height) > 1e-8);
		const dx = next ? (point.x - next.x) * path.width : 1,
			dy = next ? (point.y - next.y) * path.height : 0,
			length = Math.hypot(dx, dy);
		return {
			contour,
			index,
			point,
			explicit: style !== undefined,
			style: style ?? path.strokeCap ?? 'butt',
			direction: { x: dx / length, y: dy / length },
		};
	};
	if (path.network) {
		const { vertices, edges } = path.network;
		const incident: number[][] = vertices.map(() => []);
		for (const [i, edge] of edges.entries()) {
			incident[edge.start].push(i);
			incident[edge.end].push(i);
		}
		return vertices.flatMap((point, index) => {
			if (incident[index].length !== 1) {
				return [];
			}
			const edge = edges[incident[index][0]],
				start = edge.start === index;
			return [endpoint(0, index, [point, start ? edge.outgoing : edge.incoming, start ? edge.incoming : edge.outgoing, vertices[start ? edge.end : edge.start]], point.endpoint)];
		});
	}
	return designPathContours(path).flatMap((contour, ci) =>
		contour.closed || contour.nodes.length < 2
			? []
			: [0, contour.nodes.length - 1].map(index => {
					const start = index === 0,
						node = contour.nodes[index],
						neighbor = contour.nodes[start ? 1 : index - 1];
					return endpoint(ci, index, [node, start ? node.outgoing : node.incoming, start ? neighbor.incoming : neighbor.outgoing, neighbor], node.endpoint);
				}),
	);
}

/** Open subpaths remain centered; a closed contour's fill rule determines its interior, including holes. */
export function designStrokeLayers(path: DesignPath): readonly { contours: readonly DesignPathContour[]; width: number; alignment: 'center' | 'inside' | 'outside' }[] {
	const contours = designPathStrokeContours(path).flatMap(contour => {
			const trimmed = path.widthPoints?.length ? contour : trimArrowStroke(contour, path.width, path.height, path.strokeWidth);
			return trimmed ? [trimmed] : [];
		}),
		alignment = path.widthPoints?.length ? 'center' : (path.strokeAlignment ?? 'center');
	if (alignment === 'center') {
		return [{ contours, width: path.strokeWidth, alignment }];
	}
	return [
		{ contours: contours.filter(contour => contour.closed), width: path.strokeWidth * 2, alignment },
		{
			contours: contours.filter(contour => !contour.closed),
			width: path.strokeWidth,
			alignment: 'center' as const,
		},
	].filter(layer => layer.contours.length);
}

/** Filled endpoint outlines are shared by SVG, hit testing, booleans and Outline stroke. */
export function designEndpointContours(path: DesignPath): readonly DesignPathContour[] {
	if (!path.strokeWidth || path.widthPoints?.length) {
		return [];
	}
	return designPathEndpoints(path).flatMap(endpoint => {
		if (path.dashArray?.length && !endpoint.explicit) {
			return [];
		}
		const { point, direction: u, style } = endpoint,
			width = path.strokeWidth,
			half = width / 2,
			length = width * 3;
		const at = (x: number, y: number): DesignPoint => ({
			x: point.x + (u.x * x - u.y * y) / path.width,
			y: point.y + (u.y * x + u.x * y) / path.height,
		});
		const polygon = (points: readonly (readonly [number, number])[]): DesignPathContour => ({
			closed: true,
			nodes: points.map(([x, y]) => {
				const p = at(x, y);
				return { ...p, incoming: p, outgoing: p };
			}),
		});
		if (style === 'butt') {
			return [];
		}
		if (style === 'square') {
			return [
				polygon([
					[0, -half],
					[half, -half],
					[half, half],
					[0, half],
				]),
			];
		}
		if (style === 'round' || style === 'circle-arrow') {
			const radius = style === 'round' ? half : width * 1.5,
				cx = style === 'round' ? 0 : -radius,
				k = radius * 0.5522847498307936;
			return [
				{
					closed: true,
					nodes: [
						{ ...at(cx + radius, 0), incoming: at(cx + radius, -k), outgoing: at(cx + radius, k) },
						{ ...at(cx, radius), incoming: at(cx + k, radius), outgoing: at(cx - k, radius) },
						{ ...at(cx - radius, 0), incoming: at(cx - radius, k), outgoing: at(cx - radius, -k) },
						{ ...at(cx, -radius), incoming: at(cx - k, -radius), outgoing: at(cx + k, -radius) },
					],
				},
			];
		}
		if (style === 'triangle-arrow') {
			return [
				polygon([
					[0, 0],
					[-length, length / Math.sqrt(3)],
					[-length, -length / Math.sqrt(3)],
				]),
			];
		}
		if (style === 'reverse-triangle') {
			return [
				polygon([
					[-length, 0],
					[0, -length / Math.sqrt(3)],
					[0, length / Math.sqrt(3)],
				]),
			];
		}
		if (style === 'diamond-arrow') {
			return [
				polygon([
					[0, 0],
					[-length / 2, length / 2],
					[-length, 0],
					[-length / 2, -length / 2],
				]),
			];
		}
		const d = half / Math.sqrt(2);
		return [
			polygon([
				[-length - d, -length + d],
				[-length + d, -length - d],
				[Math.SQRT2 * half, 0],
				[-length + d, length + d],
				[-length - d, length - d],
				[-Math.SQRT2 * half, 0],
			]),
		];
	});
}

/** The line stops inside a solid tip, so a thick butt end cannot protrude from its point.
 * Only a split parameter is sampled; the remaining body keeps the exact original cubic. */
function trimArrowStroke(contour: DesignPathContour, width: number, height: number, weight: number): DesignPathContour | undefined {
	if (contour.closed) {
		return contour;
	}
	const inset = (style: DesignEndpoint | undefined) => (style === 'triangle-arrow' || style === 'diamond-arrow' ? weight : style === 'circle-arrow' ? weight / 2 : 0);
	const start = inset(contour.nodes[0]?.endpoint),
		end = inset(contour.nodes.at(-1)?.endpoint);
	if (!start && !end) {
		return contour;
	}
	const distance = (a: DesignPoint, b: DesignPoint) => Math.hypot((a.x - b.x) * width, (a.y - b.y) * height);
	const trim = (contour: DesignPathContour, remaining: number): DesignPathContour | undefined => {
		if (!remaining) {
			return contour;
		}
		for (let i = 0; i < contour.nodes.length - 1; i++) {
			const a = contour.nodes[i],
				b = contour.nodes[i + 1],
				at = (t: number) => cubicBezierPoint(a, a.outgoing, b.incoming, b, t);
			let previous: DesignPoint = a;
			for (let step = 1; step <= 64; step++) {
				const current = at(step / 64),
					length = distance(previous, current);
				if (length > remaining) {
					let low = (step - 1) / 64,
						high = step / 64;
					for (let iteration = 0; iteration < 24; iteration++) {
						const middle = (low + high) / 2;
						if (distance(previous, at(middle)) < remaining) {
							low = middle;
						} else {
							high = middle;
						}
					}
					return {
						...contour,
						nodes: splitDesignPathSegment(contour, i, (low + high) / 2).nodes.slice(i + 1),
					};
				}
				remaining -= length;
				previous = current;
			}
		}
		return undefined;
	};
	const reverse = (contour: DesignPathContour): DesignPathContour => ({
		...contour,
		nodes: contour.nodes
			.slice()
			.reverse()
			.map(node => ({ ...node, incoming: node.outgoing, outgoing: node.incoming })),
	});
	const first = trim(contour, start);
	if (!first) {
		return undefined;
	}
	if (!end) {
		return first;
	}
	const last = trim(reverse(first), end);
	return last ? reverse(last) : undefined;
}
