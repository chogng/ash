import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import assert from 'node:assert/strict';
import { setup, teardown, test } from 'mocha';
import type { BrowserWindow, HandlerDetails, WebContents } from 'electron';
import { InstantiationService } from '../../../instantiation/common/instantiationService.js';
import { IAuxiliaryWindowsMainService } from '../../../auxiliaryWindow/electron-main/auxiliaryWindows.js';
import { AuxiliaryWindowsMainService } from '../../../auxiliaryWindow/electron-main/auxiliaryWindowsMainService.js';
import { nodeWorkspacePathService } from '../../../workspaces/node/workspaces.js';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { WINDOW_FULLSCREEN_CHANGED_CHANNEL, WINDOW_OPERATION_CHANNEL, WINDOW_PREPARE_CLOSE_CHANNEL, WINDOW_ZOOM_CHANGED_CHANNEL, WINDOW_ALWAYS_ON_TOP_CHANGED_CHANNEL, validateWindowAlwaysOnTopChangedEvent, AUXILIARY_WINDOW_STATE_CHANGED_CHANNEL, validateAuxiliaryWindowStateEvent } from '../../../window/common/window.js';
import { LifecycleMainService, ILifecycleMainService } from '../../../lifecycle/electron-main/lifecycleMainService.js';
import { WindowMode, type IWindowBounds } from '../../../window/electron-main/window.js';
import type { IAnyWorkspaceIdentifier } from '../../../workspace/common/workspace.js';
import { createEmptyWorkspaceIdentifier, getSingleFolderWorkspaceIdentifier } from '../../../workspaces/node/workspaces.js';
import { WindowsMainService, windowOperationIpcRoute, workspaceRecoveryIpcRoute, type IWorkbenchWindow } from '../../electron-main/windowsMainService.js';
import type { IOpenConfiguration } from '../../electron-main/windows.js';
import { WINDOW_OPEN_FILES_CHANNEL, validateWindowFilesRequest, validateWindowFilesResponse, validateAgentsWindowHandoffComplete } from '../../../window/common/window.js';
import { WindowsStateHandler } from '../../electron-main/windowsStateHandler.js';
import { Event } from '../../../../base/common/event.js';
import { DialogMainService, IDialogMainService } from '../../../dialogs/electron-main/dialogMainService.js';
import { IThemeMainService } from '../../../theme/electron-main/themeMainService.js';
import { ThemeMainService } from '../../../theme/electron-main/themeMainServiceImpl.js';
import { ILogService, NullLoggerService } from '../../../log/common/log.js';
import { WorkspaceOpenTargetKind } from '../../../environment/common/argv.js';

let windowServices: InstantiationService;
setup(() => {
	windowServices = new InstantiationService();
	windowServices.registerInstance(ILogService, new NullLoggerService());
	windowServices.registerSingleton(IThemeMainService, () => new ThemeMainService({
		shouldUseDarkColors: false, shouldUseHighContrastColors: false, on: () => { }, removeListener: () => { },
	}, {
		getItem: () => undefined, setItem: () => { }, removeItem: () => { }, flush: async () => { }, close: async () => { },
	}));
	windowServices.registerSingleton(IDialogMainService, () => new DialogMainService({
		showMessageBox: async () => ({ response: 1, checkboxChecked: false }),
		showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
		showSaveDialog: async () => ({ canceled: true, filePath: '' }),
	}));
	windowServices.registerSingleton(ILifecycleMainService, () => new LifecycleMainService(() => { }, () => { }, {
		getItem: () => undefined, setItem: () => { }, removeItem: () => { }, flush: async () => { }, close: async () => { },
	}, 'test'));
	windowServices.registerSingleton(IAuxiliaryWindowsMainService, () => new AuxiliaryWindowsMainService(contents => (contents as unknown as TestWindow['webContents']).getOwnerBrowserWindow()));
});
teardown(() => windowServices.dispose());

ensureNoDisposablesAreLeakedInTestSuite();

test('backup window IPC validates ordinary workspace identities before opening windows', async () => {
	let restored: readonly IAnyWorkspaceIdentifier[] = [];
	const route = workspaceRecoveryIpcRoute(async workspaces => { restored = workspaces; });
	const identities = [{ id: 'empty' }, { id: 'folder', uri: 'file:///project' }, { id: 'multi', configPath: 'file:///project/test.ash-workspace' }];
	await route.invoke(route.validate(identities));
	assert.deepEqual(restored.map(workspace => workspace.id), ['empty', 'folder', 'multi']);
	assert.throws(() => route.validate({ workspaces: identities }), TypeError);
	assert.throws(() => route.validate([{ id: 'empty', content: 'must not enter Main' }]), /workspace identifier must contain exactly: id/);
	assert.throws(() => route.validate([{ id: 'folder', uri: 'https://example.com/project' }]), /workspace folder uri/);
});

test('backup recovery opens each workspace once even when restored renderers request it again', async () => {
	using service = createWindowsService(() => [], async () => undefined);
	const identities = [{ id: 'empty-with-draft' }, getSingleFolderWorkspaceIdentifier(URI.file('C:\\project'))];
	const opened: string[] = [];
	const open = async (workspace: IAnyWorkspaceIdentifier) => {
		opened.push(workspace.id);
		await service.restoreWorkspaces(identities, open);
		return new TestWindow(opened.length, workspace.id);
	};
	await service.restoreWorkspaces(identities, open);
	await service.restoreWorkspaces(identities, open);
	assert.deepEqual(opened.sort(), identities.map(workspace => workspace.id).sort());
});

test('failed backup window recovery retains other workspaces and permits a later attempt', async () => {
	using service = createWindowsService(() => [], async () => undefined);
	const opened: string[] = [];
	const open = async (workspace: IAnyWorkspaceIdentifier) => { opened.push(workspace.id); return new TestWindow(opened.length, workspace.id); };
	await assert.rejects(service.restoreWorkspaces([{ id: 'failed' }, { id: 'ready' }], async workspace => {
		if (workspace.id === 'failed') throw new Error('injected window failure');
		return open(workspace);
	}), AggregateError);
	await service.restoreWorkspaces([{ id: 'failed' }, { id: 'ready' }], open);
	assert.deepEqual(opened, ['ready', 'failed']);
});

test('window restoration selection respects the setting, explicit target, and update restart', () => {
	using service = createWindowsService(() => [], async () => undefined);
	const folder = { workspace: getSingleFolderWorkspaceIdentifier(URI.file('C:\\project')) };
	const empty = { workspace: createEmptyWorkspaceIdentifier() };
	const session = { windows: [folder, empty], active: 1 };
	assert.deepEqual(service.selectWindowsToRestore(session, undefined, false, false), { windows: [folder, empty], active: empty });
	assert.deepEqual(service.selectWindowsToRestore(session, 'folders', false, false), { windows: [folder], active: undefined });
	assert.deepEqual(service.selectWindowsToRestore(session, 'one', false, false), { windows: [empty], active: empty });
	assert.deepEqual(service.selectWindowsToRestore(session, 'none', false, false), { windows: [], active: undefined });
	assert.deepEqual(service.selectWindowsToRestore(session, 'all', true, false), { windows: [], active: undefined });
	assert.deepEqual(service.selectWindowsToRestore(session, 'preserve', true, false), { windows: [folder, empty], active: empty });
	assert.deepEqual(service.selectWindowsToRestore(session, 'none', true, true), { windows: [folder, empty], active: empty });
});

