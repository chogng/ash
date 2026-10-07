import { WEB_APP_SERVER_PROTOCOL_VERSION, WEB_APP_SERVER_CONNECT_EVENT, WEB_APP_SERVER_CONNECTED_EVENT, WEB_APP_SERVER_DISCONNECT_EVENT, WEB_APP_SERVER_FRAME_EVENT, WEB_APP_SERVER_CLOSED_EVENT, type AppServerTransport } from '../common/appServerTransport.js';
import { APP_SERVER_METHODS, APP_SERVER_SERVER_REQUESTS, type AppServerMethod, type AppServerMethodDefinition, type InitializeResult, type MethodParams, type MethodResult, type ServerCapabilities, type ServerNotification } from "../common/generated/index.js";
import { decodeAppServerEnvelope, decodeAppServerNotification, decodeAppServerResponse, decodeAppServerServerRequest } from "../common/generated/AppServerProtocolDecoder.js";
import { VSBuffer } from "../../../base/common/buffer.js";
import { toError } from "../../../base/common/errors.js";
import { isRecord } from "../../../base/common/types.js";
import type { AppServerConnectionState } from "../common/appServerApi.js";
import { AppServerRemoteError } from "../common/appServerError.js";
import type { DisposableHandle } from "../../ipc/common/ipc.js";
import { validateAppServerInitializeResult } from "../common/appServerProtocolCompatibility.js";
import type { AppServerServerRequestDefinition, AppServerServerRequestMethod, ClientCapabilities, JsonRpcId, ServerRequestParams, ServerRequestResult } from '../common/generated/index.js';
import { decodeAppServerServerRequestResult } from '../common/generated/AppServerProtocolDecoder.js';
import { type IDisposable, toDisposable } from '../../../base/common/lifecycle.js';


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

/** Owns initialization and bidirectional protocol dispatch for one renderer connection. */
export class AppServerProtocolClient {
	private readonly transport: AppServerTransport;
	private readonly options: Required<AppServerProtocolClientOptions>;
	private readonly stateListeners = new Set<(state: AppServerConnectionState) => void>();
	private readonly notificationListeners = new Set<(notification: ServerNotification) => void>();
	private readonly pending = new Map<number, PendingRequest>();
	private readonly handlers = new Map<AppServerServerRequestMethod, (params: never, context: AppServerRequestContext) => unknown | Promise<unknown>>();
	private readonly inbound = new Map<JsonRpcId, AbortController>();
	private nextRequestId = 1;
	public generation = 0;
	private _state: AppServerConnectionState = "stopped";
	private _slashCommands: readonly InitializeResult["slashCommands"][number][] = [];
	private _capabilities: ServerCapabilities | undefined;
	private metadata: AppServerConnectionMetadata | undefined;
	private connectResolve: ((metadata: AppServerConnectionMetadata) => void) | undefined;
	private connectReject: ((error: Error) => void) | undefined;
	private connectTimeout: ReturnType<typeof setTimeout> | undefined;
	private disposed = false;

	constructor(transport: AppServerTransport, options: AppServerProtocolClientOptions = {}) {
		this.transport = transport;
		this.options = {
			clientName: options.clientName ?? "ash-web",
			clientVersion: options.clientVersion ?? "0.1.0",
			connectTimeoutMs: positiveInteger(options.connectTimeoutMs, DEFAULT_CONNECT_TIMEOUT, "connectTimeoutMs"),
			initializeTimeoutMs: positiveInteger(options.initializeTimeoutMs, DEFAULT_CONNECT_TIMEOUT, "initializeTimeoutMs"),
			requestTimeoutMs: positiveInteger(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT, "requestTimeoutMs"),
			capabilities: { ...options.capabilities, notifications: true },
		};
		this.transport.on(WEB_APP_SERVER_CONNECTED_EVENT, this.handleConnected);
		this.transport.on(WEB_APP_SERVER_FRAME_EVENT, this.handleFrame);
		this.transport.on(WEB_APP_SERVER_CLOSED_EVENT, this.handleClosed);
	}

	get state(): AppServerConnectionState {
		return this._state;
	}

