import { addDisposableListener } from '../../../../base/browser/dom.js';
import { StandardWheelEvent } from '../../../../base/browser/mouseEvent.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import type { CanvasPoint, CanvasViewport } from '../common/canvasViewport.js';

const WHEEL_ZOOM_SENSITIVITY = 0.005;

export enum CanvasPointerAction {
	None = 'none',
	Handled = 'handled',
	Pan = 'pan',
	Edit = 'edit',
	Move = 'move',
}

export interface CanvasPointerInput {
	readonly event: PointerEvent;
	readonly point: CanvasPoint;
	readonly world: CanvasPoint;
}

/**
 * The participant decides editing semantics; capture and coordinate conversion belong to the controller.
 * Handled completes without capture. Pan navigates without update/end callbacks; Edit and Move
 * deliver preview updates followed by either end or cancel, with capture released before completion.
 */
export interface CanvasInputParticipant {
	begin(input: CanvasPointerInput): CanvasPointerAction;
	update(input: CanvasPointerInput): void;
	end(input: CanvasPointerInput): void;
	cancel(): void;
	canNavigate(): boolean;
}

interface CanvasInputHost {
	readonly domNode: HTMLElement;
	focus(): void;
	applyTransform(): void;
}

interface PointerGesture {
	readonly pointerId: number;
	readonly action: CanvasPointerAction.Pan | CanvasPointerAction.Edit | CanvasPointerAction.Move;
	last: CanvasPoint;
}

export class CanvasInputController extends Disposable {
	private gesture: PointerGesture | undefined;

	constructor(private readonly host: CanvasInputHost, private readonly viewport: CanvasViewport, private readonly participant: CanvasInputParticipant) {
		super();
		this._register(addDisposableListener(host.domNode, 'wheel', (event: WheelEvent) => this.handleWheel(event), { passive: false }));
		this._register(addDisposableListener(host.domNode, 'pointerdown', (event: PointerEvent) => this.handlePointerDown(event)));
		this._register(addDisposableListener(host.domNode, 'pointermove', (event: PointerEvent) => this.handlePointerMove(event)));
		this._register(addDisposableListener(host.domNode, 'pointerup', (event: PointerEvent) => this.handlePointerUp(event)));
		for (const type of ['pointercancel', 'lostpointercapture']) {
			this._register(addDisposableListener(host.domNode, type, (event: PointerEvent) => {
				if (event.pointerId === this.gesture?.pointerId) { this.cancel(); }
			}));
		}
		this._register(toDisposable(() => this.cancel()));
	}

	public get isGesturing(): boolean { return this.gesture !== undefined; }

	private toViewportPoint(event: MouseEvent): CanvasPoint {
		const bounds = this.host.domNode.getBoundingClientRect();
		return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
	}

	private input(event: PointerEvent): CanvasPointerInput {
		const point = this.toViewportPoint(event);
		return { event, point, world: this.viewport.toWorld(point) };
	}

	private handleWheel(event: WheelEvent): void {
		if (this.isGesturing || !this.participant.canNavigate()) { event.preventDefault(); return; }
		const wheel = new StandardWheelEvent(event);
		if (wheel.ctrlKey || wheel.metaKey) { this.viewport.zoomAt(this.toViewportPoint(event), Math.exp(-wheel.deltaY * WHEEL_ZOOM_SENSITIVITY)); }
		else { this.viewport.panBy(-wheel.deltaX, -wheel.deltaY); }
		this.host.applyTransform();
		wheel.stop();
	}

	private handlePointerDown(event: PointerEvent): void {
		if (event.defaultPrevented || !event.isPrimary || (event.button !== 0 && event.button !== 1) || this.isGesturing) { return; }
		const input = this.input(event);
		const action = this.participant.begin(input);
		if (action === CanvasPointerAction.None) { return; }
		if (action !== CanvasPointerAction.Handled) {
			this.gesture = { pointerId: event.pointerId, action, last: input.point };
			this.host.domNode.setPointerCapture(event.pointerId);
			this.host.domNode.classList.toggle('panning', action === CanvasPointerAction.Pan);
			this.host.domNode.classList.toggle('moving', action === CanvasPointerAction.Move);
		}
		this.host.focus();
		event.preventDefault();
	}

	private handlePointerMove(event: PointerEvent): void {
		const gesture = this.gesture;
		if (!gesture || event.pointerId !== gesture.pointerId) { return; }
		const input = this.input(event);
		if (gesture.action === CanvasPointerAction.Pan) {
			this.viewport.panBy(input.point.x - gesture.last.x, input.point.y - gesture.last.y);
			this.host.applyTransform();
		} else {
			this.participant.update(input);
		}
		gesture.last = input.point;
		event.preventDefault();
	}

	private handlePointerUp(event: PointerEvent): void {
		const gesture = this.gesture;
		if (!gesture || event.pointerId !== gesture.pointerId) { return; }
		const input = this.input(event);
		this.releaseGesture();
		if (gesture.action !== CanvasPointerAction.Pan) { this.participant.end(input); }
		event.preventDefault();
	}

	private releaseGesture(): void {
		const gesture = this.gesture;
		// Clear before release: lostpointercapture must not cancel a completed edit.
		this.gesture = undefined;
		if (gesture && this.host.domNode.hasPointerCapture(gesture.pointerId)) { this.host.domNode.releasePointerCapture(gesture.pointerId); }
		this.host.domNode.classList.remove('panning', 'moving');
	}

	public cancel(): void {
		this.releaseGesture();
		this.participant.cancel();
	}
}
