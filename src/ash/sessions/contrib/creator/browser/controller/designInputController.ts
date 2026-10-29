import { designGradientPosition, designPaints, sampleDesignPaint } from '../../common/model/designPaint.js';
import { designEffects } from '../../common/model/designEffects.js';
import {
	designWidthPointAt,
	designWidthLocation,
	nearestDesignWidthLocation,
	snapDesignWidthPosition,
	supportsDesignVariableWidth,
} from '../../common/model/designVariableWidth.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import {
	connectDesignNetwork,
	designNetworkRegionAt,
	moveDesignNetworkVertices,
	moveDesignNetworkHandle,
	paintDesignNetworkFromPath,
	splitDesignNetworkEdge,
	toDesignVectorNetwork,
	withDesignVectorNetwork,
} from '../../common/model/designVectorNetwork.js';
import {
	getDesignNetworkIntersections,
	getDesignVectorContours,
	isDesignVectorGeometryReady,
	loadDesignVectorGeometry,
} from '../designVectorGeometry.js';
import { intersectDesignNetwork, mergeDesignNetworkVertices } from '../../common/model/designVectorTopology.js';
import { status } from '../../../../../base/browser/ui/aria/aria.js';
import { localize } from '../../../../../nls.js';
import {
	designPathContours,
	designPathEditingContours,
	nearestDesignPathSegment,
	moveDesignPathNode,
	withDesignPathContours,
} from '../../common/model/designVector.js';
import { addDisposableListener } from '../../../../../base/browser/dom.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import {
	CanvasInputController,
	CanvasPointerAction,
	type CanvasInputParticipant,
	type CanvasPointerInput,
} from '../../../canvas/browser/canvasInputController.js';
import type { CanvasViewport } from '../../../canvas/common/canvasViewport.js';
import type { DesignDocumentController } from '../designDocumentController.js';
import type { DocumentCommands } from '../../common/commands/documentCommands.js';
import { cubicBezierPoint, toDesignLocal, type DesignPoint } from '../../common/core/geometry.js';
import type { DesignShape } from '../../common/model/document.js';
import { getDesignShapeEntries, hitTestDesignShapes } from '../../common/model/hitTest.js';
import type { DesignSelection } from '../../common/selection.js';
import { DesignMode, DesignTool } from '../../common/config/editorConfiguration.js';
import type { DesignDrawingParticipant } from '../designEditorBrowser.js';

type PathHandle = {
	readonly edge?: number;
	readonly contourIndex: number;
	readonly nodeIndex: number;
	readonly point: 'anchor' | 'incoming' | 'outgoing';
};
interface ShapeGesture {
	readonly start: DesignPoint;
	readonly shapes: readonly DesignShape[];
	readonly handle?: PathHandle;
	readonly gradientHandle?: { paintId: string; index?: number; stopId?: string };
	readonly blurHandle?: { effectId: string; point: 'start' | 'end' | 'axis'; origin: DesignPoint };
	readonly widthHandle?: { id: string; point: 'center' | 'edge' };
	readonly marquee?: boolean;
	readonly penVertex?: number;
	readonly connectionSource?: Extract<DesignShape, { kind: 'path' }>;
	mergeTarget?: number;
	preview: readonly DesignShape[];
}

interface InputHost {
	readonly viewport: HTMLElement;
	readonly domNode: HTMLElement;
	getTool(): DesignTool;
	getMode(): DesignMode;
	getShapesForHitTesting(): readonly DesignShape[];
	render(): void;
	applyTransform(): void;
	selectionChanged(): void;
	editText(id: string): void;
	finishText(): void;
}

/** Design owns hit targets and edits; shared canvas input owns coordinates and capture. */
export class DesignInputController extends Disposable implements CanvasInputParticipant {
	private gesture: ShapeGesture | undefined;
	private isDrawing = false;
	private penVertex: { id: string; index: number } | undefined;
	private connecting = false;
	public selectionRect: { x: number; y: number; width: number; height: number } | undefined;
	private readonly input: CanvasInputController;

