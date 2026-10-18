import type { EventEmitter } from 'node:events';
import { toDisposable } from '../../../base/common/lifecycle.js';
import type { OpenDialogOptions, OpenDialogReturnValue, SaveDialogOptions, SaveDialogReturnValue } from '../../../base/parts/sandbox/common/electronTypes.js';
import type { Event } from '../../../base/common/event.js';
import type { IServerChannel } from '../../../base/parts/ipc/common/ipc.js';
import type { IThemeMainService } from '../../theme/electron-main/themeMainService.js';
import { WINDOW_SPLASH_READ_CHANNEL, WINDOW_SPLASH_SAVE_CHANNEL, validatePartsSplash, type IPartsSplash } from '../../theme/common/themeService.js';
import type {
	IpcRoute,
} from "../../ipc/electron-main/trustedIpcRouter.js";
import {
	NATIVE_HOST_IS_ADMIN_CHANNEL,
	NATIVE_HOST_GET_TITLE_BAR_STYLE_CHANNEL,
	NATIVE_HOST_PICK_FOLDER_CHANNEL,
	NATIVE_HOST_PICK_FILE_CHANNEL,
	NATIVE_HOST_OPEN_WORKSPACE_CHANNEL,
	NATIVE_HOST_OPEN_WINDOW_CHANNEL,
	NATIVE_HOST_OPEN_AGENTS_WINDOW_CHANNEL,
	NATIVE_HOST_TERMINAL_MOVE_CHANNEL, NATIVE_HOST_TERMINAL_TAKE_CHANNEL, NATIVE_HOST_TERMINAL_COMPLETE_CHANNEL,
	validateTerminalWindowTransferMove, validateTerminalWindowTransferResult,
	type ITerminalWindowTransfer, type ITerminalWindowTransferResult,
	NATIVE_HOST_GET_ACCESSIBILITY_SUPPORT_CHANNEL,
	NATIVE_HOST_SAVE_FILE_CHANNEL,
	NATIVE_HOST_SET_WINDOW_THEME_CHANNEL,
	NATIVE_HOST_SET_WINDOW_DIMMED_CHANNEL,
	NATIVE_HOST_TOGGLE_DEVELOPER_TOOLS_CHANNEL,
	NATIVE_HOST_SYNC_SYSTEM_WIDE_KEYBINDINGS_CHANNEL,
	NATIVE_HOST_DIALOG_CHANNEL,
	NATIVE_HOST_REVEAL_FILE_CHANNEL,
	type INativeSystemWideKeybinding,
	type INativeSystemWideKeybindingResult,
	type INativeWindowTheme,
	type IOpenAgentsWindowOptions,
	type NativeDialogOperation,
	validateAccessibilitySupportRead,
	validateNativeWindowTheme,
	validateWindowDimmed,
	validatePickFolder,
	validateOpenDialogOptions,
	validateOpenWorkspace,
	validateOpenAgentsWindow,
	validateSaveDialogOptions,
	validateToggleDeveloperTools,
	validateSystemWideKeybindings,
	validateNativeDialogOperation,
	validateRevealFilePath,
} from "../common/nativeHost.js";

import { validateOpenEmptyWindowOptions, type IOpenEmptyWindowOptions, type TitleBarStyleConfiguration } from '../../window/common/window.js';
import type { AgentHostEditorUpdate, IAgentHostEditorState, IAgentsWindowInvitation } from '../../chat/common/agentsWindowInvitation.js';
import { URI, type UriComponents } from '../../../base/common/uri.js';
import {
	AGENT_HOST_EDITOR_STATE_CHANNEL, AGENT_HOST_EDITOR_UPDATE_CHANNEL, AGENTS_WINDOW_INVITATION_CLAIM_CHANNEL,
	AGENTS_WINDOW_INVITATION_SHOWN_CHANNEL, AGENTS_WINDOW_INVITATION_RELEASE_CHANNEL,
	validateAgentHostEditorUpdate, validateAgentHostEditorResource, validateAgentsWindowInvitationId,
} from '../common/nativeHost.js';

