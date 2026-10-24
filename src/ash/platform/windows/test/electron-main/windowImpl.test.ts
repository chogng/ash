import assert from 'node:assert/strict';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { setup, teardown, test } from 'mocha';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import type { MessageBoxOptions, MessageBoxReturnValue } from '../../../../base/parts/sandbox/common/electronTypes.js';
import { DeferredPromise } from '../../../../base/common/async.js';
import { InstantiationService } from '../../../instantiation/common/instantiationService.js';
import { IAuxiliaryWindowsMainService } from '../../../auxiliaryWindow/electron-main/auxiliaryWindows.js';
import { AuxiliaryWindowsMainService } from '../../../auxiliaryWindow/electron-main/auxiliaryWindowsMainService.js';
import { ColorScheme } from '../../../theme/common/theme.js';
import { IThemeMainService } from '../../../theme/electron-main/themeMainService.js';
import { ThemeMainService } from '../../../theme/electron-main/themeMainServiceImpl.js';
import { ILogService, NullLoggerService } from '../../../log/common/log.js';
import { DialogMainService, IDialogMainService } from '../../../dialogs/electron-main/dialogMainService.js';
import { LifecycleMainService, ILifecycleMainService } from '../../../lifecycle/electron-main/lifecycleMainService.js';
import { resetNlsResolver, setNlsMessages } from '../../../../nls.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { WINDOW_PREPARE_RELOAD_CHANNEL } from '../../../window/common/window.js';
import { readFile } from 'node:fs/promises';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { WindowMode, LoadReason, type IWindowBounds } from '../../../window/electron-main/window.js';
import { CodeWindow, type ICodeWindowHandle } from '../../electron-main/windowImpl.js';
import type { IWindowConstructorOptions } from '../../electron-main/windows.js';

let windowServices: InstantiationService;
let cleanup: DisposableStore;
let lifecycle: LifecycleMainService<TestWindow>;
let showMessageBox: (options: MessageBoxOptions) => Promise<MessageBoxReturnValue>;
setup(() => {
	cleanup = new DisposableStore();
	windowServices = new InstantiationService();
	windowServices.registerInstance(ILogService, new NullLoggerService());
	windowServices.registerSingleton(IThemeMainService, () => {
		const state = new Map<string, unknown>();
		return new ThemeMainService({
			shouldUseDarkColors: false, shouldUseHighContrastColors: false, on: () => { }, removeListener: () => { },
		}, {
			getItem: key => state.get(key), setItem: (key, value) => { state.set(key, value); }, removeItem: key => { state.delete(key); },
			flush: async () => { }, close: async () => { },
		});
	});
	windowServices.registerSingleton(IAuxiliaryWindowsMainService, () => new AuxiliaryWindowsMainService(() => null));
	showMessageBox = async () => ({ response: 1, checkboxChecked: false });
	const dialogs = new DialogMainService({
		showMessageBox: options => showMessageBox(options),
		showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
		showSaveDialog: async () => ({ canceled: true, filePath: '' }),
	});
	windowServices.registerInstance(IDialogMainService, dialogs);
	lifecycle = new LifecycleMainService<TestWindow>(() => { }, () => { }, {
		getItem: () => undefined, setItem: () => { }, removeItem: () => { }, flush: async () => { }, close: async () => { },
	}, 'test');
	// The test host supplies the same domain contract with a synthetic window.
	windowServices.registerInstance(ILifecycleMainService, lifecycle as unknown as ILifecycleMainService);
	cleanup.add(dialogs);
	cleanup.add(lifecycle);
});
teardown(() => {
	windowServices.dispose();
	cleanup.dispose();
	resetNlsResolver();
});
ensureNoDisposablesAreLeakedInTestSuite();

