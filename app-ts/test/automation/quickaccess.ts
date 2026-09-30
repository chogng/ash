import { expect, type Locator, type Page } from '@playwright/test';

export class QuickAccess {
	public readonly element: Locator;
	public readonly input: Locator;
	public readonly items: Locator;

	constructor(private readonly page: Page) {
		this.element = page.locator('.ash-quick-pick');
		this.input = this.element.getByRole('combobox');
		this.items = this.element.getByRole('option');
	}

	public async open(value = '>'): Promise<void> {
		await this.page.keyboard.press('F1');
		await expect(this.input).toBeFocused();
		await this.search(value);
	}

	public async search(value: string): Promise<void> {
		await this.input.fill(value);
	}

	public async select(label: string): Promise<void> {
		await this.items.filter({ has: this.page.locator('.ash-quick-pick-row-label').getByText(label, { exact: true }) }).click();
	}

	public async runCommand(commandId: string): Promise<void> {
		await this.open(`>${commandId}`);
		const commandList = this.page.locator(`[id="${await this.input.getAttribute('aria-controls')}"]`);
		// Command descriptions carry stable IDs, independent of the display language.
		await this.items.filter({ has: this.page.locator('.ash-quick-pick-row-description').getByText(commandId, { exact: true }) }).click();
		// The command may open another picker; only the command list must close.
		await commandList.waitFor({ state: 'hidden' });
	}

	public async close(): Promise<void> {
		await this.input.press('Escape');
		await this.element.waitFor({ state: 'hidden' });
	}
}
