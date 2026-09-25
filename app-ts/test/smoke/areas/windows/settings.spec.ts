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
