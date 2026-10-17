import { AppServerFrame, WEB_APP_SERVER_PROTOCOL_VERSION, WEB_APP_SERVER_CONNECT_EVENT, WEB_APP_SERVER_CONNECTED_EVENT, WEB_APP_SERVER_DISCONNECT_EVENT, WEB_APP_SERVER_FRAME_EVENT, WEB_APP_SERVER_CLOSED_EVENT, type AppServerTransport } from '../common/appServerTransport.js';
import { APP_SERVER_METHODS, type AppServerMethod, type AppServerMethodDefinition, type InitializeResult, type MethodParams, type MethodResult, type ServerCapabilities, type ServerNotification } from "../../../../../.build/protocol/typescript/index.js";
import { VSBuffer } from "../../../base/common/buffer.js";
import { canceled, isCancellationError, toError } from "../../../base/common/errors.js";
import { isRecord } from "../../../base/common/types.js";
import type { AppServerConnectionState } from "../common/appServerApi.js";
import { AppServerRemoteError } from "../common/appServerError.js";
import type { DisposableHandle } from "../../ipc/common/ipc.js";
import { checkAppServerInitializeCompatibility } from "../common/appServerProtocolCompatibility.js";
import type { AppServerServerRequestDefinition, AppServerServerRequestMethod, ClientCapabilities, JsonRpcId, ServerRequestParams, ServerRequestResult } from '../../../../../.build/protocol/typescript/index.js';
import { decodeAppServerServerRequestResult } from '../../../../../.build/protocol/typescript/AppServerProtocolDecoder.js';
import { Disposable, type IDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { OperatingSystem } from '../../../base/common/platform.js';
import { AppServerFrameDecoder } from './appServerFrameDecoder.js';
import type { AppServerDecodeContext, DecodedAppServerCall, DecodedAppServerFrame } from './appServerProtocolDecoding.js';


const DEFAULT_CONNECT_TIMEOUT = 10_000;
const DEFAULT_REQUEST_TIMEOUT = 30_000;
const MAX_FRAME_BYTES = 320 * 1024 * 1024;


export interface AppServerConnectionMetadata {
	readonly workspaceId: string;
	readonly workspaceRoot: string;
}

export interface AppServerProtocolClientOptions {
	readonly clientName?: string;
	readonly clientVersion?: string;
	readonly connectTimeoutMs?: number;
	readonly initializeTimeoutMs?: number;
	readonly requestTimeoutMs?: number;
	readonly capabilities?: ClientCapabilities;
}

export interface AppServerRequestContext {
	readonly signal: AbortSignal;
}

interface PendingRequest {
	readonly method: AppServerMethod;
	readonly resolve: (value: unknown) => void;
	readonly reject: (error: Error) => void;
	readonly timeout: ReturnType<typeof setTimeout>;
}

interface QueuedFrame {
	readonly frame: string;
	readonly byteLength: number;
	readonly context: AppServerDecodeContext;
	readonly complete: () => void;
}

interface FrameQueue {
	readonly generation: number;
	readonly waiting: QueuedFrame[];
	current: QueuedFrame;
	bytes: number;
	count: number;
	closed?: { readonly payload: unknown; };
}

/** Owns initialization and bidirectional protocol dispatch for one renderer connection. */
export class AppServerProtocolClient {
	private readonly transport: AppServerTransport;
	private readonly options: Required<AppServerProtocolClientOptions>;
	private readonly decoder: AppServerFrameDecoder;
	private readonly stateListeners = new Set<(state: AppServerConnectionState, error?: Error) => void>();
	private readonly notificationListeners = new Set<(notification: ServerNotification) => void>();
	private readonly pending = new Map<number, PendingRequest>();
	private readonly handlers = new Map<AppServerServerRequestMethod, (params: never, context: AppServerRequestContext) => unknown | Promise<unknown>>();
	private readonly inbound = new Map<JsonRpcId, AbortController>();
	private readonly bufferedCalls: DecodedAppServerCall[] = [];
	private receiving: FrameQueue | undefined;
	private bufferedCallBytes = 0;
	private nextRequestId = 1;
	private _generation = 0;
	private _state: AppServerConnectionState = "stopped";
	private _slashCommands: readonly InitializeResult["slashCommands"][number][] = [];
	private _capabilities: ServerCapabilities | undefined;
	private _operatingSystem: OperatingSystem | undefined;
	private _userHome: string | undefined;
	private connectResolve: ((metadata: AppServerConnectionMetadata) => void) | undefined;
	private connectReject: ((error: Error) => void) | undefined;
	private connectTimeout: ReturnType<typeof setTimeout> | undefined;
	private disposed = false;
	private isClosing = false;
	private firstRequestId = 1;

	constructor(transport: AppServerTransport, options: AppServerProtocolClientOptions = {}, decoder?: AppServerFrameDecoder) {
		this.transport = transport;
		this.options = {
			clientName: options.clientName ?? "ash-web",
			clientVersion: options.clientVersion ?? "0.1.0",
			connectTimeoutMs: positiveInteger(options.connectTimeoutMs, DEFAULT_CONNECT_TIMEOUT, "connectTimeoutMs"),
			initializeTimeoutMs: positiveInteger(options.initializeTimeoutMs, DEFAULT_CONNECT_TIMEOUT, "initializeTimeoutMs"),
			requestTimeoutMs: positiveInteger(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT, "requestTimeoutMs"),
			capabilities: { ...options.capabilities, notifications: true },
		};
		// Ownership transfers after options have been validated; reconnect resets
		// the Worker, while disposing the client releases the decoder itself.
		this.decoder = decoder ?? new AppServerFrameDecoder();
		this.transport.on(WEB_APP_SERVER_CONNECTED_EVENT, this.handleConnected);
		this.transport.on(WEB_APP_SERVER_FRAME_EVENT, this.handleFrame);
		this.transport.on(WEB_APP_SERVER_CLOSED_EVENT, this.handleClosed);
	}

	get state(): AppServerConnectionState {
		return this._state;
	}

	public get generation(): number { return this._generation; }

	get slashCommands(): readonly InitializeResult["slashCommands"][number][] {
		return this._slashCommands;
	}

	get capabilities(): ServerCapabilities | undefined {
		return this._capabilities;
	}

	public get operatingSystem(): OperatingSystem | undefined {
		return this._operatingSystem;
	}

	public get userHome(): string | undefined {
		return this._userHome;
	}

	public disconnect(): void {
		this.shutdown(new Error('App Server connection replaced'), 'stopped', { releaseTransport: true });
	}

	async connect(): Promise<AppServerConnectionMetadata> {
		if (this.disposed || this.isClosing) throw new Error("Cannot connect a disposed or closing App Server client");
		if (this._state !== "stopped" && this._state !== 'crashed') throw new Error(`Cannot connect App Server client from ${this._state}`);
		const generation = ++this._generation;
		this.firstRequestId = this.nextRequestId;
		const connected = new Promise<AppServerConnectionMetadata>((resolve, reject) => {
			this.connectResolve = resolve;
			this.connectReject = reject;
			this.connectTimeout = setTimeout(() => this.fail(new Error("Timed out connecting to the App Server bridge")), this.options.connectTimeoutMs);
		});
		// Observers can close or replace the connection synchronously when its state changes.
		this.setState("starting");
		if (this.isCurrentConnection(generation, 'starting')) {
			try {
				this.transport.send(WEB_APP_SERVER_CONNECT_EVENT, { protocolVersion: WEB_APP_SERVER_PROTOCOL_VERSION });
			} catch (error) {
				this.fail(toError(error));
			}
		}
		const metadata = await connected;
		if (!this.isCurrentConnection(generation, 'starting')) { throw canceled(); }
		this.setState("initializing");
		try {
			if (!this.isCurrentConnection(generation, 'initializing')) { throw canceled(); }
			const initialized = await this.requestRaw(APP_SERVER_METHODS.initialize, {
				clientInfo: { name: this.options.clientName, version: this.options.clientVersion },
				capabilities: this.options.capabilities,
			}, this.options.initializeTimeoutMs);
			if (!this.isCurrentConnection(generation, 'initializing')) { throw canceled(); }
			const initialization = validateInitializeResult(initialized);
			this._slashCommands = initialization.slashCommands;
			this._capabilities = initialization.capabilities;
			this._operatingSystem = initialization.operatingSystem;
			this._userHome = initialization.userHome;
			this.setState("ready");
			if (!this.isCurrentConnection(generation, 'ready')) { throw canceled(); }
			const calls = this.bufferedCalls.splice(0);
			this.bufferedCallBytes = 0;
			for (const call of calls) {
				if (!this.isCurrentConnection(generation, 'ready')) { throw canceled(); }
				this.handleInboundCall(call);
			}
			return metadata;
		} catch (error) {
			if (this.isCurrentConnection(generation, 'initializing') || this.isCurrentConnection(generation, 'ready')) { this.fail(toError(error)); }
			throw error;
		}
	}

	private isCurrentConnection(generation: number, state: AppServerConnectionState): boolean {
		return !this.disposed && this._generation === generation && this._state === state;
	}

	request<M extends AppServerMethod>(definition: AppServerMethodDefinition<M>, params: MethodParams<M>, options?: { readonly timeoutMs: number; }): Promise<MethodResult<M>> {
		// Abort listeners can reenter before the final state event is published.
		if (this.disposed || this.isClosing || this.receiving?.closed || this._state !== "ready") return Promise.reject(new Error(`App Server is not ready: ${this.isClosing || this.receiving?.closed ? 'closing' : this._state}`));
		return this.requestRaw(definition, params, options ? positiveInteger(options.timeoutMs, this.options.requestTimeoutMs, "timeoutMs") : this.options.requestTimeoutMs);
	}

	onStateChange(listener: (state: AppServerConnectionState, error?: Error) => void): IDisposable {
		this.stateListeners.add(listener);
		return disposable(() => this.stateListeners.delete(listener));
	}

	onNotification(listener: (notification: ServerNotification) => void): IDisposable {
		this.notificationListeners.add(listener);
		return disposable(() => this.notificationListeners.delete(listener));
	}

	public registerRequestHandler<M extends AppServerServerRequestMethod>(definition: AppServerServerRequestDefinition<M>, handler: (params: ServerRequestParams<M>, context: AppServerRequestContext) => ServerRequestResult<M> | Promise<ServerRequestResult<M>>): IDisposable {
		if (this.disposed || this.handlers.has(definition.method)) {
			throw new Error(`Cannot register App Server handler: ${definition.method}`);
		}
		this.handlers.set(definition.method, handler);
		return toDisposable(() => this.handlers.delete(definition.method));
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		try {
			this.shutdown(new Error("App Server client disposed"), "stopped", { releaseTransport: true });
		} finally {
			this.transport.off(WEB_APP_SERVER_CONNECTED_EVENT, this.handleConnected);
			this.transport.off(WEB_APP_SERVER_FRAME_EVENT, this.handleFrame);
			this.transport.off(WEB_APP_SERVER_CLOSED_EVENT, this.handleClosed);
			this.stateListeners.clear();
			this.notificationListeners.clear();
			this.handlers.clear();
			this.decoder.dispose();
		}
	}

	private requestRaw<M extends AppServerMethod>(definition: AppServerMethodDefinition<M>, params: MethodParams<M>, timeoutMs: number): Promise<MethodResult<M>> {
		if (this.pending.size >= 128) {
			return Promise.reject(new Error('App Server request limit reached'));
		}
		const id = this.nextRequestId++;
		const promise = new Promise<MethodResult<M>>((resolve, reject) => {
			const timeout = setTimeout(() => {
				const pending = this.pending.get(id);
				if (!pending) return;
				this.fail(new Error(`App Server request timed out: ${definition.method}`));
			}, timeoutMs);
			const pending: PendingRequest = {
				method: definition.method,
				resolve: (value) => resolve(value as MethodResult<M>),
				reject,
				timeout,
			};
			this.pending.set(id, pending);
		});
		try {
			const frame = JSON.stringify({ jsonrpc: "2.0", id, method: definition.method, params });
			this.transport.send(WEB_APP_SERVER_FRAME_EVENT, { frame });
		} catch (error) {
			this.rejectPending(id, toError(error));
		}
		return promise;
	}

	private readonly handleConnected = (payload: unknown): void => {
		if (this._state !== "starting") return;
		try {
			const metadata = validateConnectedPayload(payload);
			this.clearConnectTimeout();
			const resolve = this.connectResolve;
			this.connectResolve = undefined;
			this.connectReject = undefined;
			resolve?.(metadata);
		} catch (error) {
			this.fail(toError(error));
		}
	};

	private readonly handleFrame = (payload: unknown): void => {
		if (this.disposed || this.isClosing || this.receiving?.closed || this._state === 'stopped' || this._state === 'crashed') return;
		try {
			const { frame, byteLength } = validateFramePayload(payload);
			// Freeze only routing at receipt: queued replies cannot match a request
			// created later. Pending requests and their lifetimes remain owned here.
			const context: AppServerDecodeContext = { firstRequestId: this.firstRequestId, methods: [...this.pending].map(([id, request]) => [id, request.method]) };
			if (this.receiving && (this.receiving.count >= 4096 || this.receiving.bytes + byteLength > MAX_FRAME_BYTES)) throw new Error('App Server decode queue capacity exceeded');
			const decoded = this.receiving ? undefined : this.decoder.decode(frame, byteLength, context);
			if (decoded && !(decoded instanceof Promise)) { this.dispatchFrame(decoded, byteLength); return; }
			let complete!: () => void;
			const consumed = new Promise<void>(resolve => { complete = resolve; });
			const item: QueuedFrame = { frame, byteLength, context, complete };
			if (payload instanceof AppServerFrame) payload.consumed = consumed;
			if (this.receiving) {
				this.receiving.waiting.push(item);
				this.receiving.bytes += byteLength;
				this.receiving.count++;
			} else {
				const queue: FrameQueue = { generation: this._generation, waiting: [], current: item, bytes: byteLength, count: 1 };
				this.receiving = queue;
				void this.drainFrames(queue, decoded!);
			}
		} catch (error) { this.fail(toError(error)); }
	};

	private async drainFrames(queue: FrameQueue, first: DecodedAppServerFrame | Promise<DecodedAppServerFrame>): Promise<void> {
		let decoded = first;
		let started = performance.now();
		try {
			while (this.receiving === queue) {
				const item = queue.current;
				let result: DecodedAppServerFrame;
				if (decoded instanceof Promise) {
					// Notifications also need a deadline: an unresponsive Worker must
					// not hold carrier credit forever when no client request is pending.
					const timeout = setTimeout(() => { if (this.receiving === queue) this.fail(new Error('App Server frame decode timed out')); }, this.options.requestTimeoutMs);
					try { result = await decoded; } finally { clearTimeout(timeout); }
				} else { result = decoded; }
				if (this.receiving !== queue || this._generation !== queue.generation) return;
				this.dispatchFrame(result, item.byteLength);
				item.complete();
				if (this.receiving !== queue) return;
				queue.bytes -= item.byteLength;
				queue.count--;
				const next = queue.waiting.shift();
				if (!next) {
					this.receiving = undefined;
					if (queue.closed) this.handleClosed(queue.closed.payload);
					return;
				}
				queue.current = next;
				// A run of small queued notifications must yield an actual UI task,
				// rather than monopolizing the microtask queue after the Worker reply.
				if (performance.now() - started >= 4) {
					await new Promise<void>(resolve => setTimeout(resolve, 0));
					if (this.receiving !== queue) return;
					started = performance.now();
				}
				decoded = this.decoder.decode(next.frame, next.byteLength, next.context);
			}
		} catch (error) { if (this.receiving === queue) this.fail(toError(error)); }
		finally { queue.current.complete(); }
	}

	private dispatchFrame(decoded: DecodedAppServerFrame, byteLength: number): void {
		if (decoded.kind === 'retiredResponse') return;
		if (decoded.kind === 'response') { this.handleResponse(decoded); return; }
		if (this._state !== 'ready') {
			// Compatibility must be checked before any buffered host effects run.
			if (this.bufferedCalls.length >= 128 || this.bufferedCallBytes + byteLength > MAX_FRAME_BYTES) throw new Error('App Server initialization call limit reached');
			this.bufferedCalls.push(decoded);
			this.bufferedCallBytes += byteLength;
		} else { this.handleInboundCall(decoded); }
	}

	private readonly handleClosed = (payload: unknown): void => {
		if (this.disposed || this.isClosing || this._state === 'stopped') { return; }
		// EOF belongs after frames already received. Local disconnect/dispose and
		// decode failures still retire work immediately through shutdown().
		if (this.receiving) { this.receiving.closed ??= { payload }; return; }
		const intentional = isRecord(payload) && payload.intentional === true;
		const fallback = intentional ? 'App Server connection stopped' : 'App Server bridge closed';
		const message = isRecord(payload) && typeof payload.message === "string" && payload.message.trim()
			? payload.message
			: fallback;
		if (intentional) { this.shutdown(new Error(message), 'stopped'); return; }
		this.fail(new Error(message));
	};

	private handleResponse(decoded: Extract<DecodedAppServerFrame, { kind: 'response'; }>): void {
		const { response, method } = decoded;
		const id = response.id as number;
		const pending = this.pending.get(id);
		if (!pending || pending.method !== method) throw new Error('App Server emitted an unmatched response ID');
		this.pending.delete(id);
		clearTimeout(pending.timeout);
		if ("error" in response) {
			pending.reject(new AppServerRemoteError(response.error.code, response.error.message, response.error.data));
			return;
		}
		pending.resolve(response.result);
	}

	private handleInboundCall(call: DecodedAppServerCall): void {
		// The peer may have closed while earlier frames were in the Worker. Drain
		// notifications and responses, but do not start host effects on a dead lease.
		if (this.receiving?.closed && call.kind !== 'notification') return;
		if (call.kind === 'unknownServerRequest') {
			this.transport.send(WEB_APP_SERVER_FRAME_EVENT, { frame: JSON.stringify({ jsonrpc: '2.0', id: call.id, error: { code: -32601, message: 'Method not found', data: null } }) });
			return;
		}
		if (call.kind === 'serverRequest') {
			const request = call.request;
			if (this.inbound.has(request.id) || this.inbound.size >= 128) {
				throw new Error('App Server inbound request limit or duplicate ID');
			}
			const handler = this.handlers.get(request.method);
			if (!handler) {
				this.transport.send(WEB_APP_SERVER_FRAME_EVENT, { frame: JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found', data: null } }) });
				return;
			}
			const generation = this._generation;
			const controller = new AbortController();
			this.inbound.set(request.id, controller);
			const ownsRequest = (): boolean => this._generation === generation && !this.receiving?.closed && this.inbound.get(request.id) === controller;
			// Check ownership before decoding or serializing a host result. Both can throw,
			// and retired work must have no effect on a replacement connection.
			const reply = (response: () => object, options?: { readonly abort: boolean; }): void => {
				if (!ownsRequest()) { return; }
				const frame = JSON.stringify({ jsonrpc: '2.0', id: request.id, ...response() });
				this.inbound.delete(request.id);
				clearTimeout(timeout);
				if (options?.abort) { controller.abort(); }
				if (this.isCurrentConnection(generation, 'ready') && !this.receiving?.closed) {
					try {
						this.transport.send(WEB_APP_SERVER_FRAME_EVENT, { frame });
					} catch (error) {
						this.fail(toError(error));
					}
				}
			};
			const timeout = setTimeout(() => reply(() => ({ error: { code: -32000, message: 'Host request timed out', data: null } }), { abort: true }), this.options.requestTimeoutMs);
			controller.signal.addEventListener('abort', () => clearTimeout(timeout), { once: true });
			void Promise.resolve().then(() => ownsRequest() ? handler(request.params as never, { signal: controller.signal }) : undefined).then(
				value => reply(() => ({ result: decodeAppServerServerRequestResult(request.method, value) })),
				error => reply(() => ({ error: { code: isCancellationError(error) ? -32800 : -32000, message: toError(error).message, data: null } })),
			).catch(error => {
				if (this._generation === generation && !controller.signal.aborted) { this.fail(toError(error)); }
			});
			return;
		}
		const wireNotification = call.notification;
		if (wireNotification.method === '$/cancelRequest') {
			const id = wireNotification.params.id;
			const controller = this.inbound.get(id);
			if (controller) {
				// Retire first: cancellation listeners and late promises must not send a second reply.
				const generation = this._generation;
				this.inbound.delete(id);
				controller.abort();
				if (this.isCurrentConnection(generation, 'ready') && !this.receiving?.closed) {
					this.transport.send(WEB_APP_SERVER_FRAME_EVENT, { frame: JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32800, message: 'Host request cancelled', data: null } }) });
				}
			}
			return;
		}
		const notification = { method: wireNotification.method, params: wireNotification.params } as ServerNotification;
		for (const listener of this.notificationListeners) {
			try {
				listener(notification);
			} catch {
				// One presentation listener cannot break connection-wide delivery.
			}
		}
	}

	private rejectPending(id: number, error: Error): boolean {
		const pending = this.pending.get(id);
		if (!pending) return false;
		this.pending.delete(id);
		clearTimeout(pending.timeout);
		pending.reject(error);
		return true;
	}

	private fail(error: Error): void {
		if (this.disposed || this.isClosing) { return; }
		this.shutdown(error, this._state === "stopped" ? "stopped" : "crashed", { releaseTransport: true });
	}

	private shutdown(error: Error, state: AppServerConnectionState, options?: { readonly releaseTransport: boolean; }): void {
		if (this.isClosing) { return; }
		this.isClosing = true;
		try {
			const receiving = this.receiving;
			this.receiving = undefined;
			this.decoder.reset();
			receiving?.current.complete();
			for (const frame of receiving?.waiting ?? []) frame.complete();
			if (receiving) receiving.waiting.length = 0;
			this.bufferedCalls.length = 0;
			this.bufferedCallBytes = 0;
			this._slashCommands = [];
			this._capabilities = undefined;
			this._operatingSystem = undefined;
			this._userHome = undefined;
			this.clearConnectTimeout();
			const reject = this.connectReject;
			this.connectResolve = undefined;
			this.connectReject = undefined;
			const pending = [...this.pending.values()];
			const inbound = [...this.inbound.values()];
			// Retire every request before notifying cancellation listeners, which can
			// synchronously dispose this client or complete another host operation.
			this.pending.clear();
			this.inbound.clear();
			reject?.(error);
			for (const request of pending) {
				clearTimeout(request.timeout);
				request.reject(error);
			}
			for (const controller of inbound) { controller.abort(); }
			if (options?.releaseTransport) {
				try {
					this.transport.send(WEB_APP_SERVER_DISCONNECT_EVENT, { protocolVersion: WEB_APP_SERVER_PROTOCOL_VERSION });
				} catch {
					// Cleanup must settle all waiters even if the carrier already stopped.
				}
			}
		} finally {
			this.isClosing = false;
			// Recovery observers may immediately connect again. Publish only after
			// the old transport has closed so cleanup cannot tear down their new lease.
			this.setState(this.disposed ? 'stopped' : state, state === 'crashed' ? error : undefined);
		}
	}

	private clearConnectTimeout(): void {
		if (this.connectTimeout !== undefined) clearTimeout(this.connectTimeout);
		this.connectTimeout = undefined;
	}

	private setState(state: AppServerConnectionState, error?: Error): void {
		if (this._state === state) return;
		this._state = state;
		for (const listener of this.stateListeners) {
			try {
				listener(state, error);
			} catch {
				// State observers are isolated from the connection lifecycle.
			}
		}
	}
}

