import { designPaints } from '../common/model/designPaint.js';
import { designEffects } from '../common/model/designEffects.js';
import { designWidthLocation } from '../common/model/designVariableWidth.js';
import { designPathEditingContours } from '../common/model/designVector.js';
import './view.css';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { Canvas, CanvasCursor } from '../../canvas/browser/canvas.js';
import type { CanvasViewport } from '../../canvas/common/canvasViewport.js';
import { DesignConfiguration, DesignTool } from '../common/config/editorConfiguration.js';
import type { DesignShape } from '../common/model/document.js';
import type { DesignImageSource } from './designMedia.js';
import { renderDesignShape } from './svgRenderer.js';

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

interface DesignRenderState {
	readonly shapes: readonly DesignShape[];
	readonly images: ReadonlyMap<string, DesignImageSource>;
	readonly selectedShapes: readonly DesignShape[];
	readonly draft: DesignShape | undefined;
	readonly showPathHandles: boolean;
	readonly showWidthHandles?: boolean;
	readonly gradient?: { paintId?: string; stopId?: string };
	readonly blur?: { effectId?: string; handle: 'start' | 'end' };
	readonly selectedWidthPoints?: ReadonlySet<string>;
	readonly selectionRect?: { x: number; y: number; width: number; height: number };
	readonly activeContour?: number;
	readonly selectedNodes?: ReadonlySet<number>;
	readonly scale: number;
	readonly opacity: ReadonlyMap<string, number> | undefined;
}

/** Presents design objects and path handles on the shared spatial canvas. */
export class DesignView extends Disposable {
	public readonly domNode: HTMLElement;
	private readonly canvas: Canvas;
	private readonly shapesDomNode: SVGSVGElement;
	private readonly selectionDomNode: SVGGElement;
	public readonly overlayDomNode: SVGGElement;
	private readonly renderedShapes = new Map<string, SVGGraphicsElement>();
	private drawingDomNode: SVGGraphicsElement | undefined;

	constructor(
		ownerDocument: Document,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		this.canvas = this._register(instantiationService.createInstance(Canvas, ownerDocument));
		this.domNode = this.canvas.domNode;
		this.shapesDomNode = ownerDocument.createElementNS(SVG_NAMESPACE, 'svg');
		this.shapesDomNode.classList.add('ash-sessions-design-shapes');
		this.selectionDomNode = ownerDocument.createElementNS(SVG_NAMESPACE, 'g');
		this.selectionDomNode.classList.add('ash-sessions-design-selection');
		this.selectionDomNode.setAttribute('aria-hidden', 'true');
		this.overlayDomNode = ownerDocument.createElementNS(SVG_NAMESPACE, 'g');
		this.shapesDomNode.append(this.selectionDomNode, this.overlayDomNode);
		this.canvas.setContent(this.shapesDomNode);
		this.updateCursorConfiguration();
		this._register(
			configurationService.onDidChangeConfiguration(event => {
				if (event.affectsConfiguration(DesignConfiguration.usePointerCursor)) {
					this.updateCursorConfiguration();
				}
			}),
		);
	}

	public setFocused(isFocused: boolean): void {
		this.canvas.setFocused(isFocused);
	}

	public setTool(tool: DesignTool): void {
		let cursor = CanvasCursor.Draw;
		if (tool === DesignTool.Hand) {
			cursor = CanvasCursor.Pan;
		} else if (tool === DesignTool.Select) {
			cursor = CanvasCursor.Select;
		}
		this.canvas.setCursor(cursor);
	}

	public applyTransform(camera: CanvasViewport): void {
		this.canvas.applyTransform(camera);
	}

