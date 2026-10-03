import { expect, type Locator, type Page } from '@playwright/test';
import { QuickAccess } from './quickaccess.js';

/** Navigation shared by settings scenarios; callers own feature assertions. */
export class SettingsEditor {
	public readonly element: Locator;

	constructor(private readonly page: Page, private readonly quickaccess: QuickAccess) {
		this.element = page.getByRole('dialog').filter({ has: page.locator('.ash-settings-editor') });
	}

	public async openUserSettingsUI(): Promise<void> {
		await this.quickaccess.runCommand('workbench.action.openSettings');
		await expect(this.element).toBeVisible();
	}

	public async selectCategory(categoryId: string): Promise<void> {
		const category = this.element.getByRole('treeitem').filter({ has: this.page.locator(`[data-settings-category-id="${categoryId}"]`) });
		await category.click();
		await expect(category).toHaveAttribute('aria-selected', 'true');
	}

	public async selectGroup(groupId: string): Promise<void> {
		const group = this.element.getByRole('treeitem').filter({ has: this.page.locator(`[data-settings-group-id="${groupId}"]`) });
		if (await group.getAttribute('aria-expanded') !== 'true') {
			await group.click();
		}
		await expect(group).toHaveAttribute('aria-expanded', 'true');
	}
}
