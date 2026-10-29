import { designEndpointContours, designStrokeLayers } from '../common/model/designVectorStroke.js';
import { designVariableStrokeContours } from '../common/model/designVariableWidth.js';
import {
	designNetworkContours,
	designNetworkRegions,
	type DesignVectorNetwork,
} from '../common/model/designVectorNetwork.js';
import type { DesignVectorIntersection } from '../common/model/designVectorTopology.js';
import { localize } from '../../../../nls.js';
import type paper from 'paper';
import type { DesignShape } from '../common/model/document.js';
import {
	designPathData,
	designPathFillContours,
	designPathStrokeContours,
	designShapeContours,
	type DesignPathContour,
} from '../common/model/designVector.js';

let engine:
	| {
			scope: paper.PaperScope;
			offsetStroke: typeof import('paperjs-offset').offsetStroke;
			offset: typeof import('paperjs-offset').offset;
	  }
	| undefined;
let loading: Promise<void> | undefined;
const cache = new WeakMap<DesignShape, readonly DesignPathContour[]>();

/** Load the curve engine only for vector operations. No Paper items are retained in document state. */
export function loadDesignVectorGeometry(): Promise<void> {
	return (loading ??= Promise.all([import('paper'), import('paperjs-offset')])
		.then(([module, offset]) => {
			const scope = new module.default.PaperScope();
			new scope.Project(new scope.Size(1, 1));
			engine = { scope, offsetStroke: offset.offsetStroke, offset: offset.offset };
		})
		.catch(error => {
			loading = undefined;
			throw error;
		}));
}
export function isDesignVectorGeometryReady(): boolean {
	return !!engine;
}

/** Offset is baked only when the user confirms; callers can reuse these contours for a history-free preview. */
export function offsetDesignVector(
	shape: DesignShape,
	amount: number,
	join: 'miter' | 'round',
): readonly DesignPathContour[] {
	if (!engine) {
		return [];
	}
	const { scope, offset } = engine;
	scope.activate();
	let closed =
		shape.kind === 'path'
			? designPathFillContours(shape)
			: shape.kind === 'group'
				? getDesignVectorContours(shape)
				: designShapeContours(shape);
	let open: readonly DesignPathContour[] =
		shape.kind === 'path' ? designPathStrokeContours(shape).filter(contour => !contour.closed) : [];
	if (shape.kind === 'path' && shape.network) {
		const regions = designNetworkRegions(shape.network),
			boundaries = new Set(regions.flatMap(region => region.key.split(',')));
		// Region boundaries are offset with their fill; only loose branches need a separate open offset.
		open = designNetworkContours({
			...shape.network,
			edges: shape.network.edges.filter(edge => !boundaries.has(edge.id)),
		});
		if (!closed.length) {
			closed = designPathStrokeContours(shape)
				.filter(contour => contour.closed)
				.map(contour => ({ ...contour, fill: '#00000000' }));
		}
	}
	const colors = [...new Set(closed.map(contour => contour.fill ?? shape.fill))];
	const results: DesignPathContour[] = [];
	const append = (source: paper.PathItem, fill?: string): void => {
		const result = offset(source as paper.Path | paper.CompoundPath, amount, { insert: false, join, limit: 4 });
		const paths = result instanceof scope.CompoundPath ? (result.children as paper.Path[]) : [result as paper.Path];
		const point = (p: paper.Point) => ({ x: p.x / shape.width, y: p.y / shape.height });
		for (const path of paths) {
			if (path.segments.length < 2 || (path.closed && Math.abs(path.area) < 1e-7)) {
				continue;
			}
			results.push({
				closed: path.closed,
				...(fill && fill !== shape.fill ? { fill } : {}),
				nodes: path.segments.map(segment => ({
					...point(segment.point),
					incoming: point(segment.point.add(segment.handleIn)),
					outgoing: point(segment.point.add(segment.handleOut)),
				})),
			});
		}
		result.remove();
		source.remove();
	};
	try {
		const frame = { x: 0, y: 0, width: shape.width, height: shape.height };
		for (const color of colors) {
			const source = new scope.CompoundPath({
				pathData: designPathData(
					closed.filter(contour => (contour.fill ?? shape.fill) === color),
					frame,
				),
				fillRule: shape.kind === 'path' ? (shape.fillRule ?? 'nonzero') : 'nonzero',
				insert: false,
			});
			// Resolve winding and self-intersections first so positive offsets shrink holes and expand outer boundaries.
			const resolved = source.unite(source, { insert: false });
			source.remove();
			append(resolved, color);
		}
		for (const contour of open) {
			append(new scope.Path({ pathData: designPathData([contour], frame), insert: false }));
		}
		return results;
	} finally {
		scope.project.activeLayer.removeChildren();
	}
}

