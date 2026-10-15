import type { BrowserWindow, WebContentsView, WebContents, WebFrameMain, IpcMainEvent, ContextMenuParams, Event as ElectronEvent } from 'electron/main';
import { addAbortListener, type EventEmitter } from 'node:events';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import type { IDisposable } from '../../../base/common/lifecycle.js';
import { promiseWithResolvers, raceCancellationError } from '../../../base/common/async.js';
import { browserViewIsolatedWorldId, type BrowserViewEvent, type IBrowserViewBounds, type IBrowserViewState, type IBrowserViewInfo, type IBrowserViewCreateOptions, normalizeBrowserViewUrl } from '../common/browserView.js';
import { browserPageScheme } from '../common/browserPage.js';
import type { BrowserSession } from './browserSession.js';
import { BrowserViewDebugger } from './browserViewDebugger.js';
import type { IBrowserHistoryItemHandle } from '../common/browserHistory.js';
import type { IBrowserSessionHistory } from './browserSessionHistory.js';
import type { IBrowserViewWindowConfiguration, IBrowserViewKeyDownEvent, IBrowserElementSelectionOptions, IBrowserElementCommentsUpdate, IBrowserViewRect, IBrowserViewFindInPageOptions, IBrowserViewCaptureScreenshotOptions } from '../common/browserView.js';
import { VSBuffer } from '../../../base/common/buffer.js';
import { isRecord } from '../../../base/common/types.js';
import { browserZoomFactors, browserZoomDefaultIndex, type IBrowserDeviceProfile } from '../common/browserView.js';
import { randomUUID } from 'node:crypto';

export interface BrowserViewOptions {
	readonly remoteAuthority?: string;
	readonly id: string;
	readonly window: BrowserWindow;
	readonly view: WebContentsView;
	readonly initialUrl: string;
	readonly network?: IDisposable;
	readonly creation: IBrowserViewCreateOptions;
	readonly session: BrowserSession;
	readonly history: IBrowserSessionHistory;
	readonly emitEvent: (event: BrowserViewEvent) => void;
	readonly openContextMenu: (view: BrowserView, params: ContextMenuParams) => void;
}

/** Owns one page, its navigation resources and the ordered Chromium operations using it. */
export class BrowserView extends Disposable {
	private readonly fileRequests = new Map<string, (data: string | null) => void>();
	public respondToFileRequest(requestId: string, data: string | null): void { this.fileRequests.get(requestId)?.(data); }
	private readFile(url: string): Promise<Uint8Array> {
		this.assertNotDisposed();
		if (this.fileRequests.size >= 64) { return Promise.reject(new Error('Browser file request limit exceeded')); }
		const requestId = randomUUID();
		return new Promise((resolve, reject) => {
			const finish = (data: string | null): void => {
				if (!this.fileRequests.delete(requestId)) { return; }
				clearTimeout(timer);
				if (data === null) { reject(new Error('BrowserLocalFileAccessDenied')); }
				else { resolve(Buffer.from(data, 'base64')); }
			};
			const timer = setTimeout(() => finish(null), 30000);
			this.fileRequests.set(requestId, finish);
			this.emit({ type: 'fileRequested', targetId: this.id, requestId, url });
		});
	}
	readonly id: string;
	readonly view: WebContentsView;
	public readonly session: BrowserSession;
	private readonly creation: IBrowserViewCreateOptions;
	private readonly remoteAuthority: string | undefined;
	private readonly window: BrowserWindow;
	private readonly cancellation = new AbortController();
	readonly signal = this.cancellation.signal;
	private operationTurn: Promise<void> = Promise.resolve();
	private url: string;
	private errorDescription: string | undefined;
	private laidOut = false;
	private visible = false;
	private readonly emitEvent: (event: BrowserViewEvent) => void;
	private readonly openContextMenu: BrowserViewOptions['openContextMenu'];
	private networkToken: string | null = null;
	private readonly history: IBrowserSessionHistory;
	private historyItem: IBrowserHistoryItemHandle | undefined;
	private explicitNavigation = true;
	private readonly preloadFrames = new Map<WebFrameMain, string>();
	private preloadConfiguration: IBrowserViewWindowConfiguration | undefined;
	private selectionMode: 'element' | 'area' | undefined;
	private deviceEmulation: IBrowserDeviceProfile | undefined;
	private originalUserAgent: string | undefined;
	private contentVisibilityRule: import('../common/browserView.js').IBrowserContentVisibilityRule | undefined;