	public render(state: DesignRenderState): void {
		const ids = new Set(state.shapes.map(shape => shape.id));
		for (const [id, element] of this.renderedShapes) {
			if (!ids.has(id)) {
				element.remove();
				this.renderedShapes.delete(id);
			}
		}
		const backdrop: SVGGraphicsElement[] = [];
		for (const shape of state.shapes) {
			const previous = this.renderedShapes.get(shape.id);
			// Apply animation opacity before rendering so isolated paint groups and filter sources agree.
			const appearance = (shape: DesignShape): DesignShape => ({
				...shape,
				opacity: state.opacity?.get(shape.id) ?? shape.opacity,
				...(shape.kind === 'frame' || shape.kind === 'group'
					? { children: shape.children.map(appearance) }
					: {}),
			});
			const element = renderDesignShape(
				state.opacity ? appearance(shape) : shape,
				previous,
				state.images,
				backdrop,
			);
			backdrop.push(element);
			element.setAttribute('aria-hidden', 'true');
			if (previous !== element) {
				previous?.remove();
				this.renderedShapes.set(shape.id, element);
			}
			this.shapesDomNode.insertBefore(element, this.selectionDomNode);
		}
		const draft = state.draft;
		if (draft) {
			const preview = renderDesignShape(draft, this.drawingDomNode);
			preview.setAttribute('aria-hidden', 'true');
			if (preview !== this.drawingDomNode) {
				this.drawingDomNode?.remove();
				this.drawingDomNode = preview;
			}
			preview.removeAttribute('data-shape-id');
			preview.classList.add('ash-design-drawing-preview');
			this.shapesDomNode.insertBefore(preview, this.selectionDomNode);
		} else {
			this.drawingDomNode?.remove();
			this.drawingDomNode = undefined;
		}
		const selected = state.selectedShapes;
		this.canvas.renderSelection(selected);
		this.selectionDomNode.replaceChildren();
		if (state.showPathHandles && selected.length === 1 && selected[0].kind === 'path') {
			const path = selected[0];
			const handles = this.domNode.ownerDocument.createElementNS(SVG_NAMESPACE, 'g');
			handles.setAttribute('transform', this.shapeTransform(path));
			for (const [contourIndex, contour] of designPathEditingContours(path).entries()) {
				for (const [index, node] of contour.nodes.entries()) {
					for (const point of ['incoming', 'outgoing', 'anchor'] as const) {
						const position = point === 'anchor' ? node : node[point];
						if (point !== 'anchor' && position.x === node.x && position.y === node.y) {
							continue;
						}
						if (point !== 'anchor') {
							const line = this.domNode.ownerDocument.createElementNS(SVG_NAMESPACE, 'line');
							for (const [key, value] of Object.entries({
								x1: path.x + node.x * path.width,
								y1: path.y + node.y * path.height,
								x2: path.x + position.x * path.width,
								y2: path.y + position.y * path.height,
							})) {
								line.setAttribute(key, `${value}`);
							}
							handles.append(line);
						}
						const circle = this.domNode.ownerDocument.createElementNS(SVG_NAMESPACE, 'circle');
						circle.classList.add('ash-sessions-design-path-handle');
						circle.dataset.pathNode = `${index}`;
						circle.dataset.pathContour = `${contourIndex}`;
						circle.classList.toggle(
							'selected',
							point === 'anchor' &&
								state.activeContour === contourIndex &&
								!!state.selectedNodes?.has(index),
						);
						circle.dataset.pathPoint = point;
						circle.setAttribute('cx', `${path.x + position.x * path.width}`);
						circle.setAttribute('cy', `${path.y + position.y * path.height}`);
						circle.setAttribute('r', `${(point === 'anchor' ? 5 : 4) / state.scale}`);
						handles.append(circle);
					}
				}
			}
			if (path.network) {
				for (const [edgeIndex, edge] of path.network.edges.entries()) {
					for (const [point, index] of [
						['outgoing', edge.start],
						['incoming', edge.end],
					] as const) {
						const anchor = path.network.vertices[index],
							position = edge[point];
						if (anchor.x === position.x && anchor.y === position.y) {
							continue;
						}
						const line = this.domNode.ownerDocument.createElementNS(SVG_NAMESPACE, 'line');
						for (const [key, value] of Object.entries({
							x1: path.x + anchor.x * path.width,
							y1: path.y + anchor.y * path.height,
							x2: path.x + position.x * path.width,
							y2: path.y + position.y * path.height,
						})) {
							line.setAttribute(key, String(value));
						}
						const circle = this.domNode.ownerDocument.createElementNS(SVG_NAMESPACE, 'circle');
						circle.classList.add('ash-sessions-design-path-handle');
						Object.assign(circle.dataset, {
							pathNode: String(index),
							pathContour: '0',
							pathPoint: point,
							networkEdge: String(edgeIndex),
						});
						circle.setAttribute('cx', String(path.x + position.x * path.width));
						circle.setAttribute('cy', String(path.y + position.y * path.height));
						circle.setAttribute('r', String(4 / state.scale));
						handles.prepend(line, circle);
					}
				}
			}
			this.selectionDomNode.append(handles);
		}
		if (state.showWidthHandles && selected.length === 1 && selected[0].kind === 'path') {
			const path = selected[0],
				handles = this.domNode.ownerDocument.createElementNS(SVG_NAMESPACE, 'g');
			handles.setAttribute('transform', this.shapeTransform(path));
			for (const point of path.widthPoints ?? []) {
				const location = designWidthLocation(path, point.contour, point.position);
				if (!location) {
					continue;
				}
				const { normal } = location,
					center = { x: path.x + location.point.x, y: path.y + location.point.y },
					radius = (point.width * path.strokeWidth) / 2;
				const line = this.domNode.ownerDocument.createElementNS(SVG_NAMESPACE, 'line');
				for (const [key, value] of Object.entries({
					x1: center.x - normal.x * radius,
					y1: center.y - normal.y * radius,
					x2: center.x + normal.x * radius,
					y2: center.y + normal.y * radius,
				})) {
					line.setAttribute(key, String(value));
				}
				handles.append(line);
				for (const side of [-1, 1, 0]) {
					const circle = this.domNode.ownerDocument.createElementNS(SVG_NAMESPACE, 'circle');
					circle.classList.add('ash-sessions-design-path-handle');
					circle.classList.toggle('selected', !!state.selectedWidthPoints?.has(point.id));
					Object.assign(circle.dataset, { widthPoint: point.id, widthHandle: side ? 'edge' : 'center' });
					circle.setAttribute('cx', String(center.x + normal.x * radius * side));
					circle.setAttribute('cy', String(center.y + normal.y * radius * side));
					circle.setAttribute('r', String((side ? 4 : 5) / state.scale));
					handles.append(circle);
				}
			}
			this.selectionDomNode.append(handles);
		}
		if (state.blur && selected.length === 1) {
			const shape = selected[0];
			const effect = designEffects(shape).find(effect => effect.id === state.blur!.effectId);
			const progressive =
				effect?.visible !== false && effect && 'progressive' in effect ? effect.progressive : undefined;
			if (progressive) {
				const group = this.domNode.ownerDocument.createElementNS(SVG_NAMESPACE, 'g');
				group.setAttribute('transform', this.shapeTransform(shape));
				const point = (p: { x: number; y: number }) => ({
					x: shape.x + p.x * shape.width,
					y: shape.y + p.y * shape.height,
				});
				const start = point(progressive.start),
					end = point(progressive.end);
				const line = this.domNode.ownerDocument.createElementNS(SVG_NAMESPACE, 'line');
				for (const [key, value] of Object.entries({ x1: start.x, y1: start.y, x2: end.x, y2: end.y })) {
					line.setAttribute(key, String(value));
				}
				line.dataset.blurHandle = 'axis';
				group.append(line);
				for (const handle of ['start', 'end'] as const) {
					const position = point(progressive[handle]);
					const circle = this.domNode.ownerDocument.createElementNS(SVG_NAMESPACE, 'circle');
					circle.classList.add('ash-sessions-design-path-handle');
					circle.classList.toggle('selected', handle === state.blur.handle);
					circle.dataset.blurHandle = handle;
					circle.setAttribute('cx', String(position.x));
					circle.setAttribute('cy', String(position.y));
					circle.setAttribute('r', String(7 / state.scale));
					group.append(circle);
				}
				this.selectionDomNode.append(group);
			}
		}
		if (state.gradient && selected.length === 1) {
			const shape = selected[0],
				paints = designPaints(shape),
				paint = paints.find(paint => paint.id === state.gradient!.paintId) ?? paints[0];
			if (paint && paint.type !== 'solid') {
				const group = this.domNode.ownerDocument.createElementNS(SVG_NAMESPACE, 'g');
				group.setAttribute('transform', this.shapeTransform(shape));
				const point = (p: { x: number; y: number }) => ({
					x: shape.x + p.x * shape.width,
					y: shape.y + p.y * shape.height,
				});
				const [a, b, c] = paint.handles.map(point);
				for (const [index, end] of [b, c].entries()) {
					const line = this.domNode.ownerDocument.createElementNS(SVG_NAMESPACE, 'line');
					for (const [key, value] of Object.entries({ x1: a.x, y1: a.y, x2: end.x, y2: end.y })) {
						line.setAttribute(key, String(value));
					}
					if (index === 0) {
						line.dataset.gradientAxis = '';
					}
					group.append(line);
				}
				const handle = (
					p: { x: number; y: number },
					data: Record<string, string>,
					selected: boolean,
					color?: string,
				) => {
					const circle = this.domNode.ownerDocument.createElementNS(SVG_NAMESPACE, 'circle');
					circle.classList.add('ash-sessions-design-path-handle');
					circle.classList.toggle('selected', selected);
					Object.assign(circle.dataset, data);
					circle.setAttribute('cx', String(p.x));
					circle.setAttribute('cy', String(p.y));
					circle.setAttribute('r', String((color ? 5 : 8) / state.scale));
					if (color) {
						circle.style.fill = color;
					}
					group.append(circle);
				};
				for (const [index, p] of [a, b, c].entries()) {
					handle(p, { gradientHandle: String(index) }, false);
				}
				for (const stop of paint.stops) {
					const angle = stop.position * Math.PI * 2,
						p =
							paint.type === 'angular'
								? {
										x: a.x + (b.x - a.x) * Math.cos(angle) + (c.x - a.x) * Math.sin(angle),
										y: a.y + (b.y - a.y) * Math.cos(angle) + (c.y - a.y) * Math.sin(angle),
									}
								: { x: a.x + (b.x - a.x) * stop.position, y: a.y + (b.y - a.y) * stop.position };
					handle(p, { gradientStop: stop.id }, stop.id === state.gradient.stopId, stop.color);
				}
				this.selectionDomNode.append(group);
			}
		}

		if (state.selectionRect) {
			const rect = this.domNode.ownerDocument.createElementNS(SVG_NAMESPACE, 'rect');
			for (const [key, value] of Object.entries(state.selectionRect)) {
				rect.setAttribute(key, String(value));
			}
			this.selectionDomNode.append(rect);
		}
		this.selectionDomNode.classList.toggle('visible', selected.length > 0);
	}

	private shapeTransform(shape: DesignShape): string {
		return `rotate(${shape.rotation} ${shape.x + shape.width / 2} ${shape.y + shape.height / 2})`;
	}

	private updateCursorConfiguration(): void {
		this.canvas.setPointerCursor(this.configurationService.getValue<boolean>(DesignConfiguration.usePointerCursor));
	}
}
