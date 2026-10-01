import { addDisposableListener } from '../../../../../base/browser/dom.js';
import { StandardWheelEvent } from '../../../../../base/browser/mouseEvent.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import type { DesignDocumentController } from '../designDocumentController.js';
import type { DocumentCommands } from '../../common/commands/documentCommands.js';
import { toDesignLocal, type DesignPoint } from '../../common/core/geometry.js';
import type { DesignShape } from '../../common/model/document.js';
import { hitTestDesignShapes } from '../../common/model/hitTest.js';
import type { DesignSelection } from '../../common/selection.js';
import type { DesignViewport } from '../../common/viewport.js';
import { DesignMode, DesignTool } from '../../common/config/editorConfiguration.js';
import type { DesignDrawingParticipant } from '../designEditorBrowser.js';

const WHEEL_ZOOM_SENSITIVITY = 0.005;
const KEYBOARD_ZOOM_FACTOR = 1.2;
type PathHandle = { readonly nodeIndex: number; readonly point: 'anchor' | 'incoming' | 'outgoing' };
interface PointerGesture {
	readonly pointerId: number;
	readonly start: DesignPoint;
	readonly shapes: readonly DesignShape[];
	readonly handle?: PathHandle;
	preview: readonly DesignShape[];
	last: DesignPoint;
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
}

/** Canvas and drawing gestures share one pointer-capture lifetime. */
export class DesignInputController extends Disposable {
	private gesture: PointerGesture | undefined;
	private drawingPointerId: number | undefined;

	constructor(private readonly host: InputHost, private readonly documentController: DesignDocumentController, private readonly commands: DocumentCommands, private readonly selection: DesignSelection, private readonly camera: DesignViewport, private readonly drawing: DesignDrawingParticipant) {
		super();
		this._register(addDisposableListener(host.viewport, 'wheel', (event: WheelEvent) => this.handleWheel(event), { passive: false }));
		this._register(addDisposableListener(host.viewport, 'pointerdown', (event: PointerEvent) => this.handlePointerDown(event)));
		this._register(addDisposableListener(host.viewport, 'pointermove', (event: PointerEvent) => this.handlePointerMove(event)));
		this._register(addDisposableListener(host.viewport, 'pointerup', (event: PointerEvent) => this.handlePointerUp(event)));
		this._register(addDisposableListener(host.viewport, 'pointercancel', () => this.cancel()));
		this._register(addDisposableListener(host.viewport, 'lostpointercapture', (event: PointerEvent) => {
			if (event.pointerId === this.drawingPointerId || event.pointerId === this.gesture?.pointerId) { this.cancel(); }
		}));
		this._register(addDisposableListener(host.viewport, 'dblclick', event => { if (this.drawing.complete()) { event.preventDefault(); } }));
		this._register(addDisposableListener(host.domNode, 'keydown', (event: KeyboardEvent) => {
			if (event.target !== host.domNode || !this.drawing.preview) { return; }
			if (event.key === 'Escape') { this.cancel(); event.preventDefault(); }
			else if (event.key === 'Enter' && this.drawing.complete()) { event.preventDefault(); }
		}));
		this._register(toDisposable(() => this.cancel()));
	}

	public get isGesturing(): boolean { return !!this.gesture || this.drawingPointerId !== undefined; }
	public get preview(): readonly DesignShape[] { return this.gesture?.preview ?? []; }
	private get selectedShapes(): readonly DesignShape[] { return this.documentController.model.value.shapes.filter(shape => this.selection.ids.has(shape.id)); }
	private get selectedShape(): DesignShape | undefined { return this.selection.ids.size === 1 ? this.selectedShapes[0] : undefined; }
	private select(ids: readonly string[]): void { this.selection.set(ids); this.host.selectionChanged(); }
	private announceSelection(): void { this.host.selectionChanged(); }
	private handleWheel(event: WheelEvent): void {
		if (this.isGesturing || this.drawing.preview) { event.preventDefault(); return; }
		const wheel = new StandardWheelEvent(event);
		if (wheel.ctrlKey || wheel.metaKey) { this.camera.zoomAt(this.viewportPoint(event), Math.exp(-wheel.deltaY * WHEEL_ZOOM_SENSITIVITY)); }
		else { this.camera.panBy(-wheel.deltaX, -wheel.deltaY); }
		this.host.applyTransform();
		wheel.stop();
	}

	private viewportPoint(event: MouseEvent): DesignPoint {
		const bounds = this.host.viewport.getBoundingClientRect();
		return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
	}

