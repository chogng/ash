import { Disposable, DisposableMap, toDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
import type { IpcRoute } from '../../ipc/electron-main/trustedIpcRouter.js';
import type { IStateService } from '../../state/node/state.js';
import { WINDOW_CLOSE_RESPONSE_CHANNEL, WINDOW_PREPARE_CLOSE_CHANNEL, validateWindowCloseResponse, type WindowCloseResponse } from '../../window/common/window.js';

interface ILifecycleWindow {
	on(event: 'close', listener: (event: { preventDefault(): void }) => void): unknown;
	off(event: 'close', listener: (event: { preventDefault(): void }) => void): unknown;
	isDestroyed(): boolean;
	close(): void;
	readonly webContents: {
		on(event: 'did-start-loading' | 'render-process-gone', listener: () => void): unknown;
		off(event: 'did-start-loading' | 'render-process-gone', listener: () => void): unknown;
		send(channel: string, token: number): void;
	};
}

/** Owns the main-process close handshake for Workbench and Sessions windows. */
export class LifecycleMainService<TWindow extends ILifecycleWindow> extends Disposable {
	private static readonly updateRestartStateKey = 'updateRestartVersion';
	private readonly windowRegistrations = this._register(new DisposableMap<TWindow, IDisposable>());
	private readonly closeStates = new Map<TWindow, { ready: boolean; authorized: boolean; pendingToken: number | undefined; timer: ReturnType<typeof setTimeout> | undefined }>();
	private nextCloseToken = 0;
	public readonly wasRestarted: boolean;

	constructor(
		private readonly reportCloseFailure: (window: TWindow, message: string) => void | Promise<void>,
		private readonly reportCloseVeto: (window: TWindow) => void,
		private readonly stateService: IStateService,
		currentVersion: string,
	) {
		super();
		this.wasRestarted = stateService.getItem(LifecycleMainService.updateRestartStateKey) === currentVersion;
		if (this.wasRestarted) stateService.removeItem(LifecycleMainService.updateRestartStateKey);
	}

	public async prepareUpdateRestart(version: string): Promise<void> {
		this.assertNotDisposed();
		this.stateService.setItem(LifecycleMainService.updateRestartStateKey, version);
		await this.stateService.flush();
	}

	public registerWindow(window: TWindow): IDisposable {
		this.assertNotDisposed();
		if (this.windowRegistrations.has(window)) throw new Error('Workbench window is already registered for close');
		const state = { ready: false, authorized: false, pendingToken: undefined as number | undefined, timer: undefined as ReturnType<typeof setTimeout> | undefined };
		this.closeStates.set(window, state);
		const clearPending = (): void => {
			if (state.timer) clearTimeout(state.timer);
			state.timer = undefined;
			state.pendingToken = undefined;
		};
		const onClose = (event: { preventDefault(): void }): void => {
			if (state.authorized || !state.ready) return;
			event.preventDefault();
			if (state.pendingToken !== undefined) return;
			const token = ++this.nextCloseToken;
			state.pendingToken = token;
			state.timer = setTimeout(() => {
				clearPending();
				this.reportFailure(window, 'The window did not respond to the close request.');
			}, 30_000);
			window.webContents.send(WINDOW_PREPARE_CLOSE_CHANNEL, token);
		};
		const onRendererLoading = (): void => { state.ready = false; clearPending(); };
		window.on('close', onClose);
		window.webContents.on('did-start-loading', onRendererLoading);
		window.webContents.on('render-process-gone', onRendererLoading);
		this.windowRegistrations.set(window, toDisposable(() => {
			clearPending();
			this.closeStates.delete(window);
			window.off('close', onClose);
			if (!window.isDestroyed()) {
				window.webContents.off('did-start-loading', onRendererLoading);
				window.webContents.off('render-process-gone', onRendererLoading);
			}
		}));
		return toDisposable(() => this.windowRegistrations.deleteAndDispose(window));
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
		state.pendingToken = undefined;
		if (response.kind === 'complete') {
			state.authorized = true;
			window.close();
		} else if (response.kind === 'vetoed') {
			this.reportCloseVeto(window);
		} else {
			this.reportFailure(window, response.message);
		}
	}

	private reportFailure(window: TWindow, message: string): void {
		void Promise.resolve(this.reportCloseFailure(window, message)).catch(error => console.error('Failed to report window close error', error));
	}
}

export function windowCloseResponseIpcRoute<TWindow extends ILifecycleWindow>(service: LifecycleMainService<TWindow>, window: TWindow): IpcRoute<unknown, unknown> {
	return {
		channel: WINDOW_CLOSE_RESPONSE_CHANNEL,
		validate: validateWindowCloseResponse,
		invoke: response => service.respondToClose(window, response as WindowCloseResponse),
	};
}