	constructor(
		private readonly host: InputHost,
		private readonly documentController: DesignDocumentController,
		private readonly commands: DocumentCommands,
		private readonly selection: DesignSelection,
		private readonly camera: CanvasViewport,
		private readonly drawing: DesignDrawingParticipant,
	) {
		super();
		this.input = this._register(
			new CanvasInputController(
				{
					domNode: host.viewport,
					focus: () => host.domNode.focus(),
					applyTransform: () => host.applyTransform(),
				},
				camera,
				this,
			),
		);
		this._register(
			addDisposableListener(host.viewport, 'contextmenu', event => {
				// macOS reports Control-click as a secondary click. In the width tool it means insertion without snapping.
				const path = this.selectedShape;
				if (
					!event.ctrlKey ||
					!this.selection.editingWidth ||
					path?.kind !== 'path' ||
					!path.strokeWidth ||
					!supportsDesignVariableWidth(path) ||
					this.documentController.isBusy ||
					this.commands.components.isInstanceChild(path.id)
				) {
					return;
				}
				event.preventDefault();
				event.stopPropagation();
				const rect = host.viewport.getBoundingClientRect(),
					placed = getDesignShapeEntries(this.documentController.model.value.shapes).find(
						entry => entry.shape.id === path.id,
					)!.world;
				const local = toDesignLocal(
						placed,
						camera.toWorld({ x: event.clientX - rect.left, y: event.clientY - rect.top }),
					),
					scale = placed.width / path.width;
				const nearest = nearestDesignWidthLocation(
					path,
					{ x: local.x / scale, y: local.y / scale },
					8 / camera.scale / scale,
				);
				if (!nearest || (path.widthPoints?.length ?? 0) >= 1000) {
					return;
				}
				const existing = path.widthPoints?.find(
					point => point.contour === nearest.contour && Math.abs(point.position - nearest.position) < 1e-6,
				);
				const point = existing ?? {
					id: generateUuid(),
					...nearest,
					...designWidthPointAt(path, nearest.contour, nearest.position),
				};
				if (!existing) {
					this.commands.vector.update({ ...path, widthPoints: [...(path.widthPoints ?? []), point] });
				}
				this.selection.selectWidth(point.id);
				host.domNode.focus();
				host.render();
			}),
		);
		this._register(
			addDisposableListener(host.viewport, 'dblclick', event => {
				if (this.drawing.complete()) {
					event.preventDefault();
					return;
				}
				const rect = host.viewport.getBoundingClientRect();
				const shape = hitTestDesignShapes(
					host.getShapesForHitTesting(),
					camera.toWorld({ x: event.clientX - rect.left, y: event.clientY - rect.top }),
					true,
				);
				if (shape?.kind === 'text') {
					event.preventDefault();
					host.editText(shape.id);
				} else if (shape?.kind === 'path' && !commands.components.isInstanceChild(shape.id)) {
					this.select([shape.id]);
					selection.editingVector = true;
					host.render();
					event.preventDefault();
				}
			}),
		);
		this._register(
			addDisposableListener(host.domNode, 'keydown', (event: KeyboardEvent) => {
				if (event.target === host.domNode && this.penVertex && ['Escape', 'Enter'].includes(event.key)) {
					this.penVertex = undefined;
					event.preventDefault();
					event.stopImmediatePropagation();
					return;
				}
				if (event.target !== host.domNode || !this.drawing.preview) {
					return;
				}
				if (event.key === 'Escape') {
					if (!this.drawing.complete()) {
						this.cancelGesture();
					}
					event.preventDefault();
				} else if (event.key === 'Enter' && this.drawing.complete()) {
					event.preventDefault();
				}
			}),
		);
	}

