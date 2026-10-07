import { app, BrowserWindow, Menu, nativeImage, TouchBar, type MenuItemConstructorOptions } from 'electron';
import type { INativeMenubarMainHost } from './menubarMainService.js';

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