class TestWindow extends EventEmitter implements ICodeWindowHandle<TestWindow> {
	public readonly messageHooks = new Map<number, (wParam: Buffer, lParam: Buffer) => void>();
	public hookWindowMessage(message: number, callback: (wParam: Buffer, lParam: Buffer) => void): void { this.messageHooks.set(message, callback); }
	public unhookWindowMessage(message: number): void { this.messageHooks.delete(message); }
	public readonly id = 1;
	public readonly loads: string[] = [];
	public reloads = 0;
	public readonly messages: { channel: string; token: unknown; }[] = [];
	public readonly webContents = Object.assign(new EventEmitter(), {
		isDestroyed: (): boolean => this.destroyed,
		getZoomLevel: (): number => 0,
		reload: (): void => { this.reloads++; this.navigate(); },
		send: (channel: string, token: unknown): void => { this.messages.push({ channel, token }); },
	});
	public destroyed = false;
	public shown = 0;
	public minimized = false;
	public focused = 0;
	public isMinimized(): boolean { return this.minimized; }
	public restore(): void { this.minimized = false; }
	public focus(): void { this.focused++; this.emit('focus'); }
	public isFullScreen(): boolean { return this.fullscreen; }
	public isMaximized(): boolean { return this.maximized > 0; }
	public getNormalBounds(): IWindowBounds { return this.bounds; }
	public addTabbedWindow(_window: TestWindow): void { }

	public maximized = 0;
	public fullscreen = false;
	public bounds: IWindowBounds = { x: 0, y: 0, width: 800, height: 600 };
	public frameRounding = { width: 0, height: 0 };

	public isDestroyed(): boolean { return this.destroyed; }
	public show(): void { this.shown++; }
	public getBounds(): IWindowBounds { return this.bounds; }
	public setTitleBarOverlay(_colors: { color: string; symbolColor: string; height: number; }): void { }
	public setBounds(bounds: IWindowBounds): void { this.bounds = { ...bounds, width: bounds.width + this.frameRounding.width, height: bounds.height + this.frameRounding.height }; }
	public maximize(): void { this.maximized++; }
	public setFullScreen(fullscreen: boolean): void { this.fullscreen = fullscreen; }
	public async loadURL(url: string): Promise<void> { this.loads.push(url); this.navigate(); }
	public async loadFile(path: string): Promise<void> { this.loads.push(path); this.navigate(); }
	public navigate(inPlace = false, mainFrame = true): void { this.webContents.emit('did-start-navigation', undefined, 'file:///synthetic/workbench.html', inPlace, mainFrame); }
	public close(): void { this.destroy(); }
	public destroy(): void {
		if (this.destroyed) return;
		this.destroyed = true;
		this.messageHooks.clear();
		this.emit('closed');
	}
}

test('CodeWindow supplies startup theme colors before showing workbench and Agents windows', () => {
	for (const title of ['Workbench', 'Sessions']) {
		const window = new TestWindow();
		let received: IWindowConstructorOptions | undefined;
		using host = windowServices.createInstance(CodeWindow<TestWindow>, (options: IWindowConstructorOptions) => {
			received = options;
			assert.equal(window.shown, 0);
			return window;
		}, {
			state: { mode: WindowMode.Normal, width: 1000, height: 700 },
			reopen: async () => { },
			webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: '', additionalArguments: [] },
			title, backgroundColor: '#ffffff',
		}, new DisposableStore());
		assert.equal(received?.backgroundColor, '#ffffff');
		if (process.platform === 'win32' || process.platform === 'linux') {
			assert.deepEqual(received?.titleBarOverlay, { color: '#ffffff', symbolColor: '#000000', height: 35 });
		}
		assert.equal(window.shown, 0);
		host.win.emit('ready-to-show');
		assert.equal(window.shown, 1);
	}
});

