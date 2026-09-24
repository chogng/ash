import type { ElectronApplication, Page } from "@playwright/test";
import { PlaywrightDriver, type WindowSize } from "./playwrightDriver.js";

/** Adds Electron-hosted window control to the shared Workbench driver. */
export class ElectronPlaywrightDriver extends PlaywrightDriver {
	constructor(application: ElectronApplication, currentPage: Page) {
		super(application, currentPage);
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
