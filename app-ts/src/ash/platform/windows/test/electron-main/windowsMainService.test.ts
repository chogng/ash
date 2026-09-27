import assert from 'node:assert/strict';
import { test } from 'mocha';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { WINDOW_FULLSCREEN_CHANGED_CHANNEL, WINDOW_OPERATION_CHANNEL, WINDOW_PREPARE_CLOSE_CHANNEL, WINDOW_ZOOM_CHANGED_CHANNEL } from '../../../window/common/window.js';
import { LifecycleMainService } from '../../../lifecycle/electron-main/lifecycleMainService.js';
import { WindowMode } from '../../../window/electron-main/window.js';
import { WindowsMainService, windowOperationIpcRoute, type IWorkbenchWindow } from '../../electron-main/windowsMainService.js';

class TestWindow implements IWorkbenchWindow<TestWindow> {
	public readonly calls: string[] = [];
	public readonly messages: { readonly channel: string; readonly level: number | boolean }[] = [];
	private readonly zoomListeners = new Set<() => void>();
	private readonly closeListeners = new Set<(event: { preventDefault(): void }) => void>();
	private readonly fullscreenListeners = new Map<string, Set<() => void>>();
	private readonly rendererListeners = new Map<string, Set<() => void>>();
	private readonly onceListeners = new Map<string, Set<() => void>>();
	public readonly webContents = {
		getZoomLevel: (): number => this.zoomLevel,
		getZoomFactor: (): number => 1.2 ** this.zoomLevel,
		setZoomLevel: (level: number): void => { this.zoomLevel = level; },
		on: (event: 'zoom-changed' | 'did-start-loading' | 'render-process-gone', listener: () => void): void => { const listeners = event === 'zoom-changed' ? this.zoomListeners : this.rendererListeners.get(event) ?? new Set<() => void>(); listeners.add(listener); if (event !== 'zoom-changed') this.rendererListeners.set(event, listeners); },
		off: (event: 'zoom-changed' | 'did-start-loading' | 'render-process-gone', listener: () => void): void => { if (this.destroyed) throw new Error('Object has been destroyed'); (event === 'zoom-changed' ? this.zoomListeners : this.rendererListeners.get(event))?.delete(listener); },
		send: (channel: string, level: number | boolean): void => { this.messages.push({ channel, level }); },
		once: (event: 'render-process-gone', listener: () => void): void => { const listeners = this.rendererListeners.get(event) ?? new Set<() => void>(); listeners.add(listener); this.rendererListeners.set(event, listeners); },
	};
	public destroyed = false;
	public minimized = false;
	public focused = false;
	public zoomLevel = 0;
	public alwaysOnTop = false;
	public fullscreen = false;
	public shown = 0;
	public maximized = 0;
	public deferClose = false;

	constructor(public readonly id: number, private readonly title: string) {}
	public once(event: 'ready-to-show' | 'closed', listener: () => void): this {
		const listeners = this.onceListeners.get(event) ?? new Set<() => void>();
		listeners.add(listener);
		this.onceListeners.set(event, listeners);
		return this;
	}
	public emit(event: 'ready-to-show' | 'closed'): void {
		const listeners = this.onceListeners.get(event);
		this.onceListeners.delete(event);
		for (const listener of listeners ?? []) listener();
	}
	public on(event: 'close', listener: (event: { preventDefault(): void }) => void): void;
	public on(event: 'enter-full-screen' | 'leave-full-screen', listener: () => void): void;
	public on(event: 'close' | 'enter-full-screen' | 'leave-full-screen', listener: ((event: { preventDefault(): void }) => void) | (() => void)): void {
		if (event === 'close') this.closeListeners.add(listener as (event: { preventDefault(): void }) => void);
		else { const listeners = this.fullscreenListeners.get(event) ?? new Set<() => void>(); listeners.add(listener as () => void); this.fullscreenListeners.set(event, listeners); }
	}
	public off(event: 'close', listener: (event: { preventDefault(): void }) => void): void;
	public off(event: 'enter-full-screen' | 'leave-full-screen', listener: () => void): void;
	public off(event: 'close' | 'enter-full-screen' | 'leave-full-screen', listener: ((event: { preventDefault(): void }) => void) | (() => void)): void {
		if (event === 'close') this.closeListeners.delete(listener as (event: { preventDefault(): void }) => void);
		else this.fullscreenListeners.get(event)?.delete(listener as () => void);
	}

