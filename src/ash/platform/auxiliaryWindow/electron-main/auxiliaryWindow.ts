import type { EventEmitter as NodeEventEmitter } from 'node:events';
import type { BrowserWindow } from 'electron';
import { Emitter } from '../../../base/common/event.js';
import type { IAuxiliaryWindowState } from '../../window/common/window.js';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';

export interface IAuxiliaryWindow {
	readonly id: number;
	readonly parentId: number;
	readonly win: BrowserWindow;
	readonly lastFocusTime: number;
	getState(): IAuxiliaryWindowState;
}

/** The renderer owns the document; Main owns the lifetime of its Electron window. */
export class AuxiliaryWindow extends Disposable implements IAuxiliaryWindow {
	public readonly id: number;
	private readonly stateChanged = this._register(new Emitter<void>());
	readonly onDidChangeState = this.stateChanged.event;
	// Main and auxiliary windows compare focus times on the same process clock.
	private _lastFocusTime = performance.now();

	public get lastFocusTime(): number {
		return this._lastFocusTime;
	}

	constructor(public readonly win: BrowserWindow, public readonly parentId: number) {
		super();
		this.id = win.id;
		const handleFocus = (): void => { this._lastFocusTime = performance.now(); };
		win.on('focus', handleFocus);
		const events: NodeEventEmitter = win;
		for (const event of ['move', 'resize', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'always-on-top-changed'] as const) {
			const changed = (): void => this.stateChanged.fire();
			events.on(event, changed);
			this._register(toDisposable(() => events.off(event, changed)));
		}
		const webContents = win.webContents;
		const zoomChanged = (): void => { setImmediate(() => { if (!this.isDisposed && !win.isDestroyed()) this.stateChanged.fire(); }); };
		webContents.on('zoom-changed', zoomChanged);
		this._register(toDisposable(() => { if (!webContents.isDestroyed()) webContents.off('zoom-changed', zoomChanged); }));
		this._register(toDisposable(() => win.off('focus', handleFocus)));
		this._register(toDisposable(() => {
			if (!win.isDestroyed()) {
				win.destroy();
			}
		}));
	}
	getState(): IAuxiliaryWindowState {
		const bounds = this.win.getNormalBounds();
		return {
			width: bounds.width, height: bounds.height, left: bounds.x, top: bounds.y,
			zoomLevel: this.win.webContents.getZoomLevel(), alwaysOnTop: this.win.isAlwaysOnTop(),
			mode: this.win.isFullScreen() ? 'fullscreen' : this.win.isMaximized() ? 'maximized' : 'normal'
		};
	}

}
