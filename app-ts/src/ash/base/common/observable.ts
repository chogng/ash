import type { Event } from "./event.js";
import { Emitter } from "./event.js";
import { DisposableMap, Disposable, DisposableStore, type IDisposable, toDisposable } from "./lifecycle.js";
import { onUnexpectedError } from "./errors.js";

/** Reads an observable while recording it as a dependency of the current computation. */
export interface IReader {
	readObservable<T>(observable: IObservable<T>): T;
}

/** Reader whose store is cleared before every recomputation. */
export interface IReaderWithStore extends IReader {
	readonly store: DisposableStore;
}

/** A synchronously readable value with deterministic change notification. */
export interface IObservable<T> {
	get(): T;
	read(reader: IReader | undefined): T;
	readonly onDidChange: Event<T>;
	map<TMapped>(mapValue: (value: T, reader: IReader) => TMapped): IObservable<TMapped>;
}

/** Transaction passed to setters when several mutations must publish atomically. */
export interface ITransaction {
	/** @internal */
	enqueue(identity: object, notification: () => void): void;
}

/** Observable whose current value can be replaced synchronously. */
export interface ISettableObservable<T> extends IObservable<T> {
	set(value: T, transaction?: ITransaction): void;
}

type ObservableComputation = (reader: IReaderWithStore) => void;

let ambientTransaction: ObservableTransaction | undefined;

/**
 * Batches observable notifications until a synchronous state mutation ends.
 * Nested transactions participate in their outer transaction.
 */
export function transaction<T>(mutation: (transaction: ITransaction) => T): T {
	if (ambientTransaction) return mutation(ambientTransaction);
	const next = new ObservableTransaction();
	ambientTransaction = next;
	try {
		return mutation(next);
	} finally {
		ambientTransaction = undefined;
		next.finish();
	}
}

/** Creates an observable that never changes. */
export function constObservable<T>(value: T): IObservable<T> {
	return new ConstantObservable(value);
}

/** Creates a named mutable observable value. */
export function observableValue<T>(
	_nameOrOwner: string | object,
	initialValue: T,
): ISettableObservable<T> {
	return new ObservableValue(initialValue);
}

/** Converts an event into an observable invalidation signal. */
export function observableSignalFromEvent(
	_nameOrOwner: string | object,
	event: Event<unknown>,
): IObservable<void> {
	return new EventObservable(event);
}

/** Projects the latest value of an event-backed state source. */
export function observableFromEvent<T>(
	_nameOrOwner: string | object,
	event: Event<unknown>,
	getValue: () => T,
): IObservable<T> {
	return new EventValueObservable(event, getValue);
}

/** Creates a cached observable from dynamically tracked dependencies. */
export function derived<T>(
	compute: (reader: IReader) => T,
): IObservable<T> {
	return new DerivedObservable(compute);
}

/** Runs a computation immediately and whenever one of its read dependencies changes. */
export function autorun(compute: (reader: IReader) => void): IDisposable {
	return new ObservableReaction(reader => compute(reader));
}

/**
 * Runs a computation with resources that are cleared before every rerun and
 * when the returned registration is disposed.
 */
export function autorunWithStore(
	compute: (reader: IReader, store: DisposableStore) => void,
): IDisposable {
	return new ObservableReaction(reader => compute(reader, reader.store));
}

export function isObservable(value: unknown): value is IObservable<unknown> {
	return typeof value === "object" &&
		value !== null &&
		typeof (value as Partial<IObservable<unknown>>).get === "function" &&
		typeof (value as Partial<IObservable<unknown>>).read === "function" &&
		typeof (value as Partial<IObservable<unknown>>).onDidChange === "function";
}

abstract class ConvenientObservable<T> implements IObservable<T> {
	abstract get(): T;
	abstract readonly onDidChange: Event<T>;

	read(reader: IReader | undefined): T {
		return reader ? reader.readObservable(this) : this.get();
	}

	map<TMapped>(
		mapValue: (value: T, reader: IReader) => TMapped,
	): IObservable<TMapped> {
		return derived(reader => mapValue(this.read(reader), reader));
	}
}

class ConstantObservable<T> extends ConvenientObservable<T> {
	readonly onDidChange: Event<T> = () => toDisposable(() => {});

	constructor(private readonly value: T) {
		super();
	}

	get(): T {
		return this.value;
	}
}

