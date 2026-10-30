import { setTimeout as delay } from 'node:timers/promises';
import { DeferredPromise } from '../../../base/common/async.js';
import type { CancellationToken } from '../../../base/common/cancellation.js';
import { Emitter } from '../../../base/common/event.js';
import { isRecord } from '../../../base/common/types.js';
import { localize } from '../../../nls.js';
import { Color } from '../../../base/common/color.js';
import { IThemeMainService } from '../../theme/electron-main/themeMainService.js';
import { IAuxiliaryWindowsMainService } from '../../auxiliaryWindow/electron-main/auxiliaryWindows.js';
import { ILogService } from '../../log/common/log.js';
import { IDialogMainService } from '../../dialogs/electron-main/dialogMainService.js';
import { ILifecycleMainService } from '../../lifecycle/electron-main/lifecycleMainService.js';
import { Disposable, toDisposable, type DisposableStore, type IDisposable } from '../../../base/common/lifecycle.js';
import {
	WindowMode,
	LoadReason,
	type ILoadEvent,
	type ICodeWindow,
	type IWindowBounds,
	type IWindowState,
} from '../../window/electron-main/window.js';
import {
	WINDOW_ZOOM_CHANGED_CHANNEL,
	WINDOW_CLIENT_SIZE_CHANGED_CHANNEL,
	type IWindowClientSize,
	type TitleBarStyleConfiguration,
} from '../../window/common/window.js';
import {
	applyWindowState,
	resolveBrowserWindowOptions,
	resolveWindowTitleBarOptions,
	restoreWindowBounds,
	WindowControlsOverlay,
	type IWindowConstructorOptions,
	type IWindowWebPreferences,
} from './windows.js';
import {
	UNKNOWN_EMPTY_WINDOW_WORKSPACE,
	isSingleFolderWorkspaceIdentifier,
	isWorkspaceIdentifier,
	type IAnyWorkspaceIdentifier,
} from '../../workspace/common/workspace.js';

export interface IWindowCreationOptions {
	/** Rebuilds the window's host resources without asking the old renderer to unload. */
	readonly reopen: () => Promise<void>;
	readonly workspace?: IAnyWorkspaceIdentifier;
	readonly isSessionsWindow?: boolean;
	readonly state: IWindowState;
	readonly webPreferences: IWindowWebPreferences;
	readonly title: string;
	readonly titleBarStyle?: TitleBarStyleConfiguration;
	readonly backgroundColor?: string;
	readonly icon?: string;
	readonly tabbingIdentifier?: string;
}

export interface ICodeWindowHandle<TWindow = Electron.BrowserWindow> {
	readonly id: number;
	readonly webContents: {
		on(event: 'will-prevent-unload' | 'zoom-changed', listener: () => void): unknown;
		off(event: 'will-prevent-unload' | 'zoom-changed', listener: () => void): unknown;
		on(
			event: 'render-process-gone',
			listener: (event: unknown, details: Electron.RenderProcessGoneDetails) => void,
		): unknown;
		off(
			event: 'render-process-gone',
			listener: (event: unknown, details: Electron.RenderProcessGoneDetails) => void,
		): unknown;
		on(
			event: 'did-fail-load',
			listener: (event: unknown, code: number, description: string, url: string, mainFrame: boolean) => void,
		): unknown;
		off(
			event: 'did-fail-load',
			listener: (event: unknown, code: number, description: string, url: string, mainFrame: boolean) => void,
		): unknown;
		isDestroyed(): boolean;
		getZoomLevel(): number;
		send(channel: string, ...args: unknown[]): void;
		on(
			event: 'did-start-navigation',
			listener: (event: unknown, url: string, inPlace: boolean, mainFrame: boolean) => void,
		): unknown;
		off(
			event: 'did-start-navigation',
			listener: (event: unknown, url: string, inPlace: boolean, mainFrame: boolean) => void,
		): unknown;
		reload(): void;
	};
	on(
		event: 'unresponsive' | 'responsive' | 'focus' | 'enter-full-screen' | 'leave-full-screen',
		listener: () => void,
	): unknown;
	off(
		event: 'unresponsive' | 'responsive' | 'focus' | 'enter-full-screen' | 'leave-full-screen',
		listener: () => void,
	): unknown;
	once(event: 'ready-to-show' | 'closed', listener: () => void): this;
	isDestroyed(): boolean;
	isMinimized(): boolean;
	restore(): void;
	focus(): void;
	close(): void;
	isFullScreen(): boolean;
	isMaximized(): boolean;
	getNormalBounds(): IWindowBounds;
	addTabbedWindow(window: TWindow): void;
	show(): void;
	getBounds(): IWindowBounds;
	setBounds(bounds: IWindowBounds): void;
	hookWindowMessage(message: number, callback: (wParam: Buffer, lParam: Buffer) => void): void;
	unhookWindowMessage(message: number): void;
	setTitleBarOverlay(colors: { color: string; symbolColor: string; height: number }): void;
	maximize(): void;
	setFullScreen(fullscreen: boolean): void;
	loadURL(url: string): Promise<void>;
	loadFile(path: string): Promise<void>;
	destroy(): void;
}