	public isDestroyed(): boolean { return this.destroyed; }
	public isMinimized(): boolean { return this.minimized; }
	public restore(): void { this.minimized = false; this.calls.push('restore'); }
	public focus(): void { this.focused = true; this.calls.push('focus'); }
	public getTitle(): string { return this.title; }
	public isFocused(): boolean { return this.focused; }
	public isFullScreen(): boolean { return this.fullscreen; }
	public close(): void { this.calls.push('close'); let prevented = false; for (const listener of this.closeListeners) listener({ preventDefault: () => { prevented = true; } }); if (!prevented && !this.deferClose) this.destroy(); }
	public show(): void { this.shown++; }
	public maximize(): void { this.maximized++; }
	public setFullScreen(fullscreen: boolean): void { this.fullscreen = fullscreen; }
	public destroy(): void { if (this.destroyed) return; this.destroyed = true; this.emit('closed'); }
	public isAlwaysOnTop(): boolean { return this.alwaysOnTop; }
	public setAlwaysOnTop(enabled: boolean): void { this.alwaysOnTop = enabled; }
	public selectNextTab(): void { this.calls.push('next'); }
	public selectPreviousTab(): void { this.calls.push('previous'); }
	public moveTabToNewWindow(): void { this.calls.push('newWindow'); }
	public mergeAllWindows(): void { this.calls.push('merge'); }
	public toggleTabBar(): void { this.calls.push('toggleBar'); }
	public addTabbedWindow(window: TestWindow): void { this.calls.push(`tab:${window.id}`); }
	public emitZoomChanged(): void { for (const listener of this.zoomListeners) listener(); }
	public emitFullscreenChanged(fullscreen: boolean): void { this.fullscreen = fullscreen; for (const listener of this.fullscreenListeners.get(fullscreen ? 'enter-full-screen' : 'leave-full-screen') ?? []) listener(); }
	public emitRendererEvent(event: 'did-start-loading' | 'render-process-gone'): void { for (const listener of this.rendererListeners.get(event) ?? []) listener(); }
}

test('WindowsMainService lists, focuses, and closes only live Workbench windows', () => {
	const first = new TestWindow(1, 'First');
	const second = new TestWindow(2, 'Second');
	second.minimized = true;
	const service = new WindowsMainService(() => [first, second], async () => undefined, 'win32');

	assert.deepEqual(service.perform(first, { kind: 'list' }), [
		{ id: 1, title: 'First', focused: false },
		{ id: 2, title: 'Second', focused: false },
	]);
	first.minimized = true;
	service.perform(first, { kind: 'focusSelf' });
	assert.deepEqual(first.calls, ['restore', 'focus']);
	service.perform(first, { kind: 'focus', windowId: 2 });
	assert.deepEqual(second.calls, ['restore', 'focus']);
	assert.throws(() => service.perform(first, { kind: 'focus', windowId: 3 }), /Workbench window is closed/);
	service.perform(first, { kind: 'closeOthers' });
	assert.deepEqual({ first: first.calls, second: second.calls }, {
		first: ['restore', 'focus'],
		second: ['restore', 'focus', 'close'],
	});
	assert.deepEqual(service.perform(first, { kind: 'list' }), [{ id: 1, title: 'First', focused: true }]);
	assert.throws(() => service.perform(second, { kind: 'getZoom' }), /Workbench window is closed/);
	service.perform(first, { kind: 'close' });
	assert.deepEqual(first.calls, ['restore', 'focus', 'close']);
});

test('WindowsMainService owns Workbench window resources through close and app disposal', () => {
	const service = new WindowsMainService<TestWindow>(() => [], async () => undefined);
	const resources = new DisposableStore();
	let released = 0;
	resources.add(toDisposable(() => { released++; }));
	const host = service.createWindow(options => new TestWindow(1, options.title), {
		title: 'Workbench',
		state: { mode: WindowMode.Normal, width: 1000, height: 700 },
		webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: '', additionalArguments: [] },
	}, resources);
	host.win.destroy();
	assert.equal(released, 1);
	const nextResources = new DisposableStore();
	nextResources.add(toDisposable(() => { released++; }));
	const next = service.createWindow(options => new TestWindow(2, options.title), {
		title: 'Workbench',
		state: { mode: WindowMode.Normal, width: 1000, height: 700 },
		webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: '', additionalArguments: [] },
	}, nextResources);
	service.dispose();
	assert.deepEqual({ destroyed: next.win.isDestroyed(), released }, { destroyed: true, released: 2 });
});