	private handlePointerDown(event: PointerEvent): void {
		if (event.defaultPrevented || this.host.getMode() === DesignMode.Code) { return; }
		if (this.documentController.isBusy || (event.button !== 0 && event.button !== 1) || !event.isPrimary || this.isGesturing) { return; }
		const point = this.viewportPoint(event);
		if (event.button === 0 && this.drawing.begin(this.camera.toWorld(point))) {
			if (this.drawing.preview) {
				this.drawingPointerId = event.pointerId;
				this.host.viewport.setPointerCapture(event.pointerId);
			}
			this.host.domNode.focus();
			event.preventDefault();
			return;
		}
		if (this.host.getTool() === DesignTool.Zoom && event.button === 0) {
			this.camera.zoomAt(point, event.altKey ? 1 / KEYBOARD_ZOOM_FACTOR : KEYBOARD_ZOOM_FACTOR);
			this.host.applyTransform(); this.host.domNode.focus(); event.preventDefault(); return;
		}
		const target = event.target as Element;
		const path = this.selectedShape;
		if (this.host.getMode() !== DesignMode.Motion && this.host.getTool() === DesignTool.Select && event.button === 0 && target.classList.contains('ash-sessions-design-path-handle') && path?.kind === 'path') {
			const handle: PathHandle = { nodeIndex: Number(target.getAttribute('data-path-node')), point: target.getAttribute('data-path-point') as PathHandle['point'] };
			this.selection.nodeIndex = handle.nodeIndex;
			this.gesture = { pointerId: event.pointerId, start: point, shapes: [path], preview: [path], last: point, handle };
			this.host.viewport.setPointerCapture(event.pointerId);
			this.host.viewport.classList.add('moving');
			this.host.render(); this.host.domNode.focus(); event.preventDefault(); return;
		}
		const shape = event.button === 1 || this.host.getTool() === DesignTool.Hand ? undefined : hitTestDesignShapes(this.host.getShapesForHitTesting(), this.camera.toWorld(point));
		if (this.host.getMode() === DesignMode.Motion && shape) { this.select([shape.id]); this.host.render(); this.host.domNode.focus(); event.preventDefault(); return; }
		if (event.button === 0 && this.host.getTool() !== DesignTool.Hand) {
			if (event.shiftKey && shape) {
				this.selection.toggle(shape.id);
				this.announceSelection();
				this.host.render(); this.host.domNode.focus(); event.preventDefault(); return;
			}
			if (!shape || !this.selection.ids.has(shape.id)) { this.select(shape ? [shape.id] : []); }
		}
		const shapes = shape ? this.selectedShapes : [];
		this.gesture = { pointerId: event.pointerId, start: point, shapes, preview: shapes, last: point };
		this.host.viewport.setPointerCapture(event.pointerId);
		this.host.viewport.classList.add(shape ? 'moving' : 'panning');
		this.host.render();
		this.host.domNode.focus();
		event.preventDefault();
	}

	private handlePointerMove(event: PointerEvent): void {
		if (event.pointerId === this.drawingPointerId) {
			this.drawing.update(this.camera.toWorld(this.viewportPoint(event)));
			event.preventDefault();
			return;
		}
		const gesture = this.gesture;
		if (!gesture || event.pointerId !== gesture.pointerId) { return; }
		const point = this.viewportPoint(event);
		const path = gesture.shapes[0];
		if (gesture.handle && path.kind === 'path') {
			const world = this.camera.toWorld(point);
			const local = toDesignLocal(path, world);
			const position = {
				x: Math.max(0, Math.min(1, local.x / path.width)),
				y: Math.max(0, Math.min(1, local.y / path.height)),
			};
			const handle = gesture.handle;
			const nodes = path.nodes.map((node, index) => {
				if (index !== handle.nodeIndex) { return node; }
				return handle.point === 'anchor' ? { ...node, ...position } : { ...node, [handle.point]: position };
			});
			gesture.preview = [{ ...path, nodes }];
			this.host.render();
		} else if (gesture.shapes.length) {
			gesture.preview = gesture.shapes.map(shape => ({ ...shape, x: shape.x + (point.x - gesture.start.x) / this.camera.scale, y: shape.y + (point.y - gesture.start.y) / this.camera.scale }));
			this.host.render();
		} else {
			this.camera.panBy(point.x - gesture.last.x, point.y - gesture.last.y);
			this.host.applyTransform();
		}
		gesture.last = point;
	}

	private handlePointerUp(event: PointerEvent): void {
		if (event.pointerId === this.drawingPointerId) {
			this.drawing.update(this.camera.toWorld(this.viewportPoint(event)));
			this.drawingPointerId = undefined;
			if (this.host.viewport.hasPointerCapture(event.pointerId)) { this.host.viewport.releasePointerCapture(event.pointerId); }
			this.drawing.end();
			event.preventDefault();
			return;
		}
		this.finishGesture(event.pointerId, true);
	}

	private finishGesture(pointerId: number, commit: boolean): void {
		const gesture = this.gesture;
		if (!gesture || pointerId !== gesture.pointerId) { return; }
		this.gesture = undefined;
		if (this.host.viewport.hasPointerCapture(pointerId)) { this.host.viewport.releasePointerCapture(pointerId); }
		this.host.viewport.classList.remove('panning', 'moving');
		if (commit && gesture.preview.length) { this.commands.updateShapes(gesture.preview); }
		if (!this.isDisposed) { this.host.render(); }
	}

	public cancel(): void {
		const pointerId = this.drawingPointerId;
		this.drawingPointerId = undefined;
		this.drawing.cancel();
		if (pointerId !== undefined && this.host.viewport.hasPointerCapture(pointerId)) { this.host.viewport.releasePointerCapture(pointerId); }
		if (this.gesture) { this.finishGesture(this.gesture.pointerId, false); }
	}

}
