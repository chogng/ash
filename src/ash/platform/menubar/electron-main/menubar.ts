import { app, BrowserWindow, Menu, nativeImage, TouchBar, type MenuItemConstructorOptions } from 'electron';
import type { INativeMenubarMainHost } from './menubarMainService.js';
import type { Event } from '../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import { ILogService } from '../../log/common/log.js';
import { IWindowsMainService } from '../../windows/electron-main/windows.js';

/** Owns the application's additions to the system Dock menu. */
export class Menubar extends Disposable {
	constructor(
		private readonly newWindowLabel: () => string,
		onDidChangeLanguage: Event<void>,
		@IWindowsMainService private readonly windows: IWindowsMainService,
		@ILogService private readonly log: ILogService,
	) {
		super();
		this.installDockMenu();
		this._register(onDidChangeLanguage(() => this.installDockMenu()));
		this._register(toDisposable(() => app.dock?.setMenu(new Menu())));
	}

	private installDockMenu(): void {
		app.dock?.setMenu(Menu.buildFromTemplate([{
			label: this.newWindowLabel(),
			click: () => {
				void this.windows.open({
					cwd: process.cwd(),
					files: [],
					forceNewWindow: true,
					forceReuseWindow: false,
					waitForFiles: false,
				}).catch(error => this.log.error('menubar', 'Failed to open a window from the Dock', error));
			},
		}]));
	}
}

export function createElectronMenubarHost(): INativeMenubarMainHost {
	return {
		applicationName: app.name,
		setApplicationMenu: template => Menu.setApplicationMenu(
			template ? Menu.buildFromTemplate([...template] as MenuItemConstructorOptions[]) : null,
		),
		setWindowTouchBar: (window, items, select) => {
			const buttons = items.map(item => new TouchBar.TouchBarButton({
				label: item.label,
				icon: nativeImage.createFromDataURL(item.icon),
				enabled: item.enabled,
				click: () => select(item.id),
			}));
			(window as BrowserWindow).setTouchBar(buttons.length > 0 ? new TouchBar({ items: buttons }) : null);
		},
	};
}

export function clearElectronApplicationMenu(): void {
	Menu.setApplicationMenu(null);
}
