import { session, WebContentsView, type Session } from 'electron/main';
import { randomUUID } from 'node:crypto';
import { TaskQueue } from '../../../base/common/async.js';
import { Disposable, toDisposable, type IDisposable } from '../../../base/common/lifecycle.js';

export interface IBrowserPageRemoteRuntime extends IDisposable {
	readonly session: Session;
	prepareHeaders(script: string, signal: AbortSignal): Promise<unknown>;
}

/** A separate, sandboxed browser context for a product's remote request-header provider. */
export class BrowserPageRemoteRuntime extends Disposable implements IBrowserPageRemoteRuntime {
	readonly session = session.fromPartition(`browser-page-runtime:${randomUUID()}`);
	private readonly sequencer = new TaskQueue();
	private view: WebContentsView | undefined;
	private ready: Promise<void> | undefined;
	private disposed = false;

	constructor(private readonly url: string, authorize: (url: URL) => Promise<Headers | undefined>) {
		super();
		this.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
		this.session.setPermissionCheckHandler(() => false);
		this.session.webRequest.onBeforeSendHeaders((details, callback) => {
			void authorize(new URL(details.url)).then(headers => {
				if (this.disposed) { callback({ cancel: true }); return; }
				const requestHeaders = { ...details.requestHeaders };
				if (headers) {
					for (const [name, value] of headers) {
						for (const key of Object.keys(requestHeaders)) { if (key.toLowerCase() === name.toLowerCase()) { delete requestHeaders[key]; } }
						if (value) { requestHeaders[name] = value; }
					}
				}
				callback({ requestHeaders });
			}, () => callback({ cancel: true }));
		});
		this._register(toDisposable(() => {
			this.disposed = true;
			this.sequencer.clearPending();
			this.session.webRequest.onBeforeSendHeaders(null);
			if (this.view && !this.view.webContents.isDestroyed()) { this.view.webContents.close(); }
			this.view = undefined;
			// The partition is memory-only; release its browser storage when the owner retires.
			void this.session.clearStorageData().catch(() => { });
			void this.session.clearCache().catch(() => { });
		}));
	}

	prepareHeaders(script: string, signal: AbortSignal): Promise<unknown> {
		return this.sequencer.schedule(async () => {
			signal.throwIfAborted();
			if (this.disposed) { throw new Error('Browser request-header provider is closed'); }
			this.ready ??= this.initialize(script);
			await this.ready;
			signal.throwIfAborted();
			const value: unknown = await this.view!.webContents.executeJavaScript('globalThis.__ashPrepareBrowserPageHeaders()');
			signal.throwIfAborted();
			return value;
		});
	}

	private async initialize(script: string): Promise<void> {
		this.view = new WebContentsView({ webPreferences: { session: this.session, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
		this.view.setBounds({ x: 0, y: 0, width: 800, height: 600 });
		const contents = this.view.webContents;
		contents.setWindowOpenHandler(() => ({ action: 'deny' }));
		const navigation = (event: Electron.Event, target: string): void => { if (target !== this.url) { event.preventDefault(); } };
		contents.on('will-navigate', navigation);
		contents.on('will-redirect', navigation);
		this._register(toDisposable(() => { contents.removeListener('will-navigate', navigation); contents.removeListener('will-redirect', navigation); }));
		await contents.loadURL(this.url);
		if (this.disposed) { throw new Error('Browser request-header provider is closed'); }
		await contents.executeJavaScript(script);
	}
}
