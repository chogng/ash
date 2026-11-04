import { session, WebContentsView, type Session } from 'electron/main';
import { randomUUID } from 'node:crypto';
import { TaskQueue } from '../../../../base/common/async.js';
import { Disposable, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';

export interface IChatGPTVerificationRuntime extends IDisposable {
	readonly isDisposed: boolean;
	readonly session: Pick<Session, 'fetch'>;
	readonly verificationPhase?: 'navigation' | 'install' | 'proof';
	readonly verificationRequests?: readonly VerificationRequest[];
	prepareHeaders(script: string, signal: AbortSignal): Promise<unknown>;
}

interface VerificationRequest {
	readonly route: string;
	readonly outcome: number | 'pending' | 'authorization' | 'network';
}

/** Hidden Chromium is used only for ChatGPT's request verification and cookies, never as a UI/state host. */
export class ChatGPTVerificationRuntime extends Disposable implements IChatGPTVerificationRuntime {
	readonly session = session.fromPartition(`chatgpt-verification:${randomUUID()}`);
	private readonly sequencer = new TaskQueue();
	private view: WebContentsView | undefined;
	private ready: Promise<void> | undefined;
	private phase: IChatGPTVerificationRuntime['verificationPhase'];
	private readonly requests = new Map<number, VerificationRequest>();
	get verificationPhase(): IChatGPTVerificationRuntime['verificationPhase'] { return this.phase; }
	get verificationRequests(): readonly VerificationRequest[] { return [...this.requests.values()]; }

	constructor(authorize: (url: URL) => Promise<Headers>) {
		super();
		this.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
		this.session.setPermissionCheckHandler(() => false);
		const verification = { urls: ['https://chatgpt.com/backend-api/sentinel/*', 'https://chatgpt.com/backend-anon/sentinel/*', 'https://chatgpt.com/unauth-mweb/sentinel/*'] };
		this.session.webRequest.onCompleted(verification, details => this.finishRequest(details.id, details.statusCode));
		this.session.webRequest.onErrorOccurred(verification, details => this.finishRequest(details.id, 'network'));
		this.session.webRequest.onBeforeSendHeaders((details, callback) => {
			const url = new URL(details.url);
			if (this.phase && this.requests.size < 12 && url.origin === 'https://chatgpt.com') {
				const route = /^\/(backend-api|backend-anon|unauth-mweb)\/sentinel\/(chat-requirements(?:\/prepare|\/finalize)?)$/u.exec(url.pathname);
				if (route) this.requests.set(details.id, { route: `${route[1]}/${route[2]}`, outcome: 'pending' });
			}
			void authorize(url).then(headers => {
				if (this.isDisposed) { callback({ cancel: true }); return; }
				const requestHeaders = { ...details.requestHeaders };
				for (const [name, value] of headers) {
					for (const key of Object.keys(requestHeaders)) { if (key.toLowerCase() === name.toLowerCase()) { delete requestHeaders[key]; } }
					if (value) { requestHeaders[name] = value; }
				}
				callback({ requestHeaders });
			}, () => {
				this.finishRequest(details.id, 'authorization');
				callback({ cancel: true });
			});
		});
		this._register(toDisposable(() => {
			this.sequencer.clearPending();
			this.session.webRequest.onBeforeSendHeaders(null);
			this.session.webRequest.onCompleted(null);
			this.session.webRequest.onErrorOccurred(null);
			if (this.view && !this.view.webContents.isDestroyed()) { this.view.webContents.close(); }
			void this.session.clearStorageData().catch(() => { });
			void this.session.clearCache().catch(() => { });
		}));
	}

	private finishRequest(id: number, outcome: VerificationRequest['outcome']): void {
		const request = this.requests.get(id);
		if (request?.outcome === 'pending') this.requests.set(id, { route: request.route, outcome });
	}

	prepareHeaders(script: string, signal: AbortSignal): Promise<unknown> {
		return this.sequencer.schedule(async () => {
			signal.throwIfAborted();
			if (this.isDisposed) { throw new Error('ChatGPT verification is closed'); }
			// Closing the active page stops pending browser work on cancellation or timeout.
			const close = () => this.dispose();
			signal.addEventListener('abort', close, { once: true });
			using removeAbortListener = toDisposable(() => signal.removeEventListener('abort', close));
			this.requests.clear();
			this.ready ??= this.initialize(script);
			await this.ready;
			signal.throwIfAborted();
			this.phase = 'proof';
			const value: unknown = await this.view!.webContents.executeJavaScript('globalThis.__ashPrepareChatGPTHeaders()');
			signal.throwIfAborted();
			this.phase = undefined;
			return value;
		});
	}

	private async initialize(script: string): Promise<void> {
		this.phase = 'navigation';
		this.view = new WebContentsView({ webPreferences: { session: this.session, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
		this.view.setBounds({ x: 0, y: 0, width: 800, height: 600 });
		const contents = this.view.webContents;
		contents.setWindowOpenHandler(() => ({ action: 'deny' }));
		const navigation = (event: Electron.Event, target: string): void => { if (target !== 'https://chatgpt.com/') { event.preventDefault(); } };
		contents.on('will-navigate', navigation);
		contents.on('will-redirect', navigation);
		this._register(toDisposable(() => { contents.removeListener('will-navigate', navigation); contents.removeListener('will-redirect', navigation); }));
		await contents.loadURL('https://chatgpt.com/');
		if (this.isDisposed) { throw new Error('ChatGPT verification is closed'); }
		this.phase = 'install';
		await contents.executeJavaScript(script);
	}
}