// Network failures while the development host restarts can be retried. Other
// navigation errors must still reject the opening operation.
const developmentLoadErrors = new Set([-100, -101, -102, -103, -106, -324, -379]);

/** Owns one Electron window and all resources that end with it. */
export class CodeWindow<TWindow extends ICodeWindowHandle<TWindow>> extends Disposable implements ICodeWindow<TWindow> {
	public readonly win: TWindow;
	public readonly resources: DisposableStore;
	public openedWorkspace: IAnyWorkspaceIdentifier;
	private readonly documentReady = this._register(new Emitter<void>());
	public readonly onDidSignalReady = this.documentReady.event;
	private readonly documentLoading = this._register(new Emitter<ILoadEvent>());
	public readonly onWillLoad = this.documentLoading.event;
	private readonly closed = this._register(new Emitter<void>());
	public readonly onDidClose = this.closed.event;
	private readonly enteredFullScreen = this._register(new Emitter<void>());
	public readonly onDidEnterFullScreen = this.enteredFullScreen.event;
	private readonly leftFullScreen = this._register(new Emitter<void>());
	public readonly onDidLeaveFullScreen = this.leftFullScreen.event;
	private focusTime = performance.now();
	private readonly pendingMessages = new Set<{
		readonly channel: string;
		readonly args: unknown[];
		readonly token: CancellationToken;
		cancellation?: IDisposable;
	}>();
	private readiness = new DeferredPromise<void>();
	private documentLifetime = new DeferredPromise<void>();
	private readyState = false;
	private configuration: Parameters<ICodeWindow<TWindow>['load']>[0] | undefined;
	private loading: Promise<void> | undefined;
	private loadCancellation: AbortController | undefined;
	private reloading: Promise<void> | undefined;
	private errorPrompt: AbortController | undefined;
	private errorPromptTask: Promise<void> | undefined;
	private shutdownPrompt = false;
	private rendererGone = false;
	private preparedNavigation = false;
	private readonly controls: WindowControlsOverlay;
	private readonly titleBarStyle: TitleBarStyleConfiguration;
	private readonly reopen: () => Promise<void>;
	private clientSize: IWindowClientSize | undefined;