	public get isGesturing(): boolean {
		return this.input.isGesturing;
	}
	public get preview(): readonly DesignShape[] {
		return this.gesture?.preview ?? [];
	}
	private get selectedShapes(): readonly DesignShape[] {
		return getDesignShapeEntries(this.documentController.model.value.shapes)
			.filter(
				entry =>
					this.selection.ids.has(entry.shape.id) && !entry.ancestors.some(id => this.selection.ids.has(id)),
			)
			.map(entry => entry.shape);
	}
	private get selectedShape(): DesignShape | undefined {
		return this.selection.ids.size === 1 ? this.selectedShapes[0] : undefined;
	}
	private select(ids: readonly string[]): void {
		this.selection.set(ids);
		this.host.selectionChanged();
	}
	public canNavigate(): boolean {
		return !this.drawing.preview;
	}
	private async commitConnection(
		before: Extract<DesignShape, { kind: 'path' }>,
		after: Extract<DesignShape, { kind: 'path' }>,
		selected: number,
	): Promise<void> {
		const version = this.documentController.model.version;
		this.connecting = true;
		try {
			await loadDesignVectorGeometry();
			if (
				this.isDisposed ||
				version !== this.documentController.model.version ||
				this.selectedShape?.id !== before.id
			) {
				return;
			}
			const network = after.network!,
				result = intersectDesignNetwork(
					network,
					getDesignNetworkIntersections(network, after.width, after.height),
					toDesignVectorNetwork(before),
				);
			const continuation = this.penVertex;
			this.commands.vector.update(withDesignVectorNetwork(after, result.network));
			this.selection.selectNode(0, result.vertices.get(selected) ?? selected);
			if (continuation?.id === after.id) {
				this.penVertex = { id: after.id, index: result.vertices.get(continuation.index) ?? continuation.index };
			}
			this.host.render();
		} catch (error) {
			if (!this.isDisposed) {
				status(localize('sessions.design.vectorFailed', 'Could not calculate the vector: {0}', String(error)));
			}
		} finally {
			this.connecting = false;
		}
	}
	private async insertAtCrossing(
		path: Extract<DesignShape, { kind: 'path' }>,
		anchor: DesignPoint,
		tolerance: number,
		nearest: { contour: number; segment: number; t: number },
	): Promise<void> {
		const version = this.documentController.model.version;
		try {
			await loadDesignVectorGeometry();
			if (
				this.isDisposed ||
				version !== this.documentController.model.version ||
				this.selectedShape?.id !== path.id ||
				!this.selection.editingVector ||
				this.host.getTool() !== DesignTool.Pen
			) {
				return;
			}
			const network = toDesignVectorNetwork(path),
				hits = getDesignNetworkIntersections(network, path.width, path.height)
					.map(hit => {
						const edge = network.edges[hit.first.edge],
							point = cubicBezierPoint(
								network.vertices[edge.start],
								edge.outgoing,
								edge.incoming,
								network.vertices[edge.end],
								hit.first.time,
							);
						return {
							hit,
							point,
							distance: Math.hypot((point.x - anchor.x) * path.width, (point.y - anchor.y) * path.height),
						};
					})
					.filter(hit => hit.distance <= tolerance)
					.sort((a, b) => a.distance - b.distance);
			if (hits.length) {
				const point = hits[0].point,
					result = intersectDesignNetwork(
						network,
						hits
							.filter(
								hit =>
									Math.hypot(
										(hit.point.x - point.x) * path.width,
										(hit.point.y - point.y) * path.height,
									) < 1e-5,
							)
							.map(hit => hit.hit),
					);
				this.commands.vector.update(
					withDesignVectorNetwork(
						path,
						path.network ? result.network : paintDesignNetworkFromPath(path, result.network),
					),
				);
				this.selection.selectNode(
					0,
					result.network.vertices.findIndex(
						vertex =>
							Math.hypot((vertex.x - point.x) * path.width, (vertex.y - point.y) * path.height) < 1e-5,
					),
				);
				status(localize('sessions.design.networkIntersectionInserted', 'Inserted a shared intersection node.'));
			} else {
				this.selection.selectNode(
					path.network ? 0 : nearest.contour,
					path.network ? network.vertices.length : nearest.segment + 1,
				);
				this.commands.vector.insertNode(path, nearest.contour, nearest.segment, nearest.t);
			}
			this.host.render();
		} catch (error) {
			if (!this.isDisposed) {
				status(localize('sessions.design.vectorFailed', 'Could not calculate the vector: {0}', String(error)));
			}
		}
	}