class ObservableValue<T> extends ConvenientObservable<T>
	implements ISettableObservable<T> {
	private readonly emitter = new Emitter<T>();
	readonly onDidChange = this.emitter.event;

	constructor(private value: T) {
		super();
	}

	get(): T {
		return this.value;
	}

	set(value: T, activeTransaction = ambientTransaction): void {
		if (Object.is(this.value, value)) return;
		this.value = value;
		if (activeTransaction) {
			activeTransaction.enqueue(this, () => this.emitter.fire(this.value));
		} else {
			this.emitter.fire(value);
		}
	}
}

class EventObservable extends ConvenientObservable<void> {
	readonly onDidChange: Event<void>;

	constructor(event: Event<unknown>) {
		super();
		this.onDidChange = listener => event(() => listener(undefined));
	}

	get(): void {}
}

class EventValueObservable<T> extends ConvenientObservable<T> {
	readonly onDidChange: Event<T>;

	constructor(
		event: Event<unknown>,
		private readonly getValue: () => T,
	) {
		super();
		this.onDidChange = listener => event(() => listener(this.getValue()));
	}

	get(): T {
		return this.getValue();
	}
}

class DerivedObservable<T> extends ConvenientObservable<T> {
	private readonly listeners = new Set<(value: T) => void>();
	private reaction: ObservableReaction | undefined;
	private current!: T;
	private initialized = false;

	readonly onDidChange: Event<T> = listener => {
		this.listeners.add(listener);
		if (this.listeners.size === 1) {
			try {
				this.start();
			} catch (error) {
				this.listeners.delete(listener);
				throw error;
			}
		}
		return toDisposable(() => {
			this.listeners.delete(listener);
			if (this.listeners.size === 0) this.stop();
		});
	};

	constructor(private readonly compute: (reader: IReader) => T) {
		super();
	}

	get(): T {
		if (this.reaction && this.initialized) return this.current;
		return this.compute(nonTrackingReader);
	}

	private start(): void {
		this.reaction = new ObservableReaction(reader => {
			const next = this.compute(reader);
			if (!this.initialized) {
				this.current = next;
				this.initialized = true;
				return;
			}
			if (Object.is(this.current, next)) return;
			this.current = next;
			for (const listener of [...this.listeners]) listener(next);
		});
	}

	private stop(): void {
		this.reaction?.dispose();
		this.reaction = undefined;
		this.initialized = false;
	}
}

class ObservableReaction extends Disposable implements IReaderWithStore {
	readonly store = this._register(new DisposableStore());
	private readonly dependencies = this._register(new DisposableMap<IObservable<unknown>, IDisposable>());
	private readonly nextDependencies = new Set<IObservable<unknown>>();
	private running = false;
	private rerunRequested = false;

	constructor(private readonly compute: ObservableComputation) {
		super();
		this._register(toDisposable(() => this.nextDependencies.clear()));
		try {
			this.run();
		} catch (error) {
			this.dispose();
			throw error;
		}
	}

	readObservable<T>(observable: IObservable<T>): T {
		if (!this.running) {
			throw new Error("Observable dependencies can only be read during a computation");
		}
		const dependency = observable as IObservable<unknown>;
		this.nextDependencies.add(dependency);
		if (!this.dependencies.has(dependency)) {
			this.dependencies.set(
				dependency,
				dependency.onDidChange(() => this.invalidate()),
			);
		}
		return observable.get();
	}

	private invalidate(): void {
		if (this.isDisposed) return;
		if (this.running) {
			this.rerunRequested = true;
			return;
		}
		this.runSafely();
	}

	private run(): void {
		do {
			this.rerunRequested = false;
			this.running = true;
			this.nextDependencies.clear();
			this.store.clear();
			try {
				this.compute(this);
			} finally {
				this.running = false;
				for (const [dependency] of this.dependencies) {
					if (this.nextDependencies.has(dependency)) continue;
					this.dependencies.deleteAndDispose(dependency);
				}
			}
		} while (this.rerunRequested && !this.isDisposed);
	}

	private runSafely(): void {
		try {
			this.run();
		} catch (error) {
			onUnexpectedError(error);
		}
	}
}

class ObservableTransaction implements ITransaction {
	private readonly notifications = new Map<object, () => void>();

	enqueue(identity: object, notification: () => void): void {
		this.notifications.set(identity, notification);
	}

	finish(): void {
		while (this.notifications.size > 0) {
			const notifications = [...this.notifications.values()];
			this.notifications.clear();
			for (const notification of notifications) notification();
		}
	}
}

const nonTrackingReader: IReader = {
	readObservable: observable => observable.get(),
};
