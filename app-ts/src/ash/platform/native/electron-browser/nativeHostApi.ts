import { invoke, subscribe } from "../../ipc/electron-browser/rendererIpc.js";
import { NATIVE_HOST_ACCESSIBILITY_SUPPORT_CHANGED_CHANNEL, NATIVE_HOST_GET_ACCESSIBILITY_SUPPORT_CHANNEL, NATIVE_HOST_OPEN_FOLDER_CHANNEL, NATIVE_HOST_OPEN_WORKSPACE_CHANNEL, NATIVE_HOST_PICK_FOLDER_CHANNEL, NATIVE_HOST_SAVE_FILE_CHANNEL, NATIVE_HOST_SET_WINDOW_THEME_CHANNEL, NATIVE_HOST_TOGGLE_DEVELOPER_TOOLS_CHANNEL, type INativeHostApi, validateAccessibilitySupport } from "../common/nativeHost.js";

export function createNativeHostApi(): INativeHostApi {
	return {
		openFolder: () => invoke<void>(NATIVE_HOST_OPEN_FOLDER_CHANNEL),
		pickFolder: () => invoke<string | undefined>(NATIVE_HOST_PICK_FOLDER_CHANNEL),
		openWorkspace: (root) => invoke<void>(NATIVE_HOST_OPEN_WORKSPACE_CHANNEL, root),
		setWindowTheme: (theme) => invoke<void>(NATIVE_HOST_SET_WINDOW_THEME_CHANNEL, theme),
		toggleDeveloperTools: () => invoke<void>(NATIVE_HOST_TOGGLE_DEVELOPER_TOOLS_CHANNEL),
		saveFile: (options) => invoke<string | undefined>(NATIVE_HOST_SAVE_FILE_CHANNEL, options),
		async isAccessibilitySupportEnabled(): Promise<boolean> {
			return validateAccessibilitySupport(await invoke<unknown>(NATIVE_HOST_GET_ACCESSIBILITY_SUPPORT_CHANNEL));
		},
		onDidChangeAccessibilitySupport(listener) {
			return subscribe<unknown>(NATIVE_HOST_ACCESSIBILITY_SUPPORT_CHANGED_CHANNEL, (value) => listener(validateAccessibilitySupport(value)));
		},
	};
}
