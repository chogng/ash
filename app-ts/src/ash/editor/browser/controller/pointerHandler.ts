import { addDisposableListener, getWindow } from '../../../base/browser/dom.js';
import { Emitter, type Event } from '../../../base/common/event.js';
import { Disposable, type IDisposable } from '../../../base/common/lifecycle.js';
import { EditorMouseEvent, EditorMouseEventFactory, EditorPointerEventFactory, GlobalEditorPointerMoveMonitor } from '../editorDom.js';

export interface PointerTrackingHandlers {
	readonly onMove: (event: EditorMouseEvent) => void;
	readonly onUp: (event: EditorMouseEvent) => void;
	readonly onCancel: (event: EditorMouseEvent) => void;
	readonly onBlur: () => void;
}

export interface EditorPointerDownEvent {
	readonly event: EditorMouseEvent;
	readonly pointerId: number;
}

/** Owns browser pointer dispatch, capture, and one-window drag sessions. */
export class PointerHandler extends Disposable {
	private readonly pointerDownEmitter = this._register(new Emitter<EditorPointerDownEvent>());
	private readonly contextMenuEmitter = this._register(new Emitter<EditorMouseEvent>());
	private pendingMousePointerId: number | undefined;

	readonly onDidPointerDown: Event<EditorPointerDownEvent> = this.pointerDownEmitter.event;
	readonly onDidContextMenu: Event<EditorMouseEvent> = this.contextMenuEmitter.event;
	readonly targetWindow: Window;

	constructor(readonly element: HTMLElement) {
		super();
		this.targetWindow = getWindow(element);
		const pointerEvents = new EditorPointerEventFactory(element);
		const mouseEvents = new EditorMouseEventFactory(element);
		this._register(pointerEvents.onPointerDown(element, (event, pointerId) => {
			if ((event.browserEvent as PointerEvent).pointerType === 'mouse') {
				this.pendingMousePointerId = pointerId;
				return;
			}
			this.pointerDownEmitter.fire({ event, pointerId });
		}));
		this._register(mouseEvents.onMouseDown(element, event => {
			const pointerId = this.pendingMousePointerId;
			this.pendingMousePointerId = undefined;
			if (pointerId !== undefined) this.pointerDownEmitter.fire({ event, pointerId });
		}));
		this._register(pointerEvents.onPointerUp(element, () => { this.pendingMousePointerId = undefined; }));
		this._register(addDisposableListener<PointerEvent>(element, 'pointercancel', () => { this.pendingMousePointerId = undefined; }));
		this._register(addDisposableListener(this.targetWindow, 'blur', () => { this.pendingMousePointerId = undefined; }));
		this._register(mouseEvents.onContextMenu(element, event => this.contextMenuEmitter.fire(event)));
	}

	startTracking(pointerId: number, initialButtons: number, handlers: PointerTrackingHandlers): IDisposable {
		return new PointerTrackingSession(this.element, pointerId, initialButtons, handlers);
	}

	capturePointer(pointerId: number | undefined): void {
		if (
			pointerId !== undefined &&
			typeof this.element.setPointerCapture === 'function'
		) {
			this.element.setPointerCapture(pointerId);
		}
	}

	releasePointer(pointerId: number | undefined): void {
		if (
			pointerId !== undefined &&
			typeof this.element.hasPointerCapture === 'function' &&
			this.element.hasPointerCapture(pointerId)
		) {
			this.element.releasePointerCapture(pointerId);
		}
	}
}

class PointerTrackingSession extends Disposable {
	constructor(
		element: HTMLElement,
		pointerId: number,
		initialButtons: number,
		handlers: PointerTrackingHandlers,
	) {
		super();
		const monitor = this._register(new GlobalEditorPointerMoveMonitor(element));
		monitor.startMonitoring(element, pointerId, initialButtons, handlers.onMove, browserEvent => {
			if (!browserEvent || browserEvent.type === 'keydown') {
				handlers.onBlur();
				return;
			}
			const event = new EditorMouseEvent(browserEvent as PointerEvent, true, element);
			if (browserEvent.type === 'pointerup') handlers.onUp(event);
			else handlers.onCancel(event);
		});
	}
}
