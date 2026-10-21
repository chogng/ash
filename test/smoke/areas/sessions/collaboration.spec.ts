import { expect, test } from '../../../automation/test.js';

test('Collaboration separates human channels from Agent Teams', { tag: ['@electron-ui', '@browser-ui'] }, async ({ application, workbench, target }, testInfo) => {
	await workbench.quickaccess.runCommand('ash.collaboration.open');
	const channels = workbench.page.locator('.ash-collaboration');
	await expect(channels.getByRole('button', { name: 'Connect Channels', exact: true })).toBeVisible();

	let page = await workbench.openAgentsWindow(target.kind);
	const navigation = page.locator('.ash-sessions-activity-content');
	await navigation.getByRole('button', { name: 'Collaboration', exact: true }).click();
	const collaboration = page.locator('[data-view-container-id="ash.collaboration"]');
	await expect(collaboration.getByRole('button', { name: 'Connect Channels', exact: true })).toBeVisible();
	await navigation.getByRole('button', { name: 'Agent Teams', exact: true }).click();
	await expect(page.locator('.ash-teams-panel')).toBeVisible();
	await expect(collaboration).toBeHidden();
	await navigation.getByRole('button', { name: 'Collaboration', exact: true }).click();
	await expect(collaboration.getByRole('button', { name: 'Connect Channels', exact: true })).toBeVisible();
	await page.screenshot({ path: testInfo.outputPath('collaboration-window.png') });
	page = await workbench.reopenAgentsWindow(application, page);
	await expect(page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Collaboration', exact: true })).toHaveAttribute('aria-current', 'page');
	await expect(page.locator('[data-view-container-id="ash.collaboration"]').getByRole('button', { name: 'Connect Channels', exact: true })).toBeVisible();
});
