import { expect, test } from '../../../automation/test.js';

test.use({ openWorkspace: false });

test('command palette changes and clears the display language with the keyboard', async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== 'code', 'This scenario requires the Code product');
	const page = workbench.page;

	await page.keyboard.press('F1');
	let picker = page.locator('.ash-quick-pick');
	await picker.getByRole('combobox').fill('Configure Display Language');
	await expect(picker.locator('.ash-quick-pick-row-label', { hasText: 'Configure Display Language' })).toBeVisible();
	await picker.getByRole('combobox').press('Enter');

	picker = page.getByRole('dialog', { name: 'Select Display Language' });
	await expect(picker.getByRole('combobox')).toBeFocused();
	await picker.getByRole('combobox').fill('简体中文');
	await expect(picker.locator('.ash-quick-pick-row-label', { hasText: '简体中文' })).toBeVisible();
	await picker.getByRole('combobox').press('Enter');
	await expect(picker).toHaveCount(0);

	await page.keyboard.press('F1');
	picker = page.locator('.ash-quick-pick');
	await picker.getByRole('combobox').fill('清除显示语言偏好');
	await expect(picker.locator('.ash-quick-pick-row-label', { hasText: '清除显示语言偏好' })).toBeVisible();
	await picker.getByRole('combobox').press('Enter');
	await expect(picker).toHaveCount(0);

	await page.keyboard.press('F1');
	picker = page.locator('.ash-quick-pick');
	await picker.getByRole('combobox').fill('Configure Display Language');
	await expect(picker.locator('.ash-quick-pick-row-label', { hasText: 'Configure Display Language' })).toBeVisible();
});

test('display language picker opens Marketplace with language packs selected', async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== 'code', 'This scenario requires the Code product');
	const page = workbench.page;
	await page.keyboard.press('F1');
	let picker = page.locator('.ash-quick-pick');
	await picker.getByRole('combobox').fill('Configure Display Language');
	await picker.getByRole('combobox').press('Enter');

	picker = page.getByRole('dialog', { name: 'Select Display Language' });
	await picker.getByRole('combobox').fill('Install more languages from Marketplace');
	await picker.getByRole('combobox').press('Enter');
	await expect(picker).toHaveCount(0);
	await expect(page.locator('.ash-marketplace').getByLabel('Capability')).toHaveValue('localization');
});
