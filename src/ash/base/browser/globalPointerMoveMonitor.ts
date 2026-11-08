import { Disposable, DisposableStore, toDisposable } from '../common/lifecycle.js';
import { addDisposableListener, getWindow } from './dom.js';

export interface IPointerMoveCallback {
	(event: PointerEvent): void;
}

export interface IOnStopCallback {
	(event?: MouseEvent | KeyboardEvent): void;
}

/** Tracks one pointer drag, including release when the capture target cannot receive events. */
export class GlobalPointerMoveMonitor extends Disposable {
	private readonly listeners = this._register(new DisposableStore());
	private onStop: IOnStopCallback | undefined;

	isMonitoring(): boolean {
		return this.onStop !== undefined;
	}

	startMonitoring(
		element: Element,
		pointerId: number,
		initialButtons: number,
		onMove: IPointerMoveCallback,
		onStop: IOnStopCallback,
		pointerType?: string,
	): void {
		this.stopMonitoring(false);
		this.onStop = onStop;
		const targetWindow = getWindow(element);
		try {
			element.setPointerCapture?.(pointerId);
		} catch {
			// An inactive pointer cannot be captured. Window tracking still works.
		}
		this.listeners.add(toDisposable(() => {
			try {
				if (element.hasPointerCapture?.(pointerId)) {
					element.releasePointerCapture(pointerId);
				}
			} catch {
				// The pointer may have become inactive before cleanup.
			}
		}));
		this.listeners.add(addDisposableListener(targetWindow, 'pointermove', event => {
			if (event.pointerId !== pointerId) { return; }
			if (initialButtons !== 0 && (event.buttons & initialButtons) === 0) {
				this.stopMonitoring(true, event);
				return;
			}
			event.preventDefault();
			onMove(event);
		}));
		for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) {
			this.listeners.add(addDisposableListener(targetWindow, type, event => {
				if (event.pointerId === pointerId) { this.stopMonitoring(true, event); }
			}));
		}
		if (pointerType === 'mouse') {
			this.listeners.add(addDisposableListener(targetWindow, 'mouseup', event => {
				const button = [1, 4, 2, 8, 16][event.button] ?? 0;
				if ((initialButtons & button) !== 0) { this.stopMonitoring(true, event); }
			}));
		}
		this.listeners.add(addDisposableListener(targetWindow, 'blur', () => this.stopMonitoring(true)));
	}

	stopMonitoring(invokeStopCallback: boolean, event?: MouseEvent | KeyboardEvent): void {
		const onStop = this.onStop;
		if (!onStop) { return; }
		this.onStop = undefined;
		this.listeners.clear();
		if (invokeStopCallback) { onStop(event); }
	}

	protected override disposeCore(): void {
		this.stopMonitoring(false);
		super.disposeCore();
	}
}
