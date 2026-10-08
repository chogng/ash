import type { BrowserWindow, WebContentsView, WebContents, Event as ElectronEvent } from 'electron/main';
import { addAbortListener, type EventEmitter } from 'node:events';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import type { IDisposable } from '../../../base/common/lifecycle.js';
import { promiseWithResolvers, raceCancellationError } from '../../../base/common/async.js';
import { type BrowserViewEvent, type IBrowserViewBounds, type IBrowserViewState, type IBrowserViewInfo, type IBrowserViewCreateOptions, normalizeBrowserViewUrl } from '../common/browserView.js';
import type { BrowserSession } from './browserSession.js';
import { BrowserViewDebugger } from './browserViewDebugger.js';

export interface BrowserViewOptions {
	readonly id: string;
	readonly window: BrowserWindow;
	readonly view: WebContentsView;
	readonly initialUrl: string;
	readonly network?: IDisposable;
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
	private operationTurn: Promise<void> = Promise.resolve();
	private url: string;
	private errorDescription: string | undefined;
	private laidOut = false;
	private visible = false;
	private readonly emitEvent: (event: BrowserViewEvent) => void;
	private networkToken: string | null = null;

	constructor(options: BrowserViewOptions) {
		super();
		this.id = options.id;
		this.view = options.view;
		this.session = options.session;
		this.creation = options.creation;
		this.window = options.window;
		this.url = options.initialUrl;
		if (options.network) { this._register(options.network); }
		if (options.network || this.creation.owner.type === 'agent') {
			// SOCKS carries TCP traffic; WebRTC must not open direct UDP sockets outside that policy.
			this.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
		}
		this.emitEvent = options.emitEvent;
	}

