import { WebSocket } from 'undici';
import { Disposable, toDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
import { Emitter } from '../../../base/common/event.js';
import { localize } from '../../../nls.js';
import { decodeWebSessionInfo } from '../../../../../.build/protocol/typescript/WebProtocolDecoder.js';
import type { IAppServerByteTransport } from '../common/appServerTransport.js';
import { tunnelEndpoint } from '../common/remoteAgentHostService.js';
import { DEFAULT_MAX_JSONL_FRAME_BYTES } from './childProcessJsonlTransport.js';

/** Transient authentication for one self-hosted SSH-forwarded Tunnel. No tokens enter the registry. */
export class TunnelAgentHostService extends Disposable {
	public readonly description = 'Ash Tunnel';
	private readonly cancellation = new AbortController();
	private token: string | undefined;
	private workspaceRoot: string | undefined;
	private authentication: Promise<void> | undefined;
	private readonly endpoint: URL;

	constructor(endpoint: string, private ticket: string | undefined) {
		const url = tunnelEndpoint(endpoint);
		if (!ticket || !/^[a-f0-9]{64}$/.test(ticket)) throw new TypeError('Invalid Ash Tunnel ticket');
		super();
		this.endpoint = url;
		this._register(toDisposable(() => { this.cancellation.abort(); this.token = this.ticket = undefined; }));
	}

	public async acquire(signal: AbortSignal): Promise<string> {
		const cancel = (): void => this.cancellation.abort();
		signal.addEventListener('abort', cancel, { once: true });
		try { if (signal.aborted) cancel(); await this.validate(); return this.workspaceRoot!; }
		finally { signal.removeEventListener('abort', cancel); }
	}

	public validate(): Promise<void> {
		this.assertNotDisposed();
		if (this.authentication) return this.authentication;
		const operation = this.authenticate();
		this.authentication = operation;
		void operation.finally(() => { if (this.authentication === operation) this.authentication = undefined; }).catch(() => { });
		return operation;
	}

	private async authenticate(): Promise<void> {
		const response = await fetch(new URL('/ash/session', this.endpoint), {
			method: 'POST', redirect: 'error', cache: 'no-store',
			headers: { Origin: this.endpoint.origin, ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) },
			body: this.token ? '' : this.ticket,
			signal: AbortSignal.any([this.cancellation.signal, AbortSignal.timeout(15_000)]),
		});
		if (!response.ok) throw new Error(localize('agentHost.tunnelAuthorization', 'Tunnel authorization expired or was revoked. Open a new authenticated link.'));
		const session = decodeWebSessionInfo(await response.json());
		this.assertNotDisposed();
		if (this.workspaceRoot !== undefined && session.workspaceRoot !== this.workspaceRoot) throw new Error(localize('agentHost.tunnelWorkspaceChanged', 'Tunnel workspace changed. Connect again using a new authenticated link.'));
		this.workspaceRoot = session.workspaceRoot;
		this.token = session.token;
		this.ticket = undefined;
	}

	public async openTransport(): Promise<IAppServerByteTransport> {
		this.assertNotDisposed();
		if (!this.token) throw new Error('Tunnel authentication is required');
		const url = new URL('/ash/app-server', this.endpoint);
		url.protocol = 'ws:';
		const socket = new WebSocket(url, { protocols: `ash-session.${this.token}`, headers: { Origin: this.endpoint.origin } });
		const transport = new WebSocketByteTransport(socket, this.cancellation.signal);
		try {
			await transport.ready;
			// The relay is the sole transport owner. This service retires acquisition through its abort signal.
			return transport;
		} catch (error) {
			transport.dispose();
			throw error;
		}
	}
}

/** Converts WebSocket text frames to JSONL bytes without interpreting their protocol payloads. */
class WebSocketByteTransport extends Disposable implements IAppServerByteTransport {
	private readonly data = this._register(new Emitter<Uint8Array>());
	private readonly closed = this._register(new Emitter<Error>());
	private readonly pending: Uint8Array[] = [];
	private pendingBytes = 0;
	private paused = false;
	private terminalError: Error | undefined;
	private outgoing = Buffer.alloc(0);
	public readonly ready: Promise<void>;

