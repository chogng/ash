import { expect, test } from '../../../automation/test.js';

test('Git Auto Fetch setting saves all three modes through the Settings editor', async ({ target, workbench }) => {
	test.skip(target.kind !== 'electron', 'Settings persistence is verified in the desktop host.');
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
	await expect.poll(() => readAutofetch(page)).toBe(true);
	await select.press('Enter');
	await page.getByRole('option', { name: 'All remotes' }).click();
	await expect.poll(() => readAutofetch(page)).toBe('all');
	await select.press('Enter');
	await page.getByRole('option', { name: 'Off' }).click();
	await expect.poll(() => readAutofetch(page)).toBeUndefined();
});

async function readAutofetch(page: import('@playwright/test').Page): Promise<unknown> {
	return page.evaluate(async () => {
		const ipc = (globalThis as unknown as { ash: { ipcRenderer: { invoke(channel: string): Promise<unknown> } } }).ash.ipcRenderer;
		const snapshot = await ipc.invoke('ash:configuration:read') as { document: { source: string } };
		return (JSON.parse(snapshot.document.source) as Record<string, unknown>)['git.autofetch'];
	});
}
