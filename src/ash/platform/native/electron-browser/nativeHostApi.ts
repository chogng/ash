import { invoke, subscribe } from '../../ipc/electron-browser/rendererIpc.js';
import type { IMainProcessService } from '../../ipc/common/mainProcessService.js';
import {
	NATIVE_HOST_IS_ADMIN_CHANNEL,
	NATIVE_HOST_GET_TITLE_BAR_STYLE_CHANNEL,
	NATIVE_HOST_GET_WINDOW_CLIENT_SIZE_CHANNEL,
	NATIVE_HOST_ACCESSIBILITY_SUPPORT_CHANGED_CHANNEL,
	validateColorScheme,
	NATIVE_HOST_GET_ACCESSIBILITY_SUPPORT_CHANNEL,
	NATIVE_HOST_OPEN_WORKSPACE_CHANNEL,
	NATIVE_HOST_OPEN_WINDOW_CHANNEL,
	NATIVE_HOST_OPEN_AGENTS_WINDOW_CHANNEL,
	NATIVE_HOST_TERMINAL_MOVE_CHANNEL,
	NATIVE_HOST_TERMINAL_TAKE_CHANNEL,
	NATIVE_HOST_TERMINAL_COMPLETE_CHANNEL,
	NATIVE_HOST_TERMINAL_REQUEST_CHANNEL,
	validateTerminalWindowTransfer,
	validateTerminalWindowTransferResult,
	NATIVE_HOST_SYNC_SYSTEM_WIDE_KEYBINDINGS_CHANNEL,
	validateSystemWideKeybindingsResult,
	NATIVE_HOST_PICK_FOLDER_CHANNEL,
	NATIVE_HOST_PICK_FILE_CHANNEL,
	NATIVE_HOST_SAVE_FILE_CHANNEL,
	NATIVE_HOST_SET_WINDOW_THEME_CHANNEL,
	NATIVE_HOST_SET_WINDOW_DIMMED_CHANNEL,
	NATIVE_HOST_TOGGLE_DEVELOPER_TOOLS_CHANNEL,
	NATIVE_HOST_REVEAL_FILE_CHANNEL,
	type INativeHostApi,
	validateAccessibilitySupport,
	validateOpenDialogResult,
	validateSaveDialogResult,
} from '../common/nativeHost.js';
import {
	parseTitleBarStyle,
	WINDOW_OPERATION_CHANNEL,
	WINDOW_ZOOM_CHANGED_CHANNEL,
	WINDOW_CLIENT_SIZE_CHANGED_CHANNEL,
	validateWindowClientSize,
	WINDOW_ALWAYS_ON_TOP_CHANGED_CHANNEL,
	AUXILIARY_WINDOW_STATE_CHANGED_CHANNEL,
	validateAuxiliaryWindowState,
	validateAuxiliaryWindowStateEvent,
	validateWindowAlwaysOnTopChangedEvent,
	WINDOW_OPEN_EXTERNAL_URI_CHANNEL,
	type IWorkbenchWindowInfo,
} from '../../window/common/window.js';
import { showMessageBox } from '../../dialogs/electron-browser/dialog.js';
import { normalizeExternalUrl } from '../../opener/common/opener.js';
import { VSBuffer } from '../../../base/common/buffer.js';
import {
	AGENT_HOST_EDITOR_STATE_CHANNEL,
	AGENT_HOST_EDITOR_UPDATE_CHANNEL,
	AGENT_HOST_EDITOR_STATE_CHANGED_CHANNEL,
	AGENTS_WINDOW_INVITATION_CLAIM_CHANNEL,
	AGENTS_WINDOW_INVITATION_SHOWN_CHANNEL,
	AGENTS_WINDOW_INVITATION_RELEASE_CHANNEL,
	validateAgentHostEditorState,
	validateAgentsWindowInvitation,
} from '../common/nativeHost.js';

