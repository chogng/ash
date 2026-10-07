import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ElectronApplication } from '@playwright/test';
import { expect, test } from '../../../automation/test.js';

test('Content search Settings supports search, keyboard help and Chinese labels while disconnected', async ({ target, workbench, restartWorkbench }) => {
	test.skip(target.appServerMode === 'required', 'Exercises disconnected Workbench Settings.');
	let page = workbench.page;
	await workbench.settingsEditor.openUserSettingsUI();
	const settings = page.locator('.ash-settings-editor');
	await workbench.settingsEditor.selectCategory('general');
	await expect(settings.getByRole('heading', { name: 'Content search', exact: true })).toBeVisible();
	await expect(settings.getByRole('combobox', { name: 'Search engine', exact: true })).toBeDisabled();
	const row = settings.locator('[data-settings-item-id="grep.backend"]');
	await expect(row.getByRole('status')).toHaveText('Could not read search configuration. Connect to App Server and refresh.');
	const refresh = row.getByRole('button', { name: 'Refresh', exact: true });
	await refresh.focus();
	await refresh.press('Alt+F1');
	const help = page.getByRole('dialog', { name: 'Accessibility Help', exact: true });
	await expect(help.getByRole('textbox')).toHaveValue(/selected engine is shared by Agent, editor and Codebase/);
	await help.getByRole('button', { name: 'Close', exact: true }).click();
	await expect(refresh).toBeFocused();
	const search = settings.getByRole('searchbox', { name: 'Search settings', exact: true });
	await search.fill('tgrep');
	await expect(settings.getByRole('combobox', { name: 'Search engine', exact: true })).toBeVisible();
	await search.fill('');
	await workbench.settingsEditor.selectCategory('general');
	await settings.getByRole('combobox', { name: 'Interface language', exact: true }).click();
	await page.getByRole('option', { name: '简体中文', exact: true }).click();
	({ workbench } = await restartWorkbench());
	page = workbench.page;
	await workbench.settingsEditor.openUserSettingsUI();
	await workbench.settingsEditor.selectCategory('general');
	const chineseSettings = page.getByRole('dialog', { name: 'Ash 设置' });
	await expect(chineseSettings.getByRole('heading', { name: '内容搜索', exact: true })).toBeVisible();
	await expect(chineseSettings.getByRole('combobox', { name: '搜索引擎', exact: true })).toBeDisabled();
	const chineseRefresh = chineseSettings.locator('[data-settings-item-id="grep.backend"]').getByRole('button', { name: '刷新', exact: true });
	await chineseRefresh.focus();
	await chineseRefresh.press('Alt+F1');
	await expect(page.getByRole('dialog', { name: '无障碍帮助' }).getByRole('textbox')).toHaveValue(/Agent、编辑器和 Codebase 的内容搜索共用所选引擎/);
});

test('Content search Settings saves the backend engine and restores it after reload', async ({ target, workbench, application }) => {
	test.skip(target.appServerMode !== 'required', 'Uses the real backend and isolated user configuration.');
	const page = workbench.page;
	await workbench.settingsEditor.openUserSettingsUI();
	await workbench.settingsEditor.selectCategory('general');
	const settings = page.locator('.ash-settings-editor');
	const row = settings.locator('[data-settings-item-id="grep.backend"]');
	const engine = row.getByRole('combobox', { name: 'Search engine', exact: true });
	await expect(engine).toBeEnabled();
	await expect(engine).toHaveText('tgrep (default)');
	await engine.focus();
	await engine.press('Enter');
	await page.getByRole('option', { name: 'ripgrep', exact: true }).press('End');
	await page.getByRole('option', { name: 'ripgrep', exact: true }).press('Enter');
	await expect(row.getByRole('status')).toHaveText('Search engine saved.');
	await expect(engine).toHaveText('ripgrep');
	if (target.kind === 'electron') {
		const profile = await (application as ElectronApplication).evaluate(() => process.env.ASH_HOME);
		if (!profile) { throw new Error('The test application has no isolated profile'); }
		expect(await readFile(join(profile, 'config.toml'), 'utf8')).toMatch(/\[grep\]\s*backend = "ripgrep"/);
	}
	await page.locator('.ash-modal-editor-close').click();
	await page.reload();
	await workbench.waitForReady();
	await workbench.settingsEditor.openUserSettingsUI();
	await workbench.settingsEditor.selectCategory('general');
	await expect(engine).toHaveText('ripgrep');
	await expect(engine).toBeEnabled();
	await engine.click();
	await page.getByRole('option', { name: 'tgrep (default)', exact: true }).click();
	await expect(row.getByRole('status')).toHaveText('Search engine saved.');
	await expect(engine).toHaveText('tgrep (default)');
});
