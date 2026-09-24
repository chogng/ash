import { CancellationTokenSource, type CancellationToken } from './cancellation.js';
import { canceled, CancellationError, isCancellationError } from './errors.js';
import { AbstractDisposable, DisposableStore, toDisposable, type IDisposable } from './lifecycle.js';

export interface CancelablePromise<T> extends Promise<T> {
	cancel(): void;
}

export function createCancelablePromise<T>(callback: (token: CancellationToken) => PromiseLike<T>): CancelablePromise<T> {
	const source = new CancellationTokenSource();
	let thenable: PromiseLike<T>;
	try {
		thenable = callback(source.token);
	} catch (error) {
		thenable = Promise.reject(error);
	}
	let cancelled = false;
	const promise = new Promise<T>((resolve, reject) => {
		const cancellation = source.token.onCancellationRequested(() => {
			cancelled = true;
			reject(canceled());
		});
		Promise.resolve(thenable).then(value => {
			cancellation.dispose();
			source.dispose();
			if (!cancelled) resolve(value);
			else disposePromiseResult(value);
		}, error => {
			cancellation.dispose();
			source.dispose();
			if (!cancelled) reject(error);
		});
	}) as CancelablePromise<T>;
	promise.cancel = (): void => {
		source.cancel();
		source.dispose();
	};
	return promise;
}

export function raceCancellation<T>(promise: Promise<T>, token: CancellationToken): Promise<T | undefined>;
export function raceCancellation<T>(promise: Promise<T>, token: CancellationToken, defaultValue: T): Promise<T>;
export function raceCancellation<T>(promise: Promise<T>, token: CancellationToken, defaultValue?: T): Promise<T | undefined> {
	if (token.isCancellationRequested) return Promise.resolve(defaultValue);
	return new Promise<T | undefined>((resolve, reject) => {
		const cancellation = token.onCancellationRequested(() => resolve(defaultValue));
		promise.then(resolve, reject).finally(() => cancellation.dispose());
	});
}

export function raceCancellationError<T>(promise: PromiseLike<T>, cancellation: AbortSignal | CancellationToken, message = 'Operation cancelled'): Promise<T> {
	if (isCancellationRequested(cancellation)) return Promise.reject(new CancellationError(message, cancellationReason(cancellation)));
	return new Promise<T>((resolve, reject) => {
		const cancel = (): void => reject(new CancellationError(message, cancellationReason(cancellation)));
		const disposable = subscribeCancellation(cancellation, cancel);
		Promise.resolve(promise).then(resolve, reject).finally(() => disposable.dispose());
	});
}

function isCancellationRequested(cancellation: AbortSignal | CancellationToken): boolean {
	return isAbortSignal(cancellation) ? cancellation.aborted : cancellation.isCancellationRequested;
}

function cancellationReason(cancellation: AbortSignal | CancellationToken): unknown {
	return isAbortSignal(cancellation) ? cancellation.reason : undefined;
}

function subscribeCancellation(cancellation: AbortSignal | CancellationToken, listener: () => void): IDisposable {
	if (!isAbortSignal(cancellation)) return cancellation.onCancellationRequested(listener);
	cancellation.addEventListener('abort', listener, { once: true });
	return toDisposable(() => cancellation.removeEventListener('abort', listener));
}

function isAbortSignal(cancellation: AbortSignal | CancellationToken): cancellation is AbortSignal {
	const candidate = cancellation as AbortSignal;
	return typeof candidate.aborted === 'boolean' && typeof candidate.addEventListener === 'function' && typeof candidate.removeEventListener === 'function';
}

export function rejectIfNotCanceled(error: unknown): undefined {
	if (isCancellationError(error)) return undefined;
	return Promise.reject(error) as never;
}

