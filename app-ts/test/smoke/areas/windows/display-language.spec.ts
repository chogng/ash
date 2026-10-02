import { expect, test } from '../../../automation/test.js';

test.use({ openWorkspace: false });

test('Settings changes the display language with the keyboard and keeps it after reload', async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== 'code', 'This scenario requires the Code product');
	const page = workbench.page;
	const settings = page.locator('.ash-settings-editor');
	const languageRow = settings.locator('[data-settings-item-id="workbench.locale"]');
	await page.keyboard.press('ControlOrMeta+,');
	await expect(settings).toBeVisible();
	await settings.locator('[data-settings-category-id="general"]').click();
	await expect(settings.getByRole('heading', { name: 'Display Language', exact: true })).toBeVisible();
	const language = languageRow.getByRole('combobox', { name: 'Interface language', exact: true });
	await expect(language).toHaveText('English');
	await language.focus();
	await language.press('Enter');
	await expect(page.getByRole('option')).toHaveText(['English', '简体中文']);
	await page.keyboard.press('ArrowDown');
	await page.keyboard.press('Enter');
	const chineseLanguage = languageRow.getByRole('combobox', { name: '界面语言', exact: true });
	await expect(chineseLanguage).toHaveText('简体中文');
	await expect(chineseLanguage).toBeFocused();
	await expect(chineseLanguage).toBeEnabled();
	await expect(languageRow).toContainText('选择 Ash 界面使用的语言。');
	await expect(settings.getByRole('heading', { name: '显示语言', exact: true })).toBeVisible();
	await page.locator('.ash-modal-editor-close').click();
	await page.reload();
	await workbench.waitForReady();
	await page.keyboard.press('ControlOrMeta+,');
	await expect(chineseLanguage).toHaveText('简体中文');
	const search = settings.getByRole('searchbox');
	for (const query of ['language', 'locale', '语言']) {
		await search.fill(query);
		await expect(chineseLanguage).toBeVisible();
	}
	await search.fill('');
	if (target.kind === 'browser') {
		const actions = languageRow.getByRole('button', { name: 'More actions for 界面语言' });
		await actions.focus();
		await actions.press('Enter');
		await page.getByRole('menuitem', { name: 'Reset Setting', exact: true }).click();
	} else {
		await chineseLanguage.focus();
		await chineseLanguage.press('Enter');
		await page.keyboard.press('Home');
		await page.keyboard.press('Enter');
	}
	await expect(language).toHaveText('English');
	await expect(language).toBeEnabled();
	await page.locator('.ash-modal-editor-close').click();
	await page.reload();
	await workbench.waitForReady();
	await page.keyboard.press('ControlOrMeta+,');
	await expect(language).toHaveText('English');
});

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