	constructor(
		createWindow: (
			options: IWindowConstructorOptions & Pick<IWindowCreationOptions, 'title' | 'icon' | 'tabbingIdentifier'>,
		) => TWindow,
		options: IWindowCreationOptions,
		resources: DisposableStore,
		@ILogService private readonly logService: ILogService,
		@IDialogMainService private readonly dialogMainService: IDialogMainService<TWindow>,
		@ILifecycleMainService private readonly lifecycleMainService: ILifecycleMainService<TWindow>,
		@IThemeMainService themeMainService: IThemeMainService,
		@IAuxiliaryWindowsMainService private readonly auxiliaryWindowsMainService: IAuxiliaryWindowsMainService,
	) {
		super();
		this.titleBarStyle = options.titleBarStyle ?? 'custom';
		this.reopen = options.reopen;
		this.openedWorkspace = options.workspace ?? UNKNOWN_EMPTY_WINDOW_WORKSPACE;
		this.resources = this._register(resources);
		const scope = `${options.isSessionsWindow ? 'sessions' : 'workbench'}:${this.openedWorkspace.id}`;
		let backgroundColor: string;
		try {
			backgroundColor = options.backgroundColor ?? themeMainService.getBackgroundColor(scope);
			this.win = createWindow({
				...resolveBrowserWindowOptions({
					state: options.state,
					webPreferences: options.webPreferences,
					titleBarStyle: options.titleBarStyle,
					backgroundColor,
				}),
				show: false,
				title: options.title,
				icon: options.icon,
				tabbingIdentifier: options.tabbingIdentifier,
			});
		} catch (error) {
			this.dispose();
			throw error;
		}
		const window = this.win;
		if (process.platform === 'win32') {
			// getContentBounds() has already rounded through integer DIPs. WM_SIZE
			// retains the actual drawable pixel boundary at fractional display scales.
			let pending: ReturnType<typeof setImmediate> | undefined;
			window.hookWindowMessage(0x0005, (wParam, lParam) => {
				if (wParam.byteLength < 4 || lParam.byteLength < 4 || wParam.readUInt32LE() === 1) return;
				const width = lParam.readUInt16LE(0);
				const height = lParam.readUInt16LE(2);
				if (!width || !height || (this.clientSize?.width === width && this.clientSize.height === height))
					return;
				this.clientSize = { width, height };
				pending ??= setImmediate(() => {
					pending = undefined;
					if (!this.isDisposed && !window.isDestroyed() && !window.webContents.isDestroyed()) {
						this.send(WINDOW_CLIENT_SIZE_CHANGED_CHANNEL, this.clientSize);
					}
				});
			});
			this._register(
				toDisposable(() => {
					if (pending !== undefined) clearImmediate(pending);
					if (!window.isDestroyed()) window.unhookWindowMessage(0x0005);
				}),
			);
		}
		this.controls = new WindowControlsOverlay(colors => {
			if (
				(options.titleBarStyle ?? 'custom') === 'custom' &&
				(process.platform === 'win32' || process.platform === 'linux')
			) {
				window.setTitleBarOverlay(colors);
			}
		});
		this.controls.setTheme({
			backgroundColor,
			symbolColor: Color.fromHex(backgroundColor).isDarker() ? '#ffffff' : '#000000',
		});
		const { x, y, width, height } = options.state;
		if (process.platform === 'win32' && x !== undefined && y !== undefined) {
			// Windows may size the constructor frame using the primary display's DPI.
			// Apply the outer DIP rectangle on the created window's display before
			// placement tracking captures it or maximize/fullscreen changes its mode.
			restoreWindowBounds(window, { x, y, width, height });
		}
		window.once('ready-to-show', () => {
			if (window.isDestroyed()) return;
			applyWindowState(window, options.state);
			window.show();
		});
		const contents = window.webContents;
		const onFocus = (): void => {
			this.focusTime = performance.now();
		};
		const onEnterFullScreen = (): void => this.enteredFullScreen.fire();
		const onLeaveFullScreen = (): void => this.leftFullScreen.fire();
		const onZoom = (): void => {
			// Electron emits the wheel request before applying the resulting level.
			setImmediate(() => {
				if (!this.isDisposed && !window.isDestroyed() && !contents.isDestroyed()) {
					this.send(WINDOW_ZOOM_CHANGED_CHANNEL, contents.getZoomLevel());
				}
			});
		};
		window.on('focus', onFocus);
		window.on('enter-full-screen', onEnterFullScreen);
		window.on('leave-full-screen', onLeaveFullScreen);
		contents.on('zoom-changed', onZoom);
		const onNavigation = (_event: unknown, url: string, inPlace: boolean, mainFrame: boolean): void => {
			if (!mainFrame || inPlace) return;
			this.rendererGone = false;
			this.errorPrompt?.abort();
			this.errorPrompt = undefined;
			if (!this.preparedNavigation) {
				this.beginDocumentLoad(url === this.configuration?.url ? LoadReason.RELOAD : LoadReason.LOAD);
			}
			this.preparedNavigation = false;
		};
		const onGone = (_event: unknown, details: Electron.RenderProcessGoneDetails): void => {
			this.logService.error('window', 'Renderer process gone', {
				windowId: window.id,
				reason: details.reason,
				exitCode: details.exitCode,
			});
			this.rendererGone = true;
			this.resetReady();
			this.loadCancellation?.abort();
			this.errorPrompt?.abort();
			this.errorPrompt = undefined;
			// Before the first document is configured there is no entry to reopen.
			// Closing lets the in-flight opening fail and release its startup scope.
			if (!this.configuration) {
				this.logService.error('window', 'Renderer process gone before initial load', { windowId: window.id });
				window.destroy();
				return;
			}
			void this.reportWindowError(true);
		};
		const onUnresponsive = (): void => {
			void this.reportWindowError(false);
		};
		const onResponsive = (): void => {
			if (!this.rendererGone && !this.shutdownPrompt) {
				this.errorPrompt?.abort();
				this.errorPrompt = undefined;
			}
		};
		const onReload = (): void => {
			void this.reload().catch(error =>
				this.logService.error('window', 'Could not prepare window reload', error),
			);
		};
		const onFailedLoad = (
			_event: unknown,
			code: number,
			description: string,
			url: string,
			mainFrame: boolean,
		): void => {
			if (!mainFrame || code === -3) return;
			this.logService.error('window', 'Renderer navigation failed', {
				windowId: window.id,
				code,
				description,
				url,
			});
			const configuration = this.configuration;
			if (configuration?.useDevelopmentUrl && configuration.url === url && developmentLoadErrors.has(code)) {
				void this.load(configuration).catch(error =>
					this.logService.error('window', 'Renderer recovery failed', error),
				);
			}
		};
		contents.on('did-start-navigation', onNavigation);
		contents.on('render-process-gone', onGone);
		contents.on('will-prevent-unload', onReload);
		contents.on('did-fail-load', onFailedLoad);
		window.on('unresponsive', onUnresponsive);
		window.on('responsive', onResponsive);
		this._register(
			toDisposable(() => {
				this.loadCancellation?.abort();
				this.errorPrompt?.abort();
				void this.readiness.complete();
				void this.documentLifetime.complete();
				for (const message of this.pendingMessages) message.cancellation?.dispose();
				this.pendingMessages.clear();
				// Keep the original emitter: Electron drops window.webContents on close.
				if (!window.isDestroyed()) {
					contents.off('zoom-changed', onZoom);
					contents.off('did-start-navigation', onNavigation);
					contents.off('render-process-gone', onGone);
					contents.off('will-prevent-unload', onReload);
					contents.off('did-fail-load', onFailedLoad);
				}
				window.off('focus', onFocus);
				window.off('enter-full-screen', onEnterFullScreen);
				window.off('leave-full-screen', onLeaveFullScreen);
				window.off('unresponsive', onUnresponsive);
				window.off('responsive', onResponsive);
			}),
		);
		window.once('closed', () => {
			this.closed.fire();
			this.dispose();
		});
	}

