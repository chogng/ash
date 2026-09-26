import assert from 'node:assert/strict';
import { test } from 'mocha';
import { toDisposable } from '../../../../base/common/lifecycle.js';
import { DedicatedWindowHost, type IDedicatedWindowOpenOptions } from '../../electron-main/dedicatedWindowHost.js';
import { WindowMode } from '../../../window/electron-main/window.js';

class TestWindow {
	private readonly listeners = new Map<string, Set<() => void>>();
	public readonly webContents = {
		once: (_event: 'render-process-gone', listener: () => void): void => { this.rendererGone = listener; },
	};
	private rendererGone: (() => void) | undefined;
	private destroyed = false;
	public minimized = false;
	public focused = 0;
	public restored = 0;
	public shown = 0;
	public closed = 0;
	public deferClose = false;
	public maximized = 0;
	public fullscreen = false;

	public once(event: 'ready-to-show' | 'closed', listener: () => void): this {
		let listeners = this.listeners.get(event);
		if (!listeners) {
			listeners = new Set();
			this.listeners.set(event, listeners);
		}
		listeners.add(listener);
		return this;
	}

	public emit(event: 'ready-to-show' | 'closed'): void {
		const listeners = this.listeners.get(event);
		this.listeners.delete(event);
		for (const listener of listeners ?? []) listener();
	}

	public isDestroyed(): boolean { return this.destroyed; }
	public isMinimized(): boolean { return this.minimized; }
	public restore(): void { this.minimized = false; this.restored += 1; }
	public focus(): void { this.focused += 1; }
	public show(): void { this.shown += 1; }
	public maximize(): void { this.maximized += 1; }
	public setFullScreen(fullscreen: boolean): void { this.fullscreen = fullscreen; }
	public crashRenderer(): void { this.rendererGone?.(); }
	public close(): void { this.closed += 1; if (!this.deferClose) this.destroy(); }
	public destroy(): void { this.destroyed = true; this.emit('closed'); }
}

test('dedicated window host reuses a live child and releases each child with its window', async () => {
	const windows: TestWindow[] = [];
	let parentFocuses = 0;
	let released = 0;
	const host = new DedicatedWindowHost(
		() => { const window = new TestWindow(); windows.push(window); return window; },
		() => { parentFocuses += 1; },
	);
	const options: IDedicatedWindowOpenOptions<TestWindow> = {
		title: 'Sessions',
		state: { mode: WindowMode.Normal, width: 1180, height: 780 },
		webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: '', additionalArguments: [] },
		initialize: async (_window, resources) => {
			resources.add(toDisposable(() => { released += 1; }));
		},
	};
	try {
		assert.equal(host.currentWindow, undefined);
		await host.open(options);
		const first = windows[0]!;
		assert.equal(host.currentWindow, first);
		first.emit('ready-to-show');
		first.minimized = true;
		await host.open(options);
		assert.deepEqual({ created: windows.length, shown: first.shown, restored: first.restored, focused: first.focused }, { created: 1, shown: 1, restored: 1, focused: 1 });

		await host.returnToParent(first);
		assert.equal(host.currentWindow, undefined);
		assert.deepEqual({ parentFocuses, closed: first.closed, released }, { parentFocuses: 1, closed: 1, released: 1 });

		await host.open(options);
		assert.equal(windows.length, 2);
		await assert.rejects(host.returnToParent(first), /no longer active/);
	} finally {
		host.dispose();
	}
	assert.deepEqual({ destroyed: windows[1]?.isDestroyed(), released }, { destroyed: true, released: 2 });
});

test('dedicated window return waits for close before focusing its parent', async () => {
	const window = new TestWindow();
	window.deferClose = true;
	let parentFocuses = 0;
	using host = new DedicatedWindowHost(() => window, () => { parentFocuses += 1; });
	await host.open({
		title: 'Sessions',
		state: { mode: WindowMode.Normal, width: 1180, height: 780 },
		webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: '', additionalArguments: [] },
		initialize: async () => {},
	});
	const returning = host.returnToParent(window);
	assert.deepEqual({ closeRequests: window.closed, parentFocuses }, { closeRequests: 1, parentFocuses: 0 });
	window.destroy();
	await returning;
	assert.equal(parentFocuses, 1);
});

test('dedicated window host waits for a closing child before reopening', async () => {
	const windows: TestWindow[] = [];
	using host = new DedicatedWindowHost(() => {
		const window = new TestWindow();
		windows.push(window);
		return window;
	}, () => {});
	const options: IDedicatedWindowOpenOptions<TestWindow> = {
		title: 'Sessions',
		state: { mode: WindowMode.Normal, width: 1180, height: 780 },
		webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: '', additionalArguments: [] },
		initialize: async () => {},
	};
	await host.open(options);
	const first = windows[0]!;
	first.deferClose = true;
	const closing = host.close();
	const reopening = host.open(options);
	assert.deepEqual({ created: windows.length, closeRequested: first.closed }, { created: 1, closeRequested: 1 });
	first.destroy();
	await closing;
	await reopening;
	assert.equal(windows.length, 2);
});

test('a failed close releases the pending return and allows a later close', async () => {
	const window = new TestWindow();
	window.deferClose = true;
	let parentFocuses = 0;
	using host = new DedicatedWindowHost(() => window, () => { parentFocuses += 1; });
	await host.open({
		title: 'Sessions',
		state: { mode: WindowMode.Normal, width: 1180, height: 780 },
		webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: '', additionalArguments: [] },
		initialize: async () => {},
	});
	const returning = host.returnToParent(window);
	host.failClose(window, 'Save failed');
	await assert.rejects(returning, /Save failed/);
	assert.equal(parentFocuses, 0);
	assert.equal(host.currentWindow, window);
	const retry = host.returnToParent(window);
	window.destroy();
	await retry;
	assert.deepEqual({ closeRequests: window.closed, parentFocuses }, { closeRequests: 2, parentFocuses: 1 });
});

test('dedicated window host destroys a child when initialization fails', async () => {
	const window = new TestWindow();
	let released = false;
	using host = new DedicatedWindowHost(() => window, () => {});
	await assert.rejects(host.open({
		title: 'Sessions',
		state: { mode: WindowMode.Normal, width: 1180, height: 780 },
		webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: '', additionalArguments: [] },
		initialize: async (_window, resources) => {
			resources.add(toDisposable(() => { released = true; }));
			throw new Error('load failed');
		},
	}), /load failed/);
	assert.deepEqual({ destroyed: window.isDestroyed(), released }, { destroyed: true, released: true });
});

test('dedicated window host replaces a crashed renderer on the next open', async () => {
	const windows: TestWindow[] = [];
	using host = new DedicatedWindowHost(() => {
		const window = new TestWindow();
		windows.push(window);
		return window;
	}, () => {});
	const options: IDedicatedWindowOpenOptions<TestWindow> = {
		title: 'Sessions',
		state: { mode: WindowMode.Maximized, x: 80, y: 60, width: 1180, height: 780 },
		webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: '', additionalArguments: [] },
		initialize: async () => {},
	};
	await host.open(options);
	windows[0]!.emit('ready-to-show');
	assert.equal(windows[0]!.maximized, 1);
	windows[0]!.crashRenderer();
	assert.equal(host.currentWindow, undefined);
	await host.open(options);
	assert.equal(windows.length, 2);
});
