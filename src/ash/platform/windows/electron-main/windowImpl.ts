import { Disposable, toDisposable, type DisposableStore } from '../../../base/common/lifecycle.js';
import type { IWindowBounds, IWindowState } from '../../window/electron-main/window.js';
import type { TitleBarStyleConfiguration } from '../../window/common/window.js';
import { applyWindowState, resolveBrowserWindowOptions, type IWindowConstructorOptions, type IWindowWebPreferences } from './windows.js';
import { UNKNOWN_EMPTY_WINDOW_WORKSPACE, type IAnyWorkspaceIdentifier } from '../../workspace/common/workspace.js';

export interface IWindowCreationOptions {
	readonly workspace?: IAnyWorkspaceIdentifier;
	readonly state: IWindowState;
	readonly webPreferences: IWindowWebPreferences;
	readonly title: string;
	readonly titleBarStyle?: TitleBarStyleConfiguration;
	readonly backgroundColor?: string;
	readonly icon?: string;
	readonly tabbingIdentifier?: string;
}

export interface ICodeWindowHandle {
	readonly webContents: { once(event: 'render-process-gone', listener: () => void): unknown; };
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
	public openedWorkspace: IAnyWorkspaceIdentifier;

	constructor(
		createWindow: (options: IWindowConstructorOptions & Pick<IWindowCreationOptions, 'title' | 'icon' | 'tabbingIdentifier'>) => TWindow,
		options: IWindowCreationOptions,
		resources: DisposableStore,
	) {
		super();
		this.openedWorkspace = options.workspace ?? UNKNOWN_EMPTY_WINDOW_WORKSPACE;
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
			let requestedWidth = width;
			let requestedHeight = height;
			for (let attempt = 0; attempt < 4; attempt++) {
				window.setBounds({ x, y, width: requestedWidth, height: requestedHeight });
				const actual = window.getBounds();
				if (actual.width === width && actual.height === height) {
					break;
				}
				// Fractional DPI can map adjacent DIP requests to the same outer size.
				// Accumulate corrections across that plateau before placement is tracked;
				// bound attempts in case OS constraints make the saved size unreachable.
				requestedWidth -= actual.width - width;
				requestedHeight -= actual.height - height;
				if (requestedWidth <= 0 || requestedHeight <= 0) {
					break;
				}
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
