import type { Locator, Page } from "@playwright/test";
import { Editors } from "./editors.js";

/** Product-level automation surface for one Ash Workbench window. */
export class Workbench {
	readonly element: Locator;
	readonly editors: Editors;

	constructor(readonly page: Page) {
		this.element = page.locator(".ash-workbench");
		this.editors = new Editors(page);
	}

	async waitForReady(): Promise<void> {
		await this.page.waitForFunction(() => document.readyState === "complete");
		await this.element.waitFor({ state: "visible" });
		await this.editors.waitForReady();
		await this.waitForUiIdle();
	}

	async waitForUiIdle(): Promise<void> {
		await this.page.evaluate(() => new Promise<void>(resolve => {
			requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
		}));
	}
}