	protected override disposeCore(): void {
		// Closing subscribers must run while the owner and its resource scope still
		// exist. This also covers explicit disposal after failed initialization.
		try {
			if (this.win && !this.win.isDestroyed()) this.win.destroy();
		} finally {
			super.disposeCore();
		}
	}

	public get id(): number {
		return this.win.id;
	}
	public get lastFocusTime(): number {
		return this.focusTime;
	}

	public focus(): void {
		if (this.isDisposed || this.win.isDestroyed()) return;
		if (this.win.isMinimized()) this.win.restore();
		this.win.focus();
	}

	public close(): void {
		if (!this.isDisposed && !this.win.isDestroyed()) this.win.close();
	}

	public getBounds(): IWindowBounds {
		return this.win.getBounds();
	}
	public getClientSize(): IWindowClientSize | undefined {
		return this.clientSize;
	}
	public isFullScreen(): boolean {
		return this.win.isFullScreen();
	}

	public serializeWindowState(): IWindowState & IWindowBounds {
		return {
			...this.win.getNormalBounds(),
			mode: this.isFullScreen()
				? WindowMode.Fullscreen
				: this.win.isMaximized()
					? WindowMode.Maximized
					: WindowMode.Normal,
		};
	}

	public addTabbedWindow(window: ICodeWindow<TWindow>): void {
		if (window.win.isDestroyed()) return;
		if (this.isDisposed || this.win.isDestroyed()) {
			window.close();
			return;
		}
		this.win.addTabbedWindow(window.win);
	}

	public send(channel: string, ...args: unknown[]): void {
		if (this.isDisposed || this.win.isDestroyed()) return;
		try {
			if (!this.win.webContents.isDestroyed()) this.win.webContents.send(channel, ...args);
		} catch (error) {
			this.logService.error('window', 'Could not send renderer message', { windowId: this.id, channel, error });
		}
	}

	public sendWhenReady(channel: string, token: CancellationToken, ...args: unknown[]): void {
		if (this.isDisposed || this.win.isDestroyed() || token.isCancellationRequested) return;
		if (this.isReady) {
			this.send(channel, ...args);
			return;
		}
		const message: { channel: string; args: unknown[]; token: CancellationToken; cancellation?: IDisposable } = {
			channel,
			args,
			token,
		};
		this.pendingMessages.add(message);
		message.cancellation = token.onCancellationRequested(() => {
			this.pendingMessages.delete(message);
			message.cancellation?.dispose();
		});
	}

