import { Disposable, DisposableMap, toDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
import { raceCancellationError } from '../../../base/common/async.js';
import { CancellationTokenSource, throwIfCancelled, type CancellationToken } from '../../../base/common/cancellation.js';
import { isCancellationError } from '../../../base/common/errors.js';
import type { IpcRoute } from '../../ipc/electron-main/trustedIpcRouter.js';
import type { IStateService } from '../../state/node/state.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import { WINDOW_CLOSE_RESPONSE_CHANNEL, WINDOW_PREPARE_CLOSE_CHANNEL, WINDOW_PREPARE_QUIT_CHANNEL, WINDOW_PREPARE_LOAD_CHANNEL, WINDOW_PREPARE_RELOAD_CHANNEL, validateWindowCloseResponse, type WindowCloseResponse } from '../../window/common/window.js';

interface WindowCloseState {
	ready: boolean;
	authorized: boolean;
	pendingToken: number | undefined;
	timer: ReturnType<typeof setTimeout> | undefined;
	completeUnload: ((accepted: boolean) => void) | undefined;
	timeoutPrompt: AbortController | undefined;
}

export type WindowCloseFailure =
	| { readonly kind: 'failed'; readonly message: string; }
	| { readonly kind: 'unresponsive'; readonly signal: AbortSignal; readonly token: number; readonly reason: 'windowClose' | 'quit' | 'load' | 'reload'; readonly elapsedMs: number; };

interface ILifecycleWindow {
	on(event: 'close', listener: (event: { preventDefault(): void; }) => void): unknown;
	off(event: 'close', listener: (event: { preventDefault(): void; }) => void): unknown;
	isDestroyed(): boolean;
	close(): void;
	readonly webContents: {
		on(event: 'render-process-gone', listener: () => void): unknown;
		on(event: 'did-navigate', listener: () => void): unknown;
		off(event: 'render-process-gone', listener: () => void): unknown;
		off(event: 'did-navigate', listener: () => void): unknown;
		send(channel: string, token: number): void;
	};
}

export interface ILifecycleMainService<TWindow = Electron.BrowserWindow> {
	readonly wasRestarted: boolean;
	readonly isStarting: boolean;
	startup(ready: Promise<void>, initialize: (token: CancellationToken) => Promise<void>): Promise<void>;
	stopStartup(): Promise<void>;
	prepareUpdateRestart(version: string): Promise<void>;
	registerWindow(window: TWindow): IDisposable;
	unload(window: TWindow, reason?: 'load' | 'reload'): Promise<boolean>;
	respondToClose(window: TWindow, response: WindowCloseResponse): void;
}

export const ILifecycleMainService = createDecorator<ILifecycleMainService>('lifecycleMainService');

/** Owns startup cancellation and the close handshake for Workbench and Sessions windows. */
export class LifecycleMainService<TWindow extends ILifecycleWindow> extends Disposable implements ILifecycleMainService<TWindow> {
	private static readonly updateRestartStateKey = 'updateRestartVersion';
	private readonly windowRegistrations = this._register(new DisposableMap<TWindow, IDisposable>());
	private readonly closeStates = new Map<TWindow, WindowCloseState>();
	private nextCloseToken = 0;
	private readonly startupCancellation = this._register(new CancellationTokenSource());
	private startupTask: Promise<void> | undefined;
	private starting = false;
	public readonly wasRestarted: boolean;
	public get isStarting(): boolean { return this.starting; }

	constructor(
		private readonly reportCloseFailure: (window: TWindow, failure: WindowCloseFailure) => void | Promise<void>,
		private readonly reportCloseVeto: (window: TWindow) => void,
		private readonly stateService: IStateService,
		currentVersion: string,
		private readonly getCloseReason: () => 'windowClose' | 'quit' = () => 'windowClose',
	) {
		super();
		this.wasRestarted = stateService.getItem(LifecycleMainService.updateRestartStateKey) === currentVersion;
		if (this.wasRestarted) stateService.removeItem(LifecycleMainService.updateRestartStateKey);
	}

	public startup(ready: Promise<void>, initialize: (token: CancellationToken) => Promise<void>): Promise<void> {
		this.assertNotDisposed();
		if (this.startupTask) { throw new Error('Desktop startup has already started'); }
		this.starting = true;
		this.startupTask = (async () => {
			try {
				await raceCancellationError(ready, this.startupCancellation.token);
				throwIfCancelled(this.startupCancellation.token);
				await initialize(this.startupCancellation.token);
			} finally {
				this.starting = false;
			}
		})();
		return this.startupTask;
	}

	/** Initialization must settle before its resources can be closed; racing it would leave live writers behind. */
	public async stopStartup(): Promise<void> {
		this.startupCancellation.cancel();
		try { await this.startupTask; }
		catch (error) { if (!isCancellationError(error)) { throw error; } }
	}

	public async prepareUpdateRestart(version: string): Promise<void> {
		this.assertNotDisposed();
		this.stateService.setItem(LifecycleMainService.updateRestartStateKey, version);
		await this.stateService.flush();
	}

	public registerWindow(window: TWindow): IDisposable {
		this.assertNotDisposed();
		if (this.windowRegistrations.has(window)) throw new Error('Workbench window is already registered for close');
		const state: WindowCloseState = { ready: false, authorized: false, pendingToken: undefined, timer: undefined, completeUnload: undefined, timeoutPrompt: undefined };
		this.closeStates.set(window, state);
		const clearPending = (): void => {
			if (state.timer) clearTimeout(state.timer);
			state.timer = undefined;
			state.timeoutPrompt?.abort();
			state.timeoutPrompt = undefined;
			state.pendingToken = undefined;
			state.completeUnload?.(false);
			state.completeUnload = undefined;
		};
		const onClose = (event: { preventDefault(): void; }): void => {
			if (state.authorized || !state.ready) return;
			event.preventDefault();
			if (state.pendingToken !== undefined) return;
			const token = ++this.nextCloseToken;
			state.pendingToken = token;
			const reason = this.getCloseReason();
			this.waitForResponse(window, state, reason);
			window.webContents.send(reason === 'quit' ? WINDOW_PREPARE_QUIT_CHANNEL : WINDOW_PREPARE_CLOSE_CHANNEL, token);
		};
		const onRendererLoading = (): void => { state.ready = false; clearPending(); };
		window.on('close', onClose);
		// A navigation attempt can be prevented while the old document still owns
		// shutdown participants. Retire them only when a new main document commits.
		window.webContents.on('did-navigate', onRendererLoading);
		window.webContents.on('render-process-gone', onRendererLoading);
		this.windowRegistrations.set(window, toDisposable(() => {
			clearPending();
			this.closeStates.delete(window);
			window.off('close', onClose);
			if (!window.isDestroyed()) {
				window.webContents.off('did-navigate', onRendererLoading);
				window.webContents.off('render-process-gone', onRendererLoading);
			}
		}));
		return toDisposable(() => this.windowRegistrations.deleteAndDispose(window));
	}

	/** The renderer must finish its shutdown participants before this window loads another workspace. */
	public unload(window: TWindow, reason: 'load' | 'reload' = 'load'): Promise<boolean> {
		const state = this.closeStates.get(window);
		if (!state || window.isDestroyed() || !state.ready && reason !== 'reload') throw new Error('Workbench window is not ready to unload');
		// Startup failures have no renderer shutdown participants to acknowledge Retry.
		if (!state.ready) return Promise.resolve(true);
		if (state.pendingToken !== undefined) throw new Error('Workbench window already has a shutdown request');
		return new Promise<boolean>(resolve => {
			const token = ++this.nextCloseToken;
			state.pendingToken = token;
			state.completeUnload = resolve;
			this.waitForResponse(window, state, reason);
			window.webContents.send(reason === 'reload' ? WINDOW_PREPARE_RELOAD_CHANNEL : WINDOW_PREPARE_LOAD_CHANNEL, token);
		});
	}

	public respondToClose(window: TWindow, response: WindowCloseResponse): void {
		const state = this.closeStates.get(window);
		if (!state || window.isDestroyed()) throw new Error('Workbench window is closed');
		if (response.kind === 'ready') {
			state.ready = true;
			return;
		}
		if (state.pendingToken !== response.token) throw new Error('Window close request is no longer active');
		if (state.timer) clearTimeout(state.timer);
		state.timer = undefined;
		state.timeoutPrompt?.abort();
		state.timeoutPrompt = undefined;
		state.pendingToken = undefined;
		const completeUnload = state.completeUnload;
		state.completeUnload = undefined;
		if (completeUnload) {
			completeUnload(response.kind === 'complete');
			if (response.kind === 'failed') this.reportFailure(window, response.message);
			return;
		}
		if (response.kind === 'complete') {
			state.authorized = true;
			window.close();
		} else if (response.kind === 'vetoed') {
			this.reportCloseVeto(window);
		} else {
			this.reportFailure(window, response.message);
		}
	}

	private waitForResponse(window: TWindow, state: WindowCloseState, reason: 'windowClose' | 'quit' | 'load' | 'reload', started = performance.now()): void {
		const token = state.pendingToken!;
		state.timer = setTimeout(() => {
			state.timer = undefined;
			const prompt = new AbortController();
			state.timeoutPrompt = prompt;
			// Waiting keeps the original request live: a slow save can still finish
			// and dismiss recovery. Destroying the window settles it via registration cleanup.
			void Promise.resolve().then(() => this.reportCloseFailure(window, { kind: 'unresponsive', signal: prompt.signal, token, reason, elapsedMs: performance.now() - started }))
				.catch(error => console.error('Failed to report window shutdown timeout', error))
				.finally(() => {
					if (state.timeoutPrompt !== prompt) return;
					state.timeoutPrompt = undefined;
					if (!prompt.signal.aborted && state.pendingToken === token) this.waitForResponse(window, state, reason, started);
				});
		}, 30_000);
	}

	private reportFailure(window: TWindow, message: string): void {
		void Promise.resolve(this.reportCloseFailure(window, { kind: 'failed', message })).catch(error => console.error('Failed to report window close error', error));
	}
}

export function windowCloseResponseIpcRoute<TWindow extends ILifecycleWindow>(service: LifecycleMainService<TWindow>, window: TWindow): IpcRoute<unknown, unknown> {
	return {
		channel: WINDOW_CLOSE_RESPONSE_CHANNEL,
		validate: validateWindowCloseResponse,
		invoke: response => service.respondToClose(window, response as WindowCloseResponse),
	};
}
