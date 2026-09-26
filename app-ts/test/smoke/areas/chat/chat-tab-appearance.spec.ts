import { expect, test } from '../../../automation/test.js';

test('selected Chat tab uses the tab surface instead of list selection blue', async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== 'code' || target.appServerMode !== 'disabled', 'Uses the disconnected Chat shell.');
	const page = workbench.page;
	if (!await page.locator('.ash-chat-view-pane').isVisible()) {
		await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	}
	const selected = page.locator('.ash-multi-chat-tabs-control .ash-tab.checked');
	await expect(selected.getByRole('tab')).toHaveAttribute('aria-selected', 'true');
	const colors = await selected.evaluate(element => {
		const reference = document.createElement('span');
		reference.style.background = 'var(--ash-tab-list-active-background)';
		element.append(reference);
		const active = getComputedStyle(reference).backgroundColor;
		reference.style.background = 'var(--ash-list-active-selection-background)';
		const listSelection = getComputedStyle(reference).backgroundColor;
		reference.remove();
		return { tab: getComputedStyle(element).backgroundColor, active, listSelection };
	});
	expect(colors.tab).toBe(colors.active);
	expect(colors.tab).not.toBe(colors.listSelection);
});
