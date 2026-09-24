import { AbstractDisposable, DisposableStore, noneDisposable, toDisposable, type IDisposable } from './lifecycle.js';
import { onUnexpectedError } from './errors.js';

export interface Event<T> {
	(listener: (event: T) => unknown, thisArgs?: unknown, disposables?: IDisposable[] | DisposableStore): IDisposable;
}

export namespace Event {
	export const None: Event<any> = () => noneDisposable;
}

export interface EmitterOptions {
	readonly onWillAddFirstListener?: (emitter: Emitter<any>) => void;
	readonly onDidAddFirstListener?: (emitter: Emitter<any>) => void;
	readonly onDidAddListener?: (emitter: Emitter<any>) => void;
	readonly onWillRemoveListener?: (emitter: Emitter<any>) => void;
	readonly onDidRemoveLastListener?: (emitter: Emitter<any>) => void;
	readonly onListenerError?: (error: unknown) => void;
	readonly deliveryQueue?: EventDeliveryQueue;
}

interface ListenerRegistration<T> {
	readonly listener: (event: T) => unknown;
	readonly thisArgs: unknown;
	isActive: boolean;
}

interface BufferedEventDelivery {
	deliver(): void;
}

export interface EventDeliveryQueue {
	readonly _isEventDeliveryQueue: true;
}

export function createEventDeliveryQueue(): EventDeliveryQueue {
	return new EventDeliveryQueueImpl();
}

class EventDeliveryQueueImpl implements EventDeliveryQueue {
	readonly _isEventDeliveryQueue = true;
	private readonly deliveries: BufferedEventDelivery[] = [];
	private isDelivering = false;

	enqueue(deliveries: readonly BufferedEventDelivery[]): void {
		this.deliveries.push(...deliveries);
		if (this.isDelivering) return;
		this.isDelivering = true;
		try {
			for (let index = 0; index < this.deliveries.length; index += 1) {
				this.deliveries[index]!.deliver();
			}
		} finally {
			this.deliveries.length = 0;
			this.isDelivering = false;
		}
	}
}

let activeEventBuffer: BufferedEventDelivery[] | undefined;

export function runWithBufferedEvents<T>(mutation: () => T): T {
	if (typeof mutation !== 'function') {
		throw new TypeError('Buffered event mutation must be a function');
	}

	const inherited = activeEventBuffer;
	if (inherited) {
		const savepoint = inherited.length;
		try {
			return mutation();
		} catch (error) {
			inherited.length = savepoint;
			throw error;
		}
	}

	const buffer: BufferedEventDelivery[] = [];
	activeEventBuffer = buffer;
	let result!: T;
	let failure: unknown;
	let failed = false;
	try {
		result = mutation();
		if (typeof (result as { readonly then?: unknown } | undefined)?.then === 'function') {
			throw new TypeError('Buffered event mutations must be synchronous');
		}
	} catch (error) {
		buffer.length = 0;
		failure = error;
		failed = true;
	} finally {
		activeEventBuffer = undefined;
	}

	if (failed) {
		throw failure;
	}
	for (const delivery of buffer) {
		delivery.deliver();
	}
	return result;
}

export class Emitter<T> extends AbstractDisposable {
	private readonly listeners = new Set<ListenerRegistration<T>>();
	private readonly deliveryQueue: EventDeliveryQueueImpl;

	public readonly event: Event<T> = (listener, thisArgs, disposables) => {
		this.assertNotDisposed();
		const isFirstListener = this.listeners.size === 0;
		if (isFirstListener) {
			this.options.onWillAddFirstListener?.(this);
		}

		const registration: ListenerRegistration<T> = { listener, thisArgs, isActive: true };
		this.listeners.add(registration);
		if (isFirstListener) {
			this.options.onDidAddFirstListener?.(this);
		}
		this.options.onDidAddListener?.(this);

		const disposable = toDisposable(() => this.removeListener(registration));
		return addDisposable(disposable, disposables);
	};

	constructor(private readonly options: EmitterOptions = {}) {
		super();
		this.deliveryQueue = options.deliveryQueue
			? options.deliveryQueue as EventDeliveryQueueImpl
			: new EventDeliveryQueueImpl();
	}