test('WindowsMainService tracks auxiliary windows and releases them with their parent', () => {
	const parent = new TestWindow(1, 'Workbench');
	const child = new TestWindow(2, 'Editor');
	using service = new WindowsMainService(() => [parent], async () => undefined);
	const registration = service.registerAuxiliaryWindow(child);
	assert.deepEqual(service.perform(parent, { kind: 'list' }), [
		{ id: 1, title: 'Workbench', focused: false },
		{ id: 2, title: 'Editor', focused: false },
	]);
	service.perform(parent, { kind: 'focus', windowId: child.id });
	assert.deepEqual(child.calls, ['focus']);
	registration.dispose();
	assert.equal(child.isDestroyed(), true);
	assert.deepEqual(service.perform(parent, { kind: 'list' }), [{ id: 1, title: 'Workbench', focused: false }]);

	const next = new TestWindow(3, 'Editor');
	service.registerAuxiliaryWindow(next);
	service.perform(parent, { kind: 'closeOthers' });
	assert.deepEqual(next.calls, ['close']);
	assert.equal(next.isDestroyed(), true);
});

test('WindowsMainService owns an independent Sessions window after the Workbench closes', async () => {
	const workbench = new TestWindow(1, 'Workbench');
	using service = new WindowsMainService(() => [workbench], async () => undefined, 'win32');
	let created = 0;
	let released = 0;
	let closed = 0;
	const create = (options: { readonly title: string }): TestWindow => { created++; return new TestWindow(created + 1, options.title); };
	const options = {
		title: 'Agents',
		state: { mode: WindowMode.Normal, width: 1180, height: 780 },
		webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: '', additionalArguments: [] },
		initialize: async (_window: TestWindow, resources: DisposableStore) => { resources.add(toDisposable(() => { released++; })); },
	};
	await service.openManagedWindow('workspace', create, options, () => { closed++; });
	const sessions = service.managedWindow('workspace')!;
	sessions.emit('ready-to-show');
	sessions.minimized = true;
	await service.openManagedWindow('workspace', create, options, () => { closed++; });
	assert.deepEqual({ created, shown: sessions.shown, focused: sessions.focused }, { created: 1, shown: 1, focused: true });
	assert.deepEqual(service.perform(workbench, { kind: 'list' }), [
		{ id: 1, title: 'Workbench', focused: false },
		{ id: 2, title: 'Agents', focused: true },
	]);
	service.perform(workbench, { kind: 'close' });
	assert.deepEqual(service.perform(sessions, { kind: 'list' }), [{ id: 2, title: 'Agents', focused: true }]);
	service.perform(sessions, { kind: 'focusSelf' });
	await service.closeManagedWindow('workspace');
	assert.deepEqual({ current: service.managedWindow('workspace'), released, closed }, { current: undefined, released: 1, closed: 1 });
});

test('WindowsMainService waits for a managed window to close before reopening it', async () => {
	using service = new WindowsMainService<TestWindow>(() => [], async () => undefined);
	const windows: TestWindow[] = [];
	const create = (options: { readonly title: string }): TestWindow => {
		const window = new TestWindow(windows.length + 1, options.title);
		windows.push(window);
		return window;
	};
	const options = {
		title: 'Agents',
		state: { mode: WindowMode.Normal, width: 1180, height: 780 },
		webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: '', additionalArguments: [] },
		initialize: async () => {},
	};
	await service.openManagedWindow('workspace', create, options, () => {});
	const first = windows[0]!;
	first.deferClose = true;
	const closing = service.closeManagedWindow('workspace');
	const reopening = service.openManagedWindow('workspace', create, options, () => {});
	assert.deepEqual({ windows: windows.length, closeRequests: first.calls.filter(call => call === 'close').length }, { windows: 1, closeRequests: 1 });
	first.destroy();
	await closing;
	await reopening;
	assert.equal(windows.length, 2);
});