/** Serializes connection replacement and owns the retry budget, never protocol state. */
export class AppServerConnectionRecovery extends Disposable {
	private task: Promise<void> | undefined;
	private latest: Promise<void> = Promise.resolve();
	private timer: ReturnType<typeof setTimeout> | undefined;
	private attempts = 0;
	private isActive = false;
	private static readonly retryDelays = [100, 500, 2000];

	constructor(
		private readonly client: AppServerProtocolClient,
		private readonly open: () => Promise<void>,
		private readonly onFailure: (message: string, error: unknown) => void,
	) {
		super();
		this._register(client.onStateChange((state, error) => {
			if (state === 'crashed') {
				this.onFailure('Renderer connection failed', error);
				this.schedule();
			}
		}));
	}

	public connect(): Promise<void> {
		this.assertNotDisposed();
		if (this.task) { return this.task; }
		this.attempts = 0;
		return this.run();
	}

	public whenConnected(): Promise<void> {
		return this.latest;
	}

	protected override disposeCore(): void {
		this.clearTimer();
		super.disposeCore();
	}

	private run(): Promise<void> {
		this.clearTimer();
		// Defer entry until the task is published: synchronous state events and
		// restart notifications must join this attempt rather than start another.
		const operation = Promise.resolve().then(() => {
			this.assertNotDisposed();
			return this.open();
		});
		this.task = this.latest = operation;
		void operation.then(() => {
			this.task = undefined;
			this.isActive = true;
			this.attempts = 0;
			if (this.client.state === 'crashed') { this.schedule(); }
		}, error => {
			this.task = undefined;
			if (this.isDisposed) { return; }
			this.onFailure('App Server connection recovery failed', error);
			// Acquisition or extension initialization may fail with a stopped or
			// ready client. Retry the failed operation, not just crashed clients.
			this.schedule();
		});
		return operation;
	}