type RendererEvent = 'zoom-changed' | 'did-start-loading' | 'render-process-gone' | 'did-start-navigation' | 'did-navigate' | 'will-prevent-unload' | 'did-fail-load';
type RendererListener = (() => void)
	| ((event: unknown, details: Electron.RenderProcessGoneDetails) => void)
	| ((event: unknown, url: string, inPlace: boolean, mainFrame: boolean) => void)
	| ((event: unknown, code: number, description: string, url: string, mainFrame: boolean) => void);

class TestWindow implements IWorkbenchWindow<TestWindow> {
	public hookWindowMessage(_message: number, _callback: (wParam: Buffer, lParam: Buffer) => void): void { }
	public unhookWindowMessage(_message: number): void { }
	public readonly calls: string[] = [];
	public readonly messages: { readonly channel: string; readonly level: unknown; }[] = [];
	private readonly zoomListeners = new Set<() => void>();
	private readonly closeListeners = new Set<(event: { preventDefault(): void; }) => void>();
	private readonly fullscreenListeners = new Map<string, Set<() => void>>();
	private readonly rendererListeners = new Map<string, Set<() => void>>();
	private readonly onceListeners = new Map<string, Set<() => void>>();
	public readonly webContents = {
		mainFrame: { name: '' },
		getOwnerBrowserWindow: (): BrowserWindow => this as unknown as BrowserWindow,
		isDestroyed: (): boolean => this.destroyed,
		reload: (): void => { },
		getZoomLevel: (): number => this.zoomLevel,
		getZoomFactor: (): number => 1.2 ** this.zoomLevel,
		setZoomLevel: (level: number): void => { this.zoomLevel = level; },
		on: (event: RendererEvent, listener: RendererListener): void => {
			const listeners = event === 'zoom-changed' ? this.zoomListeners : this.rendererListeners.get(event) ?? new Set<() => void>();
			listeners.add(listener as () => void);
			if (event !== 'zoom-changed') this.rendererListeners.set(event, listeners);
		},
		off: (event: RendererEvent, listener: RendererListener): void => {
			if (this.destroyed) throw new Error('Object has been destroyed');
			(event === 'zoom-changed' ? this.zoomListeners : this.rendererListeners.get(event))?.delete(listener as () => void);
		},
		send: (channel: string, level: unknown): void => { this.messages.push({ channel, level }); },
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
	public bounds: IWindowBounds = { x: 0, y: 0, width: 800, height: 600 };
	public deferClose = false;

	constructor(public readonly id: number, private readonly title: string) { }
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
		for (const listener of this.fullscreenListeners.get(event) ?? []) listener();
	}
	public on(event: 'close', listener: (event: { preventDefault(): void; }) => void): void;
	public on(event: 'closed' | 'focus' | 'enter-full-screen' | 'leave-full-screen' | 'unresponsive' | 'responsive', listener: () => void): void;
	public on(event: 'close' | 'closed' | 'focus' | 'enter-full-screen' | 'leave-full-screen' | 'unresponsive' | 'responsive',
		listener: ((event: { preventDefault(): void; }) => void) | (() => void),
	): void {
		if (event === 'close') this.closeListeners.add(listener as (event: { preventDefault(): void; }) => void);
		else { const listeners = this.fullscreenListeners.get(event) ?? new Set<() => void>(); listeners.add(listener as () => void); this.fullscreenListeners.set(event, listeners); }
	}
	public off(event: 'close', listener: (event: { preventDefault(): void; }) => void): void;
	public off(event: 'closed' | 'focus' | 'enter-full-screen' | 'leave-full-screen' | 'unresponsive' | 'responsive', listener: () => void): void;
	public off(event: 'close' | 'closed' | 'focus' | 'enter-full-screen' | 'leave-full-screen' | 'unresponsive' | 'responsive',
		listener: ((event: { preventDefault(): void; }) => void) | (() => void),
	): void {
		if (event === 'close') this.closeListeners.delete(listener as (event: { preventDefault(): void; }) => void);
		else this.fullscreenListeners.get(event)?.delete(listener as () => void);
	}

	public emitFocus(): void { for (const listener of this.fullscreenListeners.get('focus') ?? []) listener(); }
	public isDestroyed(): boolean { return this.destroyed; }
	public isVisible(): boolean { return true; }
	public isMinimized(): boolean { return this.minimized; }
	public restore(): void { this.minimized = false; this.calls.push('restore'); }
	public focus(): void { this.focused = true; this.calls.push('focus'); }
	public getTitle(): string { return this.title; }
	public isFocused(): boolean { return this.focused; }
	public isFullScreen(): boolean { return this.fullscreen; }
	public isMaximized(): boolean { return this.maximized > 0; }
	public close(): void { this.calls.push('close'); let prevented = false; for (const listener of this.closeListeners) listener({ preventDefault: () => { prevented = true; } }); if (!prevented && !this.deferClose) this.destroy(); }
	public show(): void { this.shown++; }
	public getBounds(): IWindowBounds { return this.bounds; }
	public getNormalBounds(): IWindowBounds { return this.bounds; }
	public setTitleBarOverlay(_colors: { color: string; symbolColor: string; height: number; }): void { }
	public setBounds(bounds: IWindowBounds): void { this.bounds = bounds; }
	public maximize(): void { this.maximized++; }
	public setFullScreen(fullscreen: boolean): void { this.fullscreen = fullscreen; }
	public async loadURL(_url: string): Promise<void> { this.emitRendererEvent('did-start-loading'); }
	public async loadFile(_path: string): Promise<void> { this.emitRendererEvent('did-start-loading'); }
	public destroy(): void { if (this.destroyed) return; this.destroyed = true; this.emit('closed'); }
	public isAlwaysOnTop(): boolean { return this.alwaysOnTop; }
	public setAlwaysOnTop(enabled: boolean): void { this.alwaysOnTop = enabled; for (const listener of this.fullscreenListeners.get('always-on-top-changed') ?? []) listener(); }
	public selectNextTab(): void { this.calls.push('next'); }
	public selectPreviousTab(): void { this.calls.push('previous'); }
	public moveTabToNewWindow(): void { this.calls.push('newWindow'); }
	public mergeAllWindows(): void { this.calls.push('merge'); }
	public toggleTabBar(): void { this.calls.push('toggleBar'); }
	public addTabbedWindow(window: TestWindow): void { this.calls.push(`tab:${window.id}`); }
	public emitZoomChanged(): void { for (const listener of this.zoomListeners) listener(); }
	public emitFullscreenChanged(fullscreen: boolean): void { this.fullscreen = fullscreen; for (const listener of this.fullscreenListeners.get(fullscreen ? 'enter-full-screen' : 'leave-full-screen') ?? []) listener(); }
	public emitRendererEvent(event: 'did-start-loading' | 'render-process-gone'): void {
		if (event === 'did-start-loading') this.emitNavigation(false, true);
		for (const listener of this.rendererListeners.get(event) ?? []) {
			(listener as (event: unknown, details: Electron.RenderProcessGoneDetails) => void)(undefined, { reason: 'crashed', exitCode: 139 });
		}
	}
	public emitNavigation(inPlace: boolean, mainFrame: boolean): void {
		for (const listener of this.rendererListeners.get('did-start-navigation') ?? []) {
			(listener as (event: unknown, url: string, inPlace: boolean, mainFrame: boolean) => void)(undefined, 'http://localhost/sessions', inPlace, mainFrame);
		}
	}
}

