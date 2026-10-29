import { expect, test } from '../../../automation/test.js';

test.use({ openWorkspace: false });

test('Quick Access keeps an empty search open and accepts a matching command with Enter', async ({ workbench }) => {
	const quickaccess = workbench.quickaccess;
	await quickaccess.open('>no-such-command-quickaccess');
	await expect(quickaccess.items).toHaveCount(0);
	await expect(quickaccess.element.getByRole('status')).toHaveText('No matching results');
	await quickaccess.input.press('Enter');
	await expect(quickaccess.input).toBeFocused();
	await expect(workbench.editors.groupAt(0).tabs.filter({ hasText: /Untitled-/u })).toHaveCount(0);

	await quickaccess.search('>workbench.action.files.newUntitledFile');
	await expect(quickaccess.items).toHaveCount(1);
	await expect(quickaccess.items).toContainText('New Untitled Text Editor');
	await quickaccess.input.press('Enter');
	await expect(quickaccess.element).toHaveCount(0);
	await expect(workbench.editors.groupAt(0).tabs.filter({ hasText: 'Untitled-1' })).toHaveAttribute(
		'aria-selected',
		'true',
	);
});

test('Quick Access opens from its title button and cancellation restores focus without running the command', async ({
	workbench,
}) => {
	const quickaccess = workbench.quickaccess;
	const search = workbench.page.getByRole('button', { name: 'Search commands', exact: true });
	await search.click();
	await expect(quickaccess.input).toBeFocused();
	await quickaccess.search('>workbench.action.files.newUntitledFile');
	await expect(quickaccess.items).toHaveCount(1);
	await quickaccess.close();

	await expect(quickaccess.element).toHaveCount(0);
	await expect(search).toBeFocused();
	await expect(workbench.editors.groupAt(0).tabs.filter({ hasText: /Untitled-/u })).toHaveCount(0);
});
