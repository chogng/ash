import { QuickAccess } from '../../../automation/quickaccess.js';
import { expect, test } from '../../../automation/test.js';

test.use({ openWorkspace: false });

test('Collab retains channel navigation while Agent settings are open', { tag: ['@electron-ui', '@browser-ui'] }, async ({ application, workbench, target }, testInfo) => {
	await workbench.quickaccess.runCommand('ash.collaboration.open');
	const channels = workbench.page.locator('.ash-collaboration');
	await expect(channels.getByRole('button', { name: 'Connect Channels', exact: true })).toBeVisible();

	let page = await workbench.openAgentsWindow(target.kind);
	await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Chat / Agents', exact: true }).click();
	const more = page.locator('.ash-sessions-navigation').getByRole('button', { name: 'More', exact: true });
	await more.click();
	await page.getByRole('menuitemradio', { name: 'Collab', exact: true }).click();
	const collaboration = page.locator('[data-view-container-id="ash.collaboration"]');
	await expect(collaboration.getByRole('button', { name: 'Connect Channels', exact: true })).toBeVisible();
	await new QuickAccess(page).runCommand('workbench.action.openSettings');
	const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
	await settings.getByRole('button', { name: 'Agents', exact: true }).click();
	await settings.getByRole('tab', { name: 'Teams', exact: true }).click();
	await expect(settings.getByRole('button', { name: 'New Team', exact: true })).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(settings).toHaveCount(0);
	await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Chat / Agents', exact: true }).click();
	await more.click();
	const collab = page.getByRole('menuitemradio', { name: 'Collab', exact: true });
	const pin = page.getByRole('menuitem', { name: 'Pin Collab to Sidebar' });
	await collab.hover();
	const [collabBounds, pinBounds] = await Promise.all([collab.boundingBox(), pin.boundingBox()]);
	if (!collabBounds || !pinBounds) throw new Error('Expected Collab and its pin to be visible in More');
	expect(pinBounds.y).toBe(collabBounds.y);
	expect(pinBounds.x).toBeGreaterThanOrEqual(collabBounds.x + collabBounds.width);
	await pin.click();
	const pinnedCollab = page.locator('.ash-sessions-navigation').getByRole('button', { name: 'Collab', exact: true });
	await expect(pinnedCollab).toBeVisible();
	const unpin = page.getByRole('menuitem', { name: 'Unpin Collab from Sidebar' });
	await expect(unpin).toBeFocused();
	await unpin.press('Escape');
	await expect(more).toBeFocused();
	await pinnedCollab.click();
	await expect(page.locator('[data-view-container-id="ash.collaboration"]').getByRole('button', { name: 'Connect Channels', exact: true })).toBeVisible();
	await page.screenshot({ path: testInfo.outputPath('collaboration-window.png') });
	page = await workbench.reopenAgentsWindow(application, page);
	await expect(page.locator('.ash-sessions-navigation').getByRole('button', { name: 'Collab', exact: true })).toBeVisible();
	await expect(page.locator('[data-view-container-id="ash.collaboration"]').getByRole('button', { name: 'Connect Channels', exact: true })).toBeVisible();
});