	get slashCommands(): readonly InitializeResult["slashCommands"][number][] {
		return this._slashCommands;
	}

	get capabilities(): ServerCapabilities | undefined {
		return this._capabilities;
	}

	public disconnect(): void {
		this.shutdown(new Error('App Server connection replaced'), 'stopped');
		this.transport.send(WEB_APP_SERVER_DISCONNECT_EVENT, { protocolVersion: WEB_APP_SERVER_PROTOCOL_VERSION });
	}

	async connect(): Promise<AppServerConnectionMetadata> {
		if (this.disposed) throw new Error("Cannot connect a disposed App Server client");
		if (this._state !== "stopped" && this._state !== 'crashed') throw new Error(`Cannot connect App Server client from ${this._state}`);
		this.generation++;
		this.setState("starting");
		const connected = new Promise<AppServerConnectionMetadata>((resolve, reject) => {
			this.connectResolve = resolve;
			this.connectReject = reject;
			this.connectTimeout = setTimeout(() => this.fail(new Error("Timed out connecting to the App Server bridge")), this.options.connectTimeoutMs);
		});
		this.transport.send(WEB_APP_SERVER_CONNECT_EVENT, { protocolVersion: WEB_APP_SERVER_PROTOCOL_VERSION });
		const metadata = await connected;
		this.setState("initializing");
		try {
			const initialized = await this.requestRaw(APP_SERVER_METHODS.initialize, {
				clientInfo: { name: this.options.clientName, version: this.options.clientVersion },
				capabilities: this.options.capabilities,
			}, this.options.initializeTimeoutMs);
			const initialization = validateInitializeResult(initialized);
			this._slashCommands = initialization.slashCommands;
			this._capabilities = initialization.capabilities;
			this.setState("ready");
			return metadata;
		} catch (error) {
			this.fail(toError(error));
			throw error;
		}
	}

	request<M extends AppServerMethod>(definition: AppServerMethodDefinition<M>, params: MethodParams<M>): Promise<MethodResult<M>> {
		if (this._state !== "ready") return Promise.reject(new Error(`App Server is not ready: ${this._state}`));
		return this.requestRaw(definition, params, this.options.requestTimeoutMs);
	}

