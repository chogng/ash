import type {
	IpcRoute,
} from "../../ipc/electron-main/trustedIpcRouter.js";
import {
	NATIVE_HOST_PICK_FOLDER_CHANNEL,
	NATIVE_HOST_PICK_FILE_CHANNEL,
	NATIVE_HOST_OPEN_WORKSPACE_CHANNEL,
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
	type ShellCommandOperation,
	type NativeDialogOperation,
	validateAccessibilitySupportRead,
	validateNativeWindowTheme,
	validateWindowDimmed,
	validatePickFolder,
	validatePickFile,
	validateOpenWorkspace,
	validateSaveFileOptions,
	validateToggleDeveloperTools,
	validateSystemWideKeybindings,
	validateShellCommandOperation,
	validateNativeDialogOperation,
	validateRevealFilePath,
} from "../common/nativeHost.js";

/** Main-process implementation of native operations for one window. */
export interface INativeHostMainService {
	performDialogOperation(operation: NativeDialogOperation): unknown;
	performShellCommand(operation: ShellCommandOperation): Promise<string>;
	pickFolder(): Promise<string | undefined>;
	pickFile(options: INativeOpenDialogOptions): Promise<readonly string[] | undefined>;
	openWorkspace(root: string): Promise<void>;
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
		{
			channel: NATIVE_HOST_PICK_FILE_CHANNEL,
			validate: validatePickFile,
			invoke: options => service.pickFile(options as INativeOpenDialogOptions),
		},
		{
			channel: NATIVE_HOST_OPEN_WORKSPACE_CHANNEL,
			validate: validateOpenWorkspace,
			invoke: (root) => service.openWorkspace(root as string),
		},
		{
			channel: NATIVE_HOST_REVEAL_FILE_CHANNEL,
			validate: validateRevealFilePath,
			invoke: path => service.revealFile(path as string),
		},
		{
			channel: NATIVE_HOST_SAVE_FILE_CHANNEL,
			validate: validateSaveFileOptions,
			invoke: (options) => service.saveFile(options as INativeSaveFileOptions),
		},
		{
			channel: NATIVE_HOST_SET_WINDOW_THEME_CHANNEL,
			validate: validateNativeWindowTheme,
			invoke: (theme) => service.setWindowTheme(theme as INativeWindowTheme),
		},
		{
			channel: NATIVE_HOST_SET_WINDOW_DIMMED_CHANNEL,
			validate: validateWindowDimmed,
			invoke: dimmed => service.setWindowDimmed(dimmed as boolean),
		},
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