	public setContentVisibility(rule: import('../common/browserView.js').IBrowserContentVisibilityRule | undefined): void {
		if (rule?.origin === this.contentVisibilityRule?.origin && rule?.selector === this.contentVisibilityRule?.selector) { return; }
		this.contentVisibilityRule = rule;
		// Only the top-level document receives the rule. The sandbox checks its own origin again.
		if (this.preloadFrames.has(this.webContents.mainFrame)) {
			this.sendPreload(this.webContents.mainFrame, 'contentVisibility', rule);
		}
	}

	public setBrowserZoomIndex(index: number): void {
		this.webContents.setZoomFactor(browserZoomFactors[index]!);
		this.emitState();
	}
	public toggleDevTools(): void {
		if (this.webContents.isDevToolsOpened()) { this.webContents.closeDevTools(); }
		else { this.webContents.openDevTools({ mode: 'detach' }); }
	}
	public setDeviceEmulation(device: IBrowserDeviceProfile | undefined): void {
		this.originalUserAgent ??= this.webContents.getUserAgent();
		if (device) {
			const size = { width: device.width ?? 800, height: device.height ?? 600 };
			this.webContents.enableDeviceEmulation({ screenPosition: device.mobile ? 'mobile' : 'desktop', screenSize: size, viewSize: size, viewPosition: { x: 0, y: 0 }, deviceScaleFactor: device.deviceScaleFactor ?? 1, scale: 1 });
			this.webContents.setUserAgent(device.userAgent ?? this.originalUserAgent);
		} else {
			this.webContents.disableDeviceEmulation();
			this.webContents.setUserAgent(this.originalUserAgent);
		}
		this.deviceEmulation = device;
		this.emitState();
	}
	private selectionOptions: IBrowserElementSelectionOptions = {};
	// Existing markers remain editable after the picker has stopped; only renderer-accepted IDs qualify.
	private readonly commentIds = new Set<string>();
	private readonly selectedTextRequests = new Map<
		string,
		{ readonly frame: WebFrameMain; readonly resolve: (text: string) => void; }
	>();

