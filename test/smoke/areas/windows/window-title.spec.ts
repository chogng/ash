import { readFile } from 'node:fs/promises';
import { expect, test } from '../../../automation/test.js';
import { readUserSettings, writeUserSettings } from '../../../automation/settings.js';
import { QuickAccess } from '../../../automation/quickaccess.js';

test.beforeEach(async ({ workbench }) => {
	await workbench.quickaccess.runCommand('workbench.action.closeAllEditors');
	await expect(workbench.editors.groupAt(0).tabs).toHaveCount(0);
});

test('window title follows the active editor, unsaved changes, restored content and close', async ({ application, workbench }) => {
	const page = workbench.page;
	const workspaceTitle = await page.title();
	expect(workspaceTitle).toMatch(/Ash Code$/u);
	await page.keyboard.press('ControlOrMeta+N');
	await expect(page).toHaveTitle(`Untitled-1 — ${workspaceTitle}`);
	const input = workbench.editors.groupAt(0).content.locator('.stanza-editor-input');
	await input.focus();
	await input.type('window title draft');
	await expect(page).toHaveTitle(`● Untitled-1 — ${workspaceTitle}`);
	const commandCenter = page.getByRole('button', { name: 'Search commands', exact: true });
	await expect(commandCenter).toHaveAttribute('aria-description', `● Untitled-1 — ${workspaceTitle}`);
	await commandCenter.hover();
	await expect(page.getByRole('tooltip')).toHaveText(`● Untitled-1 — ${workspaceTitle}`);
	if ('windows' in application) {
		await expect.poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getTitle())).toBe(`● Untitled-1 — ${workspaceTitle}`);
	}
	await input.press('ControlOrMeta+A');
	await input.press('Backspace');
	await expect(page).toHaveTitle(`Untitled-1 — ${workspaceTitle}`);
	await page.keyboard.press('ControlOrMeta+N');
	await expect(page).toHaveTitle(`Untitled-2 — ${workspaceTitle}`);
	await page.keyboard.press('ControlOrMeta+W');
	await expect(page).toHaveTitle(`Untitled-1 — ${workspaceTitle}`);
	await page.keyboard.press('ControlOrMeta+W');
	await expect(page).toHaveTitle(workspaceTitle);
});

