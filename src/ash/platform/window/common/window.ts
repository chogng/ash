import { isMacintosh, isWeb } from '../../../base/common/platform.js';
import type { IConfigurationService } from '../../configuration/common/configuration.js';
import { createSshRemoteAuthority } from '../../remote/common/remote.js';
import { isRecord } from '../../../base/common/types.js';
import { URI } from '../../../base/common/uri.js';
import { parseWorkspaceIdentifier, type IAnyWorkspaceIdentifier } from '../../workspace/common/workspace.js';

export interface IRectangle {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

/** The drawable Win32 client area in physical pixels, before Electron's DIP rounding. */
export interface IWindowClientSize {
	readonly width: number;
	readonly height: number;
}

export const WINDOW_CLIENT_SIZE_CHANGED_CHANNEL = 'ash:window:client-size-changed';

export function validateWindowClientSize(value: unknown): IWindowClientSize | undefined {
	if (value === undefined) return undefined;
	if (
		!isRecord(value) ||
		Object.keys(value).sort().join(',') !== 'height,width' ||
		!Number.isSafeInteger(value.width) ||
		(value.width as number) <= 0 ||
		!Number.isSafeInteger(value.height) ||
		(value.height as number) <= 0
	) {
		throw new TypeError('Invalid window client size');
	}
	return value as unknown as IWindowClientSize;
}

export const WORKSPACE_RECOVERY_CHANNEL = 'ash:window:restoreWorkspaces';
export const WINDOW_TERMINAL_TRANSFER_STARTUP_CHANNEL = 'ash:window:terminal-transfer-startup';
export const WINDOW_OPEN_EXTERNAL_URI_CHANNEL = 'ash:window:openExternalUri';
export const AGENTS_WINDOW_HANDOFF_AVAILABLE_CHANNEL = 'ash:sessions:handoff-available';
export const AGENTS_WINDOW_HANDOFF_TAKE_CHANNEL = 'ash:sessions:handoff-take';
export const AGENTS_WINDOW_HANDOFF_COMPLETE_CHANNEL = 'ash:sessions:handoff-complete';

export interface IAgentsWindowHandoffResult {
	readonly id: string;
	readonly error?: string;
}

export function validateAgentsWindowHandoffTake(value: unknown): undefined {
	if (value !== undefined) {
		throw new TypeError('Agents Window handoff take does not accept parameters');
	}
	return undefined;
}

export function validateAgentsWindowHandoffComplete(value: unknown): IAgentsWindowHandoffResult {
	if (!isRecord(value)) {
		throw new TypeError('Invalid Agents Window handoff result');
	}
	if (Object.keys(value).some(key => key !== 'id' && key !== 'error') || typeof value.id !== 'string' || !value.id || (value.error !== undefined && typeof value.error !== 'string')) {
		throw new TypeError('Invalid Agents Window handoff result');
	}
	return value as unknown as IAgentsWindowHandoffResult;
}

/** Backend catalog readers request windows using ordinary workspace identities only. */
export function validateWorkspaceRecovery(value: unknown): readonly IAnyWorkspaceIdentifier[] {
	if (!Array.isArray(value)) throw new TypeError('Invalid workspace recovery request');
	return value.map(parseWorkspaceIdentifier);
}

export interface IColorScheme {
	readonly dark: boolean;
	readonly highContrast: boolean;
}
export const HOST_RESTART_CHANNEL = 'ash:host:restart';

export interface IOpenEmptyWindowOptions {
	readonly forceReuseWindow?: boolean;
	readonly remoteAuthority?: string;
}

export type IWindowOpenable = { readonly folderUri: URI } | { readonly workspaceUri: URI };

export interface IOpenWindowOptions extends IOpenEmptyWindowOptions {
	/** Browser workspace save/creation carries the current editors and backups into the new identity. */
	readonly preserveEditors?: boolean;
	readonly forceNewWindow?: boolean;
}

export function validateOpenEmptyWindowOptions(value: unknown): IOpenEmptyWindowOptions {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid empty window options');
	const options = value as Record<string, unknown>;
	if (Object.keys(options).some(key => key !== 'forceReuseWindow' && key !== 'remoteAuthority') || (options.forceReuseWindow !== undefined && typeof options.forceReuseWindow !== 'boolean'))
		throw new TypeError('Invalid empty window options');
	if (options.remoteAuthority !== undefined) {
		if (
			typeof options.remoteAuthority !== 'string' ||
			!/^[a-z][a-z0-9-]{0,63}\+[^\s\u0000-\u001f\u007f]{1,1983}$/u.test(options.remoteAuthority) ||
			(options.remoteAuthority.startsWith('ssh+') && createSshRemoteAuthority(options.remoteAuthority.slice(4)).authority !== options.remoteAuthority)
		)
			throw new TypeError('Invalid Remote authority');
	}
	return options as IOpenEmptyWindowOptions;
}

export const enum MenuSettings {
	MenuStyle = 'window.menuStyle',
}

export const enum TitleBarSetting {
	TitleBarStyle = 'window.titleBarStyle',
}

export type MenuStyleConfiguration = 'custom' | 'system' | 'inherit';
export type TitleBarStyleConfiguration = 'custom' | 'system';
export const DEFAULT_MENU_STYLE: MenuStyleConfiguration = isMacintosh ? 'system' : 'inherit';
export const DEFAULT_TITLE_BAR_STYLE: TitleBarStyleConfiguration = 'custom';
export type RestoreWindowsSetting = 'preserve' | 'all' | 'folders' | 'one' | 'none';
export const RESTORE_WINDOWS_SETTING = 'window.restoreWindows';
export const STARTUP_WINDOW_SETTING = 'window.startupWindow';
export type StartupWindow = 'default' | 'ide' | 'agents';
export const DEFAULT_STARTUP_WINDOW: StartupWindow = 'default';
export const NEW_WINDOW_DIMENSIONS_SETTING = 'window.newWindowDimensions';
export const RESTORE_FULLSCREEN_SETTING = 'window.restoreFullscreen';
export type NewWindowDimensions = 'default' | 'inherit' | 'offset' | 'maximized' | 'fullscreen';

export function parseNewWindowDimensions(value: unknown): NewWindowDimensions {
	if (value === 'default' || value === 'inherit' || value === 'offset' || value === 'maximized' || value === 'fullscreen') return value;
	throw new TypeError(`Unknown new window dimensions: ${String(value)}`);
}

export function parseRestoreFullscreen(value: unknown): boolean {
	if (typeof value === 'boolean') return value;
	throw new TypeError('Window restore fullscreen must be a boolean');
}

export function parseRestoreWindowsSetting(value: unknown): RestoreWindowsSetting {
	if (value === 'preserve' || value === 'all' || value === 'folders' || value === 'one' || value === 'none') return value;
	throw new TypeError(`Unknown window restore setting: ${String(value)}`);
}

export function parseStartupWindow(value: unknown): StartupWindow {
	if (value === 'default' || value === 'ide' || value === 'agents') return value;
	throw new TypeError(`Unknown startup window: ${String(value)}`);
}

export function parseMenuStyle(value: unknown): MenuStyleConfiguration {
	if (value === 'custom' || value === 'system' || value === 'inherit') return value;
	throw new TypeError(`Unknown window menu style: ${String(value)}`);
}

export function parseTitleBarStyle(value: unknown): TitleBarStyleConfiguration {
	if (value === 'custom' || value === 'system') return value;
	throw new TypeError(`Unknown window title bar style: ${String(value)}`);
}

/** Windows and Linux use system context menus only with a system title bar. */
export function hasSystemContextMenu(configurationService: IConfigurationService): boolean {
	const menuStyle = configurationService.getValue<MenuStyleConfiguration>(MenuSettings.MenuStyle);
	const titleBarStyle = configurationService.getValue<TitleBarStyleConfiguration>(TitleBarSetting.TitleBarStyle);
	return resolveContextMenuStyle(menuStyle, titleBarStyle, isWeb ? 'web' : isMacintosh ? 'macos' : 'desktop') === 'system';
}

/** The host window frame determines whether desktop system menus are available. */
export function resolveContextMenuStyle(menuStyle: MenuStyleConfiguration, titleBarStyle: TitleBarStyleConfiguration, host: 'web' | 'macos' | 'desktop'): 'custom' | 'system' {
	if (host === 'web') return 'custom';
	if (menuStyle === 'custom') return 'custom';
	if (menuStyle === 'system' && host === 'macos') return 'system';
	return titleBarStyle === 'system' ? 'system' : 'custom';
}

/**
 * Explicit user-requested Ash product requirement: new empty, workspace and Agents
 * windows all default to 1200 × 800 logical pixels, before display-area constraints.
 */
export const DEFAULT_EMPTY_WINDOW_SIZE = {
	width: 1200,
	height: 800,
} as const;

/** User-requested 1200 × 800 default, matching empty windows and Agents windows. */
export const DEFAULT_WORKSPACE_WINDOW_SIZE = {
	width: 1200,
	height: 800,
} as const;

/** Lower bounds that keep the workbench usable while resizing. */
export const WINDOW_MINIMUM_SIZE = {
	width: 400,
	height: 270,
} as const;

export const WINDOW_OPERATION_CHANNEL = 'ash:window:operation';
export const WINDOW_ZOOM_CHANGED_CHANNEL = 'ash:window:zoom-changed';
export const WINDOW_ALWAYS_ON_TOP_CHANGED_CHANNEL = 'ash:window:always-on-top-changed';
export const WINDOW_FULLSCREEN_CHANGED_CHANNEL = 'ash:window:fullscreen-changed';
export const WINDOW_PREPARE_CLOSE_CHANNEL = 'ash:window:prepare-close';
export const WINDOW_PREPARE_QUIT_CHANNEL = 'ash:window:prepare-quit';
export const WINDOW_PREPARE_LOAD_CHANNEL = 'ash:window:prepare-load';
export const WINDOW_PREPARE_RELOAD_CHANNEL = 'ash:window:prepare-reload';
export const WINDOW_CLOSE_RESPONSE_CHANNEL = 'ash:window:close-response';
export const WINDOW_OPEN_FILES_CHANNEL = 'ash:window:open-files';
export const WINDOW_OPEN_FILES_RESPONSE_CHANNEL = 'ash:window:open-files-response';

export const AUXILIARY_WINDOW_STATE_CHANGED_CHANNEL = 'ash:window:auxiliary-state-changed';

/** Host-owned window state retained with the editor layout for the next session. */
export interface IAuxiliaryWindowState {
	readonly width: number;
	readonly height: number;
	readonly left: number;
	readonly top: number;
	readonly zoomLevel: number;
	readonly alwaysOnTop: boolean;
	readonly mode: 'normal' | 'maximized' | 'fullscreen';
}

export interface IAuxiliaryWindowStateEvent {
	readonly windowName: string;
	readonly state: IAuxiliaryWindowState;
}

export function validateAuxiliaryWindowState(value: unknown): IAuxiliaryWindowState {
	if (
		!isRecord(value) ||
		Object.keys(value).sort().join(',') !== 'alwaysOnTop,height,left,mode,top,width,zoomLevel' ||
		!['width', 'height', 'left', 'top', 'zoomLevel'].every(key => typeof value[key] === 'number' && Number.isFinite(value[key])) ||
		(value.width as number) <= 0 ||
		(value.height as number) <= 0 ||
		(value.zoomLevel as number) < -8 ||
		(value.zoomLevel as number) > 8 ||
		typeof value.alwaysOnTop !== 'boolean' ||
		!['normal', 'maximized', 'fullscreen'].includes(value.mode as string)
	) {
		throw new TypeError('Invalid auxiliary window state');
	}
	return value as unknown as IAuxiliaryWindowState;
}

export function validateAuxiliaryWindowStateEvent(value: unknown): IAuxiliaryWindowStateEvent {
	if (!isRecord(value) || Object.keys(value).sort().join(',') !== 'state,windowName' || typeof value.windowName !== 'string' || !/^ash-auxiliary-[0-9a-f-]{36}$/.test(value.windowName))
		throw new TypeError('Invalid auxiliary window state event');
	return { windowName: value.windowName, state: validateAuxiliaryWindowState(value.state) };
}

export interface IWindowAlwaysOnTopChangedEvent {
	readonly windowName?: string;
	readonly alwaysOnTop: boolean;
}

export function validateWindowAlwaysOnTopChangedEvent(value: unknown): IWindowAlwaysOnTopChangedEvent {
	if (
		!isRecord(value) ||
		Object.keys(value).some(key => key !== 'windowName' && key !== 'alwaysOnTop') ||
		typeof value.alwaysOnTop !== 'boolean' ||
		(value.windowName !== undefined && (typeof value.windowName !== 'string' || !/^ash-auxiliary-[0-9a-f-]{36}$/.test(value.windowName)))
	) {
		throw new TypeError('Invalid window always-on-top change');
	}
	return value as unknown as IWindowAlwaysOnTopChangedEvent;
}

export interface IWindowFileOpen {
	readonly uri: string;
	readonly line?: number;
	readonly column?: number;
}

export interface IWindowFilesRequest {
	readonly id: number;
	readonly files: readonly IWindowFileOpen[];
	readonly wait: boolean;
}

export type WindowFilesResponse = { readonly kind: 'ready' } | { readonly kind: 'opened' | 'closed'; readonly id: number } | { readonly kind: 'failed'; readonly id: number; readonly message: string };

export function validateWindowFilesRequest(value: unknown): IWindowFilesRequest {
	if (!isRecord(value)) {
		throw new TypeError('Invalid file open request');
	}
	if (
		Object.keys(value).sort().join(',') !== 'files,id,wait' ||
		!Number.isSafeInteger(value.id) ||
		(value.id as number) <= 0 ||
		typeof value.wait !== 'boolean' ||
		!Array.isArray(value.files) ||
		value.files.length === 0
	) {
		throw new TypeError('Invalid file open request');
	}
	for (const file of value.files) {
		if (!isRecord(file) || typeof file.uri !== 'string' || Object.keys(file).some(key => key !== 'uri' && key !== 'line' && key !== 'column')) {
			throw new TypeError('Invalid launch file');
		}
		const uri = URI.parse(file.uri, true);
		if (uri.scheme !== 'file' || !uri.path.startsWith('/') || uri.query || uri.fragment) {
			throw new TypeError('Launch files must use absolute file URIs');
		}
		for (const position of [file.line, file.column]) {
			if (position !== undefined && (!Number.isSafeInteger(position) || (position as number) < 1)) {
				throw new TypeError('File positions must be positive integers');
			}
		}
	}
	return value as unknown as IWindowFilesRequest;
}

export function validateWindowFilesResponse(value: unknown): WindowFilesResponse {
	if (!isRecord(value)) {
		throw new TypeError('Invalid file open response');
	}
	const keys = Object.keys(value).sort().join(',');
	if (value.kind === 'ready' && keys === 'kind') {
		return value as WindowFilesResponse;
	}
	if (!Number.isSafeInteger(value.id) || (value.id as number) <= 0) {
		throw new TypeError('Invalid file open response');
	}
	if ((value.kind === 'opened' || value.kind === 'closed') && keys === 'id,kind') {
		return value as WindowFilesResponse;
	}
	if (value.kind === 'failed' && keys === 'id,kind,message' && typeof value.message === 'string' && value.message.length > 0) {
		return value as WindowFilesResponse;
	}
	throw new TypeError('Invalid file open response');
}

export const WINDOW_ZOOM_LEVEL_SETTING = 'window.zoomLevel';
export const WINDOW_ZOOM_PER_WINDOW_SETTING = 'window.zoomPerWindow';

export type WindowCloseResponse =
	| { readonly kind: 'ready' }
	| { readonly kind: 'complete'; readonly token: number }
	| { readonly kind: 'vetoed'; readonly token: number }
	| { readonly kind: 'failed'; readonly token: number; readonly message: string };

export function validateWindowCloseResponse(value: unknown): WindowCloseResponse {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid window close response');
	const response = value as Record<string, unknown>;
	if (response.kind === 'ready' && Object.keys(response).join(',') === 'kind') return response as WindowCloseResponse;
	if (
		(response.kind === 'complete' || response.kind === 'vetoed') &&
		Object.keys(response).sort().join(',') === 'kind,token' &&
		Number.isSafeInteger(response.token) &&
		(response.token as number) > 0
	)
		return response as WindowCloseResponse;
	if (
		response.kind === 'failed' &&
		Object.keys(response).sort().join(',') === 'kind,message,token' &&
		Number.isSafeInteger(response.token) &&
		(response.token as number) > 0 &&
		typeof response.message === 'string' &&
		response.message.length > 0 &&
		response.message.length <= 1_000
	)
		return response as WindowCloseResponse;
	throw new TypeError('Invalid window close response');
}

export interface IWorkbenchWindowInfo {
	readonly id: number;
	readonly title: string;
	readonly focused: boolean;
	/** The window selected by the caller's trusted window context, independent of OS focus. */
	readonly current: boolean;
}

export type WindowOperation =
	| { readonly kind: 'list'; readonly windowName?: string }
	| { readonly kind: 'focus'; readonly windowId: number }
	| { readonly kind: 'focusSelf'; readonly windowName?: string }
	| { readonly kind: 'close'; readonly windowName?: string }
	| { readonly kind: 'closeOthers' }
	| { readonly kind: 'getZoom'; readonly windowName?: string }
	| { readonly kind: 'getZoomFactor' }
	| { readonly kind: 'setZoom'; readonly level: number; readonly windowName?: string; readonly allWindows?: true }
	| { readonly kind: 'getFullscreen' }
	| { readonly kind: 'getAuxiliaryState'; readonly windowName: string }
	| { readonly kind: 'getAlwaysOnTop'; readonly windowName?: string }
	| { readonly kind: 'setAlwaysOnTop'; readonly enabled: boolean; readonly windowName?: string }
	| { readonly kind: 'nativeTab'; readonly action: 'next' | 'previous' | 'newWindow' | 'merge' | 'toggleBar' }
	| { readonly kind: 'newTab' };

export function validateWindowOperation(value: unknown): WindowOperation {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid window operation');
	const operation = value as Record<string, unknown>;
	const keys = Object.keys(operation).sort().join(',');
	const hasAuxiliaryWindowName = typeof operation.windowName === 'string' && /^ash-auxiliary-[0-9a-f-]{36}$/.test(operation.windowName);
	switch (operation.kind) {
		case 'newTab':
		case 'closeOthers':
		case 'getZoomFactor':
		case 'getFullscreen':
			if (keys === 'kind') return operation as WindowOperation;
			break;
		case 'list':
		case 'focusSelf':
		case 'close':
		case 'getZoom':
		case 'getAlwaysOnTop':
			if (keys === 'kind' || (keys === 'kind,windowName' && hasAuxiliaryWindowName)) return operation as WindowOperation;
			break;
		case 'getAuxiliaryState':
			if (keys === 'kind,windowName' && hasAuxiliaryWindowName) return operation as WindowOperation;
			break;
		case 'focus':
			if (keys === 'kind,windowId' && Number.isSafeInteger(operation.windowId) && (operation.windowId as number) > 0) return operation as WindowOperation;
			break;
		case 'setZoom':
			if (
				(keys === 'kind,level' || (keys === 'kind,level,windowName' && hasAuxiliaryWindowName) || (keys === 'allWindows,kind,level' && operation.allWindows === true)) &&
				Number.isInteger(operation.level) &&
				(operation.level as number) >= -8 &&
				(operation.level as number) <= 8
			)
				return operation as WindowOperation;
			break;
		case 'setAlwaysOnTop':
			if (typeof operation.enabled === 'boolean' && (keys === 'enabled,kind' || (keys === 'enabled,kind,windowName' && hasAuxiliaryWindowName))) return operation as WindowOperation;
			break;
		case 'nativeTab':
			if (keys === 'action,kind' && typeof operation.action === 'string' && ['next', 'previous', 'newWindow', 'merge', 'toggleBar'].includes(operation.action))
				return operation as WindowOperation;
			break;
	}
	throw new TypeError('Invalid window operation');
}
