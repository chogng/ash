import type { Event } from '../../../base/common/event.js';
import type { IServerChannel } from '../../../base/parts/ipc/common/ipc.js';
import type { IThemeMainService } from '../../theme/electron-main/themeMainService.js';
import type {
	IpcRoute,
} from "../../ipc/electron-main/trustedIpcRouter.js";
import {
	NATIVE_HOST_IS_ADMIN_CHANNEL,
	NATIVE_HOST_PICK_FOLDER_CHANNEL,
	NATIVE_HOST_PICK_FILE_CHANNEL,
	NATIVE_HOST_OPEN_WORKSPACE_CHANNEL,
	NATIVE_HOST_OPEN_WINDOW_CHANNEL,
	NATIVE_HOST_OPEN_AGENTS_WINDOW_CHANNEL,
	NATIVE_HOST_GET_ACCESSIBILITY_SUPPORT_CHANNEL,
	NATIVE_HOST_SAVE_FILE_CHANNEL,
	NATIVE_HOST_SET_WINDOW_THEME_CHANNEL,
	NATIVE_HOST_SET_WINDOW_DIMMED_CHANNEL,
	NATIVE_HOST_TOGGLE_DEVELOPER_TOOLS_CHANNEL,
	NATIVE_HOST_SYNC_SYSTEM_WIDE_KEYBINDINGS_CHANNEL,
	NATIVE_HOST_SHELL_COMMAND_CHANNEL,
	NATIVE_HOST_DIALOG_CHANNEL,
	NATIVE_HOST_REVEAL_FILE_CHANNEL,
	type INativeSystemWideKeybinding,
	type INativeSystemWideKeybindingResult,
	type INativeSaveFileOptions,
	type INativeOpenDialogOptions,
	type INativeWindowTheme,
	type IOpenAgentsWindowOptions,
	type ShellCommandOperation,
	type NativeDialogOperation,
	validateAccessibilitySupportRead,
	validateNativeWindowTheme,
	validateWindowDimmed,
	validatePickFolder,
	validatePickFile,
	validateOpenWorkspace,
	validateOpenAgentsWindow,
	validateSaveFileOptions,
	validateToggleDeveloperTools,
	validateSystemWideKeybindings,
	validateShellCommandOperation,
	validateNativeDialogOperation,
	validateRevealFilePath,
} from "../common/nativeHost.js";

import { validateOpenEmptyWindowOptions, type IOpenEmptyWindowOptions } from '../../window/common/window.js';

/** Main-process implementation of native operations for one window. */
export interface INativeHostMainService {
	isAdmin(): Promise<boolean>;
	performDialogOperation(operation: NativeDialogOperation): unknown;
	performShellCommand(operation: ShellCommandOperation): Promise<string>;
	pickFolder(): Promise<string | undefined>;
	pickFile(options: INativeOpenDialogOptions): Promise<readonly string[] | undefined>;
	openWorkspace(root: string): Promise<void>;
	openWindow(options: IOpenEmptyWindowOptions): Promise<void>;
	openAgentsWindow(options?: IOpenAgentsWindowOptions): Promise<void>;
	revealFile(path: string): void;
	saveFile(options: INativeSaveFileOptions): Promise<string | undefined>;
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
			channel: NATIVE_HOST_SHELL_COMMAND_CHANNEL,
			validate: validateShellCommandOperation,
			invoke: operation => service.performShellCommand(operation as ShellCommandOperation),
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
			invoke: (root) => service.openWorkspace(root as string),
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
export function fileDialogIpcRoutes(service: Pick<INativeHostMainService, 'pickFile' | 'saveFile'>): readonly IpcRoute<unknown, unknown>[] {
	return [
		{
			channel: NATIVE_HOST_PICK_FILE_CHANNEL,
			validate: validatePickFile,
			invoke: options => service.pickFile(options as INativeOpenDialogOptions),
		},
		{
			channel: NATIVE_HOST_SAVE_FILE_CHANNEL,
			validate: validateSaveFileOptions,
			invoke: options => service.saveFile(options as INativeSaveFileOptions),
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
