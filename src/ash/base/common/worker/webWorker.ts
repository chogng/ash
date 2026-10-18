import { Emitter, Event } from '../event.js';
import { toError } from '../errors.js';
import { Disposable, type IDisposable, toDisposable } from '../lifecycle.js';

export interface WebWorkerPort extends IDisposable {
	readonly onMessage: Event<unknown>;
	send(message: unknown, transfer?: readonly ArrayBuffer[]): void;
}

export interface WebWorkerClientPort extends WebWorkerPort {
	readonly onFailure: Event<unknown>;
}

export interface WebWorkerChannel {
	readonly protocol: string;
	readonly version: number;
}

export type Proxied<T> = {
	[K in keyof T]: T[K] extends (...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : never;
};

/** The message API preserves cancellable, versioned Ash worker protocols. */
export interface IWebWorkerClient<T> extends IDisposable {
	readonly proxy: Proxied<T>;
	readonly onDidFail: Event<Error>;
	setChannel<C extends object>(channel: string, handler: C): void;
	getChannel<C extends object>(channel: string): Proxied<C>;
	request(requestId: number, data: object, signal: AbortSignal, transfer?: readonly ArrayBuffer[]): Promise<unknown>;
	send(kind: string, data: object, transfer?: readonly ArrayBuffer[]): void;
	ensureAvailable(): void;
	invalidate(error: unknown): void;
}

export interface IWebWorkerServer {
	setChannel<T extends object>(channel: string, handler: T): void;
	getChannel<T extends object>(channel: string): Proxied<T>;
}

const rpcChannel: WebWorkerChannel = { protocol: 'ash.worker.rpc', version: 1 };
const hostChannel: WebWorkerChannel = { protocol: 'ash.worker.rpc.host', version: 1 };

/** A borrowed channel never owns termination of the physical worker. */
function borrowPort(port: WebWorkerClientPort): WebWorkerClientPort {
	return { onMessage: port.onMessage, onFailure: port.onFailure, send: (message, transfer) => port.send(message, transfer), ...Disposable.None };
}

function createProxy<T>(channel: string, invoke: (channel: string, method: string, args: unknown[]) => Promise<unknown>): Proxied<T> {
	return new Proxy(Object.create(null) as Proxied<T>, {
		get: (_target, method) => {
			if (method === 'then') return undefined;
			if (typeof method !== 'string' || ['constructor', '__proto__', 'prototype'].includes(method)) throw new TypeError('Invalid Worker method');
			return (...args: unknown[]) => invoke(channel, method, args);
		},
	});
}

function invokeChannel(channels: Map<string, object>, message: Record<string, unknown>): unknown {
	if (typeof message.channel !== 'string' || typeof message.method !== 'string' || !Array.isArray(message.args)
		|| ['constructor', '__proto__', 'prototype'].includes(message.method)) throw new TypeError('Invalid Worker channel request');
	const target = channels.get(message.channel);
	const method = target && (target as Record<string, unknown>)[message.method];
	if (typeof method !== 'function') throw new ReferenceError(`Unknown Worker method '${message.channel}.${message.method}'`);
	return method.apply(target, message.args);
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
export class WebWorkerClient<T extends object = object> extends Disposable implements IWebWorkerClient<T> {
	private readonly pending = new Map<number, PendingRequest>();
	private readonly failureEmitter = this._register(new Emitter<Error>());
	private terminalFailure: Error | undefined;
	public readonly onDidFail = this.failureEmitter.event;
	private readonly channels = new Map<string, object>();
	private readonly proxies = new Map<string, object>();
	private callbacks: WebWorkerServer | undefined;
	private rpc: WebWorkerClient | undefined;
	private rpcFailure: IDisposable | undefined;
	private nextRpcRequest = 0;
	public get proxy(): Proxied<T> { return this.getChannel<T>('default'); }

	constructor(private readonly port: WebWorkerClientPort, private readonly channel: WebWorkerChannel = rpcChannel) {
		super();
		this._register(port);
		this._register(port.onMessage(value => this.receive(value)));
		this._register(port.onFailure(error => this.invalidate(error)));
		this._register(toDisposable(() => this.rejectPending(new ReferenceError('Worker client is disposed'))));
		this._register(toDisposable(() => { this.channels.clear(); this.proxies.clear(); }));
	}

	public setChannel<C extends object>(channel: string, handler: C): void {
		this.ensureAvailable();
		this.channels.set(channel, handler);
		this.callbacks ??= this._register(new WebWorkerServer(borrowPort(this.port), hostChannel, {
			handleRequest: async message => invokeChannel(this.channels, message),
			handleNotification: () => { throw new TypeError('Unexpected Worker host notification'); },
		}));
	}

	public getChannel<C extends object>(channel: string): Proxied<C> {
		this.ensureAvailable();
		if (!this.proxies.has(channel)) {
			// Legacy domain protocols keep their IDs and cancellation namespace.
			// RPC calls use the same request machinery on a distinct channel.
			const transport = this.channel.protocol === rpcChannel.protocol || this.channel.protocol === hostChannel.protocol
				? this : this.rpc ??= this._register(new WebWorkerClient(borrowPort(this.port)));
			if (transport !== this && !this.rpcFailure) {
				this.rpcFailure = this._register(transport.onDidFail(error => this.invalidate(error)));
			}
			this.proxies.set(channel, createProxy<C>(channel, (name, method, args) =>
				transport.request(++transport.nextRpcRequest, { channel: name, method, args }, new AbortController().signal,
					args.filter((value): value is ArrayBuffer => value instanceof ArrayBuffer))));
		}
		return this.proxies.get(channel) as Proxied<C>;
	}

	public request(requestId: number, data: object, signal: AbortSignal, transfer?: readonly ArrayBuffer[]): Promise<unknown> {
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
				this.send('request', { ...data, requestId }, transfer);
			} catch (error) {
				this.pending.delete(requestId);
				pending.removeAbort();
				reject(error);
			}
		});
	}

	public send(kind: string, data: object, transfer?: readonly ArrayBuffer[]): void {
		this.ensureAvailable();
		this.port.send({ ...data, ...this.channel, kind }, transfer);
	}

	public invalidate(error: unknown): void {
		if (this.isDisposed || this.terminalFailure) {
			return;
		}
		this.terminalFailure = toError(error);
		this.rejectPending(this.terminalFailure);
		this.rpc?.invalidate(this.terminalFailure);
		this.callbacks?.dispose();
		// Terminal failure retires this transport. Only its domain owner may
		// decide whether a fresh worker and fresh application state are needed.
		this.port.dispose();
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
export class WebWorkerServer extends Disposable implements IWebWorkerServer {
	private readonly active = new Map<number, AbortController>();
	private readonly channels = new Map<string, object>();
	private readonly proxies = new Map<string, object>();
	private host: WebWorkerClient | undefined;
	private rpc: WebWorkerServer | undefined;
	private readonly channel: WebWorkerChannel;
	private readonly handler: WebWorkerRequestHandler;

	constructor(port: WebWorkerPort, factory: (server: IWebWorkerServer) => object);
	constructor(port: WebWorkerPort, channel: WebWorkerChannel, handler: WebWorkerRequestHandler);
	constructor(private readonly port: WebWorkerPort, channelOrFactory: WebWorkerChannel | ((server: IWebWorkerServer) => object), handler?: WebWorkerRequestHandler) {

		super();
		if (typeof channelOrFactory === 'function') {
			this.channel = rpcChannel;
			this.handler = {
				handleRequest: async message => invokeChannel(this.channels, message),
				handleNotification: () => { throw new TypeError('Unexpected Worker RPC notification'); },
			};
		} else {
			this.channel = channelOrFactory;
			this.handler = handler!;
		}
		this._register(port);
		this._register(port.onMessage(value => this.receive(value)));
		this._register(toDisposable(() => {
			for (const controller of this.active.values()) {
				controller.abort('serverDisposed');
			}
			this.active.clear();
			this.channels.clear();
			this.proxies.clear();
		}));
		if (typeof channelOrFactory === 'function') {
			try {
				this.setChannel('default', channelOrFactory(this));
			} catch (error) {
				this.dispose();
				throw error;
			}
		}
	}

	public setChannel<T extends object>(channel: string, handler: T): void {
		this.assertNotDisposed();
		if (this.channel.protocol !== rpcChannel.protocol) {
			this.rpc ??= this._register(new WebWorkerServer({ onMessage: this.port.onMessage, send: (value, transfer) => this.port.send(value, transfer), ...Disposable.None }, () => ({})));
			this.rpc.setChannel(channel, handler);
		} else {
			this.channels.set(channel, handler);
		}
	}

	public getChannel<T extends object>(channel: string): Proxied<T> {
		this.assertNotDisposed();
		this.host ??= this._register(new WebWorkerClient({ onMessage: this.port.onMessage, onFailure: Event.None, send: (value, transfer) => this.port.send(value, transfer), ...Disposable.None }, hostChannel));
		if (!this.proxies.has(channel)) this.proxies.set(channel, this.host.getChannel<T>(channel));
		return this.proxies.get(channel) as Proxied<T>;
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
				this.port.send({ ...this.channel, kind: 'result', requestId, result }, result instanceof ArrayBuffer ? [result] : []);
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