	public begin(input: CanvasPointerInput): CanvasPointerAction {
		if (this.host.getMode() === DesignMode.Code || this.documentController.isBusy || this.connecting) {
			return CanvasPointerAction.None;
		}
		const { event, point, world } = input;
		this.host.finishText();
		if (
			event.button === 0 &&
			this.selection.editingBlur &&
			this.selectedShape &&
			!this.commands.components.isInstanceChild(this.selectedShape.id)
		) {
			const shape = this.selectedShape;
			const effect = designEffects(shape).find(effect => effect.id === this.selection.effectId);
			const handle = (event.target as Element | null)
				?.closest?.('[data-blur-handle]')
				?.getAttribute('data-blur-handle');
			if (
				effect &&
				'progressive' in effect &&
				effect.progressive &&
				(handle === 'start' || handle === 'end' || handle === 'axis')
			) {
				const placed = getDesignShapeEntries(this.documentController.model.value.shapes).find(
					entry => entry.shape.id === shape.id,
				)!.world;
				const local = toDesignLocal(placed, world);
				if (handle !== 'axis') {
					this.selection.blurHandle = handle;
				}
				this.gesture = {
					start: point,
					shapes: [shape],
					preview: [shape],
					blurHandle: {
						effectId: effect.id,
						point: handle,
						origin: { x: local.x / placed.width, y: local.y / placed.height },
					},
				};
				this.host.render();
				return CanvasPointerAction.Edit;
			}
		}
		if (
			event.button === 0 &&
			this.selection.editingGradient &&
			this.selectedShape &&
			!this.commands.components.isInstanceChild(this.selectedShape.id)
		) {
			const shape = this.selectedShape,
				paints = designPaints(shape),
				paint = paints.find(paint => paint.id === this.selection.paintId) ?? paints[0],
				target = event.target as Element | null;
			const handle = target?.closest?.('[data-gradient-handle]')?.getAttribute('data-gradient-handle'),
				stopId = target?.closest?.('[data-gradient-stop]')?.getAttribute('data-gradient-stop');
			if (paint && paint.type !== 'solid' && ((handle !== null && handle !== undefined) || stopId)) {
				this.selection.paintId = paint.id;
				if (stopId) {
					this.selection.gradientStopId = stopId;
				}
				this.gesture = {
					start: point,
					shapes: [shape],
					preview: [shape],
					gradientHandle: { paintId: paint.id, ...(stopId ? { stopId } : { index: Number(handle) }) },
				};
				this.host.render();
				return CanvasPointerAction.Edit;
			}
			if (paint && paint.type !== 'solid' && target?.closest?.('[data-gradient-axis]')) {
				const placed = getDesignShapeEntries(this.documentController.model.value.shapes).find(
						entry => entry.shape.id === shape.id,
					)!.world,
					local = toDesignLocal(placed, world);
				const position = Math.max(
						0,
						Math.min(
							1,
							designGradientPosition(paint, { x: local.x / placed.width, y: local.y / placed.height }),
						),
					),
					color =
						'#' +
						sampleDesignPaint(paint, position)
							.map(channel => Math.round(channel).toString(16).padStart(2, '0'))
							.join('');
				if (paint.stops.length >= 256) {
					return CanvasPointerAction.Handled;
				}
				const stop = { id: generateUuid(), position, color },
					next = {
						...shape,
						fills: paints.map(value =>
							value.id === paint.id
								? { ...paint, stops: [...paint.stops, stop].sort((a, b) => a.position - b.position) }
								: value,
						),
					};
				this.selection.paintId = paint.id;
				this.selection.gradientStopId = stop.id;
				this.gesture = {
					start: point,
					shapes: [next],
					preview: [next],
					gradientHandle: { paintId: paint.id, stopId: stop.id },
				};
				this.host.render();
				return CanvasPointerAction.Edit;
			}
		}

		if (this.host.getTool() === DesignTool.Text && event.button === 0) {
			const text = hitTestDesignShapes(this.host.getShapesForHitTesting(), world, true);
			if (text?.kind === 'text') {
				this.host.editText(text.id);
				return CanvasPointerAction.Handled;
			}
		}
		if (
			event.button === 0 &&
			this.selection.editingWidth &&
			this.selectedShape?.kind === 'path' &&
			this.selectedShape.strokeWidth > 0 &&
			supportsDesignVariableWidth(this.selectedShape) &&
			!this.commands.components.isInstanceChild(this.selectedShape.id)
		) {
			const path = this.selectedShape,
				placed = getDesignShapeEntries(this.documentController.model.value.shapes).find(
					entry => entry.shape.id === path.id,
				)!.world;
			const local = toDesignLocal(placed, world),
				scale = placed.width / path.width,
				target = event.target as Element;
			const id = target.getAttribute('data-width-point'),
				handle = target.getAttribute('data-width-handle');
			if (id && path.widthPoints?.some(point => point.id === id)) {
				if (event.shiftKey || !this.selection.widthPointIds.has(id)) {
					this.selection.selectWidth(id, event.shiftKey);
				}
				if (event.shiftKey) {
					this.host.render();
					return CanvasPointerAction.Handled;
				}
				this.gesture = {
					start: point,
					shapes: [path],
					preview: [path],
					widthHandle: { id, point: handle === 'center' ? 'center' : 'edge' },
				};
				return CanvasPointerAction.Edit;
			}
			const nearest = nearestDesignWidthLocation(
				path,
				{ x: local.x / scale, y: local.y / scale },
				8 / this.camera.scale / scale,
			);
			if (nearest && (path.widthPoints?.length ?? 0) < 1000) {
				const position = event.ctrlKey
					? nearest.position
					: snapDesignWidthPosition(path, nearest.contour, nearest.position, 8 / this.camera.scale / scale);
				const existing = path.widthPoints?.find(
					point => point.contour === nearest.contour && Math.abs(point.position - position) < 1e-6,
				);
				const widthPoint = existing ?? {
					id: generateUuid(),
					contour: nearest.contour,
					position,
					...designWidthPointAt(path, nearest.contour, position),
				};
				const next = existing ? path : { ...path, widthPoints: [...(path.widthPoints ?? []), widthPoint] };
				this.selection.selectWidth(widthPoint.id);
				this.gesture = {
					start: point,
					shapes: [next],
					preview: [next],
					widthHandle: { id: widthPoint.id, point: 'edge' },
				};
				this.host.render();
				return CanvasPointerAction.Edit;
			}
			return CanvasPointerAction.Handled;
		}
		if (
			event.button === 0 &&
			this.host.getTool() === DesignTool.Pen &&
			!this.selection.paintingVector &&
			this.selection.editingVector &&
			this.selectedShape?.kind === 'path' &&
			!this.commands.components.isInstanceChild(this.selectedShape.id)
		) {
			const path = this.selectedShape,
				placed = getDesignShapeEntries(this.documentController.model.value.shapes).find(
					entry => entry.shape.id === path.id,
				)!.world;
			const local = toDesignLocal(placed, world),
				scale = placed.width / path.width;
			const anchor = { x: local.x / placed.width, y: local.y / placed.height };
			let network = toDesignVectorNetwork(path);
			const tolerance = 8 / this.camera.scale;
			const vertex = network.vertices.findIndex(
				point =>
					Math.hypot((point.x - anchor.x) * placed.width, (point.y - anchor.y) * placed.height) <= tolerance,
			);
			const active =
				this.penVertex?.id === path.id && this.penVertex.index < network.vertices.length
					? this.penVertex.index
					: undefined;
			const nearest =
				vertex < 0
					? nearestDesignPathSegment(path, { x: local.x / scale, y: local.y / scale }, tolerance / scale)
					: undefined;
			if (vertex >= 0) {
				if (active !== undefined && active !== vertex) {
					void this.commitConnection(
						path,
						withDesignVectorNetwork(path, connectDesignNetwork(network, active, vertex)),
						vertex,
					);
					this.penVertex = undefined;
				} else {
					this.penVertex = { id: path.id, index: vertex };
				}
				// Selecting a junction alone does not convert the document or create an undo step.
				if (path.network) {
					this.selection.selectNode(0, vertex);
				}
			} else if (nearest && active === undefined) {
				void this.insertAtCrossing(path, anchor, tolerance / scale, nearest);
			} else {
				let start = active;
				if (start === undefined) {
					start = path.network
						? this.selection.nodeIndex
						: designPathContours(path)
								.slice(0, this.selection.contourIndex)
								.reduce((sum, contour) => sum + contour.nodes.length, 0) + this.selection.nodeIndex;
				}
				let end: number | DesignPoint = anchor;
				if (nearest) {
					const edge = path.network
						? nearest.contour
						: designPathContours(path)
								.slice(0, nearest.contour)
								.reduce((sum, contour) => sum + contour.nodes.length - (contour.closed ? 0 : 1), 0) +
							nearest.segment;
					end = network.vertices.length;
					network = splitDesignNetworkEdge(network, edge, nearest.t);
				}
				network = connectDesignNetwork(network, start, end);
				const next = typeof end === 'number' ? end : network.vertices.length - 1;
				this.penVertex = nearest ? undefined : { id: path.id, index: next };
				const nextPath = withDesignVectorNetwork(path, network);
				if (typeof end !== 'number') {
					this.gesture = {
						start: point,
						shapes: [nextPath],
						preview: [nextPath],
						handle: { contourIndex: 0, nodeIndex: next, point: 'incoming', edge: network.edges.length - 1 },
						penVertex: next,
						connectionSource: path,
					};
					this.host.render();
					return CanvasPointerAction.Edit;
				}
				void this.commitConnection(path, nextPath, next);
			}
			this.host.render();
			return CanvasPointerAction.Handled;
		}
		if (
			event.button === 0 &&
			!this.selection.paintingVector &&
			this.drawing.begin(world, { shift: event.shiftKey, alt: event.altKey, tolerance: 8 / this.camera.scale })
		) {
			this.isDrawing = this.drawing.preview !== undefined;
			return this.isDrawing ? CanvasPointerAction.Edit : CanvasPointerAction.Handled;
		}
		const target = event.target as Element;
		const path = this.selectedShape;
		if (
			event.button === 0 &&
			(event.altKey || this.selection.paintingVector) &&
			this.selection.editingVector &&
			path?.kind === 'path' &&
			path.network &&
			!this.commands.components.isInstanceChild(path.id)
		) {
			const placed = getDesignShapeEntries(this.documentController.model.value.shapes).find(
				entry => entry.shape.id === path.id,
			)!.world;
			const local = toDesignLocal(placed, world),
				region = designNetworkRegionAt(path.network, { x: local.x / placed.width, y: local.y / placed.height });
			if (region && !target.classList.contains('ash-sessions-design-path-handle')) {
				const unfilledRegions = new Set(path.network.unfilledRegions);
				if (region.filled) {
					unfilledRegions.add(region.key);
				} else {
					unfilledRegions.delete(region.key);
				}
				this.commands.vector.update(
					withDesignVectorNetwork(path, { ...path.network, unfilledRegions: [...unfilledRegions] }),
				);
				return CanvasPointerAction.Handled;
			}
		}
		if (
			this.host.getMode() !== DesignMode.Motion &&
			this.host.getTool() === DesignTool.Select &&
			event.button === 0 &&
			target.classList.contains('ash-sessions-design-path-handle') &&
			path?.kind === 'path' &&
			!this.commands.components.isInstanceChild(path.id)
		) {
			const handle: PathHandle = {
				contourIndex: Number(target.getAttribute('data-path-contour') ?? 0),
				nodeIndex: Number(target.getAttribute('data-path-node')),
				point: target.getAttribute('data-path-point') as PathHandle['point'],
				edge: target.hasAttribute('data-network-edge')
					? Number(target.getAttribute('data-network-edge'))
					: undefined,
			};
			if (
				event.shiftKey ||
				!this.selection.nodeIndices.has(handle.nodeIndex) ||
				this.selection.contourIndex !== handle.contourIndex
			) {
				this.selection.selectNode(handle.contourIndex, handle.nodeIndex, event.shiftKey);
			}
			this.selection.editingVector = true;
			if (event.shiftKey) {
				this.host.render();
				return CanvasPointerAction.Handled;
			}
			this.gesture = { start: point, shapes: [path], preview: [path], handle };
			this.host.render();
			return CanvasPointerAction.Move;
		}
		const shape =
			event.button === 1 || this.host.getTool() === DesignTool.Hand
				? undefined
				: hitTestDesignShapes(
						this.host.getShapesForHitTesting(),
						world,
						event.ctrlKey || event.metaKey,
						isDesignVectorGeometryReady() ? getDesignVectorContours : undefined,
					);
		if (this.host.getMode() === DesignMode.Motion && shape) {
			this.select([shape.id]);
			this.host.render();
			return CanvasPointerAction.Handled;
		}
		if (
			event.button === 0 &&
			this.host.getTool() === DesignTool.Select &&
			this.selection.editingVector &&
			path?.kind === 'path' &&
			(!shape || shape.id === path.id) &&
			!this.commands.components.isInstanceChild(path.id)
		) {
			this.gesture = { start: world, shapes: [path], preview: [path], marquee: true };
			return CanvasPointerAction.Edit;
		}
		if (event.button === 0 && this.host.getTool() !== DesignTool.Hand) {
			if (event.shiftKey && shape) {
				this.selection.toggle(shape.id);
				this.host.selectionChanged();
				this.host.render();
				return CanvasPointerAction.Handled;
			}
			if (!shape || !this.selection.ids.has(shape.id)) {
				this.select(shape ? [shape.id] : []);
			}
		}
		if (shape) {
			const shapes = this.selectedShapes.filter(shape => !this.commands.components.isInstanceChild(shape.id));
			if (!shapes.length) {
				this.host.render();
				return CanvasPointerAction.Handled;
			}
			this.gesture = { start: point, shapes, preview: shapes };
		}
		this.host.render();
		return shape ? CanvasPointerAction.Move : CanvasPointerAction.Pan;
	}

