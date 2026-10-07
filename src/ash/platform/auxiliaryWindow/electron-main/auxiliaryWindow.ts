import type { BrowserWindow } from 'electron';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';

export interface IAuxiliaryWindow {
	readonly id: number;
	readonly parentId: number;
	readonly win: BrowserWindow;
	readonly lastFocusTime: number;
}

/** The renderer owns the document; Main owns the lifetime of its Electron window. */
export class AuxiliaryWindow extends Disposable implements IAuxiliaryWindow {
	public readonly id: number;
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
		this._register(toDisposable(() => win.off('focus', handleFocus)));
		this._register(toDisposable(() => {
			if (!win.isDestroyed()) {
				win.destroy();
			}
		}));
	}
}
