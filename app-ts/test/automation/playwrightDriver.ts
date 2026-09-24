import type { Browser, ElectronApplication, Page } from "@playwright/test";
import { Workbench } from "./workbench.js";

export type PlaywrightApplication = Browser | ElectronApplication;

export interface WindowSize {
	readonly width: number;
	readonly height: number;
}

/** Small Workbench-facing driver shared by Browser and Electron end-to-end tests. */
export class PlaywrightDriver {
	readonly workbench: Workbench;

	constructor(
		readonly application: PlaywrightApplication,
		readonly currentPage: Page,
		readonly consoleErrors: readonly string[] = [],
	) {
		this.workbench = new Workbench(currentPage);
	}

	async setWindowSize(size: WindowSize): Promise<WindowSize> {
		await this.currentPage.setViewportSize(size);
		await this.currentPage.waitForFunction(
			requestedSize => window.innerWidth === requestedSize.width && window.innerHeight === requestedSize.height,
			size,
		);
		await this.workbench.waitForUiIdle();
		return size;
	}
}