/** Each Paper child represents exactly one graph edge, including self-crossings and overlap endpoints. */
export function getDesignNetworkIntersections(
	network: DesignVectorNetwork,
	width: number,
	height: number,
): readonly DesignVectorIntersection[] {
	if (!engine) {
		return [];
	}
	const { scope } = engine;
	scope.activate();
	const source = new scope.CompoundPath({
		pathData: designPathData(designNetworkContours(network), { x: 0, y: 0, width, height }),
		insert: false,
	});
	try {
		return source.getIntersections(source).flatMap(hit => {
			const other = hit.intersection;
			if (!other || hit.time === null || other.time === null) {
				return [];
			}
			const first = { edge: hit.path.index, time: hit.time },
				second = { edge: other.path.index, time: other.time };
			const endpoint = (location: typeof first) =>
				location.time < 1e-8
					? network.edges[location.edge].start
					: location.time > 1 - 1e-8
						? network.edges[location.edge].end
						: undefined;
			const a = endpoint(first),
				b = endpoint(second);
			return a !== undefined && a === b ? [] : [{ first, second }];
		});
	} finally {
		source.remove();
	}
}

/** Results use the input's local box, so the renderer, flatten command and SVG export share cubic geometry. */
export function getDesignVectorContours(
	shape: DesignShape,
	strokeOnly = false,
	clip?: { x: number; y: number; width: number; height: number },
): readonly DesignPathContour[] {
	if (!engine) {
		return [];
	}
	const cached = !strokeOnly && !clip && cache.get(shape);
	if (cached) {
		return cached;
	}
	const { scope, offsetStroke } = engine;
	scope.activate();
	const project = scope.project;
	const empty = (): paper.PathItem => new scope.Path({ insert: false });
	const combine = (
		items: paper.PathItem[],
		operation: 'unite' | 'subtract' | 'intersect' | 'exclude',
	): paper.PathItem => {
		if (!items.length) {
			return empty();
		}
		let result = items[0];
		for (const item of items.slice(1)) {
			const next = result[operation](item, { insert: false });
			result.remove();
			item.remove();
			result = next;
		}
		return result;
	};
	const outline = (source: paper.PathItem, shape: Extract<DesignShape, { kind: 'path' }>): paper.PathItem => {
		if (!shape.strokeWidth) {
			return empty();
		}
		const variable = designVariableStrokeContours(shape);
		if (variable.length) {
			const ribbon = new scope.CompoundPath({
				pathData: designPathData(variable, shape),
				insert: false,
				fillRule: 'nonzero',
			});
			const resolved = ribbon.unite(ribbon, { insert: false });
			ribbon.remove();
			return resolved;
		}
		const paths = source instanceof scope.CompoundPath ? (source.children as paper.Path[]) : [source as paper.Path];
		const parts: paper.PathItem[] = [];
		for (const path of paths) {
			const strokes: paper.Path[] = [];
			const dash = shape.dashArray?.length
				? shape.dashArray.length % 2
					? [...shape.dashArray, ...shape.dashArray]
					: shape.dashArray
				: undefined;
			if (dash) {
				let distance = 0,
					index = 0;
				while (distance < path.length - 1e-8 && index < 10000) {
					const end = Math.min(path.length, distance + dash[index % dash.length]);
					if (index % 2 === 0 && end > distance) {
						let piece = path.clone({ insert: false });
						if (piece.closed) {
							piece.splitAt(0);
						}
						if (distance > 0) {
							const tail = piece.splitAt(distance);
							piece.remove();
							if (!tail) {
								break;
							}
							piece = tail;
						}
						// Splitting at a numerically equivalent endpoint can return the source itself. Keep that final dash intact.
						if (end - distance < piece.length - 1e-8) {
							piece.splitAt(end - distance)?.remove();
						}
						strokes.push(piece);
					}
					distance = end;
					index++;
				}
				if (distance < path.length - 1e-8) {
					throw new Error(
						localize(
							'sessions.design.vectorComplexDash',
							'Increase the dash lengths before outlining this path.',
						),
					);
				}
			} else {
				strokes.push(path.clone({ insert: false }));
			}
			if (
				path.closed &&
				strokes.length > 1 &&
				strokes.at(-1)!.lastSegment.point.getDistance(strokes[0].firstSegment.point) < 1e-7
			) {
				// A dash crossing the closing seam has one join, not two caps.
				const last = strokes.pop()!,
					first = strokes.shift()!;
				last.join(first, 1e-7);
				strokes.unshift(last);
			}
			for (const stroke of strokes) {
				if (stroke.length < 1e-8) {
					if (shape.dashArray?.length && shape.strokeCap === 'round' && stroke.firstSegment) {
						parts.push(
							new scope.Path.Circle({
								center: stroke.firstSegment.point,
								radius: shape.strokeWidth / 2,
								insert: false,
							}),
						);
					}
					stroke.remove();
					continue;
				}
				if (shape.dashArray?.length && shape.strokeCap === 'square' && !stroke.closed && stroke.length) {
					for (const [anchor, tangent] of [
						[stroke.firstSegment.point, stroke.getTangentAt(0).multiply(-1)],
						[stroke.lastSegment.point, stroke.getTangentAt(stroke.length)],
					] as const) {
						const along = tangent.multiply(shape.strokeWidth / 2),
							across = new scope.Point(-along.y, along.x);
						parts.push(
							new scope.Path({
								insert: false,
								closed: true,
								segments: [
									anchor.add(across),
									anchor.add(along).add(across),
									anchor.add(along).subtract(across),
									anchor.subtract(across),
								],
							}),
						);
					}
				}
				parts.push(
					offsetStroke(stroke, shape.strokeWidth / 2, {
						insert: false,
						limit: 4,
						join: shape.strokeJoin ?? 'miter',
						cap: shape.dashArray?.length && shape.strokeCap === 'round' ? 'round' : 'butt',
					}),
				);
				stroke.remove();
			}
		}
		return combine(parts, 'unite');
	};
	const geometry = (current: DesignShape, onlyStroke = false): paper.PathItem => {
		let result: paper.PathItem;
		if (current.visible === false) {
			return empty();
		}
		if (current.kind === 'group') {
			const operation = (
				{ union: 'unite', subtract: 'subtract', intersect: 'intersect', exclude: 'exclude' } as const
			)[current.booleanOperation ?? 'union'];
			result = combine(
				current.children.map(child => geometry(child)),
				operation,
			);
			result.scale(
				current.width / current.contentWidth,
				current.height / current.contentHeight,
				new scope.Point(0, 0),
			);
			result.translate(new scope.Point(current.x, current.y));
		} else {
			const contours = current.kind === 'path' ? designPathStrokeContours(current) : designShapeContours(current);
			const source = new scope.CompoundPath({
				pathData: designPathData(contours, current),
				insert: false,
				fillRule: current.kind === 'path' ? (current.fillRule ?? 'nonzero') : 'nonzero',
			});
			const fill = new scope.CompoundPath({
				pathData: designPathData(
					current.kind === 'path'
						? designPathFillContours(current)
						: contours.filter(contour => contour.closed),
					current,
				),
				insert: false,
				fillRule: source.fillRule,
			});
			if (current.kind === 'path' && current.strokeWidth) {
				const strokes = designStrokeLayers(current).map(layer => {
					const boundary = new scope.CompoundPath({
						pathData: designPathData(layer.contours, current),
						insert: false,
						fillRule: current.fillRule ?? 'nonzero',
					});
					let stroke = outline(boundary, { ...current, strokeWidth: layer.width });
					if (layer.alignment !== 'center') {
						const clipped =
							layer.alignment === 'inside'
								? stroke.intersect(boundary, { insert: false })
								: stroke.subtract(boundary, { insert: false });
						stroke.remove();
						stroke = clipped;
					}
					boundary.remove();
					return stroke;
				});
				const ends = designEndpointContours(current);
				if (ends.length) {
					strokes.push(
						new scope.CompoundPath({
							pathData: designPathData(ends, current),
							insert: false,
							fillRule: 'nonzero',
						}),
					);
				}
				const stroke = combine(strokes, 'unite');
				result = onlyStroke ? stroke : combine([fill, stroke], 'unite');
				if (onlyStroke) {
					fill.remove();
				}
			} else {
				result = onlyStroke ? empty() : fill;
			}
			source.remove();
		}
		result.rotate(current.rotation, new scope.Point(current.x + current.width / 2, current.y + current.height / 2));
		return result;
	};
	try {
		// Root placement stays on the saved layer. Descendant transforms are baked into its contours.
		let result = geometry({ ...shape, x: 0, y: 0, rotation: 0 }, strokeOnly);
		if (clip) {
			const rectangle = new scope.Path.Rectangle({
				rectangle: new scope.Rectangle(clip.x, clip.y, clip.width, clip.height),
				insert: false,
			});
			const clipped = result.intersect(rectangle, { insert: false });
			result.remove();
			rectangle.remove();
			result = clipped;
		}
		const paths = result instanceof scope.CompoundPath ? (result.children as paper.Path[]) : [result as paper.Path];
		const point = (p: paper.Point) => ({ x: p.x / shape.width, y: p.y / shape.height });
		const contours = paths
			.filter(path => path.segments.length >= 2)
			.map(path => ({
				closed: path.closed,
				nodes: path.segments.map(segment => ({
					...point(segment.point),
					incoming: point(segment.point.add(segment.handleIn)),
					outgoing: point(segment.point.add(segment.handleOut)),
				})),
			}));
		result.remove();
		if (!strokeOnly && !clip) {
			cache.set(shape, contours);
		}
		return contours;
	} finally {
		// Some offset algorithms create temporary inserted paths. Clear them after every operation.
		project.activeLayer.removeChildren();
	}
}
