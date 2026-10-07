import type { BrowserWindowConstructorOptions, HandlerDetails, WebContents } from 'electron';
import type { IDisposable } from '../../../base/common/lifecycle.js';
import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';
import type { IAuxiliaryWindow } from './auxiliaryWindow.js';

export const IAuxiliaryWindowsMainService = createServiceIdentifier<IAuxiliaryWindowsMainService>('auxiliaryWindowsMainService');

export interface IAuxiliaryWindowsMainService {
	createWindow(details: HandlerDetails): BrowserWindowConstructorOptions;
	/** The opener's resources own this registration, including any descendant windows. */
	registerWindow(webContents: WebContents, parentId: number): IDisposable;
	getWindowByWebContents(webContents: WebContents): IAuxiliaryWindow | undefined;
	getFocusedWindow(): IAuxiliaryWindow | undefined;
	getLastActiveWindow(): IAuxiliaryWindow | undefined;
	getWindows(): readonly IAuxiliaryWindow[];
}