test('file launches wait for renderer readiness, reject replies from another window and retain wait requests until close', async () => {
	const window = new TestWindow(1, 'Workbench');
	const other = new TestWindow(2, 'Other');
	using service = createWindowsService(() => [window], async () => window);
	const configuration: IOpenConfiguration = { cwd: 'C:\\project', files: [{ uri: 'file:///C:/project/file.ts' }], forceNewWindow: false, forceReuseWindow: true, waitForFiles: true };
	const opening = service.open(configuration);
	await new Promise<void>(resolve => setImmediate(resolve));
	assert.deepEqual(window.messages, []);
	service.respondToFileOpen(window, { kind: 'ready' });
	assert.deepEqual(window.messages, [{ channel: WINDOW_OPEN_FILES_CHANNEL, level: { id: 1, files: configuration.files, wait: true } }]);
	assert.throws(() => service.respondToFileOpen(other, { kind: 'opened', id: 1 }), /does not belong/);
	service.respondToFileOpen(window, { kind: 'opened', id: 1 });
	const result = await opening;
	let finished = false;
	void result.whenFilesClosed.then(() => { finished = true; });
	await new Promise<void>(resolve => setImmediate(resolve));
	assert.equal(finished, false);
	service.respondToFileOpen(window, { kind: 'closed', id: 1 });
	await result.whenFilesClosed;
	assert.equal(finished, true);
	assert.throws(() => service.respondToFileOpen(window, { kind: 'closed', id: 1 }), /does not belong/);
});

test('new window launches bypass the active window while reuse requests select it', async () => {
	const active = new TestWindow(1, 'Active');
	active.focused = true;
	const created = new TestWindow(2, 'Created');
	const selected: (TestWindow | undefined)[] = [];
	using service = createWindowsService(() => [active], async (_configuration, reuse) => {
		selected.push(reuse);
		return reuse ?? registerWindow(service, created);
	});
	const configuration: IOpenConfiguration = { cwd: 'C:\\project', files: [], forceNewWindow: true, forceReuseWindow: false, waitForFiles: false };
	await service.open(configuration);
	await service.open({ ...configuration, forceNewWindow: false, forceReuseWindow: true });
	assert.deepEqual(selected, [undefined, active]);
});

test('file requests fail on renderer errors and settle when their window reloads or closes', async () => {
	let window!: TestWindow;
	using service = createWindowsService(() => [window], async () => window);
	window = service.createWindow(options => new TestWindow(1, options.title), {
		title: 'Workbench',
		reopen: async () => { },
		state: { mode: WindowMode.Normal, width: 1000, height: 700 },
		webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: '', additionalArguments: [] },
	}, new DisposableStore()).win;
	const configuration: IOpenConfiguration = { cwd: 'C:\\project', files: [{ uri: 'file:///C:/project/file.ts' }], forceNewWindow: false, forceReuseWindow: true, waitForFiles: true };
	const failed = service.open(configuration);
	const rejected = assert.rejects(failed, /Permission denied/);
	await new Promise<void>(resolve => setImmediate(resolve));
	service.respondToFileOpen(window, { kind: 'ready' });
	service.respondToFileOpen(window, { kind: 'failed', id: 1, message: 'Permission denied' });
	await rejected;
	const opening = service.open(configuration);
	await new Promise<void>(resolve => setImmediate(resolve));
	service.respondToFileOpen(window, { kind: 'opened', id: 2 });
	const opened = await opening;
	window.emitRendererEvent('did-start-loading');
	await opened.whenFilesClosed;
	const pending = service.open(configuration);
	const closed = assert.rejects(pending, /Window closed before opening/);
	await new Promise<void>(resolve => setImmediate(resolve));
	window.destroy();
	await closed;
});

test('renderer readiness follows the latest load and rejects a window that closes during startup', async () => {
	using service = createWindowsService(() => [], async () => undefined);
	const window = service.createWindow(options => new TestWindow(1, options.title), {
		title: 'Workbench',
		reopen: async () => { },
		state: { mode: WindowMode.Normal, width: 1000, height: 700 },
		webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: '', additionalArguments: [] },
	}, new DisposableStore()).win;
	let ready = false;
	const restored = service.getWindowById(window.id)!.ready().then(() => { ready = true; });
	window.emitRendererEvent('did-start-loading');
	await new Promise<void>(resolve => setImmediate(resolve));
	assert.equal(ready, false);
	service.respondToFileOpen(window, { kind: 'ready' });
	await restored;
	assert.equal(ready, true);
	window.emitRendererEvent('did-start-loading');
	const closed = assert.rejects(service.getWindowById(window.id)!.ready(), /Window closed before its renderer/);
	window.destroy();
	await closed;
});

test('file launch IPC rejects extra fields, invalid positions, invalid resource schemes and malformed responses', () => {
	const request = { id: 1, wait: true, files: [{ uri: 'file:///C:/project/file.ts', line: 2, column: 3 }] };
	assert.deepEqual(validateWindowFilesRequest(request), request);
	assert.throws(() => validateWindowFilesRequest({ ...request, files: [{ uri: 'https://example.com/file' }] }), /absolute file URIs/);
	assert.throws(() => validateWindowFilesRequest({ ...request, files: [{ uri: request.files[0]!.uri, line: 0 }] }), /positive integers/);
	assert.throws(() => validateWindowFilesRequest({ ...request, extra: true }), /Invalid file open request/);
	assert.throws(() => validateWindowFilesResponse({ kind: 'ready', id: 1 }), /Invalid file open response/);
	assert.throws(() => validateWindowFilesResponse({ kind: 'opened', id: -1 }), /Invalid file open response/);
	assert.throws(() => validateWindowFilesResponse({ kind: 'failed', id: 1, message: '' }), /Invalid file open response/);
});

test('WindowsMainService lists, focuses, and closes only live Workbench windows', () => {
	const first = new TestWindow(1, 'First');
	const second = new TestWindow(2, 'Second');
	second.minimized = true;
	using service = createWindowsService(() => [first, second], async () => undefined, 'win32');

	assert.deepEqual(service.perform(first, { kind: 'list' }), [
		{ id: 1, title: 'First', focused: false, current: true },
		{ id: 2, title: 'Second', focused: false, current: false },
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
	assert.deepEqual(service.perform(first, { kind: 'list' }), [{ id: 1, title: 'First', focused: true, current: true }]);
	assert.throws(() => service.perform(second, { kind: 'getZoom' }), /Workbench window is closed/);
	service.perform(first, { kind: 'close' });
	assert.deepEqual(first.calls, ['restore', 'focus', 'close']);
});

test('WindowsMainService owns Workbench window resources through close and app disposal', () => {
	using service = createWindowsService(() => [], async () => undefined);
	const resources = new DisposableStore();
	let released = 0;
	resources.add(toDisposable(() => { released++; }));
	const host = service.createWindow(options => new TestWindow(1, options.title), {
		title: 'Workbench',
		reopen: async () => { },
		state: { mode: WindowMode.Normal, width: 1000, height: 700 },
		webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: '', additionalArguments: [] },
	}, resources);
	host.win.destroy();
	assert.equal(released, 1);
	const nextResources = new DisposableStore();
	nextResources.add(toDisposable(() => { released++; }));
	const next = service.createWindow(options => new TestWindow(2, options.title), {
		title: 'Workbench',
		reopen: async () => { },
		state: { mode: WindowMode.Normal, width: 1000, height: 700 },
		webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: '', additionalArguments: [] },
	}, nextResources);
	service.dispose();
	assert.deepEqual({ destroyed: next.win.isDestroyed(), released }, { destroyed: true, released: 2 });
});

