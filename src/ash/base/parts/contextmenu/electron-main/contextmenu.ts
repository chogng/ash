import {
	Menu,
	type BrowserWindow,
	type MenuItemConstructorOptions,
} from "electron/main";
import { Disposable, toDisposable } from "../../../common/lifecycle.js";
import { promiseWithResolvers } from '../../../common/async.js';
import {
	type INativeContextMenuRequest,
	type INativeContextMenuResult,
	type NativeContextMenuItem,
} from "../common/contextmenu.js";

interface IMenuPopup {
	readonly menu: Menu;
	readonly settle: (result: INativeContextMenuResult) => void;
	readonly onWindowClosed: () => void;
	closeRequested: boolean;
}

/** Owns the active Electron context menu for one browser window. */
export class ElectronContextMenu extends Disposable {
	private readonly window: BrowserWindow;
	private activePopup: IMenuPopup | undefined;

	constructor(window: BrowserWindow) {
		super();
		this.window = window;
		this._register(toDisposable(() => this.close()));
	}

	popup(
		request: INativeContextMenuRequest,
	): Promise<INativeContextMenuResult> {
		// A closing OS menu still owns the window until its callback confirms closure.
		if (this.activePopup || this.isDisposed || this.window.isDestroyed()) return Promise.resolve({});

		let selectedId: string | undefined;
		const menu = Menu.buildFromTemplate(toTemplate(
			request.items,
			(id) => {
				selectedId = id;
			},
		));
		const result = promiseWithResolvers<INativeContextMenuResult>();
		const popup: IMenuPopup = { menu, settle: result.resolve, closeRequested: false, onWindowClosed: () => this.finish(menu, {}) };
		this.activePopup = popup;
		// This listener follows the pending OS popup, including closure after synchronous disposal.
		this.window.once('closed', popup.onWindowClosed);
		try {
			// Electron positions menus in unzoomed window coordinates; renderer anchors use CSS pixels.
			const zoom = this.window.webContents.getZoomFactor();
			menu.popup({
				window: this.window,
				x: Math.floor(request.x * zoom),
				y: Math.floor(request.y * zoom) + (request.elementAnchor ? 4 : 0),
				positioningItem: request.positioningItem,
				callback: () => this.finish(menu,
					!popup.closeRequested && selectedId ? { selectedId } : {},
				),
			});
		} catch (error) {
			this.finish(menu, {});
			throw error;
		}
		return result.promise;
	}

	close(): void {
		const popup = this.activePopup;
		if (!popup) return;
		popup.closeRequested = true;
		if (this.window.isDestroyed()) {
			this.finish(popup.menu, {});
			return;
		}
		// A failed close retains the owner for retry; success still waits for the popup callback.
		popup.menu.closePopup(this.window);
	}

	private finish(menu: Menu, result: INativeContextMenuResult): void {
		const popup = this.activePopup;
		if (!popup || popup.menu !== menu) return;
		this.activePopup = undefined;
		this.window.removeListener('closed', popup.onWindowClosed);
		popup.settle(result);
	}
}

function toTemplate(
	items: readonly NativeContextMenuItem[],
	select: (id: string) => void,
): MenuItemConstructorOptions[] {
	return items.map((item): MenuItemConstructorOptions => {
		switch (item.type) {
			case "separator":
				return { type: "separator" };
			case "submenu":
				return {
					type: "submenu",
					label: item.label,
					enabled: item.enabled,
					submenu: toTemplate(item.items, select),
				};
			case "action":
				return {
					type: item.checked === undefined ? "normal" : "checkbox",
					label: item.label,
					enabled: item.enabled,
					checked: item.checked,
					accelerator: item.accelerator,
					click: () => select(item.id),
				};
		}
	});
}
