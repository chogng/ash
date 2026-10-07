import { VSBuffer } from '../../../common/buffer.js';
import { createCancelablePromise, type CancelablePromise } from '../../../common/async.js';
import type { CancellationToken } from '../../../common/cancellation.js';
import { CancellationError } from '../../../common/errors.js';
import { Emitter } from '../../../common/event.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../common/lifecycle.js';
import { generateUuid } from '../../../common/uuid.js';
import { ipcRenderer } from '../../sandbox/electron-browser/globals.js';
import { IPCClient, type IChannel, type IMessagePassingProtocol, type IServerChannel } from '../common/ipc.js';
import { acquirePort } from './ipc.mp.js';

class RendererProtocol extends Disposable implements IMessagePassingProtocol {
	private readonly messages = this._register(new Emitter<VSBuffer>());
	public readonly onMessage = this.messages.event;
	private readonly closed = this._register(new Emitter<void>());
	public readonly onDidClose = this.closed.event;
	private port: MessagePort | undefined;

	public attach(port: MessagePort): void {
		this.assertNotDisposed();
		this.port = port;
		port.onmessage = event => {
			if (!(event.data instanceof Uint8Array)) { this.dispose(); return; }
			this.messages.fire(VSBuffer.wrap(new Uint8Array(event.data)));
		};
		port.onmessageerror = () => this.dispose();
		port.start();
		this._register(toDisposable(() => { this.closed.fire(); port.onmessage = null; port.onmessageerror = null; port.close(); }));
	}
	public send(buffer: VSBuffer): void {
		if (!this.port || this.isDisposed) { throw new Error('Main process IPC is not connected'); }
		this.port.postMessage(buffer.buffer);
	}
}

/** Owns the document's Main connection; the trusted acquisition route assigns its window context. */
export class Client extends Disposable {
	private readonly protocol = this._register(new RendererProtocol());
	private readonly peer = this._register(new MutableDisposable<IPCClient>());
	private connecting: CancelablePromise<void> | undefined;

	constructor(private readonly id: string) {
		super();
		this._register(toDisposable(() => this.connecting?.cancel()));
	}

	public connect(): Promise<void> {
		this.assertNotDisposed();
		return this.connecting ??= createCancelablePromise(token => this.acquire(token));
	}
	public getChannel<T extends IChannel>(name: string): T {
		if (!this.peer.value) { throw new Error('Main process IPC is not connected'); }
		return this.peer.value.getChannel<T>(name);
	}
	public registerChannel(name: string, channel: IServerChannel<string>): void {
		if (!this.peer.value) { throw new Error('Main process IPC is not connected'); }
		this.peer.value.registerChannel(name, channel);
	}

	private async acquire(token: CancellationToken): Promise<void> {
		const nonce = generateUuid();
		const port = acquirePort(undefined, 'ash:ipc:port', nonce);
		using resources = new DisposableStore();
		resources.add(toDisposable(() => port.cancel()));
		const cancelled = new Promise<never>((_resolve, reject) => resources.add(token.onCancellationRequested(() => reject(new CancellationError()))));
		let received: MessagePort | undefined;
		try {
			// Both promises are observed immediately: failure in Main must release the preload registration.
			const [value] = await Promise.race([
				Promise.all([port.then(value => { received = value; return value; }), ipcRenderer.invoke('ash:ipc:connect', { nonce })]),
				cancelled,
			]);
			if (token.isCancellationRequested) { throw new CancellationError(); }
			this.protocol.attach(value);
			this.peer.value = new IPCClient(this.protocol, this.id);
		} catch (error) { received?.close(); throw error; }
	}
}
