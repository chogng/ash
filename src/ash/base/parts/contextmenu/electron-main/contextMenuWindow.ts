import type { BrowserWindow, BrowserWindowConstructorOptions, HandlerDetails } from 'electron';
import { Disposable, DisposableMap, DisposableStore, toDisposable } from '../../../common/lifecycle.js';
import { isContextMenuWindowName } from '../common/contextmenu.js';

/** Owns non-modal menu windows without registering them as product/editor windows. */
export class ContextMenuWindow extends Disposable {
	private readonly windows = this._register(new DisposableMap<BrowserWindow, DisposableStore>());

	constructor(private readonly parent: BrowserWindow) {
		super();
		const close = (): void => this.windows.clearAndDisposeAll();
		parent.on('move', close);
		parent.on('resize', close);
		parent.on('hide', close);
		parent.on('minimize', close);
		parent.on('closed', close);
		this._register(toDisposable(() => {
			parent.off('move', close);
			parent.off('resize', close);
			parent.off('hide', close);
			parent.off('minimize', close);
			parent.off('closed', close);
		}));
		const webContents = parent.webContents;
		webContents.on('did-start-navigation', close);
		this._register(toDisposable(() => webContents.off('did-start-navigation', close)));
	}

	getWindowOpenOptions(details: HandlerDetails): BrowserWindowConstructorOptions | undefined {
		if (details.url !== 'about:blank' || !isContextMenuWindowName(details.frameName)) return undefined;
		const features = new URLSearchParams(details.features.replaceAll(',', '&'));
		const coordinate = (key: string, fallback: number): number => {
			const value = features.get(key);
			if (value === null) return fallback;
			const number = Number(value);
			if (!value.trim() || !Number.isSafeInteger(number) || Math.abs(number) > 1_000_000) throw new TypeError(`Invalid menu window ${key}`);
			return number;
		};
		const bounds = this.parent.getContentBounds();
		return {
			parent: this.parent,
			modal: false,
			frame: false,
			transparent: true,
			backgroundColor: '#00000000',
			hasShadow: false,
			show: true,
			resizable: false,
			movable: false,
			minimizable: false,
			maximizable: false,
			fullscreenable: false,
			skipTaskbar: true,
			roundedCorners: false,
			x: coordinate('x', bounds.x),
			y: coordinate('y', bounds.y),
			width: 480,
			height: Math.min(720, bounds.height),
			minWidth: 1,
			minHeight: 1,
			webPreferences: {
				sandbox: true,
				contextIsolation: true,
				nodeIntegration: false,
				zoomFactor: 1,
			},
		};
	}

	registerWindow(window: BrowserWindow): void {
		const lifetime = new DisposableStore();
		this.windows.set(window, lifetime);
		lifetime.add(toDisposable(() => { if (!window.isDestroyed()) window.close(); }));
		const closed = (): void => { this.windows.deleteAndDispose(window); };
		window.once('closed', closed);
		lifetime.add(toDisposable(() => window.off('closed', closed)));
		const webContents = window.webContents;
		const preventNavigation = (event: Electron.Event): void => event.preventDefault();
		webContents.on('will-navigate', preventNavigation);
		lifetime.add(toDisposable(() => webContents.off('will-navigate', preventNavigation)));
		webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
		window.setMenu(null);
	}
}