test('CodeWindow applies Windows startup bounds before tracking and showing every window mode', () => {
	for (const mode of [WindowMode.Normal, WindowMode.Maximized, WindowMode.Fullscreen]) {
		const bounds = { x: -1600, y: 80, width: 1440, height: 900 };
		const window = new TestWindow();
		window.frameRounding = { width: 2, height: 1 };
		const constructorBounds = window.bounds;
		using host = windowServices.createInstance(CodeWindow<TestWindow>, () => window, {
			state: { mode, ...bounds },
			reopen: async () => { },
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

test('CodeWindow restores saved dimensions across fractional DPI rounding plateaus', function () {
	if (process.platform !== 'win32') {
		this.skip();
	}
	const window = new TestWindow();
	const saved = { x: 454, y: 206, width: 1002, height: 702 };
	// At 125% scaling, both 1002/1001 and 702/701 requests produced the same
	// outer size. The next lower request reached the saved physical rectangle.
	window.setBounds = bounds => {
		window.bounds = {
			...bounds,
			width: bounds.width >= 1001 ? 1003 : 1002,
			height: bounds.height >= 701 ? 703 : 702,
		};
	};
	using host = windowServices.createInstance(CodeWindow<TestWindow>, () => window, {
		state: { mode: WindowMode.Normal, ...saved },
		reopen: async () => { },
		webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: '', additionalArguments: [] },
		title: 'Sessions',
	}, new DisposableStore());
	assert.deepEqual(host.win.getBounds(), saved);
	host.win.emit('ready-to-show');
	assert.deepEqual(host.win.getBounds(), saved);
});

test('CodeWindow stops compensating when OS constraints prevent restoring the saved size', function () {
	if (process.platform !== 'win32') {
		this.skip();
	}
	const window = new TestWindow();
	let requests = 0;
	window.setBounds = bounds => {
		assert.ok(bounds.width > 0 && bounds.height > 0);
		requests++;
		window.bounds = { ...bounds, width: Math.max(bounds.width, 1500), height: Math.max(bounds.height, 1000) };
	};
	using host = windowServices.createInstance(CodeWindow<TestWindow>, () => window, {
		state: { mode: WindowMode.Normal, x: 20, y: 30, width: 1002, height: 702 },
		reopen: async () => { },
		webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: '', additionalArguments: [] },
		title: 'Sessions',
	}, new DisposableStore());
	assert.ok(requests <= 4);
	assert.deepEqual(host.win.getBounds(), { x: 20, y: 30, width: 1500, height: 1000 });
});

test('CodeWindow restores state when ready and releases resources when closed', () => {
	const resources = new DisposableStore();
	let released = 0;
	resources.add(toDisposable(() => { released++; }));
	const host = windowServices.createInstance(CodeWindow<TestWindow>, () => new TestWindow(), {
		state: { mode: WindowMode.Maximized, width: 1000, height: 700 },
		reopen: async () => { },
		webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: '', additionalArguments: [] },
		title: 'Workbench',
	}, resources);
	const window = host.win;
	window.emit('ready-to-show');
	assert.deepEqual({ shown: window.shown, maximized: window.maximized }, { shown: 1, maximized: 1 });
	window.destroy();
	assert.deepEqual({ released, disposed: host.isDisposed }, { released: 1, disposed: true });
});

test('CodeWindow closes a renderer lost before loading and releases startup resources', () => {
	const errors: unknown[][] = [];
	windowServices.get(ILogService).error = (...args: unknown[]): void => { errors.push(args); };
	const resources = new DisposableStore();
	let released = 0;
	resources.add(toDisposable(() => { released++; }));
	const host = windowServices.createInstance(CodeWindow<TestWindow>, () => new TestWindow(), {
		state: { mode: WindowMode.Normal, width: 1000, height: 700 },
		reopen: async () => { },
		webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: '', additionalArguments: [] },
		title: 'Sessions',
	}, resources);
	host.win.webContents.emit('render-process-gone', undefined, { reason: 'crashed', exitCode: 139 });
	assert.deepEqual({ destroyed: host.win.destroyed, released }, { destroyed: true, released: 1 });
	assert.deepEqual(errors[0], ['window', 'Renderer process gone', { windowId: host.id, reason: 'crashed', exitCode: 139 }]);
});

function createHost(window = new TestWindow(), reopen: () => Promise<void> = async () => { }): CodeWindow<TestWindow> {
	return windowServices.createInstance(CodeWindow<TestWindow>, () => window, {
		state: { mode: WindowMode.Normal, width: 1000, height: 700 },
		reopen,
		webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: '', additionalArguments: [] },
		title: 'Workbench',
	}, new DisposableStore());
}

