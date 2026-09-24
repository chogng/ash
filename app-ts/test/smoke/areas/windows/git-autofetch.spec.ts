import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '../../../automation/test.js';

test('Git Auto Fetch setting saves all three modes through shared App Server config', async ({ application, target, workbench }) => {
	test.skip(target.kind !== 'electron' || target.appServerMode !== 'required', 'Requires the desktop App Server.');
	if (!('windows' in application)) return;
	const home = await application.evaluate(() => process.env.ASH_HOME!);
	const readAutofetch = async () => (await readFile(join(home, 'config.toml'), 'utf8')).match(/^autofetch = "(off|default|all)"$/m)?.[1];
	const page = workbench.page;
	await page.keyboard.press('ControlOrMeta+Shift+P');
	await page.getByPlaceholder('Type the name of a command to run').fill('Ash Settings');
	await page.keyboard.press('Enter');
	await expect(page.locator('.ash-modal-editor')).toBeVisible();
	const control = page.locator('[data-configuration-key="git.autofetch"]');
	const select = control.getByRole('combobox', { name: 'Auto Fetch' });
	await expect(select).toBeVisible();
	await select.press('Enter');
	await page.getByRole('option', { name: 'Default remote' }).click();
	await expect(select).toContainText('Default remote');
	await expect.poll(readAutofetch).toBe('default');
	await select.press('Enter');
	await page.getByRole('option', { name: 'All remotes' }).click();
	await expect.poll(readAutofetch).toBe('all');
	await select.press('Enter');
	await page.getByRole('option', { name: 'Off' }).click();
	await expect.poll(readAutofetch).toBe('off');
});
