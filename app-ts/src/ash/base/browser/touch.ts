import { addDisposableListener, getWindow, stopEvent } from './dom.js';
import { Disposable, DisposableStore, toDisposable, type IDisposable } from '../common/lifecycle.js';

export namespace EventType {
	export const Tap = 'ash-gesturetap';
}

export interface GestureEvent extends MouseEvent {
	readonly initialTarget: EventTarget | null;
	readonly translationX: number;
	readonly translationY: number;
	readonly tapCount: number;
}

interface TapSequence {
	readonly target: HTMLElement;
	readonly initialTarget: EventTarget | null;
	readonly x: number;
	readonly y: number;
}

/** Window-local tap recognition shared by registered controls, including nested targets. */
export class Gesture extends Disposable {
	private static readonly documents = new WeakMap<Document, Gesture>();
	private readonly targets = new Map<HTMLElement, number>();
	private readonly sequences = new Map<number, TapSequence>();
	private previousTap: { target: HTMLElement; time: number; } | undefined;

	public static addTarget(element: HTMLElement): IDisposable {
		const document = element.ownerDocument;
		let gesture = Gesture.documents.get(document);
		if (!gesture) {
			gesture = new Gesture(document);
			Gesture.documents.set(document, gesture);
		}
		const owner = gesture;
		owner.targets.set(element, (owner.targets.get(element) ?? 0) + 1);
		return toDisposable(() => {
			const count = owner.targets.get(element)! - 1;
			if (count > 0) {
				owner.targets.set(element, count);
				return;
			}
			owner.targets.delete(element);
			if (owner.previousTap?.target === element) { owner.previousTap = undefined; }
			for (const [pointer, sequence] of owner.sequences) {
				if (sequence.target === element) { owner.sequences.delete(pointer); }
			}
			if (owner.targets.size === 0) {
				Gesture.documents.delete(document);
				owner.dispose();
			}
		});
	}

	private constructor(document: Document) {
		super();
		const window = getWindow(document);
		const listeners = this._register(new DisposableStore());
		listeners.add(addDisposableListener(window, 'pointerdown', event => {
			if (event.pointerType === 'mouse' || !event.isPrimary || event.button !== 0) { return; }
			const target = event.composedPath().find(candidate => this.targets.has(candidate as HTMLElement)) as HTMLElement | undefined;
			if (!target) { return; }
			// Cancelling pointerdown suppresses compatibility mousedown without blocking other pointer listeners.
			event.preventDefault();
			this.sequences.set(event.pointerId, { target, initialTarget: event.target, x: event.clientX, y: event.clientY });
		}, true));
		listeners.add(addDisposableListener(window, 'pointermove', event => {
			const sequence = this.sequences.get(event.pointerId);
			if (sequence && Math.hypot(event.clientX - sequence.x, event.clientY - sequence.y) > 10) {
				this.sequences.delete(event.pointerId);
			}
		}, true));
		listeners.add(addDisposableListener(window, 'pointercancel', event => this.sequences.delete(event.pointerId), true));
		listeners.add(addDisposableListener(window, 'pointerup', event => {
			const sequence = this.sequences.get(event.pointerId);
			this.sequences.delete(event.pointerId);
			if (!sequence || !sequence.target.isConnected) { return; }
			const now = event.timeStamp;
			const tapCount = this.previousTap?.target === sequence.target && now - this.previousTap.time < 400 ? 2 : 1;
			this.previousTap = tapCount === 1 ? { target: sequence.target, time: now } : undefined;
			const tap = new window.MouseEvent(EventType.Tap, { bubbles: true, cancelable: true, view: window, clientX: event.clientX, clientY: event.clientY, screenX: event.screenX, screenY: event.screenY });
			Object.assign(tap, { initialTarget: sequence.initialTarget, translationX: event.clientX - sequence.x, translationY: event.clientY - sequence.y, tapCount });
			if (!sequence.target.dispatchEvent(tap)) { stopEvent(event); }
		}, true));
		listeners.add(addDisposableListener(window, 'blur', () => this.sequences.clear()));
	}
}
