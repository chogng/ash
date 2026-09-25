import { Disposable, DisposableStore, MutableDisposable } from '../../../base/common/lifecycle.js';
import { resolveBrowserWindowOptions, type IWindowConstructorOptions, type IWindowWebPreferences } from './windows.js';
import { WindowMode } from '../../window/electron-main/window.js';

interface IDedicatedWindow {
	once(event: 'ready-to-show' | 'closed', listener: () => void): this;
	isDestroyed(): boolean;
	isMinimized(): boolean;
	restore(): void;
	focus(): void;
	show(): void;
	close(): void;
	destroy(): void;
}

interface IDedicatedWindowConstructorOptions extends IWindowConstructorOptions {
	readonly title: string;
	readonly icon?: string;
}

export interface IDedicatedWindowOpenOptions<T extends IDedicatedWindow> {
	readonly title: string;
	readonly icon?: string;
	readonly width: number;
	readonly height: number;
	readonly webPreferences: IWindowWebPreferences;
	readonly initialize: (window: T, resources: DisposableStore) => Promise<void>;
}

/** Owns one dedicated renderer window and its resources for one parent window. */
export class DedicatedWindowHost<T extends IDedicatedWindow> extends Disposable {
	private readonly childResources = this._register(new MutableDisposable<DisposableStore>());
	private window: T | undefined;
	private opening: Promise<void> | undefined;
	private closing: Promise<void> | undefined;
	private rejectClosing: ((error: Error) => void) | undefined;

	public get currentWindow(): T | undefined {
		return this.window && !this.window.isDestroyed() ? this.window : undefined;
	}

	constructor(
		private readonly createWindow: (options: IDedicatedWindowConstructorOptions) => T,
		private readonly focusParent: () => void,
	) {
		super();
	}

	public async open(options: IDedicatedWindowOpenOptions<T>): Promise<void> {
		this.assertNotDisposed();
		// Keep the old child's routes and resources until Electron reports it closed.
		if (this.closing) await this.closing;
		this.assertNotDisposed();
		const existing = this.window;
		if (existing && !existing.isDestroyed()) {
			if (existing.isMinimized()) existing.restore();
			existing.focus();
			await this.opening;
			return;
		}

		const window = this.createWindow({
			...resolveBrowserWindowOptions({
				state: { mode: WindowMode.Normal, width: options.width, height: options.height },
				webPreferences: options.webPreferences,
			}),
			show: false,
			title: options.title,
			icon: options.icon,
		});
		const resources = new DisposableStore();
		this.childResources.value = resources;
		this.window = window;
		window.once('ready-to-show', () => {
			if (this.window === window && !window.isDestroyed()) window.show();
		});
		window.once('closed', () => {
			if (this.window !== window) return;
			this.window = undefined;
			this.childResources.clear();
		});

		let opening: Promise<void> | undefined;
		try {
			opening = options.initialize(window, resources);
			this.opening = opening;
			await opening;
		} catch (error) {
			if (!window.isDestroyed()) window.destroy();
			throw error;
		} finally {
			if (this.opening === opening) this.opening = undefined;
		}
	}

	public async returnToParent(window: T): Promise<void> {
		if (this.window !== window) throw new Error('Dedicated window is no longer active');
		await this.close();
		this.focusParent();
	}

	public close(): Promise<void> {
		const window = this.currentWindow;
		if (!window) return Promise.resolve();
		if (this.closing) return this.closing;
		const closing = new Promise<void>((resolve, reject) => {
			this.rejectClosing = reject;
			window.once('closed', resolve);
		});
		this.closing = closing;
		const clearClosing = (): void => {
			if (this.closing === closing) {
				this.closing = undefined;
				this.rejectClosing = undefined;
			}
		};
		void closing.then(clearClosing, clearClosing);
		if (!window.isDestroyed()) window.close();
		return closing;
	}

	/** Releases a pending close after the renderer rejects its save join. */
	public failClose(window: T, message: string): void {
		if (this.window === window) this.rejectClosing?.(new Error(message));
	}

	protected override disposeCore(): void {
		const window = this.window;
		if (window && !window.isDestroyed()) window.destroy();
		this.window = undefined;
		super.disposeCore();
	}
}