/** Main-process implementation of native operations for one window. */
export interface INativeHostMainService {
	getTitleBarStyle(): TitleBarStyleConfiguration;
	isAdmin(): Promise<boolean>;
	performDialogOperation(operation: NativeDialogOperation): unknown;
	pickFolder(): Promise<string | undefined>;
	showOpenDialog(options: OpenDialogOptions): Promise<OpenDialogReturnValue>;
	openWorkspace(root: string, forceNewWindow?: boolean): Promise<void>;
	openWindow(options: IOpenEmptyWindowOptions): Promise<void>;
	openAgentsWindow(options?: IOpenAgentsWindowOptions): Promise<void>;
	moveTerminalToWindow(transfer: ITerminalWindowTransfer, targetWindowId?: number): Promise<ITerminalWindowTransferResult>;
	takeTerminalTransfer(): ITerminalWindowTransfer | undefined;
	completeTerminalTransfer(result: ITerminalWindowTransferResult): void;
	getAgentHostEditorState(): IAgentHostEditorState;
	updateAgentHostEditorState(update: AgentHostEditorUpdate): Promise<void>;
	claimAgentsWindowInvitation(resource: URI): IAgentsWindowInvitation | undefined;
	markAgentsWindowInvitationShown(id: string): Promise<void>;
	releaseAgentsWindowInvitation(id: string): void;
	revealFile(path: string): void;
	showSaveDialog(options: SaveDialogOptions): Promise<SaveDialogReturnValue>;
	isAccessibilitySupportEnabled(): boolean;
	setWindowTheme(theme: INativeWindowTheme): void;
	setWindowDimmed(dimmed: boolean): void;
	toggleDeveloperTools(): void;
	syncSystemWideKeybindings(bindings: readonly INativeSystemWideKeybinding[]): INativeSystemWideKeybindingResult;
}

/** Exposes one window's native operations through the trusted IPC router. */
export function nativeHostIpcRoutes(
	service: INativeHostMainService,
): readonly IpcRoute<unknown, unknown>[] {
	return [

		{
			channel: NATIVE_HOST_TERMINAL_MOVE_CHANNEL,
			validate: validateTerminalWindowTransferMove,
			invoke: value => {
				const { transfer, targetWindowId } = value as ReturnType<typeof validateTerminalWindowTransferMove>;
				return service.moveTerminalToWindow(transfer, targetWindowId);
			},
		},
		{
			channel: NATIVE_HOST_TERMINAL_TAKE_CHANNEL,
			validate: value => { if (value !== undefined) throw new TypeError('Terminal transfer reads accept no arguments'); return undefined; },
			invoke: () => service.takeTerminalTransfer(),
		},
		{ channel: NATIVE_HOST_TERMINAL_COMPLETE_CHANNEL, validate: validateTerminalWindowTransferResult, invoke: value => service.completeTerminalTransfer(value as ITerminalWindowTransferResult) },
		{
			channel: AGENT_HOST_EDITOR_STATE_CHANNEL,
			validate: value => { if (value !== undefined) throw new TypeError('Editor state reads accept no arguments'); return undefined; },
			invoke: () => service.getAgentHostEditorState(),
		},
		{ channel: AGENT_HOST_EDITOR_UPDATE_CHANNEL, validate: validateAgentHostEditorUpdate, invoke: update => service.updateAgentHostEditorState(update as AgentHostEditorUpdate) },
		{ channel: AGENTS_WINDOW_INVITATION_CLAIM_CHANNEL, validate: validateAgentHostEditorResource, invoke: resource => service.claimAgentsWindowInvitation(URI.revive(resource as UriComponents)) },
		{ channel: AGENTS_WINDOW_INVITATION_SHOWN_CHANNEL, validate: validateAgentsWindowInvitationId, invoke: id => service.markAgentsWindowInvitationShown(id as string) },
		{ channel: AGENTS_WINDOW_INVITATION_RELEASE_CHANNEL, validate: validateAgentsWindowInvitationId, invoke: id => service.releaseAgentsWindowInvitation(id as string) },
		{
			channel: NATIVE_HOST_GET_TITLE_BAR_STYLE_CHANNEL,
			validate: value => {
				if (value !== undefined) { throw new TypeError('Window title bar reads accept no arguments'); }
				return undefined;
			},
			invoke: () => service.getTitleBarStyle(),
		},
		{
			channel: NATIVE_HOST_IS_ADMIN_CHANNEL,
			validate: value => {
				if (value !== undefined) { throw new TypeError('Desktop privilege reads accept no arguments'); }
				return undefined;
			},
			invoke: () => service.isAdmin(),
		},
		{
			channel: NATIVE_HOST_DIALOG_CHANNEL,
			validate: validateNativeDialogOperation,
			invoke: operation => service.performDialogOperation(operation as NativeDialogOperation),
		},
		{
			channel: NATIVE_HOST_GET_ACCESSIBILITY_SUPPORT_CHANNEL,
			validate: validateAccessibilitySupportRead,
			invoke: () => service.isAccessibilitySupportEnabled(),
		},
		{
			channel: NATIVE_HOST_PICK_FOLDER_CHANNEL,
			validate: validatePickFolder,
			invoke: () => service.pickFolder(),
		},
		...fileDialogIpcRoutes(service),
		{
			channel: NATIVE_HOST_OPEN_WORKSPACE_CHANNEL,
			validate: validateOpenWorkspace,
			invoke: value => { const request = value as ReturnType<typeof validateOpenWorkspace>; return service.openWorkspace(request.root, request.forceNewWindow); },
		},
		{
			channel: NATIVE_HOST_OPEN_WINDOW_CHANNEL,
			validate: validateOpenEmptyWindowOptions,
			invoke: options => service.openWindow(options as IOpenEmptyWindowOptions),
		},
		{
			channel: NATIVE_HOST_OPEN_AGENTS_WINDOW_CHANNEL,
			validate: validateOpenAgentsWindow,
			invoke: options => service.openAgentsWindow(options as IOpenAgentsWindowOptions | undefined),
		},
		{
			channel: NATIVE_HOST_REVEAL_FILE_CHANNEL,
			validate: validateRevealFilePath,
			invoke: path => service.revealFile(path as string),
		},
		...windowAppearanceIpcRoutes(service),
		{
			channel: NATIVE_HOST_TOGGLE_DEVELOPER_TOOLS_CHANNEL,
			validate: validateToggleDeveloperTools,
			invoke: () => service.toggleDeveloperTools(),
		},
		{
			channel: NATIVE_HOST_SYNC_SYSTEM_WIDE_KEYBINDINGS_CHANNEL,
			validate: validateSystemWideKeybindings,
			invoke: bindings => service.syncSystemWideKeybindings(bindings as readonly INativeSystemWideKeybinding[]),
		},
	];
}

