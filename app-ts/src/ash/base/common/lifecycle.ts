/**
 * A project resource that supports both explicit `.dispose()` calls and the
 * ECMAScript `using` protocol.
 *
 * Implementations must release synchronously and idempotently.
 */
export interface IDisposable extends globalThis.Disposable {
	dispose(): void;
}

/** Owns one disposable value while exposing the value to its consumer. */
export interface IReference<T> extends IDisposable {
	readonly object: T;
}

export function isDisposable<T>(value: T): value is T & IDisposable {
	if (typeof value !== 'object' || value === null) return false;
	const dispose = Reflect.get(value, 'dispose');
	return typeof dispose === 'function' && dispose.length === 0;
}

/** A reference whose value is borrowed and therefore never disposed here. */
export class ImmortalReference<T> implements IReference<T> {
	readonly object: T;
	constructor(object: T) {
		this.object = object;
	}
	dispose(): void {}
	[Symbol.dispose](): void {}
}

/**
 * A project resource that supports both explicit `.disposeAsync()` calls and
 * the ECMAScript `await using` protocol.
 */
export interface IAsyncDisposable extends globalThis.AsyncDisposable {
	disposeAsync(): Promise<void>;
}

/** Reusable cleanup handle for contracts that intentionally own no resource. */
export const noneDisposable: IDisposable = Object.freeze({
	dispose(): void {},
	[Symbol.dispose](): void {},
});

/** @internal */
export type TrackableDisposable = globalThis.Disposable | globalThis.AsyncDisposable;

function isNoneDisposable(disposable: TrackableDisposable): boolean {
	return Object.is(disposable, noneDisposable);
}

/**
 * Internal observation contract used by development-time disposable tracking.
 *
 * Implementations must never affect lifecycle correctness when no tracker is
 * installed.
 *
 * @internal
 */
export interface IDisposableTracker {
	trackDisposable(
		disposable: TrackableDisposable,
		label?: string,
	): void;
	validateDisposableOwner(
		disposable: TrackableDisposable,
		owner: TrackableDisposable,
	): void;
	setDisposableOwner(
		disposable: TrackableDisposable,
		owner: TrackableDisposable,
	): void;
	clearDisposableOwner(disposable: TrackableDisposable): void;
	markAsDisposed(disposable: TrackableDisposable): void;
	markAsSingleton(disposable: TrackableDisposable): void;
}

let disposableTracker: IDisposableTracker | undefined;

/** @internal */
export function registerDisposableTracker(
	tracker: IDisposableTracker,
): globalThis.Disposable {
	if (disposableTracker) {
		throw new Error("A disposable tracker is already installed");
	}
	disposableTracker = tracker;
	let disposed = false;
	return {
		[Symbol.dispose](): void {
			if (disposed) return;
			if (disposableTracker !== tracker) {
				throw new Error("The installed disposable tracker changed unexpectedly");
			}
			disposed = true;
			disposableTracker = undefined;
		},
	};
}

/** @internal */
export function trackDisposable<T extends TrackableDisposable>(
	disposable: T,
	label?: string,
): T {
	if (!isNoneDisposable(disposable)) disposableTracker?.trackDisposable(disposable, label);
	return disposable;
}

/** @internal */
export function validateDisposableOwner(
	disposable: TrackableDisposable,
	owner: TrackableDisposable,
): void {
	if (!isNoneDisposable(disposable)) disposableTracker?.validateDisposableOwner(disposable, owner);
}

/** @internal */
export function setDisposableOwner(
	disposable: TrackableDisposable,
	owner: TrackableDisposable,
): void {
	if (!isNoneDisposable(disposable)) disposableTracker?.setDisposableOwner(disposable, owner);
}

function clearDisposableOwner(disposable: TrackableDisposable): void {
	if (!isNoneDisposable(disposable)) disposableTracker?.clearDisposableOwner(disposable);
}

/** @internal */
export function markAsDisposed(disposable: TrackableDisposable): void {
	if (!isNoneDisposable(disposable)) disposableTracker?.markAsDisposed(disposable);
}

/** Marks a process-lifetime disposable as intentionally not owned by a disposable store. */
export function markAsSingleton<T extends IDisposable>(singleton: T): T {
	if (!isNoneDisposable(singleton)) disposableTracker?.markAsSingleton(singleton);
	return singleton;
}

export interface DisposableLeak {
	readonly disposable: TrackableDisposable;
	readonly label: string;
	readonly ownerLabel?: string;
	readonly createdAt?: string;
}

interface DisposableRecord {
	readonly disposable: TrackableDisposable;
	readonly label: string;
	readonly createdAt?: string;
	readonly children: Set<TrackableDisposable>;
	isSingleton: boolean;
	owner?: TrackableDisposable;
}

