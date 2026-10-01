import { MessageChannelMain, type MessagePortMain, type WebContents } from 'electron/main';
import { VSBuffer } from '../../../common/buffer.js';
import { Emitter } from '../../../common/event.js';
import { Disposable, DisposableMap, DisposableStore, toDisposable, type IDisposable } from '../../../common/lifecycle.js';
import { IPCServer, type ClientConnectionEvent, type IMessagePassingProtocol } from '../common/ipc.js';

class MainProtocol extends Disposable implements IMessagePassingProtocol {
	private readonly messages = this._register(new Emitter<VSBuffer>());
	public readonly onMessage = this.messages.event;
	private readonly closed = this._register(new Emitter<void>());
	public readonly onDidClose = this.closed.event;
	constructor(private readonly port: MessagePortMain) {
		super();
		const receive = (event: { data: unknown }): void => {
			if (!(event.data instanceof Uint8Array)) { this.closed.fire(); return; }
			this.messages.fire(VSBuffer.wrap(new Uint8Array(event.data)));
		};
		const close = (): void => this.closed.fire();
		port.on('message', receive);
		port.on('close', close);
		this._register(toDisposable(() => { port.off('message', receive); port.off('close', close); port.close(); }));
		port.start();
	}
	public send(buffer: VSBuffer): void { this.port.postMessage(buffer.buffer); }
}

/** Ports are delivered only after the product's trusted sender and entry-URL gate succeeds. */
export class Server extends IPCServer {
	private readonly connected: Emitter<ClientConnectionEvent>;
	private readonly documents = this._register(new DisposableMap<number, IDisposable>());

	constructor() {
		const connected = new Emitter<ClientConnectionEvent>();
		super(connected.event);
		this.connected = this._register(connected);
	}

	public connect(sender: WebContents, context: string, nonce: string): void {
		this.assertNotDisposed();
		const resources = new DisposableStore();
		this.documents.set(sender.id, resources);
		const { port1, port2 } = new MessageChannelMain();
		const protocol = resources.add(new MainProtocol(port1));
		const disconnected = resources.add(new Emitter<void>());
		const stop = (): void => {
			// A late port close belongs to its own document, never the replacement connection.
			if (this.documents.get(sender.id) === resources) { this.documents.deleteAndDispose(sender.id); }
		};
		const navigate = (_event: unknown, _url: string, inPlace: boolean, mainFrame: boolean): void => {
			if (mainFrame && !inPlace) { stop(); }
		};
		sender.on('did-start-navigation', navigate);
		sender.on('destroyed', stop);
		resources.add(toDisposable(() => { sender.off('did-start-navigation', navigate); sender.off('destroyed', stop); }));
		resources.add(toDisposable(() => disconnected.fire()));
		this.connected.fire({ protocol, ctx: context, onDidClientDisconnect: disconnected.event });
		resources.add(protocol.onDidClose(stop));
		try { sender.postMessage('ash:ipc:port', { nonce }, [port2]); }
		catch (error) { port2.close(); stop(); throw error; }
	}
}
