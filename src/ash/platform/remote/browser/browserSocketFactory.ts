import { VSBuffer } from '../../../base/common/buffer.js';
import { Emitter, type Event } from '../../../base/common/event.js';
import { Disposable, DisposableStore, toDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
import { SocketCloseEventType, type ISocket, type SocketCloseEvent, type SocketDiagnosticsEventType } from '../../../base/parts/ipc/common/ipc.net.js';
import { RemoteConnectionType, type WebSocketRemoteConnection } from '../common/remoteAuthorityResolver.js';
import type { ISocketFactory } from '../common/remoteSocketFactoryService.js';

export interface IWebSocketCloseEvent {
	readonly code: number;
	readonly reason: string;
	readonly wasClean: boolean;
	readonly event: unknown | undefined;
}
export interface IWebSocket {
	readonly onData: Event<ArrayBuffer>;
	readonly onOpen: Event<void>;
	readonly onClose: Event<IWebSocketCloseEvent | void>;
	readonly onError: Event<unknown>;
	send(data: ArrayBuffer | ArrayBufferView<ArrayBuffer>): void;
	close(): void;
	traceSocketEvent?(type: SocketDiagnosticsEventType, data?: unknown): void;
}
export interface IWebSocketFactory {
	create(url: string, debugLabel: string): IWebSocket;
}

class BrowserWebSocket extends Disposable implements IWebSocket {
	private readonly data = this._register(new Emitter<ArrayBuffer>());
	private readonly opened = this._register(new Emitter<void>());
	private readonly closed = this._register(new Emitter<IWebSocketCloseEvent>());
	private readonly errors = this._register(new Emitter<unknown>());
	public readonly onData = this.data.event;
	public readonly onOpen = this.opened.event;
	public readonly onClose = this.closed.event;
	public readonly onError = this.errors.event;
	private readonly socket: WebSocket;

	constructor(url: string) {
		super();
		const endpoint = new URL(url);
		const token = endpoint.searchParams.get('connectionToken');
		endpoint.searchParams.delete('connectionToken');
		this.socket = new WebSocket(endpoint, token ? `ash-session.${token}` : undefined);
		this.socket.binaryType = 'arraybuffer';
		const message = (event: MessageEvent): void => {
			if (typeof event.data === 'string') { this.data.fire(new TextEncoder().encode(event.data).buffer); }
			else if (event.data instanceof ArrayBuffer) { this.data.fire(event.data); }
			else { this.errors.fire(new Error('Unsupported remote WebSocket message')); this.close(); }
		};
		const open = (): void => this.opened.fire();
		const close = (event: CloseEvent): void => {
			this.closed.fire({ code: event.code, reason: event.reason, wasClean: event.wasClean, event });
			this.dispose();
		};
		const error = (): void => this.errors.fire(new Error('Remote WebSocket failed'));
		this.socket.addEventListener('message', message);
		this.socket.addEventListener('open', open);
		this.socket.addEventListener('close', close);
		this.socket.addEventListener('error', error);
		this._register(toDisposable(() => {
			this.socket.removeEventListener('message', message);
			this.socket.removeEventListener('open', open);
			this.socket.removeEventListener('close', close);
			this.socket.removeEventListener('error', error);
			this.socket.close();
		}));
	}

	public send(data: ArrayBuffer | ArrayBufferView<ArrayBuffer>): void {
		this.assertNotDisposed();
		// Text and binary messages expose the same bytes to ISocket; JSON peers accept text frames.
		let text: string;
		try { text = new TextDecoder('utf-8', { fatal: true }).decode(data); }
		catch { this.socket.send(data); return; }
		this.socket.send(text);
	}
	public close(): void { this.dispose(); }
}

export class BrowserSocket extends Disposable implements ISocket {
	private readonly data = this._register(new Emitter<VSBuffer>());
	private readonly closed = this._register(new Emitter<SocketCloseEvent>());
	private readonly ended = this._register(new Emitter<void>());

	constructor(public readonly socket: IWebSocket, public readonly debugLabel: string) {
		super();
		this._register(toDisposable(() => socket.close()));
		this._register(socket.onData(data => this.data.fire(VSBuffer.wrap(new Uint8Array(data)))));
		this._register(socket.onClose(event => {
			this.closed.fire(event ? { type: SocketCloseEventType.WebSocketCloseEvent, ...event } : undefined);
			this.ended.fire();
			this.dispose();
		}));
	}

	public onData(listener: (data: VSBuffer) => void): IDisposable { return this.data.event(listener); }
	public onClose(listener: (event: SocketCloseEvent) => void): IDisposable { return this.closed.event(listener); }
	public onEnd(listener: () => void): IDisposable { return this.ended.event(listener); }
	public write(buffer: VSBuffer): void { this.assertNotDisposed(); this.socket.send(buffer.buffer.slice()); }
	public end(): void { this.dispose(); }
	public async drain(): Promise<void> { this.assertNotDisposed(); }
	public traceSocketEvent(type: SocketDiagnosticsEventType, data?: unknown): void { this.socket.traceSocketEvent?.(type, data); }
}

export class BrowserSocketFactory implements ISocketFactory<RemoteConnectionType.WebSocket> {
	private readonly factory: IWebSocketFactory;

	constructor(webSocketFactory: IWebSocketFactory | null | undefined) {
		this.factory = webSocketFactory ?? { create: url => new BrowserWebSocket(url) };
	}

	public supports(_connection: WebSocketRemoteConnection): boolean { return true; }

	public async connect(connection: WebSocketRemoteConnection, path: string, query: string, debugLabel: string): Promise<ISocket> {
		const host = connection.host.includes(':') ? `[${connection.host}]` : connection.host;
		const scheme = globalThis.location?.protocol === 'https:' ? 'wss' : 'ws';
		const peer = this.factory.create(`${scheme}://${host}:${connection.port}/${path.replace(/^\//, '')}${query ? `?${query}` : ''}`, debugLabel);
		const socket = new BrowserSocket(peer, debugLabel);
		using waiting = new DisposableStore();
		try {
			await new Promise<void>((resolve, reject) => {
				waiting.add(peer.onOpen(resolve));
				waiting.add(peer.onError(reject));
				waiting.add(peer.onClose(() => reject(new Error('Remote socket closed before opening'))));
				const timeout = setTimeout(() => reject(new Error('Remote socket opening timed out')), 30_000);
				waiting.add(toDisposable(() => clearTimeout(timeout)));
			});
			return socket;
		} catch (error) { socket.dispose(); throw error; }
	}
}
