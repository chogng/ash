import { session, WebContentsView, type Session } from 'electron/main';
import { randomUUID } from 'node:crypto';
import { DeferredPromise, raceCancellationError, TaskQueue } from '../../../../base/common/async.js';
import { Disposable, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';

export type ChatGPTRequestHeaderHandler = (url: URL, method: string, headers: Readonly<Record<string, string>>) => Promise<Record<string, string>>;

export interface IChatGPTVerificationRuntime extends IDisposable {
	readonly isDisposed: boolean;
	readonly session: Pick<Session, 'fetch' | 'getUserAgent'>;
	readonly verificationPhase?: 'navigation' | 'install' | 'proof';
	readonly verificationRequests?: readonly VerificationRequest[];
	warmup(readScript: (signal: AbortSignal) => Promise<string>): Promise<void>;
	prepareHeaders(script: string, signal: AbortSignal, sidebar?: boolean): Promise<unknown>;
}

interface VerificationRequest {
	readonly route: string;
	readonly outcome: number | 'pending' | 'authorization' | 'network';
}

/** Hidden Chromium is used only for ChatGPT's request verification and cookies, never as a UI/state host. */
export class ChatGPTVerificationRuntime extends Disposable implements IChatGPTVerificationRuntime {
	readonly session = session.fromPartition(`chatgpt-verification:${randomUUID()}`);
	private readonly sequencer = new TaskQueue();
	private readonly lifetime = new AbortController();
	private view: WebContentsView | undefined;
	private ready: Promise<void> | undefined;
	private prewarmed = false;
	private warmupFinished: DeferredPromise<void> | undefined;
	private phase: IChatGPTVerificationRuntime['verificationPhase'];
	private readonly requests = new Map<number, VerificationRequest>();
	get verificationPhase(): IChatGPTVerificationRuntime['verificationPhase'] { return this.phase; }
	get verificationRequests(): readonly VerificationRequest[] { return [...this.requests.values()]; }

	constructor(prepareRequestHeaders: ChatGPTRequestHeaderHandler) {
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
			void prepareRequestHeaders(url, details.method, details.requestHeaders).then(requestHeaders => {
				if (this.isDisposed) { callback({ cancel: true }); return; }
				callback({ requestHeaders });
			}, () => {
				this.finishRequest(details.id, 'authorization');
				callback({ cancel: true });
			});
		});
		this._register(toDisposable(() => {
			this.lifetime.abort();
			this.sequencer.clearPending();
			this.session.webRequest.onBeforeSendHeaders(null);
			this.session.webRequest.onCompleted(null);
			this.session.webRequest.onErrorOccurred(null);
			this.closePage();
			void this.session.clearStorageData().catch(() => { });
			void this.session.clearCache().catch(() => { });
		}));
	}

	warmup(readScript: (signal: AbortSignal) => Promise<string>): Promise<void> {
		return this.sequencer.schedule(async () => {
			if (this.isDisposed) return;
			const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(35_000)]);
			const close = () => this.closePage();
			signal.addEventListener('abort', close, { once: true });
			using removeAbortListener = toDisposable(() => signal.removeEventListener('abort', close));
			try {
				const script = await raceCancellationError(readScript(signal), signal);
				signal.throwIfAborted();
				this.ready ??= this.initialize(script);
				await raceCancellationError(this.ready, signal);
				const contents = this.view!.webContents;
				await contents.debugger.sendCommand('Page.setWebLifecycleState', { state: 'active' });
				contents.setBackgroundThrottling(false);
				this.phase = 'proof';
				this.requests.clear();
				// The SDK's priming call returns before its final HTTP request completes.
				// Freezing earlier suspends that work and puts it back on the Send path.
				const finished = this.warmupFinished = new DeferredPromise<void>();
				const hadPrewarmed = this.prewarmed;
				await raceCancellationError(Promise.all([
					this.evaluate('globalThis.__ashWarmChatGPTVerification()').then(value => {
						// The SDK checks its own expiry and context. Reusing a settled entry
						// produces no second finalization event, so there is nothing to wait for.
						if (hadPrewarmed && value && typeof value === 'object' && 'requestsStarted' in value && value.requestsStarted === false && !finished.isSettled) {
							void finished.complete();
						}
					}), finished.p,
				]), signal);
				signal.throwIfAborted();
				this.prewarmed = true;
				await this.suspendPage();
			} catch {
				// Prewarming is optional. A foreground send can retry from a fresh page.
				this.closePage();
			} finally { this.warmupFinished = undefined; this.phase = undefined; }
		});
	}

	private finishRequest(id: number, outcome: VerificationRequest['outcome']): void {
		const request = this.requests.get(id);
		if (request?.outcome !== 'pending') return;
		this.requests.set(id, { route: request.route, outcome });
		if (this.warmupFinished && !this.warmupFinished.isSettled) {
			if (outcome !== 200) { void this.warmupFinished.error(new Error('ChatGPT verification warmup failed')); }
			else if (request.route.endsWith('/chat-requirements/finalize')) { void this.warmupFinished.complete(); }
		}
	}

	private closePage(): void {
		const view = this.view;
		this.view = undefined;
		this.ready = undefined;
		this.prewarmed = false;
		if (view && !view.webContents.isDestroyed()) { view.webContents.close(); }
	}

	private async suspendPage(): Promise<void> {
		const contents = this.view?.webContents;
		if (!contents || contents.isDestroyed()) return;
		try {
			contents.setBackgroundThrottling(true);
			await contents.debugger.sendCommand('Page.setWebLifecycleState', { state: 'frozen' });
		} catch {
			// If Chromium cannot suspend, release the internal page without discarding
			// the valid proof or Session transport. The next request can recreate it.
			this.closePage();
		}
	}

	prepareHeaders(script: string, signal: AbortSignal, sidebar = false): Promise<unknown> {
		return this.sequencer.schedule(async () => {
			signal.throwIfAborted();
			if (this.isDisposed) { throw new Error('ChatGPT verification is closed'); }
			// Closing the active page stops pending browser work on cancellation or timeout.
			const close = () => this.dispose();
			signal.addEventListener('abort', close, { once: true });
			using removeAbortListener = toDisposable(() => signal.removeEventListener('abort', close));
			this.requests.clear();
			try {
				this.ready ??= this.initialize(script);
				await this.ready;
				signal.throwIfAborted();
				const contents = this.view!.webContents;
				await contents.debugger.sendCommand('Page.setWebLifecycleState', { state: 'active' });
				contents.setBackgroundThrottling(false);
				signal.throwIfAborted();
				this.phase = 'proof';
				this.prewarmed = false;
				const value = await this.evaluate(`globalThis.__ashPrepareChatGPTHeaders(${sidebar})`);
				signal.throwIfAborted();
				// This internal page has no user-owned background work. Preserve its
				// installed verification state while stopping timers and animation frames.
				await this.suspendPage();
				signal.throwIfAborted();
				// Refill after handing off this one-use result. It runs alongside the reply,
				// never holds up its submission, and freezes again when verification settles.
				if (this.view) { void this.warmup(async () => script).catch(() => { }); }
				return value;
			} catch (error) {
				this.closePage();
				throw error;
			} finally {
				this.phase = undefined;
			}
		});
	}

	private async evaluate(expression: string): Promise<unknown> {
		// executeJavaScript waits for page loading to stop, including unrelated website
		// resources. Verification only needs the document and its own module to be ready.
		const response = await this.view!.webContents.debugger.sendCommand('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
		if (response.exceptionDetails) { throw new Error('ChatGPT verification script failed'); }
		return response.result.value;
	}

	private async initialize(script: string): Promise<void> {
		this.phase = 'navigation';
		this.view = new WebContentsView({ webPreferences: { session: this.session, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
		this.view.setVisible(false);
		this.view.setBounds({ x: 0, y: 0, width: 800, height: 600 });
		const contents = this.view.webContents;
		contents.debugger.attach('1.3');
		contents.setWindowOpenHandler(() => ({ action: 'deny' }));
		const navigation = (event: Electron.Event, target: string): void => { if (target !== 'https://chatgpt.com/') { event.preventDefault(); } };
		contents.on('will-navigate', navigation);
		contents.on('will-redirect', navigation);
		let committed!: () => void;
		using removeCommitListener = toDisposable(() => contents.removeListener('did-navigate', committed));
		await new Promise<void>((resolve, reject) => {
			committed = () => resolve();
			contents.once('did-navigate', committed);
			void contents.loadURL('https://chatgpt.com/').catch(reject);
		});
		if (this.isDisposed) { throw new Error('ChatGPT verification is closed'); }
		this.phase = 'install';
		await this.evaluate(script);
	}
}