	public configurePreload(configuration: IBrowserViewWindowConfiguration): void {
		this.preloadConfiguration = configuration;
		this.broadcastPreload('configure', configuration);
	}
	private sendPreload(frame: WebFrameMain, command: string, data?: unknown): void {
		if (!frame.detached) {
			frame.send('ash:browserView:preload', { command, data });
		}
	}
	private broadcastPreload(command: string, data?: unknown): void {
		for (const frame of this.preloadFrames.keys()) {
			if (frame.detached) {
				this.preloadFrames.delete(frame);
			} else {
				this.sendPreload(frame, command, data);
			}
		}
	}
	public async getSelectedText(): Promise<string> {
		const frame = this.webContents.focusedFrame ?? this.webContents.mainFrame;
		if (!this.preloadFrames.has(frame)) {
			throw new Error('BrowserPreloadUnavailable');
		}
		if (frame === this.webContents.mainFrame) {
			const text: unknown = await raceCancellationError(
				this.webContents.executeJavaScriptInIsolatedWorld(browserViewIsolatedWorldId, [
					{ code: 'window.browserViewAPI.getSelectedText()' },
				]),
				this.signal,
				'BrowserTargetUnavailable',
			);
			if (typeof text !== 'string' || text.length > 65536) {
				throw new Error('Invalid browser selection');
			}
			return text;
		}
		const id = crypto.randomUUID();
		const result = promiseWithResolvers<string>();
		this.selectedTextRequests.set(id, { frame, resolve: result.resolve });
		const timer = setTimeout(() => result.reject(new Error('BrowserSelectionTimedOut')), 3000);
		try {
			this.sendPreload(frame, 'getSelectedText', id);
			return await raceCancellationError(result.promise, this.signal, 'BrowserTargetUnavailable');
		} finally {
			clearTimeout(timer);
			this.selectedTextRequests.delete(id);
		}
	}
	public findInPage(text: string, options?: IBrowserViewFindInPageOptions): void {
		this.webContents.findInPage(text, {
			forward: options?.forward,
			matchCase: options?.matchCase,
			findNext: options?.recompute !== true,
		});
	}
	public stopFindInPage(keepSelection = false): void {
		this.webContents.stopFindInPage(keepSelection ? 'keepSelection' : 'clearSelection');
	}
	public toggleElementSelection(enabled = this.selectionMode !== 'element', options: IBrowserElementSelectionOptions = {}): void {
		this.broadcastPreload('stop');
		this.selectionMode = enabled ? 'element' : undefined;
		this.selectionOptions = options;
		if (enabled) {
			this.broadcastPreload('startElementPicker', options);
			this.focus();
		} else {
			this.emit({ type: 'selectionStopped', targetId: this.id });
		}
	}
	public toggleAreaSelection(enabled = this.selectionMode !== 'area'): void {
		this.broadcastPreload('stop');
		this.selectionMode = enabled ? 'area' : undefined;
		// Area geometry is measured in the top frame's CSS viewport, including iframe pixels.
		if (enabled) {
			this.sendPreload(this.webContents.mainFrame, 'startAreaPicker');
			this.focus();
		} else {
			this.emit({ type: 'selectionStopped', targetId: this.id });
		}
	}
	public setElementComments(update: IBrowserElementCommentsUpdate): void {
		if (update.comments) {
			this.commentIds.clear();
			for (const comment of update.comments) { this.commentIds.add(comment.elementId); }
		}
		for (const id of update.pendingCommentIdsToDiscard ?? []) { this.commentIds.delete(id); }
		this.broadcastPreload('setElementComments', update);
	}
	private readonly consoleLogs: string[] = [];
	private consoleBytes = 0;
	public getConsoleLogs(): string { return this.consoleLogs.join('\n'); }
	public captureScreenshot(options: IBrowserViewCaptureScreenshotOptions = {}): Promise<VSBuffer> {
		return this.runOperation(this.signal, async () => {
			this.broadcastPreload('hideUI');
			try {
				if (options.awaitNextPaint) {
					await raceCancellationError(
						this.webContents.executeJavaScriptInIsolatedWorld(browserViewIsolatedWorldId, [
							{
								code: 'new Promise(resolve => { setTimeout(resolve, 100); requestAnimationFrame(() => requestAnimationFrame(resolve)); })',
							},
						]),
						this.signal,
						'BrowserTargetUnavailable',
					);
				}
				if (options.fullPage && !options.screenRect) {
					using attachment = this.debugger.acquire();
					const metrics = await this.debugger.sendCommand('Page.getLayoutMetrics');
					if (!isRecord(metrics) || !isRecord(metrics.cssContentSize)) { throw new Error('BrowserScreenshotUnavailable'); }
					const { width, height } = metrics.cssContentSize;
					if (typeof width !== 'number' || typeof height !== 'number' || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 || Math.ceil(width) * Math.ceil(height) > 16_777_216) { throw new Error('BrowserScreenshotTooLarge'); }
					const deviceScale: unknown = await this.webContents.executeJavaScriptInIsolatedWorld(browserViewIsolatedWorldId, [{ code: 'window.devicePixelRatio' }]);
					if (typeof deviceScale !== 'number' || !Number.isFinite(deviceScale) || deviceScale <= 0 || deviceScale > 100) { throw new Error('BrowserScreenshotUnavailable'); }
					// Normalize to CSS pixels so the pixel budget also applies on Retina and zoomed displays.
					const capture = await this.debugger.sendCommand('Page.captureScreenshot', { format: options.format ?? 'png', ...(options.format === 'jpeg' && options.quality !== undefined ? { quality: options.quality } : {}), captureBeyondViewport: true, clip: { x: 0, y: 0, width: Math.ceil(width), height: Math.ceil(height), scale: 1 / deviceScale } });
					if (!isRecord(capture) || typeof capture.data !== 'string' || capture.data.length > 24 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(capture.data)) { throw new Error('BrowserScreenshotTooLarge'); }
					const bytes = Buffer.from(capture.data, 'base64');
					if (bytes.byteLength > 16 * 1024 * 1024) { throw new Error('BrowserScreenshotTooLarge'); }
					return VSBuffer.wrap(bytes);
				}
				const scale = this.webContents.getZoomFactor();
				const bounds = options.screenRect;
				const viewport = this.view.getBounds();
				if (
					bounds &&
					(bounds.x < 0 ||
						bounds.y < 0 ||
						(bounds.x + bounds.width) * scale > viewport.width + 1 ||
						(bounds.y + bounds.height) * scale > viewport.height + 1)
				) {
					throw new Error('BrowserScreenshotOutsideViewport');
				}
				const image = await this.webContents.capturePage(
					bounds
						? {
							x: Math.round(bounds.x * scale),
							y: Math.round(bounds.y * scale),
							width: Math.round(bounds.width * scale),
							height: Math.round(bounds.height * scale),
						}
						: undefined,
				);
				const bytes = options.format === 'jpeg' ? image.toJPEG(options.quality ?? 90) : image.toPNG();
				if (bytes.byteLength > 16 * 1024 * 1024) {
					throw new Error('BrowserScreenshotTooLarge');
				}
				return VSBuffer.wrap(new Uint8Array(bytes));
			} finally {
				this.broadcastPreload('showUI');
			}
		});
	}