export function createNativeHostApi(mainProcessService: IMainProcessService): INativeHostApi {
	const colors = mainProcessService.getChannel('colorScheme');
	const power = mainProcessService.getChannel('powerMonitor');
	return {
		onDidSuspendOS: listener => power.listen<void>('onDidSuspendOS')(listener),
		onDidResumeOS: listener => power.listen<void>('onDidResumeOS')(listener),
		async getScreenshot(rect) {
			const value = await invoke<unknown>('ash:host:screenshot', rect);
			if (value === undefined) return undefined;
			if (!(value instanceof Uint8Array) || value.byteLength === 0 || value.byteLength > 20 * 1024 * 1024) throw new TypeError('Invalid screenshot image');
			return VSBuffer.wrap(new Uint8Array(value));
		},
		getTitleBarStyle: async () => parseTitleBarStyle(await invoke<unknown>(NATIVE_HOST_GET_TITLE_BAR_STYLE_CHANNEL)),
		getWindowClientSize: async () => validateWindowClientSize(await invoke<unknown>(NATIVE_HOST_GET_WINDOW_CLIENT_SIZE_CHANNEL)),
		onDidChangeWindowClientSize: listener => subscribe<unknown>(WINDOW_CLIENT_SIZE_CHANGED_CHANNEL, value => listener(validateWindowClientSize(value))),
		async isAdmin(): Promise<boolean> {
			const value = await invoke<unknown>(NATIVE_HOST_IS_ADMIN_CHANNEL);
			if (typeof value !== 'boolean') {
				throw new TypeError('Invalid desktop privilege result');
			}
			return value;
		},
		getOSColorScheme: async () => validateColorScheme(await colors.call<unknown>('getOSColorScheme')),
		onDidChangeColorScheme: listener => colors.listen<unknown>('onDidChangeColorScheme')(value => listener(validateColorScheme(value))),
		showMessageBox,
		listWindows: windowName =>
			invoke<readonly IWorkbenchWindowInfo[]>(WINDOW_OPERATION_CHANNEL, {
				kind: 'list',
				...(windowName === undefined ? {} : { windowName }),
			}),
		focusWindowById: windowId => invoke<void>(WINDOW_OPERATION_CHANNEL, { kind: 'focus', windowId }),
		focusWindow: windowName =>
			invoke<void>(WINDOW_OPERATION_CHANNEL, {
				kind: 'focusSelf',
				...(windowName === undefined ? {} : { windowName }),
			}),
		closeWindow: windowName =>
			invoke<void>(WINDOW_OPERATION_CHANNEL, {
				kind: 'close',
				...(windowName === undefined ? {} : { windowName }),
			}),
		closeOtherWindows: () => invoke<void>(WINDOW_OPERATION_CHANNEL, { kind: 'closeOthers' }),
		getZoomLevel: windowName =>
			invoke<number>(WINDOW_OPERATION_CHANNEL, {
				kind: 'getZoom',
				...(windowName === undefined ? {} : { windowName }),
			}),
		onDidChangeZoomLevel: listener => subscribe<number>(WINDOW_ZOOM_CHANGED_CHANNEL, listener),
		setZoomLevel: (level, windowName, allWindows) =>
			invoke<void>(WINDOW_OPERATION_CHANNEL, {
				kind: 'setZoom',
				level,
				...(windowName === undefined ? {} : { windowName }),
				...(allWindows ? { allWindows: true } : {}),
			}),
		getAuxiliaryWindowState: async windowName => validateAuxiliaryWindowState(await invoke<unknown>(WINDOW_OPERATION_CHANNEL, { kind: 'getAuxiliaryState', windowName })),
		onDidChangeAuxiliaryWindowState: listener => subscribe<unknown>(AUXILIARY_WINDOW_STATE_CHANGED_CHANNEL, value => listener(validateAuxiliaryWindowStateEvent(value))),
		isAlwaysOnTop: windowName =>
			invoke<boolean>(WINDOW_OPERATION_CHANNEL, {
				kind: 'getAlwaysOnTop',
				...(windowName === undefined ? {} : { windowName }),
			}),
		setAlwaysOnTop: (enabled, windowName) =>
			invoke<void>(WINDOW_OPERATION_CHANNEL, {
				kind: 'setAlwaysOnTop',
				enabled,
				...(windowName === undefined ? {} : { windowName }),
			}),
		onDidChangeWindowAlwaysOnTop: listener => subscribe<unknown>(WINDOW_ALWAYS_ON_TOP_CHANGED_CHANNEL, value => listener(validateWindowAlwaysOnTopChangedEvent(value))),
		performNativeTabAction: action => invoke<void>(WINDOW_OPERATION_CHANNEL, { kind: 'nativeTab', action }),
		openNewWindowTab: () => invoke<void>(WINDOW_OPERATION_CHANNEL, { kind: 'newTab' }),
		pickFolder: () => invoke<string | undefined>(NATIVE_HOST_PICK_FOLDER_CHANNEL),
		showOpenDialog: async options => validateOpenDialogResult(await invoke<unknown>(NATIVE_HOST_PICK_FILE_CHANNEL, options)),
		openWorkspace: (root, forceNewWindow) => invoke<void>(NATIVE_HOST_OPEN_WORKSPACE_CHANNEL, forceNewWindow ? { root, forceNewWindow } : root),
		openWindow: options => invoke<void>(NATIVE_HOST_OPEN_WINDOW_CHANNEL, options),
		openAgentsWindow: options => invoke<void>(NATIVE_HOST_OPEN_AGENTS_WINDOW_CHANNEL, options),
		async moveTerminalToWindow(transfer, targetWindowId) {
			const result = await invoke<unknown>(NATIVE_HOST_TERMINAL_MOVE_CHANNEL, {
				transfer,
				...(targetWindowId === undefined ? {} : { targetWindowId }),
			});
			return validateTerminalWindowTransferResult(result);
		},
		async takeTerminalTransfer() {
			const value = await invoke<unknown>(NATIVE_HOST_TERMINAL_TAKE_CHANNEL);
			return value === undefined ? undefined : validateTerminalWindowTransfer(value);
		},
		completeTerminalTransfer: result => invoke<void>(NATIVE_HOST_TERMINAL_COMPLETE_CHANNEL, result),
		onDidRequestTerminalTransfer: listener => subscribe<void>(NATIVE_HOST_TERMINAL_REQUEST_CHANNEL, listener),
		getAgentHostEditorState: async () => validateAgentHostEditorState(await invoke<unknown>(AGENT_HOST_EDITOR_STATE_CHANNEL)),
		updateAgentHostEditorState: update => invoke<void>(AGENT_HOST_EDITOR_UPDATE_CHANNEL, update),
		onDidChangeAgentHostEditorState: listener => subscribe<unknown>(AGENT_HOST_EDITOR_STATE_CHANGED_CHANNEL, value => listener(validateAgentHostEditorState(value))),
		claimAgentsWindowInvitation: async resource => validateAgentsWindowInvitation(await invoke<unknown>(AGENTS_WINDOW_INVITATION_CLAIM_CHANNEL, resource)),
		markAgentsWindowInvitationShown: id => invoke<void>(AGENTS_WINDOW_INVITATION_SHOWN_CHANNEL, id),
		releaseAgentsWindowInvitation: id => invoke<void>(AGENTS_WINDOW_INVITATION_RELEASE_CHANNEL, id),
		syncSystemWideKeybindings: async keybindings => validateSystemWideKeybindingsResult(await invoke<unknown>(NATIVE_HOST_SYNC_SYSTEM_WIDE_KEYBINDINGS_CHANNEL, keybindings)),
		openExternal: target => invoke<boolean>('ash:host:openExternal', target),
		onDidRequestOpenExternalUri: listener =>
			subscribe<unknown>(WINDOW_OPEN_EXTERNAL_URI_CHANNEL, value => {
				if (typeof value !== 'string') {
					throw new TypeError('Invalid external URL request');
				}
				listener(normalizeExternalUrl(value));
			}),
		revealFile: path => invoke<void>(NATIVE_HOST_REVEAL_FILE_CHANNEL, path),
		setWindowTheme: theme => invoke<void>(NATIVE_HOST_SET_WINDOW_THEME_CHANNEL, theme),
		setWindowDimmed: dimmed => invoke<void>(NATIVE_HOST_SET_WINDOW_DIMMED_CHANNEL, dimmed),
		toggleDeveloperTools: () => invoke<void>(NATIVE_HOST_TOGGLE_DEVELOPER_TOOLS_CHANNEL),
		showSaveDialog: async options => validateSaveDialogResult(await invoke<unknown>(NATIVE_HOST_SAVE_FILE_CHANNEL, options)),
		async isAccessibilitySupportEnabled(): Promise<boolean> {
			return validateAccessibilitySupport(await invoke<unknown>(NATIVE_HOST_GET_ACCESSIBILITY_SUPPORT_CHANNEL));
		},
		onDidChangeAccessibilitySupport(listener) {
			return subscribe<unknown>(NATIVE_HOST_ACCESSIBILITY_SUPPORT_CHANGED_CHANNEL, value => listener(validateAccessibilitySupport(value)));
		},
	};
}