	public update(input: CanvasPointerInput): void {
		if (this.isDrawing) {
			this.drawing.update(input.world, { shift: input.event.shiftKey, alt: input.event.altKey });
			return;
		}
		const gesture = this.gesture!;
		const path = gesture.shapes[0];
		if (gesture.blurHandle) {
			const handle = gesture.blurHandle,
				effects = designEffects(path);
			const effect = effects.find(effect => effect.id === handle.effectId);
			if (!effect || !('progressive' in effect) || !effect.progressive) {
				return;
			}
			const placed = getDesignShapeEntries(this.documentController.model.value.shapes).find(
				entry => entry.shape.id === path.id,
			)!.world;
			const local = toDesignLocal(placed, input.world);
			const delta = { x: local.x / placed.width - handle.origin.x, y: local.y / placed.height - handle.origin.y };
			const progressive = { ...effect.progressive };
			for (const key of ['start', 'end'] as const) {
				if (handle.point === key || handle.point === 'axis') {
					progressive[key] = { x: progressive[key].x + delta.x, y: progressive[key].y + delta.y };
				}
			}
			if (input.event.shiftKey && handle.point !== 'axis') {
				const fixed = progressive[handle.point === 'start' ? 'end' : 'start'],
					moving = progressive[handle.point];
				const dx = (moving.x - fixed.x) * placed.width,
					dy = (moving.y - fixed.y) * placed.height;
				const distance = Math.hypot(dx, dy),
					angle = (Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * Math.PI) / 4;
				progressive[handle.point] = {
					x: fixed.x + (Math.cos(angle) * distance) / placed.width,
					y: fixed.y + (Math.sin(angle) * distance) / placed.height,
				};
			}
			gesture.preview = [
				{
					...path,
					effects: effects.map(value => (value.id === effect.id ? { ...effect, progressive } : value)),
				},
			];
			this.host.render();
			return;
		}
		if (gesture.gradientHandle) {
			const handle = gesture.gradientHandle,
				paints = designPaints(path),
				paint = paints.find(paint => paint.id === handle.paintId);
			if (!paint || paint.type === 'solid') {
				return;
			}
			const placed = getDesignShapeEntries(this.documentController.model.value.shapes).find(
					entry => entry.shape.id === path.id,
				)!.world,
				local = toDesignLocal(placed, input.world),
				position = { x: local.x / placed.width, y: local.y / placed.height };
			let next = paint;
			if (handle.stopId) {
				const fraction = Math.max(0, Math.min(1, designGradientPosition(paint, position))),
					snapped = input.event.ctrlKey ? fraction : Math.round(fraction * 100) / 100;
				next = {
					...paint,
					stops: paint.stops
						.map(stop => (stop.id === handle.stopId ? { ...stop, position: snapped } : stop))
						.sort((a, b) => a.position - b.position),
				};
			} else {
				const index = handle.index!,
					origin = paint.handles[0];
				if (input.event.shiftKey && index !== 0) {
					const dx = (position.x - origin.x) * placed.width,
						dy = (position.y - origin.y) * placed.height,
						length = Math.hypot(dx, dy),
						angle = (Math.round(Math.atan2(dy, dx) / (Math.PI / 12)) * Math.PI) / 12;
					position.x = origin.x + (Math.cos(angle) * length) / placed.width;
					position.y = origin.y + (Math.sin(angle) * length) / placed.height;
				}
				const handles = paint.handles.map((point, i) =>
					index === 0
						? { x: point.x + position.x - origin.x, y: point.y + position.y - origin.y }
						: i === index
							? position
							: point,
				) as unknown as typeof paint.handles;
				const [a, b, c] = handles;
				if (
					Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) < 1e-8 ||
					handles.some(p => Math.abs(p.x) > 10000 || Math.abs(p.y) > 10000)
				) {
					return;
				}
				next = { ...paint, handles };
			}
			gesture.preview = [{ ...path, fills: paints.map(value => (value.id === paint.id ? next : value)) }];
			this.host.render();
			return;
		}

