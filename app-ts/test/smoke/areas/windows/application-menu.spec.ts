import type { ElectronApplication, Locator } from '@playwright/test';
import type { BrowserWindow, MessageBoxOptions } from 'electron';
import { readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '../../../automation/test.js';

test.use({ openWorkspace: false });

test('File menu keeps close commands visible and closes single and all editors', async ({ target, application, workbench }) => {
	test.skip(target.workbenchMode !== 'code', 'This scenario requires the Code product');
	const page = workbench.page;
	const systemMenu = target.kind === 'electron' && process.platform === 'darwin';
	const electron = application as ElectronApplication;
	const closeLabels = ['Close All Editors', 'Close Editor'];
	const openFileMenu = async () => {
		await page.getByRole('button', { name: 'Application menu' }).click();
		await page.getByRole('menu').first().getByRole('menuitem', { name: 'File', exact: true }).click();
		return page.getByRole('menu').last();
	};
	const readCloseItems = async () => {
		if (systemMenu) {
			return electron.evaluate(({ Menu }, labels) => Menu.getApplicationMenu()?.items.find(item => item.label === 'File')?.submenu?.items
				.filter(item => labels.includes(item.label)).map(item => ({ label: item.label, enabled: item.enabled })), closeLabels);
		}
		const menu = await openFileMenu();
		const items = await Promise.all(closeLabels.map(async label => ({ label, enabled: await menu.getByRole('menuitem', { name: label, exact: true }).isEnabled() })));
		await page.keyboard.press('Escape');
		await page.keyboard.press('Escape');
		return items;
	};
	const runMenuCommand = async (label: string) => {
		if (systemMenu) {
			await electron.evaluate(({ Menu }, label) => {
				const item = Menu.getApplicationMenu()?.items.find(item => item.label === 'File')?.submenu?.items.find(item => item.label === label);
				if (!item?.enabled) throw new Error(`File menu command is unavailable: ${label}`);
				item.click({ altKey: false });
			}, label);
		} else {
			await (await openFileMenu()).getByRole('menuitem', { name: label, exact: true }).click();
		}
	};
	const tabs = workbench.editors.element.getByRole('tab');
	await expect(tabs).toHaveText(['Welcome']);
	if (await tabs.count() > 0) {
		await runMenuCommand('Close All Editors');
	}
	await expect(tabs).toHaveCount(0);
	await expect.poll(readCloseItems).toEqual(closeLabels.map(label => ({ label, enabled: false })));
	await runMenuCommand('New Untitled Text Editor');
	await runMenuCommand('New Untitled Text Editor');
	await expect(tabs).toHaveCount(2);
	await expect.poll(readCloseItems).toEqual(closeLabels.map(label => ({ label, enabled: true })));
	await runMenuCommand('Close Editor');
	await expect(tabs).toHaveCount(1);
	await runMenuCommand('Close All Editors');
	await expect(tabs).toHaveCount(0);
	await expect.poll(readCloseItems).toEqual(closeLabels.map(label => ({ label, enabled: false })));
});

test.describe('File menu closes the workspace', () => {
	test.use({ openWorkspace: true });

	test('Close Folder returns the current window to an empty workspace', async ({ target, application, workbench }) => {
		test.skip(target.workbenchMode !== 'code', 'This scenario requires the Code product');
		test.skip(target.kind === 'browser' && target.appServerMode !== 'disabled', 'The server browser requires an authorized folder');
		const page = workbench.page;
		const originalRenderer = await page.evaluate(() => performance.timeOrigin);
		const originalWindow = target.kind === 'electron' ? await (application as ElectronApplication).evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.id) : undefined;
		if (target.kind === 'browser') {
			await page.evaluate(async () => {
				const root = await navigator.storage.getDirectory();
				const folder = await root.getDirectoryHandle(`ash-close-${crypto.randomUUID()}`, { create: true });
				Object.defineProperty(window, 'showDirectoryPicker', { configurable: true, value: async () => folder });
			});
			await page.keyboard.press('F1');
			await page.locator('.ash-quick-pick').getByRole('combobox').fill('Open Folder');
			await page.keyboard.press('Enter');
		}
		await workbench.quickaccess.runCommand('workbench.action.files.newUntitledFile');
		await expect(workbench.editors.element.getByRole('tab', { name: /Untitled-1/ })).toBeVisible();
		const input = workbench.editors.groupAt(0).content.locator('.stanza-editor-input');
		await input.focus();
		await input.type('unsaved draft');
		const electron = application as ElectronApplication;

		if (target.kind === 'electron') {
			await electron.evaluate(({ dialog }) => {
				const original = dialog.showMessageBox.bind(dialog);
				const state = globalThis as typeof globalThis & { ashCloseFolderDialog?: { count: number; restore: () => void } };
				state.ashCloseFolderDialog = { count: 0, restore: () => { dialog.showMessageBox = original; } };
				dialog.showMessageBox = ((...args: [MessageBoxOptions] | [BrowserWindow, MessageBoxOptions]) => {
					const options = args.length === 1 ? args[0] : args[1];
					if (!options.buttons?.includes("Don't Save")) return args.length === 1 ? original(args[0]) : original(args[0], args[1]);
					const label = state.ashCloseFolderDialog!.count++ === 0 ? 'Cancel' : "Don't Save";
					return Promise.resolve({ response: options.buttons.indexOf(label), checkboxChecked: false });
				}) as typeof dialog.showMessageBox;
			});
		}
		const closeFolder = async () => {
			if (target.kind === 'electron' && process.platform === 'darwin') {
				await expect.poll(() => electron.evaluate(({ Menu }) => Menu.getApplicationMenu()?.items.find(item => item.label === 'File')?.submenu?.items.find(item => item.label === 'Close Folder')?.enabled)).toBe(true);
				await electron.evaluate(({ Menu }) => Menu.getApplicationMenu()!.items.find(item => item.label === 'File')!.submenu!.items.find(item => item.label === 'Close Folder')!.click({ altKey: false }));
			} else {
				await page.getByRole('button', { name: 'Application menu' }).click();
				await page.getByRole('menu').first().getByRole('menuitem', { name: 'File', exact: true }).click();
				await page.getByRole('menu').last().getByRole('menuitem', { name: 'Close Folder', exact: true }).click();
			}
		};
		try {
			await closeFolder();
			if (target.kind === 'electron') {
				await expect.poll(() => electron.evaluate(() => (globalThis as typeof globalThis & { ashCloseFolderDialog?: { count: number } }).ashCloseFolderDialog?.count)).toBe(1);
			} else {
				await page.getByRole('dialog', { name: 'Save Changes' }).getByRole('button', { name: 'Cancel', exact: true }).click();
			}
			await expect(workbench.editors.groupAt(0).content.locator('.stanza-editor-line-text').first()).toContainText('unsaved draft');
			await expect(workbench.editors.element.getByRole('tab', { name: /Untitled-1/ })).toBeVisible();
			expect(await page.evaluate(() => performance.timeOrigin)).toBe(originalRenderer);
			await closeFolder();
			if (target.kind === 'browser') {
				await page.getByRole('dialog', { name: 'Save Changes' }).getByRole('button', { name: "Don't Save", exact: true }).click();
			}
			await expect(workbench.editors.element.getByRole('tab')).toHaveText(['Welcome']);
			await expect.poll(() => page.evaluate(() => performance.timeOrigin)).not.toBe(originalRenderer);
		} finally {
			if (target.kind === 'electron') {
				await electron.evaluate(() => (globalThis as typeof globalThis & { ashCloseFolderDialog?: { restore: () => void } }).ashCloseFolderDialog?.restore());
			}
		}
		const showSidebar = page.getByRole('button', { name: 'Show Primary Side Bar', exact: true });
		if (await showSidebar.isVisible()) await showSidebar.click();
		await expect(page.getByRole('button', { name: 'Open Folder', exact: true })).toBeVisible();
		if (target.kind === 'electron') {
			expect((application as ElectronApplication).windows()).toHaveLength(1);
			expect(await (application as ElectronApplication).evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.id)).toBe(originalWindow);
			const context = await page.evaluate(() => (globalThis as unknown as { ash: { ipcRenderer: { invoke(channel: string): Promise<{ folders: unknown[] }> } } }).ash.ipcRenderer.invoke('ash:workspace:context:read'));
			expect(context.folders).toEqual([]);
		}
	});

	test('Close Folder saves the draft before loading the empty workspace', async ({ target, application, testWorkspace, workbench }) => {
		test.skip(target.kind !== 'electron' || target.appServerMode !== 'required', 'This scenario saves through the desktop App Server');
		const page = workbench.page;
		const destination = join(await realpath(testWorkspace.directory), 'saved-before-close.txt');
		const electron = application as ElectronApplication;
		await electron.evaluate(({ dialog }, destination) => {
			const originalMessage = dialog.showMessageBox.bind(dialog);
			const originalSave = dialog.showSaveDialog.bind(dialog);
			const state = globalThis as typeof globalThis & { ashRestoreCloseDialogs?: () => void };
			state.ashRestoreCloseDialogs = () => { dialog.showMessageBox = originalMessage; dialog.showSaveDialog = originalSave; };
			dialog.showMessageBox = ((...args: [MessageBoxOptions] | [BrowserWindow, MessageBoxOptions]) => {
				const options = args.length === 1 ? args[0] : args[1];
				if (!options.buttons?.includes("Don't Save")) return args.length === 1 ? originalMessage(args[0]) : originalMessage(args[0], args[1]);
				return Promise.resolve({ response: options.buttons.indexOf('Save'), checkboxChecked: false });
			}) as typeof dialog.showMessageBox;
			dialog.showSaveDialog = (async () => ({ canceled: false, filePath: destination })) as typeof dialog.showSaveDialog;
		}, destination);
		try {
			await workbench.quickaccess.runCommand('workbench.action.files.newUntitledFile');
			const input = workbench.editors.groupAt(0).content.locator('.stanza-editor-input');
			await input.focus();
			await input.type('saved through workspace shutdown');
			if (process.platform === 'darwin') {
				await electron.evaluate(({ Menu }) => Menu.getApplicationMenu()!.items.find(item => item.label === 'File')!.submenu!.items.find(item => item.label === 'Close Folder')!.click({ altKey: false }));
			} else {
				await page.getByRole('button', { name: 'Application menu' }).click();
				await page.getByRole('menu').first().getByRole('menuitem', { name: 'File', exact: true }).click();
				await page.getByRole('menu').last().getByRole('menuitem', { name: 'Close Folder', exact: true }).click();
			}
			await expect(workbench.editors.element.getByRole('tab')).toHaveText(['Welcome']);
			expect(await readFile(destination, 'utf8')).toBe('saved through workspace shutdown');
		} finally {
			await electron.evaluate(() => (globalThis as typeof globalThis & { ashRestoreCloseDialogs?: () => void }).ashRestoreCloseDialogs?.());
		}
	});
});

