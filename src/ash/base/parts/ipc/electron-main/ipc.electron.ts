import { ipcMain, type IpcMainEvent, type WebContents } from 'electron/main';
import { VSBuffer } from '../../../common/buffer.js';
import { Emitter } from '../../../common/event.js';
import { DisposableMap, DisposableStore, MutableDisposable, toDisposable, type IDisposable } from '../../../common/lifecycle.js';
import { IPCServer, type ClientConnectionEvent } from '../common/ipc.js';

interface RendererConnection {
	readonly sender: WebContents;
	readonly context: string;
	readonly allowedEntryUrls: ReadonlySet<string>;
	readonly document: MutableDisposable<IDisposable>;
	message: Emitter<VSBuffer> | undefined;
}

/** Electron messages carry channels; the host registers each permitted renderer's context. */
export class Server extends IPCServer {
	private readonly connected: Emitter<ClientConnectionEvent>;
	private readonly registrations = this._register(new DisposableMap<number, IDisposable>());
	private readonly renderers = new Map<number, RendererConnection>();

	constructor() {
		const connected = new Emitter<ClientConnectionEvent>();
		super(connected.event);
		this.connected = this._register(connected);
		const hello = (event: IpcMainEvent, ...args: unknown[]): void => {
			const renderer = this.renderer(event);
			if (renderer && args.length === 0) { this.connect(renderer); }
		};
		const message = (event: IpcMainEvent, value: unknown): void => {
			const renderer = this.renderer(event);
			if (!renderer) { return; }
			if (!(value instanceof Uint8Array)) { renderer.document.clear(); return; }
			renderer.message?.fire(VSBuffer.wrap(new Uint8Array(value)));
		};
		const disconnect = (event: IpcMainEvent): void => this.renderer(event)?.document.clear();
		ipcMain.on('ash:hello', hello);
		ipcMain.on('ash:message', message);
		ipcMain.on('ash:disconnect', disconnect);
		this._register(toDisposable(() => {
			ipcMain.removeListener('ash:hello', hello);
			ipcMain.removeListener('ash:message', message);
			ipcMain.removeListener('ash:disconnect', disconnect);
		}));
	}

	public registerClient(sender: WebContents, context: string, allowedEntryUrls: ReadonlySet<string>): IDisposable {
		this.assertNotDisposed();
		const resources = new DisposableStore();
		const document = resources.add(new MutableDisposable<IDisposable>());
		const renderer: RendererConnection = { sender, context, allowedEntryUrls, document, message: undefined };
		this.registrations.set(sender.id, resources);
		this.renderers.set(sender.id, renderer);
		const remove = (): void => {
			if (this.renderers.get(sender.id) === renderer) { this.registrations.deleteAndDispose(sender.id); }
		};
		const navigate = (_event: unknown, _url: string, inPlace: boolean, mainFrame: boolean): void => {
			if (mainFrame && !inPlace) { document.clear(); }
		};
		sender.on('did-start-navigation', navigate);
		sender.on('destroyed', remove);
		resources.add(toDisposable(() => {
			sender.off('did-start-navigation', navigate);
			sender.off('destroyed', remove);
			if (this.renderers.get(sender.id) === renderer) { this.renderers.delete(sender.id); }
		}));
		return toDisposable(remove);
	}

	private renderer(event: IpcMainEvent): RendererConnection | undefined {
		const renderer = this.renderers.get(event.sender.id);
		if (!renderer || renderer.sender !== event.sender || event.senderFrame !== renderer.sender.mainFrame) { return undefined; }
		if (!event.senderFrame || !renderer.allowedEntryUrls.has(event.senderFrame.url)) { return undefined; }
		return renderer;
	}

	private connect(renderer: RendererConnection): void {
		renderer.document.clear();
		const resources = new DisposableStore();
		renderer.document.value = resources;
		const disconnected = new Emitter<void>();
		const messages = new Emitter<VSBuffer>();
		resources.add(disconnected);
		resources.add(messages);
		renderer.message = messages;
		resources.add(toDisposable(() => { renderer.message = undefined; }));
		this.connected.fire({
			protocol: {
				onMessage: messages.event,
				onDidClose: disconnected.event,
				send: buffer => renderer.sender.send('ash:message', buffer.buffer),
			},
			ctx: renderer.context,
			onDidClientDisconnect: disconnected.event,
		});
		// Stores release in reverse order: notify the peer before disposing its event sources.
		resources.add(toDisposable(() => disconnected.fire()));
	}
}
