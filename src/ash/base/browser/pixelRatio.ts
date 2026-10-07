import { Emitter, type Event } from '../common/event.js';
import { Disposable, MutableDisposable, toDisposable } from '../common/lifecycle.js';

export interface IPixelRatioMonitor {
	readonly value: number;
	readonly onDidChange: Event<number>;
}

class PixelRatioMonitor extends Disposable implements IPixelRatioMonitor {
	private readonly changeEmitter = this._register(new Emitter<number>());
	private readonly mediaQueryListener = this._register(new MutableDisposable());
	private currentValue: number;
	private notifiedValue: number;

	public readonly onDidChange = this.changeEmitter.event;

	constructor(
		private readonly targetWindow: Window,
		initialValue: number,
		onDispose: () => void,
	) {
		super();
		this.currentValue = initialValue;
		this.notifiedValue = initialValue;
		this.bindMediaQuery();

		const handleResize = (): void => this.handleNativeChange();
		targetWindow.addEventListener('resize', handleResize);
		this._register(toDisposable(() => targetWindow.removeEventListener('resize', handleResize)));

		const handlePageHide = (): void => {
			onDispose();
			this.dispose();
		};
		targetWindow.addEventListener('pagehide', handlePageHide, { once: true });
		this._register(toDisposable(() => targetWindow.removeEventListener('pagehide', handlePageHide)));
	}

	public get value(): number {
		this.currentValue = readPixelRatio(this.targetWindow);
		return this.currentValue;
	}

	private handleNativeChange(): void {
		this.currentValue = readPixelRatio(this.targetWindow);
		this.bindMediaQuery();
		if (this.currentValue === this.notifiedValue) return;
		this.notifiedValue = this.currentValue;
		this.changeEmitter.fire(this.currentValue);
	}

	private bindMediaQuery(): void {
		if (typeof this.targetWindow.matchMedia !== 'function') {
			this.mediaQueryListener.clear();
			return;
		}
		const query = this.targetWindow.matchMedia(`(resolution: ${this.currentValue}dppx)`);
		const handleChange = (): void => this.handleNativeChange();
		query.addEventListener('change', handleChange);
		this.mediaQueryListener.value = toDisposable(() => query.removeEventListener('change', handleChange));
	}
}

class PixelRatioFacade {
	private readonly monitors = new WeakMap<Window, PixelRatioMonitor>();

	public getInstance(targetWindow: Window): IPixelRatioMonitor {
		const current = this.monitors.get(targetWindow);
		if (current) return current;
		const initialValue = readPixelRatio(targetWindow);
		const monitor = new PixelRatioMonitor(targetWindow, initialValue, () => this.monitors.delete(targetWindow));
		this.monitors.set(targetWindow, monitor);
		return monitor;
	}
}

function readPixelRatio(targetWindow: Window): number {
	const value = targetWindow.devicePixelRatio;
	if (!Number.isFinite(value) || value <= 0) throw new RangeError('Window device pixel ratio must be finite and positive');
	return value;
}

export const PixelRatio = new PixelRatioFacade();