test('detached editor titles follow their own window when focus and dirty state change', async ({ application, workbench }, testInfo) => {
	const page = workbench.page;
	const workspaceTitle = await page.title();
	await page.keyboard.press('ControlOrMeta+N');
	await expect(page).toHaveTitle(`Untitled-1 — ${workspaceTitle}`);
	await page.keyboard.press('ControlOrMeta+N');
	await expect(page).toHaveTitle(`Untitled-2 — ${workspaceTitle}`);
	const opened = page.context().waitForEvent('page');
	await workbench.quickaccess.runCommand('workbench.action.moveEditorToNewWindow');
	const popup = await opened;
	try {
		await expect(popup).toHaveTitle(`Untitled-2 — ${workspaceTitle}`);
		if ('windows' in application) {
			const titlebar = popup.locator('.ash-auxiliary-titlebar.ash-electron-titlebar');
			await expect(titlebar).toBeVisible();
			await expect(titlebar).toHaveCSS('-webkit-app-region', 'drag');
			await expect(titlebar.locator('.ash-titlebar-command-center')).toHaveCSS('-webkit-app-region', 'no-drag');
			await expect(titlebar.locator('[data-action-id="ash.applicationMenu"]')).toHaveCount(process.platform === 'darwin' ? 0 : 1);
			const name = await popup.evaluate(() => window.name);
			const pin = titlebar.getByRole('button', { name: 'Turn On Always on Top', exact: true });
			await expect(pin).toBeVisible();
			const readPinnedWindows = () => application.evaluate(({ BrowserWindow }, name) => ({
				auxiliary: BrowserWindow.getAllWindows().find(window => window.webContents.mainFrame.name === name)?.isAlwaysOnTop(),
				main: BrowserWindow.getAllWindows().filter(window => window.webContents.mainFrame.name !== name).map(window => window.isAlwaysOnTop()),
			}), name);
			await popup.bringToFront();
			await pin.click();
			await expect.poll(readPinnedWindows).toEqual({ auxiliary: true, main: [false] });
			await expect(titlebar.getByRole('button', { name: 'Turn Off Always on Top', exact: true })).toBeVisible();
			const commands = new QuickAccess(popup);
			await commands.runCommand('workbench.action.disableWindowAlwaysOnTop');
			await expect.poll(readPinnedWindows).toEqual({ auxiliary: false, main: [false] });
			await expect(pin).toBeVisible();
			await commands.runCommand('workbench.action.toggleWindowAlwaysOnTop');
			await expect(titlebar.getByRole('button', { name: 'Turn Off Always on Top', exact: true })).toBeVisible();
			await expect.poll(readPinnedWindows).toEqual({ auxiliary: true, main: [false] });
			await titlebar.getByRole('button', { name: 'Turn Off Always on Top', exact: true }).press('Space');
			await expect(pin).toBeVisible();
			await expect.poll(readPinnedWindows).toEqual({ auxiliary: false, main: [false] });
			const frameInset = await application.evaluate(({ BrowserWindow }, name) => {
				const window = BrowserWindow.getAllWindows().find(window => window.webContents.mainFrame.name === name);
				if (!window) throw new Error('Auxiliary window is not registered');
				return window.getContentBounds().y - window.getBounds().y;
			}, name);
			expect(frameInset).toBe(0);
			await popup.screenshot({ path: testInfo.outputPath('auxiliary-custom-titlebar.png') });
		}
		await expect(page).toHaveTitle(`Untitled-1 — ${workspaceTitle}`);
		const input = popup.locator('.stanza-editor-input');
		await input.focus();
		await input.type('detached draft');
		await expect(popup).toHaveTitle(`● Untitled-2 — ${workspaceTitle}`);
		await workbench.editors.groupAt(0).tabs.first().click();
		await expect(page).toHaveTitle(`Untitled-1 — ${workspaceTitle}`);
		await expect(popup).toHaveTitle(`● Untitled-2 — ${workspaceTitle}`);
		await popup.bringToFront();
		await input.focus();
		await input.press('Home');
		await input.press('Shift+End');
		await input.press('Backspace');
		await expect(popup).toHaveTitle(`Untitled-2 — ${workspaceTitle}`);
		await popup.close();
		await expect(workbench.editors.groupAt(0).tabs).toHaveCount(1);
		await page.keyboard.press('ControlOrMeta+N');
		await expect(page).toHaveTitle(`Untitled-3 — ${workspaceTitle}`);
	} finally {
		if (!popup.isClosed()) {
			await popup.close();
		}
	}
});

test('saving a workspace file clears the window title dirty marker', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ target, testWorkspace, workbench }) => {
	const page = workbench.page;
	const workspaceTitle = await page.title();
	const file = page.locator('.ash-explorer .ash-tree-row').filter({ hasText: 'main.ts' });
	await expect(file).toHaveCount(1);
	await file.dblclick();
	await expect(page).toHaveTitle(`main.ts — ${workspaceTitle}`);
	const input = workbench.editors.groupAt(0).content.locator('.stanza-editor-input');
	await input.focus();
	await input.press('ControlOrMeta+A');
	await input.type('const title = 2;');
	await expect(page).toHaveTitle(`● main.ts — ${workspaceTitle}`);
	await input.press('ControlOrMeta+S');
	await expect.poll(() => readFile(testWorkspace.file, 'utf8')).toBe('const title = 2;');
	await expect(page).toHaveTitle(`main.ts — ${workspaceTitle}`);
});


