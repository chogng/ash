import { expect, test } from '@playwright/test';

test('installing a language package enables completion in an already open Python editor', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
	await page.goto('/language.html');
	try {
		expect(await page.evaluate(() => window.languageIntegration.registered())).toBe(false);
		await page.getByRole('button', { name: 'Install Python server', exact: true }).click();
		await expect.poll(() => page.evaluate(() => window.languageIntegration.registered())).toBe(true);
		await page.evaluate(() => window.languageIntegration.focus());
		await page.keyboard.press('Control+Space');
		await expect(page.locator('.stanza-editor-completion-option').filter({ hasText: 'print_from_server' })).toBeVisible();
		await page.keyboard.press('Escape');
		await page.getByRole('button', { name: 'Uninstall Python server', exact: true }).click();
		await expect.poll(() => page.evaluate(() => window.languageIntegration.registered())).toBe(false);
		const requests = await page.evaluate(() => window.languageIntegration.requests());
		await page.evaluate(() => window.languageIntegration.focus());
		await page.keyboard.press('Control+Space');
		await expect(page.locator('.stanza-editor-completion-option').filter({ hasText: 'print_from_server' })).toHaveCount(0);
		expect(await page.evaluate(() => window.languageIntegration.requests())).toBe(requests);
		expect(errors).toEqual([]);
	} finally {
		await page.evaluate(() => window.languageIntegration.dispose());
	}
});