test('WindowsMainService tracks auxiliary windows and releases them with their parent', () => {
	const parent = new TestWindow(1, 'Workbench');
	const child = new TestWindow(2, 'Editor');
	using service = createWindowsService(() => [parent], async () => undefined);
	const registration = windowServices.get(IAuxiliaryWindowsMainService).registerWindow(child.webContents as unknown as WebContents, parent.id);
	assert.deepEqual(service.perform(parent, { kind: 'list' }), [
		{ id: 1, title: 'Workbench', focused: false, current: true },
		{ id: 2, title: 'Editor', focused: false, current: false },
	]);
	service.perform(parent, { kind: 'focus', windowId: child.id });
	assert.deepEqual(child.calls, ['focus']);
	registration.dispose();
	assert.equal(child.isDestroyed(), true);
	assert.deepEqual(service.perform(parent, { kind: 'list' }), [{ id: 1, title: 'Workbench', focused: false, current: true }]);

	const next = new TestWindow(3, 'Editor');
	using nextRegistration = windowServices.get(IAuxiliaryWindowsMainService).registerWindow(next.webContents as unknown as WebContents, parent.id);
	service.perform(parent, { kind: 'closeOthers' });
	assert.deepEqual(next.calls, []);
	assert.equal(next.isDestroyed(), false);
});

test('auxiliary creation validates popup bounds independently of whether a position was restored', () => {
	const service = windowServices.get(IAuxiliaryWindowsMainService);
	const request = (features: string): HandlerDetails => ({ url: 'about:blank', features, frameName: '', disposition: 'new-window', referrer: { url: '', policy: 'default' } });
	assert.deepEqual(service.createWindow(request('popup=yes,width=700,height=530'), 'system'), { width: 700, height: 530, alwaysOnTop: false, fullscreen: false, webPreferences: { zoomFactor: 1 } });
	assert.deepEqual(service.createWindow(request('width=700,height=530,x=-120,y=90'), 'system'), { width: 700, height: 530, x: -120, y: 90, alwaysOnTop: false, fullscreen: false, webPreferences: { zoomFactor: 1 } });
	assert.deepEqual(service.createWindow(request('left=120,top=90'), 'system'), { x: 120, y: 90, alwaysOnTop: false, fullscreen: false, webPreferences: { zoomFactor: 1 } });
	const custom = service.createWindow(request('width=700,height=530'), 'custom');
	assert.deepEqual({ width: custom.width, height: custom.height }, { width: 700, height: 530 });
	assert.equal(custom.titleBarStyle, process.platform === 'darwin' ? 'hiddenInset' : 'hidden');
	assert.ok(custom.titleBarOverlay);
	const restored = service.createWindow(request('width=800,height=600,window-maximized=yes,window-always-on-top=yes,window-zoom-level=2'), 'custom');
	assert.deepEqual({ show: restored.show, pinned: restored.alwaysOnTop, zoom: restored.webPreferences?.zoomFactor }, { show: false, pinned: true, zoom: 1.44 });
	assert.throws(() => service.createWindow(request('window-zoom-level=Infinity'), 'custom'), /Invalid auxiliary zoom/);
	for (const features of ['width=0', 'height=-1', 'x=NaN', 'width=', 'height=1.5']) {
		assert.throws(() => service.createWindow(request(features), 'custom'), /Invalid auxiliary window/);
	}
	assert.throws(() => service.createWindow({ ...request(''), url: 'https://example.com' }, 'custom'), /same-origin document/);
});

test('focused detached editors retain their parent workspace and focus when that workspace is reused', async () => {
	const first = new TestWindow(1, 'First');
	const second = new TestWindow(2, 'Second');
	const child = new TestWindow(3, 'Editor');
	using service = createWindowsService(() => [first, second], async () => undefined);
	const folder = URI.file('/repo/project');
	service.updateWorkspace(first.id, { id: 'first', uri: folder });
	service.updateWorkspace(second.id, { id: 'second', uri: folder });
	const auxiliary = windowServices.get(IAuxiliaryWindowsMainService);
	using registration = auxiliary.registerWindow(child.webContents as unknown as WebContents, first.id);
	child.focused = true;
	child.emitFocus();
	assert.equal(service.getLastActiveWindow(), first);
	child.focused = false;
	assert.equal(service.getLastActiveWindow(), first);
	assert.equal(service.findWorkspace({ id: 'folder', uri: folder }), first);
	second.emitFocus();
	assert.equal(service.getLastActiveWindow(), second);
	assert.equal(service.findWorkspace({ id: 'folder', uri: folder }), second);
	child.focused = true;
	child.emitFocus();
	assert.equal(auxiliary.getWindowByWebContents(child.webContents as unknown as WebContents)?.parentId, first.id);
	assert.equal(await service.openWorkspace({ id: 'first', uri: folder }, async () => assert.fail('must reuse parent workspace')), first);
	assert.deepEqual({ parent: first.calls, child: child.calls }, { parent: [], child: ['focus'] });
	child.destroy();
	assert.deepEqual(auxiliary.getWindows(), []);
	assert.equal(service.getLastActiveWindow(), second);
});

test('auxiliary registration resolves descendant ownership and detaches listeners on release', () => {
	const auxiliary = windowServices.get(IAuxiliaryWindowsMainService);
	const child = new TestWindow(2, 'Editor');
	const descendant = new TestWindow(3, 'Nested Editor');
	using registration = auxiliary.registerWindow(child.webContents as unknown as WebContents, 1);
	using descendantRegistration = auxiliary.registerWindow(descendant.webContents as unknown as WebContents, child.id);
	assert.deepEqual(auxiliary.getWindows().map(window => ({ id: window.id, parentId: window.parentId })), [{ id: 2, parentId: 1 }, { id: 3, parentId: 1 }]);
	assert.throws(() => auxiliary.registerWindow(child.webContents as unknown as WebContents, 1), /already registered/);
	registration.dispose();
	assert.equal(child.isDestroyed(), true);
	assert.equal(auxiliary.getWindowByWebContents(child.webContents as unknown as WebContents), undefined);
	assert.throws(() => auxiliary.registerWindow(child.webContents as unknown as WebContents, 1), /closed before registration/);
	windowServices.dispose();
	assert.equal(descendant.isDestroyed(), true);
});

test('auxiliary registration maximizes only when restoring that window mode', () => {
	const auxiliary = windowServices.get(IAuxiliaryWindowsMainService);
	const hidden = new TestWindow(2, 'Hidden editor');
	hidden.isVisible = () => false;
	using hiddenRegistration = auxiliary.registerWindow(hidden.webContents as unknown as WebContents, 1);
	assert.deepEqual({ maximized: hidden.maximized, shown: hidden.shown }, { maximized: 0, shown: 0 });
	const restored = new TestWindow(3, 'Restored editor');
	using restoredRegistration = auxiliary.registerWindow(restored.webContents as unknown as WebContents, 1, { show: false });
	assert.deepEqual({ maximized: restored.maximized, shown: restored.shown }, { maximized: 1, shown: 1 });
});

test('auxiliary registration restores Windows outer bounds before capturing its initial state', function () {
	if (process.platform !== 'win32') this.skip();
	const child = new TestWindow(2, 'Restored editor');
	const saved = { x: 120, y: 90, width: 718, height: 539 };
	// Reproduce the constructor/frame mismatch measured on the Windows desktop.
	child.bounds = { ...saved, width: 724, height: 544 };
	using registration = windowServices.get(IAuxiliaryWindowsMainService).registerWindow(child.webContents as unknown as WebContents, 1, saved);
	assert.deepEqual(child.getBounds(), saved);
	assert.deepEqual(windowServices.get(IAuxiliaryWindowsMainService).getWindowByWebContents(child.webContents as unknown as WebContents)?.getState(), {
		width: saved.width, height: saved.height, left: saved.x, top: saved.y,
		zoomLevel: 0, alwaysOnTop: false, mode: 'normal',
	});
});