/**
 * Development-time ownership graph for diagnosing leaked or multiply-owned
 * disposables.
 *
 * The tracker intentionally retains live disposables strongly. Install it only
 * in development or tests and call `assertNoLeaks` at a well-defined scope
 * boundary.
 */
export class DisposableTracker implements IDisposableTracker {
	private readonly records = new Map<TrackableDisposable, DisposableRecord>();
	private readonly disposed = new WeakSet<object>();

	trackDisposable(
		disposable: TrackableDisposable,
		label = disposableLabel(disposable),
	): void {
		if (this.disposed.has(disposable)) {
			throw new ReferenceError(`Cannot track disposed disposable: ${label}`);
		}
		if (this.records.has(disposable)) return;
		this.records.set(disposable, {
			disposable,
			label,
			createdAt: captureCreationStack(),
			children: new Set(),
			isSingleton: false,
		});
	}

	validateDisposableOwner(
		disposable: TrackableDisposable,
		owner: TrackableDisposable,
	): void {
		if (disposable === owner) {
			throw new Error("A disposable cannot own itself");
		}
		if (this.disposed.has(disposable)) {
			throw new ReferenceError(
				`Cannot own disposed disposable: ${disposableLabel(disposable)}`,
			);
		}
		const existingOwner = this.records.get(disposable)?.owner;
		if (existingOwner && existingOwner !== owner) {
			throw new Error(
				`${this.label(disposable)} already belongs to ${this.label(existingOwner)}`,
			);
		}
		for (
			let ancestor: TrackableDisposable | undefined = owner;
			ancestor;
			ancestor = this.records.get(ancestor)?.owner
		) {
			if (ancestor === disposable) {
				throw new Error("Disposable ownership cannot contain a cycle");
			}
		}
	}

	setDisposableOwner(
		disposable: TrackableDisposable,
		owner: TrackableDisposable,
	): void {
		this.validateDisposableOwner(disposable, owner);
		this.trackDisposable(owner);
		this.trackDisposable(disposable);
		const record = this.records.get(disposable);
		if (!record || record.owner === owner) return;
		record.owner = owner;
		this.records.get(owner)?.children.add(disposable);
	}

	clearDisposableOwner(disposable: TrackableDisposable): void {
		const record = this.records.get(disposable);
		if (!record?.owner) return;
		this.records.get(record.owner)?.children.delete(disposable);
		record.owner = undefined;
	}

	markAsDisposed(disposable: TrackableDisposable): void {
		const record = this.records.get(disposable);
		if (record) {
			for (const child of [...record.children]) {
				this.markAsDisposed(child);
			}
			if (record.owner) {
				this.records.get(record.owner)?.children.delete(disposable);
			}
			this.records.delete(disposable);
		}
		this.disposed.add(disposable);
	}

	markAsSingleton(disposable: TrackableDisposable): void {
		this.trackDisposable(disposable);
		const record = this.records.get(disposable);
		if (record) record.isSingleton = true;
	}

	leaks(): readonly DisposableLeak[] {
		return [...this.records.values()].filter(record => !record.isSingleton).map((record) => ({
			disposable: record.disposable,
			label: record.label,
			ownerLabel: record.owner ? this.label(record.owner) : undefined,
			createdAt: record.createdAt,
		}));
	}

	assertNoLeaks(): void {
		const leaks = this.leaks();
		if (leaks.length === 0) return;
		const details = leaks.map((leak) => {
			const ownership = leak.ownerLabel
				? ` owned by ${leak.ownerLabel}`
				: " without an owner";
			return `${leak.label}${ownership}${leak.createdAt ? `\n${leak.createdAt}` : ""}`;
		});
		throw new Error(
			`Detected ${leaks.length} undisposed disposable(s):\n${details.join("\n")}`,
		);
	}

	private label(disposable: TrackableDisposable): string {
		return this.records.get(disposable)?.label ?? disposableLabel(disposable);
	}
}

/**
 * Installs the development tracker for the current JavaScript realm.
 */
export function installDisposableTracker(
	tracker: DisposableTracker,
): globalThis.Disposable {
	return registerDisposableTracker(tracker);
}

function disposableLabel(disposable: TrackableDisposable): string {
	const constructor = (disposable as object).constructor;
	return typeof constructor === "function" && constructor.name
		? constructor.name
		: "Disposable";
}

function captureCreationStack(): string | undefined {
	return new Error().stack
		?.split("\n")
		.slice(3)
		.join("\n");
}

/**
 * Provides tracked, idempotent synchronous disposal without owning a resource
 * collection. Subclasses implement cleanup in `disposeCore`.
 */
