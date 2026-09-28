import { expect, test } from '../../../automation/test.js';

test('Agents Collaboration page stays empty and separate from the Chat and Code switch', async ({ application, target, workbench }) => {
	test.skip(target.workbenchMode !== 'code', 'Requires Code Sessions');
	let page = workbench.page;
	if (target.kind === 'browser') {
		await page.locator('[data-action-id="ash.code.open-sessions"] button').click();
	} else {
		if (!('windows' in application)) throw new Error('Expected Electron windows');
		const opened = application.waitForEvent('window');
		await page.locator("[data-action-id='workbench.action.chat.openAgentsWindow.titleBar'] button").click();
		page = await opened;
	}
	const modeSwitch = page.getByRole('navigation', { name: 'Chat and Code' });
	await expect(modeSwitch.getByRole('button', { name: 'Chat' })).toHaveAttribute('aria-current', 'page');
	await page.getByRole('button', { name: 'Collaboration' }).click();
	await expect(page.locator('.ash-teams-panel')).toBeHidden();
	await expect(modeSwitch.getByRole('button', { name: 'Chat' })).toHaveAttribute('aria-current', 'page');
	await page.reload();
	await expect(page.locator('.ash-teams-panel')).toBeHidden();
});