	constructor(private readonly socket: WebSocket, signal: AbortSignal) {
		super();
		const close = (): void => this.dispose();
		signal.addEventListener('abort', close, { once: true });
		this._register(toDisposable(() => signal.removeEventListener('abort', close)));
		this.ready = new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => this.finish(), 15_000);
			const opened = (): void => { clearTimeout(timeout); resolve(); };
			const ended = this.closed.event(error => { clearTimeout(timeout); reject(error); });
			this._register(ended);
			socket.addEventListener('open', opened);
			this._register(toDisposable(() => { clearTimeout(timeout); socket.removeEventListener('open', opened); }));
		});
		const message = (event: Event): void => {
			const payload: unknown = (event as MessageEvent).data;
			if (typeof payload !== 'string') { this.finish(); return; }
			const bytes = Buffer.from(`${payload}\n`, 'utf8');
			if (bytes.byteLength > DEFAULT_MAX_JSONL_FRAME_BYTES || this.pending.length >= 128 || this.pendingBytes + bytes.byteLength > DEFAULT_MAX_JSONL_FRAME_BYTES) { this.finish(); return; }
			this.pending.push(bytes);
			this.pendingBytes += bytes.byteLength;
			this.flush();
		};
		const ended = (): void => this.finish();
		socket.addEventListener('message', message);
		socket.addEventListener('close', ended);
		socket.addEventListener('error', ended);
		this._register(toDisposable(() => {
			socket.removeEventListener('message', message);
			socket.removeEventListener('close', ended);
			socket.removeEventListener('error', ended);
			socket.close();
		}));
		if (signal.aborted) this.dispose();
	}

	public onData(listener: (bytes: Uint8Array) => void): IDisposable {
		const subscription = this.data.event(listener);
		queueMicrotask(() => this.flush());
		return subscription;
	}
	public onClose(listener: (error: Error) => void): IDisposable {
		if (!this.terminalError) return this.closed.event(listener);
		let active = true;
		queueMicrotask(() => { if (active) listener(this.terminalError!); });
		return toDisposable(() => { active = false; });
	}
	public pause(): void { this.paused = true; }
	public resume(): void { this.paused = false; this.flush(); }
	public diagnostics(): string { return this.terminalError?.message ?? ''; }
	public async close(): Promise<void> { this.dispose(); }
	public async sendBytes(bytes: Uint8Array): Promise<void> {
		if (this.terminalError || this.socket.readyState !== WebSocket.OPEN) throw new Error('Tunnel connection closed');
		if (this.outgoing.byteLength + bytes.byteLength + this.socket.bufferedAmount > DEFAULT_MAX_JSONL_FRAME_BYTES) throw new Error('Tunnel write capacity reached');
		this.outgoing = Buffer.concat([this.outgoing, bytes]);
		let end: number;
		while ((end = this.outgoing.indexOf(10)) >= 0) {
			this.socket.send(new TextDecoder('utf-8', { fatal: true }).decode(this.outgoing.subarray(0, end)));
			this.outgoing = end + 1 === this.outgoing.length ? Buffer.alloc(0) : this.outgoing.subarray(end + 1);
		}
	}
	private flush(): void {
		while (!this.paused && !this.terminalError && this.data.hasListeners() && this.pending.length) {
			const bytes = this.pending.shift()!;
			this.pendingBytes -= bytes.byteLength;
			this.data.fire(bytes);
		}
	}
	private finish(): void { this.dispose(); }
	public override dispose(): void {
		if (this.isDisposed) return;
		this.terminalError = new Error('Tunnel connection closed');
		this.closed.fire(this.terminalError);
		this.pending.length = 0;
		this.pendingBytes = 0;
		this.outgoing = Buffer.alloc(0);
		super.dispose();
	}
}
