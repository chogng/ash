import { expect, test } from '../../../automation/test.js';

test('Agents window keeps a Team and fixed members after reload', async ({ application, target, workbench }) => {
	test.skip(target.workbenchMode !== 'code' || target.appServerMode !== 'required', 'Requires Code with App Server');
	let page = workbench.page;
	if (target.kind === 'browser') {
		await page.locator('[data-action-id="ash.code.open-sessions"] button').click();
	} else {
		if (!('windows' in application)) throw new Error('Expected Electron windows');
		const opened = application.waitForEvent('window');
		await page.locator("[data-action-id='workbench.action.chat.openAgentsWindow.titleBar'] button").click();
		page = await opened;
	}
	await page.getByRole('navigation', { name: 'Sidebar views' }).getByRole('button', { name: 'Teams' }).click();
	const panel = page.locator('.ash-teams-panel');
	await expect(panel).toBeVisible();
	await panel.getByRole('button', { name: 'New Team' }).click();
	for (const [title, value] of [
		['Team name', 'Feature Team'],
		['Team description', 'Build and review together'],
		['Lead name', 'Lead'],
		['Lead responsibility', 'Coordinate the work'],
	] as const) {
		const dialog = page.getByRole('dialog', { name: title });
		await expect(dialog).toBeVisible();
		await dialog.getByRole('textbox').fill(value);
		await dialog.getByRole('textbox').press('Enter');
	}
	await page.getByRole('dialog', { name: 'Choose Agent role' }).getByRole('combobox').press('Enter');
	await expect(panel.getByRole('button', { name: 'Feature Team · 1' })).toBeVisible();
	await panel.getByRole('button', { name: 'Add member' }).click();
	for (const [title, value] of [
		['Member name', 'Reviewer'],
		['Member responsibility', 'Review the change'],
	] as const) {
		const dialog = page.getByRole('dialog', { name: title });
		await expect(dialog).toBeVisible();
		await dialog.getByRole('textbox').fill(value);
		await dialog.getByRole('textbox').press('Enter');
	}
	await page.getByRole('dialog', { name: 'Choose Agent role' }).getByRole('combobox').press('Enter');
	await expect(panel.getByRole('button', { name: 'Feature Team · 2' })).toBeVisible();
	await expect(panel.getByText('Reviewer · Review the change')).toBeVisible();
	await page.reload();
	await page.getByRole('navigation', { name: 'Sidebar views' }).getByRole('button', { name: 'Teams' }).click();
	const restored = page.locator('.ash-teams-panel');
	await restored.getByRole('button', { name: 'Feature Team · 2' }).click();
	await expect(restored.getByText('Reviewer · Review the change')).toBeVisible();
	await restored.getByRole('button', { name: 'Start task' }).click();
	const taskDialog = page.getByRole('dialog', { name: 'Team task' });
	await taskDialog.getByRole('textbox').fill('Review task');
	await taskDialog.getByRole('textbox').press('Enter');
	await expect(restored.getByRole('button', { name: 'Review task' })).toBeVisible();
	await restored.getByRole('button', { name: 'Post message' }).click();
	const messageDialog = page.getByRole('dialog', { name: 'Team message' });
	await messageDialog.getByRole('textbox').fill('Keep the review findings');
	await messageDialog.getByRole('textbox').press('Enter');
	await expect(restored.getByText('Lead: Keep the review findings')).toBeVisible();
	await page.reload();
	await page.getByRole('navigation', { name: 'Sidebar views' }).getByRole('button', { name: 'Teams' }).click();
	await page.locator('.ash-teams-panel').getByRole('button', { name: 'Feature Team · 2' }).click();
	await expect(page.locator('.ash-teams-panel').getByRole('button', { name: 'Review task' })).toBeVisible();
	await expect(page.locator('.ash-teams-panel').getByText('Lead: Keep the review findings')).toBeVisible();
});
