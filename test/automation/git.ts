import { expect, type Page } from '@playwright/test';
import type { PlaywrightApplication } from './playwrightDriver.js';
import type { Menus } from './menus.js';

/** Drives the Changes title through its rendered toolbar and actual menu dispatch. */
export class Git {
	constructor(private readonly page: Page, private readonly menus: Menus) { }

	async open(): Promise<void> {
		const tab = this.page.getByRole('tab', { name: /^Git(?:,|$)/u });
		if (await tab.getAttribute('aria-selected') !== 'true' || !await this.page.locator('[data-part="sidebar"]').isVisible()) await tab.click();
		await expect(this.page.locator('[data-view-id="ash.gitView"]')).toBeVisible();
	}

	async selectTitleMenu(application: PlaywrightApplication, path: readonly string[]): Promise<void> {
		await this.open();
		const toolbar = this.page.getByRole('toolbar', { name: 'Source control actions', exact: true });
		// Refresh becomes enabled only after the selected provider has finished its operation.
		await expect(toolbar.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled();
		await this.menus.select(application, () => toolbar.getByRole('button', { name: 'More Actions', exact: true }).click(), path);
	}
}