	private schedule(): void {
		if (this.isDisposed || !this.isActive || this.task || this.timer !== undefined
			|| this.attempts >= AppServerConnectionRecovery.retryDelays.length) { return; }
		this.timer = setTimeout(() => {
			this.timer = undefined;
			this.attempts++;
			void this.run().catch(() => { });
		}, AppServerConnectionRecovery.retryDelays[this.attempts]);
	}

	private clearTimer(): void {
		if (this.timer !== undefined) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
	}
}

function validateConnectedPayload(payload: unknown): AppServerConnectionMetadata {
	if (!isRecord(payload) || payload.protocolVersion !== WEB_APP_SERVER_PROTOCOL_VERSION) {
		throw new Error("App Server bridge protocol version mismatch");
	}
	if (typeof payload.workspaceId !== "string" || payload.workspaceId.trim().length === 0) throw new Error("App Server bridge workspace ID is invalid");
	if (typeof payload.workspaceRoot !== "string" || payload.workspaceRoot.trim().length === 0) throw new Error("App Server bridge workspace root is invalid");
	return { workspaceId: payload.workspaceId, workspaceRoot: payload.workspaceRoot };
}

function validateFramePayload(payload: unknown): { frame: string; byteLength: number; } {
	if (payload instanceof AppServerFrame) return payload;
	if (!isRecord(payload) || typeof payload.frame !== "string") throw new Error("App Server bridge frame is invalid");
	const byteLength = VSBuffer.fromString(payload.frame).byteLength;
	if (byteLength > MAX_FRAME_BYTES) throw new Error(`App Server frame exceeds ${MAX_FRAME_BYTES} bytes`);
	return { frame: payload.frame, byteLength };
}

