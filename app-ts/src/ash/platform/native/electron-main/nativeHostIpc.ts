import type {
	IpcRoute,
} from "../../ipc/electron-main/trustedIpcRouter.js";
import {
	NATIVE_HOST_OPEN_FOLDER_CHANNEL,
	NATIVE_HOST_PICK_FOLDER_CHANNEL,
	NATIVE_HOST_OPEN_WORKSPACE_CHANNEL,
	NATIVE_HOST_GET_ACCESSIBILITY_SUPPORT_CHANNEL,
	NATIVE_HOST_SAVE_FILE_CHANNEL,
	NATIVE_HOST_SET_WINDOW_THEME_CHANNEL,
	NATIVE_HOST_TOGGLE_DEVELOPER_TOOLS_CHANNEL,
	type INativeSaveFileOptions,
	type INativeWindowTheme,
	validateAccessibilitySupportRead,
	validateNativeWindowTheme,
	validateOpenFolder,
	validatePickFolder,
	validateOpenWorkspace,
	validateSaveFileOptions,
	validateToggleDeveloperTools,
} from "../common/nativeHost.js";

/** Main-process implementation of native operations for one window. */
export interface INativeHostMainService {
	openFolder(): Promise<void>;
	pickFolder(): Promise<string | undefined>;
	openWorkspace(root: string): Promise<void>;
	saveFile(options: INativeSaveFileOptions): Promise<string | undefined>;
	isAccessibilitySupportEnabled(): boolean;
	setWindowTheme(theme: INativeWindowTheme): void;
	toggleDeveloperTools(): void;
}

/** Exposes one window's native operations through the trusted IPC router. */
export function nativeHostIpcRoutes(
	service: INativeHostMainService,
): readonly IpcRoute<unknown, unknown>[] {
	return [
		{
			channel: NATIVE_HOST_GET_ACCESSIBILITY_SUPPORT_CHANNEL,
			validate: validateAccessibilitySupportRead,
			invoke: () => service.isAccessibilitySupportEnabled(),
		},
		{
			channel: NATIVE_HOST_OPEN_FOLDER_CHANNEL,
			validate: validateOpenFolder,
			invoke: () => service.openFolder(),
		},
		{
			channel: NATIVE_HOST_PICK_FOLDER_CHANNEL,
			validate: validatePickFolder,
			invoke: () => service.pickFolder(),
		},
		{
			channel: NATIVE_HOST_OPEN_WORKSPACE_CHANNEL,
			validate: validateOpenWorkspace,
			invoke: (root) => service.openWorkspace(root as string),
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
			channel: NATIVE_HOST_TOGGLE_DEVELOPER_TOOLS_CHANNEL,
			validate: validateToggleDeveloperTools,
			invoke: () => service.toggleDeveloperTools(),
		},
	];
}
