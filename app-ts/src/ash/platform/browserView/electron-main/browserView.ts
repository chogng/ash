import type { BrowserWindow, WebContentsView, WebContents, Event as ElectronEvent } from 'electron/main';
import { addAbortListener, type EventEmitter } from 'node:events';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import { promiseWithResolvers, raceCancellationError } from '../../../base/common/async.js';
import { type BrowserViewEvent, type IBrowserViewBounds, type IBrowserViewState, type IBrowserViewInfo, type IBrowserViewCreateOptions, normalizeBrowserViewUrl } from '../common/browserView.js';
import { type BrowserViewNavigation, IBrowserViewNavigationResolver } from '../common/browserViewNavigation.js';
import type { BrowserSession } from './browserSession.js';
import { BrowserViewDebugger } from './browserViewDebugger.js';

export interface BrowserViewOptions {
	readonly id: string;
	readonly window: BrowserWindow;
	readonly view: WebContentsView;
	readonly navigation: BrowserViewNavigation;
	readonly creation: IBrowserViewCreateOptions;
	readonly session: BrowserSession;
	readonly emitEvent: (event: BrowserViewEvent) => void;
}

/** Owns one page, its navigation resources and the ordered Chromium operations using it. */
export class BrowserView extends Disposable {
	readonly id: string;
	readonly view: WebContentsView;
	public readonly session: BrowserSession;
	private readonly creation: IBrowserViewCreateOptions;
	private readonly window: BrowserWindow;
	private readonly cancellation = new AbortController();
	readonly signal = this.cancellation.signal;
	private readonly navigations: Set<BrowserViewNavigation>;
	private navigation: BrowserViewNavigation;
	private pendingNavigation?: BrowserViewNavigation;
	private operationTurn: Promise<void> = Promise.resolve();
	private url: string;
	private laidOut = false;
	private visible = false;
	private readonly emitEvent: (event: BrowserViewEvent) => void;

	constructor(options: BrowserViewOptions, @IBrowserViewNavigationResolver private readonly navigationResolver: IBrowserViewNavigationResolver) {
		super();
		this.id = options.id;
		this.view = options.view;
		this.session = options.session;
		this.creation = options.creation;
		this.window = options.window;
		this.navigation = options.navigation;
		this.navigations = new Set([options.navigation]);
		this.url = options.navigation.requestedUrl;
		this.emitEvent = options.emitEvent;
	}

	/** Called only after the manager has taken ownership, so synchronous page events can find this view. */
	initialize(): void {
		this.view.setBounds({ x: 0, y: 0, width: 1024, height: 768 });
		this.view.setVisible(false);
		this.window.contentView.addChildView(this.view);
		this.configureSecurity();
		this.listen();
		this.emit({ type: 'created', info: this.getInfo() });
		void this.view.webContents.loadURL(this.navigation.loadUrl).catch(() => {
			// did-fail-load carries the failure to the editor and the host caller.
		});
	}
	get webContents(): WebContents { return this.view.webContents; }
	private debuggerOwner: BrowserViewDebugger | undefined;
	get debugger(): BrowserViewDebugger {
		this.assertNotDisposed();
		return this.debuggerOwner ??= this._register(new BrowserViewDebugger(this.webContents));
	}
	public waitForLoad(signal: AbortSignal): Promise<void> { return waitForLoad(this, signal); }
	layout(bounds: IBrowserViewBounds): void {
		const scale = this.window.webContents.getZoomFactor();
		this.view.setBounds({ x: Math.round(bounds.x * scale), y: Math.round(bounds.y * scale), width: Math.round(bounds.width * scale), height: Math.round(bounds.height * scale) });
		this.laidOut = true;
	}
	setVisible(visible: boolean): void {
		if (visible && !this.laidOut) throw new Error('BrowserTargetNotLaidOut');
		if (visible === this.visible) return;
		this.visible = visible; this.view.setVisible(visible); this.emitState();
	}
	loadURL(url: string, signal: AbortSignal = this.signal): Promise<void> { return this.runOperation(signal, s => this.navigate(normalizeBrowserViewUrl(url), s)); }
	goBack(): Promise<void> { return this.runOperation(this.signal, async () => { const h = this.webContents.navigationHistory; if (h.canGoBack()) h.goBack(); }); }
	goForward(): Promise<void> { return this.runOperation(this.signal, async () => { const h = this.webContents.navigationHistory; if (h.canGoForward()) h.goForward(); }); }
	reload(): Promise<void> { return this.runOperation(this.signal, async () => this.webContents.reload()); }
	stop(): void { this.webContents.stop(); }
	focus(): void { if (this.visible) this.webContents.focus(); }

