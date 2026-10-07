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
import { WINDOW_FULLSCREEN_CHANGED_CHANNEL, WINDOW_OPERATION_CHANNEL, WINDOW_PREPARE_CLOSE_CHANNEL, WINDOW_ZOOM_CHANGED_CHANNEL } from '../../../window/common/window.js';
import { LifecycleMainService } from '../../../lifecycle/electron-main/lifecycleMainService.js';
import { WindowMode, type IWindowBounds } from '../../../window/electron-main/window.js';
import type { IAnyWorkspaceIdentifier } from '../../../workspace/common/workspace.js';
import { createEmptyWorkspaceIdentifier, getSingleFolderWorkspaceIdentifier } from '../../../workspaces/node/workspaces.js';
import { WindowsMainService, windowOperationIpcRoute, workspaceRecoveryIpcRoute, type IWorkbenchWindow } from '../../electron-main/windowsMainService.js';
import type { IOpenConfiguration } from '../../electron-main/windows.js';
import { WINDOW_OPEN_FILES_CHANNEL, validateWindowFilesRequest, validateWindowFilesResponse } from '../../../window/common/window.js';
import { WindowsStateHandler } from '../../electron-main/windowsStateHandler.js';
import { Event } from '../../../../base/common/event.js';
import { WorkspaceOpenTargetKind } from '../../../environment/common/argv.js';

let windowServices: InstantiationService;
setup(() => {
	windowServices = new InstantiationService();
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

class TestWindow implements IWorkbenchWindow<TestWindow> {
	public readonly calls: string[] = [];
	public readonly messages: { readonly channel: string; readonly level: unknown; }[] = [];
	private readonly zoomListeners = new Set<() => void>();
	private readonly closeListeners = new Set<(event: { preventDefault(): void; }) => void>();
	private readonly fullscreenListeners = new Map<string, Set<() => void>>();
	private readonly rendererListeners = new Map<string, Set<() => void>>();
	private readonly onceListeners = new Map<string, Set<() => void>>();
	public readonly webContents = {
		getOwnerBrowserWindow: (): BrowserWindow => this as unknown as BrowserWindow,
		isDestroyed: (): boolean => this.destroyed,
		getZoomLevel: (): number => this.zoomLevel,
		getZoomFactor: (): number => 1.2 ** this.zoomLevel,
		setZoomLevel: (level: number): void => { this.zoomLevel = level; },
		on: (event: 'zoom-changed' | 'did-start-loading' | 'render-process-gone', listener: () => void): void => { const listeners = event === 'zoom-changed' ? this.zoomListeners : this.rendererListeners.get(event) ?? new Set<() => void>(); listeners.add(listener); if (event !== 'zoom-changed') this.rendererListeners.set(event, listeners); },
		off: (event: 'zoom-changed' | 'did-start-loading' | 'render-process-gone', listener: () => void): void => { if (this.destroyed) throw new Error('Object has been destroyed'); (event === 'zoom-changed' ? this.zoomListeners : this.rendererListeners.get(event))?.delete(listener); },
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
	public on(event: 'closed' | 'focus' | 'enter-full-screen' | 'leave-full-screen', listener: () => void): void;
	public on(event: 'close' | 'closed' | 'focus' | 'enter-full-screen' | 'leave-full-screen', listener: ((event: { preventDefault(): void; }) => void) | (() => void)): void {
		if (event === 'close') this.closeListeners.add(listener as (event: { preventDefault(): void; }) => void);
		else { const listeners = this.fullscreenListeners.get(event) ?? new Set<() => void>(); listeners.add(listener as () => void); this.fullscreenListeners.set(event, listeners); }
	}
	public off(event: 'close', listener: (event: { preventDefault(): void; }) => void): void;
	public off(event: 'closed' | 'focus' | 'enter-full-screen' | 'leave-full-screen', listener: () => void): void;
	public off(event: 'close' | 'closed' | 'focus' | 'enter-full-screen' | 'leave-full-screen', listener: ((event: { preventDefault(): void; }) => void) | (() => void)): void {
		if (event === 'close') this.closeListeners.delete(listener as (event: { preventDefault(): void; }) => void);
		else this.fullscreenListeners.get(event)?.delete(listener as () => void);
	}

	public emitFocus(): void { for (const listener of this.fullscreenListeners.get('focus') ?? []) listener(); }
	public isDestroyed(): boolean { return this.destroyed; }
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
	public setBounds(bounds: IWindowBounds): void { this.bounds = bounds; }
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
		return reuse ?? created;
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
		state: { mode: WindowMode.Normal, width: 1000, height: 700 },
		webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: '', additionalArguments: [] },
	}, new DisposableStore()).win;
	let ready = false;
	const restored = service.whenReady(window).then(() => { ready = true; });
	window.emitRendererEvent('did-start-loading');
	await new Promise<void>(resolve => setImmediate(resolve));
	assert.equal(ready, false);
	service.respondToFileOpen(window, { kind: 'ready' });
	await restored;
	assert.equal(ready, true);
	window.emitRendererEvent('did-start-loading');
	const closed = assert.rejects(service.whenReady(window), /Window closed before its renderer/);
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
	using service = createWindowsService(() => [], async () => undefined);
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
	using service = createWindowsService(() => [parent], async () => undefined);
	const registration = windowServices.get(IAuxiliaryWindowsMainService).registerWindow(child.webContents as unknown as WebContents, parent.id);
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
	using nextRegistration = windowServices.get(IAuxiliaryWindowsMainService).registerWindow(next.webContents as unknown as WebContents, parent.id);
	service.perform(parent, { kind: 'closeOthers' });
	assert.deepEqual(next.calls, ['close']);
	assert.equal(next.isDestroyed(), true);
});

