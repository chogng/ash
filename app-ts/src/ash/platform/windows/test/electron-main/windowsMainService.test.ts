import assert from 'node:assert/strict';
import { test } from 'mocha';
import { WINDOW_CLOSE_RESPONSE_CHANNEL, WINDOW_FULLSCREEN_CHANGED_CHANNEL, WINDOW_OPERATION_CHANNEL, WINDOW_PREPARE_CLOSE_CHANNEL, WINDOW_ZOOM_CHANGED_CHANNEL } from '../../../window/common/window.js';
import { WindowsMainService, windowCloseResponseIpcRoute, windowOperationIpcRoute, type IWorkbenchWindow } from '../../electron-main/windowsMainService.js';

class TestWindow implements IWorkbenchWindow<TestWindow> {
	public readonly calls: string[] = [];
	public readonly messages: { readonly channel: string; readonly level: number | boolean }[] = [];
	private readonly zoomListeners = new Set<() => void>();
	private readonly closeListeners = new Set<(event: { preventDefault(): void }) => void>();
	private readonly fullscreenListeners = new Map<string, Set<() => void>>();
	private readonly rendererListeners = new Map<string, Set<() => void>>();
	public readonly webContents = {
		getZoomLevel: (): number => this.zoomLevel,
		getZoomFactor: (): number => 1.2 ** this.zoomLevel,
		setZoomLevel: (level: number): void => { this.zoomLevel = level; },
		on: (event: 'zoom-changed' | 'did-start-loading' | 'render-process-gone', listener: () => void): void => { const listeners = event === 'zoom-changed' ? this.zoomListeners : this.rendererListeners.get(event) ?? new Set<() => void>(); listeners.add(listener); if (event !== 'zoom-changed') this.rendererListeners.set(event, listeners); },
		off: (event: 'zoom-changed' | 'did-start-loading' | 'render-process-gone', listener: () => void): void => { if (this.destroyed) throw new Error('Object has been destroyed'); (event === 'zoom-changed' ? this.zoomListeners : this.rendererListeners.get(event))?.delete(listener); },
		send: (channel: string, level: number | boolean): void => { this.messages.push({ channel, level }); },
	};
	public destroyed = false;
	public minimized = false;
	public focused = false;
	public zoomLevel = 0;
	public alwaysOnTop = false;
	public fullscreen = false;

	constructor(public readonly id: number, private readonly title: string) {}
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
	public close(): void { this.calls.push('close'); let prevented = false; for (const listener of this.closeListeners) listener({ preventDefault: () => { prevented = true; } }); if (!prevented) this.destroyed = true; }
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

test('WindowsMainService includes a dedicated child with its parent window', () => {
	const parent = new TestWindow(1, 'Workbench');
	const child = new TestWindow(2, 'Agents');
	const service = new WindowsMainService(() => [parent, child], async () => undefined, 'win32', window => window === child ? parent.id : undefined);
	assert.deepEqual(service.perform(parent, { kind: 'list' }), [
		{ id: 1, title: 'Workbench', focused: false },
		{ id: 2, title: 'Agents', focused: false, parentId: 1 },
	]);
	service.perform(parent, { kind: 'focus', windowId: child.id });
	assert.deepEqual(child.calls, ['focus']);
	service.perform(parent, { kind: 'closeOthers' });
	assert.equal(child.destroyed, true);
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

test('window close waits for the renderer to save, and a failed attempt can be retried', () => {
	const window = new TestWindow(1, 'First');
	const failures: string[] = [];
	const service = new WindowsMainService(() => [window], async () => undefined, 'win32', () => undefined, (_window, message) => { failures.push(message); });
	using tracking = service.trackClose(window);
	const route = windowCloseResponseIpcRoute(service, window);
	assert.equal(route.channel, WINDOW_CLOSE_RESPONSE_CHANNEL);
	assert.throws(() => route.validate({ kind: 'complete', token: -1 }), /Invalid window close response/);
	route.invoke(route.validate({ kind: 'ready' }));
	window.close();
	assert.equal(window.destroyed, false);
	assert.deepEqual(window.messages, [{ channel: WINDOW_PREPARE_CLOSE_CHANNEL, level: 1 }]);
	route.invoke(route.validate({ kind: 'failed', token: 1, message: 'Save failed' }));
	assert.deepEqual(failures, ['Save failed']);
	window.close();
	assert.deepEqual(window.messages, [
		{ channel: WINDOW_PREPARE_CLOSE_CHANNEL, level: 1 },
		{ channel: WINDOW_PREPARE_CLOSE_CHANNEL, level: 2 },
	]);
	assert.throws(() => route.invoke(route.validate({ kind: 'complete', token: 1 })), /no longer active/);
	route.invoke(route.validate({ kind: 'complete', token: 2 }));
	assert.equal(window.destroyed, true);
});

test('parent close waits for its dedicated window before requesting its own save', async () => {
	const parent = new TestWindow(1, 'Workbench');
	const child = new TestWindow(2, 'Agents');
	let finishChild!: () => void;
	let childCloseRequests = 0;
	const childClosed = new Promise<void>(resolve => { finishChild = resolve; });
	const service = new WindowsMainService(() => [parent, child], async () => undefined);
	using tracking = service.trackClose(parent, () => { childCloseRequests += 1; return childClosed; });
	const route = windowCloseResponseIpcRoute(service, parent);
	route.invoke(route.validate({ kind: 'ready' }));
	parent.close();
	assert.equal(parent.destroyed, false);
	assert.deepEqual(parent.messages, []);
	child.destroyed = true;
	finishChild();
	await childClosed;
	await Promise.resolve();
	assert.equal(parent.destroyed, false);
	assert.deepEqual(parent.messages, [{ channel: WINDOW_PREPARE_CLOSE_CHANNEL, level: 1 }]);
	route.invoke(route.validate({ kind: 'failed', token: 1, message: 'Parent save failed' }));
	parent.close();
	await Promise.resolve();
	assert.equal(childCloseRequests, 2);
	assert.deepEqual(parent.messages, [
		{ channel: WINDOW_PREPARE_CLOSE_CHANNEL, level: 1 },
		{ channel: WINDOW_PREPARE_CLOSE_CHANNEL, level: 2 },
	]);
	route.invoke(route.validate({ kind: 'complete', token: 2 }));
	assert.equal(parent.destroyed, true);
});

test('window close does not wait for a renderer that is loading', () => {
	const window = new TestWindow(1, 'First');
	const service = new WindowsMainService(() => [window], async () => undefined);
	using tracking = service.trackClose(window);
	const route = windowCloseResponseIpcRoute(service, window);
	route.invoke(route.validate({ kind: 'ready' }));
	window.emitRendererEvent('did-start-loading');
	window.close();
	assert.equal(window.destroyed, true);
	assert.deepEqual(window.messages, []);
});