test('window service assembly rejects a missing auxiliary window owner', () => {
	using services = new InstantiationService();
	assert.throws(() => services.createInstance(WindowsMainService<TestWindow>, async () => undefined, process.platform, nodeWorkspacePathService), /Unknown service: auxiliaryWindowsMainService/);
});

test('an auxiliary renderer crash closes its window and removes it from window operations', () => {
	const parent = new TestWindow(1, 'Workbench');
	const child = new TestWindow(2, 'Editor');
	using service = createWindowsService(() => [parent], async () => undefined);
	const auxiliary = windowServices.get(IAuxiliaryWindowsMainService);
	using registration = auxiliary.registerWindow(child.webContents as unknown as WebContents, parent.id);
	child.emitRendererEvent('render-process-gone');
	assert.deepEqual({ destroyed: child.isDestroyed(), auxiliary: auxiliary.getWindows(), windows: service.perform(parent, { kind: 'list' }) }, {
		destroyed: true,
		auxiliary: [],
		windows: [{ id: 1, title: 'Workbench', focused: false, current: true }],
	});
});

test('WindowsMainService owns an independent Sessions window after the Workbench closes', async () => {
	const workbench = new TestWindow(1, 'Workbench');
	using service = createWindowsService(() => [workbench], async () => undefined, 'win32');
	let created = 0;
	let released = 0;
	let closed = 0;
	const create = (options: { readonly title: string; }): TestWindow => { created++; return new TestWindow(created + 1, options.title); };
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
		{ id: 1, title: 'Workbench', focused: false, current: true },
		{ id: 2, title: 'Agents', focused: true, current: false },
	]);
	service.perform(workbench, { kind: 'close' });
	assert.deepEqual(service.perform(sessions, { kind: 'list' }), [{ id: 2, title: 'Agents', focused: true, current: true }]);
	service.perform(sessions, { kind: 'focusSelf' });
	await service.closeManagedWindow('workspace');
	assert.deepEqual({ current: service.managedWindow('workspace'), released, closed }, { current: undefined, released: 1, closed: 1 });
});

test('managed Agents windows receive startup theme colors before initialization', async () => {
	using service = createWindowsService(() => [], async () => undefined, 'win32');
	let constructed = false;
	await service.openManagedWindow('agents', options => {
		assert.equal(options.backgroundColor, '#ffffff');
		if (process.platform === 'win32' || process.platform === 'linux') {
			assert.deepEqual(options.titleBarOverlay, { color: '#ffffff', symbolColor: '#000000', height: 35 });
		}
		constructed = true;
		return new TestWindow(1, options.title);
	}, {
		title: 'Agents', backgroundColor: '#ffffff',
		state: { mode: WindowMode.Normal, width: 1180, height: 780 },
		webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: '', additionalArguments: [] },
		initialize: async window => {
			assert.equal(constructed, true);
			assert.equal(window.shown, 0);
		},
	}, () => { });
});

test('managed window handoffs are ordered, acknowledged once and rejected with their renderer document', async () => {
	using service = createWindowsService(() => [], async () => undefined);
	const options = {
		title: 'Agents', state: { mode: WindowMode.Normal, width: 1180, height: 780 },
		webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: '', additionalArguments: [] },
		initialize: async (_window: TestWindow, _resources: DisposableStore) => { },
	};
	await service.openManagedWindow('agents', () => new TestWindow(1, 'Agents'), options, () => { });
	const request = { conversation: { sessionId: 'session', threadId: 'thread' } };
	const first = service.enqueueManagedWindowHandoff('agents', request);
	const second = service.enqueueManagedWindowHandoff('agents', request);
	const taken = service.takeManagedWindowHandoff('agents')!;
	assert.deepEqual(taken.options, request);
	service.completeManagedWindowHandoff('agents', validateAgentsWindowHandoffComplete({ id: taken.id }));
	await first;
	assert.throws(() => service.completeManagedWindowHandoff('agents', { id: taken.id }), /not pending/);
	const failed = service.takeManagedWindowHandoff('agents')!;
	const failedResult = assert.rejects(second, /Occupied draft/);
	service.completeManagedWindowHandoff('agents', { id: failed.id, error: 'Occupied draft' });
	await failedResult;
	assert.equal(service.takeManagedWindowHandoff('agents'), undefined);
	assert.throws(() => validateAgentsWindowHandoffComplete({ id: taken.id, unexpected: true }), TypeError);

	for (const interruption of ['reload', 'crash', 'close'] as const) {
		await service.openManagedWindow('agents', () => new TestWindow(1, 'Agents'), options, () => { });
		const window = service.managedWindow('agents')!;
		const pending = service.enqueueManagedWindowHandoff('agents', request);
		const stale = service.takeManagedWindowHandoff('agents')!;
		const rejected = assert.rejects(pending, interruption === 'reload' ? /reloaded before/ : /closed before/);
		window.emitNavigation(true, true);
		window.emitNavigation(false, false);
		if (interruption === 'reload') { window.emitNavigation(false, true); }
		else if (interruption === 'crash') { window.emitRendererEvent('render-process-gone'); }
		else { await service.closeManagedWindow('agents'); }
		await rejected;
		if (interruption === 'crash') {
			await new Promise(resolve => setImmediate(resolve));
			assert.equal(service.managedWindow('agents'), undefined);
		}
		assert.equal(service.takeManagedWindowHandoff('agents'), undefined);
		assert.throws(() => service.completeManagedWindowHandoff('agents', { id: stale.id }), /not pending/);
	}
	await assert.rejects(service.enqueueManagedWindowHandoff('agents', request), /unavailable/);
});

test('WindowsMainService waits for a managed window to close before reopening it', async () => {
	using service = createWindowsService(() => [], async () => undefined);
	const windows: TestWindow[] = [];
	const create = (options: { readonly title: string; }): TestWindow => {
		const window = new TestWindow(windows.length + 1, options.title);
		windows.push(window);
		return window;
	};
	const options = {
		title: 'Agents',
		state: { mode: WindowMode.Normal, width: 1180, height: 780 },
		webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: '', additionalArguments: [] },
		initialize: async () => { },
	};
	await service.openManagedWindow('workspace', create, options, () => { });
	const first = windows[0]!;
	first.deferClose = true;
	const closing = service.closeManagedWindow('workspace');
	const reopening = service.openManagedWindow('workspace', create, options, () => { });
	assert.deepEqual({ windows: windows.length, closeRequests: first.calls.filter(call => call === 'close').length }, { windows: 1, closeRequests: 1 });
	first.destroy();
	await closing;
	await reopening;
	assert.equal(windows.length, 2);
});

for (const failReplacement of [false, true]) {
	test(`managed recovery creates a fresh native window and ${failReplacement ? 'retains the old host on failure' : 'retires the old host without waiting for close'}`, async () => {
		windowServices.get(IDialogMainService).showMessageBox = async () => ({ response: 0, checkboxChecked: false });
		using service = createWindowsService(() => [], async () => undefined);
		const windows: TestWindow[] = [];
		let closed = 0;
		await service.openManagedWindow('agents', options => {
			const window = new TestWindow(windows.length + 1, options.title);
			windows.push(window);
			return window;
		}, {
			title: 'Agents', workspace: { id: 'fixture' },
			state: { mode: WindowMode.Normal, width: 1000, height: 700 },
			webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: '', additionalArguments: [] },
			initialize: async window => {
				if (failReplacement && windows.length === 2) throw new Error('Replacement failed');
				await service.getWindowById(window.id)!.load({ file: '/synthetic/sessions.html', url: 'file:///synthetic/sessions.html', useDevelopmentUrl: false });
			},
		}, () => { closed++; });
		const first = windows[0]!;
		first.deferClose = true;
		const closing = assert.rejects(service.closeManagedWindow('agents'), /being reopened/);
		await service.getWindowById(first.id)!.reportWindowError(false);
		await closing;
		assert.equal(windows.length, 2);
		assert.equal(closed, 0);
		assert.equal(service.managedWindow('agents'), windows[failReplacement ? 0 : 1]);
		assert.equal(first.isDestroyed(), !failReplacement);
		assert.equal(windows[1]!.isDestroyed(), failReplacement);
		assert.equal(service.getWindowById(service.managedWindow('agents')!.id)!.openedWorkspace.id, 'fixture');
	});
}

