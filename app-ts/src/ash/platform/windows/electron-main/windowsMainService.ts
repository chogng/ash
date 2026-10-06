import { resolve } from 'node:path';
import { IAuxiliaryWindowsMainService } from '../../auxiliaryWindow/electron-main/auxiliaryWindows.js';
import { WORKSPACE_RECOVERY_CHANNEL, validateWorkspaceRecovery, NEW_WINDOW_DIMENSIONS_SETTING, RESTORE_FULLSCREEN_SETTING, parseNewWindowDimensions, parseRestoreFullscreen } from '../../window/common/window.js';
import { DeferredPromise } from '../../../base/common/async.js';
import { AbstractDisposable, Disposable, DisposableMap, DisposableStore, MutableDisposable, toDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
import { URI } from '../../../base/common/uri.js';
import { CONFIGURATION_CHANGED_CHANNEL } from '../../configuration/common/configurationIpc.js';
import { configurationIpcRoutes, type ConfigurationMainService } from '../../configuration/electron-main/configurationMainService.js';
import { type IWorkspaceOpenTarget, WorkspaceOpenTargetKind } from '../../environment/common/argv.js';
import type { IpcRoute } from '../../ipc/electron-main/trustedIpcRouter.js';
import { NATIVE_KEYBOARD_LAYOUT_CHANGED_CHANNEL } from '../../keyboardLayout/common/nativeKeyboardLayout.js';
import { USER_KEYBOARD_LAYOUT_CHANGED_CHANNEL } from '../../keyboardLayout/common/userKeyboardLayout.js';
import { nativeKeyboardLayoutIpcRoutes, type NativeKeyboardLayoutMainService } from '../../keyboardLayout/electron-main/nativeKeyboardLayoutMainService.js';
import { userKeyboardLayoutIpcRoutes, type UserKeyboardLayoutMainService } from '../../keyboardLayout/electron-main/userKeyboardLayoutMainService.js';
import { createSshRemoteWorkspaceUri } from '../../remote/common/remote.js';
import { type IAnyWorkspaceIdentifier, hasWorkspaceFileExtension, isSingleFolderWorkspaceIdentifier, isWorkspaceIdentifier, serializeWorkspace } from '../../workspace/common/workspace.js';
import { WORKSPACE_CONTEXT_READ_CHANNEL, validateWorkspaceContextRead } from '../../workspace/common/workspaceIpc.js';
import { createEmptyWorkspaceIdentifier, getSingleFolderWorkspaceIdentifier, getWorkspaceIdentifier, type IWorkspacePathService, WorkspacePathKind } from '../../workspaces/node/workspaces.js';
import { WINDOW_CLOSE_RESPONSE_CHANNEL, WINDOW_FULLSCREEN_CHANGED_CHANNEL, WINDOW_OPERATION_CHANNEL, WINDOW_PREPARE_CLOSE_CHANNEL, WINDOW_ZOOM_CHANGED_CHANNEL, parseRestoreWindowsSetting, validateWindowCloseResponse, validateWindowOperation, type WindowCloseResponse, type WindowOperation, type IWorkbenchWindowInfo, type RestoreWindowsSetting } from '../../window/common/window.js';
import { focusWindow, WindowMode, type IFocusableWindow, type WorkspaceContextMainService } from '../../window/electron-main/window.js';
import type { WindowsStateHandler } from './windowsStateHandler.js';
import { CodeWindow, type IWindowCreationOptions } from './windowImpl.js';
import type { IWindowConstructorOptions, IWindowWebPreferences, IOpenConfiguration, IWindowsMainService } from './windows.js';
import { WINDOW_OPEN_FILES_CHANNEL, WINDOW_OPEN_FILES_RESPONSE_CHANNEL, validateWindowFilesResponse, type IWindowFilesRequest, type WindowFilesResponse } from '../../window/common/window.js';
import type { IWindowBounds, IWindowState } from '../../window/electron-main/window.js';
import { findWindowOnWorkspaceOrFolder } from './windowsFinder.js';

export interface IWorkbenchWindow<TWindow> extends IFocusableWindow {
	readonly id: number;
	on(event: 'close', listener: (event: { preventDefault(): void }) => void): unknown;
	on(event: 'focus', listener: () => void): unknown;
	off(event: 'close', listener: (event: { preventDefault(): void }) => void): unknown;
	off(event: 'focus', listener: () => void): unknown;
	on(event: 'enter-full-screen' | 'leave-full-screen', listener: () => void): unknown;
	off(event: 'enter-full-screen' | 'leave-full-screen', listener: () => void): unknown;
	readonly webContents: {
		getZoomLevel(): number;
		getZoomFactor(): number;
		setZoomLevel(level: number): void;
		on(event: 'zoom-changed' | 'did-start-loading' | 'render-process-gone', listener: () => void): unknown;
		off(event: 'zoom-changed' | 'did-start-loading' | 'render-process-gone', listener: () => void): unknown;
		send(channel: string, value: unknown): void;
		once(event: 'render-process-gone', listener: () => void): unknown;
	};
	once(event: 'ready-to-show' | 'closed', listener: () => void): this;
	getTitle(): string;
	isFocused(): boolean;
	isFullScreen(): boolean;
	isMaximized(): boolean;
	close(): void;
	show(): void;
	getBounds(): IWindowBounds;
	getNormalBounds(): IWindowBounds;
	setBounds(bounds: IWindowBounds): void;
	maximize(): void;
	setFullScreen(fullscreen: boolean): void;
	destroy(): void;
	isAlwaysOnTop(): boolean;
	setAlwaysOnTop(enabled: boolean): void;
	selectNextTab(): void;
	selectPreviousTab(): void;
	moveTabToNewWindow(): void;
	mergeAllWindows(): void;
	toggleTabBar(): void;
	addTabbedWindow(window: TWindow): void;
}

export interface IManagedWindowOpenOptions<TWindow extends IWorkbenchWindow<TWindow>> {
	readonly title: string;
	readonly titleBarStyle?: IWindowCreationOptions['titleBarStyle'];
	readonly icon?: string;
	readonly state: IWindowState;
	readonly webPreferences: IWindowWebPreferences;
	readonly initialize: (window: TWindow, resources: DisposableStore) => Promise<void>;
}

class ManagedWindowHost<TWindow extends IWorkbenchWindow<TWindow>> extends Disposable {
	private readonly windowHost = this._register(new MutableDisposable<CodeWindow<TWindow>>());
	private opening: Promise<void> | undefined;
	private closing: Promise<void> | undefined;
	private resolveClosing: (() => void) | undefined;
	private rejectClosing: ((error: Error) => void) | undefined;
	private openRequests = 0;

	constructor(
		private readonly createWindow: (options: IWindowConstructorOptions & Pick<IWindowCreationOptions, 'title' | 'icon' | 'tabbingIdentifier'>) => TWindow,
		private readonly onDidClose: () => void,
	) {
		super();
	}

	public get currentWindow(): TWindow | undefined {
		const window = this.windowHost.value?.win;
		return window && !window.isDestroyed() ? window : undefined;
	}

	public async open(options: IManagedWindowOpenOptions<TWindow>): Promise<void> {
		this.openRequests++;
		try {
			this.assertNotDisposed();
			// Keep the closing window's routes alive until Electron confirms its close.
			if (this.closing) await this.closing;
			this.assertNotDisposed();
			const existing = this.currentWindow;
			if (existing) {
				if (existing.isMinimized()) existing.restore();
				existing.focus();
				await this.opening;
				return;
			}

			const resources = new DisposableStore();
			const windowHost = new CodeWindow(this.createWindow, options, resources);
			this.windowHost.value = windowHost;
			const window = windowHost.win;
			window.once('closed', () => {
				this.resolveClosing?.();
				if (this.windowHost.value !== windowHost) return;
				this.windowHost.clear();
				if (this.openRequests === 0) this.onDidClose();
			});

			let opening: Promise<void> | undefined;
			try {
				opening = options.initialize(window, resources);
				this.opening = opening;
				await opening;
			} catch (error) {
				windowHost.dispose();
				throw error;
			} finally {
				if (this.opening === opening) this.opening = undefined;
			}
		} finally {
			this.openRequests--;
			if (this.openRequests === 0 && !this.currentWindow) this.onDidClose();
		}
	}

	public close(): Promise<void> {
		const window = this.currentWindow;
		if (!window) return Promise.resolve();
		if (this.closing) return this.closing;
		const closing = new Promise<void>((resolve, reject) => {
			this.resolveClosing = resolve;
			this.rejectClosing = reject;
		});
		this.closing = closing;
		const clearClosing = (): void => {
			if (this.closing === closing) {
				this.closing = undefined;
				this.resolveClosing = undefined;
				this.rejectClosing = undefined;
			}
		};
		void closing.then(clearClosing, clearClosing);
		window.close();
		return closing;
	}

	public failClose(window: TWindow, message: string): void {
		if (this.currentWindow === window) this.rejectClosing?.(new Error(message));
	}

}

/** Owns window operations for the live Workbench windows of one Electron app. */
export class WindowsMainService<TWindow extends IWorkbenchWindow<TWindow>> extends Disposable implements IWindowsMainService {
	private readonly workbenchWindows = this._register(new DisposableMap<number, CodeWindow<TWindow>>());
	private readonly managedWindows = this._register(new DisposableMap<string, ManagedWindowHost<TWindow>>());
	private readonly fileRequests = this._register(new DisposableMap<number, WindowFileRequest>());
	private readonly rendererReadiness = new Map<number, DeferredPromise<void>>();
	private readonly closedWindows = new WeakMap<TWindow, Promise<void>>();
	private readonly workspaceOpenings = new Map<string, Promise<TWindow | undefined>>();
	private readonly recoveredWorkspaces = new Set<string>();
	private readonly activationOrder = new Map<number, number>();
	private lastClosedWindowState: IWindowState | undefined;
	private nextFileRequest = 0;
	constructor(
		private readonly createEmptyWindow: (configuration?: IOpenConfiguration, reuseWindow?: TWindow) => Promise<TWindow | undefined>,
		private readonly platform: NodeJS.Platform,
		private readonly workspacePaths: IWorkspacePathService,
		@IAuxiliaryWindowsMainService private readonly auxiliaryWindowsMainService: IAuxiliaryWindowsMainService,
	) {
		super();
		this._register(toDisposable(() => {
			for (const readiness of this.rendererReadiness.values()) {
				void readiness.complete();
			}
			this.rendererReadiness.clear();
		}));
	}

	public getWindows(): readonly TWindow[] {
		return [...this.workbenchWindows].map(([, host]) => host.win).filter(window => !window.isDestroyed());
	}

	public getWindowById(id: number): TWindow | undefined {
		const window = this.workbenchWindows.get(id)?.win;
		return window && !window.isDestroyed() ? window : undefined;
	}

	public getWindowCount(): number {
		return this.getWindows().length;
	}

	public getLastActiveWindow(kind: 'all' | 'workbench' = 'all'): TWindow | undefined {
		const windows = kind === 'all' ? [...this.getWindows(), ...this.managedWindowValues()] : this.getWindows();
		const focusedMain = windows.find(window => window.isFocused());
		if (focusedMain) {
			return focusedMain;
		}
		const focusedAuxiliary = this.auxiliaryWindowsMainService.getFocusedWindow();
		if (focusedAuxiliary) {
			const parent = windows.find(window => window.id === focusedAuxiliary.parentId);
			if (parent) {
				return parent;
			}
		}
		const lastAuxiliary = this.auxiliaryWindowsMainService.getLastActiveWindow();
		const auxiliaryParent = lastAuxiliary && windows.find(window => window.id === lastAuxiliary.parentId);
		for (const [id, time] of [...this.activationOrder].reverse()) {
			const window = windows.find(window => window.id === id);
			if (window) {
				return lastAuxiliary && auxiliaryParent && lastAuxiliary.lastFocusTime > time ? auxiliaryParent : window;
			}
		}
		return auxiliaryParent;
	}

	/** Live window identity and configuration enter the sizing policy together for both window kinds. */
	public getNewWindowState(handler: WindowsStateHandler, settings: Readonly<Record<string, unknown>>, wasRestarted: boolean): IWindowState {
		const active = this.getLastActiveWindow();
		return handler.getNewWindowState({
			lastActiveWindow: active ? { state: this.serializeWindowState(active), bounds: active.getBounds() } : undefined,
			lastClosedWindow: this.lastClosedWindowState,
			existingWindows: [...this.getWindows(), ...this.managedWindowValues()].map(window => window.getBounds()),
			newWindowDimensions: parseNewWindowDimensions(settings[NEW_WINDOW_DIMENSIONS_SETTING] ?? 'default'),
			restoreFullscreen: parseRestoreFullscreen(settings[RESTORE_FULLSCREEN_SETTING] ?? false),
			wasRestarted,
		});
	}

	private serializeWindowState(window: TWindow): IWindowState & IWindowBounds {
		return { ...window.getNormalBounds(), mode: window.isFullScreen() ? WindowMode.Fullscreen : window.isMaximized() ? WindowMode.Maximized : WindowMode.Normal };
	}

	private trackActivation(window: TWindow, resources: DisposableStore): void {
		const activate = (): void => {
			this.activationOrder.delete(window.id);
			this.activationOrder.set(window.id, performance.now());
		};
		let closingState: IWindowState | undefined;
		const closing = (): void => { closingState = this.serializeWindowState(window); };
		activate();
		window.on('focus', activate);
		window.on('close', closing);
		resources.add(toDisposable(() => {
			if (!window.isDestroyed()) {
				window.off('focus', activate);
				window.off('close', closing);
			}
		}));
		window.once('closed', () => {
			this.activationOrder.delete(window.id);
			if (this.getWindows().length + this.managedWindowValues().length === 0) this.lastClosedWindowState = closingState;
		});
	}

	public updateWorkspace(id: number, workspace: IAnyWorkspaceIdentifier): void {
		const host = this.workbenchWindows.get(id);
		if (!host) throw new Error(`Workbench window ${id} is not registered`);
		host.openedWorkspace = workspace;
	}

	public findWorkspace(workspace: IAnyWorkspaceIdentifier): TWindow | undefined {
		const lastActive = this.getLastActiveWindow();
		const order = new Set([...(lastActive ? [lastActive.id] : []), ...[...this.activationOrder.keys()].reverse()]);
		const hosts = [...order].flatMap(id => {
			const host = this.workbenchWindows.get(id);
			return host && !host.win.isDestroyed() ? [host] : [];
		});
		let host: CodeWindow<TWindow> | undefined;
		if (isWorkspaceIdentifier(workspace)) {
			host = findWindowOnWorkspaceOrFolder(hosts, workspace.configPath);
		} else if (isSingleFolderWorkspaceIdentifier(workspace)) {
			host = findWindowOnWorkspaceOrFolder(hosts, workspace.uri);
		} else {
			host = hosts.find(host => host.openedWorkspace.id === workspace.id);
		}
		return host?.win;
	}

	/** Every newly restored renderer reads the same catalog. Claim each window once for this app run. */
	public async restoreWorkspaces(workspaces: readonly IAnyWorkspaceIdentifier[], open: (workspace: IAnyWorkspaceIdentifier) => Promise<TWindow | undefined>): Promise<void> {
		const results = await Promise.allSettled(workspaces.map(async workspace => {
			if (this.recoveredWorkspaces.has(workspace.id)) return;
			this.recoveredWorkspaces.add(workspace.id);
			if (this.findWorkspace(workspace)) return;
			try {
				if (!await open(workspace)) throw new Error(`Workspace recovery did not open ${workspace.id}`);
			} catch (error) {
				this.recoveredWorkspaces.delete(workspace.id);
				throw error;
			}
		}));
		const failures = results.filter(result => result.status === 'rejected');
		if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Failed to restore backup workspaces');
	}

	public openWorkspace(workspace: IAnyWorkspaceIdentifier, create: () => Promise<TWindow | undefined>): Promise<TWindow | undefined> {
		this.assertNotDisposed();
		const pending = this.workspaceOpenings.get(workspace.id);
		if (pending) return pending;
		const existing = this.findWorkspace(workspace);
		if (existing) {
			const child = this.auxiliaryWindowsMainService.getFocusedWindow();
			focusWindow(child?.parentId === existing.id ? child.win : existing);
			return Promise.resolve(existing);
		}
		const opening = create();
		this.workspaceOpenings.set(workspace.id, opening);
		void opening.finally(() => {
			if (this.workspaceOpenings.get(workspace.id) === opening) this.workspaceOpenings.delete(workspace.id);
		}).catch(() => {
			// The caller observes the original opening, including its rejection.
		});
		return opening;
	}

	/** Workspace callbacks also need a restored renderer because that renderer owns the backend client. */
	public async whenReady(window: TWindow): Promise<void> {
		this.assertNotDisposed();
		while (!window.isDestroyed()) {
			const readiness = this.rendererReadiness.get(window.id);
			if (!readiness) {
				throw new Error('Window has no Workbench renderer');
			}
			await readiness.p;
			this.assertNotDisposed();
			if (!window.isDestroyed() && this.rendererReadiness.get(window.id) === readiness) {
				return;
			}
		}
		throw new Error('Window closed before its renderer was ready');
	}

	public async open(configuration: IOpenConfiguration): Promise<{ whenClosed: Promise<void>; whenFilesClosed: Promise<void> }> {
		this.assertNotDisposed();
		const needsWorkbench = !!configuration.workspace || configuration.files.length > 0;
		const active = this.getLastActiveWindow(needsWorkbench ? 'workbench' : 'all');
		const reuse = !configuration.forceNewWindow && (configuration.forceReuseWindow || !configuration.workspace) ? active : undefined;
		const window = await this.createEmptyWindow(configuration, reuse);
		if (!window) {
			throw new Error('The launch request did not open a window');
		}
		const child = this.auxiliaryWindowsMainService.getFocusedWindow();
		focusWindow(child?.parentId === window.id ? child.win : window);
		let whenClosed = this.closedWindows.get(window);
		if (!whenClosed) {
			whenClosed = new Promise<void>(resolve => window.once('closed', resolve));
			this.closedWindows.set(window, whenClosed);
		}
		if (configuration.files.length === 0) {
			return { whenClosed, whenFilesClosed: whenClosed };
		}
		const request = new WindowFileRequest(window.id, { id: ++this.nextFileRequest, files: configuration.files, wait: configuration.waitForFiles });
		this.fileRequests.set(request.request.id, request);
		if (this.rendererReadiness.get(window.id)?.isResolved) {
			window.webContents.send(WINDOW_OPEN_FILES_CHANNEL, request.request);
		}
		await request.whenOpened;
		return { whenClosed, whenFilesClosed: request.whenClosed };
	}

	public respondToFileOpen(window: TWindow, response: WindowFilesResponse): void {
		if (response.kind === 'ready') {
			let readiness = this.rendererReadiness.get(window.id);
			if (!readiness) {
				readiness = new DeferredPromise<void>();
				this.rendererReadiness.set(window.id, readiness);
			}
			void readiness.complete();
			for (const [, request] of this.fileRequests) {
				if (request.windowId === window.id) {
					window.webContents.send(WINDOW_OPEN_FILES_CHANNEL, request.request);
				}
			}
			return;
		}
		const request = this.fileRequests.get(response.id);
		if (!request || request.windowId !== window.id) {
			throw new Error('File open request does not belong to this window');
		}
		if (response.kind === 'failed') {
			request.fail(new Error(response.message));
			this.fileRequests.deleteAndDispose(response.id);
		} else if (response.kind === 'opened') {
			request.opened();
			if (!request.request.wait) this.fileRequests.deleteAndDispose(response.id);
		} else {
			this.fileRequests.deleteAndDispose(response.id);
		}
	}

	public fileOpenResponseIpcRoute(window: TWindow): IpcRoute<unknown, unknown> {
		return { channel: WINDOW_OPEN_FILES_RESPONSE_CHANNEL, validate: validateWindowFilesResponse, invoke: response => this.respondToFileOpen(window, response as WindowFilesResponse) };
	}

	public createWindow(
		createWindow: (options: IWindowConstructorOptions & Pick<IWindowCreationOptions, 'title' | 'icon' | 'tabbingIdentifier'>) => TWindow,
		options: IWindowCreationOptions,
		resources: DisposableStore,
	): CodeWindow<TWindow> {
		this.assertNotDisposed();
		const host = new CodeWindow(createWindow, { ...options, workspace: options.workspace ?? createEmptyWorkspaceIdentifier() }, resources);
		const window = host.win;
		if (this.workbenchWindows.has(window.id)) {
			host.dispose();
			throw new Error(`Workbench window ${window.id} is already registered`);
		}
		this.workbenchWindows.set(window.id, host);
		this.trackActivation(window, resources);
		this.rendererReadiness.set(window.id, new DeferredPromise<void>());
		window.once('closed', () => {
			this.activationOrder.delete(window.id);
			void this.rendererReadiness.get(window.id)?.complete();
			this.rendererReadiness.delete(window.id);
			for (const [id, request] of this.fileRequests) {
				if (request.windowId === window.id) {
					this.fileRequests.deleteAndDispose(id);
				}
			}
			if (this.workbenchWindows.get(window.id) === host) this.workbenchWindows.deleteAndDispose(window.id);
		});
		const loading = (): void => {
			void this.rendererReadiness.get(window.id)?.complete();
			this.rendererReadiness.set(window.id, new DeferredPromise<void>());
			for (const [id, request] of this.fileRequests) {
				if (request.windowId === window.id) {
					this.fileRequests.deleteAndDispose(id);
				}
			}
		};
		window.webContents.on('did-start-loading', loading);
		resources.add(toDisposable(() => {
			if (!window.isDestroyed()) window.webContents.off('did-start-loading', loading);
		}));
		return host;
	}

	public openManagedWindow(key: string, createWindow: (options: IWindowConstructorOptions & Pick<IWindowCreationOptions, 'title' | 'icon' | 'tabbingIdentifier'>) => TWindow, options: IManagedWindowOpenOptions<TWindow>, onDidClose: () => void): Promise<void> {
		let host = this.managedWindows.get(key);
		if (!host) {
			const created = new ManagedWindowHost(createWindow, () => {
				if (this.managedWindows.get(key) !== created) return;
				this.managedWindows.deleteAndDispose(key);
				onDidClose();
			});
			this.managedWindows.set(key, created);
			host = created;
		}
		return host.open({ ...options, initialize: (window, resources) => {
			this.trackActivation(window, resources);
			return options.initialize(window, resources);
		} });
	}

	public managedWindow(key: string): TWindow | undefined {
		return this.managedWindows.get(key)?.currentWindow;
	}

	public managedWindowValues(): readonly TWindow[] {
		return [...this.managedWindows].flatMap(([, host]) => host.currentWindow ?? []);
	}

	public closeManagedWindow(key: string): Promise<void> {
		return this.managedWindows.get(key)?.close() ?? Promise.resolve();
	}

	public selectWindowsToRestore<TEntry extends { readonly workspace: IAnyWorkspaceIdentifier }>(
		session: { readonly windows: readonly TEntry[]; readonly active: number } | undefined,
		configuredSetting: unknown,
		hasExplicitTarget: boolean,
		wasRestarted: boolean,
	): { readonly windows: readonly TEntry[]; readonly active: TEntry | undefined } {
		const setting: RestoreWindowsSetting = wasRestarted || configuredSetting === undefined
			? 'all'
			: parseRestoreWindowsSetting(configuredSetting);
		if (!session || setting === 'none' || (hasExplicitTarget && !wasRestarted && setting !== 'preserve')) {
			return { windows: [], active: undefined };
		}
		const windows = setting === 'one'
			? [session.windows[session.active]].filter((entry): entry is TEntry => entry !== undefined)
			: session.windows.filter(entry => setting !== 'folders' || isSingleFolderWorkspaceIdentifier(entry.workspace) || isWorkspaceIdentifier(entry.workspace));
		const active = session.windows[session.active];
		return { windows, active: active && windows.includes(active) ? active : undefined };
	}

	public async resolveWorkspaceOpenTarget(target: IWorkspaceOpenTarget | undefined, cwd: string): Promise<IAnyWorkspaceIdentifier> {
		if (!target) {
			return createEmptyWorkspaceIdentifier();
		}
		if (target.kind === WorkspaceOpenTargetKind.RemoteFolder) {
			return getSingleFolderWorkspaceIdentifier(createSshRemoteWorkspaceUri(target.sshHost, target.path));
		}
		const requestedPath = resolve(cwd, target.path);
		const resolved = await this.workspacePaths.resolvePath(requestedPath);
		if (target.kind === WorkspaceOpenTargetKind.Folder && resolved.kind !== WorkspacePathKind.Directory) {
			throw new Error(`Workspace folder is not a directory: ${target.path}`);
		}
		if (target.kind === WorkspaceOpenTargetKind.Workspace && resolved.kind !== WorkspacePathKind.File) {
			throw new Error(`Workspace configuration is not a file: ${target.path}`);
		}
		if (resolved.kind === WorkspacePathKind.Directory) {
			return getSingleFolderWorkspaceIdentifier(URI.file(resolved.path));
		}
		if (resolved.kind === WorkspacePathKind.File &&
			(target.kind === WorkspaceOpenTargetKind.Workspace || hasWorkspaceFileExtension(resolved.path))) {
			return getWorkspaceIdentifier(URI.file(resolved.path));
		}
		return createEmptyWorkspaceIdentifier();
	}

	public failManagedWindowClose(window: TWindow, message: string): void {
		for (const [, host] of this.managedWindows) host.failClose(window, message);
	}

	public trackZoomLevel(window: TWindow): IDisposable {
		let active = true;
		const onZoomChanged = (): void => {
			// Electron reports a wheel request before its zoom level settles.
			setImmediate(() => {
				if (active && !window.isDestroyed()) {
					window.webContents.send(WINDOW_ZOOM_CHANGED_CHANNEL, window.webContents.getZoomLevel());
				}
			});
		};
		window.webContents.on('zoom-changed', onZoomChanged);
		return toDisposable(() => {
			active = false;
			if (!window.isDestroyed()) window.webContents.off('zoom-changed', onZoomChanged);
		});
	}

	public trackFullscreen(window: TWindow): IDisposable {
		const onChange = (): void => {
			if (!window.isDestroyed()) window.webContents.send(WINDOW_FULLSCREEN_CHANGED_CHANNEL, window.isFullScreen());
		};
		window.on('enter-full-screen', onChange);
		window.on('leave-full-screen', onChange);
		return toDisposable(() => {
			window.off('enter-full-screen', onChange);
			window.off('leave-full-screen', onChange);
		});
	}

	public perform(source: TWindow, operation: WindowOperation): void | number | boolean | readonly IWorkbenchWindowInfo[] | Promise<void> {
		const windows = [...this.getWindows(), ...this.managedWindowValues(), ...this.auxiliaryWindowsMainService.getWindows().map(window => window.win)].filter(window => !window.isDestroyed());
		if (!windows.includes(source)) throw new Error('Workbench window is closed');
		switch (operation.kind) {
			case 'list':
				return windows.map((window): IWorkbenchWindowInfo => ({ id: window.id, title: window.getTitle(), focused: window.isFocused() }));
			case 'focus': {
				const target = windows.find(window => window.id === operation.windowId);
				if (!target) throw new Error('Workbench window is closed');
				focusWindow(target);
				return;
			}
			case 'focusSelf':
				focusWindow(source);
				return;
			case 'close':
				source.close();
				return;
			case 'closeOthers':
				for (const window of windows) {
					if (window !== source && !window.isDestroyed()) window.close();
				}
				return;
			case 'getZoom':
				return source.webContents.getZoomLevel();
			case 'getZoomFactor':
				return source.webContents.getZoomFactor();
			case 'getFullscreen':
				return source.isFullScreen();
			case 'setZoom':
				source.webContents.setZoomLevel(operation.level);
				// Programmatic changes do not emit Electron's wheel-only zoom event.
				source.webContents.send(WINDOW_ZOOM_CHANGED_CHANNEL, operation.level);
				return;
			case 'getAlwaysOnTop':
				return source.isAlwaysOnTop();
			case 'setAlwaysOnTop':
				source.setAlwaysOnTop(operation.enabled);
				return;
			case 'nativeTab':
				if (this.platform !== 'darwin') throw new Error('Native window tabs require macOS');
				switch (operation.action) {
					case 'next': source.selectNextTab(); break;
					case 'previous': source.selectPreviousTab(); break;
					case 'newWindow': source.moveTabToNewWindow(); break;
					case 'merge': source.mergeAllWindows(); break;
					case 'toggleBar': source.toggleTabBar(); break;
				}
				return;
			case 'newTab':
				if (this.platform !== 'darwin') throw new Error('Window tabs require macOS');
				return this.createEmptyWindow().then(tab => {
					if (!tab) return;
					if (source.isDestroyed()) {
						tab.close();
						return;
					}
					source.addTabbedWindow(tab);
				});
		}
		const unhandled: never = operation;
		return unhandled;
	}
}

class WindowFileRequest extends AbstractDisposable {
	public readonly whenOpened: Promise<void>;
	public readonly whenClosed: Promise<void>;
	private resolveOpened!: () => void;
	private rejectOpened!: (error: Error) => void;
	private resolveClosed!: () => void;
	private isOpened = false;

	constructor(public readonly windowId: number, public readonly request: IWindowFilesRequest) {
		super();
		this.whenOpened = new Promise<void>((resolve, reject) => { this.resolveOpened = resolve; this.rejectOpened = reject; });
		this.whenClosed = new Promise<void>(resolve => { this.resolveClosed = resolve; });
	}

	public opened(): void {
		this.isOpened = true;
		this.resolveOpened();
	}

	public fail(error: Error): void {
		this.rejectOpened(error);
	}

	protected override disposeCore(): void {
		if (!this.isOpened) {
			this.rejectOpened(new Error('Window closed before opening the requested files'));
		}
		this.resolveClosed();
	}
}

export function windowOperationIpcRoute<TWindow extends IWorkbenchWindow<TWindow>>(service: WindowsMainService<TWindow>, window: TWindow): IpcRoute<unknown, unknown> {
	return {
		channel: WINDOW_OPERATION_CHANNEL,
		validate: validateWindowOperation,
		invoke: operation => service.perform(window, operation as WindowOperation),
	};
}

/** The renderer selects recovery scopes; Main only creates their windows. */
export function workspaceRecoveryIpcRoute(restore: (workspaces: readonly IAnyWorkspaceIdentifier[]) => Promise<void>): IpcRoute<unknown, unknown> {
	return { channel: WORKSPACE_RECOVERY_CHANNEL, validate: validateWorkspaceRecovery, invoke: workspaces => restore(workspaces as readonly IAnyWorkspaceIdentifier[]) };
}

/** Publishes one window's committed workspace through the trusted IPC router. */
export function workspaceContextIpcRoutes(service: WorkspaceContextMainService): readonly IpcRoute<unknown, unknown>[] {
	return [{
		channel: WORKSPACE_CONTEXT_READ_CHANNEL,
		validate: validateWorkspaceContextRead,
		invoke: () => serializeWorkspace(service.getResolvedWorkspace()),
	}];
}

export interface IWindowResourceIpcServices {
	readonly configuration: ConfigurationMainService;
	readonly nativeKeyboardLayout: NativeKeyboardLayoutMainService;
	readonly userKeyboardLayout: UserKeyboardLayoutMainService;
}

/** Shared resource routes available to every Electron Workbench renderer window. */
export function windowResourceIpcRoutes(services: IWindowResourceIpcServices): readonly IpcRoute<unknown, unknown>[] {
	return [
		...configurationIpcRoutes(services.configuration),
		...nativeKeyboardLayoutIpcRoutes(services.nativeKeyboardLayout),
		...userKeyboardLayoutIpcRoutes(services.userKeyboardLayout),
	];
}

export function trackWindowResourceChanges(
	window: { readonly webContents: { send(channel: string, value: unknown): void }; isDestroyed(): boolean },
	services: IWindowResourceIpcServices,
): IDisposable {
	const resources = new DisposableStore();
	resources.add(services.configuration.onDidChange(snapshot => {
		if (!window.isDestroyed()) window.webContents.send(CONFIGURATION_CHANGED_CHANNEL, snapshot);
	}));
	resources.add(services.nativeKeyboardLayout.onDidChangeKeyboardLayout(layout => {
		if (!window.isDestroyed()) window.webContents.send(NATIVE_KEYBOARD_LAYOUT_CHANGED_CHANNEL, layout);
	}));
	resources.add(services.userKeyboardLayout.onDidChangeKeyboardLayout(() => {
		if (!window.isDestroyed()) window.webContents.send(USER_KEYBOARD_LAYOUT_CHANGED_CHANNEL, services.userKeyboardLayout.currentKeyboardLayout);
	}));
	return resources;
}
