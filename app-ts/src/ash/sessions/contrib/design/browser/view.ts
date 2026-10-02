import './view.css';
import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { getLxiconDefinition } from '../../../../base/common/lxiconsUtil.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { foreground } from '../../../../platform/theme/common/colors/baseColors.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { DesignConfiguration, DesignTool } from '../common/config/editorConfiguration.js';
import type { DesignShape } from '../common/model/document.js';
import type { DesignViewport } from '../common/viewport.js';
import { renderDesignShape } from './svgRenderer.js';

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

interface DesignRenderState {
	readonly shapes: readonly DesignShape[];
	readonly selectedShapes: readonly DesignShape[];
	readonly draft: DesignShape | undefined;
	readonly showPathHandles: boolean;
	readonly scale: number;
	readonly opacity: ReadonlyMap<string, number> | undefined;
}

/** Owns the canvas DOM and its presentation; editing and history stay outside the view. */
export class DesignView extends Disposable {
	public readonly domNode: HTMLElement;
	private readonly world: HTMLElement;
	private readonly shapesDomNode: SVGSVGElement;
	private readonly selectionDomNode: SVGGElement;
	private readonly renderedShapes = new Map<string, SVGGraphicsElement>();
	private drawingDomNode: SVGGraphicsElement | undefined;

	constructor(
		ownerDocument: Document,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IThemeService private readonly themeService: IThemeService,
	) {
		super();
		this.domNode = h(ownerDocument, 'div', { className: 'ash-sessions-design-viewport' });
		this.world = h(ownerDocument, 'div', { className: 'ash-sessions-design-world' });
		this.shapesDomNode = ownerDocument.createElementNS(SVG_NAMESPACE, 'svg');
		this.shapesDomNode.classList.add('ash-sessions-design-shapes');
		this.shapesDomNode.setAttribute('aria-hidden', 'true');
		this.selectionDomNode = ownerDocument.createElementNS(SVG_NAMESPACE, 'g');
		this.selectionDomNode.classList.add('ash-sessions-design-selection');
		this.shapesDomNode.append(this.selectionDomNode);
		this.world.append(this.shapesDomNode);
		this.domNode.append(this.world);
		this.updatePointerCursor();
		this.updateCursorConfiguration();
		this._register(themeService.onDidColorThemeChange(() => this.updatePointerCursor()));
		this._register(configurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(DesignConfiguration.usePointerCursor)) { this.updateCursorConfiguration(); }
		}));
		this._register(addDisposableListener(this.domNode, 'pointerdown', () => this.setFocused(false)));
	}

	public setFocused(isFocused: boolean): void { this.domNode.classList.toggle('focused', isFocused); }

	public setTool(tool: DesignTool): void {
		this.domNode.classList.toggle('hand-tool', tool === DesignTool.Hand);
		this.domNode.classList.toggle('drawing-tool', ![DesignTool.Select, DesignTool.Hand].includes(tool));
	}

	public applyTransform(camera: DesignViewport): void {
		this.world.style.transform = `translate(${camera.panX}px, ${camera.panY}px) scale(${camera.scale})`;
		this.domNode.style.setProperty('--ash-sessions-design-pan-x', `${camera.panX}px`);
		this.domNode.style.setProperty('--ash-sessions-design-pan-y', `${camera.panY}px`);
		this.domNode.style.setProperty('--ash-sessions-design-scale', `${camera.scale}`);
	}

	public render(state: DesignRenderState): void {
		const ids = new Set(state.shapes.map(shape => shape.id));
		for (const [id, element] of this.renderedShapes) {
			if (!ids.has(id)) { element.remove(); this.renderedShapes.delete(id); }
		}
		for (const shape of state.shapes) {
			const previous = this.renderedShapes.get(shape.id);
			const element = renderDesignShape(shape, previous);
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
		this.selectionDomNode.replaceChildren(...selected.map(shape => {
			const rect = this.domNode.ownerDocument.createElementNS(SVG_NAMESPACE, 'rect');
			for (const key of ['x', 'y', 'width', 'height'] as const) { rect.setAttribute(key, `${shape[key]}`); }
			rect.setAttribute('transform', this.shapeTransform(shape));
			return rect;
		}));
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
		this.domNode.classList.toggle('pointer-cursor', this.configurationService.getValue<boolean>(DesignConfiguration.usePointerCursor));
	}

	private updatePointerCursor(): void {
		const color = this.themeService.getColorTheme().getColorCss(foreground)!;
		const svg = getLxiconDefinition(Lxicon.cursor2.id)!().replace('<svg ', '<svg width="24" height="24" ').replaceAll('#000', color);
		// The hotspot follows the artwork's tip at (4.5, 3.258) in its 16-unit viewBox.
		this.domNode.style.setProperty('--ash-sessions-design-pointer-cursor', `url("data:image/svg+xml,${encodeURIComponent(svg)}") 6 4, default`);
	}
}
