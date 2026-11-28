import type { BrowserWindow, BrowserWindowConstructorOptions, HandlerDetails } from 'electron';
import { Disposable, DisposableMap, DisposableStore, MutableDisposable, toDisposable, type IDisposable } from '../../../common/lifecycle.js';
import { isContextMenuWindowName, type IContextMenuWindowPresentation } from '../common/contextmenu.js';

/** Owns non-modal menu windows without registering them as product/editor windows. */
export class ContextMenuWindow extends Disposable {
	private readonly windows = this._register(new DisposableMap<BrowserWindow, DisposableStore>());

	constructor(
		private readonly parent: BrowserWindow,
		/** Enqueues native activation after the focus callback and returns its cancellation handle. */
		private readonly scheduleParentActivation: (parent: BrowserWindow) => IDisposable,
		private readonly getFocusedWindow: () => BrowserWindow | null,
	) {
		super();
		const close = (): void => this.windows.clearAndDisposeAll();
		const closePending = (): void => {
			for (const window of this.windows.keys()) {
				if (!window.isDestroyed() && !window.isVisible()) this.windows.deleteAndDispose(window);
			}
		};
		// A delayed presentation must not steal focus after the owner is left.
		// A shown menu transfers focus itself, so only cancel windows still hidden.
		parent.on('blur', closePending);
		parent.on('move', close);
		parent.on('resize', close);
		parent.on('hide', close);
		parent.on('minimize', close);
		parent.on('closed', close);
		this._register(toDisposable(() => {
			parent.off('blur', closePending);
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
		const bounds = this.parent.getContentBounds();
		return {
			parent: this.parent,
			modal: false,
			frame: false,
			transparent: true,
			backgroundColor: '#00000000',
			hasShadow: false,
			show: false,
			resizable: false,
			movable: false,
			minimizable: false,
			maximizable: false,
			fullscreenable: false,
			skipTaskbar: true,
			roundedCorners: false,
			// Keep initial DOM measurement on the source display. Final bounds arrive after styling.
			x: bounds.x,
			y: bounds.y,
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

	present(request: IContextMenuWindowPresentation): boolean {
		if (this.isDisposed || this.parent.isDestroyed()) return false;
		// Auxiliary workbenches use their root's trusted IPC routes. Follow the native
		// ownership tree rather than accepting a global BrowserWindow id.
		const find = (parent: BrowserWindow): BrowserWindow | undefined => {
			for (const child of parent.getChildWindows()) {
				if (child.isDestroyed()) continue;
				if (child.webContents.mainFrame.name === request.windowName) return child;
				const descendant = find(child);
				if (descendant) return descendant;
			}
			return undefined;
		};
		const window = find(this.parent);
		if (!window) return false;
		const visible = window.isVisible();
		// Native focus can already have moved while the owner's blur event is queued.
		const focused = this.getFocusedWindow();
		if (!visible && focused && focused !== window.getParentWindow()) {
			window.close();
			return false;
		}
		window.setBounds(request.bounds);
		if (!visible) window.show();
		return true;
	}

	registerWindow(window: BrowserWindow): void {
		const lifetime = new DisposableStore();
		this.windows.set(window, lifetime);
		lifetime.add(toDisposable(() => { if (!window.isDestroyed()) window.close(); }));
		const closed = (): void => { this.windows.deleteAndDispose(window); };
		window.once('closed', closed);
		lifetime.add(toDisposable(() => window.off('closed', closed)));
		const webContents = window.webContents;
		const pendingActivation = lifetime.add(new MutableDisposable<IDisposable>());
		const cancelActivation = (): void => pendingActivation.clear();
		const scheduleActivation = (): void => {
			pendingActivation.clear();
			if (!window.isDestroyed() && !this.parent.isDestroyed() && window.isFocused()) pendingActivation.value = this.scheduleParentActivation(this.parent);
		};
		window.on('focus', scheduleActivation);
		window.on('blur', cancelActivation);
		this.parent.on('close', cancelActivation);
		lifetime.add(toDisposable(() => {
			window.off('focus', scheduleActivation);
			window.off('blur', cancelActivation);
			this.parent.off('close', cancelActivation);
		}));
		const preventNavigation = (event: Electron.Event): void => event.preventDefault();
		webContents.on('will-navigate', preventNavigation);
		lifetime.add(toDisposable(() => webContents.off('will-navigate', preventNavigation)));
		webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
		window.setMenu(null);
	}
}