		if (gesture.widthHandle && path.kind === 'path') {
			const placed = getDesignShapeEntries(this.documentController.model.value.shapes).find(
				entry => entry.shape.id === path.id,
			)!.world;
			const local = toDesignLocal(placed, input.world),
				scale = placed.width / path.width;
			const point = { x: local.x / scale, y: local.y / scale },
				active = path.widthPoints!.find(point => point.id === gesture.widthHandle!.id)!;
			const location = designWidthLocation(path, active.contour, active.position)!;
			let deltaPosition = 0,
				deltaWidth = 0;
			if (gesture.widthHandle.point === 'center') {
				const nearest = nearestDesignWidthLocation(path, point);
				if (!nearest || nearest.contour !== active.contour) {
					return;
				}
				const position = input.event.ctrlKey
					? nearest.position
					: snapDesignWidthPosition(path, active.contour, nearest.position, 8 / this.camera.scale / scale);
				deltaPosition = position - active.position;
			} else {
				let width =
					Math.abs(
						(point.x - location.point.x) * location.normal.x +
							(point.y - location.point.y) * location.normal.y,
					) * 2;
				if (!input.event.ctrlKey) {
					width = Math.round(width);
				}
				deltaWidth = width / path.strokeWidth - active.width;
			}
			gesture.preview = [
				{
					...path,
					widthPoints: path.widthPoints!.map(point =>
						this.selection.widthPointIds.has(point.id)
							? {
									...point,
									position: Math.max(0, Math.min(1, point.position + deltaPosition)),
									width: Math.max(0, Math.min(10000, point.width + deltaWidth)),
									slope: deltaPosition || deltaWidth ? 0 : (point.slope ?? 0),
								}
							: point,
					),
				},
			];
		} else if (gesture.marquee && path.kind === 'path') {
			const placed = getDesignShapeEntries(this.documentController.model.value.shapes).find(
				entry => entry.shape.id === path.id,
			)!.world;
			const x = Math.min(gesture.start.x, input.world.x),
				y = Math.min(gesture.start.y, input.world.y),
				width = Math.abs(input.world.x - gesture.start.x),
				height = Math.abs(input.world.y - gesture.start.y);
			this.selectionRect = { x, y, width, height };
			this.selection.nodeIndices.clear();
			const angle = (placed.rotation * Math.PI) / 180;
			for (const [index, node] of designPathEditingContours(path)[this.selection.contourIndex]?.nodes.entries() ??
				[]) {
				const dx = (node.x - 0.5) * placed.width,
					dy = (node.y - 0.5) * placed.height;
				const px = placed.x + placed.width / 2 + dx * Math.cos(angle) - dy * Math.sin(angle),
					py = placed.y + placed.height / 2 + dx * Math.sin(angle) + dy * Math.cos(angle);
				if (px >= x && px <= x + width && py >= y && py <= y + height) {
					this.selection.nodeIndices.add(index);
				}
			}
		} else if (gesture.handle && path.kind === 'path') {
			const placed = getDesignShapeEntries(this.documentController.model.value.shapes).find(
				entry => entry.shape.id === path.id,
			)!.world;
			const local = toDesignLocal(placed, input.world);
			let position = { x: local.x / placed.width, y: local.y / placed.height };
			const handle = gesture.handle,
				contours = designPathEditingContours(path),
				contour = contours[handle.contourIndex],
				anchor = contour.nodes[handle.nodeIndex];
			gesture.mergeTarget = undefined;
			if (handle.point === 'anchor' && this.selection.nodeIndices.size === 1 && !input.event.altKey) {
				const network = toDesignVectorNetwork(path),
					offset = path.network
						? 0
						: contours
								.slice(0, handle.contourIndex)
								.reduce((sum, contour) => sum + contour.nodes.length, 0);
				const target = network.vertices
					.map((vertex, index) => ({
						vertex,
						index,
						distance: Math.hypot(
							(vertex.x - position.x) * placed.width,
							(vertex.y - position.y) * placed.height,
						),
					}))
					.filter(item => item.index !== offset + handle.nodeIndex && item.distance <= 8 / this.camera.scale)
					.sort((a, b) => a.distance - b.distance)[0];
				if (target) {
					gesture.mergeTarget = target.index;
					position = target.vertex;
				}
			}
			if (input.event.shiftKey) {
				const dx = (position.x - anchor.x) * path.width,
					dy = (position.y - anchor.y) * path.height;
				const angle = (Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * Math.PI) / 4,
					length = Math.hypot(dx, dy);
				position = {
					x: anchor.x + (Math.cos(angle) * length) / path.width,
					y: anchor.y + (Math.sin(angle) * length) / path.height,
				};
			}
			if (path.network) {
				if (gesture.penVertex !== undefined) {
					position = { x: 2 * anchor.x - position.x, y: 2 * anchor.y - position.y };
				}
				const network =
					handle.point === 'anchor'
						? moveDesignNetworkVertices(
								path.network,
								this.selection.nodeIndices,
								position.x - anchor.x,
								position.y - anchor.y,
							)
						: moveDesignNetworkHandle(
								path.network,
								handle.edge!,
								handle.point,
								position,
								path.width,
								path.height,
								input.event.altKey,
							);
				gesture.preview = [withDesignVectorNetwork(path, network)];
				this.host.render();
				return;
			}
			const nodes = contour.nodes.map((node, index) => {
				if (handle.point === 'anchor' && this.selection.nodeIndices.has(index)) {
					return moveDesignPathNode(
						node,
						'anchor',
						{ x: node.x + position.x - anchor.x, y: node.y + position.y - anchor.y },
						path.width,
						path.height,
					);
				}
				return index === handle.nodeIndex
					? moveDesignPathNode(node, handle.point, position, path.width, path.height, input.event.altKey)
					: node;
			});
			gesture.preview = [
				withDesignPathContours(
					path,
					contours.map((value, index) => (index === handle.contourIndex ? { ...value, nodes } : value)),
				),
			];
		} else {
			const entries = getDesignShapeEntries(this.documentController.model.value.shapes);
			gesture.preview = gesture.shapes.map(shape => {
				const entry = entries.find(entry => entry.shape.id === shape.id)!;
				const angle = ((entry.world.rotation - shape.rotation) * Math.PI) / 180;
				const dx = (input.point.x - gesture.start.x) / this.camera.scale / entry.parentScale;
				const dy = (input.point.y - gesture.start.y) / this.camera.scale / entry.parentScale;
				return {
					...shape,
					x: shape.x + dx * Math.cos(angle) + dy * Math.sin(angle),
					y: shape.y - dx * Math.sin(angle) + dy * Math.cos(angle),
				};
			});
		}
		this.host.render();
	}

	public end(input: CanvasPointerInput): void {
		if (this.isDrawing) {
			this.drawing.update(input.world, { shift: input.event.shiftKey, alt: input.event.altKey });
			this.isDrawing = false;
			this.drawing.end();
			return;
		}
		const gesture = this.gesture!;
		this.gesture = undefined;
		this.selectionRect = undefined;
		if (!gesture.marquee) {
			if (gesture.penVertex !== undefined) {
				this.selection.selectNode(0, gesture.penVertex);
			}
			const path = gesture.preview[0];
			if (gesture.mergeTarget !== undefined && gesture.handle && path.kind === 'path') {
				const offset = path.network
					? 0
					: designPathContours(path)
							.slice(0, gesture.handle.contourIndex)
							.reduce((sum, contour) => sum + contour.nodes.length, 0);
				const result = mergeDesignNetworkVertices(
					toDesignVectorNetwork(path),
					new Set([offset + gesture.handle.nodeIndex, gesture.mergeTarget]),
					gesture.mergeTarget,
				);
				if (result.network.edges.length) {
					this.commands.vector.update(withDesignVectorNetwork(path, result.network));
					this.selection.selectNode(0, result.vertices.get(gesture.mergeTarget)!);
				} else {
					this.commands.removeShapes(new Set([path.id]));
				}
				status(
					localize('sessions.design.networkNodesMerged', 'Nodes merged. Undo restores the separate nodes.'),
				);
			} else if (gesture.connectionSource && path.kind === 'path') {
				void this.commitConnection(gesture.connectionSource, path, gesture.penVertex!);
			} else {
				this.commands.updateShapes(gesture.preview);
			}
		}
		this.host.render();
	}

	public cancel(): void {
		this.isDrawing = false;
		this.penVertex = undefined;
		const hadGesture = this.gesture !== undefined;
		this.gesture = undefined;
		this.selectionRect = undefined;
		this.drawing.cancel();
		if (hadGesture && !this.isDisposed) {
			this.host.render();
		}
	}

	public cancelGesture(): void {
		this.penVertex = undefined;
		this.input.cancel();
	}
}
