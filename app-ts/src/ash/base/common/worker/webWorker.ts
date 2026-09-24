import { Emitter, type Event } from '../event.js';
import { toError } from '../errors.js';
import { Disposable, type IDisposable, toDisposable } from '../lifecycle.js';

export interface WebWorkerPort extends IDisposable {
	readonly onMessage: Event<unknown>;
	send(message: unknown): void;
}

export interface WebWorkerClientPort extends WebWorkerPort {
	readonly onFailure: Event<unknown>;
}

export interface WebWorkerChannel {
	readonly protocol: string;
	readonly version: number;
}

export class WebWorkerRemoteError extends Error {
	constructor(readonly remoteName: string, message: string) {
		super(message);
		this.name = 'WebWorkerRemoteError';
	}
}

interface PendingRequest {
	readonly resolve: (value: unknown) => void;
	readonly reject: (error: unknown) => void;
	readonly removeAbort: () => void;
}

/** Owns request cancellation and failure for one structured-clone channel. */
export class WebWorkerClient extends Disposable {
	private readonly pending = new Map<number, PendingRequest>();
	private readonly failureEmitter = this._register(new Emitter<Error>());
	private terminalFailure: Error | undefined;
	public readonly onDidFail = this.failureEmitter.event;

	constructor(private readonly port: WebWorkerClientPort, private readonly channel: WebWorkerChannel) {
		super();
		this._register(port);
		this._register(port.onMessage(value => this.receive(value)));
		this._register(port.onFailure(error => this.invalidate(error)));
		this._register(toDisposable(() => this.rejectPending(new ReferenceError('Worker client is disposed'))));
	}

	public request(requestId: number, data: object, signal: AbortSignal): Promise<unknown> {
		this.ensureAvailable();
		assertRequestId(requestId);
		signal.throwIfAborted();
		if (this.pending.has(requestId)) {
			throw new RangeError(`Worker request '${requestId}' is already pending`);
		}
		return new Promise((resolve, reject) => {
			const abort = (): void => {
				const pending = this.pending.get(requestId);
				if (!pending) {
					return;
				}
				this.pending.delete(requestId);
				pending.removeAbort();
				try {
					this.send('cancel', { requestId });
				} catch {
					// Cancellation still settles locally when the transport is already closed.
				}
				const error = signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason ?? 'Worker request cancelled'));
				if (!(signal.reason instanceof Error)) {
					error.name = 'AbortError';
				}
				reject(error);
			};
			signal.addEventListener('abort', abort, { once: true });
			const pending = { resolve, reject, removeAbort: () => signal.removeEventListener('abort', abort) };
			this.pending.set(requestId, pending);
			try {
				this.send('request', { ...data, requestId });
			} catch (error) {
				this.pending.delete(requestId);
				pending.removeAbort();
				reject(error);
			}
		});
	}

	public send(kind: string, data: object): void {
		this.ensureAvailable();
		this.port.send({ ...data, ...this.channel, kind });
	}

	public invalidate(error: unknown): void {
		if (this.isDisposed || this.terminalFailure) {
			return;
		}
		this.terminalFailure = toError(error);
		this.rejectPending(this.terminalFailure);
		this.failureEmitter.fire(this.terminalFailure);
	}

	public ensureAvailable(): void {
		this.assertNotDisposed();
		if (this.terminalFailure) {
			throw this.terminalFailure;
		}
	}

	private receive(value: unknown): void {
		if (!isChannelMessage(value, this.channel)) {
			return;
		}
		try {
			assertVersion(value, this.channel);
			if (value.kind === 'notificationFailure') {
				this.invalidate(decodeError(value.error));
				return;
			}
			assertRequestId(value.requestId);
			if (value.kind !== 'result' && value.kind !== 'failure') {
				throw new TypeError('Unknown worker response');
			}
			const error = value.kind === 'failure' ? decodeError(value.error) : undefined;
			const pending = this.pending.get(value.requestId);
			if (!pending) {
				return;
			}
			this.pending.delete(value.requestId);
			pending.removeAbort();
			if (error) {
				pending.reject(error);
			}
			else {
				pending.resolve(value.result);
			}
		} catch (error) {
			this.invalidate(error);
		}
	}

	private rejectPending(error: Error): void {
		const requests = [...this.pending.values()];
		this.pending.clear();
		for (const pending of requests) {
			pending.removeAbort();
			pending.reject(error);
		}
	}
}

export interface WebWorkerRequestHandler {
	handleRequest(message: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
	handleNotification(message: Record<string, unknown>): void;
}

/** Dispatches messages without knowing the application payload or its state. */
export class WebWorkerServer extends Disposable {
	private readonly active = new Map<number, AbortController>();

	constructor(private readonly port: WebWorkerPort, private readonly channel: WebWorkerChannel, private readonly handler: WebWorkerRequestHandler) {
		super();
		this._register(port);
		this._register(port.onMessage(value => this.receive(value)));
		this._register(toDisposable(() => {
			for (const controller of this.active.values()) {
				controller.abort('serverDisposed');
			}
			this.active.clear();
		}));
	}

	private receive(value: unknown): void {
		if (!isChannelMessage(value, this.channel)) {
			return;
		}
		try {
			assertVersion(value, this.channel);
			if (value.kind === 'cancel') {
				assertRequestId(value.requestId);
				this.active.get(value.requestId)?.abort('clientCancelled');
			} else if (value.kind === 'request') {
				assertRequestId(value.requestId);
				if (this.active.has(value.requestId)) {
					throw new RangeError(`Duplicate worker request '${value.requestId}'`);
				}
				void this.run(value.requestId, value);
			} else {
				this.handler.handleNotification(value);
			}
		} catch (error) {
			this.sendFailure(value.kind === 'request' ? value.requestId : undefined, error);
		}
	}

	private async run(requestId: number, message: Record<string, unknown>): Promise<void> {
		const controller = new AbortController();
		this.active.set(requestId, controller);
		try {
			const result = await this.handler.handleRequest(message, controller.signal);
			if (!this.isDisposed && !controller.signal.aborted) {
				this.port.send({ ...this.channel, kind: 'result', requestId, result });
			}
		} catch (error) {
			if (!this.isDisposed && !controller.signal.aborted) {
				this.sendFailure(requestId, error);
			}
		} finally {
			if (this.active.get(requestId) === controller) {
				this.active.delete(requestId);
			}
		}
	}

	private sendFailure(requestId: unknown, value: unknown): void {
		if (this.isDisposed) {
			return;
		}
		const error = toError(value);
		this.port.send({ ...this.channel, kind: requestId === undefined ? 'notificationFailure' : 'failure', requestId, error: { name: error.name, message: error.message } });
	}
}

function isChannelMessage(value: unknown, channel: WebWorkerChannel): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && (value as Record<string, unknown>).protocol === channel.protocol;
}

function assertVersion(value: Record<string, unknown>, channel: WebWorkerChannel): void {
	if (value.version !== channel.version) {
		throw new TypeError(`Unsupported worker protocol version '${String(value.version)}'`);
	}
}

function assertRequestId(value: unknown): asserts value is number {
	if (!Number.isSafeInteger(value) || (value as number) <= 0) {
		throw new RangeError('Worker request ID must be a positive safe integer');
	}
}

function decodeError(value: unknown): WebWorkerRemoteError {
	if (!value || typeof value !== 'object' || !('name' in value) || !('message' in value) || typeof value.name !== 'string' || typeof value.message !== 'string') {
		throw new TypeError('Invalid worker error');
	}
	return new WebWorkerRemoteError(value.name, value.message);
}
