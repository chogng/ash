import { CancellationTokenSource } from '../../../base/common/cancellation.js';
import { resolve } from 'node:path';
import { IAuxiliaryWindowsMainService } from '../../auxiliaryWindow/electron-main/auxiliaryWindows.js';
import { WORKSPACE_RECOVERY_CHANNEL, validateWorkspaceRecovery, NEW_WINDOW_DIMENSIONS_SETTING, RESTORE_FULLSCREEN_SETTING, parseNewWindowDimensions, parseRestoreFullscreen } from '../../window/common/window.js';
import { IInstantiationService } from '../../instantiation/common/instantiation.js';
import { AbstractDisposable, Disposable, DisposableMap, DisposableStore, MutableDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { URI } from '../../../base/common/uri.js';
import { type IWorkspaceOpenTarget, WorkspaceOpenTargetKind } from '../../environment/common/argv.js';
import type { IpcRoute } from '../../ipc/electron-main/trustedIpcRouter.js';
import { createSshRemoteWorkspaceUri } from '../../remote/common/remote.js';
import { type IAnyWorkspaceIdentifier, hasWorkspaceFileExtension, isSingleFolderWorkspaceIdentifier, isWorkspaceIdentifier, serializeWorkspace } from '../../workspace/common/workspace.js';
import { WORKSPACE_CONTEXT_READ_CHANNEL, validateWorkspaceContextRead } from '../../workspace/common/workspaceIpc.js';
import { createEmptyWorkspaceIdentifier, getSingleFolderWorkspaceIdentifier, getWorkspaceIdentifier, type IWorkspacePathService, WorkspacePathKind } from '../../workspaces/node/workspaces.js';
import { WINDOW_CLOSE_RESPONSE_CHANNEL, WINDOW_FULLSCREEN_CHANGED_CHANNEL, WINDOW_OPERATION_CHANNEL, WINDOW_PREPARE_CLOSE_CHANNEL, WINDOW_ZOOM_CHANGED_CHANNEL, WINDOW_ALWAYS_ON_TOP_CHANGED_CHANNEL, AUXILIARY_WINDOW_STATE_CHANGED_CHANNEL, type IAuxiliaryWindowState, parseRestoreWindowsSetting, validateWindowCloseResponse, validateWindowOperation, type WindowCloseResponse, type WindowOperation, type IWorkbenchWindowInfo, type RestoreWindowsSetting } from '../../window/common/window.js';
import { focusWindow, type IFocusableWindow, type WorkspaceContextMainService } from '../../window/electron-main/window.js';
import type { WindowsStateHandler } from './windowsStateHandler.js';
import { CodeWindow, type ICodeWindowHandle, type IWindowCreationOptions, type IWindowConstructorOptions, type IWindowWebPreferences } from './windowImpl.js';
import { createUuid } from '../../../base/common/uuid.js';
import type { IOpenAgentsWindowOptions } from '../../native/common/nativeHost.js';
import type { IAgentsWindowHandoffResult } from '../../window/common/window.js';
import type { IOpenConfiguration, IWindowsMainService } from './windows.js';
import { WINDOW_OPEN_FILES_CHANNEL, WINDOW_OPEN_FILES_RESPONSE_CHANNEL, validateWindowFilesResponse, type IWindowFilesRequest, type WindowFilesResponse } from '../../window/common/window.js';
import type { ICodeWindow, IWindowBounds, IWindowState } from '../../window/electron-main/window.js';
import { findWindowOnWorkspaceOrFolder } from './windowsFinder.js';

export interface IWorkbenchWindow<TWindow> extends IFocusableWindow, ICodeWindowHandle<TWindow> {
	readonly id: number;
	on(event: 'close', listener: (event: { preventDefault(): void; }) => void): unknown;
	on(event: 'focus', listener: () => void): unknown;
	off(event: 'close', listener: (event: { preventDefault(): void; }) => void): unknown;
	off(event: 'focus', listener: () => void): unknown;
	on(event: 'enter-full-screen' | 'leave-full-screen' | 'unresponsive' | 'responsive', listener: () => void): unknown;
	off(event: 'enter-full-screen' | 'leave-full-screen' | 'unresponsive' | 'responsive', listener: () => void): unknown;
	readonly webContents: {
		isDestroyed(): boolean;
		reload(): void;
		on(event: 'render-process-gone', listener: (event: unknown, details: Electron.RenderProcessGoneDetails) => void): unknown;
		off(event: 'render-process-gone', listener: (event: unknown, details: Electron.RenderProcessGoneDetails) => void): unknown;
		on(event: 'did-fail-load', listener: (event: unknown, code: number, description: string, url: string, mainFrame: boolean) => void): unknown;
		off(event: 'did-fail-load', listener: (event: unknown, code: number, description: string, url: string, mainFrame: boolean) => void): unknown;
		getZoomLevel(): number;
		getZoomFactor(): number;
		setZoomLevel(level: number): void;
		on(event: 'zoom-changed' | 'did-start-loading' | 'render-process-gone' | 'will-prevent-unload', listener: () => void): unknown;
		off(event: 'zoom-changed' | 'did-start-loading' | 'render-process-gone' | 'will-prevent-unload', listener: () => void): unknown;
		on(event: 'did-start-navigation', listener: (event: unknown, url: string, inPlace: boolean, mainFrame: boolean) => void): unknown;
		off(event: 'did-start-navigation', listener: (event: unknown, url: string, inPlace: boolean, mainFrame: boolean) => void): unknown;
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

export interface IManagedWindowOpenOptions<TWindow extends IWorkbenchWindow<TWindow>> extends Pick<IWindowCreationOptions, 'workspace' | 'isSessionsWindow'> {
	readonly title: string;
	readonly titleBarStyle?: IWindowCreationOptions['titleBarStyle'];
	readonly backgroundColor?: IWindowCreationOptions['backgroundColor'];
	readonly icon?: string;
	readonly state: IWindowState;
	readonly webPreferences: IWindowWebPreferences;
	readonly initialize: (window: TWindow, resources: DisposableStore) => Promise<void>;
}

/** Pending handoffs belong to the receiving window's current renderer document. */
class ManagedWindowHandoffs<TWindow extends IWorkbenchWindow<TWindow>> extends Disposable {
	private readonly pending = new Map<string, { readonly options: IOpenAgentsWindowOptions; readonly resolve: () => void; readonly reject: (error: Error) => void; }>();
	private readonly queue: string[] = [];

	constructor(host: ICodeWindow<TWindow>) {
		super();
		const window = host.win;
		const rejectInterrupted = (): void => this.rejectPending(new Error('Agents Window reloaded before the handoff completed'));
		this._register(host.onWillLoad(rejectInterrupted));
		window.webContents.on('render-process-gone', rejectInterrupted);
		this._register(toDisposable(() => {
			if (!window.isDestroyed()) {
				window.webContents.off('render-process-gone', rejectInterrupted);
			}
		}));
		this._register(toDisposable(() => this.rejectPending(new Error('Agents Window closed before the handoff completed'))));
	}

	public enqueue(options: IOpenAgentsWindowOptions): Promise<void> {
		this.assertNotDisposed();
		const id = createUuid();
		return new Promise<void>((resolve, reject) => {
			this.pending.set(id, { options, resolve, reject });
			this.queue.push(id);
		});
	}

	public take(): { readonly id: string; readonly options: IOpenAgentsWindowOptions; } | undefined {
		const id = this.queue.shift();
		const handoff = id ? this.pending.get(id) : undefined;
		return handoff && id ? { id, options: handoff.options } : undefined;
	}

	public complete(result: IAgentsWindowHandoffResult): void {
		const handoff = this.pending.get(result.id);
		if (!handoff) {
			throw new Error('Agents Window handoff is not pending');
		}
		this.pending.delete(result.id);
		if (result.error) {
			handoff.reject(new Error(result.error));
		} else {
			handoff.resolve();
		}
	}

	private rejectPending(error: Error): void {
		for (const handoff of this.pending.values()) {
			handoff.reject(error);
		}
		this.pending.clear();
		this.queue.length = 0;
	}
}

class ManagedWindowHost<TWindow extends IWorkbenchWindow<TWindow>> extends Disposable {
	private readonly windowHost = this._register(new MutableDisposable<CodeWindow<TWindow>>());
	private readonly handoffs = this._register(new MutableDisposable<ManagedWindowHandoffs<TWindow>>());
	private opening: Promise<void> | undefined;
	private closing: Promise<void> | undefined;
	private resolveClosing: (() => void) | undefined;
	private rejectClosing: ((error: Error) => void) | undefined;
	private openRequests = 0;

	constructor(
		private readonly createWindow: (options: IWindowConstructorOptions & Pick<IWindowCreationOptions, 'title' | 'icon' | 'tabbingIdentifier'>) => TWindow,
		private readonly onDidClose: () => void,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();
	}

	public get codeWindow(): CodeWindow<TWindow> | undefined {
		return this.windowHost.value;
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
				this.windowHost.value!.focus();
				await this.opening;
				return;
			}

			const resources = new DisposableStore();
			const windowHost = this.instantiationService.createInstance(CodeWindow<TWindow>, this.createWindow, {
				...options,
				reopen: async () => {
					// Keep the old native window alive until its replacement exists,
					// including when it is the app's last window.
					this.handoffs.clear();
					this.windowHost.clearAndLeak();
					this.rejectClosing?.(new Error('Agents Window is being reopened'));
					this.closing = undefined;
					this.resolveClosing = undefined;
					this.rejectClosing = undefined;
					this.openRequests++;
					try {
						await this.open({ ...options, workspace: windowHost.openedWorkspace, state: windowHost.serializeWindowState() });
					} catch (error) {
						this.windowHost.value = windowHost;
						throw error;
					} finally {
						this.openRequests--;
					}
				},
			}, resources);
			this.windowHost.value = windowHost;
			const window = windowHost.win;
			resources.add(windowHost.onDidClose(() => {
				if (this.windowHost.value !== windowHost) return;
				this.resolveClosing?.();
				this.handoffs.clear();
				this.windowHost.clearAndLeak();
				if (this.openRequests === 0) this.onDidClose();
			}));

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
		this.windowHost.value!.close();
		return closing;
	}

	public failClose(window: TWindow, message: string): void {
		if (this.currentWindow === window) this.rejectClosing?.(new Error(message));
	}

	public enqueueHandoff(options: IOpenAgentsWindowOptions): Promise<void> {
		const window = this.currentWindow;
		if (!window) {
			return Promise.reject(new Error('Agents Window is unavailable for handoff'));
		}
		if (!this.handoffs.value) {
			this.handoffs.value = new ManagedWindowHandoffs(this.windowHost.value!);
		}
		return this.handoffs.value.enqueue(options);
	}

	public takeHandoff(): { readonly id: string; readonly options: IOpenAgentsWindowOptions; } | undefined {
		return this.handoffs.value?.take();
	}

	public completeHandoff(result: IAgentsWindowHandoffResult): void {
		if (!this.handoffs.value) {
			throw new Error('Agents Window handoff is not pending');
		}
		this.handoffs.value.complete(result);
	}

}

/** Owns window operations for the live Workbench windows of one Electron app. */
export class WindowsMainService<TWindow extends IWorkbenchWindow<TWindow>> extends Disposable implements IWindowsMainService {
	private readonly workbenchWindows = this._register(new DisposableMap<number, CodeWindow<TWindow>>());
	private readonly managedWindows = this._register(new DisposableMap<string, ManagedWindowHost<TWindow>>());
	private readonly fileRequests = this._register(new DisposableMap<number, WindowFileRequest>());
	private readonly workspaceOpenings = new Map<string, Promise<TWindow | undefined>>();
	private readonly recoveredWorkspaces = new Set<string>();
	private lastClosedWindowState: IWindowState | undefined;
	private nextFileRequest = 0;
	constructor(
		private readonly createEmptyWindow: (configuration?: IOpenConfiguration, reuseWindow?: TWindow) => Promise<TWindow | undefined>,
		private readonly platform: NodeJS.Platform,
		private readonly workspacePaths: IWorkspacePathService,
		@IAuxiliaryWindowsMainService private readonly auxiliaryWindowsMainService: IAuxiliaryWindowsMainService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();
		this._register(auxiliaryWindowsMainService.onDidChangeWindowState(({ parentId, event }) => {
			const parent = [...this.getWindows(), ...this.managedWindowValues()].find(window => window.id === parentId);
			if (!parent || parent.isDestroyed()) return;
			this.getWindowById(parent.id)?.send(AUXILIARY_WINDOW_STATE_CHANGED_CHANNEL, event);
			this.getWindowById(parent.id)?.send(WINDOW_ALWAYS_ON_TOP_CHANGED_CHANNEL, { windowName: event.windowName, alwaysOnTop: event.state.alwaysOnTop });
		}));
	}

	public getWindows(): readonly TWindow[] {
		return [...this.workbenchWindows].map(([, host]) => host.win).filter(window => !window.isDestroyed());
	}

	public getWindowById(id: number): ICodeWindow<TWindow> | undefined {
		const host = this.workbenchWindows.get(id)
			?? [...this.managedWindows].map(([, window]) => window.codeWindow).find(window => window?.win.id === id);
		return host && !host.win.isDestroyed() ? host : undefined;
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
		const lastMain = windows.map(window => this.getWindowById(window.id)!)
			.sort((a, b) => b.lastFocusTime - a.lastFocusTime)[0];
		if (lastMain) {
			return lastAuxiliary && auxiliaryParent && lastAuxiliary.lastFocusTime > lastMain.lastFocusTime ? auxiliaryParent : lastMain.win;
		}
		return auxiliaryParent;
	}

	/** Live window identity and configuration enter the sizing policy together for both window kinds. */
	public getNewWindowState(handler: WindowsStateHandler, settings: Readonly<Record<string, unknown>>, wasRestarted: boolean): IWindowState {
		const active = this.getLastActiveWindow();
		return handler.getNewWindowState({
			lastActiveWindow: active ? { state: this.getWindowById(active.id)!.serializeWindowState(), bounds: this.getWindowById(active.id)!.getBounds() } : undefined,
			lastClosedWindow: this.lastClosedWindowState,
			existingWindows: [...this.getWindows(), ...this.managedWindowValues()].map(window => this.getWindowById(window.id)!.getBounds()),
			newWindowDimensions: parseNewWindowDimensions(settings[NEW_WINDOW_DIMENSIONS_SETTING] ?? 'default'),
			restoreFullscreen: parseRestoreFullscreen(settings[RESTORE_FULLSCREEN_SETTING] ?? false),
			wasRestarted,
		});
	}

	private trackWindow(host: ICodeWindow<TWindow>, resources: DisposableStore): void {
		const window = host.win;
		let closingState: IWindowState | undefined;
		const closing = (): void => { closingState = host.serializeWindowState(); };
		window.on('close', closing);
		resources.add(toDisposable(() => window.off('close', closing)));
		resources.add(host.onDidClose(() => {
			if (this.getWindows().length + this.managedWindowValues().length === 0) this.lastClosedWindowState = closingState;
		}));
		const fullscreenChanged = (): void => host.send(WINDOW_FULLSCREEN_CHANGED_CHANNEL, host.isFullScreen());
		resources.add(host.onDidEnterFullScreen(fullscreenChanged));
		resources.add(host.onDidLeaveFullScreen(fullscreenChanged));
	}

	public updateWorkspace(id: number, workspace: IAnyWorkspaceIdentifier): void {
		const host = this.workbenchWindows.get(id)
			?? [...this.managedWindows].map(([, window]) => window.codeWindow).find(window => window?.id === id);
		if (!host) throw new Error(`Workbench window ${id} is not registered`);
		host.openedWorkspace = workspace;
	}

	public findWorkspace(workspace: IAnyWorkspaceIdentifier): TWindow | undefined {
		const lastActive = this.getLastActiveWindow();
		const hosts = [...this.workbenchWindows].map(([, host]) => host).filter(host => !host.win.isDestroyed())
			.sort((a, b) => a.id === lastActive?.id ? -1 : b.id === lastActive?.id ? 1 : b.lastFocusTime - a.lastFocusTime);
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
			if (child?.parentId === existing.id) focusWindow(child.win);
			else this.getWindowById(existing.id)!.focus();
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

	public async open(configuration: IOpenConfiguration): Promise<{ whenClosed: Promise<void>; whenFilesClosed: Promise<void>; }> {
		this.assertNotDisposed();
		const needsWorkbench = !!configuration.workspace || configuration.files.length > 0;
		const active = this.getLastActiveWindow(needsWorkbench ? 'workbench' : 'all');
		const reuse = !configuration.forceNewWindow && (configuration.forceReuseWindow || !configuration.workspace) ? active : undefined;
		const window = await this.createEmptyWindow(configuration, reuse);
		if (!window) {
			throw new Error('The launch request did not open a window');
		}
		const child = this.auxiliaryWindowsMainService.getFocusedWindow();
		if (child?.parentId === window.id) focusWindow(child.win);
		else this.getWindowById(window.id)!.focus();
		// CLI wait follows this document's edit lifetime, including a later load.
		const whenClosed = this.getWindowById(window.id)!.whenClosedOrLoaded;
		if (configuration.files.length === 0) {
			return { whenClosed, whenFilesClosed: whenClosed };
		}
		const request = new WindowFileRequest(window.id, { id: ++this.nextFileRequest, files: configuration.files, wait: configuration.waitForFiles });
		this.fileRequests.set(request.request.id, request);
		this.getWindowById(window.id)!.sendWhenReady(WINDOW_OPEN_FILES_CHANNEL, request.token, request.request);
		await request.whenOpened;
		return { whenClosed, whenFilesClosed: request.whenClosed };
	}

	public respondToFileOpen(window: TWindow, response: WindowFilesResponse): void {
		if (response.kind === 'ready') {
			const host = this.getWindowById(window.id);
			if (!host) throw new Error('Window has no Workbench renderer');
			host.setReady();
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
		const host = this.instantiationService.createInstance(CodeWindow<TWindow>, createWindow, { ...options, workspace: options.workspace ?? createEmptyWorkspaceIdentifier() }, resources);
		const window = host.win;
		if (this.workbenchWindows.has(window.id)) {
			host.dispose();
			throw new Error(`Workbench window ${window.id} is already registered`);
		}
		this.workbenchWindows.set(window.id, host);
		this.trackWindow(host, resources);
		resources.add(host.onDidClose(() => {
			for (const [id, request] of this.fileRequests) {
				if (request.windowId === window.id) {
					this.fileRequests.deleteAndDispose(id);
				}
			}
			if (this.workbenchWindows.get(window.id) === host) this.workbenchWindows.deleteAndLeak(window.id);
		}));
		const loading = (): void => {
			for (const [id, request] of this.fileRequests) {
				if (request.windowId === window.id) {
					this.fileRequests.deleteAndDispose(id);
				}
			}
		};
		resources.add(host.onWillLoad(loading));
		window.webContents.on('render-process-gone', loading);
		resources.add(toDisposable(() => {
			if (!window.isDestroyed()) window.webContents.off('render-process-gone', loading);
		}));
		return host;
	}

	public openManagedWindow(key: string, createWindow: (options: IWindowConstructorOptions & Pick<IWindowCreationOptions, 'title' | 'icon' | 'tabbingIdentifier'>) => TWindow, options: IManagedWindowOpenOptions<TWindow>, onDidClose: () => void): Promise<void> {
		let host = this.managedWindows.get(key);
		if (!host) {
			const created = this.instantiationService.createInstance(ManagedWindowHost<TWindow>, createWindow, () => {
				if (this.managedWindows.get(key) !== created) return;
				this.managedWindows.deleteAndDispose(key);
				onDidClose();
			});
			this.managedWindows.set(key, created);
			host = created;
		}
		return host.open({
			...options, initialize: (window, resources) => {
				this.trackWindow(this.getWindowById(window.id)!, resources);
				return options.initialize(window, resources);
			}
		});
	}

	public managedWindow(key: string): TWindow | undefined {
		return this.managedWindows.get(key)?.currentWindow;
	}

	public enqueueManagedWindowHandoff(key: string, options: IOpenAgentsWindowOptions): Promise<void> {
		const host = this.managedWindows.get(key);
		return host ? host.enqueueHandoff(options) : Promise.reject(new Error('Agents Window is unavailable for handoff'));
	}

	public takeManagedWindowHandoff(key: string): { readonly id: string; readonly options: IOpenAgentsWindowOptions; } | undefined {
		return this.managedWindows.get(key)?.takeHandoff();
	}

	public completeManagedWindowHandoff(key: string, result: IAgentsWindowHandoffResult): void {
		const host = this.managedWindows.get(key);
		if (!host) {
			throw new Error('Agents Window handoff is not pending');
		}
		host.completeHandoff(result);
	}

	public managedWindowValues(): readonly TWindow[] {
		return [...this.managedWindows].flatMap(([, host]) => host.currentWindow ?? []);
	}

	public closeManagedWindow(key: string): Promise<void> {
		return this.managedWindows.get(key)?.close() ?? Promise.resolve();
	}

	public selectWindowsToRestore<TEntry extends { readonly workspace: IAnyWorkspaceIdentifier; }>(
		session: { readonly windows: readonly TEntry[]; readonly active: number; } | undefined,
		configuredSetting: unknown,
		hasExplicitTarget: boolean,
		wasRestarted: boolean,
	): { readonly windows: readonly TEntry[]; readonly active: TEntry | undefined; } {
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

	public perform(source: TWindow, operation: WindowOperation): void | number | boolean | readonly IWorkbenchWindowInfo[] | IAuxiliaryWindowState | Promise<void> {
		const windows = [...this.getWindows(), ...this.managedWindowValues(), ...this.auxiliaryWindowsMainService.getWindows().map(window => window.win)].filter(window => !window.isDestroyed());
		if (!windows.includes(source)) throw new Error('Workbench window is closed');
		// Same-renderer editor windows share their owner's IPC route. Resolve only its descendants.
		const target = 'windowName' in operation && operation.windowName !== undefined
			? this.auxiliaryWindowsMainService.getWindows().find(window => window.parentId === source.id && window.win.webContents.mainFrame.name === operation.windowName)?.win
			: source;
		if (!target) throw new Error('Auxiliary window is closed or belongs to another workbench');
		switch (operation.kind) {
			case 'list':
				return windows.map((window): IWorkbenchWindowInfo => ({ id: window.id, title: window.getTitle(), focused: window.isFocused(), current: window === target }));
			case 'focus': {
				const target = windows.find(window => window.id === operation.windowId);
				if (!target) throw new Error('Workbench window is closed');
				const host = this.getWindowById(target.id);
				if (host) host.focus();
				else focusWindow(target);
				return;
			}
			case 'focusSelf': {
				const host = this.getWindowById(target.id);
				if (host) host.focus();
				else focusWindow(target);
				return;
			}
			case 'close': {
				const host = this.getWindowById(target.id);
				if (host) host.close();
				else target.close();
				return;
			}
			case 'closeOthers':
				for (const window of [...this.getWindows(), ...this.managedWindowValues()]) {
					if (window !== source) this.getWindowById(window.id)?.close();
				}
				return;
			case 'getAuxiliaryState':
				return this.auxiliaryWindowsMainService.getWindowByWebContents(target.webContents as unknown as import('electron').WebContents)!.getState();
			case 'getZoom':
				return target.webContents.getZoomLevel();
			case 'getZoomFactor':
				return source.webContents.getZoomFactor();
			case 'getFullscreen':
				return this.getWindowById(source.id)!.isFullScreen();
			case 'setZoom':
				for (const window of operation.allWindows ? [source, ...this.auxiliaryWindowsMainService.getWindows().filter(window => window.parentId === source.id).map(window => window.win)] : [target]) {
					window.webContents.setZoomLevel(operation.level);
					const host = this.getWindowById(window.id);
					if (host) host.send(WINDOW_ZOOM_CHANGED_CHANNEL, operation.level);
					else window.webContents.send(WINDOW_ZOOM_CHANGED_CHANNEL, operation.level);
					const auxiliary = this.auxiliaryWindowsMainService.getWindows().find(candidate => candidate.id === window.id);
					if (auxiliary) this.getWindowById(source.id)!.send(AUXILIARY_WINDOW_STATE_CHANGED_CHANNEL, { windowName: auxiliary.win.webContents.mainFrame.name, state: auxiliary.getState() });
				}
				return;
			case 'getAlwaysOnTop':
			case 'setAlwaysOnTop': {
				if (operation.kind === 'getAlwaysOnTop') return target.isAlwaysOnTop();
				target.setAlwaysOnTop(operation.enabled);

				return;
			}
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
			case 'newTab': {
				if (this.platform !== 'darwin') throw new Error('Window tabs require macOS');
				const parent = this.getWindowById(source.id)!;
				return this.createEmptyWindow().then(tab => {
					const child = tab && this.getWindowById(tab.id);
					if (child) parent.addTabbedWindow(child);
				});
			}
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
	private readonly cancellation = new CancellationTokenSource();
	public readonly token = this.cancellation.token;

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
		this.cancellation.dispose(true);
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
