import { VSBuffer } from '../../../common/buffer.js';
import { Emitter } from '../../../common/event.js';
import { Disposable, toDisposable } from '../../../common/lifecycle.js';
import { IPCClient, type IMessagePassingProtocol } from './ipc.js';

export interface IMessagePort {
	postMessage(data: Uint8Array): void;
	addEventListener(type: 'message' | 'close', listener: (event: { data: unknown; }) => void): void;
	removeEventListener(type: 'message' | 'close', listener: (event: { data: unknown; }) => void): void;
	start(): void;
	close(): void;
}

class Protocol extends Disposable implements IMessagePassingProtocol {
	private readonly messages = this._register(new Emitter<VSBuffer>());
	public readonly onMessage = this.messages.event;
	private readonly closed = this._register(new Emitter<void>());
	public readonly onDidClose = this.closed.event;
	constructor(private readonly port: IMessagePort) {
		super();
		const message = (event: { data: unknown; }): void => {
			if (!(event.data instanceof Uint8Array)) { this.closed.fire(); return; }
			this.messages.fire(VSBuffer.wrap(new Uint8Array(event.data)));
		};
		const close = (): void => this.closed.fire();
		port.addEventListener('message', message);
		port.addEventListener('close', close);
		this._register(toDisposable(() => {
			port.removeEventListener('message', message); port.removeEventListener('close', close); port.close();
		}));
		port.start();
	}
	public send(buffer: VSBuffer): void { this.port.postMessage(buffer.buffer); }
}

/** The connection owns its port; closing either process rejects every pending call. */
export class Client extends IPCClient {
	constructor(port: IMessagePort, clientId: string) {
		const protocol = new Protocol(port);
		super(protocol, clientId);
		this._register(protocol);
	}
}
