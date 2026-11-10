import { addDisposableListener } from '../../../../base/browser/dom.js';
import { Emitter } from '../../../../base/common/event.js';
import { FreehandStroke } from '../../../../base/common/freehandStroke.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';

const svgNamespace = 'http://www.w3.org/2000/svg';
// Ink becomes part of the image and keeps its color across themes.
const ink = '#e53935';
const maxPixels = 64 * 1024 * 1024;

interface Stroke {
	readonly points: FreehandStroke;
	readonly width: number;
	readonly line: SVGPolylineElement;
}

/** Keeps ink in image coordinates so the preview and the PNG use the same strokes. */
export class ImageAnnotation extends Disposable {
	readonly overlay: SVGSVGElement;
	private readonly changed = this._register(new Emitter<void>());
	readonly onDidChange = this.changed.event;
	private readonly strokes: Stroke[] = [];
	private active: { readonly id: number; readonly stroke: Stroke; } | undefined;
	private size: { readonly width: number; readonly height: number; } | undefined;

	constructor(private readonly document: Document, private readonly source: string) {
		super();
		const overlay = this.overlay = document.createElementNS(svgNamespace, 'svg');
		overlay.classList.add('ash-image-annotation');
		overlay.setAttribute('aria-hidden', 'true');
		overlay.setAttribute('preserveAspectRatio', 'none');
		this._register(addDisposableListener(overlay, 'pointerdown', event => this.begin(event as PointerEvent)));
		this._register(addDisposableListener(overlay, 'pointermove', event => this.move(event as PointerEvent)));
		this._register(addDisposableListener(overlay, 'pointerup', event => this.finish(event as PointerEvent)));
		this._register(addDisposableListener(overlay, 'lostpointercapture', event => {
			if (this.active?.id === (event as PointerEvent).pointerId) this.discardStroke();
		}));
		// Drawing must not trigger the viewer's click-to-zoom gesture.
		for (const type of ['mousedown', 'click'] as const) {
			this._register(addDisposableListener(overlay, type, event => event.stopPropagation()));
		}
	}

	get hasStrokes(): boolean { return this.strokes.length > 0; }

	start(size: { readonly width: number; readonly height: number; }): void {
		this.size = size;
		this.overlay.setAttribute('viewBox', `0 0 ${size.width} ${size.height}`);
		this.overlay.classList.add('drawing');
	}

	clear(): void {
		this.discardStroke();
		this.strokes.length = 0;
		this.overlay.replaceChildren();
		this.overlay.classList.remove('drawing');
		this.size = undefined;
		this.changed.fire();
	}

	undo(): void {
		this.strokes.pop()?.line.remove();
		this.changed.fire();
	}

	async renderPng(signal: AbortSignal): Promise<Blob> {
		const image = this.document.createElement('img');
		image.src = this.source;
		await image.decode();
		signal.throwIfAborted();
		const canvas = this.document.createElement('canvas');
		canvas.width = image.naturalWidth;
		canvas.height = image.naturalHeight;
		if (canvas.width * canvas.height > maxPixels) throw new Error(localize('chat.image.annotationTooLarge', 'This image is too large to annotate.'));
		const context = canvas.getContext('2d');
		if (!context) throw new Error(localize('chat.image.annotationFailed', 'Could not create the annotated image.'));
		context.drawImage(image, 0, 0);
		context.strokeStyle = ink;
		context.lineCap = 'round';
		context.lineJoin = 'round';
		for (const stroke of this.strokes) {
			context.lineWidth = stroke.width;
			context.beginPath();
			const [start, ...points] = stroke.points.points;
			context.moveTo(start.x, start.y);
			for (const point of points) context.lineTo(point.x, point.y);
			context.stroke();
		}
		const png = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
		signal.throwIfAborted();
		if (!png) throw new Error(localize('chat.image.annotationFailed', 'Could not create the annotated image.'));
		return png;
	}

	private begin(event: PointerEvent): void {
		const size = this.size;
		if (!size || this.active || event.button !== 0) return;
		const bounds = this.overlay.getBoundingClientRect();
		if (!bounds.width || !bounds.height) return;
		const scale = size.width / bounds.width;
		const width = Math.max(1, scale * 3);
		const line = this.document.createElementNS(svgNamespace, 'polyline');
		line.setAttribute('fill', 'none');
		line.setAttribute('stroke', ink);
		line.setAttribute('stroke-width', String(width));
		line.setAttribute('stroke-linecap', 'round');
		line.setAttribute('stroke-linejoin', 'round');
		const points = new FreehandStroke(this.point(event, bounds, size), scale * 2);
		this.active = { id: event.pointerId, stroke: { points, width, line } };
		this.overlay.append(line);
		this.overlay.setPointerCapture(event.pointerId);
		event.preventDefault();
	}

	private move(event: PointerEvent): void {
		const active = this.active;
		const size = this.size;
		if (!active || !size || active.id !== event.pointerId) return;
		const bounds = this.overlay.getBoundingClientRect();
		if (!bounds.width || !bounds.height) return;
		const stroke = active.stroke;
		if (stroke.points.append(this.point(event, bounds, size))) {
			stroke.line.setAttribute('points', stroke.points.points.map(point => `${point.x},${point.y}`).join(' '));
		}
	}

	private finish(event: PointerEvent): void {
		const active = this.active;
		if (!active || active.id !== event.pointerId) return;
		this.move(event);
		this.active = undefined;
		if (active.stroke.points.points.length > 1) this.strokes.push(active.stroke);
		else active.stroke.line.remove();
		this.changed.fire();
	}

	private discardStroke(): void {
		const active = this.active;
		this.active = undefined;
		active?.stroke.line.remove();
	}

	private point(event: PointerEvent, bounds: DOMRect, size: NonNullable<ImageAnnotation['size']>): { x: number; y: number; } {
		return {
			x: Math.max(0, Math.min(size.width, (event.clientX - bounds.left) * size.width / bounds.width)),
			y: Math.max(0, Math.min(size.height, (event.clientY - bounds.top) * size.height / bounds.height)),
		};
	}
}
