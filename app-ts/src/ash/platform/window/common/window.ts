import { isMacintosh, isWeb } from '../../../base/common/platform.js';
import type { IConfigurationService } from '../../configuration/common/configuration.js';

export const enum MenuSettings {
	MenuStyle = 'window.menuStyle',
}

export const enum TitleBarSetting {
	TitleBarStyle = 'window.titleBarStyle',
}

export type MenuStyleConfiguration = 'custom' | 'system' | 'inherit';
export type TitleBarStyleConfiguration = 'custom' | 'system';
export type RestoreWindowsSetting = 'preserve' | 'all' | 'folders' | 'one' | 'none';
export const RESTORE_WINDOWS_SETTING = 'window.restoreWindows';

export function parseRestoreWindowsSetting(value: unknown): RestoreWindowsSetting {
	if (value === 'preserve' || value === 'all' || value === 'folders' || value === 'one' || value === 'none') return value;
	throw new TypeError(`Unknown window restore setting: ${String(value)}`);
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

/** Dimensions used for a new window without an opened workspace. */
export const DEFAULT_EMPTY_WINDOW_SIZE = {
	width: 1200,
	height: 800,
} as const;

/** Dimensions used for a new window with an opened workspace. */
export const DEFAULT_WORKSPACE_WINDOW_SIZE = {
	width: 1440,
	height: 900,
} as const;

/** Lower bounds that keep the workbench usable while resizing. */
export const WINDOW_MINIMUM_SIZE = {
	width: 400,
	height: 270,
} as const;

export const WINDOW_OPERATION_CHANNEL = 'ash:window:operation';
export const WINDOW_ZOOM_CHANGED_CHANNEL = 'ash:window:zoom-changed';
export const WINDOW_FULLSCREEN_CHANGED_CHANNEL = 'ash:window:fullscreen-changed';
export const WINDOW_PREPARE_CLOSE_CHANNEL = 'ash:window:prepare-close';
export const WINDOW_CLOSE_RESPONSE_CHANNEL = 'ash:window:close-response';
export const WINDOW_ZOOM_LEVEL_SETTING = 'window.zoomLevel';

export type WindowCloseResponse =
	| { readonly kind: 'ready' }
	| { readonly kind: 'complete'; readonly token: number }
	| { readonly kind: 'vetoed'; readonly token: number }
	| { readonly kind: 'failed'; readonly token: number; readonly message: string };

export function validateWindowCloseResponse(value: unknown): WindowCloseResponse {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid window close response');
	const response = value as Record<string, unknown>;
	if (response.kind === 'ready' && Object.keys(response).join(',') === 'kind') return response as WindowCloseResponse;
	if ((response.kind === 'complete' || response.kind === 'vetoed') && Object.keys(response).sort().join(',') === 'kind,token' && Number.isSafeInteger(response.token) && (response.token as number) > 0) return response as WindowCloseResponse;
	if (response.kind === 'failed' && Object.keys(response).sort().join(',') === 'kind,message,token' && Number.isSafeInteger(response.token) && (response.token as number) > 0 && typeof response.message === 'string' && response.message.length > 0 && response.message.length <= 1_000) return response as WindowCloseResponse;
	throw new TypeError('Invalid window close response');
}

export interface IWorkbenchWindowInfo {
	readonly id: number;
	readonly title: string;
	readonly focused: boolean;
}

export type WindowOperation =
	| { readonly kind: 'list' }
	| { readonly kind: 'focus'; readonly windowId: number }
	| { readonly kind: 'focusSelf' }
	| { readonly kind: 'close' }
	| { readonly kind: 'closeOthers' }
	| { readonly kind: 'getZoom' }
	| { readonly kind: 'getZoomFactor' }
	| { readonly kind: 'setZoom'; readonly level: number }
	| { readonly kind: 'getFullscreen' }
	| { readonly kind: 'getAlwaysOnTop' }
	| { readonly kind: 'setAlwaysOnTop'; readonly enabled: boolean }
	| { readonly kind: 'nativeTab'; readonly action: 'next' | 'previous' | 'newWindow' | 'merge' | 'toggleBar' }
	| { readonly kind: 'newTab' };

export function validateWindowOperation(value: unknown): WindowOperation {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid window operation');
	const operation = value as Record<string, unknown>;
	const keys = Object.keys(operation).sort().join(',');
	switch (operation.kind) {
		case 'list':
		case 'focusSelf':
		case 'newTab':
		case 'close':
		case 'closeOthers':
		case 'getZoom':
		case 'getZoomFactor':
		case 'getFullscreen':
		case 'getAlwaysOnTop':
			if (keys === 'kind') return operation as WindowOperation;
			break;
		case 'focus':
			if (keys === 'kind,windowId' && Number.isSafeInteger(operation.windowId) && (operation.windowId as number) > 0) return operation as WindowOperation;
			break;
		case 'setZoom':
			if (keys === 'kind,level' && Number.isInteger(operation.level) && (operation.level as number) >= -8 && (operation.level as number) <= 8) return operation as WindowOperation;
			break;
		case 'setAlwaysOnTop':
			if (keys === 'enabled,kind' && typeof operation.enabled === 'boolean') return operation as WindowOperation;
			break;
		case 'nativeTab':
			if (keys === 'action,kind' && typeof operation.action === 'string' && ['next', 'previous', 'newWindow', 'merge', 'toggleBar'].includes(operation.action)) return operation as WindowOperation;
			break;
	}
	throw new TypeError('Invalid window operation');
}