test('WindowsMainService keeps a managed window open after a failed close and permits retry', async () => {
	using service = createWindowsService(() => [], async () => undefined);
	using lifecycle = new LifecycleMainService<TestWindow>((window, failure) => { if (failure.kind === 'failed') service.failManagedWindowClose(window, failure.message); }, window => service.failManagedWindowClose(window, 'Window close was vetoed'), {
		getItem: () => undefined,
		setItem: () => { },
		removeItem: () => { },
		flush: async () => { },
		close: async () => { },
	}, '1.0.0');
	let window: TestWindow | undefined;
	await service.openManagedWindow('workspace', options => window = new TestWindow(1, options.title), {
		title: 'Agents',
		state: { mode: WindowMode.Normal, width: 1180, height: 780 },
		webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: '', additionalArguments: [] },
		initialize: async () => { },
	}, () => { });
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
	using service = createWindowsService(() => [], async () => undefined);
	const windows: TestWindow[] = [];
	let released = 0;
	let closed = 0;
	const create = (options: { readonly title: string; }): TestWindow => {
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
	await new Promise(resolve => setImmediate(resolve));
	assert.deepEqual({ current: service.managedWindow('workspace'), released, closed }, { current: undefined, released: 2, closed: 2 });
});

test('WindowsMainService applies zoom, always-on-top, and platform tab operations', () => {
	const window = new TestWindow(1, 'First');
	const windows = () => [window];
	using service = createWindowsService(windows, async () => undefined, 'win32');
	service.perform(window, { kind: 'setZoom', level: 2 });
	service.perform(window, { kind: 'setAlwaysOnTop', enabled: true });
	assert.deepEqual([
		service.perform(window, { kind: 'getZoom' }),
		service.perform(window, { kind: 'getZoomFactor' }),
		service.perform(window, { kind: 'getAlwaysOnTop' }),
	], [2, 1.44, true]);
	assert.throws(() => service.perform(window, { kind: 'nativeTab', action: 'next' }), /require macOS/);

	using macService = createWindowsService(windows, async () => undefined, 'darwin');
	for (const action of ['next', 'previous', 'newWindow', 'merge', 'toggleBar'] as const) {
		macService.perform(window, { kind: 'nativeTab', action });
	}
	assert.deepEqual(window.calls, ['next', 'previous', 'newWindow', 'merge', 'toggleBar']);
});

test('window pinning targets only registered auxiliary windows owned by its IPC sender', () => {
	const parent = new TestWindow(1, 'Workbench');
	const child = new TestWindow(2, 'Theme Editor');
	const other = new TestWindow(3, 'Other workbench');
	const name = 'ash-auxiliary-12345678-1234-1234-1234-123456789abc';
	child.webContents.mainFrame.name = name;
	using service = createWindowsService(() => [parent, other], async () => undefined);
	using registration = windowServices.get(IAuxiliaryWindowsMainService).registerWindow(child.webContents as unknown as WebContents, parent.id);
	const route = windowOperationIpcRoute(service, parent);
	const pin = route.validate({ kind: 'setAlwaysOnTop', enabled: true, windowName: name });
	route.invoke(pin);
	assert.deepEqual([parent.alwaysOnTop, child.alwaysOnTop, other.alwaysOnTop], [false, true, false]);
	assert.equal(route.invoke(route.validate({ kind: 'getAlwaysOnTop', windowName: name })), true);
	assert.throws(() => windowOperationIpcRoute(service, other).invoke(pin), /belongs to another workbench/);
	for (const invalid of [
		{ kind: 'getAlwaysOnTop', windowName: '../another-window' },
		{ kind: 'setAlwaysOnTop', enabled: 'true', windowName: name },
		{ kind: 'setAlwaysOnTop', enabled: true, windowName: name, windowId: parent.id },
		{ kind: 'closeOthers', windowName: name },
	]) assert.throws(() => route.validate(invalid), /Invalid window operation/);
	route.invoke(route.validate({ kind: 'setAlwaysOnTop', enabled: false, windowName: name }));
	assert.equal(child.alwaysOnTop, false);
	assert.deepEqual(parent.messages.filter(message => message.channel === WINDOW_ALWAYS_ON_TOP_CHANGED_CHANNEL), [true, false].map(alwaysOnTop => ({ channel: WINDOW_ALWAYS_ON_TOP_CHANGED_CHANNEL, level: { windowName: name, alwaysOnTop } })));
	assert.deepEqual(child.messages, []);
	assert.deepEqual(other.messages, []);
	assert.deepEqual(validateWindowAlwaysOnTopChangedEvent({ windowName: name, alwaysOnTop: true }), { windowName: name, alwaysOnTop: true });
	for (const event of [null, { alwaysOnTop: 'true' }, { alwaysOnTop: true, windowName: 'foreign' }, { alwaysOnTop: true, execute: true }]) {
		assert.throws(() => validateWindowAlwaysOnTopChangedEvent(event), /Invalid window always-on-top change/);
	}
	registration.dispose();
	assert.throws(() => route.invoke(pin), /closed/);
});

test('WindowsMainService sends zoom changes and releases its window listener', async () => {
	const window = new TestWindow(1, 'First');
	using service = createWindowsService(() => [window], async () => undefined);
	service.perform(window, { kind: 'setZoom', level: 2 });
	window.emitZoomChanged();
	await new Promise<void>(resolve => setImmediate(resolve));
	assert.deepEqual(window.messages, [
		{ channel: WINDOW_ZOOM_CHANGED_CHANNEL, level: 2 },
		{ channel: WINDOW_ZOOM_CHANGED_CHANNEL, level: 2 },
	]);
	window.emitZoomChanged();
	service.getWindowById(window.id)!.dispose();
	await new Promise<void>(resolve => setImmediate(resolve));
	window.emitZoomChanged();
	assert.equal(window.messages.length, 2);
});

test('WindowsMainService reports fullscreen changes and releases its window listeners', () => {
	const window = new TestWindow(1, 'First');
	using service = createWindowsService(() => [window], async () => undefined);
	assert.equal(service.perform(window, { kind: 'getFullscreen' }), false);
	window.emitFullscreenChanged(true);
	assert.equal(service.perform(window, { kind: 'getFullscreen' }), true);
	window.emitFullscreenChanged(false);
	assert.deepEqual(window.messages, [
		{ channel: WINDOW_FULLSCREEN_CHANGED_CHANNEL, level: true },
		{ channel: WINDOW_FULLSCREEN_CHANGED_CHANNEL, level: false },
	]);
	service.getWindowById(window.id)!.dispose();
	window.emitFullscreenChanged(true);
	assert.equal(window.messages.length, 2);
});

test('WindowsMainService disposes zoom tracking after window destruction', () => {
	const window = new TestWindow(1, 'First');
	using service = createWindowsService(() => [window], async () => undefined);
	window.destroyed = true;
	assert.doesNotThrow(() => service.dispose());
});