/** File pickers belong to their requesting window; picking a path grants no file access. */
export function fileDialogIpcRoutes(service: Pick<INativeHostMainService, 'showOpenDialog' | 'showSaveDialog'>): readonly IpcRoute<unknown, unknown>[] {
	return [
		{
			channel: NATIVE_HOST_PICK_FILE_CHANNEL,
			validate: validateOpenDialogOptions,
			invoke: options => service.showOpenDialog(options as OpenDialogOptions),
		},
		{
			channel: NATIVE_HOST_SAVE_FILE_CHANNEL,
			validate: validateSaveDialogOptions,
			invoke: options => service.showSaveDialog(options as SaveDialogOptions),
		},
	];
}

/** Window appearance is available to every Electron renderer, including Sessions. */
export function windowAppearanceIpcRoutes(service: Pick<INativeHostMainService, 'setWindowTheme' | 'setWindowDimmed'>): readonly IpcRoute<unknown, unknown>[] {
	return [
		{
			channel: NATIVE_HOST_SET_WINDOW_THEME_CHANNEL,
			validate: validateNativeWindowTheme,
			invoke: theme => service.setWindowTheme(theme as INativeWindowTheme),
		},
		{
			channel: NATIVE_HOST_SET_WINDOW_DIMMED_CHANNEL,
			validate: validateWindowDimmed,
			invoke: dimmed => service.setWindowDimmed(dimmed as boolean),
		},
	];
}

export function colorSchemeChannel(service: IThemeMainService): IServerChannel {
	return {
		async call<T>(_context: string, command: string, arg?: unknown): Promise<T> {
			if (command !== 'getOSColorScheme' || arg !== undefined) { throw new TypeError('Invalid system color scheme read'); }
			return service.getColorScheme() as T;
		},
		listen<T>(_context: string, event: string, arg?: unknown): Event<T> {
			if (event !== 'onDidChangeColorScheme' || arg !== undefined) { throw new TypeError('Invalid system color scheme subscription'); }
			return service.onDidChangeColorScheme as Event<T>;
		},
	};
}

/** The trusted window host supplies the cache scope; renderers cannot write another window's state. */
export function windowSplashIpcRoutes(service: IThemeMainService, scope: () => string, setBackground: (color: string) => void): readonly IpcRoute<unknown, unknown>[] {
	return [
		{
			channel: WINDOW_SPLASH_READ_CHANNEL,
			validate: value => {
				if (value !== undefined) throw new TypeError('Window splash reads accept no arguments');
				return undefined;
			},
			invoke: () => service.getWindowSplash(scope()),
		},
		{
			channel: WINDOW_SPLASH_SAVE_CHANNEL,
			validate: validatePartsSplash,
			invoke: value => {
				const splash = value as IPartsSplash;
				setBackground(splash.colorInfo.background);
				return service.saveWindowSplash(scope(), splash);
			},
		},
	];
}

/** Subscriptions are owned by the window IPC connection, including listener cleanup. */
export function powerMonitorChannel(monitor: Pick<EventEmitter, 'on' | 'removeListener'>): IServerChannel {
	return {
		async call(): Promise<never> { throw new TypeError('Power monitor accepts subscriptions only'); },
		listen<T>(_context: string, event: string, arg?: unknown): Event<T> {
			if (arg !== undefined || event !== 'onDidSuspendOS' && event !== 'onDidResumeOS') {
				throw new TypeError('Invalid power monitor subscription');
			}
			return (listener, thisArgs, disposables) => {
				const name = event === 'onDidSuspendOS' ? 'suspend' : 'resume';
				const callback = () => listener.call(thisArgs, undefined as T);
				monitor.on(name, callback);
				const subscription = toDisposable(() => monitor.removeListener(name, callback));
				if (Array.isArray(disposables)) disposables.push(subscription);
				else disposables?.add(subscription);
				return subscription;
			};
		},
	};
}