export abstract class AbstractDisposable implements IDisposable {
	private disposedState = false;

	constructor() {
		trackDisposable(this);
	}

	public get isDisposed(): boolean {
		return this.disposedState;
	}

	protected assertNotDisposed(): void {
		if (this.disposedState) throw new ReferenceError(`${this.constructor.name} is already disposed`);
	}

	public dispose(): void {
		if (this.disposedState) return;
		this.disposedState = true;
		try {
			this.disposeCore();
		} finally {
			markAsDisposed(this);
		}
	}

	public [Symbol.dispose](): void {
		this.dispose();
	}

	protected abstract disposeCore(): void;
}

/**
 * Creates an idempotent project disposable from a cleanup callback.
 */
export function toDisposable(fn: () => void): IDisposable {
	let disposed = false;
	const dispose = (): void => {
		if (disposed) return;
		disposed = true;
		try {
			fn();
		} finally {
			markAsDisposed(resource);
		}
	};
	const resource: IDisposable = {
		dispose,
		[Symbol.dispose]: dispose,
	};
	trackDisposable(resource, "toDisposable");
	return resource;
}

/**
 * Owns synchronous resources with the standard `DisposableStack` semantics.
 *
 * Resources are released in reverse registration order. Once disposed, new
 * registrations throw `ReferenceError`, matching the standard stack.
 */
export class DisposableStore extends AbstractDisposable {
	private stack = new DisposableStack();
	private resources = new Set<IDisposable>();

	public clear(): void {
		if (this.isDisposed) return;
		const current = this.stack;
		const resources = this.resources;
		this.stack = new DisposableStack();
		this.resources = new Set();
		try {
			current.dispose();
		} finally {
			for (const resource of resources) markAsDisposed(resource);
		}
	}

	public add<T extends IDisposable | null | undefined>(resource: T): T {
		if (!resource) return resource;
		if ((resource as unknown) === this) {
			throw new Error("Cannot register a disposable store on itself");
		}
		this.assertNotDisposed();
		validateDisposableOwner(resource, this);
		const owned = this.stack.use(resource);
		setDisposableOwner(resource, this);
		this.resources.add(resource);
		return owned;
	}

	public has(resource: IDisposable): boolean {
		return this.resources.has(resource);
	}

	/** Removes a resource without disposing it, transferring ownership to the caller. */
	public delete(resource: IDisposable): boolean {
		if (this.isDisposed || !this.resources.delete(resource)) return false;
		clearDisposableOwner(resource);
		const replacement = new DisposableStack();
		for (const remaining of this.resources) replacement.use(remaining);
		this.stack = replacement;
		return true;
	}

	protected override disposeCore(): void {
		const current = this.stack;
		const resources = this.resources;
		this.stack = new DisposableStack();
		this.resources = new Set();
		try {
			current.dispose();
		} finally {
			for (const resource of resources) markAsDisposed(resource);
		}
	}
}

/**
 * Base class for composite objects that own independently created resources.
 * Register resources through `_register`; the protected store disposes them
 * in reverse registration order.
 */
export abstract class Disposable extends AbstractDisposable {
	public static readonly None: IDisposable = noneDisposable;
	protected readonly _store = new DisposableStore();

	constructor() {
		super();
		setDisposableOwner(this._store, this);
	}

	protected _register<T extends IDisposable | null | undefined>(resource: T): T {
		if (resource && (resource as unknown) === this) {
			throw new Error("Cannot register a disposable on itself");
		}
		return this._store.add(resource);
	}

	protected override disposeCore(): void {
		this._store.dispose();
	}
}

/**
 * Owns asynchronous and synchronous resources with the standard
 * `AsyncDisposableStack` semantics.
 */
export class AsyncDisposableStore implements IAsyncDisposable {
	private readonly stack = new AsyncDisposableStack();
	private resources = new Set<globalThis.AsyncDisposable | globalThis.Disposable>();
	private disposePromise: Promise<void> | undefined;

	constructor() {
		trackDisposable(this);
	}

	public get isDisposed(): boolean {
		return this.stack.disposed;
	}

	public add<
		T extends globalThis.AsyncDisposable | globalThis.Disposable | null | undefined,
	>(resource: T): T {
		if (!resource) return resource;
		if ((resource as unknown) === this) {
			throw new Error("Cannot register an async disposable store on itself");
		}
		if (this.isDisposed) {
			throw new ReferenceError("AsyncDisposableStore is already disposed");
		}
		validateDisposableOwner(resource, this);
		const owned = this.stack.use(resource);
		setDisposableOwner(resource, this);
		this.resources.add(resource);
		return owned;
	}

