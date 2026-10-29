import { getWindow, scheduleAtNextAnimationFrame } from '../../../base/browser/dom.js';
import { Emitter, type Event } from '../../../base/common/event.js';
import { Disposable, MutableDisposable, toDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
import { type IDimension } from '../../common/core/2d/dimension.js';

export class ElementSizeObserver extends Disposable {
	private _onDidChange = this._register(new Emitter<void>());
	public readonly onDidChange: Event<void> = this._onDidChange.event;
	private readonly _referenceDomElement: HTMLElement | null;
	private _width: number;
	private _height: number;
	private _resizeObserver: ResizeObserver | null;
	private readonly _frame = this._register(new MutableDisposable<IDisposable>());
	private _frameLocked = false;
	private _resizePending = false;
	private _pendingDimension: IDimension | undefined;

	constructor(referenceDomElement: HTMLElement | null, dimension: IDimension | undefined) {
		super();
		this._referenceDomElement = referenceDomElement;
		this._width = -1;
		this._height = -1;
		this._resizeObserver = null;
		this.measureReferenceDomElement(false, dimension);
		this._register(toDisposable(() => this.stopObserving()));
	}

	public getWidth(): number { return this._width; }
	public getHeight(): number { return this._height; }

	public startObserving(): void {
		if (this._resizeObserver || !this._referenceDomElement) return;
		const observer = new ResizeObserver(entries => {
			if (this._resizeObserver !== observer) return;
			const rect = entries[0]?.contentRect;
			this._pendingDimension = rect ? { width: rect.width, height: rect.height } : undefined;
			this._resizePending = true;
			if (!this._frameLocked) this.flushResize();
		});
		this._resizeObserver = observer;
		observer.observe(this._referenceDomElement);
	}

	public stopObserving(): void {
		this._resizeObserver?.disconnect();
		this._resizeObserver = null;
		this._frame.clear();
		this._frameLocked = false;
		this._resizePending = false;
		this._pendingDimension = undefined;
	}

	public observe(dimension?: IDimension): void { this.measureReferenceDomElement(true, dimension); }

	private flushResize(): void {
		if (!this._resizePending || !this._referenceDomElement) return;
		const dimension = this._pendingDimension;
		this._resizePending = false;
		this._pendingDimension = undefined;
		this._frameLocked = true;
		this._frame.value = scheduleAtNextAnimationFrame(getWindow(this._referenceDomElement), () => {
			this._frame.clear();
			this._frameLocked = false;
			this.flushResize();
		});
		this.observe(dimension);
	}

	private measureReferenceDomElement(emitEvent: boolean, dimension?: IDimension): void {
		let observedWidth = 0;
		let observedHeight = 0;
		if (dimension) {
			observedWidth = dimension.width;
			observedHeight = dimension.height;
		} else if (this._referenceDomElement) {
			observedWidth = this._referenceDomElement.clientWidth;
			observedHeight = this._referenceDomElement.clientHeight;
		}
		observedWidth = Math.max(5, observedWidth);
		observedHeight = Math.max(5, observedHeight);
		if (this._width !== observedWidth || this._height !== observedHeight) {
			this._width = observedWidth;
			this._height = observedHeight;
			if (emitEvent) this._onDidChange.fire();
		}
	}
}
