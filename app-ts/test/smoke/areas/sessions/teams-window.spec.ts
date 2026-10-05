import { expect, test } from '../../../automation/test.js';

test('Agents Collaboration page stays empty and selects its Activity Bar entry', async ({ application, target, workbench }) => {
	let page = await workbench.openAgentsWindow(target.kind);
	const activityBar = page.locator('.ash-sessions-activity-content');
	await expect(activityBar.getByRole('button', { name: /^Chat/ })).toHaveAttribute('aria-current', 'page');
	await page.getByRole('button', { name: 'Collaboration' }).click();
	await expect(page.locator('.ash-teams-panel')).toBeHidden();
	await expect(activityBar.getByRole('button', { name: 'Collaboration' })).toHaveAttribute('aria-current', 'page');
	await expect(activityBar.getByRole('button', { name: /^Chat/ })).not.toHaveAttribute('aria-current', 'page');
	page = await workbench.reopenAgentsWindow(application, page);
	await expect(page.locator('.ash-teams-panel')).toBeHidden();
	await expect(page.getByRole('button', { name: 'Collaboration', exact: true })).toHaveAttribute('aria-current', 'page');
});