test('macOS system menu receives workbench commands', async ({ target, application }) => {
	test.skip(target.kind !== 'electron' || process.platform !== 'darwin' || target.workbenchMode !== 'code', 'This scenario requires the macOS Code desktop product');
	const electron = application as ElectronApplication;

	await expect.poll(() => electron.evaluate(({ Menu }) => {
		const fileMenu = Menu.getApplicationMenu()?.items.find(item => item.label === 'File');
		return fileMenu?.submenu?.items.map(item => item.label);
	})).toContain('New Untitled Text Editor');
});

test('macOS keeps the sidebar action and omits the duplicate application menu', async ({ target, workbench }) => {
	test.skip(target.kind !== 'electron' || process.platform !== 'darwin' || target.workbenchMode !== 'code', 'This scenario requires the macOS Code desktop product');
	const toolbar = workbench.page.getByRole('toolbar', { name: 'Title bar left actions' });
	await expect(toolbar.getByRole('button', { name: 'Application menu' })).toHaveCount(0);
	const sidebarToggle = toolbar.locator('[data-action-id="workbench.action.toggleSideBar"] button');
	await expect(sidebarToggle).toBeVisible();
	await expect(toolbar.locator('.ash-action-view-item').first()).toHaveAttribute('data-action-id', 'workbench.action.toggleSideBar');
	const sidebar = workbench.page.locator('[data-part="sidebar"]');
	const wasVisible = await sidebar.isVisible();
	await sidebarToggle.click();
	await expect(sidebar).toBeVisible({ visible: !wasVisible });
});

