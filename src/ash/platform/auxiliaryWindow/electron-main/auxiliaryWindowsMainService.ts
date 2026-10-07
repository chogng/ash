import type { BrowserWindow, BrowserWindowConstructorOptions, HandlerDetails, WebContents } from 'electron';
import { Disposable, DisposableMap, DisposableStore, toDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
import { AuxiliaryWindow, type IAuxiliaryWindow } from './auxiliaryWindow.js';
import type { IAuxiliaryWindowsMainService } from './auxiliaryWindows.js';

export class AuxiliaryWindowsMainService extends Disposable implements IAuxiliaryWindowsMainService {
	private readonly windows = this._register(new DisposableMap<number, AuxiliaryWindow>());
	private readonly listeners = this._register(new DisposableMap<number, DisposableStore>());

	constructor(private readonly resolveWindow: (webContents: WebContents) => BrowserWindow | null) {
		super();
	}

	public createWindow(details: HandlerDetails): BrowserWindowConstructorOptions {
		this.assertNotDisposed();
		if (details.url !== 'about:blank') {
			throw new TypeError('Auxiliary windows require an empty same-origin document');
		}
		const features = new URLSearchParams(details.features.replaceAll(',', '&'));
		const options: BrowserWindowConstructorOptions = {};
		for (const key of ['x', 'y', 'left', 'top', 'width', 'height'] as const) {
			const value = features.get(key);
			if (value === null) {
				continue;
			}
			const number = Number(value);
			if (value.trim() === '' || !Number.isSafeInteger(number) || ((key === 'width' || key === 'height') && number <= 0)) {
				throw new TypeError(`Invalid auxiliary window ${key}`);
			}
			if (key === 'left') {
				options.x = number;
			} else if (key === 'top') {
				options.y = number;
			} else {
				options[key] = number;
			}
		}
		return options;
	}

	public registerWindow(webContents: WebContents, parentId: number): IDisposable {
		this.assertNotDisposed();
		const window = this.resolveWindow(webContents);
		if (!window || window.isDestroyed()) {
			throw new Error('Auxiliary window closed before registration');
		}
		if (this.windows.has(window.id)) {
			throw new Error(`Auxiliary window ${window.id} is already registered`);
		}
		const parent = this.windows.get(parentId);
		const auxiliary = this.windows.set(window.id, new AuxiliaryWindow(window, parent?.parentId ?? parentId));
		const resources = this.listeners.set(window.id, new DisposableStore());
		const release = (): void => {
			if (this.windows.get(window.id) !== auxiliary) {
				return;
			}
			// Detach the close listener before forced destruction emits another close.
			this.listeners.deleteAndDispose(window.id);
			this.windows.deleteAndDispose(window.id);
		};
		window.on('closed', release);
		resources.add(toDisposable(() => window.off('closed', release)));
		webContents.on('render-process-gone', release);
		resources.add(toDisposable(() => {
			if (!webContents.isDestroyed()) {
				webContents.off('render-process-gone', release);
			}
		}));
		return toDisposable(release);
	}

	public getWindowByWebContents(webContents: WebContents): IAuxiliaryWindow | undefined {
		return this.getWindows().find(window => window.win.webContents === webContents);
	}

	public getFocusedWindow(): IAuxiliaryWindow | undefined {
		return this.getWindows().find(window => window.win.isFocused());
	}

	public getLastActiveWindow(): IAuxiliaryWindow | undefined {
		let lastActive: IAuxiliaryWindow | undefined;
		for (const window of this.getWindows()) {
			if (!lastActive || window.lastFocusTime > lastActive.lastFocusTime) {
				lastActive = window;
			}
		}
		return lastActive;
	}

	public getWindows(): readonly IAuxiliaryWindow[] {
		return [...this.windows].map(([, window]) => window).filter(window => !window.win.isDestroyed());
	}
}