test('CodeWindow preserves native client pixels, coalesces resize and releases its message hook', async function () {
	if (process.platform !== 'win32') this.skip();
	const window = new TestWindow();
	using host = createHost(window);
	const resize = (width: number, height: number, kind = 0): void => {
		const wParam = Buffer.alloc(8);
		const lParam = Buffer.alloc(8);
		wParam.writeUInt32LE(kind);
		lParam.writeUInt16LE(width, 0);
		lParam.writeUInt16LE(height, 2);
		window.messageHooks.get(0x0005)!(wParam, lParam);
	};
	assert.equal(host.getClientSize(), undefined);
	resize(1500, 999);
	assert.deepEqual(host.getClientSize(), { width: 1500, height: 999 });
	resize(1501, 1001);
	resize(0, 0, 1);
	resize(1501, 1001);
	await new Promise<void>(resolve => setImmediate(resolve));
	assert.deepEqual(window.messages, [{ channel: 'ash:window:client-size-changed', token: { width: 1501, height: 1001 } }]);
	resize(1500, 997);
	host.dispose();
	assert.equal(window.messageHooks.size, 0);
	await new Promise<void>(resolve => setImmediate(resolve));
	assert.equal(window.messages.length, 1);
});

const packagedEntry = { file: '/synthetic/workbench.html', url: 'file:///synthetic/workbench.html', useDevelopmentUrl: false };

test('CodeWindow creation fails before creating an OS window when a required service is missing', () => {
	using services = new InstantiationService();
	let created = false;
	using resources = new DisposableStore();
	assert.throws(() => services.createInstance(CodeWindow<TestWindow>, () => { created = true; return new TestWindow(); }, {
		state: { mode: WindowMode.Normal, width: 1000, height: 700 },
		reopen: async () => { },
		webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: '', additionalArguments: [] },
		title: 'Workbench',
	}, resources), /Unknown service: logService/);
	assert.equal(created, false);
});

test('CodeWindow readiness follows the latest document and closing releases pending waiters', async () => {
	using host = createHost();
	let signals = 0;
	using listener = host.onDidSignalReady(() => { signals++; });
	const first = host.ready();
	host.setReady();
	host.setReady();
	assert.equal(await first, host);
	assert.equal(signals, 1);
	await host.load(packagedEntry);
	assert.equal(host.isReady, false);
	let ready = false;
	const next = host.ready().then(() => { ready = true; });
	host.win.navigate();
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(ready, false);
	host.setReady();
	await next;
	assert.equal(signals, 2);
	host.win.navigate();
	const closed = assert.rejects(host.ready(), /Window closed before/);
	host.win.destroy();
	await closed;
});

test('CodeWindow shares each reload handshake and respects a renderer veto', async () => {
	using host = createHost();
	using registration = lifecycle.registerWindow(host.win);
	lifecycle.respondToClose(host.win, { kind: 'ready' });
	host.setReady();
	const vetoed = host.reload();
	assert.equal(host.reload(), vetoed);
	await new Promise(resolve => setImmediate(resolve));
	assert.deepEqual(host.win.messages, [{ channel: WINDOW_PREPARE_RELOAD_CHANNEL, token: 1 }]);
	lifecycle.respondToClose(host.win, { kind: 'vetoed', token: 1 });
	await vetoed;
	assert.equal(host.win.reloads, 0);
	assert.equal(host.isReady, true);
	const accepted = host.reload();
	await new Promise(resolve => setImmediate(resolve));
	lifecycle.respondToClose(host.win, { kind: 'complete', token: 2 });
	await accepted;
	assert.equal(host.win.reloads, 1);
	assert.equal(host.isReady, false);
});

