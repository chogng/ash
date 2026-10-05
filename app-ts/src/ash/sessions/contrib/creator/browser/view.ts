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
	readonly scale: number;
	readonly opacity: ReadonlyMap<string, number> | undefined;
}

/** Presents design objects and path handles on the shared spatial canvas. */
export class DesignView extends Disposable {
	public readonly domNode: HTMLElement;
	private readonly canvas: Canvas;
	private readonly shapesDomNode: SVGSVGElement;
	private readonly selectionDomNode: SVGGElement;
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
		this.shapesDomNode.setAttribute('aria-hidden', 'true');
		this.selectionDomNode = ownerDocument.createElementNS(SVG_NAMESPACE, 'g');
		this.selectionDomNode.classList.add('ash-sessions-design-selection');
		this.shapesDomNode.append(this.selectionDomNode);
		this.canvas.setContent(this.shapesDomNode);
		this.updateCursorConfiguration();
		this._register(configurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(DesignConfiguration.usePointerCursor)) { this.updateCursorConfiguration(); }
		}));
	}

	public setFocused(isFocused: boolean): void { this.canvas.setFocused(isFocused); }

	public setTool(tool: DesignTool): void {
		let cursor = CanvasCursor.Draw;
		if (tool === DesignTool.Hand) { cursor = CanvasCursor.Pan; }
		else if (tool === DesignTool.Select) { cursor = CanvasCursor.Select; }
		this.canvas.setCursor(cursor);
	}

	public applyTransform(camera: CanvasViewport): void { this.canvas.applyTransform(camera); }

	public render(state: DesignRenderState): void {
		const ids = new Set(state.shapes.map(shape => shape.id));
		for (const [id, element] of this.renderedShapes) {
			if (!ids.has(id)) { element.remove(); this.renderedShapes.delete(id); }
		}
		for (const shape of state.shapes) {
			const previous = this.renderedShapes.get(shape.id);
			const element = renderDesignShape(shape, previous, state.images);
			for (const node of [element, ...element.querySelectorAll<SVGGraphicsElement>('[data-shape-id]')]) {
				if (state.opacity) { node.setAttribute('opacity', `${state.opacity.get(node.dataset.shapeId!)!}`); }
				else { node.removeAttribute('opacity'); }
			}
			if (previous !== element) { previous?.remove(); this.renderedShapes.set(shape.id, element); }
			this.shapesDomNode.insertBefore(element, this.selectionDomNode);
		}
		const draft = state.draft;
		if (draft) {
			const preview = renderDesignShape(draft, this.drawingDomNode);
			if (preview !== this.drawingDomNode) { this.drawingDomNode?.remove(); this.drawingDomNode = preview; }
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
			for (const [index, node] of path.nodes.entries()) {
				for (const point of ['incoming', 'outgoing', 'anchor'] as const) {
					const position = point === 'anchor' ? node : node[point];
					if (point !== 'anchor' && position.x === node.x && position.y === node.y) { continue; }
					if (point !== 'anchor') {
						const line = this.domNode.ownerDocument.createElementNS(SVG_NAMESPACE, 'line');
						for (const [key, value] of Object.entries({ x1: path.x + node.x * path.width, y1: path.y + node.y * path.height, x2: path.x + position.x * path.width, y2: path.y + position.y * path.height })) { line.setAttribute(key, `${value}`); }
						handles.append(line);
					}
					const circle = this.domNode.ownerDocument.createElementNS(SVG_NAMESPACE, 'circle');
					circle.classList.add('ash-sessions-design-path-handle');
					circle.dataset.pathNode = `${index}`;
					circle.dataset.pathPoint = point;
					circle.setAttribute('cx', `${path.x + position.x * path.width}`);
					circle.setAttribute('cy', `${path.y + position.y * path.height}`);
					circle.setAttribute('r', `${(point === 'anchor' ? 5 : 4) / state.scale}`);
					handles.append(circle);
				}
			}
			this.selectionDomNode.append(handles);
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
