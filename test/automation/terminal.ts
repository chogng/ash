import type { Locator, Page } from '@playwright/test';

/** Terminal navigation and input shared by product scenarios. */
export class Terminal {
	readonly instances: Locator;
	readonly activeInstance: Locator;
	readonly tabs: Locator;

	constructor(private readonly page: Page) {
		this.instances = page.locator('.ash-terminal-instance');
		this.activeInstance = page.locator('.ash-terminal-instance:visible');
		this.tabs = page.getByRole('tablist', { name: 'Terminal instances', exact: true }).getByRole('tab');
	}

	async show(): Promise<void> {
		await this.page.getByRole('button', { name: 'Toggle Panel Visibility', exact: true }).click();
		await this.activeInstance.locator('.xterm-helper-textarea').waitFor({ state: 'attached' });
	}

	async runCommand(command: string): Promise<void> {
		const input = this.activeInstance.locator('.xterm-helper-textarea');
		await input.focus();
		await input.pressSequentially(command);
		await input.press('Enter');
	}
}
