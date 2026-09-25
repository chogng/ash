import type { Locator } from '@playwright/test';
import { expect, test } from '../../../automation/test.js';

test.use({ openWorkspace: false });

test('application menu switches its root submenus on pointer entry', async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== 'code', 'This scenario requires the Code product');
	const page = workbench.page;
	const trigger = page.getByRole('toolbar', { name: 'Application menu' }).getByRole('button', { name: 'Application menu' });
	await trigger.click();
	const mainMenu = page.getByRole('menu').first();
	const fileMenuItem = mainMenu.getByRole('menuitem', { name: 'File' });
	const editMenuItem = mainMenu.getByRole('menuitem', { name: 'Edit' });

	await fileMenuItem.hover();
	await expect(fileMenuItem).toHaveAttribute('aria-expanded', 'true');
	await editMenuItem.hover();
	await expect(fileMenuItem).toHaveAttribute('aria-expanded', 'false');
	await expect(editMenuItem).toHaveAttribute('aria-expanded', 'true');
});

test('application menu opens real commands and updates Go when an editor opens', async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== 'code', 'This scenario requires the Code product');
	const page = workbench.page;
	const trigger = page.getByRole('button', { name: 'Application menu' });
	const hoverMenuItem = async (item: Locator) => {
		await item.hover();
		const bounds = await item.boundingBox();
		if (!bounds) throw new Error('Menu item disappeared while hovering');
		await page.mouse.move(bounds.x + bounds.width / 2 + 4, bounds.y + bounds.height / 2, { steps: 2 });
	};

	await trigger.click();
	const mainMenu = page.getByRole('menu').first();
	await expect(mainMenu.getByRole('menuitem')).toHaveText([
		'File', 'Edit', 'Selection', 'View', 'Go', 'Run', 'Terminal', 'Help',
	]);
	const goMenuItem = mainMenu.getByRole('menuitem', { name: 'Go', exact: true });
	await hoverMenuItem(goMenuItem);
	await expect(goMenuItem).toHaveAttribute('aria-expanded', 'true');
	await page.getByRole('menu').last().getByRole('menuitem', { name: 'Go to Symbol in Workspace' }).click();
	const symbolQuery = page.locator('.ash-quick-pick-input input');
	await expect(symbolQuery).toBeFocused();
	await expect(symbolQuery).toHaveValue('@');
	await symbolQuery.press('Escape');

	await trigger.click();
	const fileMenuItem = mainMenu.getByRole('menuitem', { name: 'File' });
	const viewMenuItem = mainMenu.getByRole('menuitem', { name: 'View' });
	await hoverMenuItem(fileMenuItem);
	await expect(fileMenuItem).toHaveAttribute('aria-expanded', 'true');
	await hoverMenuItem(viewMenuItem);
	await expect(viewMenuItem).toHaveAttribute('aria-expanded', 'true');
	await expect(fileMenuItem).toHaveAttribute('aria-expanded', 'false');
	await page.keyboard.press('Escape');
	await expect(viewMenuItem).toHaveAttribute('aria-expanded', 'false');
	await expect(viewMenuItem).toBeFocused();
	await hoverMenuItem(fileMenuItem);
	await expect(fileMenuItem).toHaveAttribute('aria-expanded', 'true');
	await expect(viewMenuItem).toHaveAttribute('aria-expanded', 'false');
	await mainMenu.getByRole('menuitem', { name: 'Edit' }).hover();
	await expect(fileMenuItem).toHaveAttribute('aria-expanded', 'false');
	await hoverMenuItem(fileMenuItem);
	await expect(fileMenuItem).toHaveAttribute('aria-expanded', 'true');
	await fileMenuItem.click();
	await expect(fileMenuItem).toHaveAttribute('aria-expanded', 'true');
	const fileMenu = page.getByRole('menu').last();
	const openFolder = fileMenu.getByRole('menuitem', { name: 'Open Folder...' });
	if (target.kind === 'electron' || target.appServerMode === 'required') {
		await expect(openFolder).toBeVisible();
	} else {
		await expect(openFolder).toHaveCount(0);
	}
	await expect(fileMenu.getByRole('menuitem', { name: 'Ash Settings' })).toBeVisible();
	const newEditorItem = fileMenu.getByRole('menuitem', { name: 'New Untitled Text Editor' });
	await newEditorItem.hover();
	await expect(fileMenuItem).toHaveAttribute('aria-expanded', 'true');
	await newEditorItem.click();

	await expect(page.getByText('Untitled-1', { exact: true }).first()).toBeVisible();
	await trigger.focus();
	await trigger.press('ArrowDown');
	await expect(goMenuItem).toBeVisible();
	await goMenuItem.focus();
	await goMenuItem.press('ArrowRight');
	await page.getByRole('menu').last().getByRole('menuitem', { name: 'Go to Line/Column...' }).click();
	await expect(page.getByRole('dialog', { name: 'Go to Line or Column' })).toBeVisible();
	await page.keyboard.press('Escape');

	await trigger.click();
	await hoverMenuItem(mainMenu.getByRole('menuitem', { name: 'Terminal' }));
	await page.getByRole('menu').last().getByRole('menuitem', { name: 'Focus Terminal' }).click();
	await expect(page.locator('.ash-terminal-view')).toBeVisible();
});
