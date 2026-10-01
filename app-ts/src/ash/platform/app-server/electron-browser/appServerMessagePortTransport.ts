import { Disposable, MutableDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import type { IDisposable } from '../../../base/common/lifecycle.js';
import { CancellationError } from '../../../base/common/errors.js';
import { acquirePort } from '../../../base/parts/ipc/electron-browser/ipc.mp.js';
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
	private readonly acquisition = this._register(new MutableDisposable<IDisposable>());

	constructor(private readonly restart: () => void) {
		super();
		this._register(toDisposable(() => this.close()));
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
		const port = acquirePort(undefined, 'ash:app-server:port', nonce);
		const cancellation = toDisposable(() => port.cancel());
		this.acquisition.value = cancellation;
		let enabled: boolean | undefined;
		const ready = port.then(value => {
			if (this.nonce !== nonce || this.isDisposed) {
				value.close();
				throw new CancellationError();
			}
			this.attach(value);
		}, error => { if (enabled !== false) { throw error; } });
		let timeout: ReturnType<typeof setTimeout>;
		const timedOut = new Promise<never>((_resolve, reject) => {
			timeout = setTimeout(() => {
				const error = new Error('App Server port acquisition timed out');
				// Reject with the timeout before closing cancels the pending port acquisition.
				reject(error);
				if (this.nonce === nonce) { this.fail(error.message); }
			}, 10_000);
		});
		const acquisition = invoke<unknown>('ash:app-server:acquire', { nonce }).then(result => {
			if (this.nonce !== nonce) { throw new CancellationError(); }
			if (!isRecord(result) || typeof result.enabled !== 'boolean') { throw new Error('Invalid connection acquisition response'); }
			this.enabled = enabled = result.enabled;
			this.metadata = result;
			if (!result.enabled) { port.cancel(); }
		});
		try {
			await Promise.race([Promise.all([acquisition, ready]), timedOut]);
			return this.enabled === true;
		} catch (error) {
			if (this.nonce === nonce) { this.close(); }
			throw error;
		} finally {
			clearTimeout(timeout!);
			if (this.acquisition.value === cancellation) { this.acquisition.clear(); }
		}
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

	private attach(port: MessagePort): void {
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
		port.onmessageerror = () => { if (this.port === port) { this.fail('App Server port message could not be decoded'); } };
		port.start();
	}

	private fail(message: string): void {
		this.close();
		this.emit(WEB_APP_SERVER_CLOSED_EVENT, { message });
	}

	private close(): void { this.acquisition.clear(); this.port?.close(); this.port = undefined; this.nonce = undefined; this.pending.length = 0; this.pendingBytes = 0; }
	private emit(event: string, payload: unknown): void { for (const listener of this.listeners.get(event) ?? []) { listener(payload); } }
}
