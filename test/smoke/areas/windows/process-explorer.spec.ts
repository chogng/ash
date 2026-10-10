import { expect, test } from '../../../automation/test.js';
import { Workbench } from '../../../automation/workbench.js';

for (const windowKind of ['Editor', 'Agents'] as const) {
	test(`the ${windowKind} Desktop window opens real process metrics and restores keyboard focus`, async ({ workbench, target }) => {
		test.skip(target.kind !== 'electron', 'Local process collection requires the Desktop host');
		const driver = windowKind === 'Agents' ? new Workbench(await workbench.openAgentsWindow(target.kind)) : workbench;
		const page = driver.page;
		await driver.quickaccess.runCommand('workbench.action.openProcessExplorer');
		const explorer = page.locator('.ash-process-explorer');
		await expect(explorer).toBeVisible();
		await expect(explorer.getByRole('status')).toContainText(/\d+ processes/);
		const main = explorer.getByRole('treeitem').filter({ hasText: 'Ash Main' });
		await expect(main).toBeVisible();
		await expect(main.locator('.process-explorer-row > span').nth(3)).toHaveText(/^\d+$/);
		await expect(main.locator('.process-explorer-row > span').nth(2)).toHaveText(/^\d+\.\d$/);
		const tree = explorer.getByRole('tree');
		await tree.focus(); await page.keyboard.press('Alt+F1');
		await expect(page.getByRole('dialog', { name: 'Accessibility Help' }).getByRole('textbox')).toHaveValue(/Process Explorer displays local Desktop processes/);
		await page.keyboard.press('Escape'); await expect(tree).toBeFocused();
		await page.keyboard.press('Alt+F2');
		await expect(page.getByRole('dialog', { name: 'Accessible View' }).getByRole('textbox')).toHaveValue(/Ash Main/);
		await page.keyboard.press('Escape'); await expect(tree).toBeFocused();
		await explorer.getByRole('button', { name: 'Refresh', exact: true }).click();
		await expect(tree).toHaveAttribute('aria-busy', 'false');
		await expect(explorer.getByRole('status')).not.toContainText('Could not');
		await page.getByRole('button', { name: 'Close Process Explorer', exact: true }).click();
		await expect(explorer).toHaveCount(0);
		await driver.quickaccess.runCommand('workbench.action.openProcessExplorer');
		await expect(explorer.getByRole('status')).toContainText(/\d+ processes/);
	});
}