	public get whenClosedOrLoaded(): Promise<void> {
		return this.documentLifetime.p;
	}

	public get isReady(): boolean {
		return this.readyState && !this.isDisposed && !this.win.isDestroyed();
	}

	public async ready(): Promise<this> {
		while (!this.isDisposed && !this.win.isDestroyed()) {
			const readiness = this.readiness;
			await readiness.p;
			if (this.isReady && readiness === this.readiness) return this;
		}
		throw new Error('Window closed before its renderer was ready');
	}

	public setReady(): void {
		this.assertNotDisposed();
		if (this.isReady) return;
		this.readyState = true;
		void this.readiness.complete();
		this.documentReady.fire();
		// A ready listener may synchronously navigate or close the window. Leave
		// remaining messages queued for the next ready document in that case.
		for (const message of this.pendingMessages) {
			if (!this.isReady) break;
			this.pendingMessages.delete(message);
			message.cancellation?.dispose();
			if (!message.token.isCancellationRequested) this.send(message.channel, ...message.args);
		}
	}

	private resetReady(): void {
		void this.readiness.complete();
		this.readiness = new DeferredPromise<void>();
		this.readyState = false;
		void this.documentLifetime.complete();
		this.documentLifetime = new DeferredPromise<void>();
	}

	private beginDocumentLoad(reason: LoadReason): void {
		this.resetReady();
		const workspace = this.openedWorkspace;
		this.documentLoading.fire({
			workspace:
				isWorkspaceIdentifier(workspace) || isSingleFolderWorkspaceIdentifier(workspace)
					? workspace
					: undefined,
			reason,
		});
	}

	public load(configuration: Parameters<ICodeWindow<TWindow>['load']>[0]): Promise<void> {
		this.assertNotDisposed();
		if (this.loading && !this.loadCancellation?.signal.aborted && this.configuration?.url === configuration.url)
			return this.loading;
		this.loadCancellation?.abort();
		const cancellation = new AbortController();
		this.loadCancellation = cancellation;
		const reason = !this.configuration
			? LoadReason.INITIAL
			: this.configuration.url === configuration.url
				? LoadReason.RELOAD
				: LoadReason.LOAD;
		this.configuration = { ...configuration };
		this.rendererGone = false;
		this.preparedNavigation = true;
		this.beginDocumentLoad(reason);
		// Publish before navigation can synchronously emit did-fail-load. Startup
		// and recovery of the same document must share one operation.
		const loading = Promise.resolve()
			.then(async () => {
				if (!configuration.useDevelopmentUrl) {
					if (cancellation.signal.aborted) return;
					// Load the exact URL registered with the IPC gates. loadFile uses different
					// escaping for Windows short paths ("~" versus "%7E") and rejects a trusted renderer.
					await this.win.loadURL(configuration.url);
					return;
				}
				let waiting = false;
				while (!cancellation.signal.aborted) {
					let available = false;
					try {
						// A listening HMR socket does not imply the HTML is available.
						const response = await fetch(configuration.url, {
							redirect: 'error',
							signal: AbortSignal.any([cancellation.signal, AbortSignal.timeout(2_000)]),
						});
						available = response.ok;
						await response.body?.cancel();
					} catch {
						if (cancellation.signal.aborted) return;
					}
					if (available && !cancellation.signal.aborted) {
						try {
							await this.win.loadURL(configuration.url);
							return;
						} catch (error) {
							if (cancellation.signal.aborted) return;
							if (
								!isRecord(error) ||
								typeof error.errno !== 'number' ||
								!developmentLoadErrors.has(error.errno)
							)
								throw error;
						}
					}
					if (!waiting) {
						this.logService.warn('window', 'Waiting for development renderer', {
							windowId: this.win.id,
							url: configuration.url,
						});
						waiting = true;
					}
					await delay(500, undefined, { signal: cancellation.signal });
				}
			})
			.catch(error => {
				if (!cancellation.signal.aborted) throw error;
			});
		this.loading = loading;
		const complete = (): void => {
			if (this.loading === loading) this.loading = undefined;
		};
		void loading.then(complete, complete);
		return loading;
	}

