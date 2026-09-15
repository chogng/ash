import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import { isRecord } from '../../../base/common/types.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { invoke, subscribe } from '../../ipc/electron-browser/rendererIpc.js';
import type { AppServerTransport } from '../common/appServerTransport.js';
import { WEB_APP_SERVER_CLOSED_EVENT, WEB_APP_SERVER_CONNECTED_EVENT, WEB_APP_SERVER_CONNECT_EVENT, WEB_APP_SERVER_DISCONNECT_EVENT, WEB_APP_SERVER_FRAME_EVENT } from '../common/appServerTransport.js';

/** Acquires and owns a renderer-exclusive MessagePort without interpreting protocol messages. */
export class AppServerMessagePortTransport extends Disposable implements AppServerTransport {
	private readonly listeners = new Map<string, Set<(value: unknown) => void>>();
	private port: MessagePort | undefined;
	private nonce: string | undefined;
	private readonly pending: number[] = [];
	private pendingBytes = 0;
	private metadata: unknown;
	private enabled: boolean | undefined;
	private resolveReady: (() => void) | undefined;
	private rejectReady: ((error: Error) => void) | undefined;

	constructor(private readonly restart: () => void) {
		super();
		window.addEventListener('message', this.receivePort);
		this._register(toDisposable(() => { window.removeEventListener('message', this.receivePort); this.close(); }));
		const subscription = subscribe('ash:app-server:restart', restart);
		this._register(toDisposable(() => subscription.dispose()));
	}

	public on(event: string, listener: (payload: unknown) => void): void {
		let listeners = this.listeners.get(event);
		if (!listeners) { listeners = new Set(); this.listeners.set(event, listeners); }
		listeners.add(listener);
	}

	public off(event: string, listener: (payload: unknown) => void): void { this.listeners.get(event)?.delete(listener); }

	public async acquire(): Promise<boolean> {
		this.assertNotDisposed();
		this.close();
		const nonce = this.nonce = generateUuid();
		const ready = new Promise<void>((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
		const timeout = setTimeout(() => this.fail('App Server port acquisition timed out'), 10_000);
		const acquisition = invoke<unknown>('ash:app-server:acquire', { nonce }).then(result => {
			if (this.nonce !== nonce) { throw new Error('Connection acquisition superseded'); }
			if (!isRecord(result) || typeof result.enabled !== 'boolean') { throw new Error('Invalid connection acquisition response'); }
			this.enabled = result.enabled;
			this.metadata = result;
			if (!result.enabled) { this.resolveReady?.(); }
		});
		try { await Promise.all([acquisition, ready]); return this.enabled === true; }
		catch (error) { this.close(); throw error; }
		finally { clearTimeout(timeout); this.resolveReady = undefined; this.rejectReady = undefined; }
	}

	public async initialized(): Promise<void> { await invoke('ash:app-server:initialized', { nonce: this.nonce }); }

	public send(event: string, payload?: unknown): void {
		if (event === WEB_APP_SERVER_DISCONNECT_EVENT) { this.close(); return; }
		if (event === WEB_APP_SERVER_CONNECT_EVENT) {
			if (!this.enabled || !this.port) { throw new Error('App Server port was not acquired'); }
			this.emit(WEB_APP_SERVER_CONNECTED_EVENT, this.metadata);
			return;
		}
		if (event !== WEB_APP_SERVER_FRAME_EVENT || !this.port || !isRecord(payload) || typeof payload.frame !== 'string') { throw new Error('Invalid App Server transport frame'); }
		const size = new TextEncoder().encode(payload.frame).length;
		if (this.pending.length >= 128 || this.pendingBytes + size > 320 * 1024 * 1024) { throw new Error('App Server transport capacity exceeded'); }
		this.pending.push(size);
		this.pendingBytes += size;
		this.port.postMessage({ frame: payload.frame });
	}

	private readonly receivePort = (event: MessageEvent): void => {
		if (event.source !== window || !isRecord(event.data) || event.data.type !== 'ash:app-server:port' || event.data.nonce !== this.nonce || event.ports.length !== 1) { return; }
		const port = event.ports[0];
		this.port = port;
		port.onmessage = event => {
			if (this.port !== port) { return; }
			const value: unknown = event.data;
			if (!isRecord(value)) { this.fail('Invalid transport message'); return; }
			if (value.ack === true && this.pending.length > 0) { this.pendingBytes -= this.pending.shift()!; return; }
			if (typeof value.frame === 'string') {
				this.emit(WEB_APP_SERVER_FRAME_EVENT, value);
				if (this.port === port) { port.postMessage({ ack: true }); }
				return;
			}
			if (value.intentional === true) { this.close(); this.emit(WEB_APP_SERVER_CLOSED_EVENT, { intentional: true }); return; }
			this.fail(typeof value.closed === 'string' ? value.closed : 'App Server connection closed');
		};
		port.onmessageerror = () => this.fail('App Server port message could not be decoded');
		port.start();
		this.resolveReady?.();
	};

	private fail(message: string): void {
		this.rejectReady?.(new Error(message));
		this.close();
		this.emit(WEB_APP_SERVER_CLOSED_EVENT, { message });
	}

	private close(): void { this.port?.close(); this.port = undefined; this.nonce = undefined; this.pending.length = 0; this.pendingBytes = 0; this.rejectReady?.(new Error('App Server connection closed')); }
	private emit(event: string, payload: unknown): void { for (const listener of this.listeners.get(event) ?? []) { listener(payload); } }
}
