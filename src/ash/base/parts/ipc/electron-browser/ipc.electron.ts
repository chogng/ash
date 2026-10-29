import { VSBuffer } from '../../../common/buffer.js';
import { Emitter } from '../../../common/event.js';
import { Disposable, toDisposable } from '../../../common/lifecycle.js';
import { ipcRenderer } from '../../sandbox/electron-browser/globals.js';
import { IPCClient, type IChannel, type IServerChannel } from '../common/ipc.js';

/** One channel connection belongs to each renderer document. Main assigns its trusted context. */
export class Client extends Disposable {
	private readonly messages = this._register(new Emitter<VSBuffer>());
	private readonly peer: IPCClient;

	constructor(id: string) {
		super();
		const subscription = ipcRenderer.on('ash:message', value => {
			if (value instanceof Uint8Array) {
				this.messages.fire(VSBuffer.wrap(new Uint8Array(value)));
			}
		});
		this._register(toDisposable(() => subscription.dispose()));
		this._register(toDisposable(() => ipcRenderer.send('ash:disconnect')));
		this.peer = this._register(new IPCClient({
			onMessage: this.messages.event,
			send: buffer => ipcRenderer.send('ash:message', buffer.buffer),
		}, id));
		// Electron preserves sender message order: hello precedes the first channel call.
		ipcRenderer.send('ash:hello');
	}

	public getChannel<T extends IChannel>(name: string): T {
		return this.peer.getChannel<T>(name);
	}

	public registerChannel(name: string, channel: IServerChannel<string>): void {
		this.peer.registerChannel(name, channel);
	}
}
