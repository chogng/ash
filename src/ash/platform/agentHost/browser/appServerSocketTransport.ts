import { VSBuffer } from '../../../base/common/buffer.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { isRecord } from '../../../base/common/types.js';
import { SocketCloseEventType, type ISocket, type SocketCloseEvent } from '../../../base/parts/ipc/common/ipc.net.js';
import { IRemoteSocketFactoryService } from '../../remote/common/remoteSocketFactoryService.js';
import { RemoteConnectionType } from '../../remote/common/remoteAuthorityResolver.js';
import type { IAddressProvider } from '../../remote/common/remoteAgentConnection.js';
import { AppServerFrame, deferAppServerRead, type AppServerTransport, WEB_APP_SERVER_CONNECT_EVENT, WEB_APP_SERVER_CONNECTED_EVENT, WEB_APP_SERVER_DISCONNECT_EVENT, WEB_APP_SERVER_FRAME_EVENT, WEB_APP_SERVER_CLOSED_EVENT } from '../common/appServerTransport.js';

const framePageBytes = 64 * 1024;
const maxFrameBytes = 320 * 1024 * 1024;

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
	private pendingConsumption: Promise<void> | undefined;

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
					// WebSocket already owns the message boundary; stream carriers use JSONL.
					if (isWebSocket) { this.acceptFrame(data); } else { this.acceptData(data); }
					// Partial chunks arriving behind an asynchronous frame also retain
					// credit, so the existing Main stdout pause reaches the slow consumer.
					if (this.pendingConsumption) { deferAppServerRead(data, this.pendingConsumption); }
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
		for (; ;) {
			const index = data.buffer.indexOf(10, start);
			if (index === -1) {
				this.append(data.slice(start));
				return;
			}
			let bytes = data.slice(start, index);
			if (this.bufferedBytes) {
				if (!this.append(bytes)) { return; }
				const lastPageBytes = this.bufferedBytes % framePageBytes;
				if (lastPageBytes) {
					this.parts[this.parts.length - 1] = this.parts[this.parts.length - 1].slice(0, lastPageBytes);
				}
				bytes = this.parts.length === 1 ? this.parts[0] : VSBuffer.concat(this.parts, this.bufferedBytes);
				this.parts = [];
				this.bufferedBytes = 0;
			}
			// A complete frame in this callback is decoded before its input can be reused.
			if (!this.acceptFrame(bytes)) { return; }
			start = index + 1;
		}
	}

	private append(data: VSBuffer): boolean {
		if (this.bufferedBytes + data.byteLength > maxFrameBytes) {
			this.disconnect();
			this.emit(WEB_APP_SERVER_CLOSED_EVENT, { message: 'App Server frame exceeds transport capacity' });
			return false;
		}
		// Fixed pages own retained bytes with one copy, independent of packet size.
		// The frame limit also bounds the number of pages even for one-byte packets.
		let offset = 0;
		while (offset < data.byteLength) {
			const pageOffset = this.bufferedBytes % framePageBytes;
			if (pageOffset === 0) { this.parts.push(VSBuffer.alloc(framePageBytes)); }
			const length = Math.min(framePageBytes - pageOffset, data.byteLength - offset);
			this.parts[this.parts.length - 1].buffer.set(data.buffer.subarray(offset, offset + length), pageOffset);
			this.bufferedBytes += length;
			offset += length;
		}
		return true;
	}

	private acceptFrame(bytes: VSBuffer): boolean {
		if (bytes.byteLength > maxFrameBytes) {
			this.disconnect();
			this.emit(WEB_APP_SERVER_CLOSED_EVENT, { message: 'App Server frame exceeds transport capacity' });
			return false;
		}
		try {
			if (!bytes.byteLength || bytes.buffer.at(-1) === 13) {
				throw new Error('App Server JSONL requires nonempty LF frames');
			}
			const frame = new TextDecoder('utf-8', { fatal: true }).decode(bytes.buffer);
			const payload = new AppServerFrame(frame, bytes.byteLength);
			this.emit(WEB_APP_SERVER_FRAME_EVENT, payload);
			if (this.socket && payload.consumed) {
				const consumed = this.pendingConsumption = payload.consumed;
				void consumed.then(() => { if (this.pendingConsumption === consumed) this.pendingConsumption = undefined; });
			}
			return this.socket !== undefined;
		} catch (error) {
			this.disconnect();
			this.emit(WEB_APP_SERVER_CLOSED_EVENT, { message: String(error) });
			return false;
		}
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
		this.pendingConsumption = undefined;
	}

	private emit(event: string, payload: unknown): void {
		for (const listener of this.listeners.get(event) ?? []) {
			listener(payload);
		}
	}
}
