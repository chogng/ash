import { AbstractDisposable } from '../../../base/common/lifecycle.js';
import { isRecord } from '../../../base/common/types.js';
import { decodeWebSessionInfo } from '../common/generated/WebProtocolDecoder.js';
import type { WebSessionInfo } from '../common/generated/index.js';
import { type AppServerTransport, WEB_APP_SERVER_CLOSED_EVENT, WEB_APP_SERVER_CONNECT_EVENT, WEB_APP_SERVER_DISCONNECT_EVENT, WEB_APP_SERVER_FRAME_EVENT, WEB_APP_SERVER_CONNECTED_EVENT, WEB_APP_SERVER_PROTOCOL_VERSION } from '../common/appServerTransport.js';

const maxBufferedBytes = 320 * 1024 * 1024;

export async function authenticateWebAppServer(endpoint: URL, storage: Storage, ticket: string | null): Promise<AppServerWebSocketTransport> {
	if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || !endpoint.port || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/') {
		throw new Error('Expected a loopback App Server endpoint');
	}
	const key = `ash.appServer.session:${endpoint.origin}`;
	const token = ticket ? undefined : storage.getItem(key);
	if (!ticket && !token) { throw new Error('Open the authenticated Web URL provided by the Ash launcher.'); }
	const response = await fetch(new URL('/ash/session', endpoint), {
		method: 'POST', credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(15_000),
		headers: token ? { Authorization: `Bearer ${token}` } : {}, body: ticket ?? '',
	});
	if (!response.ok) { storage.removeItem(key); throw new Error('The Web session expired. Open a new URL from the Ash launcher.'); }
	const session = decodeWebSessionInfo(await response.json());
	storage.setItem(key, session.token);
	storage.setItem('ash.appServer.endpoint', endpoint.href);
	return new AppServerWebSocketTransport(endpoint, session);
}

/** Carries raw JSON-RPC frames over one authenticated browser connection. */
export class AppServerWebSocketTransport extends AbstractDisposable implements AppServerTransport {
	private readonly listeners = new Map<string, Set<(payload: unknown) => void>>();
	private socket: WebSocket | undefined;
	private closed = true;
	private connectedBefore = false;
	private authentication: AbortController | undefined;

	constructor(private readonly endpoint: URL, private readonly session: WebSessionInfo) { super(); }

	public on(event: string, listener: (payload: unknown) => void): void {
		let listeners = this.listeners.get(event);
		if (!listeners) { this.listeners.set(event, listeners = new Set()); }
		listeners.add(listener);
	}

	public off(event: string, listener: (payload: unknown) => void): void { this.listeners.get(event)?.delete(listener); }

	public send(event: string, payload?: unknown): void {
		if (this.isDisposed) { return; }
		if (event === WEB_APP_SERVER_CONNECT_EVENT) {
			if (!this.closed) { return; }
			this.releaseSocket();
			this.closed = false;
			void this.openSocket();
			return;
		}
		if (event === WEB_APP_SERVER_DISCONNECT_EVENT) { this.handleClose(); return; }
		if (event !== WEB_APP_SERVER_FRAME_EVENT || this.closed) { return; }
		if (!isRecord(payload) || typeof payload.frame !== 'string' || !this.socket || this.socket.readyState !== WebSocket.OPEN
			|| this.socket.bufferedAmount + new TextEncoder().encode(payload.frame).byteLength > maxBufferedBytes) {
			this.handleClose(); return;
		}
		this.socket.send(payload.frame);
	}

	private readonly handleOpen = (): void => {
		this.connectedBefore = true;
		this.emit(WEB_APP_SERVER_CONNECTED_EVENT, { protocolVersion: WEB_APP_SERVER_PROTOCOL_VERSION, workspaceId: this.session.workspaceId, workspaceRoot: this.session.workspaceRoot });
	};

	private async openSocket(): Promise<void> {
		const authentication = new AbortController();
		this.authentication = authentication;
		try {
			if (this.connectedBefore) {
				const response = await fetch(new URL('/ash/session', this.endpoint), {
					method: 'POST', credentials: 'omit', cache: 'no-store',
					headers: { Authorization: `Bearer ${this.session.token}` }, body: '',
					signal: AbortSignal.any([authentication.signal, AbortSignal.timeout(10_000)]),
				});
				if (response.status === 401 || response.status === 403) {
					this.closed = true;
					this.emit(WEB_APP_SERVER_CLOSED_EVENT, { intentional: true, message: 'Web authorization expired or was revoked. Open a new authenticated link.' });
					return;
				}
				if (!response.ok) { throw new Error('Web App Server is unavailable'); }
				const session = decodeWebSessionInfo(await response.json());
				if (session.workspaceId !== this.session.workspaceId || session.workspaceRoot !== this.session.workspaceRoot) {
					this.closed = true;
					this.emit(WEB_APP_SERVER_CLOSED_EVENT, { intentional: true, message: 'Web workspace changed. Open a new authenticated link.' });
					return;
				}
			}
			if (authentication.signal.aborted || this.isDisposed || this.closed) { return; }
			const url = new URL('/ash/app-server', this.endpoint);
			url.protocol = 'ws:';
			this.socket = new WebSocket(url, `ash-session.${this.session.token}`);
			this.socket.addEventListener('open', this.handleOpen);
			this.socket.addEventListener('message', this.handleMessage);
			this.socket.addEventListener('close', this.handleClose);
			this.socket.addEventListener('error', this.handleClose);
		} catch { if (!authentication.signal.aborted) { this.handleClose(); } }
	}

	private readonly handleMessage = (event: MessageEvent): void => {
		if (typeof event.data !== 'string' || new TextEncoder().encode(event.data).byteLength > maxBufferedBytes) { this.handleClose(); return; }
		this.emit(WEB_APP_SERVER_FRAME_EVENT, { frame: event.data });
	};

	private readonly handleClose = (): void => {
		if (this.closed) { return; }
		this.closed = true;
		this.releaseSocket();
		this.emit(WEB_APP_SERVER_CLOSED_EVENT, { message: 'Web App Server connection closed' });
	};

	private emit(event: string, payload: unknown): void {
		for (const listener of this.listeners.get(event) ?? []) { listener(payload); }
	}

	private releaseSocket(): void {
		this.authentication?.abort();
		this.authentication = undefined;
		const socket = this.socket;
		this.socket = undefined;
		if (!socket) { return; }
		socket.removeEventListener('open', this.handleOpen);
		socket.removeEventListener('message', this.handleMessage);
		socket.removeEventListener('close', this.handleClose);
		socket.removeEventListener('error', this.handleClose);
		socket.close();
	}

	protected override disposeCore(): void { this.handleClose(); this.listeners.clear(); }
}