	public runOperation<R>(requestSignal: AbortSignal, execute: (signal: AbortSignal) => Promise<R>): Promise<R> {
		const signal = AbortSignal.any([requestSignal, this.signal]);
		const operation = this.operationTurn.then(() => { throwIfAborted(signal); return execute(signal); });
		// Cancellation releases the caller, while Chromium retains its turn until the command finishes.
		// A worker can disconnect before a previously issued Chromium command has completed.
		// Keep the page's next turn behind that command even though the caller already received its error.
		this.operationTurn = operation.then(() => this.debuggerOwner?.whenIdle(), () => this.debuggerOwner?.whenIdle());
		return raceCancellationError(operation, signal, 'BrowserRequestCancelled');
	}
	private configureSecurity(): void {
		const contents = this.view.webContents;

		contents.setWindowOpenHandler(({ url }) => {
			try {
				this.emit({
					type: "openRequested",
					targetId: this.id,
					url: normalizeBrowserViewUrl(url),
				});
			} catch {
				// Invalid and privileged URLs are denied without entering renderer IPC.
			}
			return { action: "deny" };
		});
	}

	private listen(): void {
		const contents = this.view.webContents;
		this.on(contents, "before-input-event", (event: ElectronEvent, input: Electron.Input) => {
			if (input.type === 'keyDown' && (input.key === 'F6' || ((input.control || input.meta) && input.key.toLowerCase() === 'l'))) {
				event.preventDefault();
				this.window.webContents.focus();
				this.emit({ type: 'focusAddress', targetId: this.id });
			}
		});
		this.on(contents, "did-start-loading", () =>
			this.emitState());
		this.on(contents, "did-stop-loading", () =>
			this.emitState());
		this.on(contents, "did-navigate", (
			_event: ElectronEvent,
			url: string,
		) => {
			const normalized = normalizeBrowserViewUrl(url);
			const navigation = this.navigationForLoadedUrl(normalized);
			if (navigation) this.navigation = navigation;
			this.url = navigation?.requestedUrlFor(normalized) ?? normalized;
			this.emitState();
		});
		this.on(contents, "did-navigate-in-page", (
			_event: ElectronEvent,
			url: string,
			isMainFrame: boolean,
		) => {
			if (!isMainFrame) return;
			this.url = this.requestedUrlFor(url);
			this.emitState();
		});
		this.on(contents, "page-title-updated", () =>
			this.emitState());
		this.on(
			contents,
			"did-fail-load",
			(
				_event: ElectronEvent,
				errorCode: number,
				errorDescription: string,
				validatedURL: string,
				isMainFrame: boolean,
			) => {
				if (!isMainFrame) return;
				this.emit({
					type: "loadFailed",
					targetId: this.id,
					url: this.requestedUrlFor(validatedURL),
					errorCode,
					errorDescription,
				});
				this.emitState();
			},
		);
		this.on(contents, "render-process-gone", (
			_event: ElectronEvent,
			details: Electron.RenderProcessGoneDetails,
		) => {
			this.emit({
				type: "renderProcessGone",
				targetId: this.id,
				reason: details.reason,
			});
		});
		this.on(contents, "will-navigate", (
			event: ElectronEvent,
			url: string,
		) =>
			this.validateNavigation(event, url));
		this.on(contents, "will-redirect", (
			event: ElectronEvent,
			url: string,
		) =>
			this.validateNavigation(event, url));
		this.on(contents, "will-attach-webview", (
			event: ElectronEvent,
		) =>
			event.preventDefault());
		this.on(contents, "destroyed", () =>
			this.dispose());
	}

	private validateNavigation(event: ElectronEvent, url: string): void {
		let normalized: string;
		try {
			normalized = normalizeBrowserViewUrl(url);
		} catch {
			event.preventDefault();
			return;
		}
		if (this.navigationForLoadedUrl(normalized)) return;
		event.preventDefault();
		const requestedUrl = this.requestedUrlFor(normalized);
		void this.loadURL(requestedUrl).catch(error => {
			if (this.signal.aborted) return;
			this.emit({
				type: "loadFailed",
				targetId: this.id,
				url: requestedUrl,
				errorCode: -2,
				errorDescription: error instanceof Error ? error.message : "Browser navigation resolution failed",
			});
			this.emitState();
		});
	}

