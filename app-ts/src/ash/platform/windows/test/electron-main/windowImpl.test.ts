import assert from 'node:assert/strict';
import { test } from 'mocha';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { WindowMode } from '../../../window/electron-main/window.js';
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

	public once(event: 'ready-to-show' | 'closed', listener: () => void): this {
		this.listeners.set(event, listener);
		return this;
	}

	public emit(event: 'ready-to-show' | 'closed' | 'render-process-gone'): void {
		this.listeners.get(event)?.();
	}

	public isDestroyed(): boolean { return this.destroyed; }
	public show(): void { this.shown++; }
	public maximize(): void { this.maximized++; }
	public setFullScreen(fullscreen: boolean): void { this.fullscreen = fullscreen; }
	public destroy(): void {
		if (this.destroyed) return;
		this.destroyed = true;
		this.emit('closed');
	}
}

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