test('WindowsMainService keeps a managed window open after a failed close and permits retry', async () => {
	using service = new WindowsMainService<TestWindow>(() => [], async () => undefined);
	using lifecycle = new LifecycleMainService<TestWindow>((window, message) => service.failManagedWindowClose(window, message), window => service.failManagedWindowClose(window, 'Window close was vetoed'));
	let window: TestWindow | undefined;
	await service.openManagedWindow('workspace', options => window = new TestWindow(1, options.title), {
		title: 'Agents',
		state: { mode: WindowMode.Normal, width: 1180, height: 780 },
		webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: '', additionalArguments: [] },
		initialize: async () => {},
	}, () => {});
	const sessions = window!;
	using tracking = lifecycle.registerWindow(sessions);
	lifecycle.respondToClose(sessions, { kind: 'ready' });
	const closing = service.closeManagedWindow('workspace');
	const firstToken = sessions.messages.find(message => message.channel === WINDOW_PREPARE_CLOSE_CHANNEL)?.level as number;
	lifecycle.respondToClose(sessions, { kind: 'failed', token: firstToken, message: 'Save failed' });
	await assert.rejects(closing, /Save failed/);
	assert.equal(service.managedWindow('workspace'), sessions);
	const retry = service.closeManagedWindow('workspace');
	const secondToken = sessions.messages.filter(message => message.channel === WINDOW_PREPARE_CLOSE_CHANNEL).at(-1)?.level as number;
	lifecycle.respondToClose(sessions, { kind: 'complete', token: secondToken });
	await retry;
	assert.equal(service.managedWindow('workspace'), undefined);
});

test('WindowsMainService releases a failed or crashed managed window', async () => {
	using service = new WindowsMainService<TestWindow>(() => [], async () => undefined);
	const windows: TestWindow[] = [];
	let released = 0;
	let closed = 0;
	const create = (options: { readonly title: string }): TestWindow => {
		const window = new TestWindow(windows.length + 1, options.title);
		windows.push(window);
		return window;
	};
	const options = {
		title: 'Agents',
		state: { mode: WindowMode.Maximized, width: 1180, height: 780 },
		webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: '', additionalArguments: [] },
		initialize: async (_window: TestWindow, resources: DisposableStore) => {
			resources.add(toDisposable(() => { released++; }));
			if (windows.length === 1) throw new Error('load failed');
		},
	};
	await assert.rejects(service.openManagedWindow('workspace', create, options, () => { closed++; }), /load failed/);
	assert.deepEqual({ destroyed: windows[0]?.isDestroyed(), released, closed }, { destroyed: true, released: 1, closed: 1 });
	await service.openManagedWindow('workspace', create, options, () => { closed++; });
	windows[1]!.emit('ready-to-show');
	assert.equal(windows[1]!.maximized, 1);
	windows[1]!.emitRendererEvent('render-process-gone');
	assert.deepEqual({ current: service.managedWindow('workspace'), released, closed }, { current: undefined, released: 2, closed: 2 });
});

test('WindowsMainService applies zoom, always-on-top, and platform tab operations', () => {
	const window = new TestWindow(1, 'First');
	const windows = () => [window];
	const service = new WindowsMainService(windows, async () => undefined, 'win32');
	service.perform(window, { kind: 'setZoom', level: 2 });
	service.perform(window, { kind: 'setAlwaysOnTop', enabled: true });
	assert.deepEqual([
		service.perform(window, { kind: 'getZoom' }),
		service.perform(window, { kind: 'getZoomFactor' }),
		service.perform(window, { kind: 'getAlwaysOnTop' }),
	], [2, 1.44, true]);
	assert.throws(() => service.perform(window, { kind: 'nativeTab', action: 'next' }), /require macOS/);

	const macService = new WindowsMainService(windows, async () => undefined, 'darwin');
	for (const action of ['next', 'previous', 'newWindow', 'merge', 'toggleBar'] as const) {
		macService.perform(window, { kind: 'nativeTab', action });
	}
	assert.deepEqual(window.calls, ['next', 'previous', 'newWindow', 'merge', 'toggleBar']);
});

