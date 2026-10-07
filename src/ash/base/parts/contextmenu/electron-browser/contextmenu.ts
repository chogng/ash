import { ipcRenderer } from '../../sandbox/electron-browser/globals.js';
import { NATIVE_CONTEXT_MENU_CLOSE_CHANNEL, NATIVE_CONTEXT_MENU_POPUP_CHANNEL, type INativeContextMenuRequest, type INativeContextMenuResult } from '../common/contextmenu.js';

export function popup(request: INativeContextMenuRequest): Promise<INativeContextMenuResult> {
	return ipcRenderer.invoke(NATIVE_CONTEXT_MENU_POPUP_CHANNEL, request) as Promise<INativeContextMenuResult>;
}

export async function close(): Promise<void> {
	await ipcRenderer.invoke(NATIVE_CONTEXT_MENU_CLOSE_CHANNEL);
}
