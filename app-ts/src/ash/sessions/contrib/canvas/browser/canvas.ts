import './canvas.css';
import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { getLxiconDefinition } from '../../../../base/common/lxiconsUtil.js';
import { foreground } from '../../../../platform/theme/common/colors/baseColors.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import type { CanvasViewport } from '../common/canvasViewport.js';

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

export enum CanvasCursor {
	Select = 'select',
	Pan = 'pan',
	Draw = 'draw',
}

export interface CanvasSelectionBounds {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
	readonly rotation: number;
}

/** Owns the spatial surface; the editor owns its content, model and accessible description. */
export class Canvas extends Disposable {
	public readonly domNode: HTMLElement;
	private readonly worldDomNode: HTMLElement;
	private readonly selectionDomNode: SVGSVGElement;
	private readonly selectionBoundsDomNodes: SVGRectElement[] = [];

	constructor(ownerDocument: Document, @IThemeService private readonly themeService: IThemeService) {
		super();
		this.domNode = h(ownerDocument, 'div', { className: 'ash-canvas-viewport' });
		this.worldDomNode = h(ownerDocument, 'div', { className: 'ash-canvas-world' });
		this.selectionDomNode = ownerDocument.createElementNS(SVG_NAMESPACE, 'svg');
		this.selectionDomNode.classList.add('ash-canvas-selection');
		this.selectionDomNode.setAttribute('aria-hidden', 'true');
		this.worldDomNode.append(this.selectionDomNode);
		this.domNode.append(this.worldDomNode);
		this._register(toDisposable(() => this.domNode.remove()));
		this._register(addDisposableListener(this.domNode, 'pointerdown', () => this.setFocused(false)));
		this._register(themeService.onDidColorThemeChange(() => this.updatePointerCursor()));
		this.updatePointerCursor();
	}

	public setContent(content: HTMLElement | SVGElement): void {
		this.worldDomNode.replaceChildren(content, this.selectionDomNode);
	}

	public setFocused(isFocused: boolean): void { this.domNode.classList.toggle('focused', isFocused); }
	public setPointerCursor(isEnabled: boolean): void { this.domNode.classList.toggle('pointer-cursor', isEnabled); }

	public setCursor(cursor: CanvasCursor): void {
		this.domNode.classList.toggle('hand-tool', cursor === CanvasCursor.Pan);
		this.domNode.classList.toggle('drawing-tool', cursor === CanvasCursor.Draw);
	}

	public applyTransform(viewport: CanvasViewport): void {
		this.worldDomNode.style.transform = `translate(${viewport.panX}px, ${viewport.panY}px) scale(${viewport.scale})`;
		this.domNode.style.setProperty('--ash-canvas-pan-x', `${viewport.panX}px`);
		this.domNode.style.setProperty('--ash-canvas-pan-y', `${viewport.panY}px`);
		this.domNode.style.setProperty('--ash-canvas-scale', `${viewport.scale}`);
	}

	public renderSelection(bounds: readonly CanvasSelectionBounds[]): void {
		for (const rect of this.selectionBoundsDomNodes.splice(bounds.length)) { rect.remove(); }
		for (const [index, bound] of bounds.entries()) {
			let rect = this.selectionBoundsDomNodes[index];
			if (!rect) {
				rect = this.domNode.ownerDocument.createElementNS(SVG_NAMESPACE, 'rect');
				this.selectionBoundsDomNodes.push(rect);
				this.selectionDomNode.append(rect);
			}
			for (const key of ['x', 'y', 'width', 'height'] as const) { rect.setAttribute(key, `${bound[key]}`); }
			rect.setAttribute('transform', `rotate(${bound.rotation} ${bound.x + bound.width / 2} ${bound.y + bound.height / 2})`);
		}
		this.selectionDomNode.classList.toggle('visible', bounds.length > 0);
	}

	private updatePointerCursor(): void {
		const color = this.themeService.getColorTheme().getColorCss(foreground)!;
		const svg = getLxiconDefinition(Lxicon.cursor2.id)!().replace('<svg ', '<svg width="24" height="24" ').replaceAll('#000', color);
		// The hotspot follows the artwork's tip at (4.5, 3.258) in its 16-unit viewBox.
		this.domNode.style.setProperty('--ash-canvas-pointer-cursor', `url("data:image/svg+xml,${encodeURIComponent(svg)}") 6 4, default`);
	}
}
