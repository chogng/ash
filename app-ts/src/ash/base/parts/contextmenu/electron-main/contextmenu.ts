import {
	Menu,
	type BrowserWindow,
	type MenuItemConstructorOptions,
} from "electron/main";
import { Disposable, toDisposable } from "../../../common/lifecycle.js";
import {
	type INativeContextMenuRequest,
	type INativeContextMenuResult,
	type NativeContextMenuItem,
} from "../common/contextmenu.js";

/** Owns the active Electron context menu for one browser window. */
export class ElectronContextMenu extends Disposable {
	private readonly window: BrowserWindow;
	private activeMenu: Menu | undefined;
	private settle: ((result: INativeContextMenuResult) => void) | undefined;

	constructor(window: BrowserWindow) {
		super();
		this.window = window;
		this._register(toDisposable(() => {
			this.close();
			this.finish({});
		}));
	}

	popup(
		request: INativeContextMenuRequest,
	): Promise<INativeContextMenuResult> {
		this.close();
		this.finish({});
		if (this.window.isDestroyed()) return Promise.resolve({});

		let selectedId: string | undefined;
		const menu = Menu.buildFromTemplate(toTemplate(
			request.items,
			(id) => {
				selectedId = id;
			},
		));
		this.activeMenu = menu;

		const result = new Promise<INativeContextMenuResult>((resolve) => {
			this.settle = resolve;
		});
		try {
			menu.popup({
				window: this.window,
				x: request.x,
				y: request.y,
				callback: () => this.finish(
					selectedId ? { selectedId } : {},
				),
			});
		} catch (error) {
			this.finish({});
			throw error;
		}
		return result;
	}

	close(): void {
		const menu = this.activeMenu;
		if (!menu) return;
		this.activeMenu = undefined;
		if (!this.window.isDestroyed()) menu.closePopup(this.window);
		this.finish({});
	}

	private finish(result: INativeContextMenuResult): void {
		const settle = this.settle;
		if (!settle) return;
		this.settle = undefined;
		this.activeMenu = undefined;
		settle(result);
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
