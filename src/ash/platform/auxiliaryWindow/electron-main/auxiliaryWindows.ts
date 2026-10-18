import type { BrowserWindowConstructorOptions, HandlerDetails, WebContents } from 'electron';
import type { Event } from '../../../base/common/event.js';
import type { IAuxiliaryWindowStateEvent } from '../../window/common/window.js';
import type { IDisposable } from '../../../base/common/lifecycle.js';
import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';
import type { IAuxiliaryWindow } from './auxiliaryWindow.js';
import type { TitleBarStyleConfiguration } from '../../window/common/window.js';

export const IAuxiliaryWindowsMainService = createServiceIdentifier<IAuxiliaryWindowsMainService>('auxiliaryWindowsMainService');

export interface IAuxiliaryWindowsMainService {
	readonly onDidChangeWindowState: Event<{ readonly parentId: number; readonly event: IAuxiliaryWindowStateEvent; }>;
	createWindow(details: HandlerDetails, titleBarStyle: TitleBarStyleConfiguration, zoomLevel?: number): BrowserWindowConstructorOptions;
	/** The opener's resources own this registration, including any descendant windows. */
	registerWindow(webContents: WebContents, parentId: number, options?: Pick<BrowserWindowConstructorOptions, 'x' | 'y' | 'width' | 'height' | 'show'>): IDisposable;
	getWindowByWebContents(webContents: WebContents): IAuxiliaryWindow | undefined;
	getFocusedWindow(): IAuxiliaryWindow | undefined;
	getLastActiveWindow(): IAuxiliaryWindow | undefined;
	getWindows(): readonly IAuxiliaryWindow[];
}
