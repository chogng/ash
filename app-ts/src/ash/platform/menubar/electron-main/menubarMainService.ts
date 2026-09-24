import { Disposable, type IDisposable, toDisposable } from "../../../base/common/lifecycle.js";
import type {
	IpcRoute,
} from "../../ipc/electron-main/trustedIpcRouter.js";
import {
	type INativeMenubarData,
	NATIVE_MENUBAR_SELECT_CHANNEL,
	NATIVE_MENUBAR_UPDATE_CHANNEL,
	type NativeMenubarItem,
	validateNativeMenubarData,
} from "../common/nativeMenubar.js";

export interface INativeMenubarMainHost {
	readonly applicationName: string;
	setApplicationMenu(
		template: readonly INativeMenubarMainMenuItem[] | undefined,
	): void;
}

export interface INativeMenubarMainWindow {
	readonly id: number;
	readonly webContents: {
		send(channel: string, value: unknown): void;
	};
	isDestroyed(): boolean;
	isFocused(): boolean;
	on(event: "focus", listener: () => void): unknown;
	removeListener(event: "focus", listener: () => void): unknown;
}

export interface INativeMenubarMainMenuItem {
	readonly type?: "normal" | "separator" | "submenu" | "checkbox";
	readonly role?: "about" | "services" | "hide" | "hideOthers" | "unhide" | "quit" | "windowMenu" | "minimize" | "zoom" | "front";
	readonly label?: string;
	readonly enabled?: boolean;
	readonly checked?: boolean;
	readonly submenu?: readonly INativeMenubarMainMenuItem[];
	readonly click?: (
		menuItem: unknown,
		window: unknown,
		event: { readonly altKey: boolean },
	) => void;
}

interface IWindowMenubarState {
	readonly window: INativeMenubarMainWindow;
	data: INativeMenubarData | undefined;
}

/** Owns the macOS application menu and the snapshots of all workbench windows. */
export class NativeMenubarMainService extends Disposable {
	private readonly host: INativeMenubarMainHost;
	private readonly windows = new Map<number, IWindowMenubarState>();
	private readonly activationOrder: number[] = [];
	private activeWindowId: number | undefined;

	constructor(host: INativeMenubarMainHost) {
		super();
		this.host = host;
		this._register(toDisposable(() => this.host.setApplicationMenu(undefined)));
	}

	registerWindow(window: INativeMenubarMainWindow): IDisposable {
		if (this.windows.has(window.id)) {
			throw new Error(`Workbench window ${window.id} already has a menubar`);
		}

		this.windows.set(window.id, { window, data: undefined });
		const handleFocus = (): void => this.activateWindow(window.id);
		window.on("focus", handleFocus);
		if (window.isFocused()) this.activateWindow(window.id);

		return toDisposable(() => {
			window.removeListener("focus", handleFocus);
			this.windows.delete(window.id);
			const activationIndex = this.activationOrder.indexOf(window.id);
			if (activationIndex >= 0) this.activationOrder.splice(activationIndex, 1);
			if (this.activeWindowId !== window.id) return;
			this.activeWindowId = undefined;
			this.activateMostRecentWindow();
		});
	}

	update(window: INativeMenubarMainWindow, data: INativeMenubarData): void {
		const state = this.windows.get(window.id);
		if (!state || state.window !== window || window.isDestroyed()) return;
		state.data = data;
		if (window.isFocused() || this.activeWindowId === undefined) {
			this.activateWindow(window.id);
			return;
		}
		if (this.activeWindowId === window.id) this.install(state);
	}

	private activateWindow(windowId: number): void {
		const state = this.windows.get(windowId);
		if (!state || state.window.isDestroyed()) return;
		const previousIndex = this.activationOrder.indexOf(windowId);
		if (previousIndex >= 0) this.activationOrder.splice(previousIndex, 1);
		this.activationOrder.push(windowId);
		this.activeWindowId = windowId;
		this.install(state);
	}

	private activateMostRecentWindow(): void {
		for (let index = this.activationOrder.length - 1; index >= 0; index -= 1) {
			const windowId = this.activationOrder[index]!;
			const state = this.windows.get(windowId);
			if (state && !state.window.isDestroyed()) {
				this.activateWindow(windowId);
				return;
			}
		}
		this.install(undefined);
	}

	private install(state: IWindowMenubarState | undefined): void {
		const data = state?.data;
		const template: INativeMenubarMainMenuItem[] = [
			applicationMenu(this.host.applicationName),
			...(data?.menus ?? []).map(({ label, items }) => ({
				label,
				submenu: toTemplate(items, (id) => {
					if (state && data) this.select(state.window, data.revision, id);
				}),
			})),
			windowMenu(),
		];
		this.host.setApplicationMenu(template);
	}

	private select(window: INativeMenubarMainWindow, revision: number, id: string): void {
		if (window.isDestroyed()) return;
		window.webContents.send(NATIVE_MENUBAR_SELECT_CHANNEL, {
			revision,
			id,
		});
	}
}

export function nativeMenubarIpcRoutes(
	service: NativeMenubarMainService,
	window: INativeMenubarMainWindow,
): readonly IpcRoute<unknown, unknown>[] {
	return [{
		channel: NATIVE_MENUBAR_UPDATE_CHANNEL,
		validate: validateNativeMenubarData,
		invoke: (data) => service.update(window, data as INativeMenubarData),
	}];
}

function toTemplate(
	items: readonly NativeMenubarItem[],
	select: (id: string) => void,
): INativeMenubarMainMenuItem[] {
	return items.map((item): INativeMenubarMainMenuItem => {
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
					click: (_menuItem, _window, event) => select(
						event.altKey && item.altId ? item.altId : item.id,
					),
				};
		}
	});
}

function applicationMenu(applicationName: string): INativeMenubarMainMenuItem {
	return {
		label: applicationName,
		submenu: [
			{ role: "about" },
			{ type: "separator" },
			{ role: "services" },
			{ type: "separator" },
			{ role: "hide" },
			{ role: "hideOthers" },
			{ role: "unhide" },
			{ type: "separator" },
			{ role: "quit" },
		],
	};
}

function windowMenu(): INativeMenubarMainMenuItem {
	return {
		role: "windowMenu",
		submenu: [
			{ role: "minimize" },
			{ role: "zoom" },
			{ type: "separator" },
			{ role: "front" },
		],
	};
}
