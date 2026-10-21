import type { ElectronApplication, Locator } from '@playwright/test';
import { readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '../../../automation/test.js';

test.use({ openWorkspace: false });

test('File menu keeps close commands visible and closes single and all editors', async ({ target, application, workbench }) => {
	const page = workbench.page;
	const systemMenu = target.kind === 'electron' && process.platform === 'darwin';
	const electron = application as ElectronApplication;
	const closeLabels = ['Close All Tabs', 'Close'];
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
		await runMenuCommand('Close All Tabs');
	}
	await expect(tabs).toHaveCount(0);
	await expect.poll(readCloseItems).toEqual(closeLabels.map(label => ({ label, enabled: false })));
	await runMenuCommand('New Untitled Text Editor');
	await expect(tabs).toHaveCount(1);
	await runMenuCommand('New Untitled Text Editor');
	await expect(tabs).toHaveCount(2);
	await expect.poll(readCloseItems).toEqual(closeLabels.map(label => ({ label, enabled: true })));
	await runMenuCommand('Close');
	await expect(tabs).toHaveCount(1);
	await runMenuCommand('Close All Tabs');
	await expect(tabs).toHaveCount(0);
	await expect.poll(readCloseItems).toEqual(closeLabels.map(label => ({ label, enabled: false })));
});

test.describe('File menu closes the workspace', () => {
	test.use({ openWorkspace: true });

	test('Close Folder returns the current window to an empty workspace', { tag: ['@browser-ui', '@electron-ui', '@electron-app-server'] }, async ({ target, application, workbench }) => {
		const page = workbench.page;
		const originalRenderer = await page.evaluate(() => performance.timeOrigin);
		const originalWindow = target.kind === 'electron' ? await (application as ElectronApplication).evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.id) : undefined;
		if (target.kind === 'browser') {
			await page.evaluate(async () => {
				const root = await navigator.storage.getDirectory();
				const folder = await root.getDirectoryHandle(`ash-close-${crypto.randomUUID()}`, { create: true });
				Object.defineProperty(window, 'showDirectoryPicker', { configurable: true, value: async () => folder });
			});
			await workbench.quickaccess.runCommand('workbench.action.files.openFolderViaWorkspace');
		}
		if (target.kind === 'browser') await expect(page.locator('.ash-explorer')).toBeVisible();
		await workbench.quickaccess.runCommand('workbench.action.files.newUntitledFile');
		await expect(workbench.editors.element.getByRole('tab', { name: /Untitled-1/ })).toBeVisible();
		const input = workbench.editors.groupAt(0).content.locator('.stanza-editor-input');
		await input.focus();
		await input.type('unsaved draft');
		const electron = application as ElectronApplication;

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
		await workbench.dialogs.confirm(application, 'Save Changes', 'Cancel', closeFolder);
		await expect(workbench.editors.groupAt(0).content.locator('.stanza-editor-line-text').first()).toContainText('unsaved draft');
		await expect(workbench.editors.element.getByRole('tab', { name: /Untitled-1/ })).toBeVisible();
		expect(await page.evaluate(() => performance.timeOrigin)).toBe(originalRenderer);
		await workbench.dialogs.confirm(application, 'Save Changes', "Don't Save", closeFolder);
		await expect(workbench.editors.element.getByRole('tab')).toHaveText(['Welcome']);
		await expect.poll(() => page.evaluate(() => performance.timeOrigin)).not.toBe(originalRenderer);
		const showSidebar = page.getByRole('button', { name: 'Show Primary Side Bar', exact: true });
		if (await showSidebar.isVisible()) await showSidebar.click();
		await expect(page.getByRole('button', { name: 'Open Folder', exact: true })).toBeVisible();
		if (target.kind === 'electron') {
			expect((application as ElectronApplication).windows()).toHaveLength(1);
			expect(await (application as ElectronApplication).evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.id)).toBe(originalWindow);
			const context = await page.evaluate(() => (globalThis as unknown as { ash: { ipcRenderer: { invoke(channel: string): Promise<{ folders: unknown[]; }>; }; }; }).ash.ipcRenderer.invoke('ash:workspace:context:read'));
			expect(context.folders).toEqual([]);
		}
	});

	test('Close Folder saves the draft before loading the empty workspace', { tag: ['@electron-app-server'] }, async ({ target, application, testWorkspace, workbench }) => {
		const page = workbench.page;
		const destination = join(await realpath(testWorkspace.directory), 'saved-before-close.txt');
		const electron = application as ElectronApplication;
		await electron.evaluate(({ dialog }, destination) => {
			const originalSave = dialog.showSaveDialog.bind(dialog);
			const state = globalThis as typeof globalThis & { ashRestoreCloseDialogs?: () => void; };
			state.ashRestoreCloseDialogs = () => { dialog.showSaveDialog = originalSave; delete state.ashRestoreCloseDialogs; };

			dialog.showSaveDialog = (async () => ({ canceled: false, filePath: destination })) as typeof dialog.showSaveDialog;
		}, destination);
		try {
			await workbench.quickaccess.runCommand('workbench.action.files.newUntitledFile');
			const input = workbench.editors.groupAt(0).content.locator('.stanza-editor-input');
			await input.focus();
			await input.type('saved through workspace shutdown');
			await workbench.dialogs.confirm(application, 'Save Changes', 'Save', async () => {
				if (process.platform === 'darwin') {
					await electron.evaluate(({ Menu }) => Menu.getApplicationMenu()!.items.find(item => item.label === 'File')!.submenu!.items.find(item => item.label === 'Close Folder')!.click({ altKey: false }));
				} else {
					await page.getByRole('button', { name: 'Application menu' }).click();
					await page.getByRole('menu').first().getByRole('menuitem', { name: 'File', exact: true }).click();
					await page.getByRole('menu').last().getByRole('menuitem', { name: 'Close Folder', exact: true }).click();
				}
			});
			await expect(workbench.editors.element.getByRole('tab')).toHaveText(['Welcome']);
			expect(await readFile(destination, 'utf8')).toBe('saved through workspace shutdown');
		} finally {
			await electron.evaluate(() => (globalThis as typeof globalThis & { ashRestoreCloseDialogs?: () => void; }).ashRestoreCloseDialogs?.());
		}
	});
});