function validateInitializeResult(value: InitializeResult): Pick<InitializeResult, "capabilities" | "slashCommands"> & { operatingSystem: OperatingSystem | undefined; userHome: string | undefined; } {
	const initialized = checkAppServerInitializeCompatibility(value, { expectedServerName: "ash-app-server" });
	let operatingSystem: OperatingSystem | undefined;
	switch (initialized.serverInfo.operatingSystem) {
		case 'windows': operatingSystem = OperatingSystem.Windows; break;
		case 'mac': operatingSystem = OperatingSystem.Macintosh; break;
		case 'linux': operatingSystem = OperatingSystem.Linux; break;
	}
	const userHome = initialized.serverInfo.userHome;
	if (userHome !== undefined && (userHome.includes('\0') || !(operatingSystem === OperatingSystem.Windows
		? /^(?:[a-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/i.test(userHome)
		: userHome.startsWith('/')))) {
		throw new TypeError('App Server user home must be an absolute directory');
	}
	return { capabilities: initialized.capabilities, slashCommands: initialized.slashCommands, operatingSystem, userHome };
}

function disposable(dispose: () => void): IDisposable { return toDisposable(dispose); }

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
	const resolved = value ?? fallback;
	if (!Number.isSafeInteger(resolved) || resolved <= 0) throw new RangeError(`${name} must be a positive safe integer`);
	return resolved;
}

function describeValue(value: unknown): string {
	return typeof value === "string" ? JSON.stringify(value) : String(value);
}
