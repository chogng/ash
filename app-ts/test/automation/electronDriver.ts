import { expect, type ElectronApplication, type Page } from "@playwright/test";
import { PlaywrightDriver, type WindowSize, type WorkbenchDiagnostics } from "./playwrightDriver.js";

/** Adds Electron-hosted window control to the shared Workbench driver. */
export class ElectronPlaywrightDriver extends PlaywrightDriver {
	constructor(application: ElectronApplication, currentPage: Page, diagnostics: WorkbenchDiagnostics) {
		super(application, currentPage, diagnostics);
	}

	override async setWindowSize(size: WindowSize): Promise<WindowSize> {
		const application = this.application;
		if (!("windows" in application)) {
			throw new Error("Electron window control requires an Electron application");
		}
		const actualSize = await application.evaluate(({ BrowserWindow }, requestedSize) => {
			const window = BrowserWindow.getAllWindows()[0];
			if (!window) throw new Error("Ash workbench window is unavailable");
			window.setSize(requestedSize.width, requestedSize.height);
			const bounds = window.getBounds();
			return { width: bounds.width, height: bounds.height };
		}, size);
		await this.workbench.waitForUiIdle();
		return actualSize;
	}
}

export interface ElectronMenuItem {
	readonly label: string;
	readonly enabled: boolean;
	readonly checked: boolean;
	readonly submenu?: readonly ElectronMenuItem[];
}

interface CapturedMenu {
	readonly items: readonly ElectronMenuItem[];
	readonly error?: string;
}

interface MenuCaptureGlobal {
	ashTestMenuCapture?: { readonly restore: () => void; result?: CapturedMenu };
}

/** Selects only the OS popup item; renderer dispatch, IPC and action execution remain real. */
export async function captureElectronMenu(application: ElectronApplication, trigger: () => Promise<void>, selection?: { readonly label: string; readonly checked?: boolean }): Promise<readonly ElectronMenuItem[]> {
	await application.evaluate(({ Menu }, selection) => {
		const state = globalThis as MenuCaptureGlobal;
		if (state.ashTestMenuCapture) throw new Error('Another test menu capture is active');
		const popup = Menu.prototype.popup;
		const capture = state.ashTestMenuCapture = { restore: () => { Menu.prototype.popup = popup; } } as NonNullable<MenuCaptureGlobal['ashTestMenuCapture']>;
		Menu.prototype.popup = function (options) {
			capture.restore();
			const snapshot = (items: typeof this.items): ElectronMenuItem[] => items.filter(item => item.type !== 'separator').map(item => ({
				label: item.label, enabled: item.enabled, checked: item.checked,
				...(item.submenu ? { submenu: snapshot(item.submenu.items) } : {}),
			}));
			const items = snapshot(this.items);
			try {
				if (selection) {
					const find = (items: typeof this.items): typeof this.items[number] | undefined => {
						for (const item of items) {
							if (item.label === selection.label) return item;
							const nested = item.submenu && find(item.submenu.items);
							if (nested) return nested;
						}
					};
					const item = find(this.items);
					if (!item || !item.enabled) throw new Error(`Expected enabled menu item: ${selection.label}`);
					if (selection.checked !== undefined && item.checked !== selection.checked) throw new Error(`Unexpected menu checked state: ${selection.label}`);
					item.click(item, options?.window, { shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, triggeredByAccelerator: false });
				}
				capture.result = { items };
			} catch (error) {
				// Return failed selections to the runner instead of throwing on Main's event loop.
				capture.result = { items, error: String(error) };
			} finally {
				options?.callback?.();
			}
		};
	}, selection);
	try {
		await trigger();
		await expect.poll(() => application.evaluate(() => Boolean((globalThis as MenuCaptureGlobal).ashTestMenuCapture!.result))).toBe(true);
		const result = await application.evaluate(() => (globalThis as MenuCaptureGlobal).ashTestMenuCapture!.result!);
		if (result.error) throw new Error(result.error);
		return result.items;
	} finally {
		await application.evaluate(() => {
			const state = globalThis as MenuCaptureGlobal;
			state.ashTestMenuCapture!.restore();
			delete state.ashTestMenuCapture;
		});
	}
}
