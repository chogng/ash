import { expect, type Locator, type Page } from '@playwright/test';

/** Search navigation and submission; scenarios own result assertions. */
export class Search {
	readonly element: Locator;
	readonly query: Locator;
	readonly status: Locator;
	readonly files: Locator;

	constructor(private readonly page: Page) {
		this.element = page.locator('.ash-search');
		this.query = this.element.getByRole('textbox', { name: 'Search workspace', exact: true });
		this.status = this.element.getByRole('status');
		this.files = this.element.locator('.ash-search-file-path');
	}

	async open(): Promise<void> {
		if (!await this.page.getByRole('region', { name: 'Primary sidebar' }).isVisible()) {
			await this.page.getByRole('button', { name: 'Show Primary Side Bar', exact: true }).click();
		}
		await this.page.getByRole('tab', { name: 'Search', exact: true }).click();
		await expect(this.element).toBeVisible();
	}

	async search(text: string): Promise<void> {
		await this.query.fill(text);
		await this.query.press('Enter');
		await expect(this.element.getByRole('button', { name: 'Search', exact: true })).toBeEnabled();
	}
}
