import { expect, test } from '../../../automation/test.js';

test('Settings opens with editor display controls', async ({ workbench }) => {
	const page = workbench.page;
	await page.keyboard.press('ControlOrMeta+Shift+P');
	await page.getByPlaceholder('Type the name of a command to run').fill('Ash Settings');
	await page.keyboard.press('Enter');
	await expect(page.locator('.ash-modal-editor')).toBeVisible();
	await page.locator('[data-settings-category-id="editor"]').click();
	await expect(page.locator('[data-configuration-key="editor.renderWhitespace"]')).toBeVisible();
	await expect(page.locator('[data-configuration-key="editor.renderControlCharacters"]')).toBeVisible();
});

test.describe('without an open workspace', () => {
	test.use({ openWorkspace: false });

	test('title bar Settings opens from the welcome page', async ({ workbench }) => {
		const page = workbench.page;
		await page.getByRole('dialog', { name: 'Find commands quickly' }).getByRole('button', { name: 'Dismiss' }).click();
		const settingsButton = page.getByRole('button', { name: 'Ash Settings' });
		await settingsButton.focus();
		const tooltip = page.locator('.ash-hover', { hasText: 'Ash Settings' });
		await expect(tooltip).toBeVisible();
		const buttonBounds = await settingsButton.boundingBox();
		const tooltipBounds = await tooltip.boundingBox();
		expect(buttonBounds).not.toBeNull();
		expect(tooltipBounds).not.toBeNull();
		expect(Math.abs((buttonBounds!.x + buttonBounds!.width / 2) - (tooltipBounds!.x + tooltipBounds!.width / 2))).toBeLessThan(1);
		await settingsButton.click();
		await expect(page.getByRole('dialog', { name: 'Ash Settings' })).toBeVisible();
		await expect(page.locator('.ash-settings-editor')).toBeVisible();
		await page.locator('[data-settings-category-id="appearance"]').click();
		await expect(page.locator('[data-configuration-key="window.zoomLevel"]')).toBeVisible();
	});
});
