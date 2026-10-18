import { Disposable, MutableDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import type { IDisposable } from '../../../base/common/lifecycle.js';
import { CancellationError } from '../../../base/common/errors.js';
import { acquirePort } from '../../../base/parts/ipc/electron-browser/ipc.mp.js';
import { isRecord } from '../../../base/common/types.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { invoke, subscribe } from '../../ipc/electron-browser/rendererIpc.js';
import { VSBuffer } from '../../../base/common/buffer.js';
import { Emitter } from '../../../base/common/event.js';
import { appServerConnectionChannel, getAppServerReadConsumption, type AppServerConnectionTarget } from '../common/appServerTransport.js';
import { SocketCloseEventType, type ISocket, type SocketCloseEvent, type SocketDiagnosticsEventType } from '../../../base/parts/ipc/common/ipc.net.js';

/** Acquires and owns a renderer-exclusive MessagePort without interpreting protocol messages. */
export class AppServerMessagePortTransport extends Disposable {
	private readonly socketOwner = this._register(new MutableDisposable<MessagePortSocket>());
	private nonce: string | undefined;
	private metadata: unknown;
	private enabled: boolean | undefined;
	private readonly acquisition = this._register(new MutableDisposable<IDisposable>());

	constructor(private readonly restart: () => void, private readonly connection: AppServerConnectionTarget = 'workspace', private readonly acquisitionTimeoutMs = 10_000) {
		super();
		this._register(toDisposable(() => this.close()));
		const subscription = subscribe(`${this.channelPrefix}:restart`, restart);
		this._register(toDisposable(() => subscription.dispose()));
	}

	private get channelPrefix(): string { return appServerConnectionChannel(this.connection); }

	public get connectionMetadata(): unknown {
		return this.metadata;
	}

	public get socket(): ISocket {
		const socket = this.socketOwner.value;
		if (!socket || socket.isClosed) {
			throw new Error('App Server port was not acquired or was closed');
		}
		return socket;
	}

	public async acquire(): Promise<boolean> {
		this.assertNotDisposed();
		this.close();
		const nonce = this.nonce = generateUuid();
		this.mark('acquire-start', nonce);
		const port = acquirePort(undefined, `${this.channelPrefix}:port`, nonce);
		const cancellation = toDisposable(() => port.cancel());
		this.acquisition.value = cancellation;
		let enabled: boolean | undefined;
		const ready = port.then(value => {
			if (this.nonce !== nonce || this.isDisposed) {
				value.close();
				throw new CancellationError();
			}
			this.socketOwner.value = new MessagePortSocket(value);
		}, error => { if (enabled !== false) { throw error; } });
		let timeout: ReturnType<typeof setTimeout>;
		const timedOut = new Promise<never>((_resolve, reject) => {
			timeout = setTimeout(() => {
				const error = new Error('App Server port acquisition timed out');
				// Reject with the timeout before closing cancels the pending port acquisition.
				reject(error);
				if (this.nonce === nonce) { this.close(); }
			}, this.acquisitionTimeoutMs);
		});
		const acquisition = invoke<unknown>(`${this.channelPrefix}:acquire`, { nonce }).then(result => {
			if (this.nonce !== nonce) { throw new CancellationError(); }
			if (!isRecord(result) || typeof result.enabled !== 'boolean' || (result.enabled && result.byteStream !== true)) { throw new Error('Invalid connection acquisition response'); }
			this.enabled = enabled = result.enabled;
			this.metadata = result;
			if (!result.enabled) { port.cancel(); }
		});
		try {
			await Promise.race([Promise.all([acquisition, ready]), timedOut]);
			this.mark('acquired', nonce);
			return this.enabled === true;
		} catch (error) {
			if (this.nonce === nonce) { this.close(); }
			throw error;
		} finally {
			clearTimeout(timeout!);
			if (this.acquisition.value === cancellation) { this.acquisition.clear(); }
		}
	}

	public async initialized(): Promise<void> {
		const nonce = this.nonce;
		await invoke(`${this.channelPrefix}:initialized`, { nonce });
		this.mark('initialized', nonce);
	}

	/** A lease owns its diagnostics; late replies cannot recreate retired marks. */
	private mark(phase: string, nonce: string | undefined): void {
		if (nonce !== undefined && nonce === this.nonce && !this.isDisposed) {
			performance.mark(`ash.appServer.port-${phase}:${nonce}`, { detail: { nonce } });
		}
	}

	private close(): void {
		if (this.nonce !== undefined) {
			for (const phase of ['acquire-start', 'acquired', 'initialized']) {
				performance.clearMarks(`ash.appServer.port-${phase}:${this.nonce}`);
			}
		}
		this.acquisition.clear();
		this.socketOwner.clear();
		this.nonce = undefined;
	}
}

/** One acquired port owns one byte socket; an older socket never writes to its replacement. */
class MessagePortSocket extends Disposable implements ISocket {
	private readonly dataEmitter = this._register(new Emitter<VSBuffer>());
	private readonly closeEmitter = this._register(new Emitter<SocketCloseEvent>());
	private readonly endEmitter = this._register(new Emitter<void>());
	public readonly onData = this.dataEmitter.event;
	public readonly onClose = this.closeEmitter.event;
	public readonly onEnd = this.endEmitter.event;
	private readonly pending: number[] = [];
	private pendingBytes = 0;
	private readonly drainWaiters = new Set<{ resolve(): void; reject(error: Error): void; }>();
	private closed = false;
	private ending = false;
	private failure: Error | undefined;
	public get isClosed(): boolean {
		return this.closed;
	}

	constructor(private readonly port: MessagePort) {
		super();
		this._register(toDisposable(() => this.finish()));
		port.onmessage = event => {
			if (this.closed) {
				return;
			}
			const value: unknown = event.data;
			if (!isRecord(value)) {
				this.finish(new Error('Invalid transport message'));
				return;
			}
			if (value.ack === true) {
				if (!this.pending.length) {
					this.finish(new Error('Unexpected transport write acknowledgement'));
					return;
				}
				this.pendingBytes -= this.pending.shift()!;
				if (!this.pending.length) {
					for (const waiter of this.drainWaiters) {
						waiter.resolve();
					}
					this.drainWaiters.clear();
				}
				return;
			}
			if (value.data instanceof Uint8Array && value.data.byteLength <= 320 * 1024 * 1024) {
				// Ordinary MessagePort storage is already owned; only shared storage
				// needs a copy before readers can safely retain or decode its contents.
				const data = value.data.buffer instanceof ArrayBuffer
					? new Uint8Array(value.data.buffer, value.data.byteOffset, value.data.byteLength)
					: new Uint8Array(value.data);
				const buffer = VSBuffer.wrap(data);
				this.dataEmitter.fire(buffer);
				const ack = (): void => { if (!this.closed) port.postMessage({ ack: true }); };
				const consumed = getAppServerReadConsumption(buffer);
				if (consumed) { void consumed.then(ack, () => this.finish(new Error('App Server read failed'))); }
				else { ack(); }
				return;
			}
			if (value.intentional === true) {
				this.finish();
				return;
			}
			this.finish(new Error(typeof value.closed === 'string' ? value.closed : 'App Server connection closed'));
		};
		port.onmessageerror = () => this.finish(new Error('App Server port message could not be decoded'));
		port.start();
	}

	public write(buffer: VSBuffer): void {
		if (this.closed || this.ending) {
			throw this.failure ?? new Error('App Server socket is closed');
		}
		if (this.pending.length >= 128 || this.pendingBytes + buffer.byteLength > 320 * 1024 * 1024) {
			const error = new Error('App Server transport capacity exceeded');
			this.finish(error);
			throw error;
		}
		this.pending.push(buffer.byteLength);
		this.pendingBytes += buffer.byteLength;
		try {
			this.port.postMessage({ data: buffer.buffer });
		} catch (error) {
			this.finish(error instanceof Error ? error : new Error('App Server byte write failed'));
			throw error;
		}
	}

	public drain(): Promise<void> {
		if (this.closed) {
			return Promise.reject(this.failure ?? new Error('App Server socket is closed'));
		}
		if (!this.pending.length) {
			return Promise.resolve();
		}
		return new Promise((resolve, reject) => this.drainWaiters.add({ resolve, reject }));
	}

	public end(): void {
		if (this.closed || this.ending) {
			return;
		}
		this.ending = true;
		void this.drain().then(() => this.finish(), error => this.finish(error));
	}

	public traceSocketEvent(type: SocketDiagnosticsEventType, data?: unknown): void {
		// Diagnostics report sizes, never protocol contents or credentials.
		console.debug('App Server MessagePort socket', type, data instanceof VSBuffer ? data.byteLength : undefined);
	}

	private finish(error?: Error): void {
		if (this.closed) {
			return;
		}
		this.closed = true;
		this.failure = error;
		if (!error) {
			// A renderer releasing its lease must not look like a failed carrier in Main.
			try { this.port.postMessage({ intentional: true }); }
			catch { /* The peer may already have closed its port. */ }
		}
		this.port.onmessage = null;
		this.port.onmessageerror = null;
		this.port.close();
		const closed = error ?? new Error('App Server socket is closed');
		for (const waiter of this.drainWaiters) {
			waiter.reject(closed);
		}
		this.drainWaiters.clear();
		this.pending.length = 0;
		this.pendingBytes = 0;
		// Publish the typed close before EOF: the protocol carrier needs its
		// intentional flag before an unclassified end can retire the socket.
		this.closeEmitter.fire({ type: SocketCloseEventType.NodeSocketCloseEvent, hadError: !!error, error });
		if (!error) {
			this.endEmitter.fire();
		}
	}
}
