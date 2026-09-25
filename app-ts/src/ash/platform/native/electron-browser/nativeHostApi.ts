import { invoke, subscribe } from "../../ipc/electron-browser/rendererIpc.js";
import {
	NATIVE_HOST_ACCESSIBILITY_SUPPORT_CHANGED_CHANNEL,
	NATIVE_HOST_DIALOG_CHANNEL,
	NATIVE_HOST_GET_ACCESSIBILITY_SUPPORT_CHANNEL,
	NATIVE_HOST_OPEN_WORKSPACE_CHANNEL,
	NATIVE_HOST_PICK_FOLDER_CHANNEL,
	NATIVE_HOST_PICK_FILE_CHANNEL,
	NATIVE_HOST_SAVE_FILE_CHANNEL,
	NATIVE_HOST_SET_WINDOW_THEME_CHANNEL,
	NATIVE_HOST_SHELL_COMMAND_CHANNEL,
	NATIVE_HOST_TOGGLE_DEVELOPER_TOOLS_CHANNEL,
	NATIVE_HOST_REVEAL_FILE_CHANNEL,
	type INativeHostApi,
	validateAccessibilitySupport,
} from '../common/nativeHost.js';
import {
	WINDOW_OPERATION_CHANNEL,
	WINDOW_ZOOM_CHANGED_CHANNEL,
	type IWorkbenchWindowInfo,
} from '../../window/common/window.js';
import { DialogResult } from '../../dialogs/common/dialogs.js';

let nextDialogId = 0;

export function createNativeHostApi(): INativeHostApi {
	return {
		async showNativeDialog(request, signal) {
			if (signal.aborted) return { button: DialogResult.Cancel };
			const id = ++nextDialogId;
			const abort = (): void => { void invoke<void>(NATIVE_HOST_DIALOG_CHANNEL, { kind: 'cancel', id }).catch(error => console.error('Failed to cancel system dialog', error)); };
			signal.addEventListener('abort', abort, { once: true });
			try {
				const result = await invoke<{ button: DialogResult; checkboxChecked?: boolean }>(NATIVE_HOST_DIALOG_CHANNEL, { kind: 'show', id, request });
				return signal.aborted ? { button: DialogResult.Cancel } : result;
			} finally {
				signal.removeEventListener('abort', abort);
			}
		},
		installShellCommand: () => invoke<string>(NATIVE_HOST_SHELL_COMMAND_CHANNEL, 'install'),
		uninstallShellCommand: () => invoke<string>(NATIVE_HOST_SHELL_COMMAND_CHANNEL, 'uninstall'),
		listWindows: () => invoke<readonly IWorkbenchWindowInfo[]>(WINDOW_OPERATION_CHANNEL, { kind: 'list' }),
		focusWindowById: windowId => invoke<void>(WINDOW_OPERATION_CHANNEL, { kind: 'focus', windowId }),
		focusWindow: () => invoke<void>(WINDOW_OPERATION_CHANNEL, { kind: 'focusSelf' }),
		closeWindow: () => invoke<void>(WINDOW_OPERATION_CHANNEL, { kind: 'close' }),
		closeOtherWindows: () => invoke<void>(WINDOW_OPERATION_CHANNEL, { kind: 'closeOthers' }),
		getZoomLevel: () => invoke<number>(WINDOW_OPERATION_CHANNEL, { kind: 'getZoom' }),
		onDidChangeZoomLevel: listener => subscribe<number>(WINDOW_ZOOM_CHANGED_CHANNEL, listener),
		setZoomLevel: level => invoke<void>(WINDOW_OPERATION_CHANNEL, { kind: 'setZoom', level }),
		isAlwaysOnTop: () => invoke<boolean>(WINDOW_OPERATION_CHANNEL, { kind: 'getAlwaysOnTop' }),
		setAlwaysOnTop: enabled => invoke<void>(WINDOW_OPERATION_CHANNEL, { kind: 'setAlwaysOnTop', enabled }),
		performNativeTabAction: action => invoke<void>(WINDOW_OPERATION_CHANNEL, { kind: 'nativeTab', action }),
		openNewWindowTab: () => invoke<void>(WINDOW_OPERATION_CHANNEL, { kind: 'newTab' }),
		pickFolder: () => invoke<string | undefined>(NATIVE_HOST_PICK_FOLDER_CHANNEL),
		pickFile: (options) => invoke<readonly string[] | undefined>(NATIVE_HOST_PICK_FILE_CHANNEL, options),
		openWorkspace: (root) => invoke<void>(NATIVE_HOST_OPEN_WORKSPACE_CHANNEL, root),
		revealFile: path => invoke<void>(NATIVE_HOST_REVEAL_FILE_CHANNEL, path),
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
