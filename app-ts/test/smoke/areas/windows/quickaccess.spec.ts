import { expect, test } from '../../../automation/test.js';

test.use({ openWorkspace: false });

test.beforeEach(async ({  }) => {
});

test('Quick Access runs an exact command ID and can reopen for another command', async ({ workbench }) => {
	const quickaccess = workbench.quickaccess;
	const tabs = workbench.editors.groupAt(0).tabs;

	await quickaccess.runCommand('workbench.action.files.newUntitledFile');
	await expect(tabs.filter({ hasText: 'Untitled-1' })).toHaveAttribute('aria-selected', 'true');
	await quickaccess.runCommand('workbench.action.files.newUntitledFile');
	await expect(tabs.filter({ hasText: 'Untitled-2' })).toHaveAttribute('aria-selected', 'true');
	await expect(tabs.filter({ hasText: /Untitled-[12]/u })).toHaveCount(2);
	await expect(quickaccess.element).toHaveCount(0);
});

test('Quick Access hands off to the picker opened by a command', async ({ workbench }) => {
	const quickaccess = workbench.quickaccess;
	await quickaccess.runCommand('workbench.action.selectTheme');
	await expect(quickaccess.input).toBeFocused();
	await expect(quickaccess.input).toHaveAttribute('placeholder', 'Color Theme');
	await quickaccess.select('Ash High Contrast Dark');
	await expect(quickaccess.element).toHaveCount(0);
	await expect(workbench.page.locator('#app')).toHaveAttribute('data-color-theme', 'ash-high-contrast-dark');
});

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
	await expect(workbench.editors.groupAt(0).tabs.filter({ hasText: 'Untitled-1' })).toHaveAttribute('aria-selected', 'true');
});

test('Quick Access cancellation restores focus without running the filtered command', async ({ workbench }) => {
	const quickaccess = workbench.quickaccess;
	const search = workbench.page.getByRole('button', { name: 'Search commands', exact: true });
	await search.focus();
	await quickaccess.open('workbench.action.files.newUntitledFile');
	await expect(quickaccess.items).toHaveCount(1);
	await quickaccess.close();

	await expect(quickaccess.element).toHaveCount(0);
	await expect(search).toBeFocused();
	await expect(workbench.editors.groupAt(0).tabs.filter({ hasText: /Untitled-/u })).toHaveCount(0);
});

test('Quick Access help switches to commands within the same picker', async ({ workbench }) => {
	const quickaccess = workbench.quickaccess;
	await quickaccess.open('?');
	await expect(quickaccess.input).toHaveAttribute('placeholder', 'Select a search mode');
	const listId = await quickaccess.input.getAttribute('aria-controls');
	await quickaccess.select('> Commands');

	await expect(quickaccess.element).toHaveCount(1);
	await expect(quickaccess.input).toHaveValue('>');
	await expect(quickaccess.input).toHaveAttribute('placeholder', 'Type the name of a command to run');
	await expect(quickaccess.input).toHaveAttribute('aria-controls', listId!);
	await quickaccess.search('>workbench.action.files.newUntitledFile');
	await quickaccess.select('New Untitled Text Editor');
	await expect(quickaccess.element).toHaveCount(0);
	await expect(workbench.editors.groupAt(0).tabs.filter({ hasText: 'Untitled-1' })).toHaveAttribute('aria-selected', 'true');
});
