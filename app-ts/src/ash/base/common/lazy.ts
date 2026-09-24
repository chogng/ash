const enum LazyState {
	Uninitialized,
	Initializing,
	Initialized,
}

/** Evaluates a value once on first access and retains its result or failure. */
export class Lazy<T> {
	private state = LazyState.Uninitialized;
	private result: T | undefined;
	private failure: unknown;
	private failed = false;

	constructor(private readonly create: () => T) {}

	get hasValue(): boolean {
		return this.state === LazyState.Initialized;
	}

	get value(): T {
		if (this.state === LazyState.Initializing) {
			throw new Error("Cannot read a lazy value while it is being initialized");
		}
		if (this.state === LazyState.Uninitialized) {
			this.state = LazyState.Initializing;
			try {
				this.result = this.create();
			} catch (error) {
				this.failure = error;
				this.failed = true;
			} finally {
				this.state = LazyState.Initialized;
			}
		}
		if (this.failed) throw this.failure;
		return this.result as T;
	}

	get rawValue(): T | undefined {
		return this.result;
	}
}