export function promiseWithResolvers<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T | PromiseLike<T>) => void; readonly reject: (reason?: unknown) => void } {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

/** Returns a cancelable promise that resolves after the provided timeout. */
export function timeout(millis: number): CancelablePromise<void> {
	let settled = false;
	let rejectPromise!: (reason: unknown) => void;
	let promiseHandle: ReturnType<typeof setTimeout>;
	const promise = new Promise<void>((resolve, reject) => {
		rejectPromise = reject;
		const handle = setTimeout(() => {
			settled = true;
			resolve();
		}, millis);
		promiseHandle = handle;
	}) as CancelablePromise<void>;
	promise.cancel = (): void => {
		if (settled) return;
		settled = true;
		clearTimeout(promiseHandle);
		rejectPromise(canceled());
	};
	return promise;
}

/** Owns one replaceable timeout and clears it during disposal. */
export class TimeoutTimer extends AbstractDisposable {
	private timeoutHandle: ReturnType<typeof setTimeout> | undefined;

	public constructor();
	public constructor(runner: () => void, delay: number);
	public constructor(runner?: () => void, delay?: number) {
		super();
		if (runner !== undefined && delay !== undefined) this.setIfNotSet(runner, delay);
	}

	public cancel(): void {
		if (this.timeoutHandle === undefined) return;
		clearTimeout(this.timeoutHandle);
		this.timeoutHandle = undefined;
	}

	public cancelAndSet(runner: () => void, delay: number): void {
		this.assertNotDisposed();
		this.cancel();
		this.set(runner, delay);
	}

	public setIfNotSet(runner: () => void, delay: number): void {
		this.assertNotDisposed();
		if (this.timeoutHandle !== undefined) return;
		this.set(runner, delay);
	}

	protected disposeCore(): void {
		this.cancel();
	}

	private set(runner: () => void, delay: number): void {
		validateDelay(delay);
		this.timeoutHandle = setTimeout(() => {
			this.timeoutHandle = undefined;
			runner();
		}, delay);
	}
}

/** Debounces one callback and owns its pending timeout. */
export class RunOnceScheduler extends AbstractDisposable {
	private timeoutHandle: ReturnType<typeof setTimeout> | undefined;

	public constructor(
		private readonly runner: () => void,
		private defaultDelay: number,
	) {
		super();
		validateDelay(defaultDelay);
	}

	public get delay(): number {
		return this.defaultDelay;
	}

	public set delay(value: number) {
		validateDelay(value);
		this.defaultDelay = value;
	}

	public schedule(delay = this.defaultDelay): void {
		this.assertNotDisposed();
		validateDelay(delay);
		this.cancel();
		this.timeoutHandle = setTimeout(() => {
			this.timeoutHandle = undefined;
			this.runner();
		}, delay);
	}

	public cancel(): void {
		if (this.timeoutHandle === undefined) return;
		clearTimeout(this.timeoutHandle);
		this.timeoutHandle = undefined;
	}

	public isScheduled(): boolean {
		return this.timeoutHandle !== undefined;
	}

	public flush(): void {
		if (!this.isScheduled()) return;
		this.cancel();
		this.runner();
	}

	protected disposeCore(): void {
		this.cancel();
	}
}

export class IntervalTimer extends AbstractDisposable {
	private registration: IDisposable | undefined;

	cancel(): void {
		this.registration?.dispose();
		this.registration = undefined;
	}

	cancelAndSet(runner: () => void, interval: number, context: IntervalTimerContext = globalThis): void {
		this.assertNotDisposed();
		validateDelay(interval);
		this.cancel();
		const handle = context.setInterval(runner, interval);
		this.registration = toDisposable(() => context.clearInterval(handle as never));
	}

	protected disposeCore(): void {
		this.cancel();
	}
}

export interface IntervalTimerContext {
	setInterval(handler: () => void, interval?: number): unknown;
	clearInterval(handle: never): void;
}

export function disposableTimeout(handler: () => void, delay = 0, store?: DisposableStore): IDisposable {
	validateDelay(delay);
	const handle = setTimeout(() => {
		handler();
		if (store) registration.dispose();
	}, delay);
	const registration = toDisposable(() => {
		clearTimeout(handle);
		store?.delete(registration);
	});
	store?.add(registration);
	return registration;
}

export class Delayer<T> implements IDisposable {
	private handle: ReturnType<typeof setTimeout> | undefined;
	private completion: DeferredPromise<T> | undefined;
	private task: (() => T | PromiseLike<T>) | undefined;
	private disposed = false;

	constructor(public defaultDelay: number) {
		validateDelay(defaultDelay);
	}

	trigger(task: () => T | PromiseLike<T>, delay = this.defaultDelay): Promise<T> {
		if (this.disposed) throw new ReferenceError('Delayer is already disposed');
		validateDelay(delay);
		this.task = task;
		if (this.handle !== undefined) clearTimeout(this.handle);
		const completion = this.completion ??= new DeferredPromise<T>();
		this.handle = setTimeout(() => {
			this.handle = undefined;
			this.completion = undefined;
			const pendingTask = this.task;
			this.task = undefined;
			if (!pendingTask) return;
			Promise.resolve().then(pendingTask).then(
				value => void completion.complete(value),
				error => void completion.error(error),
			);
		}, delay);
		return completion.p;
	}

	isTriggered(): boolean {
		return this.handle !== undefined;
	}

	cancel(): void {
		if (this.handle !== undefined) clearTimeout(this.handle);
		this.handle = undefined;
		this.task = undefined;
		const completion = this.completion;
		this.completion = undefined;
		if (completion) void completion.error(canceled());
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.cancel();
	}

	[Symbol.dispose](): void {
		this.dispose();
	}
}

export class DeferredPromise<T> {
	static fromPromise<T>(promise: PromiseLike<T>): DeferredPromise<T> {
		const deferred = new DeferredPromise<T>();
		deferred.settleWith(promise);
		return deferred;
	}

	private readonly resolvePromise: (value: T | PromiseLike<T>) => void;
	private readonly rejectPromise: (reason?: unknown) => void;
	private outcome: { readonly kind: 'resolved'; readonly value: T } | { readonly kind: 'rejected'; readonly reason: unknown } | undefined;
	readonly p: Promise<T>;

	constructor() {
		const resolvers = promiseWithResolvers<T>();
		this.p = resolvers.promise;
		this.resolvePromise = resolvers.resolve;
		this.rejectPromise = resolvers.reject;
	}

	get isRejected(): boolean { return this.outcome?.kind === 'rejected'; }
	get isResolved(): boolean { return this.outcome?.kind === 'resolved'; }
	get isSettled(): boolean { return this.outcome !== undefined; }
	get value(): T | undefined { return this.outcome?.kind === 'resolved' ? this.outcome.value : undefined; }

	complete(value: T): Promise<void> {
		if (this.isSettled) return Promise.resolve();
		this.outcome = { kind: 'resolved', value };
		this.resolvePromise(value);
		return Promise.resolve();
	}

	error(reason: unknown): Promise<void> {
		if (this.isSettled) return Promise.resolve();
		this.outcome = { kind: 'rejected', reason };
		this.rejectPromise(reason);
		return Promise.resolve();
	}

	settleWith(promise: PromiseLike<T>): void {
		Promise.resolve(promise).then(
			value => void this.complete(value),
			error => void this.error(error),
		);
	}
}

export function first<T>(promiseFactories: readonly (() => PromiseLike<T>)[], shouldStop: (value: T) => boolean = value => Boolean(value), defaultValue: T | null = null): Promise<T | null> {
	let index = 0;
	const next = async (): Promise<T | null> => {
		if (index >= promiseFactories.length) return defaultValue;
		const value = await promiseFactories[index++]!();
		return shouldStop(value) ? value : next();
	};
	return next();
}

export class TaskQueue {
	private running = false;
	private pending: Array<{ readonly task: () => unknown | PromiseLike<unknown>; readonly deferred: DeferredPromise<unknown>; readonly skipIfCleared: boolean }> = [];

	schedule<T>(task: () => T | PromiseLike<T>): Promise<T> {
		return this.enqueue(task, false) as Promise<T>;
	}

	scheduleSkipIfCleared<T>(task: () => T | PromiseLike<T>): Promise<T | undefined> {
		return this.enqueue(task, true) as Promise<T | undefined>;
	}

	clearPending(): void {
		const pending = this.pending;
		this.pending = [];
		for (const entry of pending) {
			if (entry.skipIfCleared) void entry.deferred.complete(undefined);
			else void entry.deferred.error(canceled());
		}
	}

	private enqueue<T>(task: () => T | PromiseLike<T>, skipIfCleared: boolean): Promise<T | undefined> {
		const deferred = new DeferredPromise<T | undefined>();
		this.pending.push({ task, deferred: deferred as DeferredPromise<unknown>, skipIfCleared });
		void this.process();
		return deferred.p;
	}

	private async process(): Promise<void> {
		if (this.running) return;
		this.running = true;
		try {
			while (this.pending.length > 0) {
				const entry = this.pending.shift()!;
				try {
					void entry.deferred.complete(await entry.task());
				} catch (error) {
					void entry.deferred.error(error);
				}
			}
		} finally {
			this.running = false;
		}
	}
}

export interface IdleDeadline {
	readonly didTimeout: boolean;
	timeRemaining(): number;
}

export function runWhenGlobalIdle(callback: (deadline: IdleDeadline) => void, timeoutMs?: number): IDisposable {
	const idleGlobal = globalThis as typeof globalThis & {
		requestIdleCallback?: (callback: (deadline: IdleDeadline) => void, options?: { readonly timeout?: number }) => number;
		cancelIdleCallback?: (handle: number) => void;
	};
	if (idleGlobal.requestIdleCallback && idleGlobal.cancelIdleCallback) {
		const handle = idleGlobal.requestIdleCallback(callback, timeoutMs === undefined ? undefined : { timeout: timeoutMs });
		return toDisposable(() => idleGlobal.cancelIdleCallback?.(handle));
	}
	const started = Date.now();
	const handle = setTimeout(() => callback(Object.freeze({
		didTimeout: timeoutMs !== undefined,
		timeRemaining: () => Math.max(0, 15 - (Date.now() - started)),
	})), 0);
	return toDisposable(() => clearTimeout(handle));
}

function validateDelay(delay: number): void {
	if (!Number.isFinite(delay) || delay < 0) throw new RangeError('Timer delay must be a non-negative finite number');
}

function disposePromiseResult(value: unknown): void {
	const disposable = value as { readonly dispose?: unknown } | undefined;
	if (typeof disposable?.dispose === 'function') disposable.dispose();
}
