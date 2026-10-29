import { expect, type Page } from '@playwright/test';
import type { PlaywrightApplication } from './playwrightDriver.js';
import type { Menus } from './menus.js';
import type { SettingsEditor } from './settings.js';

/** Drives the Changes title through its rendered toolbar and actual menu dispatch. */
export class Git {
	constructor(
		private readonly page: Page,
		private readonly menus: Menus,
		private readonly settings: SettingsEditor,
	) {}

	async setHistoryBadges(value: 'All references' | 'Filtered references'): Promise<void> {
		await this.settings.openUserSettingsUI();
		const settings = this.settings.element;
		await settings.getByRole('searchbox').fill('scm.graph.badges');
		await settings.locator('[data-settings-item-id="scm.graph.badges"]').getByRole('combobox').click();
		await this.page.getByRole('option', { name: value, exact: true }).click();
		await settings.locator('.ash-modal-editor-close').click();
	}

	async open(): Promise<void> {
		const tab = this.page.getByRole('tab').and(this.page.locator('[data-action-id="ash.git"]'));
		if ((await tab.getAttribute('aria-selected')) !== 'true' || !(await this.page.locator('[data-part="sidebar"]').isVisible())) await tab.click();
		await expect(this.page.locator('[data-view-id="ash.gitView"]')).toBeVisible();
	}

	async selectTitleMenu(application: PlaywrightApplication, path: readonly string[]): Promise<void> {
		await this.open();
		await this.page.locator('[data-view-id="ash.gitView"] .ash-pane-view-header').hover();
		const toolbar = this.page.getByRole('toolbar', { name: 'Source control actions', exact: true });
		// Refresh becomes enabled only after the selected provider has finished its operation.
		await expect(this.page.locator('[data-view-id="ash.gitView"] [data-action-id="git.refresh"] button')).toBeEnabled();
		await this.page.locator('[data-view-id="ash.gitView"] .ash-pane-view-header').hover();
		await this.menus.select(application, () => toolbar.getByRole('button', { name: 'More Actions', exact: true }).click(), path);
	}
}
