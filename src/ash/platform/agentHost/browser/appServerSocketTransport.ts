import { VSBuffer } from '../../../base/common/buffer.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { isRecord } from '../../../base/common/types.js';
import { SocketCloseEventType, type ISocket, type SocketCloseEvent } from '../../../base/parts/ipc/common/ipc.net.js';
import { IRemoteSocketFactoryService } from '../../remote/common/remoteSocketFactoryService.js';
import { RemoteConnectionType } from '../../remote/common/remoteAuthorityResolver.js';
import type { IAddressProvider } from '../../remote/common/remoteAgentConnection.js';
import { type AppServerTransport, WEB_APP_SERVER_CONNECT_EVENT, WEB_APP_SERVER_CONNECTED_EVENT, WEB_APP_SERVER_DISCONNECT_EVENT, WEB_APP_SERVER_FRAME_EVENT, WEB_APP_SERVER_CLOSED_EVENT } from '../common/appServerTransport.js';

interface SocketConnection extends IAddressProvider {
	getMetadata(): unknown;
}

/** Keeps the Rust JSONL protocol above the byte carrier and owns one connected socket at a time. */
export class AppServerSocketTransport extends Disposable implements AppServerTransport {
	private readonly listeners = new Map<string, Set<(payload: unknown) => void>>();
	private readonly connectionResources = this._register(new MutableDisposable<DisposableStore>());
	private socket: ISocket | undefined;
	private revision = 0;
	private connecting = false;
	private messageFraming = false;
	private parts: VSBuffer[] = [];
	private bufferedBytes = 0;

	constructor(private readonly connection: SocketConnection, @IRemoteSocketFactoryService private readonly factories: IRemoteSocketFactoryService) {
		super();
		this._register(toDisposable(() => {
			this.disconnect();
			this.listeners.clear();
		}));
	}

	public on(event: string, listener: (payload: unknown) => void): void {
		let listeners = this.listeners.get(event);
		if (!listeners) {
			listeners = new Set();
			this.listeners.set(event, listeners);
		}
		listeners.add(listener);
	}

	public off(event: string, listener: (payload: unknown) => void): void {
		this.listeners.get(event)?.delete(listener);
	}

	public send(event: string, payload?: unknown): void {
		this.assertNotDisposed();
		if (event === WEB_APP_SERVER_CONNECT_EVENT) {
			void this.connect();
			return;
		}
		if (event === WEB_APP_SERVER_DISCONNECT_EVENT) {
			this.disconnect();
			return;
		}
		if (event !== WEB_APP_SERVER_FRAME_EVENT || !this.socket || !isRecord(payload) || typeof payload.frame !== 'string' || /[\r\n]/.test(payload.frame)) {
			throw new Error('Invalid App Server transport frame');
		}
		this.socket.write(VSBuffer.fromString(`${payload.frame}${this.messageFraming ? '' : '\n'}`));
	}

	private async connect(): Promise<void> {
		if (this.socket || this.connecting) {
			return;
		}
		this.connecting = true;
		const revision = this.revision;
		try {
			const address = await this.connection.getAddress();
			if (this.isDisposed || revision !== this.revision) { return; }
			const isWebSocket = address.connectTo.type === RemoteConnectionType.WebSocket;
			const query = isWebSocket && address.connectionToken ? `connectionToken=${encodeURIComponent(address.connectionToken)}` : '';
			const socket = await this.factories.connect(address.connectTo, isWebSocket ? '/ash/app-server' : '', query, 'ash-app-server');
			if (this.isDisposed || revision !== this.revision) {
				socket.dispose();
				return;
			}
			const resources = new DisposableStore();
			this.connectionResources.value = resources;
			this.socket = socket;
			this.messageFraming = isWebSocket;
			this.connecting = false;
			// The acquisition owner retains the carrier; this client closes its lease on disconnect.
			resources.add(toDisposable(() => socket.dispose()));
			resources.add(socket.onData(data => {
				if (this.socket === socket) {
					// WebSocket messages carry one JSON value; stream carriers retain JSONL boundaries.
					this.acceptData(isWebSocket ? VSBuffer.concat([data, VSBuffer.fromString('\n')]) : data);
				}
			}));
			resources.add(socket.onClose(event => {
				if (this.socket === socket) {
					this.closed(event);
				}
			}));
			resources.add(socket.onEnd(() => {
				if (this.socket === socket) { this.closed(undefined); }
			}));
			this.emit(WEB_APP_SERVER_CONNECTED_EVENT, this.connection.getMetadata());
		} catch (error) {
			if (!this.isDisposed && revision === this.revision) {
				this.disconnect();
				this.emit(WEB_APP_SERVER_CLOSED_EVENT, { message: String(error) });
			}
		}
	}

	private acceptData(data: VSBuffer): void {
		let start = 0;
		for (let index = 0; index < data.byteLength; index++) {
			if (data.buffer[index] !== 10) {
				continue;
			}
			if (!this.append(data.slice(start, index))) {
				return;
			}
			const bytes = VSBuffer.concat(this.parts, this.bufferedBytes);
			this.parts = [];
			this.bufferedBytes = 0;
			try {
				if (!bytes.byteLength || bytes.buffer.at(-1) === 13) {
					throw new Error('App Server JSONL requires nonempty LF frames');
				}
				const frame = new TextDecoder('utf-8', { fatal: true }).decode(bytes.buffer);
				this.emit(WEB_APP_SERVER_FRAME_EVENT, { frame });
				if (!this.socket) {
					return;
				}
			} catch (error) {
				this.disconnect();
				this.emit(WEB_APP_SERVER_CLOSED_EVENT, { message: String(error) });
				return;
			}
			start = index + 1;
		}
		this.append(data.slice(start));
	}

	private append(data: VSBuffer): boolean {
		if (this.bufferedBytes + data.byteLength > 320 * 1024 * 1024) {
			this.disconnect();
			this.emit(WEB_APP_SERVER_CLOSED_EVENT, { message: 'App Server frame exceeds transport capacity' });
			return false;
		}
		if (data.byteLength) {
			this.bufferedBytes += data.byteLength;
			let owned = VSBuffer.wrap(data.buffer.slice());
			// Keep geometrically sized fragments so tiny packets cannot grow an unbounded array
			// or force a copy of the entire partial frame on each packet.
			while (this.parts.length && this.parts[this.parts.length - 1].byteLength < owned.byteLength * 2) {
				owned = VSBuffer.concat([this.parts.pop()!, owned]);
			}
			this.parts.push(owned);
		}
		return true;
	}

	private closed(event: SocketCloseEvent): void {
		const partial = this.bufferedBytes > 0;
		this.disconnect();
		const intentional = !partial && event?.type === SocketCloseEventType.NodeSocketCloseEvent && !event.hadError;
		let message: string | undefined;
		if (partial) {
			message = 'App Server connection ended with an unterminated frame';
		} else if (event?.type === SocketCloseEventType.NodeSocketCloseEvent) {
			message = event.error?.message;
		} else {
			message = 'App Server connection closed';
		}
		const result: { intentional?: boolean; message: string | undefined; } = { message };
		if (intentional) {
			result.intentional = true;
		}
		this.emit(WEB_APP_SERVER_CLOSED_EVENT, result);
	}

	private disconnect(): void {
		this.revision++;
		this.connecting = false;
		this.socket = undefined;
		this.connectionResources.clear();
		this.parts = [];
		this.bufferedBytes = 0;
	}

	private emit(event: string, payload: unknown): void {
		for (const listener of this.listeners.get(event) ?? []) {
			listener(payload);
		}
	}
}