	public fire(event: T): void {
		if (this.isDisposed || this.listeners.size === 0) {
			return;
		}

		const deliveries = [...this.listeners].map(registration => ({
			deliver: () => this.deliver(registration, event),
		}));
		if (activeEventBuffer) {
			activeEventBuffer.push({ deliver: () => this.enqueue(deliveries) });
			return;
		}
		this.enqueue(deliveries);
	}

	public hasListeners(): boolean {
		return this.listeners.size > 0;
	}

	protected override disposeCore(): void {
		const hadListeners = this.listeners.size > 0;
		for (const registration of this.listeners) {
			registration.isActive = false;
		}
		this.listeners.clear();
		if (hadListeners) {
			this.options.onDidRemoveLastListener?.(this);
		}
	}

	private removeListener(registration: ListenerRegistration<T>): void {
		if (!registration.isActive) {
			return;
		}
		this.options.onWillRemoveListener?.(this);
		registration.isActive = false;
		this.listeners.delete(registration);
		if (this.listeners.size === 0) {
			this.options.onDidRemoveLastListener?.(this);
		}
	}

	private enqueue(deliveries: readonly BufferedEventDelivery[]): void {
		this.deliveryQueue.enqueue(deliveries);
	}

	private deliver(registration: ListenerRegistration<T>, event: T): void {
		if (!registration.isActive) return;
		try {
			registration.listener.call(registration.thisArgs, event);
		} catch (error) {
			this.reportListenerError(error);
		}
	}

	private reportListenerError(error: unknown): void {
		try {
			(this.options.onListenerError ?? onUnexpectedError)(error);
		} catch (reportingError) {
			console.error('Unexpected error while reporting an event listener error', error, reportingError);
		}
	}
}

export class PauseableEmitter<T> extends Emitter<T> {
	private pauseCount = 0;
	private readonly eventQueue: T[] = [];
	private readonly merge: ((events: readonly T[]) => T) | undefined;

	constructor(options: EmitterOptions & { readonly merge?: (events: readonly T[]) => T } = {}) {
		super(options);
		this.merge = options.merge;
	}

	get isPaused(): boolean {
		return this.pauseCount > 0;
	}

	pause(): void {
		this.assertNotDisposed();
		this.pauseCount += 1;
	}

	resume(): void {
		this.assertNotDisposed();
		if (this.pauseCount === 0 || --this.pauseCount > 0) return;
		if (this.merge && this.eventQueue.length > 0) {
			const events = this.eventQueue.splice(0);
			super.fire(this.merge(events));
			return;
		}
		while (!this.isPaused && this.eventQueue.length > 0) {
			super.fire(this.eventQueue.shift()!);
		}
	}

	override fire(event: T): void {
		if (this.isPaused) {
			this.eventQueue.push(event);
			return;
		}
		super.fire(event);
	}

	protected override disposeCore(): void {
		this.eventQueue.length = 0;
		this.pauseCount = 0;
		super.disposeCore();
	}
}

export interface IValueWithChangeEvent<T> {
	readonly onDidChange: Event<void>;
	readonly value: T;
}

export class ValueWithChangeEvent<T> implements IValueWithChangeEvent<T> {
	static const<T>(value: T): IValueWithChangeEvent<T> {
		return Object.freeze({ onDidChange: Event.None, value });
	}

	private readonly changeEmitter = new Emitter<void>();
	readonly onDidChange = this.changeEmitter.event;

	constructor(private currentValue: T) {}

	get value(): T {
		return this.currentValue;
	}

	set value(value: T) {
		if (Object.is(value, this.currentValue)) return;
		this.currentValue = value;
		this.changeEmitter.fire(undefined);
	}
}

function addDisposable<T extends IDisposable>(disposable: T, target: IDisposable[] | DisposableStore | undefined): T {
	try {
		if (Array.isArray(target)) {
			target.push(disposable);
		} else {
			target?.add(disposable);
		}
		return disposable;
	} catch (error) {
		disposable.dispose();
		throw error;
	}
}