	private acceptPreload(event: IpcMainEvent, message: unknown): void {
		if (
			!isRecord(message) ||
			typeof message.frameToken !== 'string' ||
			message.frameToken.length > 64 ||
			typeof message.type !== 'string'
		) {
			return;
		}
		const frame = event.senderFrame;
		if (!frame || frame.detached || !this.webContents.mainFrame.framesInSubtree.includes(frame)) {
			return;
		}
		if (message.type === 'ready') {
			this.preloadFrames.set(frame, message.frameToken);
			if (frame === this.webContents.mainFrame && this.contentVisibilityRule) {
				this.sendPreload(frame, 'contentVisibility', this.contentVisibilityRule);
			}
			if (this.preloadConfiguration) {
				this.sendPreload(frame, 'configure', this.preloadConfiguration);
			}
			if (this.selectionMode === 'element') {
				this.sendPreload(frame, 'startElementPicker', this.selectionOptions);
			}
			return;
		}
		if (this.preloadFrames.get(frame) !== message.frameToken) {
			return;
		}
		const data = message.data;
		if (message.type === 'selectedText') {
			if (isRecord(data) && typeof data.requestId === 'string' && typeof data.text === 'string' && data.text.length <= 65536) {
				const request = this.selectedTextRequests.get(data.requestId);
				if (request?.frame === frame) {
					request.resolve(data.text);
				}
			}
		} else if (message.type === 'keyDown' && !this.selectionMode && this.webContents.isFocused()) {
			if (
				!isRecord(data) ||
				typeof data.key !== 'string' ||
				data.key.length > 64 ||
				typeof data.code !== 'string' ||
				data.code.length > 32 ||
				!Number.isInteger(data.keyCode) ||
				['ctrlKey', 'shiftKey', 'altKey', 'metaKey', 'repeat'].some((key) => typeof data[key] !== 'boolean')
			) {
				return;
			}
			const keyboardEvent: IBrowserViewKeyDownEvent = {
				key: data.key,
				code: data.code,
				keyCode: data.keyCode as number,
				ctrlKey: data.ctrlKey as boolean,
				shiftKey: data.shiftKey as boolean,
				altKey: data.altKey as boolean,
				metaKey: data.metaKey as boolean,
				repeat: data.repeat as boolean,
			};
			this.emit({ type: 'keyDown', targetId: this.id, event: keyboardEvent });
		} else if (message.type === 'elementPicked' && (this.selectionMode === 'element' || (isRecord(data) && typeof data.elementId === 'string' && this.commentIds.has(data.elementId)))) {
			if (
				!isRecord(data) ||
				typeof data.elementId !== 'string' ||
				!data.elementId.startsWith(message.frameToken + ':') ||
				data.elementId.length > 140 ||
				typeof data.outerHTML !== 'string' ||
				data.outerHTML.length > 16384 ||
				typeof data.computedStyle !== 'string' ||
				data.computedStyle.length > 4096 ||
				(data.innerText !== undefined && (typeof data.innerText !== 'string' || data.innerText.length > 8192)) ||
				(data.comment !== undefined && (typeof data.comment !== 'string' || data.comment.length > 2048)) ||
				!validPreloadRect(data.bounds)
			) {
				return;
			}
			this.emit({
				type: 'elementPicked',
				targetId: this.id,
				data: {
					elementId: data.elementId,
					outerHTML: data.outerHTML,
					computedStyle: data.computedStyle,
					...(typeof data.innerText === 'string' ? { innerText: data.innerText } : {}),
					...(typeof data.comment === 'string' ? { comment: data.comment } : {}),
					bounds: { x: data.bounds.x, y: data.bounds.y, width: data.bounds.width, height: data.bounds.height },
					url: frame.url,
				},
			});
		} else if (
			message.type === 'areaPicked' &&
			this.selectionMode === 'area' &&
			frame === this.webContents.mainFrame &&
			validPreloadRect(data)
		) {
			const bounds = this.view.getBounds();
			const scale = this.webContents.getZoomFactor();
			if (
				data.x < 0 ||
				data.y < 0 ||
				data.x + data.width > bounds.width / scale + 1 ||
				data.y + data.height > bounds.height / scale + 1
			) {
				return;
			}
			this.emit({
				type: 'areaPicked',
				targetId: this.id,
				rect: { x: data.x, y: data.y, width: data.width, height: data.height },
			});
		} else if (
			message.type === 'elementCommentRemoved' &&
			typeof data === 'string' &&
			data.startsWith(message.frameToken + ':') &&
			data.length <= 140
		) {
			this.emit({ type: 'elementCommentRemoved', targetId: this.id, elementId: data });
		} else if (message.type === 'selectionStopped') {
			this.selectionMode = undefined;
			this.broadcastPreload('stop');
			this.emit({ type: 'selectionStopped', targetId: this.id });
		}
	}