	/** Called only after the manager has taken ownership, so synchronous page events can find this view. */
	initialize(): void {
		this.view.setBounds({ x: 0, y: 0, width: 1024, height: 768 });
		this.view.setVisible(false);
		this.window.contentView.addChildView(this.view);
		this.configureSecurity();
		this._register(this.session.permissions.attach(this.id, this.webContents, event => this.emit(event)));
		this._register(this.session.attachNetwork(this.id, this.webContents, this.creation.owner, () => this.networkToken, event => this.emit(event)));
		this.listen();
		this.emit({ type: 'created', info: this.getInfo() });
		void this.view.webContents.loadURL(this.url).catch(() => {
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
	public async setNetworkAuthority(token: string | null): Promise<void> {
		if (this.creation.owner.type !== 'agent') { throw new Error('BrowserNetworkIsolationRequired'); }
		if (this.networkToken === token) { return; }
		this.networkToken = token;
		this.session.cancelNetworkRequests(this.webContents.id);
		// Retiring authority also fails in-flight HTTP requests and clears pooled connections.
		await this.session.electronSession.closeAllConnections();
	}
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
	loadURL(url: string, signal: AbortSignal = this.signal, networkToken?: string | null): Promise<void> { return this.runOperation(signal, s => this.navigate(normalizeBrowserViewUrl(url), s), networkToken); }
	goBack(): Promise<void> { return this.runOperation(this.signal, async () => { const h = this.webContents.navigationHistory; if (h.canGoBack()) { this.errorDescription = undefined; h.goBack(); } }); }
	goForward(): Promise<void> { return this.runOperation(this.signal, async () => { const h = this.webContents.navigationHistory; if (h.canGoForward()) { this.errorDescription = undefined; h.goForward(); } }); }
	reload(): Promise<void> { return this.runOperation(this.signal, async () => { this.errorDescription = undefined; this.webContents.reload(); }); }
	stop(): void { this.webContents.stop(); }
	focus(): void { if (this.visible) this.webContents.focus(); }

	public runOperation<R>(requestSignal: AbortSignal, execute: (signal: AbortSignal) => Promise<R>, networkToken?: string | null): Promise<R> {
		const signal = AbortSignal.any([requestSignal, this.signal]);
		const operation = this.operationTurn.then(() => {
			throwIfAborted(signal);
			if (networkToken === undefined) { return execute(signal); }
			return this.session.runNetworkOperation(async () => {
				throwIfAborted(signal);
				await this.setNetworkAuthority(networkToken);
				using cancellation = addAbortListener(signal, () => { void this.setNetworkAuthority(null).catch(() => { }); });
				try { throwIfAborted(signal); return await execute(signal); }
				finally {
					await this.debuggerOwner?.whenIdle();
					if (!this.isDisposed) { await this.setNetworkAuthority(null); }
				}
			});
		});
		// Cancellation releases the caller, while Chromium retains its turn until the command finishes.
		// A worker can disconnect before a previously issued Chromium command has completed.
		// Keep the page's next turn behind that command even though the caller already received its error.
		this.operationTurn = operation.then(() => this.debuggerOwner?.whenIdle(), () => this.debuggerOwner?.whenIdle());
		return raceCancellationError(operation, signal, 'BrowserRequestCancelled');
	}
	private configureSecurity(): void {
		const contents = this.view.webContents;

		contents.setWindowOpenHandler(({ url }) => {
			// Agent popups must not create an unrestricted user page outside their request authority.
			if (this.creation.owner.type === 'agent') { return { action: 'deny' }; }
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
			} else if (input.type === 'keyDown' && (input.control || input.meta) && input.shift && !input.alt && input.key.toLowerCase() === 'p') {
				// The webpage has a separate WebContents; Workbench owns shortcut resolution and command execution.
				event.preventDefault();
				this.window.webContents.focus();
				const modifiers: Electron.KeyboardInputEvent['modifiers'] = [];
				if (input.control) { modifiers.push('control'); }
				if (input.meta) { modifiers.push('meta'); }
				modifiers.push('shift');
				this.window.webContents.sendInputEvent({ type: 'keyDown', keyCode: input.key, modifiers });
			}
		});
		this.on(contents, "did-start-loading", () => this.emitState());
		this.on(contents, "did-stop-loading", () =>
			this.emitState());
		this.on(contents, "did-navigate", (
			_event: ElectronEvent,
			url: string,
		) => {
			this.url = normalizeBrowserViewUrl(url);
			this.emitState();
		});
		this.on(contents, "did-navigate-in-page", (
			_event: ElectronEvent,
			url: string,
			isMainFrame: boolean,
		) => {
			if (!isMainFrame) return;
			this.url = normalizeBrowserViewUrl(url);
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
				this.errorDescription = errorDescription;
				this.emit({
					type: "loadFailed",
					targetId: this.id,
					url: validatedURL,
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
		try { normalizeBrowserViewUrl(url); this.errorDescription = undefined; }
		catch { event.preventDefault(); }
	}

	private async navigate(requestedUrl: string, signal: AbortSignal): Promise<void> {
		signal.throwIfAborted();
		this.errorDescription = undefined;
		// Stop the visible load before replacing it. Chromium does not settle every stopped
		// initial loadURL promise, so page loading events define completion and cancellation.
		if (this.webContents.isLoading()) this.webContents.stop();
		await this.waitForLoad(signal);
		signal.throwIfAborted();
		// Only an in-flight load may stop Chromium; cancelling a queued operation must leave the current load alone.
		using cancellation = addAbortListener(signal, () => {
			if (!this.webContents.isDestroyed()) this.webContents.stop();
		});
		await this.webContents.loadURL(requestedUrl);
		await this.waitForLoad(signal);
		signal.throwIfAborted();
		this.url = this.webContents.getURL() || requestedUrl;
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
			url: contents.getURL() || this.url,
			title: contents.getTitle(),
			loading: contents.isLoading(),
			canGoBack: history.canGoBack(),
			canGoForward: history.canGoForward(),
			visible: this.visible,
			errorDescription: this.errorDescription,
		};
	}


	private emitState(): void {
		if (!this.signal.aborted) this.emit({ type: 'stateChanged', state: this.getState() });
	}
	private emit(event: BrowserViewEvent): void { this.emitEvent(event); }
	protected override disposeCore(): void {
		this.cancellation.abort(new Error('BrowserTargetUnavailable'));
		super.disposeCore();
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