test('application menu trigger uses the titlebar action size', async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== 'code', 'This scenario requires the Code product');
	test.skip(target.kind === 'electron' && process.platform === 'darwin', 'macOS uses the system menu');
	const page = workbench.page;
	const trigger = page.getByRole('toolbar', { name: 'Title bar left actions' }).getByRole('button', { name: 'Application menu' });
	await expect(trigger).toHaveCount(1);
	await expect(trigger).toHaveAccessibleName('Application menu');
	await expect(trigger.locator('.ash-icon')).toBeVisible();
	await expect(trigger.locator('.ash-button-label')).toBeHidden();
	await expect(trigger).toHaveCSS('width', '22px');
	await expect(trigger).toHaveCSS('height', '22px');
	await expect(page.getByRole('toolbar', { name: 'Title bar left actions' }).getByRole('menubar')).toHaveCount(0);
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

test('macOS menu style switches context menus without a titlebar menu button', async ({ target, application, workbench }) => {
	test.skip(target.kind !== 'electron' || process.platform !== 'darwin' || target.workbenchMode !== 'code', 'This scenario requires the macOS Code desktop');
	const page = workbench.page;
	await page.keyboard.press('ControlOrMeta+Shift+P');
	await page.getByPlaceholder('Type the name of a command to run').fill('Ash Settings');
	await page.keyboard.press('Enter');
	await page.locator('[data-settings-group-id="workbench"]').click();
	await page.locator('[data-settings-category-id="layout"]').click();
	const menuStyle = page.locator('[data-configuration-key="window.menuStyle"]').getByRole('combobox');
	await menuStyle.click();
	await page.getByRole('option', { name: 'Custom' }).click();
	await page.getByRole('button', { name: 'Close Ash Settings' }).click();

	const search = page.locator('[data-part="activitybar"]').getByRole('tab', { name: 'Search' });
	await search.click({ button: 'right' });
	await expect(page.getByRole('menu').last()).toBeVisible();
	await page.keyboard.press('Escape');

	await page.keyboard.press('ControlOrMeta+Shift+P');
	await page.getByPlaceholder('Type the name of a command to run').fill('Ash Settings');
	await page.keyboard.press('Enter');
	await page.locator('[data-settings-group-id="workbench"]').click();
	await page.locator('[data-settings-category-id="layout"]').click();
	await menuStyle.click();
	await page.getByRole('option', { name: 'System' }).click();
	await page.getByRole('button', { name: 'Close Ash Settings' }).click();

	const electron = application as ElectronApplication;
	await electron.evaluate(({ Menu }) => {
		const originalPopup = Menu.prototype.popup;
		const state = globalThis as typeof globalThis & { ashMenuStyleTest?: { count: number; restore: () => void } };
		state.ashMenuStyleTest = { count: 0, restore: () => { Menu.prototype.popup = originalPopup; } };
		Menu.prototype.popup = function(options) {
			state.ashMenuStyleTest!.count++;
			options?.callback?.();
		};
	});
	try {
		await search.click({ button: 'right' });
		await expect.poll(() => electron.evaluate(() => (globalThis as typeof globalThis & { ashMenuStyleTest?: { count: number } }).ashMenuStyleTest?.count)).toBe(1);
		await expect(page.getByRole('toolbar', { name: 'Title bar left actions' }).getByRole('button', { name: 'Application menu' })).toHaveCount(0);
		await expect(page.locator('.ash-titlebar-left-actions [data-action-id="workbench.action.toggleSideBar"] button')).toBeVisible();
	} finally {
		await electron.evaluate(({ Menu }) => {
			const state = (globalThis as typeof globalThis & { ashMenuStyleTest?: { restore: () => void } }).ashMenuStyleTest;
			state?.restore();
		});
	}
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
	test.skip(target.kind === 'electron' && process.platform === 'darwin', 'macOS uses the system menu');
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
	test.skip(target.kind === 'electron' && process.platform === 'darwin', 'macOS uses the system menu');
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
