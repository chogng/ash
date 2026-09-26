import type { ElectronApplication, Locator } from '@playwright/test';
import { expect, test } from '../../../automation/test.js';

test.use({ openWorkspace: false });

test('macOS system menu receives workbench commands', async ({ target, application }) => {
	test.skip(target.kind !== 'electron' || process.platform !== 'darwin' || target.workbenchMode !== 'code', 'This scenario requires the macOS Code desktop product');
	const electron = application as ElectronApplication;

	await expect.poll(() => electron.evaluate(({ Menu }) => {
		const fileMenu = Menu.getApplicationMenu()?.items.find(item => item.label === 'File');
		return fileMenu?.submenu?.items.map(item => item.label);
	})).toContain('New Untitled Text Editor');
});

test('application menu trigger uses the titlebar action size', async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== 'code', 'This scenario requires the Code product');
	const page = workbench.page;
	const trigger = page.getByRole('toolbar', { name: 'Title bar left actions' }).getByRole('button', { name: 'Application menu' });
	const adjacentAction = page.locator('.ash-titlebar-left-actions [data-action-id="workbench.action.toggleSideBar"] .ash-button');
	const [triggerBounds, actionBounds] = await Promise.all([trigger.boundingBox(), adjacentAction.boundingBox()]);
	expect(triggerBounds).not.toBeNull();
	expect(actionBounds).not.toBeNull();
	expect({ width: triggerBounds!.width, height: triggerBounds!.height }).toEqual({
		width: actionBounds!.width,
		height: actionBounds!.height,
	});
	await trigger.hover();
	await expect(trigger).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
});

test('application menu switches its root submenus on pointer entry', async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== 'code', 'This scenario requires the Code product');
	test.skip(target.kind === 'electron' && process.platform === 'darwin', 'macOS uses the system menu');
	const page = workbench.page;
	const trigger = page.getByRole('toolbar', { name: 'Title bar left actions' }).getByRole('button', { name: 'Application menu' });
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

test('application menu keeps submenu arrows inside their menu rows', async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== 'code', 'This scenario requires the Code product');
	test.skip(target.kind === 'electron' && process.platform === 'darwin', 'macOS uses the system menu');
	const page = workbench.page;
	await page.getByRole('button', { name: 'Application menu' }).click();
	const mainMenu = page.getByRole('menu').first();
	const fileItem = mainMenu.getByRole('menuitem', { name: 'File' });
	await fileItem.hover();
	await expect(fileItem).toHaveAttribute('aria-expanded', 'true');
	const arrow = fileItem.locator('.ash-submenu-indicator > .ash-icon');
	const [itemBounds, arrowBounds] = await Promise.all([fileItem.boundingBox(), arrow.boundingBox()]);
	expect(itemBounds).not.toBeNull();
	expect(arrowBounds).not.toBeNull();
	expect(arrowBounds!.width).toBe(12);
	expect(itemBounds!.x + itemBounds!.width - arrowBounds!.x - arrowBounds!.width).toBeGreaterThanOrEqual(8);
});

test('application menu aligns command labels with and without icons', async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== 'code', 'This scenario requires the Code product');
	test.skip(target.kind === 'electron' && process.platform === 'darwin', 'macOS uses the system menu');
	const page = workbench.page;
	await page.getByRole('button', { name: 'Application menu' }).click();
	const fileItem = page.getByRole('menu').first().getByRole('menuitem', { name: 'File' });
	await fileItem.hover();
	await expect(fileItem).toHaveAttribute('aria-expanded', 'true');
	const fileMenu = page.getByRole('menu').last();
	await expect(fileMenu.locator('..')).toHaveCSS('border-radius', '8px');
	const iconLabel = fileMenu.getByRole('menuitem', { name: 'New Untitled Text Editor' }).locator('.ash-button-label');
	const plainLabel = fileMenu.getByRole('menuitem', { name: 'New File from Template' }).locator('.ash-button-label');
	const [iconBounds, plainBounds] = await Promise.all([iconLabel.boundingBox(), plainLabel.boundingBox()]);
	expect(iconBounds).not.toBeNull();
	expect(plainBounds).not.toBeNull();
	expect(Math.abs(iconBounds!.x - plainBounds!.x)).toBeLessThanOrEqual(1);
});

