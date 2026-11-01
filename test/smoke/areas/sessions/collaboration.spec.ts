import { QuickAccess } from '../../../automation/quickaccess.js';
import { expect, test } from '../../../automation/test.js';

test.use({ openWorkspace: false });

test('Collab retains channel navigation while Agent settings are open', { tag: ['@electron-ui', '@browser-ui'] }, async ({ application, workbench, target }, testInfo) => {
	await workbench.quickaccess.runCommand('ash.collaboration.open');
	const channels = workbench.page.locator('.ash-collaboration');
	await expect(channels.getByRole('button', { name: 'Connect Channels', exact: true })).toBeVisible();

	let page = await workbench.openAgentsWindow(target.kind);
	let navigation = page.locator('.ash-sessions-activity-content');
	await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
	await navigation.getByRole('button', { name: 'Collab', exact: true }).click();
	const collaboration = page.locator('[data-view-container-id="ash.collaboration"]');
	await expect(collaboration.getByRole('button', { name: 'Connect Channels', exact: true })).toBeVisible();
	await new QuickAccess(page).runCommand('workbench.action.openSettings');
	const settings = page.getByRole('dialog', { name: 'Sessions Settings', exact: true });
	await settings.getByRole('button', { name: 'Agents', exact: true }).click();
	await settings.getByRole('tab', { name: 'Teams', exact: true }).click();
	await expect(settings.getByRole('button', { name: 'New Team', exact: true })).toBeVisible();
	await expect(navigation.getByRole('button', { name: 'Collab', exact: true })).toHaveAttribute('aria-current', 'page');
	await page.keyboard.press('Escape');
	await expect(settings).toHaveCount(0);
	await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
	await navigation.getByRole('button', { name: 'Collab', exact: true }).click();
	await expect(page.locator('[data-view-container-id="ash.collaboration"]').getByRole('button', { name: 'Connect Channels', exact: true })).toBeVisible();
	await page.screenshot({ path: testInfo.outputPath('collaboration-window.png') });
	page = await workbench.reopenAgentsWindow(application, page);
	await expect(page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Collab', exact: true })).toHaveAttribute('aria-current', 'page');
	await expect(page.locator('[data-view-container-id="ash.collaboration"]').getByRole('button', { name: 'Connect Channels', exact: true })).toBeVisible();
});