	public disposeAsync(): Promise<void> {
		if (!this.disposePromise) {
			this.disposePromise = this.stack.disposeAsync().finally(() => {
				const resources = this.resources;
				this.resources = new Set();
				for (const resource of resources) markAsDisposed(resource);
				markAsDisposed(this);
			});
		}
		return this.disposePromise;
	}

	public [Symbol.asyncDispose](): Promise<void> {
		return this.disposeAsync();
	}
}

/**
 * Owns one replaceable synchronous resource.
 */
export class MutableDisposable<T extends IDisposable> extends AbstractDisposable {
	private _value: T | undefined;

	public get value(): T | undefined {
		return this.isDisposed ? undefined : this._value;
	}

	public set value(next: T | undefined) {
		if (this.isDisposed || next === this._value) return;
		if (next) validateDisposableOwner(next, this);
		const previous = this._value;
		this._value = next;
		if (next) setDisposableOwner(next, this);
		if (previous) {
			try {
				previous[Symbol.dispose]();
			} finally {
				markAsDisposed(previous);
			}
		}
	}

	public clear(): void {
		this.value = undefined;
	}

	public clearAndLeak(): T | undefined {
		const previous = this._value;
		this._value = undefined;
		if (previous) clearDisposableOwner(previous);
		return previous;
	}

	protected override disposeCore(): void {
		const current = this._value;
		this._value = undefined;
		try {
			current?.[Symbol.dispose]();
		} finally {
			if (current) markAsDisposed(current);
		}
	}
}

/** Owns disposable resources whose lifetime follows stable keys. */
export class DisposableMap<K, V extends IDisposable = IDisposable> extends AbstractDisposable implements Iterable<[K, V]> {
	private readonly resources = new Map<K, V>();

	public get(key: K): V | undefined {
		return this.resources.get(key);
	}

	public has(key: K): boolean {
		return this.resources.has(key);
	}

	public set(key: K, resource: V): V {
		this.assertNotDisposed();
		const previous = this.resources.get(key);
		if (previous === resource) return resource;
		validateDisposableOwner(resource, this);
		if (previous) {
			this.resources.delete(key);
			this.disposeResource(previous);
		}
		setDisposableOwner(resource, this);
		this.resources.set(key, resource);
		return resource;
	}

	public deleteAndDispose(key: K): boolean {
		const resource = this.resources.get(key);
		if (!resource) return false;
		this.resources.delete(key);
		this.disposeResource(resource);
		return true;
	}

	public deleteAndLeak(key: K): V | undefined {
		const resource = this.resources.get(key);
		if (!resource) return undefined;
		this.resources.delete(key);
		clearDisposableOwner(resource);
		return resource;
	}

	public keys(): IterableIterator<K> {
		return this.resources.keys();
	}

	public [Symbol.iterator](): IterableIterator<[K, V]> {
		return this.resources[Symbol.iterator]();
	}

	protected override disposeCore(): void {
		if (this.resources.size === 0) return;
		const resources = [...this.resources.values()];
		this.resources.clear();
		const stack = new DisposableStack();
		for (const resource of resources) stack.use(resource);
		try {
			stack.dispose();
		} finally {
			for (const resource of resources) markAsDisposed(resource);
		}
	}

	private disposeResource(resource: V): void {
		try {
			resource[Symbol.dispose]();
		} finally {
			markAsDisposed(resource);
		}
	}
}

/**
 * Combines resources into one project disposable.
 */
export function combinedDisposable(
	...resources: readonly IDisposable[]
): IDisposable {
	const store = new DisposableStore();
	for (const resource of resources) store.add(resource);
	return store;
}

export function dispose<T extends { dispose(): void }>(resource: T): T;
export function dispose<T extends { dispose(): void }>(resource: T | undefined): T | undefined;
export function dispose<T extends { dispose(): void }, TCollection extends Iterable<T>>(resources: TCollection): TCollection;
export function dispose<T extends { dispose(): void }>(resources: Array<T>): Array<T>;
export function dispose<T extends { dispose(): void }>(resources: ReadonlyArray<T>): ReadonlyArray<T>;
export function dispose<T extends { dispose(): void }>(value: T | Iterable<T> | undefined): T | Iterable<T> | undefined {
	if (!value) {
		return value;
	}
	if (!(Symbol.iterator in Object(value))) {
		(value as T).dispose();
		return value;
	}

	const errors: unknown[] = [];
	for (const resource of value as Iterable<T>) {
		try {
			resource.dispose();
		} catch (error) {
			errors.push(error);
		}
	}
	if (errors.length === 1) {
		throw errors[0];
	}
	if (errors.length > 1) {
		throw new AggregateError(errors, 'Multiple resources failed to dispose');
	}
	return Array.isArray(value) ? [] : value;
}