	constructor(options: BrowserViewOptions) {
		super();
		this.id = options.id;
		this.view = options.view;
		this.session = options.session;
		this.history = options.history;
		this.creation = options.creation;
		this.remoteAuthority = options.remoteAuthority;
		this.window = options.window;
		this.url = options.initialUrl;
		if (options.network) { this._register(options.network); }
		if (options.network || this.creation.owner.type === 'agent') {
			// SOCKS carries TCP traffic; WebRTC must not open direct UDP sockets outside that policy.
			this.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
		}
		this.emitEvent = options.emitEvent;
		this.openContextMenu = options.openContextMenu;
		this._register(toDisposable(() => { for (const finish of this.fileRequests.values()) { finish(null); } }));
	}

	/** Called only after the manager has taken ownership, so synchronous page events can find this view. */
	initialize(): void {
		this.view.setBounds({ x: 0, y: 0, width: 1024, height: 768 });
		this.view.setVisible(false);
		this.window.contentView.addChildView(this.view);
		this.configureSecurity();
		if (this.creation.owner.type === 'user') { this._register(this.session.attachFileReader(this.id, url => this.readFile(url))); }
		this._register(this.session.permissions.attach(this.id, this.webContents, event => this.emit(event), () => this.emitState()));
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
	loadURL(url: string, signal: AbortSignal = this.signal, networkToken?: string | null): Promise<void> {
		const normalized = normalizeBrowserViewUrl(url);
		if (this.creation.owner.type === 'agent' && ['file:', `${browserPageScheme}:`].includes(new URL(normalized).protocol)) { return Promise.reject(new Error('BrowserLocalFileAccessDenied')); }
		return this.runOperation(signal, s => this.navigate(normalized, s), networkToken);
	}
	goBack(): Promise<void> { return this.runOperation(this.signal, async () => { const h = this.webContents.navigationHistory; if (h.canGoBack()) { this.errorDescription = undefined; h.goBack(); } }); }
	goForward(): Promise<void> { return this.runOperation(this.signal, async () => { const h = this.webContents.navigationHistory; if (h.canGoForward()) { this.errorDescription = undefined; h.goForward(); } }); }
	reload(hard = false): Promise<void> { return this.runOperation(this.signal, async () => { this.errorDescription = undefined; if (hard) { this.webContents.reloadIgnoringCache(); } else { this.webContents.reload(); } }); }
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
		this.on(contents, 'context-menu', (_event: ElectronEvent, params: ContextMenuParams) => {
			this.openContextMenu(this, params);
		});
		this.on(contents, 'console-message', (event: Electron.Event<Electron.WebContentsConsoleMessageEventParams>) => {
			const line = `${event.level}: ${event.message}`.slice(0, 8192);
			this.consoleLogs.push(line); this.consoleBytes += Buffer.byteLength(line);
			while (this.consoleBytes > 64 * 1024 || this.consoleLogs.length > 500) { this.consoleBytes -= Buffer.byteLength(this.consoleLogs.shift()!); }
		});
		this.on(contents, 'ipc-message', (event: IpcMainEvent, channel: string, message: unknown) => {
			if (channel === 'ash:browserView:preload') { this.acceptPreload(event, message); }
		});
		this.on(contents, 'did-start-navigation', (_event: ElectronEvent, _url: string, inPlace: boolean, mainFrame: boolean) => {
			if (mainFrame && !inPlace) {
				this.consoleLogs.length = 0; this.consoleBytes = 0;
				this.selectionMode = undefined; this.preloadFrames.clear();
				this.commentIds.clear();
				this.emit({ type: 'selectionStopped', targetId: this.id });
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
			this.recordVisit();
			this.emitState();
		});
		this.on(contents, "did-navigate-in-page", (
			_event: ElectronEvent,
			url: string,
			isMainFrame: boolean,
		) => {
			if (!isMainFrame) return;
			this.url = normalizeBrowserViewUrl(url);
			this.recordVisit();
			this.emitState();
		});
		this.on(contents, "page-title-updated", () => {
			this.historyItem?.update({ title: contents.getTitle() });
			this.emitState();
		});
		this.on(contents, 'page-favicon-updated', (_event: ElectronEvent, favicons: string[]) => {
			// Inline images can be retained without initiating a request outside the page's authority.
			const favicon = favicons.find(value => value.startsWith('data:image/') && value.length <= 64 * 1024);
			if (favicon) { this.historyItem?.update({ favicon }); }
		});
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
		if (this.creation.owner.type === 'agent' && ['file:', `${browserPageScheme}:`].includes(new URL(url).protocol)) { event.preventDefault(); return; }
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
		this.explicitNavigation = true;
		await this.webContents.loadURL(requestedUrl);
		await this.waitForLoad(signal);
		signal.throwIfAborted();
		this.url = this.webContents.getURL() || requestedUrl;
	}

	private recordVisit(): void {
		const explicit = this.explicitNavigation;
		this.explicitNavigation = false;
		if (this.url === 'about:blank') { return; }
		this.historyItem = this.history.add(this.url, this.webContents.getTitle(), undefined, explicit);
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
		return { id: this.id, host: { windowId: this.window.id }, owner: this.creation.owner, session: this.creation.session, remoteAuthority: this.remoteAuthority, state: this.getState() };
	}

	getState(): IBrowserViewState {
		const contents = this.view.webContents;
		if (contents.isDestroyed()) {
			throw new Error("BrowserTargetUnavailable");
		}
		const history = contents.navigationHistory;
		return {
			targetId: this.id,
			permissions: this.session.permissions.snapshot(contents),
			browserZoomIndex: browserZoomFactors.reduce<number>((best, factor, index) => Math.abs(factor - contents.getZoomFactor()) < Math.abs(browserZoomFactors[best]! - contents.getZoomFactor()) ? index : best, browserZoomDefaultIndex),
			deviceEmulation: this.deviceEmulation,
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

function validPreloadRect(value: unknown): value is IBrowserViewRect {
	return isRecord(value) && ['x', 'y', 'width', 'height'].every(key => typeof value[key] === 'number' && Number.isFinite(value[key]) && Math.abs(value[key]) <= 100000) && (value.width as number) > 0 && (value.height as number) > 0;
}
