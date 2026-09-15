import { AbstractDisposable } from '../../../base/common/lifecycle.js';
import { type AppServerTransport, WEB_APP_SERVER_CLOSED_EVENT, WEB_APP_SERVER_FRAME_EVENT, WEB_APP_SERVER_CONNECTED_EVENT } from '../common/appServerTransport.js';

const maxBufferedBytes = 320 * 1024 * 1024;

/** Carries connection events independently of the frontend development server. */
export class AppServerWebSocketTransport extends AbstractDisposable implements AppServerTransport {
	private readonly listeners = new Map<string, Set<(payload: unknown) => void>>();
	private readonly socket: WebSocket;
	private closed = false;
	private readonly pending: string[] = [];
	private pendingBytes = 0;

	constructor(url: URL) {
		super();
		this.socket = new WebSocket(url);
		this.socket.addEventListener('open', this.handleOpen);
		this.socket.addEventListener('message', this.handleMessage);
		this.socket.addEventListener('close', this.handleClose);
		this.socket.addEventListener('error', this.handleClose);
	}

	public on(event: string, listener: (payload: unknown) => void): void {
		let listeners = this.listeners.get(event);
		if (!listeners) this.listeners.set(event, listeners = new Set());
		listeners.add(listener);
	}

	public off(event: string, listener: (payload: unknown) => void): void {
		this.listeners.get(event)?.delete(listener);
	}

	public send(event: string, payload?: unknown): void {
		if (this.closed || this.isDisposed) return;
		const message = JSON.stringify({ event, payload });
		const bytes = new TextEncoder().encode(message).byteLength;
		if (this.pending.length >= 128 || this.pendingBytes + this.socket.bufferedAmount + bytes > maxBufferedBytes) {
			this.handleClose();
			return;
		}
		if (this.socket.readyState === WebSocket.OPEN) this.socket.send(message);
		else {
			this.pending.push(message);
			this.pendingBytes += bytes;
		}
	}

	private readonly handleOpen = (): void => {
		for (const message of this.pending) this.socket.send(message);
		this.pending.length = 0;
		this.pendingBytes = 0;
	};

	private readonly handleMessage = (event: MessageEvent): void => {
		try {
			if (typeof event.data !== 'string' || new TextEncoder().encode(event.data).byteLength > maxBufferedBytes) throw new Error('Invalid transport message');
			const message: unknown = JSON.parse(event.data);
			if (!message || typeof message !== 'object' || !('event' in message) || !('payload' in message) || typeof message.event !== 'string' || ![WEB_APP_SERVER_CONNECTED_EVENT, WEB_APP_SERVER_FRAME_EVENT, WEB_APP_SERVER_CLOSED_EVENT].includes(message.event)) throw new Error('Invalid transport event');
			for (const listener of this.listeners.get(message.event) ?? []) listener(message.payload);
		} catch {
			this.handleClose();
		}
	};

	private readonly handleClose = (): void => {
		if (this.closed) return;
		this.closed = true;
		this.pending.length = 0;
		this.pendingBytes = 0;
		this.socket.close();
		for (const listener of this.listeners.get(WEB_APP_SERVER_CLOSED_EVENT) ?? []) listener({ message: 'Web App Server connection closed' });
	};

	protected override disposeCore(): void {
		this.socket.removeEventListener('open', this.handleOpen);
		this.socket.removeEventListener('message', this.handleMessage);
		this.socket.removeEventListener('close', this.handleClose);
		this.socket.removeEventListener('error', this.handleClose);
		this.handleClose();
		this.listeners.clear();
	}
}