test('WindowsMainService creates a new macOS window tab and joins it to its parent', async () => {
	const parent = new TestWindow(1, 'Parent');
	const tab = new TestWindow(2, 'Tab');
	let creations = 0;
	using service = createWindowsService(() => [parent], async () => {
		creations += 1;
		return registerWindow(service, tab);
	}, 'darwin');
	await service.perform(parent, { kind: 'newTab' });
	assert.deepEqual({ creations, calls: parent.calls }, { creations: 1, calls: ['tab:2'] });

	using windowsService = createWindowsService(() => [parent], async () => tab, 'win32');
	assert.throws(() => windowsService.perform(parent, { kind: 'newTab' }), /require macOS/);
});

test('WindowsMainService closes a new tab when its parent closes during creation', async () => {
	const parent = new TestWindow(1, 'Parent');
	const tab = new TestWindow(2, 'Tab');
	let resolveTab!: (window: TestWindow) => void;
	const pendingTab = new Promise<TestWindow>(resolve => { resolveTab = resolve; });
	using service = createWindowsService(() => [parent], () => pendingTab.then(tab => registerWindow(service, tab)), 'darwin');
	const opening = service.perform(parent, { kind: 'newTab' });
	parent.destroyed = true;
	resolveTab(tab);
	await opening;
	assert.deepEqual({ parent: parent.calls, tab: tab.calls }, { parent: [], tab: ['close'] });
});

test('window operation IPC validates commands before dispatching to the window host', () => {
	const window = new TestWindow(1, 'First');
	using service = createWindowsService(() => [window], async () => undefined);
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

function registerWindow(service: WindowsMainService<TestWindow>, window: TestWindow, workspace: IAnyWorkspaceIdentifier = createEmptyWorkspaceIdentifier()): TestWindow {
	return service.createWindow(() => window, {
		workspace,
		reopen: async () => { },
		state: { mode: WindowMode.Normal, ...window.bounds },
		title: window.getTitle(),
		webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: '', additionalArguments: [] },
	}, new DisposableStore()).win;
}

function createWindowsService(windows: () => readonly TestWindow[], create: ConstructorParameters<typeof WindowsMainService<TestWindow>>[0], platform: NodeJS.Platform = process.platform): WindowsMainService<TestWindow> {
	const service = windowServices.createInstance(WindowsMainService<TestWindow>, create, platform, nodeWorkspacePathService);
	for (const window of windows()) {
		if (window) registerWindow(service, window);
	}
	return service;
}

test('platform window owner tracks activation, workspace changes and close without a product registry', () => {
	using service = windowServices.createInstance(WindowsMainService<TestWindow>, async () => undefined, process.platform, nodeWorkspacePathService);
	const first = registerWindow(service, new TestWindow(1, 'First'), { id: 'first' });
	const second = registerWindow(service, new TestWindow(2, 'Second'), { id: 'second' });
	assert.equal(service.getLastActiveWindow(), second);
	first.emitFocus();
	assert.equal(service.getLastActiveWindow(), first);
	service.updateWorkspace(first.id, { id: 'changed' });
	assert.equal(service.findWorkspace({ id: 'first' }), undefined);
	assert.equal(service.findWorkspace({ id: 'changed' }), first);
	first.destroy();
	assert.equal(service.getLastActiveWindow(), second);
	assert.equal(service.getWindowCount(), 1);
	assert.equal(service.getWindowById(first.id), undefined);
	second.destroy();
	assert.equal(service.getLastActiveWindow(), undefined);
	assert.equal(service.getWindowCount(), 0);
	assert.throws(() => service.updateWorkspace(first.id, { id: 'changed' }), /not registered/);
});

test('managed windows share activation, sizing and last-closed placement without taking workspace reuse', async () => {
	const workbench = new TestWindow(1, 'Workbench');
	let reused: TestWindow | undefined;
	using service = createWindowsService(() => [workbench], async (_configuration, window) => { reused = window; return window; });
	const agents = new TestWindow(2, 'Agents');
	agents.bounds = { x: 180, y: 140, width: 900, height: 600 };
	await service.openManagedWindow('agents', () => agents, {
		title: 'Agents', state: { ...agents.bounds, mode: WindowMode.Normal },
		webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: '', additionalArguments: [] },
		initialize: async () => { },
	}, () => { });
	assert.equal(service.getLastActiveWindow(), agents);
	service.updateWorkspace(agents.id, { id: 'updated-agents-workspace' });
	assert.equal(service.getWindowById(agents.id)!.openedWorkspace.id, 'updated-agents-workspace');
	workbench.emitFocus();
	assert.equal(service.getLastActiveWindow(), workbench);
	agents.emitFocus();
	assert.equal(service.getLastActiveWindow(), agents);
	const display = { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 } };
	const handler = new WindowsStateHandler({
		workspace: createEmptyWorkspaceIdentifier(),
		stateService: { getItem: () => undefined, setItem: () => { }, removeItem: () => { }, flush: async () => { }, close: async () => { } },
		displayService: { onDidChangeDisplays: Event.None, getAllDisplays: () => [display], getPrimaryDisplay: () => display, getCursorDisplay: () => display, getDisplayMatching: () => display },
	});
	assert.deepEqual(service.getNewWindowState(handler, { 'window.newWindowDimensions': 'offset' }, false), {
		mode: WindowMode.Normal, x: 210, y: 170, width: 900, height: 600, displayId: display.id, workArea: display.workArea,
	});
	assert.throws(() => service.getNewWindowState(handler, { 'window.newWindowDimensions': 'unknown' }, false), TypeError);
	await service.open({ workspace: { kind: WorkspaceOpenTargetKind.Folder, path: '/project' }, files: [], forceReuseWindow: true, forceNewWindow: false, cwd: '/', waitForFiles: false });
	assert.equal(reused, workbench);
	workbench.close();
	agents.close();
	assert.deepEqual(service.getNewWindowState(handler, {}, false), { ...agents.bounds, mode: WindowMode.Normal });
});

test('platform window owner reuses the most recently active folder or workspace file', () => {
	using service = windowServices.createInstance(WindowsMainService<TestWindow>, async () => undefined, process.platform, nodeWorkspacePathService);
	const folder = URI.file('/repo/project');
	const first = registerWindow(service, new TestWindow(1, 'First'), { id: 'first', uri: folder });
	const second = registerWindow(service, new TestWindow(2, 'Second'), { id: 'second', uri: folder });
	assert.equal(service.findWorkspace({ id: 'different', uri: folder }), second);
	first.emitFocus();
	assert.equal(service.findWorkspace({ id: 'different', uri: folder }), first);
	const configPath = URI.file('/repo/project.ash-workspace');
	service.updateWorkspace(first.id, { id: 'workspace', configPath });
	assert.equal(service.findWorkspace({ id: 'new-id', configPath }), first);
});

test('platform window owner coalesces opens through renderer startup and focuses the existing window', async () => {
	using service = windowServices.createInstance(WindowsMainService<TestWindow>, async () => undefined, process.platform, nodeWorkspacePathService);
	const workspace = { id: 'pending' };
	let finishStartup!: () => void;
	const startup = new Promise<void>(resolve => { finishStartup = resolve; });
	const window = new TestWindow(1, 'Pending');
	let creations = 0;
	const first = service.openWorkspace(workspace, async () => {
		creations++;
		registerWindow(service, window, workspace);
		await startup;
		return window;
	});
	const second = service.openWorkspace(workspace, async () => assert.fail('pending workspace must not be recreated'));
	assert.equal(first, second);
	assert.deepEqual({ creations, calls: window.calls }, { creations: 1, calls: [] });
	finishStartup();
	assert.equal(await first, window);
	assert.equal(await second, window);
	assert.equal(await service.openWorkspace(workspace, async () => assert.fail('live workspace must not be recreated')), window);
	assert.deepEqual(window.calls, ['focus']);
});