	onStateChange(listener: (state: AppServerConnectionState) => void): IDisposable {
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
			this.transport.send(WEB_APP_SERVER_DISCONNECT_EVENT, { protocolVersion: WEB_APP_SERVER_PROTOCOL_VERSION });
		} finally {
			this.transport.off(WEB_APP_SERVER_CONNECTED_EVENT, this.handleConnected);
			this.transport.off(WEB_APP_SERVER_FRAME_EVENT, this.handleFrame);
			this.transport.off(WEB_APP_SERVER_CLOSED_EVENT, this.handleClosed);
			this.shutdown(new Error("App Server client disposed"), "stopped");
			this.stateListeners.clear();
			this.notificationListeners.clear();
			this.handlers.clear();
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
		const frame = JSON.stringify({ jsonrpc: "2.0", id, method: definition.method, params });
		try {
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
			this.metadata = metadata;
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
		if (this.disposed || this._state === 'stopped' || this._state === 'crashed') {
			return;
		}
		try {
			const frame = validateFramePayload(payload);
			const message: unknown = JSON.parse(frame);
			const envelope = decodeAppServerEnvelope(message);
			if (envelope.kind === "notification" || envelope.kind === "serverRequest") {
				this.handleInboundCall(message as Record<string, unknown>);
			} else {
				this.handleResponse(message as Record<string, unknown>);
			}
		} catch (error) {
			this.fail(toError(error));
		}
	};

	private readonly handleClosed = (payload: unknown): void => {
		if (this.disposed) { return; }
		if (isRecord(payload) && payload.intentional === true) { this.shutdown(new Error('App Server connection stopped'), 'stopped'); return; }
		const message = isRecord(payload) && typeof payload.message === "string" && payload.message.trim()
			? payload.message
			: "App Server bridge closed";
		this.fail(new Error(message));
	};

	private handleResponse(message: Record<string, unknown>): void {
		if (!Number.isSafeInteger(message.id) || (message.id as number) <= 0) throw new Error("App Server emitted an invalid response ID");
		const id = message.id as number;
		const pending = this.pending.get(id);
		if (!pending) return;
		const response = decodeAppServerResponse(pending.method, message);
		this.pending.delete(id);
		clearTimeout(pending.timeout);
		if ("error" in response) {
			pending.reject(new AppServerRemoteError(response.error.code, response.error.message, response.error.data));
			return;
		}
		pending.resolve(response.result);
	}

	private handleInboundCall(message: Record<string, unknown>): void {
		if (Object.hasOwn(message, "id")) {
			if (typeof message.method === 'string' && !Object.hasOwn(APP_SERVER_SERVER_REQUESTS, message.method)) {
				this.transport.send(WEB_APP_SERVER_FRAME_EVENT, { frame: JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } }) });
				return;
			}
			const request = decodeAppServerServerRequest(message);
			if (this.inbound.has(request.id) || this.inbound.size >= 128) {
				throw new Error('App Server inbound request limit or duplicate ID');
			}
			const handler = this.handlers.get(request.method);
			if (!handler) {
				this.transport.send(WEB_APP_SERVER_FRAME_EVENT, { frame: JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } }) });
				return;
			}
			const controller = new AbortController();
			this.inbound.set(request.id, controller);
			const reply = (response: object): void => {
				if (this.inbound.get(request.id) !== controller) { return; }
				this.inbound.delete(request.id);
				clearTimeout(timeout);
				this.transport.send(WEB_APP_SERVER_FRAME_EVENT, { frame: JSON.stringify({ jsonrpc: '2.0', id: request.id, ...response }) });
			};
			const timeout = setTimeout(() => {
				controller.abort();
				reply({ error: { code: -32000, message: 'Host request timed out' } });
			}, this.options.requestTimeoutMs);
			controller.signal.addEventListener('abort', () => clearTimeout(timeout), { once: true });
			void Promise.resolve().then(() => handler(request.params as never, { signal: controller.signal })).then(
				value => reply({ result: decodeAppServerServerRequestResult(request.method, value) }),
				error => reply({ error: { code: -32000, message: toError(error).message } }),
			).catch(error => this.fail(toError(error)));
			return;
		}
		const wireNotification = decodeAppServerNotification(message);
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
		this.shutdown(error, this._state === "stopped" ? "stopped" : "crashed");
		this.transport.send(WEB_APP_SERVER_DISCONNECT_EVENT, { protocolVersion: WEB_APP_SERVER_PROTOCOL_VERSION });
	}

	private shutdown(error: Error, state: AppServerConnectionState): void {
		this.clearConnectTimeout();
		const reject = this.connectReject;
		this.connectResolve = undefined;
		this.connectReject = undefined;
		reject?.(error);
		for (const [id] of this.pending) this.rejectPending(id, error);
		for (const controller of this.inbound.values()) { controller.abort(); }
		this.inbound.clear();
		this.setState(state);
	}

	private clearConnectTimeout(): void {
		if (this.connectTimeout !== undefined) clearTimeout(this.connectTimeout);
		this.connectTimeout = undefined;
	}

	private setState(state: AppServerConnectionState): void {
		if (this._state === state) return;
		this._state = state;
		for (const listener of this.stateListeners) {
			try {
				listener(state);
			} catch {
				// State observers are isolated from the connection lifecycle.
			}
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

function validateFramePayload(payload: unknown): string {
	if (!isRecord(payload) || typeof payload.frame !== "string") throw new Error("App Server bridge frame is invalid");
	if (VSBuffer.fromString(payload.frame).byteLength > MAX_FRAME_BYTES) throw new Error(`App Server frame exceeds ${MAX_FRAME_BYTES} bytes`);
	return payload.frame;
}

function validateInitializeResult(value: InitializeResult): Pick<InitializeResult, "capabilities" | "slashCommands"> {
	const initialized = validateAppServerInitializeResult(value, { expectedServerName: "ash-app-server" });
	return { capabilities: initialized.capabilities, slashCommands: initialized.slashCommands };
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