test('auxiliary window close and zoom commands leave the main window intact', { tag: ['@electron-ui'] }, async ({ application, workbench }) => {
	if (!('windows' in application)) throw new Error('Requires Electron');
	const page = workbench.page;
	await page.keyboard.press('ControlOrMeta+N');
	const opened = page.context().waitForEvent('page');
	await workbench.quickaccess.runCommand('workbench.action.moveEditorToNewWindow');
	const popup = await opened;
	const name = await popup.evaluate(() => window.name);
	const commands = new QuickAccess(popup);
	const readZoom = () => application.evaluate(({ BrowserWindow }, name) => BrowserWindow.getAllWindows().map(window => ({ auxiliary: window.webContents.mainFrame.name === name, zoom: window.webContents.getZoomLevel() })).sort((a, b) => Number(a.auxiliary) - Number(b.auxiliary)), name);
	try {
		await popup.bringToFront();
		await commands.runCommand('workbench.action.zoomIn');
		await expect.poll(readZoom).toEqual([{ auxiliary: false, zoom: 0 }, { auxiliary: true, zoom: 1 }]);
		await commands.runCommand('workbench.action.zoomReset');
		await expect.poll(readZoom).toEqual([{ auxiliary: false, zoom: 0 }, { auxiliary: true, zoom: 0 }]);
		await popup.locator('.stanza-editor-input').focus();
		await popup.locator('.stanza-editor-input').type('preserved auxiliary draft');
		await commands.open('>workbench.action.closeWindow');
		await Promise.all([popup.waitForEvent('close'), commands.items.filter({ has: popup.locator('.ash-quick-pick-row-description').getByText('workbench.action.closeWindow', { exact: true }) }).click()]);
		await expect.poll(() => popup.isClosed()).toBe(true);
		expect(page.isClosed()).toBe(false);
		await expect(workbench.element).toBeVisible();
		await expect(workbench.editors.groupAt(0).tabs).toHaveCount(1);
		await expect(page).toHaveTitle(/● Untitled-1/);
		await expect(workbench.editors.groupAt(0).content).toContainText('preserved auxiliary draft');
	} finally { if (!popup.isClosed()) await popup.close(); }
});