test('macOS system menu receives workbench commands', { tag: ['@electron-ui', '@electron-app-server', '@darwin'] }, async ({ target, application }) => {
	const electron = application as ElectronApplication;

	await expect.poll(() => electron.evaluate(({ Menu }) => {
		const fileMenu = Menu.getApplicationMenu()?.items.find(item => item.label === 'File');
		return fileMenu?.submenu?.items.map(item => item.label);
	})).toContain('New Untitled Text Editor');
});

test('macOS keeps the sidebar action and omits the duplicate application menu', { tag: ['@electron-ui', '@electron-app-server', '@darwin'] }, async ({ target, workbench }) => {
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

test('macOS menu style switches context menus without a titlebar menu button', { tag: ['@electron-ui', '@electron-app-server', '@darwin'] }, async ({ target, application, workbench }) => {
	const page = workbench.page;
	await workbench.settingsEditor.openUserSettingsUI();
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

	await workbench.settingsEditor.openUserSettingsUI();
	await page.locator('[data-settings-group-id="workbench"]').click();
	await page.locator('[data-settings-category-id="layout"]').click();
	await menuStyle.click();
	await page.getByRole('option', { name: 'System' }).click();
	await page.getByRole('button', { name: 'Close Ash Settings' }).click();

	const electron = application as ElectronApplication;
	await electron.evaluate(({ Menu }) => {
		const originalPopup = Menu.prototype.popup;
		const state = globalThis as typeof globalThis & { ashMenuStyleTest?: { count: number; restore: () => void; }; };
		state.ashMenuStyleTest = { count: 0, restore: () => { Menu.prototype.popup = originalPopup; } };
		Menu.prototype.popup = function (options) {
			state.ashMenuStyleTest!.count++;
			options?.callback?.();
		};
	});
	try {
		await search.click({ button: 'right' });
		await expect.poll(() => electron.evaluate(() => (globalThis as typeof globalThis & { ashMenuStyleTest?: { count: number; }; }).ashMenuStyleTest?.count)).toBe(1);
		await expect(page.getByRole('toolbar', { name: 'Title bar left actions' }).getByRole('button', { name: 'Application menu' })).toHaveCount(0);
		await expect(page.locator('.ash-titlebar-left-actions [data-action-id="workbench.action.toggleSideBar"] button')).toBeVisible();
	} finally {
		await electron.evaluate(({ Menu }) => {
			const state = (globalThis as typeof globalThis & { ashMenuStyleTest?: { restore: () => void; }; }).ashMenuStyleTest;
			state?.restore();
		});
	}
});

test('View menu reflects actual sidebar visibility', { tag: process.platform === 'darwin' ? ['@browser-ui', '@browser-app-server'] : ['@browser-ui', '@browser-app-server', '@electron-ui', '@electron-app-server'] }, async ({ target, workbench }) => {
	const page = workbench.page;
	const sidebarToggle = page.locator('.ash-titlebar-left-actions [data-action-id="workbench.action.toggleSideBar"] button');
	if (await sidebarToggle.getAttribute('aria-label') === 'Show Primary Side Bar') await sidebarToggle.click();
	const hideAuxiliary = page.getByRole('button', { name: 'Hide Secondary Side Bar', exact: true });
	if (await hideAuxiliary.isVisible()) await hideAuxiliary.click();
	await page.getByRole('button', { name: 'Application menu' }).click();
	const view = page.getByRole('menu').first().getByRole('menuitem', { name: 'View' });
	await view.hover();
	await expect(view).toHaveAttribute('aria-expanded', 'true');
	const viewMenu = page.getByRole('menu').last();
	for (const [actionId, checked] of [
		['workbench.action.toggleSideBar', 'true'],
		['workbench.action.toggleAuxiliaryBar', 'false'],
	] as const) {
		const item = viewMenu.locator(`[data-action-id="${actionId}"] button`);
		await expect(item).toHaveAttribute('aria-checked', checked);
	}
});

test('application menu opens real commands and updates Go when an editor opens', { tag: process.platform === 'darwin' ? ['@browser-ui', '@browser-app-server'] : ['@browser-ui', '@browser-app-server', '@electron-ui', '@electron-app-server'] }, async ({ target, workbench }) => {
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
	for (const [category, labels] of [['Selection', ['Select All']], ['Edit', ['Undo', 'Redo']]] as const) {
		await hoverMenuItem(mainMenu.getByRole('menuitem', { name: category, exact: true }));
		for (const name of labels) await expect(page.getByRole('menu').last().getByRole('menuitem', { name, exact: true }).locator('.ash-button-label')).toHaveText(name);
	}
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
	await expect(newEditorItem.locator('.ash-button-label')).toHaveText('New Untitled Text Editor');
	await newEditorItem.hover();
	await expect(fileMenuItem).toHaveAttribute('aria-expanded', 'true');
	await newEditorItem.click();

	await expect(page.getByText('Untitled-1', { exact: true }).first()).toBeVisible();
	const editor = workbench.editors.groupAt(0).editor;
	await editor.waitForEditorFocus();
	await page.keyboard.insertText('first\nsecond\nthird');
	await trigger.focus();
	await trigger.press('ArrowDown');
	await expect(goMenuItem).toBeVisible();
	await goMenuItem.focus();
	await goMenuItem.press('ArrowRight');
	await page.getByRole('menu').last().getByRole('menuitem', { name: 'Go to Line/Column...' }).click();
	const location = page.locator('.ash-quick-pick').getByRole('combobox');
	await expect(location).toBeFocused();
	await expect(location).toHaveValue(':');
	await location.fill(':2:3');
	await location.press('Enter');
	await expect(page.locator('.ash-quick-pick')).toHaveCount(0);
	await expect(editor.input).toBeFocused();
	await page.keyboard.insertText('Z');
	await editor.waitForEditorContents(contents => contents === 'first\nseZcond\nthird');

	await trigger.click();
	await hoverMenuItem(mainMenu.getByRole('menuitem', { name: 'Terminal' }));
	const focusTerminal = page.getByRole('menu').last().getByRole('menuitem', { name: 'Focus Terminal' });
	if (target.appServerMode === 'required') {
		await expect(focusTerminal).toBeEnabled();
		await focusTerminal.click();
		await expect(page.locator('.ash-terminal-view')).toBeVisible();
	} else {
		await expect(focusTerminal).toBeDisabled();
		await page.keyboard.press('Escape');
		await page.keyboard.press('Escape');
		await expect(mainMenu).toHaveCount(0);
	}
});

test('Browser workspace files persist multiple authorized handles across save, close, reopen and reload', { tag: ['@browser-ui'] }, async ({ workbench }, testInfo) => {
	const page = workbench.page;
	const fixture = await page.evaluate(async () => {
		const name = `ash-multi-${crypto.randomUUID()}`;
		const home = await (await navigator.storage.getDirectory()).getDirectoryHandle(name, { create: true });
		const client = await home.getDirectoryHandle('client', { create: true });
		const server = await home.getDirectoryHandle('server', { create: true });
		const clean = await (await client.getFileHandle('clean.txt', { create: true })).createWritable();
		await clean.write('saved workspace editor'); await clean.close();
		const writable = await (await server.getFileHandle('kept.txt', { create: true })).createWritable();
		await writable.write('server file is retained'); await writable.close();
		Object.defineProperty(window, 'showDirectoryPicker', { configurable: true, value: async () => client });
		return name;
	});
	await workbench.quickaccess.runCommand('workbench.action.files.openFolderViaWorkspace');
	await expect(page.locator('.ash-explorer')).toBeVisible();
	const targetWorkspaceId = new URL(page.url()).searchParams.get('folder')! + '/team.ash-workspace';
	await workbench.quickaccess.runCommand('workbench.action.files.newUntitledFile');
	await workbench.editors.groupAt(0).editor.waitForEditorFocus();
	await workbench.editors.groupAt(0).editor.waitForTypeInEditor('unsaved browser workspace draft');
	const chooseDirectory = async (name: string) => page.evaluate(async ({ fixture, name }) => {
		const home = await (await navigator.storage.getDirectory()).getDirectoryHandle(fixture);
		const directory = await home.getDirectoryHandle(name);
		Object.defineProperty(window, 'showDirectoryPicker', { configurable: true, value: async () => directory });
	}, { fixture, name });
	const fileMenu = async (label: string) => {
		await page.getByRole('button', { name: 'Application menu', exact: true }).click();
		await page.getByRole('menu').first().getByRole('menuitem', { name: 'File', exact: true }).click();
		await page.getByRole('menu').last().getByRole('menuitem', { name: label, exact: true }).click();
	};
	await chooseDirectory('server');
	await fileMenu('Add Folder to Workspace...');
	await page.getByRole('dialog').getByRole('button', { name: 'Done', exact: true }).click();
	const roots = page.locator('.ash-explorer .ash-tree-row[aria-level="1"]');
	await expect(roots).toHaveCount(2);
	await expect(page).toHaveURL(/workspace=ash-userdata/);
	await page.reload();
	await workbench.waitForReady();
	await expect(roots).toHaveCount(2);
	await chooseDirectory('client');
	const recovery = await page.evaluate(async targetWorkspaceId => {
		const database = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open('ash-working-copy-backups', 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
		try {
			return await new Promise<{ key: string; source: Record<string, unknown>; }>((resolve, reject) => {
				const transaction = database.transaction('backups', 'readwrite');
				const store = transaction.objectStore('backups');
				const reading = store.getAll();
				let key = '';
				let source: Record<string, unknown> = {};
				reading.onsuccess = () => {
					const record = reading.result.find(record => record.content.includes('unsaved browser workspace draft'));
					if (record) source = record;
					if (!record) { transaction.abort(); return; }
					key = `${targetWorkspaceId}\0${source.resource}`;
					store.put({ ...source, key, workspaceId: targetWorkspaceId, content: 'existing target recovery', revision: 'other-writer' });
				};
				transaction.oncomplete = () => resolve({ key, source });
				transaction.onabort = () => reject(transaction.error ?? new Error('Missing source recovery'));
			});
		} finally { database.close(); }
	}, targetWorkspaceId);
	const saveWorkspace = async () => {
		await fileMenu('Save Workspace As...');
		const save = page.getByRole('dialog', { name: 'Save Workspace As...' });
		await save.getByRole('textbox', { name: 'File name, field 1' }).fill('team.ash-workspace');
		await save.getByRole('button', { name: 'OK', exact: true }).click();
	};
	await saveWorkspace();
	await expect(page.getByRole('region', { name: 'Notifications', exact: true }).getByText('Backup conflict', { exact: true })).toBeVisible();
	await page.getByRole('region', { name: 'Notifications', exact: true }).getByRole('button', { name: 'Remove notification', exact: true }).click();
	await expect(page).toHaveURL(/workspace=ash-userdata/);
	await page.evaluate(async conflictKey => {
		const database = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open('ash-working-copy-backups', 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
		try {
			await new Promise<void>((resolve, reject) => {
				const transaction = database.transaction('backups', 'readwrite');
				const store = transaction.objectStore('backups');
				const reading = store.get(conflictKey);
				reading.onsuccess = () => { if (reading.result?.content !== 'existing target recovery') transaction.abort(); else store.delete(conflictKey); };
				transaction.oncomplete = () => resolve(); transaction.onabort = () => reject(new Error('Target recovery was overwritten'));
			});
		} finally { database.close(); }
	}, recovery.key);
	await saveWorkspace();
	await expect(page).toHaveURL(/workspace=file/);
	const saved = await page.evaluate(async fixture => {
		const home = await (await navigator.storage.getDirectory()).getDirectoryHandle(fixture);
		const client = await home.getDirectoryHandle('client');
		return JSON.parse(await (await (await client.getFileHandle('team.ash-workspace')).getFile()).text());
	}, fixture);
	expect(saved.folders).toHaveLength(2);
	await expect(workbench.editors.groupAt(0).editor.lines).toContainText(['unsaved browser workspace draft']);
	await page.reload();
	await workbench.waitForReady();
	await expect(roots).toHaveCount(2);
	await expect(workbench.editors.groupAt(0).content.locator('.stanza-editor-line-text').first()).toContainText('unsaved browser workspace draft');
	const client = roots.filter({ hasText: 'client' });
	if (await client.getAttribute('aria-expanded') !== 'true') await client.locator('.ash-tree-twistie').click();
	await page.locator('.ash-explorer').getByText('clean.txt', { exact: true }).dblclick();
	await expect(workbench.editors.groupAt(0).editor.lines).toContainText(['saved workspace editor']);
	const server = roots.filter({ hasText: 'server' });
	await server.click(); await server.press('Shift+F10');
	await page.getByRole('menu').last().getByRole('menuitem', { name: 'Remove Folder from Workspace...', exact: true }).click();
	await expect(roots).toHaveCount(1);
	expect(await page.evaluate(async fixture => {
		const home = await (await navigator.storage.getDirectory()).getDirectoryHandle(fixture);
		return (await (await (await home.getDirectoryHandle('server')).getFileHandle('kept.txt')).getFile()).text();
	}, fixture)).toBe('server file is retained');
	await fileMenu('Close Workspace');
	await page.getByRole('dialog', { name: 'Save Changes' }).getByRole('button', { name: "Don't Save", exact: true }).click();
	await workbench.waitForReady();
	await expect(page).not.toHaveURL(/workspace=/);
	// Simulate a crash backup belonging to the saved workspace while a different
	// workspace is active. Opening must recover it without a subsequent reload.
	await page.evaluate(async ({ source, workspaceId }) => {
		const database = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open('ash-working-copy-backups', 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
		try {
			await new Promise<void>((resolve, reject) => {
				const transaction = database.transaction('backups', 'readwrite');
				transaction.objectStore('backups').put({ ...source, key: `${workspaceId}\0${source.resource}`, workspaceId, content: 'recovered target workspace draft', revision: 'crash-recovery' });
				transaction.oncomplete = () => resolve(); transaction.onabort = () => reject(transaction.error);
			});
		} finally { database.close(); }
	}, { source: recovery.source, workspaceId: targetWorkspaceId });
	await chooseDirectory('client');
	await fileMenu('Open Workspace from File...');
	await page.locator('.ash-quick-pick').getByText('team.ash-workspace', { exact: true }).click();
	await expect(roots).toHaveCount(1);
	await expect(page).toHaveURL(/workspace=file/);
	const group = workbench.editors.groupAt(0);
	await expect(group.tabs.filter({ hasText: 'clean.txt' })).toHaveCount(1);
	await group.tabs.filter({ hasText: 'clean.txt' }).click();
	await expect(group.editor.lines).toContainText(['saved workspace editor']);
	await group.title.locator('.ash-tab[data-state="dirty"]').click();
	await expect(group.editor.lines).toContainText(['recovered target workspace draft']);
	await expect(group.title.locator('.ash-tab[data-state="dirty"]')).toHaveCount(1);
	const screenshot = testInfo.outputPath('browser-workspace-reopened.png');
	await page.screenshot({ path: screenshot });
	await testInfo.attach('browser-workspace-reopened', { path: screenshot, contentType: 'image/png' });
});
