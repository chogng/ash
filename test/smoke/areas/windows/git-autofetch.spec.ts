import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '../../../automation/test.js';

test(
	'Git Auto Fetch setting saves all three modes through shared App Server config',
	{ tag: ['@electron-app-server'] },
	async ({ application, target, workbench }) => {
		if (!('windows' in application)) return;
		const home = await application.evaluate(() => process.env.ASH_HOME!);
		const readAutofetch = async () =>
			(await readFile(join(home, 'config.toml'), 'utf8')).match(/^autofetch = "(off|default|all)"$/m)?.[1];
		const page = workbench.page;
		await workbench.settingsEditor.openUserSettingsUI();
		await expect(page.locator('.ash-modal-editor')).toBeVisible();
		await workbench.settingsEditor.selectGroup('extensions');
		await workbench.settingsEditor.selectCategory('extension.ash.git');
		const control = page.locator('[data-configuration-key="git.autofetch"]');
		const select = control.getByRole('combobox', { name: 'Auto Fetch' });
		await expect(select).toBeVisible();
		await select.press('Enter');
		await page.getByRole('option', { name: 'Default remote' }).click();
		await expect(select).toContainText('Default remote');
		await expect.poll(readAutofetch).toBe('default');
		await expect(select).toBeEnabled();
		await select.press('Enter');
		await page.getByRole('option', { name: 'All remotes' }).click();
		await expect.poll(readAutofetch).toBe('all');
		await expect(select).toBeEnabled();
		await select.press('Enter');
		await page.getByRole('option', { name: 'Off' }).click();
		await expect.poll(readAutofetch).toBe('off');
	},
);
