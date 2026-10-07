import { Event } from './event.js';
import { CancellationError, onUnexpectedError } from './errors.js';
import { DisposableStore, toDisposable, type IDisposable } from './lifecycle.js';

export interface CancellationToken {
	readonly isCancellationRequested: boolean;
	readonly onCancellationRequested: (listener: (event: void) => unknown, thisArgs?: unknown, disposables?: IDisposable[]) => IDisposable;
}

type CancellationEvent = CancellationToken['onCancellationRequested'];

const shortcutEvent: CancellationEvent = (listener, thisArgs, disposables) => {
	const handle = setTimeout(() => listener.call(thisArgs, undefined), 0);
	const disposable = toDisposable(() => clearTimeout(handle));
	disposables?.push(disposable);
	return disposable;
};

export namespace CancellationToken {
	export function isCancellationToken(value: unknown): value is CancellationToken {
		if (value === None || value === Cancelled || value instanceof MutableToken) return true;
		if (!value || typeof value !== 'object') return false;
		const candidate = value as CancellationToken;
		return typeof candidate.isCancellationRequested === 'boolean' && typeof candidate.onCancellationRequested === 'function';
	}

	export const None = Object.freeze<CancellationToken>({
		isCancellationRequested: false,
		onCancellationRequested: Event.None,
	});

	export const Cancelled = Object.freeze<CancellationToken>({
		isCancellationRequested: true,
		onCancellationRequested: shortcutEvent,
	});
}

class MutableToken implements CancellationToken {
	private isCancelled = false;
	private listeners: Set<() => unknown> | undefined;

	public get isCancellationRequested(): boolean {
		return this.isCancelled;
	}

	public get onCancellationRequested(): CancellationEvent {
		if (this.isCancelled) return shortcutEvent;
		return (listener, thisArgs, disposables) => {
			if (this.isCancelled) {
				return shortcutEvent(listener, thisArgs, disposables);
			}
			const callback = (): unknown => listener.call(thisArgs, undefined);
			const listeners = this.listeners ??= new Set<() => unknown>();
			listeners.add(callback);
			const disposable = toDisposable(() => listeners.delete(callback));
			disposables?.push(disposable);
			return disposable;
		};
	}

	public cancel(): void {
		if (this.isCancelled) return;
		this.isCancelled = true;
		// Cancellation is irreversible and must propagate before any buffered state events are published.
		try {
			for (const listener of [...(this.listeners ?? [])]) {
				if (!this.listeners?.has(listener)) {
					continue;
				}
				try {
					listener();
				} catch (error) {
					try {
						onUnexpectedError(error);
					} catch (reportingError) {
						console.error('Unexpected error while reporting a cancellation listener error', error, reportingError);
					}
				}
			}
		} finally {
			this.dispose();
		}
	}

	public dispose(): void {
		this.listeners?.clear();
		this.listeners = undefined;
	}
}

export class CancellationTokenSource implements IDisposable {
	private tokenValue: CancellationToken | undefined;
	private parentListener: IDisposable | undefined;

	constructor(parent?: CancellationToken) {
		this.parentListener = parent?.onCancellationRequested(this.cancel, this);
	}

	public get token(): CancellationToken {
		this.tokenValue ??= new MutableToken();
		return this.tokenValue;
	}

	public cancel(): void {
		if (!this.tokenValue) {
			this.tokenValue = CancellationToken.Cancelled;
			return;
		}
		if (this.tokenValue instanceof MutableToken) this.tokenValue.cancel();
	}

	public dispose(cancel = false): void {
		if (cancel) this.cancel();
		this.parentListener?.dispose();
		this.parentListener = undefined;
		if (!this.tokenValue) {
			this.tokenValue = CancellationToken.None;
		} else if (this.tokenValue instanceof MutableToken) {
			this.tokenValue.dispose();
		}
	}

	public [Symbol.dispose](): void {
		this.dispose();
	}
}

export function cancelOnDispose(store: DisposableStore): CancellationToken {
	const source = new CancellationTokenSource();
	store.add(toDisposable(() => source.dispose(true)));
	return source.token;
}

export class CancellationTokenPool implements IDisposable {
	private readonly source = new CancellationTokenSource();
	private readonly listeners = new DisposableStore();
	private total = 0;
	private cancelled = 0;
	private isDone = false;
	private isDisposed = false;

	public get token(): CancellationToken {
		return this.source.token;
	}

	public add(token: CancellationToken): void {
		if (this.isDone || this.isDisposed) return;
		this.total += 1;
		if (token.isCancellationRequested) {
			this.cancelled += 1;
			this.check();
			return;
		}
		let listener: IDisposable;
		listener = token.onCancellationRequested(() => {
			listener.dispose();
			this.cancelled += 1;
			this.check();
		});
		this.listeners.add(listener);
	}

	public dispose(): void {
		if (this.isDisposed) return;
		this.isDisposed = true;
		this.listeners.dispose();
		this.source.dispose();
	}

	public [Symbol.dispose](): void {
		this.dispose();
	}

	private check(): void {
		if (this.isDone || this.total === 0 || this.total !== this.cancelled) return;
		this.isDone = true;
		this.listeners.dispose();
		this.source.cancel();
	}
}

export function throwIfCancelled(cancellation: AbortSignal | CancellationToken, message?: string): void {
	if (isCancellationRequested(cancellation)) throw new CancellationError(message, cancellationReason(cancellation));
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
	return typeof candidate.aborted === 'boolean'
		&& typeof candidate.addEventListener === 'function'
		&& typeof candidate.removeEventListener === 'function';
}
