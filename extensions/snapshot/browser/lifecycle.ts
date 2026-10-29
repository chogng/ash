interface IDisposable {
	dispose(): void;
}
export function toDisposable(callback: () => void): IDisposable {
	let active = true;
	return {
		dispose() {
			if (active) {
				active = false;
				callback();
			}
		},
	};
}
export class DisposableStore {
	private readonly values = new Set<IDisposable>();
	private disposed = false;
	add<T extends IDisposable>(value: T): T {
		if (this.disposed) value.dispose();
		else this.values.add(value);
		return value;
	}
	clear(): void {
		const values = [...this.values];
		this.values.clear();
		for (const value of values) value.dispose();
	}
	dispose(): void {
		this.disposed = true;
		this.clear();
	}
}
export class Disposable {
	private readonly lifetime = new DisposableStore();
	protected isDisposed = false;
	protected _register<T extends IDisposable>(value: T): T {
		return this.lifetime.add(value);
	}
	dispose(): void {
		if (!this.isDisposed) {
			this.isDisposed = true;
			this.lifetime.dispose();
		}
	}
}
type Events = GlobalEventHandlersEventMap & WindowEventMap & { abort: Event; close: Event };
export function addDisposableListener<K extends keyof Events>(
	target: EventTarget,
	type: K,
	listener: (event: Events[K]) => void,
	options?: boolean | AddEventListenerOptions,
): IDisposable {
	target.addEventListener(type, listener as EventListener, options);
	return toDisposable(() => target.removeEventListener(type, listener as EventListener, options));
}
