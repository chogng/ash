import { DisposableStore, toDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
import { CONFIGURATION_CHANGED_CHANNEL } from '../../configuration/common/configurationIpc.js';
import { configurationIpcRoutes, type ConfigurationMainService } from '../../configuration/electron-main/configurationMainService.js';
import type { IpcRoute } from '../../ipc/electron-main/trustedIpcRouter.js';
import { KEYBINDINGS_RESOURCE_CHANGED_CHANNEL } from '../../keybinding/common/keybindingsResource.js';
import { keybindingsResourceIpcRoutes, type KeybindingsResourceMainService } from '../../keybinding/electron-main/keybindingsResourceMainService.js';
import { NATIVE_KEYBOARD_LAYOUT_CHANGED_CHANNEL } from '../../keyboardLayout/common/nativeKeyboardLayout.js';
import { USER_KEYBOARD_LAYOUT_CHANGED_CHANNEL } from '../../keyboardLayout/common/userKeyboardLayout.js';
import { nativeKeyboardLayoutIpcRoutes, type NativeKeyboardLayoutMainService } from '../../keyboardLayout/electron-main/nativeKeyboardLayoutMainService.js';
import { userKeyboardLayoutIpcRoutes, type UserKeyboardLayoutMainService } from '../../keyboardLayout/electron-main/userKeyboardLayoutMainService.js';
import { WINDOW_CLOSE_RESPONSE_CHANNEL, WINDOW_OPERATION_CHANNEL, WINDOW_PREPARE_CLOSE_CHANNEL, WINDOW_ZOOM_CHANGED_CHANNEL, validateWindowCloseResponse, validateWindowOperation, type WindowCloseResponse, type WindowOperation, type IWorkbenchWindowInfo } from '../../window/common/window.js';
import { focusWindow, type IFocusableWindow } from '../../window/electron-main/window.js';

export interface IWorkbenchWindow<TWindow> extends IFocusableWindow {
	readonly id: number;
	on(event: 'close', listener: (event: { preventDefault(): void }) => void): unknown;
	off(event: 'close', listener: (event: { preventDefault(): void }) => void): unknown;
	readonly webContents: {
		getZoomLevel(): number;
		setZoomLevel(level: number): void;
		on(event: 'zoom-changed' | 'did-start-loading' | 'render-process-gone', listener: () => void): unknown;
		off(event: 'zoom-changed' | 'did-start-loading' | 'render-process-gone', listener: () => void): unknown;
		send(channel: string, level: number): void;
	};
	getTitle(): string;
	isFocused(): boolean;
	close(): void;
	isAlwaysOnTop(): boolean;
	setAlwaysOnTop(enabled: boolean): void;
	selectNextTab(): void;
	selectPreviousTab(): void;
	moveTabToNewWindow(): void;
	mergeAllWindows(): void;
	toggleTabBar(): void;
	addTabbedWindow(window: TWindow): void;
}

/** Owns window operations for the live Workbench windows of one Electron app. */
export class WindowsMainService<TWindow extends IWorkbenchWindow<TWindow>> {
	private readonly closeStates = new Map<TWindow, { ready: boolean; authorized: boolean; closingChild: boolean; childClosed: boolean; pendingToken: number | undefined; timer: ReturnType<typeof setTimeout> | undefined }>();
	private nextCloseToken = 0;
	constructor(
		private readonly getWindows: () => readonly TWindow[],
		private readonly createEmptyWindow: () => Promise<TWindow | undefined>,
		private readonly platform: NodeJS.Platform = process.platform,
		private readonly getParentWindowId: (window: TWindow) => number | undefined = () => undefined,
		private readonly reportCloseFailure: (window: TWindow, message: string) => void | Promise<void> = () => {},
	) {}

	public trackClose(window: TWindow, beforeClose?: () => Promise<void>): IDisposable {
		const state = { ready: false, authorized: false, closingChild: false, childClosed: false, pendingToken: undefined as number | undefined, timer: undefined as ReturnType<typeof setTimeout> | undefined };
		this.closeStates.set(window, state);
		const clearPending = (): void => {
			if (state.timer) clearTimeout(state.timer);
			state.timer = undefined;
			state.pendingToken = undefined;
		};
		const onClose = (event: { preventDefault(): void }): void => {
			if (state.authorized) return;
			// A parent must wait for its dedicated window's save join before starting its own.
			if (beforeClose && !state.childClosed) {
				event.preventDefault();
				if (state.closingChild) return;
				state.closingChild = true;
				void beforeClose().then(() => {
					state.closingChild = false;
					state.childClosed = true;
					if (!window.isDestroyed()) window.close();
				}, error => {
					state.closingChild = false;
					console.error('Failed to close a child window before its parent', error);
				});
				return;
			}
			if (!state.ready) return;
			event.preventDefault();
			if (state.pendingToken !== undefined) return;
			const token = ++this.nextCloseToken;
			state.pendingToken = token;
			state.timer = setTimeout(() => {
				clearPending();
				state.childClosed = false;
				this.reportFailure(window, 'The window did not respond to the close request.');
			}, 30_000);
			window.webContents.send(WINDOW_PREPARE_CLOSE_CHANNEL, token);
		};
		const onRendererLoading = (): void => { state.ready = false; state.childClosed = false; clearPending(); };
		window.on('close', onClose);
		window.webContents.on('did-start-loading', onRendererLoading);
		window.webContents.on('render-process-gone', onRendererLoading);
		return toDisposable(() => {
			clearPending();
			this.closeStates.delete(window);
			window.off('close', onClose);
			window.webContents.off('did-start-loading', onRendererLoading);
			window.webContents.off('render-process-gone', onRendererLoading);
		});
	}

	public respondToClose(window: TWindow, response: WindowCloseResponse): void {
		const state = this.closeStates.get(window);
		if (!state || window.isDestroyed()) throw new Error('Workbench window is closed');
		if (response.kind === 'ready') {
			state.ready = true;
			return;
		}
		if (state.pendingToken !== response.token) throw new Error('Window close request is no longer active');
		if (state.timer) clearTimeout(state.timer);
		state.timer = undefined;
		state.pendingToken = undefined;
		if (response.kind === 'complete') {
			state.authorized = true;
			window.close();
		} else {
			state.childClosed = false;
			this.reportFailure(window, response.message);
		}
	}

	private reportFailure(window: TWindow, message: string): void {
		void Promise.resolve(this.reportCloseFailure(window, message)).catch(error => console.error('Failed to report window close error', error));
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
			window.webContents.off('zoom-changed', onZoomChanged);
		});
	}

	public perform(source: TWindow, operation: WindowOperation): void | number | boolean | readonly IWorkbenchWindowInfo[] | Promise<void> {
		const windows = this.getWindows().filter(window => !window.isDestroyed());
		if (!windows.includes(source)) throw new Error('Workbench window is closed');
		switch (operation.kind) {
			case 'list':
				return windows.map((window): IWorkbenchWindowInfo => {
					const parentId = this.getParentWindowId(window);
					return { id: window.id, title: window.getTitle(), focused: window.isFocused(), ...(parentId !== undefined ? { parentId } : {}) };
				});
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

export function windowCloseResponseIpcRoute<TWindow extends IWorkbenchWindow<TWindow>>(service: WindowsMainService<TWindow>, window: TWindow): IpcRoute<unknown, unknown> {
	return {
		channel: WINDOW_CLOSE_RESPONSE_CHANNEL,
		validate: validateWindowCloseResponse,
		invoke: response => service.respondToClose(window, response as WindowCloseResponse),
	};
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
