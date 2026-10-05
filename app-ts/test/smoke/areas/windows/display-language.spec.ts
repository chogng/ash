import { expect, test } from '../../../automation/test.js';

test.use({ openWorkspace: false });

test('display language stays unchanged until restart and initializes Chinese command titles', async ({ target, workbench, restartWorkbench, deferRestart, restartMessage }) => {
	let page = workbench.page;
	await page.keyboard.press('ControlOrMeta+,');
	let settings = page.locator('.ash-settings-editor');
	await settings.locator('[data-settings-category-id="general"]').click();
	const language = settings.locator('[data-settings-item-id="workbench.locale"]').getByRole('combobox', { name: 'Interface language', exact: true });
	await language.focus();
	await language.press('Enter');
	await expect(page.getByRole('option')).toHaveText(['English', '简体中文']);
	await page.keyboard.press('ArrowDown');
	await page.keyboard.press('Enter');
	await expect.poll(restartMessage).toBe('Restart Ash to use 简体中文?');
	await expect(settings.getByRole('heading', { name: 'Display Language', exact: true })).toBeVisible();
	await expect(language).toHaveText('简体中文');
	await deferRestart();
	await expect(language).toBeFocused();
	await expect(language).toBeEnabled();
	await expect(settings).toContainText('Choose the language used by the Ash interface.');
	await page.locator('.ash-modal-editor-close').click();
	await workbench.quickaccess.runCommand('workbench.action.configureLocale');
	const picker = page.getByRole('dialog', { name: 'Select Display Language' });
	await picker.getByRole('combobox').fill('简体中文');
	await picker.getByRole('combobox').press('Enter');
	({ workbench } = await restartWorkbench());
	page = workbench.page;
	await expect(page.getByRole('button', { name: '搜索命令', exact: true })).toBeVisible();
	await expect(page.getByRole('button', { name: '管理', exact: true })).toBeVisible();
	if (target.appServerMode === 'required') {
		await workbench.quickaccess.runCommand('ash.call.open');
		const call = page.locator('.ash-call').getByRole('combobox', { name: 'Call', exact: true });
		await call.focus();
		await call.press('Alt+F1');
		const help = page.getByRole('dialog', { name: '无障碍帮助', exact: true });
		await expect(help.getByRole('textbox')).toHaveValue(/麦克风/u);
		await page.keyboard.press('Escape');
		await expect(call).toBeFocused();
	}
	await page.keyboard.press('F1');
	const commands = page.locator('.ash-quick-pick');
	await commands.getByRole('combobox').fill('创建分支');
	await expect(commands.locator('.ash-quick-pick-row-label', { hasText: 'Git: 创建分支' })).toBeVisible();
	await commands.getByRole('combobox').fill('Preferences: Change Keyboard Layout');
	await expect(commands.locator('.ash-quick-pick-row-label', { hasText: '首选项：更改键盘布局' })).toBeVisible();
	await commands.getByRole('combobox').press('Enter');
	const layouts = page.getByRole('dialog', { name: '选择键盘布局' });
	await expect(layouts).toBeVisible();
	await expect(layouts.locator('.ash-quick-pick-row-label', { hasText: '自动检测' })).toBeVisible();
	await page.keyboard.press('Escape');
	await page.keyboard.press('ControlOrMeta+,');
	settings = page.getByRole('dialog', { name: 'Ash 设置' });
	await settings.locator('[data-settings-category-id="general"]').click();
	const chinese = settings.locator('[data-settings-item-id="workbench.locale"]').getByRole('combobox', { name: '界面语言', exact: true });
	await expect(chinese).toHaveText('简体中文');
	const search = settings.getByRole('searchbox');
	for (const query of ['language', 'locale', '语言']) {
		await search.fill(query);
		await expect(chinese).toBeVisible();
	}
	await page.locator('.ash-modal-editor-close').click();
	await workbench.quickaccess.runCommand('workbench.action.clearLocalePreference');
	await expect.poll(restartMessage).toBe('重启 Ash 以使用English？');
	({ workbench } = await restartWorkbench());
	await workbench.page.keyboard.press('ControlOrMeta+,');
	await expect(workbench.page.getByRole('dialog', { name: 'Ash Settings' })).toBeVisible();
});

test('command palette saves and clears a pending display language without changing current commands', async ({ workbench, deferRestart }) => {
	const page = workbench.page;
	await workbench.quickaccess.runCommand('workbench.action.configureLocale');
	const picker = page.getByRole('dialog', { name: 'Select Display Language' });
	await picker.getByRole('combobox').fill('简体中文');
	await picker.getByRole('combobox').press('Enter');
	await deferRestart();
	await workbench.quickaccess.runCommand('workbench.action.clearLocalePreference');
	await page.keyboard.press('ControlOrMeta+,');
	const settings = page.getByRole('dialog', { name: 'Ash Settings' });
	await settings.locator('[data-settings-category-id="general"]').click();
	await expect(settings.getByRole('combobox', { name: 'Interface language', exact: true })).toHaveText('English');
});

test('display language picker opens Marketplace with language packs selected', async ({ workbench }) => {
	const page = workbench.page;
	await expect(page.getByRole('button', { name: 'Search commands', exact: true })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Manage', exact: true })).toBeVisible();
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