test('auxiliary creation validates popup bounds independently of whether a position was restored', () => {
	const service = windowServices.get(IAuxiliaryWindowsMainService);
	const request = (features: string): HandlerDetails => ({ url: 'about:blank', features, frameName: '', disposition: 'new-window', referrer: { url: '', policy: 'default' } });
	assert.deepEqual(service.createWindow(request('popup=yes,width=700,height=530')), { width: 700, height: 530 });
	assert.deepEqual(service.createWindow(request('width=700,height=530,x=-120,y=90')), { width: 700, height: 530, x: -120, y: 90 });
	assert.deepEqual(service.createWindow(request('left=120,top=90')), { x: 120, y: 90 });
	for (const features of ['width=0', 'height=-1', 'x=NaN', 'width=', 'height=1.5']) {
		assert.throws(() => service.createWindow(request(features)), /Invalid auxiliary window/);
	}
	assert.throws(() => service.createWindow({ ...request(''), url: 'https://example.com' }), /same-origin document/);
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
		windows: [{ id: 1, title: 'Workbench', focused: false }],
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

test('WindowsMainService keeps a managed window open after a failed close and permits retry', async () => {
	using service = createWindowsService(() => [], async () => undefined);
	using lifecycle = new LifecycleMainService<TestWindow>((window, message) => service.failManagedWindowClose(window, message), window => service.failManagedWindowClose(window, 'Window close was vetoed'), {
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

test('WindowsMainService sends zoom changes and releases its window listener', async () => {
	const window = new TestWindow(1, 'First');
	using service = createWindowsService(() => [window], async () => undefined);
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
	using service = createWindowsService(() => [window], async () => undefined);
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
	using service = createWindowsService(() => [window], async () => undefined);
	const tracking = service.trackZoomLevel(window);
	window.destroyed = true;
	assert.doesNotThrow(() => tracking.dispose());
});

test('WindowsMainService creates a new macOS window tab and joins it to its parent', async () => {
	const parent = new TestWindow(1, 'Parent');
	const tab = new TestWindow(2, 'Tab');
	let creations = 0;
	using service = createWindowsService(() => [parent], async () => {
		creations += 1;
		return tab;
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
	using service = createWindowsService(() => [parent], () => pendingTab, 'darwin');
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