	private async navigate(requestedUrl: string, signal: AbortSignal): Promise<void> {
		signal.throwIfAborted();
		let navigation = this.reusableNavigationForRequestedUrl(requestedUrl);
		const created = navigation === undefined;
		if (!navigation) navigation = await this.navigationResolver.resolve(requestedUrl, signal);
		if (signal.aborted) {
			if (created) navigation.release();
			signal.throwIfAborted();
		}
		if (created) this.navigations.add(navigation);
		this.pendingNavigation = navigation;
		try {
			// Stop only this in-flight load; queued cancellation must not stop another navigation.
			using cancellation = addAbortListener(signal, () => {
				if (!this.view.webContents.isDestroyed()) this.view.webContents.stop();
			});
			await this.view.webContents.loadURL(navigation.loadUrlFor(requestedUrl));
			signal.throwIfAborted();
			this.navigation = navigation;
			const loadedUrl = this.view.webContents.getURL() || navigation.loadUrlFor(requestedUrl);
			this.url = navigation.requestedUrlFor(loadedUrl);
		} catch (error) {
			if (created && !this.signal.aborted && this.navigations.delete(navigation)) navigation.release();
			throw error;
		} finally {
			if (this.pendingNavigation === navigation) this.pendingNavigation = undefined;
		}
	}

	private reusableNavigationForRequestedUrl(url: string): BrowserViewNavigation | undefined {
		if (this.navigation.isReusable() && this.navigation.ownsRequestedUrl(url)) return this.navigation;
		return [...this.navigations].find(navigation => navigation.isReusable() && navigation.ownsRequestedUrl(url));
	}

	private navigationForLoadedUrl(url: string): BrowserViewNavigation | undefined {
		if (this.pendingNavigation?.ownsLoadedUrl(url)) return this.pendingNavigation;
		if (this.navigation.ownsLoadedUrl(url)) return this.navigation;
		return [...this.navigations].find(navigation => navigation.ownsLoadedUrl(url));
	}

	private requestedUrlFor(loadedUrl: string): string {
		let normalized: string;
		try {
			normalized = normalizeBrowserViewUrl(loadedUrl);
		} catch {
			return loadedUrl;
		}
		return this.navigationForLoadedUrl(normalized)?.requestedUrlFor(normalized) ?? normalized;
	}

	private on(
		contents: WebContents,
		event: string,
		listener: (...args: any[]) => void,
	): void {
		const emitter = contents as unknown as EventEmitter;
		emitter.on(event, listener);
		this._register(toDisposable(() => emitter.removeListener(event, listener)));
	}

	public getInfo(): IBrowserViewInfo {
		return { id: this.id, host: { windowId: this.window.id }, owner: this.creation.owner, session: this.creation.session, state: this.getState() };
	}

	getState(): IBrowserViewState {
		const contents = this.view.webContents;
		if (contents.isDestroyed()) {
			throw new Error("BrowserTargetUnavailable");
		}
		const history = contents.navigationHistory;
		return {
			targetId: this.id,
			url: contents.getURL() ? this.requestedUrlFor(contents.getURL()) : this.url,
			title: contents.getTitle(),
			loading: contents.isLoading(),
			canGoBack: history.canGoBack(),
			canGoForward: history.canGoForward(),
			visible: this.visible,
		};
	}


	private emitState(): void {
		if (!this.signal.aborted) this.emit({ type: 'stateChanged', state: this.getState() });
	}
	private emit(event: BrowserViewEvent): void { this.emitEvent(event); }
	protected override disposeCore(): void {
		this.cancellation.abort(new Error('BrowserTargetUnavailable'));
		super.disposeCore();
		for (const navigation of this.navigations) navigation.release();
		this.navigations.clear();
		if (!this.window.isDestroyed()) this.window.contentView.removeChildView(this.view);
		if (!this.webContents.isDestroyed()) this.webContents.close();
		this.emit({ type: 'closed', targetId: this.id });
	}
}

async function waitForLoad(target: BrowserView, signal: AbortSignal): Promise<void> {
	throwIfAborted(signal);
	const contents = target.webContents;
	if (!contents.isLoading()) return;
	const loading = promiseWithResolvers<void>();
	const loaded = (): void => loading.resolve();
	contents.on('did-stop-loading', loaded);
	try {
		await raceCancellationError(loading.promise, signal, 'BrowserRequestCancelled');
	} finally {
		contents.removeListener('did-stop-loading', loaded);
	}
}

function throwIfAborted(signal: AbortSignal): void {
	if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("BrowserRequestCancelled");
}
