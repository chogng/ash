import { resolve } from 'node:path';
import { AbstractDisposable, Disposable, DisposableMap, DisposableStore, MutableDisposable, toDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
import { URI } from '../../../base/common/uri.js';
import { CONFIGURATION_CHANGED_CHANNEL } from '../../configuration/common/configurationIpc.js';
import { configurationIpcRoutes, type ConfigurationMainService } from '../../configuration/electron-main/configurationMainService.js';
import { type IWorkspaceOpenTarget, WorkspaceOpenTargetKind } from '../../environment/common/argv.js';
import type { IpcRoute } from '../../ipc/electron-main/trustedIpcRouter.js';
import { KEYBINDINGS_RESOURCE_CHANGED_CHANNEL } from '../../keybinding/common/keybindingsResource.js';
import { keybindingsResourceIpcRoutes, type KeybindingsResourceMainService } from '../../keybinding/electron-main/keybindingsResourceMainService.js';
import { NATIVE_KEYBOARD_LAYOUT_CHANGED_CHANNEL } from '../../keyboardLayout/common/nativeKeyboardLayout.js';
import { USER_KEYBOARD_LAYOUT_CHANGED_CHANNEL } from '../../keyboardLayout/common/userKeyboardLayout.js';
import { nativeKeyboardLayoutIpcRoutes, type NativeKeyboardLayoutMainService } from '../../keyboardLayout/electron-main/nativeKeyboardLayoutMainService.js';
import { userKeyboardLayoutIpcRoutes, type UserKeyboardLayoutMainService } from '../../keyboardLayout/electron-main/userKeyboardLayoutMainService.js';
import { createSshRemoteWorkspaceUri } from '../../remote/common/remote.js';
import { type IAnyWorkspaceIdentifier, hasWorkspaceFileExtension, serializeWorkspace } from '../../workspace/common/workspace.js';
import { WORKSPACE_CONTEXT_READ_CHANNEL, validateWorkspaceContextRead } from '../../workspace/common/workspaceIpc.js';
import { createEmptyWorkspaceIdentifier, getSingleFolderWorkspaceIdentifier, getWorkspaceIdentifier, nodeWorkspacePathService, type IWorkspacePathService, WorkspacePathKind } from '../../workspaces/node/workspaces.js';
import { WINDOW_CLOSE_RESPONSE_CHANNEL, WINDOW_FULLSCREEN_CHANGED_CHANNEL, WINDOW_OPERATION_CHANNEL, WINDOW_PREPARE_CLOSE_CHANNEL, WINDOW_ZOOM_CHANGED_CHANNEL, validateWindowCloseResponse, validateWindowOperation, type WindowCloseResponse, type WindowOperation, type IWorkbenchWindowInfo } from '../../window/common/window.js';
import { focusWindow, type IFocusableWindow, type WorkspaceContextMainService } from '../../window/electron-main/window.js';
import { CodeWindow, type IWindowCreationOptions } from './windowImpl.js';
import type { IWindowConstructorOptions, IWindowWebPreferences } from './windows.js';
import type { IWindowState } from '../../window/electron-main/window.js';

export interface IWorkbenchWindow<TWindow> extends IFocusableWindow {
	readonly id: number;
	on(event: 'close', listener: (event: { preventDefault(): void }) => void): unknown;
	off(event: 'close', listener: (event: { preventDefault(): void }) => void): unknown;
	on(event: 'enter-full-screen' | 'leave-full-screen', listener: () => void): unknown;
	off(event: 'enter-full-screen' | 'leave-full-screen', listener: () => void): unknown;
	readonly webContents: {
		getZoomLevel(): number;
		getZoomFactor(): number;
		setZoomLevel(level: number): void;
		on(event: 'zoom-changed' | 'did-start-loading' | 'render-process-gone', listener: () => void): unknown;
		off(event: 'zoom-changed' | 'did-start-loading' | 'render-process-gone', listener: () => void): unknown;
		send(channel: string, value: number | boolean): void;
		once(event: 'render-process-gone', listener: () => void): unknown;
	};
	once(event: 'ready-to-show' | 'closed', listener: () => void): this;
	getTitle(): string;
	isFocused(): boolean;
	isFullScreen(): boolean;
	close(): void;
	show(): void;
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

class AuxiliaryWindowHost<TWindow extends IWorkbenchWindow<TWindow>> extends AbstractDisposable {
	constructor(readonly window: TWindow) { super(); }

	protected disposeCore(): void {
		if (!this.window.isDestroyed()) this.window.destroy();
	}
}

/** Owns window operations for the live Workbench windows of one Electron app. */
export class WindowsMainService<TWindow extends IWorkbenchWindow<TWindow>> extends Disposable {
	private readonly workbenchWindows = this._register(new DisposableMap<number, CodeWindow<TWindow>>());
	private readonly auxiliaryWindows = this._register(new DisposableMap<number, AuxiliaryWindowHost<TWindow>>());
	private readonly managedWindows = this._register(new DisposableMap<string, ManagedWindowHost<TWindow>>());
	constructor(
		private readonly getWindows: () => readonly TWindow[],
		private readonly createEmptyWindow: () => Promise<TWindow | undefined>,
		private readonly platform: NodeJS.Platform = process.platform,
		private readonly workspacePaths: IWorkspacePathService = nodeWorkspacePathService,
	) { super(); }

	public createWindow(
		createWindow: (options: IWindowConstructorOptions & Pick<IWindowCreationOptions, 'title' | 'icon' | 'tabbingIdentifier'>) => TWindow,
		options: IWindowCreationOptions,
		resources: DisposableStore,
	): CodeWindow<TWindow> {
		this.assertNotDisposed();
		const host = new CodeWindow(createWindow, options, resources);
		const window = host.win;
		this.workbenchWindows.set(window.id, host);
		window.once('closed', () => {
			if (this.workbenchWindows.get(window.id) === host) this.workbenchWindows.deleteAndDispose(window.id);
		});
		return host;
	}

	public registerAuxiliaryWindow(window: TWindow): IDisposable {
		this.assertNotDisposed();
		const host = this.auxiliaryWindows.set(window.id, new AuxiliaryWindowHost(window));
		window.once('closed', () => {
			if (this.auxiliaryWindows.get(window.id) === host) this.auxiliaryWindows.deleteAndDispose(window.id);
		});
		return toDisposable(() => {
			if (this.auxiliaryWindows.get(window.id) === host) this.auxiliaryWindows.deleteAndDispose(window.id);
		});
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
		return host.open(options);
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
		const windows = [...this.getWindows(), ...this.managedWindowValues(), ...[...this.auxiliaryWindows].map(([, host]) => host.window)].filter(window => !window.isDestroyed());
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

export function windowOperationIpcRoute<TWindow extends IWorkbenchWindow<TWindow>>(service: WindowsMainService<TWindow>, window: TWindow): IpcRoute<unknown, unknown> {
	return {
		channel: WINDOW_OPERATION_CHANNEL,
		validate: validateWindowOperation,
		invoke: operation => service.perform(window, operation as WindowOperation),
	};
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
	readonly keybindings: KeybindingsResourceMainService;
	readonly nativeKeyboardLayout: NativeKeyboardLayoutMainService;
	readonly userKeyboardLayout: UserKeyboardLayoutMainService;
}

/** Shared resource routes available to every Electron Workbench renderer window. */
export function windowResourceIpcRoutes(services: IWindowResourceIpcServices): readonly IpcRoute<unknown, unknown>[] {
	return [
		...configurationIpcRoutes(services.configuration),
		...keybindingsResourceIpcRoutes(services.keybindings),
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
	resources.add(services.keybindings.onDidChange(snapshot => {
		if (!window.isDestroyed()) window.webContents.send(KEYBINDINGS_RESOURCE_CHANGED_CHANNEL, snapshot);
	}));
	resources.add(services.nativeKeyboardLayout.onDidChangeKeyboardLayout(layout => {
		if (!window.isDestroyed()) window.webContents.send(NATIVE_KEYBOARD_LAYOUT_CHANGED_CHANNEL, layout);
	}));
	resources.add(services.userKeyboardLayout.onDidChangeKeyboardLayout(() => {
		if (!window.isDestroyed()) window.webContents.send(USER_KEYBOARD_LAYOUT_CHANGED_CHANNEL, services.userKeyboardLayout.currentKeyboardLayout);
	}));
	return resources;
}