test('WindowsMainService sends zoom changes and releases its window listener', async () => {
	const window = new TestWindow(1, 'First');
	const service = new WindowsMainService(() => [window], async () => undefined);
	const tracking = service.trackZoomLevel(window);
	service.perform(window, { kind: 'setZoom', level: 2 });
	window.emitZoomChanged();
	await new Promise<void>(resolve => setImmediate(resolve));
	assert.deepEqual(window.messages, [
		{ channel: WINDOW_ZOOM_CHANGED_CHANNEL, level: 2 },
		{ channel: WINDOW_ZOOM_CHANGED_CHANNEL, level: 2 },
	]);
	window.emitZoomChanged();
	tracking.dispose();
	await new Promise<void>(resolve => setImmediate(resolve));
	window.emitZoomChanged();
	assert.equal(window.messages.length, 2);
});

test('WindowsMainService reports fullscreen changes and releases its window listeners', () => {
	const window = new TestWindow(1, 'First');
	const service = new WindowsMainService(() => [window], async () => undefined);
	assert.equal(service.perform(window, { kind: 'getFullscreen' }), false);
	const tracking = service.trackFullscreen(window);
	window.emitFullscreenChanged(true);
	assert.equal(service.perform(window, { kind: 'getFullscreen' }), true);
	window.emitFullscreenChanged(false);
	assert.deepEqual(window.messages, [
		{ channel: WINDOW_FULLSCREEN_CHANGED_CHANNEL, level: true },
		{ channel: WINDOW_FULLSCREEN_CHANGED_CHANNEL, level: false },
	]);
	tracking.dispose();
	window.emitFullscreenChanged(true);
	assert.equal(window.messages.length, 2);
});

test('WindowsMainService disposes zoom tracking after window destruction', () => {
	const window = new TestWindow(1, 'First');
	const service = new WindowsMainService(() => [window], async () => undefined);
	const tracking = service.trackZoomLevel(window);
	window.destroyed = true;
	assert.doesNotThrow(() => tracking.dispose());
});

test('WindowsMainService creates a new macOS window tab and joins it to its parent', async () => {
	const parent = new TestWindow(1, 'Parent');
	const tab = new TestWindow(2, 'Tab');
	let creations = 0;
	const service = new WindowsMainService(() => [parent], async () => {
		creations += 1;
		return tab;
	}, 'darwin');
	await service.perform(parent, { kind: 'newTab' });
	assert.deepEqual({ creations, calls: parent.calls }, { creations: 1, calls: ['tab:2'] });

	const windowsService = new WindowsMainService(() => [parent], async () => tab, 'win32');
	assert.throws(() => windowsService.perform(parent, { kind: 'newTab' }), /require macOS/);
});

test('WindowsMainService closes a new tab when its parent closes during creation', async () => {
	const parent = new TestWindow(1, 'Parent');
	const tab = new TestWindow(2, 'Tab');
	let resolveTab!: (window: TestWindow) => void;
	const pendingTab = new Promise<TestWindow>(resolve => { resolveTab = resolve; });
	const service = new WindowsMainService(() => [parent], () => pendingTab, 'darwin');
	const opening = service.perform(parent, { kind: 'newTab' });
	parent.destroyed = true;
	resolveTab(tab);
	await opening;
	assert.deepEqual({ parent: parent.calls, tab: tab.calls }, { parent: [], tab: ['close'] });
});

test('window operation IPC validates commands before dispatching to the window host', () => {
	const window = new TestWindow(1, 'First');
	const service = new WindowsMainService(() => [window], async () => undefined);
	const route = windowOperationIpcRoute(service, window);
	assert.equal(route.channel, WINDOW_OPERATION_CHANNEL);
	assert.throws(() => route.validate({ kind: 'focus', windowId: -1 }), /Invalid window operation/);
	assert.throws(() => route.validate({ kind: 'setZoom', level: 100 }), /Invalid window operation/);
	assert.throws(() => route.validate({ kind: 'close', windowId: 1 }), /Invalid window operation/);
	assert.deepEqual(route.validate({ kind: 'getFullscreen' }), { kind: 'getFullscreen' });
	assert.deepEqual(route.validate({ kind: 'getZoomFactor' }), { kind: 'getZoomFactor' });
	route.invoke(route.validate({ kind: 'focusSelf' }));
	assert.deepEqual(window.calls, ['focus']);
});