test('auxiliary windows restore separate bounds zoom and pin state and observe host changes', { tag: ['@electron-ui'] }, async ({ application, workbench, reloadWorkbench }) => {
	if (!('windows' in application)) throw new Error('Requires Electron');
	const opened = workbench.page.context().waitForEvent('page');
	await workbench.quickaccess.runCommand('workbench.action.newEmptyEditorWindow');
	const first = await opened;
	await expect.poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter(window => window.webContents.mainFrame.name.startsWith('ash-auxiliary-')).map(window => window.isMaximized()))).toEqual([false]);
	await first.bringToFront();
	await first.keyboard.press('ControlOrMeta+N');
	await first.locator('.stanza-editor-input').focus();
	await first.locator('.stanza-editor-input').type('first window draft');
	const firstCommands = new QuickAccess(first);
	await firstCommands.runCommand('workbench.action.zoomIn');
	const secondOpened = first.context().waitForEvent('page');
	await firstCommands.runCommand('workbench.action.newEmptyEditorWindow');
	const second = await secondOpened;
	await second.bringToFront();
	await second.keyboard.press('ControlOrMeta+N');
	await second.locator('.stanza-editor-input').focus();
	await second.locator('.stanza-editor-input').type('second window draft');
	await new QuickAccess(second).runCommand('workbench.action.zoomOut');
	const names = await Promise.all([first, second].map(page => page.evaluate(() => window.name)));
	await application.evaluate(({ BrowserWindow }, names) => names.forEach((name, index) => {
		const window = BrowserWindow.getAllWindows().find(window => window.webContents.mainFrame.name === name)!;
		window.setBounds({ x: 50 + index * 120, y: 70 + index * 80, width: 850 + index * 90, height: 650 + index * 70 });
		window.setAlwaysOnTop(index === 0);
	}), names);
	await application.evaluate(({ BrowserWindow }, name) => BrowserWindow.getAllWindows().find(window => window.webContents.mainFrame.name === name)!.maximize(), names[1]!);
	await expect.poll(() => application.evaluate(({ BrowserWindow }, name) => BrowserWindow.getAllWindows().find(window => window.webContents.mainFrame.name === name)!.isMaximized(), names[1]!)).toBe(true);
	const expected = await application.evaluate(({ BrowserWindow }, names) => names.map(name => {
		const window = BrowserWindow.getAllWindows().find(window => window.webContents.mainFrame.name === name)!;
		return { bounds: window.getNormalBounds(), zoom: window.webContents.getZoomLevel(), pin: window.isAlwaysOnTop(), maximized: window.isMaximized() };
	}), names);
	await expect(first.getByRole('button', { name: 'Turn Off Always on Top', exact: true })).toBeVisible();
	for (const page of [first, second]) {
		await expect(page.locator('.ash-auxiliary-titlebar [data-action-id="workbench.action.togglePanel"]')).toHaveCount(0);
		await expect(page.locator('.ash-auxiliary-titlebar [data-action-id="workbench.action.toggleAuxiliaryBar"]')).toHaveCount(0);
	}
	const { application: restoredApplication, workbench: restored } = await reloadWorkbench();
	if (!('windows' in restoredApplication)) throw new Error('Requires Electron');
	await expect.poll(() => restored.page.context().pages().filter(page => page !== restored.page && !page.isClosed()).length).toBe(2);
	await expect.poll(() => restoredApplication.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter(window => window.webContents.mainFrame.name.startsWith('ash-auxiliary-')).map(window => ({ bounds: window.getNormalBounds(), zoom: window.webContents.getZoomLevel(), pin: window.isAlwaysOnTop(), maximized: window.isMaximized() })).sort((a, b) => a.bounds.x - b.bounds.x), undefined)).toEqual(expected);
	const popups = restored.page.context().pages().filter(page => page !== restored.page && !page.isClosed());
	await expect(popups[0]!.locator('.stanza-editor-input')).toBeVisible();
	await expect(popups[1]!.locator('.stanza-editor-input')).toBeVisible();
});


test('shared zoom and status bar visibility follow profile settings in auxiliary windows', { tag: ['@electron-ui'] }, async ({ application, workbench }) => {
	if (!('windows' in application)) throw new Error('Requires Electron');
	const page = workbench.page;
	await expect(page.locator('.ash-titlebar-actions [data-action-id="workbench.action.togglePanel"]')).toBeVisible();
	const settings = await readUserSettings(page);
	await writeUserSettings(page, JSON.stringify({ 'window.zoomPerWindow': false, 'workbench.statusBar.visible': false }), settings.revision);
	await expect(page.locator('.ash-workbench-statusbar')).toBeHidden();
	const opened = page.context().waitForEvent('page');
	await workbench.quickaccess.runCommand('workbench.action.newEmptyEditorWindow');
	const popup = await opened;
	try {
		await expect(popup.locator('.ash-workbench-statusbar')).toBeHidden();
		await popup.bringToFront();
		const commands = new QuickAccess(popup);
		await commands.runCommand('workbench.action.zoomIn');
		const levels = () => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => window.webContents.getZoomLevel()));
		await expect.poll(levels).toEqual([1, 1]);
		await commands.runCommand('workbench.action.zoomOut');
		await expect.poll(levels).toEqual([0, 0]);
		const latest = await readUserSettings(page);
		await writeUserSettings(page, JSON.stringify({ 'window.zoomPerWindow': true, 'workbench.statusBar.visible': true }), latest.revision);
		await expect(page.locator('.ash-workbench-statusbar')).toBeVisible();
		await expect(popup.locator('.ash-workbench-statusbar')).toBeVisible();
	} finally { if (!popup.isClosed()) await popup.close(); }
});