	public reload(): Promise<void> {
		this.assertNotDisposed();
		if (this.reloading) return this.reloading;
		// Start the handshake in the Electron event turn. Deferring this step
		// lets Chromium's beforeunload decision race the owning Main process.
		const reloading = this.lifecycleMainService.unload(this.win, 'reload').then(accepted => {
			if (accepted && !this.isDisposed && !this.win.isDestroyed()) {
				this.rendererGone = false;
				this.preparedNavigation = true;
				this.beginDocumentLoad(LoadReason.RELOAD);
				this.win.webContents.reload();
			}
		});
		this.reloading = reloading;
		const complete = (): void => {
			this.reloading = undefined;
		};
		void reloading.then(complete, complete);
		return reloading;
	}

	public updateWindowControls(options: Parameters<ICodeWindow<TWindow>['updateWindowControls']>[0]): void {
		this.assertNotDisposed();
		if (
			options.backgroundColor !== undefined ||
			options.foregroundColor !== undefined ||
			options.backdropColor !== undefined
		) {
			const theme = this.controls.setTheme({
				...(options.backgroundColor !== undefined ? { backgroundColor: options.backgroundColor } : {}),
				...(options.foregroundColor !== undefined ? { symbolColor: options.foregroundColor } : {}),
				...(options.backdropColor !== undefined ? { backdropColor: options.backdropColor } : {}),
			});
			const overlay = resolveWindowTitleBarOptions(
				this.titleBarStyle,
				process.platform,
				theme.backgroundColor,
			).titleBarOverlay;
			if (typeof overlay === 'object') {
				// Detached editors share the palette, but their modal backdrop belongs
				// to their own window and must not inherit this window's dim state.
				for (const auxiliary of this.auxiliaryWindowsMainService.getWindows()) {
					if (auxiliary.parentId === this.win.id)
						auxiliary.win.setTitleBarOverlay({ ...overlay, symbolColor: theme.symbolColor });
				}
			}
		}
		if (options.dimmed !== undefined) this.controls.setDimmed(options.dimmed);
	}

	public reportWindowError(gone: boolean, shutdownSignal?: AbortSignal): Promise<void> {
		if (this.isDisposed || shutdownSignal?.aborted) return Promise.resolve();
		if (this.errorPrompt) {
			if (!shutdownSignal) return this.errorPromptTask!;
			const prompt = this.errorPrompt;
			this.shutdownPrompt = true;
			const cancel = (): void => prompt.abort();
			shutdownSignal.addEventListener('abort', cancel, { once: true });
			return this.errorPromptTask!.finally(() => shutdownSignal.removeEventListener('abort', cancel));
		}
		if (!gone)
			this.logService.error('window', 'Window is unresponsive', {
				windowId: this.win.id,
				source: shutdownSignal ? 'shutdown-timeout' : 'renderer-unresponsive',
			});
		const prompt = new AbortController();
		this.errorPrompt = prompt;
		this.shutdownPrompt = shutdownSignal !== undefined;
		const cancel = (): void => prompt.abort();
		shutdownSignal?.addEventListener('abort', cancel, { once: true });
		const task = this.dialogMainService
			.showMessageBox(
				{
					type: 'warning',
					message: gone
						? localize('window.rendererGone', 'The window closed unexpectedly.')
						: localize('window.unresponsive', 'The window is not responding.'),
					detail: gone
						? localize('window.recoveryDetail', 'Reopen the window to continue, or close it.')
						: localize(
								'window.waitRecoveryDetail',
								'You can keep waiting, reopen the window, or close it. Reopening or closing may lose changes that have not been backed up.',
							),
					buttons: gone
						? [localize('window.reopen', 'Reopen'), localize('window.close', 'Close')]
						: [
								localize('window.reopen', 'Reopen'),
								localize('window.close', 'Close'),
								localize('window.keepWaiting', 'Keep Waiting'),
							],
					defaultId: gone ? 0 : 2,
					cancelId: gone ? 1 : 2,
					noLink: true,
					signal: prompt.signal,
				},
				this.win,
			)
			.then(async result => {
				// Recovery and close invalidate an already visible dialog's result too.
				if (prompt.signal.aborted || this.isDisposed) return;
				if (result.response === 0) {
					await this.reopen();
					if (!this.win.isDestroyed()) this.win.destroy();
				} else if (result.response === 1) {
					this.win.destroy();
				}
			})
			.catch(error => this.logService.error('window', 'Window recovery failed', error))
			.finally(() => {
				shutdownSignal?.removeEventListener('abort', cancel);
				if (this.errorPrompt === prompt) {
					this.errorPrompt = undefined;
					this.errorPromptTask = undefined;
					this.shutdownPrompt = false;
				}
			});
		this.errorPromptTask = task;
		return task;
	}
}
