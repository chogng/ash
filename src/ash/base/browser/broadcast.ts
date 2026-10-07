import { addDisposableListener } from './dom.js';
import { Emitter } from '../common/event.js';
import { Disposable, toDisposable } from '../common/lifecycle.js';

/** Cross-window notifications with storage events for browsers without BroadcastChannel. */
export class BroadcastDataChannel<T> extends Disposable {
	private readonly received = this._register(new Emitter<T>());
	public readonly onDidReceiveData = this.received.event;
	private readonly channel: BroadcastChannel | undefined;
	private readonly storageKey: string;

	constructor(channelName: string, private readonly ownerWindow: Window = window) {
		super();
		this.storageKey = `ash.broadcast.${channelName}`;
		try {
			const Channel = (ownerWindow as Window & typeof globalThis).BroadcastChannel;
			this.channel = new Channel(channelName);
		} catch {
			this.channel = undefined;
		}
		if (this.channel) {
			const channel = this.channel;
			this._register(toDisposable(() => channel.close()));
			this._register(addDisposableListener(channel, 'message', event => this.received.fire((event as MessageEvent<T>).data)));
		} else {
			this._register(addDisposableListener(ownerWindow, 'storage', event => {
				const changed = event as StorageEvent;
				if (changed.key !== this.storageKey || changed.newValue === null || changed.storageArea !== ownerWindow.localStorage) {
					return;
				}
				try { this.received.fire((JSON.parse(changed.newValue) as { data: T; }).data); } catch { /* Ignore data from older or unrelated clients. */ }
			}));
		}
	}

	public postData(data: T): void {
		this.assertNotDisposed();
		if (this.channel) {
			this.channel.postMessage(data);
			return;
		}
		// A fresh envelope delivers consecutive equal values without retaining a message history.
		try { this.ownerWindow.localStorage.setItem(this.storageKey, JSON.stringify({ id: crypto.randomUUID(), data })); }
		catch { /* A denied storage area cannot undo the caller's already committed operation. */ }
	}
}