test('application menu shows clean labels and readable shortcuts', async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== 'code', 'This scenario requires the Code product');
	const page = workbench.page;
	await page.getByRole('button', { name: 'Application menu' }).click();
	const mainMenu = page.getByRole('menu').first();
	await mainMenu.getByRole('menuitem', { name: 'Selection' }).hover();
	const selectionMenu = page.getByRole('menu').last();
	const selectAll = selectionMenu.getByRole('menuitem', { name: 'Select All' });
	await expect(selectAll.locator('.ash-button-label')).toHaveText('Select All');
	const shortcut = selectAll.locator('.ash-menu-keybinding kbd');
	await expect(shortcut).toHaveText('Ctrl+A');
	expect(await shortcut.evaluate(element => ({
		fontFamily: getComputedStyle(element).fontFamily,
		fontSize: getComputedStyle(element).fontSize,
	}))).toEqual(
		await selectAll.evaluate(element => ({
			fontFamily: getComputedStyle(element).fontFamily,
			fontSize: getComputedStyle(element).fontSize,
		})),
	);
	await mainMenu.getByRole('menuitem', { name: 'File' }).hover();
	const fileMenu = page.getByRole('menu').last();
	const newEditor = fileMenu.getByRole('menuitem', { name: 'New Untitled Text Editor' });
	await expect(newEditor.locator('.ash-menu-keybinding kbd')).toHaveText('Ctrl+N');
	expect(await newEditor.locator('.ash-menu-keybinding kbd').evaluate(element => getComputedStyle(element).fontFamily)).toBe(
		await newEditor.evaluate(element => getComputedStyle(element).fontFamily),
	);
	await mainMenu.getByRole('menuitem', { name: 'Edit' }).hover();
	const editMenu = page.getByRole('menu').last();
	await expect(editMenu.getByRole('menuitem', { name: 'Undo' }).locator('.ash-button-label')).toHaveText('Undo');
	await expect(editMenu.getByRole('menuitem', { name: 'Redo' }).locator('.ash-button-label')).toHaveText('Redo');
});

test('checked View menu icons stay inside the leading slot', async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== 'code', 'This scenario requires the Code product');
	const page = workbench.page;
	const sidebarToggle = page.locator('.ash-titlebar-left-actions [data-action-id="workbench.action.toggleSideBar"] button');
	if (await sidebarToggle.getAttribute('aria-label') === 'Show Primary Side Bar') await sidebarToggle.click();
	await page.getByRole('button', { name: 'Application menu' }).click();
	const view = page.getByRole('menu').first().getByRole('menuitem', { name: 'View' });
	await view.hover();
	await expect(view).toHaveAttribute('aria-expanded', 'true');
	const viewMenu = page.getByRole('menu').last();
	for (const [actionId, checked, iconSelector] of [
		['workbench.action.toggleSideBar', 'true', '.ash-menu-leading-check > .ash-icon'],
		['workbench.action.toggleAuxiliaryBar', 'false', '.ash-menu-leading-check > .ash-icon-label-icon > .ash-icon'],
	] as const) {
		const item = viewMenu.locator(`[data-action-id="${actionId}"] button`);
		await expect(item).toHaveAttribute('aria-checked', checked);
		const slot = item.locator('.ash-menu-leading-slot');
		const icon = item.locator(iconSelector);
		const label = item.locator('.ash-button-label');
		const [slotBounds, iconBounds, labelBounds] = await Promise.all([
			slot.boundingBox(), icon.boundingBox(), label.boundingBox(),
		]);
		expect(slotBounds).not.toBeNull();
		expect(iconBounds).not.toBeNull();
		expect(labelBounds).not.toBeNull();
		expect(iconBounds!.x).toBeGreaterThanOrEqual(slotBounds!.x);
		expect(iconBounds!.x + iconBounds!.width).toBeLessThanOrEqual(slotBounds!.x + slotBounds!.width);
		expect(labelBounds!.x).toBeGreaterThanOrEqual(iconBounds!.x + iconBounds!.width + 4);
	}
});

test('application menu opens real commands and updates Go when an editor opens', async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== 'code', 'This scenario requires the Code product');
	test.skip(target.kind === 'electron' && process.platform === 'darwin', 'macOS uses the system menu');
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
	await expect(openFolder).toBeVisible();
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
