import { expect, type Locator, type Page } from "@playwright/test";
import { Editors } from "./editors.js";
import { QuickAccess } from "./quickaccess.js";
import { StartupDeadline } from './startupDeadline.js';

/** Product-level automation surface for one Ash Workbench window. */
export class Workbench {
	readonly element: Locator;
	readonly editors: Editors;
	readonly quickaccess: QuickAccess;

	constructor(readonly page: Page) {
		this.element = page.locator(".ash-workbench");
		this.editors = new Editors(page);
		this.quickaccess = new QuickAccess(page);
	}

	async waitForReady(deadline = new StartupDeadline()): Promise<void> {
		await deadline.run('Workbench readiness', async () => {
			await this.page.waitForFunction(() => document.readyState === "complete", undefined, { timeout: deadline.remaining('document load') });
			await this.element.waitFor({ state: "visible", timeout: deadline.remaining('Workbench visibility') });
			// Recovery owns readiness; its wait uses the launch budget, not an interaction assertion budget.
			await expect(this.element).toHaveAttribute('aria-busy', 'false', { timeout: deadline.remaining('Workbench restoration') });
			await this.editors.waitForReady(deadline);
			await this.waitForAnimationFrames();
		});
	}

	/** Allows pending rendering frames to run; this does not await asynchronous command completion. */
	async waitForAnimationFrames(): Promise<void> {
		await this.page.evaluate(() => new Promise<void>(resolve => {
			requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
		}));
	}
}
