import assert from 'node:assert/strict';
import { test } from 'mocha';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { WindowMode, type IWindowBounds } from '../../../window/electron-main/window.js';
import { CodeWindow, type ICodeWindowHandle } from '../../electron-main/windowImpl.js';

class TestWindow implements ICodeWindowHandle {
	private readonly listeners = new Map<string, () => void>();
	public readonly webContents = {
		once: (event: 'render-process-gone', listener: () => void): void => { this.listeners.set(event, listener); },
	};
	public destroyed = false;
	public shown = 0;
	public maximized = 0;
	public fullscreen = false;
	public bounds: IWindowBounds = { x: 0, y: 0, width: 800, height: 600 };
	public frameRounding = { width: 0, height: 0 };

	public once(event: 'ready-to-show' | 'closed', listener: () => void): this {
		this.listeners.set(event, listener);
		return this;
	}

	public emit(event: 'ready-to-show' | 'closed' | 'render-process-gone'): void {
		this.listeners.get(event)?.();
	}

	public isDestroyed(): boolean { return this.destroyed; }
	public show(): void { this.shown++; }
	public getBounds(): IWindowBounds { return this.bounds; }
	public setBounds(bounds: IWindowBounds): void { this.bounds = { ...bounds, width: bounds.width + this.frameRounding.width, height: bounds.height + this.frameRounding.height }; }
	public maximize(): void { this.maximized++; }
	public setFullScreen(fullscreen: boolean): void { this.fullscreen = fullscreen; }
	public destroy(): void {
		if (this.destroyed) return;
		this.destroyed = true;
		this.emit('closed');
	}
}

test('CodeWindow applies Windows startup bounds before tracking and showing every window mode', () => {
	for (const mode of [WindowMode.Normal, WindowMode.Maximized, WindowMode.Fullscreen]) {
		const bounds = { x: -1600, y: 80, width: 1440, height: 900 };
		const window = new TestWindow();
		window.frameRounding = { width: 2, height: 1 };
		const constructorBounds = window.bounds;
		using host = new CodeWindow(() => window, {
			state: { mode, ...bounds },
			webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: '', additionalArguments: [] },
			title: 'Workbench',
		}, new DisposableStore());
		assert.deepEqual({ bounds: host.win.bounds, shown: host.win.shown, maximized: host.win.maximized, fullscreen: host.win.fullscreen }, {
			bounds: process.platform === 'win32' ? bounds : constructorBounds, shown: 0, maximized: 0, fullscreen: false,
		});
		host.win.emit('ready-to-show');
		assert.deepEqual({ bounds: host.win.bounds, shown: host.win.shown, maximized: host.win.maximized, fullscreen: host.win.fullscreen }, {
			bounds: process.platform === 'win32' ? bounds : constructorBounds, shown: 1, maximized: mode === WindowMode.Maximized ? 1 : 0, fullscreen: mode === WindowMode.Fullscreen,
		});
	}
});

test('CodeWindow restores state when ready and releases resources when closed', () => {
	const resources = new DisposableStore();
	let released = 0;
	resources.add(toDisposable(() => { released++; }));
	const host = new CodeWindow(() => new TestWindow(), {
		state: { mode: WindowMode.Maximized, width: 1000, height: 700 },
		webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: '', additionalArguments: [] },
		title: 'Workbench',
	}, resources);
	const window = host.win;
	window.emit('ready-to-show');
	assert.deepEqual({ shown: window.shown, maximized: window.maximized }, { shown: 1, maximized: 1 });
	window.destroy();
	assert.deepEqual({ released, disposed: host.isDisposed }, { released: 1, disposed: true });
});

test('CodeWindow destroys a crashed renderer window and releases its resources', () => {
	const resources = new DisposableStore();
	let released = 0;
	resources.add(toDisposable(() => { released++; }));
	const host = new CodeWindow(() => new TestWindow(), {
		state: { mode: WindowMode.Normal, width: 1000, height: 700 },
		webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: '', additionalArguments: [] },
		title: 'Sessions',
	}, resources);
	host.win.emit('render-process-gone');
	assert.deepEqual({ destroyed: host.win.destroyed, released }, { destroyed: true, released: 1 });
});
