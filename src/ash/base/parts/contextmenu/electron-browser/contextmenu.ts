import { ipcRenderer } from '../../sandbox/electron-browser/globals.js';
import {
	NATIVE_CONTEXT_MENU_CLOSE_CHANNEL,
	NATIVE_CONTEXT_MENU_POPUP_CHANNEL,
	NATIVE_CONTEXT_MENU_PRESENT_WINDOW_CHANNEL,
	type IContextMenuWindowPresentation,
	type INativeContextMenuRequest,
	type INativeContextMenuResult,
} from '../common/contextmenu.js';

export function popup(request: INativeContextMenuRequest): Promise<INativeContextMenuResult> {
	return ipcRenderer.invoke(NATIVE_CONTEXT_MENU_POPUP_CHANNEL, request) as Promise<INativeContextMenuResult>;
}

export async function close(): Promise<void> {
	await ipcRenderer.invoke(NATIVE_CONTEXT_MENU_CLOSE_CHANNEL);
}

export function presentWindow(request: IContextMenuWindowPresentation): Promise<boolean> {
	return ipcRenderer.invoke(NATIVE_CONTEXT_MENU_PRESENT_WINDOW_CHANNEL, request) as Promise<boolean>;
}
