import { expect, test } from '../../../automation/test.js';

test('extension status bar replaces commands, supports keyboard activation and releases entries on reload', async ({ workbench, reloadWorkbench }) => {
	test.skip(!process.env.ASH_WEB_EXTENSION_PATHS?.includes('statusbar-extension'), 'Requires the bundled extension status bar fixture.');
	let page = workbench.page;
	await workbench.quickaccess.runCommand('ash.statusbar.fixture.show');
	let item = page.locator('.ash-statusbar-item').filter({ has: page.getByRole('button', { name: 'Run extension status 0', exact: true }) });
	await expect(item).toHaveText('Extension status 0');
	await item.getByRole('button').click();
	await expect(page.getByRole('button', { name: 'Run extension status 1', exact: true })).toBeVisible();
	await workbench.quickaccess.runCommand('ash.statusbar.fixture.replace');
	item = page.locator('.ash-statusbar-item').filter({ has: page.getByRole('button', { name: 'Run extension status 37', exact: true }) });
	await expect(item).toHaveCount(1);
	await expect(item).toHaveText('Extension status 37');
	await item.getByRole('button').focus();
	await item.getByRole('button').press('Enter');
	await expect(page.getByRole('button', { name: 'Run extension status 38', exact: true })).toBeVisible();
	await workbench.quickaccess.runCommand('ash.statusbar.fixture.hide');
	await expect(page.locator('.ash-statusbar-item-label[aria-label^="Run extension status"]')).toHaveCount(0);
	await workbench.quickaccess.runCommand('ash.statusbar.fixture.show');
	await expect(page.getByRole('button', { name: 'Run extension status 0', exact: true })).toBeVisible();
	const reloaded = await reloadWorkbench();
	page = reloaded.workbench.page;
	await expect(page.locator('.ash-statusbar-item-label[aria-label^="Run extension status"]')).toHaveCount(0);
	await reloaded.workbench.quickaccess.runCommand('ash.statusbar.fixture.show');
	await expect(page.getByRole('button', { name: 'Run extension status 0', exact: true })).toHaveCount(1);
});
