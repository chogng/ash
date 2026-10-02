import { Disposable, toDisposable, type DisposableStore } from '../../../base/common/lifecycle.js';
import type { IWindowBounds, IWindowState } from '../../window/electron-main/window.js';
import type { TitleBarStyleConfiguration } from '../../window/common/window.js';
import { applyWindowState, resolveBrowserWindowOptions, type IWindowConstructorOptions, type IWindowWebPreferences } from './windows.js';

export interface IWindowCreationOptions {
	readonly state: IWindowState;
	readonly webPreferences: IWindowWebPreferences;
	readonly title: string;
	readonly titleBarStyle?: TitleBarStyleConfiguration;
	readonly backgroundColor?: string;
	readonly icon?: string;
	readonly tabbingIdentifier?: string;
}

export interface ICodeWindowHandle {
	readonly webContents: { once(event: 'render-process-gone', listener: () => void): unknown };
	once(event: 'ready-to-show' | 'closed', listener: () => void): this;
	isDestroyed(): boolean;
	show(): void;
	getBounds(): IWindowBounds;
	setBounds(bounds: IWindowBounds): void;
	maximize(): void;
	setFullScreen(fullscreen: boolean): void;
	destroy(): void;
}

/** Owns one Electron window and all resources that end with it. */
export class CodeWindow<TWindow extends ICodeWindowHandle> extends Disposable {
	public readonly win: TWindow;
	public readonly resources: DisposableStore;

	constructor(
		createWindow: (options: IWindowConstructorOptions & Pick<IWindowCreationOptions, 'title' | 'icon' | 'tabbingIdentifier'>) => TWindow,
		options: IWindowCreationOptions,
		resources: DisposableStore,
	) {
		super();
		this.resources = this._register(resources);
		try {
			this.win = createWindow({
				...resolveBrowserWindowOptions({ state: options.state, webPreferences: options.webPreferences, titleBarStyle: options.titleBarStyle, backgroundColor: options.backgroundColor }),
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
		this._register(toDisposable(() => {
			if (!window.isDestroyed()) window.destroy();
		}));
		const { x, y, width, height } = options.state;
		if (process.platform === 'win32' && x !== undefined && y !== undefined) {
			// Windows may size the constructor frame using the primary display's DPI.
			// Apply the outer DIP rectangle on the created window's display before
			// placement tracking captures it or maximize/fullscreen changes its mode.
			window.setBounds({ x, y, width, height });
			const actual = window.getBounds();
			if (actual.width !== width || actual.height !== height) {
				// Fractional DPI can round the Windows frame outward. Read back its
				// size to remove that difference instead of saving it on every restart.
				window.setBounds({ x, y, width: width - (actual.width - width), height: height - (actual.height - height) });
			}
		}
		window.once('ready-to-show', () => {
			if (window.isDestroyed()) return;
			applyWindowState(window, options.state);
			window.show();
		});
		window.webContents.once('render-process-gone', () => {
			if (!window.isDestroyed()) window.destroy();
		});
		window.once('closed', () => this.dispose());
	}
}