test('CodeWindow waits for development HTML, coalesces recovery, and propagates non-network load errors', async () => {
	let requests = 0;
	const server = createServer((_request, response) => {
		requests++;
		response.writeHead(requests === 1 ? 503 : 200).end('synthetic renderer');
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	try {
		const address = server.address();
		assert.ok(address && typeof address !== 'string');
		const entry = { file: '', url: `http://127.0.0.1:${address.port}/workbench.html`, useDevelopmentUrl: true };
		using host = createHost();
		const loading = host.load(entry);
		assert.equal(host.load(entry), loading);
		await loading;
		assert.equal(requests, 2);
		assert.deepEqual(host.win.loads, [entry.url]);
		host.win.loadURL = async () => { throw new Error('load host failed'); };
		await assert.rejects(host.load(entry), /load host failed/);
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
	}
});

test('CodeWindow closing aborts a pending development response and settles its load', async () => {
	const requested = new DeferredPromise<void>();
	const server = createServer(() => { void requested.complete(); });
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	try {
		const address = server.address();
		assert.ok(address && typeof address !== 'string');
		using host = createHost();
		const loading = host.load({ file: '', url: `http://127.0.0.1:${address.port}/`, useDevelopmentUrl: true });
		await requested.p;
		host.win.destroy();
		await loading;
		assert.deepEqual(host.win.loads, []);
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
	}
});

test('CodeWindow cancels an unresponsive prompt on recovery and ignores its late close result', async () => {
	const result = new DeferredPromise<MessageBoxReturnValue>();
	const shown = new DeferredPromise<MessageBoxOptions>();
	showMessageBox = options => { void shown.complete(options); return result.p; };
	using host = createHost();
	host.win.emit('unresponsive');
	host.win.emit('unresponsive');
	const options = await shown.p;
	host.win.emit('responsive');
	assert.equal(options.signal?.aborted, true);
	await result.complete({ response: options.buttons!.indexOf('Close'), checkboxChecked: false });
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(host.win.destroyed, false);
});

test('CodeWindow diagnostics distinguish native unresponsiveness from a shutdown timeout', async () => {
	const errors: unknown[][] = [];
	windowServices.get(ILogService).error = (...args: unknown[]) => { errors.push(args); };
	showMessageBox = async options => ({ response: options.cancelId!, checkboxChecked: false });
	using host = createHost();
	await host.reportWindowError(false);
	const shutdown = new AbortController();
	await host.reportWindowError(false, shutdown.signal);
	assert.deepEqual(errors, [
		['window', 'Window is unresponsive', { windowId: host.win.id, source: 'renderer-unresponsive' }],
		['window', 'Window is unresponsive', { windowId: host.win.id, source: 'shutdown-timeout' }],
	]);
});

test('CodeWindow offers localized crash recovery and replaces the window without a dead-renderer handshake', async () => {
	const messages = JSON.parse(await readFile('extensions/language-pack-zh-cn/translations/workbench.json', 'utf8')) as Record<string, Record<string, string>>;
	setNlsMessages('zh-CN', messages);
	const result = new DeferredPromise<MessageBoxReturnValue>();
	const shown = new DeferredPromise<MessageBoxOptions>();
	showMessageBox = options => { void shown.complete(options); return result.p; };
	let reopened = 0;
	using host = createHost(new TestWindow(), async () => { reopened++; });
	await host.load(packagedEntry);
	host.setReady();
	host.win.webContents.emit('render-process-gone', undefined, { reason: 'crashed', exitCode: 139 });
	assert.equal(host.isReady, false);
	const options = await shown.p;
	assert.equal(options.message, '窗口意外关闭。');
	assert.ok(options.buttons?.includes('重新打开'));
	await result.complete({ response: options.buttons!.indexOf('重新打开'), checkboxChecked: false });
	await new Promise(resolve => setImmediate(resolve));
	assert.deepEqual(host.win.loads, [packagedEntry.file]);
	assert.equal(reopened, 1);
	assert.equal(host.win.destroyed, true);
	assert.equal(host.win.messages.length, 0);
});

test('CodeWindow recovery waits for its new host before destroying the unresponsive window', async () => {
	const replacement = new DeferredPromise<void>();
	const opening = new DeferredPromise<void>();
	showMessageBox = async options => ({ response: options.buttons!.indexOf('Reopen'), checkboxChecked: false });
	using host = createHost(new TestWindow(), () => { void opening.complete(); return replacement.p; });
	await host.load(packagedEntry);
	using registration = lifecycle.registerWindow(host.win);
	lifecycle.respondToClose(host.win, { kind: 'ready' });
	const recovering = host.reportWindowError(false);
	await opening.p;
	assert.deepEqual({ destroyed: host.win.destroyed, reloads: host.win.reloads, messages: host.win.messages }, { destroyed: false, reloads: 0, messages: [] });
	await replacement.complete();
	await recovering;
	assert.equal(host.win.destroyed, true);
	assert.deepEqual(host.win.messages, []);
});

test('CodeWindow shutdown recovery survives responsive events and ignores a choice after shutdown completes', async () => {
	const shown = new DeferredPromise<MessageBoxOptions>();
	const result = new DeferredPromise<MessageBoxReturnValue>();
	showMessageBox = options => { void shown.complete(options); return result.p; };
	let reopened = 0;
	using host = createHost(new TestWindow(), async () => { reopened++; });
	const shutdown = new AbortController();
	const recovering = host.reportWindowError(false, shutdown.signal);
	const options = await shown.p;
	assert.deepEqual([...options.buttons!].sort(), ['Close', 'Keep Waiting', 'Reopen']);
	assert.equal(options.buttons![options.cancelId!], 'Keep Waiting');
	assert.equal(options.buttons![options.defaultId!], 'Keep Waiting');
	host.win.emit('responsive');
	assert.equal(options.signal?.aborted, false);
	shutdown.abort();
	assert.equal(options.signal?.aborted, true);
	await result.complete({ response: options.buttons!.indexOf('Reopen'), checkboxChecked: false });
	await recovering;
	assert.deepEqual({ reopened, destroyed: host.win.destroyed }, { reopened: 0, destroyed: false });
});

test('CodeWindow attaches shutdown cancellation to an already visible unresponsive prompt', async () => {
	const shown = new DeferredPromise<MessageBoxOptions>();
	const result = new DeferredPromise<MessageBoxReturnValue>();
	let prompts = 0;
	showMessageBox = options => { prompts++; void shown.complete(options); return result.p; };
	using host = createHost();
	const nativeRecovery = host.reportWindowError(false);
	const options = await shown.p;
	const shutdown = new AbortController();
	const shutdownRecovery = host.reportWindowError(false, shutdown.signal);
	host.win.emit('responsive');
	assert.equal(options.signal?.aborted, false);
	shutdown.abort();
	assert.equal(options.signal?.aborted, true);
	await result.complete({ response: options.buttons!.indexOf('Close'), checkboxChecked: false });
	await Promise.all([nativeRecovery, shutdownRecovery]);
	assert.deepEqual({ prompts, destroyed: host.win.destroyed }, { prompts: 1, destroyed: false });
});

for (const choice of ['Keep Waiting', 'Close'] as const) {
	test(`CodeWindow recovery ${choice} acts only on the current window`, async () => {
		showMessageBox = async options => ({ response: options.buttons!.indexOf(choice), checkboxChecked: false });
		let reopened = 0;
		using host = createHost(new TestWindow(), async () => { reopened++; });
		await host.reportWindowError(false);
		assert.deepEqual({ reopened, destroyed: host.win.destroyed, requests: host.win.messages }, { reopened: 0, destroyed: choice === 'Close', requests: [] });
	});
}

test('CodeWindow keeps its old host when opening the replacement fails', async () => {
	showMessageBox = async options => ({ response: options.buttons!.indexOf('Reopen'), checkboxChecked: false });
	const errors: unknown[][] = [];
	windowServices.get(ILogService).error = (...args: unknown[]) => { errors.push(args); };
	using host = createHost(new TestWindow(), async () => { throw new Error('Replacement failed'); });
	await host.reportWindowError(false);
	assert.equal(host.win.destroyed, false);
	assert.deepEqual(errors.map(args => args[1]), ['Window is unresponsive', 'Window recovery failed']);
});

test('CodeWindow resolves the window kind and workspace theme snapshot before OS window creation', async () => {
	const theme = windowServices.get(IThemeMainService);
	await theme.saveWindowSplash('workbench:fixture', { baseTheme: ColorScheme.Dark, colorInfo: { background: '#123456', foreground: '#ffffff' } });
	await theme.saveWindowSplash('sessions:fixture', { baseTheme: ColorScheme.Light, colorInfo: { background: '#abcdef', foreground: '#000000' } });
	for (const [isSessionsWindow, backgroundColor] of [[false, '#123456'], [true, '#abcdef']] as const) {
		let actual: string | undefined;
		using host = windowServices.createInstance(CodeWindow<TestWindow>, (options: IWindowConstructorOptions) => {
			actual = options.backgroundColor;
			return new TestWindow();
		}, {
			workspace: { id: 'fixture' }, isSessionsWindow,
			state: { mode: WindowMode.Normal, width: 1000, height: 700 },
			reopen: async () => { },
			webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: '', additionalArguments: [] },
			title: 'Workbench',
		}, new DisposableStore());
		assert.equal(actual, backgroundColor);
	}
});


test('CodeWindow restores focus and captures normal bounds with the current window mode', () => {
	using host = createHost();
	host.win.minimized = true;
	const previousFocus = host.lastFocusTime;
	host.focus();
	assert.equal(host.win.minimized, false);
	assert.equal(host.win.focused, 1);
	assert.ok(host.lastFocusTime >= previousFocus);
	assert.equal(host.id, host.win.id);
	assert.deepEqual(host.getBounds(), host.win.bounds);
	for (const mode of [WindowMode.Normal, WindowMode.Maximized, WindowMode.Fullscreen]) {
		host.win.maximized = mode === WindowMode.Maximized ? 1 : 0;
		host.win.fullscreen = mode === WindowMode.Fullscreen;
		assert.deepEqual(host.serializeWindowState(), { ...host.win.bounds, mode });
	}
	host.close();
	host.focus();
	assert.equal(host.win.focused, 1);
});

test('CodeWindow publishes close before releasing its resource scope, including explicit disposal', () => {
	for (const explicit of [false, true]) {
		const host = createHost();
		const order: string[] = [];
		host.resources.add(toDisposable(() => order.push('resources')));
		host.resources.add(host.onDidClose(() => order.push('closed')));
		if (explicit) host.dispose();
		else host.close();
		host.dispose();
		assert.deepEqual(order, ['closed', 'resources']);
		assert.equal(host.win.listenerCount('focus'), 0);
		assert.equal(host.win.listenerCount('enter-full-screen'), 0);
	}
});

test('CodeWindow buffers messages once, removes canceled requests and never sends to a closed renderer', () => {
	using host = createHost();
	using canceled = new CancellationTokenSource();
	host.sendWhenReady('canceled', canceled.token, 1);
	host.sendWhenReady('files', CancellationToken.None, 2);
	canceled.cancel();
	assert.equal(host.win.messages.length, 0);
	host.setReady();
	host.setReady();
	assert.deepEqual(host.win.messages, [{ channel: 'files', token: 2 }]);
	host.sendWhenReady('already-ready', CancellationToken.None, 3);
	host.win.navigate();
	host.sendWhenReady('closed', CancellationToken.None, 4);
	host.dispose();
	host.send('after-close', 5);
	assert.deepEqual(host.win.messages.map(message => message.channel), ['files', 'already-ready']);
});

test('CodeWindow keeps buffered messages for the next document when a ready subscriber navigates', () => {
	using host = createHost();
	host.sendWhenReady('files', CancellationToken.None, 1);
	const loading = host.onDidSignalReady(() => host.win.navigate());
	host.setReady();
	assert.equal(host.win.messages.length, 0);
	loading.dispose();
	host.setReady();
	assert.deepEqual(host.win.messages, [{ channel: 'files', token: 1 }]);
});


test('CodeWindow reports one accepted load and ignores subframe and in-place navigation', async () => {
	using host = createHost();
	const reasons: LoadReason[] = [];
	host.resources.add(host.onWillLoad(event => reasons.push(event.reason)));
	await host.load(packagedEntry);
	assert.deepEqual(reasons, [LoadReason.INITIAL]);
	host.setReady();
	host.win.navigate(true);
	host.win.navigate(false, false);
	assert.equal(host.isReady, true);
	assert.deepEqual(reasons, [LoadReason.INITIAL]);
	host.win.navigate();
	assert.equal(host.isReady, false);
	assert.deepEqual(reasons, [LoadReason.INITIAL, LoadReason.RELOAD]);
});