test('platform window owner releases a failed opening for an explicit retry', async () => {
	using service = windowServices.createInstance(WindowsMainService<TestWindow>, async () => undefined, process.platform, nodeWorkspacePathService);
	const workspace = { id: 'failed' };
	await assert.rejects(service.openWorkspace(workspace, async () => { throw new Error('startup failed'); }), /startup failed/);
	const window = new TestWindow(1, 'Retry');
	assert.equal(await service.openWorkspace(workspace, async () => registerWindow(service, window, workspace)), window);
});


test('auxiliary close, focus and zoom operations stay in their owner and shared zoom reaches every window', () => {
	const parent = new TestWindow(301, 'Workbench');
	const child = new TestWindow(302, 'Editor');
	const other = new TestWindow(303, 'Other');
	const name = 'ash-auxiliary-12345678-1234-1234-1234-123456789abc';
	child.webContents.mainFrame.name = name;
	using service = createWindowsService(() => [parent, other], async () => undefined);
	using registration = windowServices.get(IAuxiliaryWindowsMainService).registerWindow(child.webContents as unknown as WebContents, parent.id);
	const route = windowOperationIpcRoute(service, parent);
	route.invoke(route.validate({ kind: 'focusSelf', windowName: name }));
	assert.deepEqual(child.calls, ['focus']);
	assert.deepEqual(parent.calls, []);
	route.invoke(route.validate({ kind: 'setZoom', level: 2, windowName: name }));
	assert.equal(route.invoke(route.validate({ kind: 'getZoom', windowName: name })), 2);
	assert.deepEqual([parent.zoomLevel, child.zoomLevel, other.zoomLevel], [0, 2, 0]);
	route.invoke(route.validate({ kind: 'setZoom', level: 1, allWindows: true }));
	assert.deepEqual([parent.zoomLevel, child.zoomLevel, other.zoomLevel], [1, 1, 0]);
	assert.throws(() => route.validate({ kind: 'setZoom', level: 2, windowName: name, allWindows: true }), /Invalid/);
	for (const kind of ['close', 'focusSelf', 'getZoom', 'setZoom'] as const) {
		assert.throws(() => windowOperationIpcRoute(service, other).invoke({ kind, windowName: name, ...(kind === 'setZoom' ? { level: 2 } : {}) }), /belongs to another/);
	}
	route.invoke(route.validate({ kind: 'closeOthers' }));
	assert.equal(other.destroyed, true);
	assert.equal(child.destroyed, false);
	route.invoke(route.validate({ kind: 'close', windowName: name }));
	assert.equal(child.destroyed, true);
	assert.equal(parent.destroyed, false);
});


test('auxiliary state events report host bounds fullscreen and pin state only to the owner', () => {
	const parent = new TestWindow(401, 'Workbench');
	const child = new TestWindow(402, 'Editor');
	const other = new TestWindow(403, 'Other');
	const name = 'ash-auxiliary-12345678-1234-1234-1234-123456789abc';
	child.webContents.mainFrame.name = name;
	child.bounds = { x: 35, y: 45, width: 850, height: 600 };
	using service = createWindowsService(() => [parent, other], async () => undefined);
	using registration = windowServices.get(IAuxiliaryWindowsMainService).registerWindow(child.webContents as unknown as WebContents, parent.id);
	child.emitFullscreenChanged(true);
	child.setAlwaysOnTop(true);
	const states = parent.messages.filter(message => message.channel === AUXILIARY_WINDOW_STATE_CHANGED_CHANNEL).map(message => validateAuxiliaryWindowStateEvent(message.level));
	assert.equal(states.length, 2);
	assert.deepEqual(states[1], { windowName: name, state: { width: 850, height: 600, left: 35, top: 45, mode: 'fullscreen', zoomLevel: 0, alwaysOnTop: true } });
	assert.deepEqual(other.messages, []);
	assert.deepEqual(service.perform(parent, { kind: 'getAuxiliaryState', windowName: name }), states[1]!.state);
	assert.throws(() => service.perform(other, { kind: 'getAuxiliaryState', windowName: name }), /belongs to another/);
	assert.throws(() => validateAuxiliaryWindowStateEvent({ windowName: name, state: { ...states[1]!.state, width: NaN } }), /Invalid auxiliary window state/);
	assert.throws(() => validateAuxiliaryWindowStateEvent({ ...states[1], windowName: 'foreign' }), /Invalid auxiliary window state event/);
});


test('waiting launches finish for the replaced document while a new wait follows the live document', async () => {
	const window = new TestWindow(1, 'Workbench');
	using service = createWindowsService(() => [window], async () => window);
	const configuration: IOpenConfiguration = { cwd: '/project', files: [], forceNewWindow: false, forceReuseWindow: true, waitForFiles: true };
	const initial = await service.open(configuration);
	let firstFinished = false;
	void initial.whenClosed.then(() => { firstFinished = true; });
	window.emitNavigation(true, true);
	window.emitNavigation(false, false);
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(firstFinished, false);
	window.emitNavigation(false, true);
	await initial.whenClosed;
	const next = await service.open(configuration);
	let nextFinished = false;
	void next.whenClosed.then(() => { nextFinished = true; });
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(nextFinished, false);
	window.close();
	await next.whenClosed;
});


test('a canceled file launch is removed from the window queue before the next renderer signals ready', async () => {
	const window = new TestWindow(1, 'Workbench');
	using service = createWindowsService(() => [window], async () => window);
	const opening = service.open({ cwd: '/project', files: [{ uri: 'file:///project/file.ts' }], forceNewWindow: false, forceReuseWindow: true, waitForFiles: true });
	const canceled = assert.rejects(opening, /Window closed before opening/);
	await new Promise(resolve => setImmediate(resolve));
	window.emitNavigation(false, true);
	await canceled;
	service.respondToFileOpen(window, { kind: 'ready' });
	service.respondToFileOpen(window, { kind: 'ready' });
	assert.deepEqual(window.messages, []);
});


test('window lists retain caller identity when another window owns OS focus and restrict auxiliary selection', () => {
	const parent = new TestWindow(1, 'Workbench');
	const other = new TestWindow(2, 'Other');
	const child = new TestWindow(3, 'Editor');
	const name = 'ash-auxiliary-12345678-1234-1234-1234-123456789abc';
	child.webContents.mainFrame.name = name;
	other.focused = true;
	using service = createWindowsService(() => [parent, other], async () => undefined);
	using registration = windowServices.get(IAuxiliaryWindowsMainService).registerWindow(child.webContents as unknown as WebContents, parent.id);
	assert.deepEqual(service.perform(parent, { kind: 'list' }), [
		{ id: 1, title: 'Workbench', focused: false, current: true },
		{ id: 2, title: 'Other', focused: true, current: false },
		{ id: 3, title: 'Editor', focused: false, current: false },
	]);
	const route = windowOperationIpcRoute(service, parent);
	const operation = route.validate({ kind: 'list', windowName: name });
	assert.deepEqual(route.invoke(operation), [
		{ id: 1, title: 'Workbench', focused: false, current: false },
		{ id: 2, title: 'Other', focused: true, current: false },
		{ id: 3, title: 'Editor', focused: false, current: true },
	]);
	assert.throws(() => windowOperationIpcRoute(service, other).invoke(operation), /belongs to another workbench/);
	assert.throws(() => route.validate({ kind: 'list', windowId: parent.id }), /Invalid window operation/);
	assert.throws(() => route.validate({ kind: 'list', windowName: 'foreign' }), /Invalid window operation/);
});
