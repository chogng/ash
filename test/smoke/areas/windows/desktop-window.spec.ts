import { expect, test } from '../../../automation/test.js';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseWorkspace } from '../../../../src/ash/platform/workspace/common/workspace.js';
import { URI } from '../../../../src/ash/base/common/uri.js';
import { waitForElectronWindowState } from '../../../automation/electronDriver.js';
import { Workbench } from '../../../automation/workbench.js';

const focusTest = test.extend({ electronWindowMode: 'active' });
const persistedZoomTest = test.extend({ electronWindowMode: 'active', electronUserSettings: { 'window.zoomPerWindow': false } });

test.use({ openWorkspace: false });

for (const entry of ['welcome', 'explorer'] as const) {
	test(`desktop ${entry} folder entry opens the Windows folder chooser`, { tag: ['@electron-ui', '@electron-app-server', '@win32'] }, async ({ application, target, workbench }) => {
		if (!('windows' in application)) throw new Error('Expected Electron');
		const page = workbench.page;
		if (entry === 'explorer') {
			const showSidebar = page.getByRole('button', { name: 'Show Primary Side Bar', exact: true });
			if (await showSidebar.isVisible()) await showSidebar.click();
		}
		await page.getByRole('button', { name: entry === 'welcome' ? 'Open folder' : 'Open Folder', exact: true }).click();
		// Windows disables the owning window while its system chooser is open.
		// Keep the real dialog implementation; fixture cleanup destroys its owner.
		await expect.poll(() => application.evaluate(({ BrowserWindow }) => {
			return BrowserWindow.getAllWindows().some(window => !window.isEnabled());
		})).toBe(true);
	});
}

for (const entry of ['welcome', 'explorer', 'recent'] as const) {
	test(`desktop ${entry} folder entry loads the workspace and file contents`, { tag: ['@electron-app-server'] }, async ({ application, target, testWorkspace, workbench }) => {
		if (!('windows' in application)) throw new Error('Expected Electron');
		const originalDialog = await application.evaluateHandle(({ dialog }) => dialog.showOpenDialog);
		await application.evaluate(({ dialog }, folder) => {
			dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [folder] })) as typeof dialog.showOpenDialog;
		}, testWorkspace.directory);
		try {
			const page = workbench.page;
			if (entry === 'recent') {
				await page.evaluate(async folder => {
					await globalThis.ashTestMainProcess.call('workspaces', 'addRecentlyOpened', { workspaces: [{ folderUri: folder }] });
				}, URI.file(testWorkspace.directory).toString());
				await page.locator('.ash-getting-started-recent-item').click();
			} else if (entry === 'explorer') {
				const showSidebar = page.getByRole('button', { name: 'Show Primary Side Bar', exact: true });
				if (await showSidebar.isVisible()) await showSidebar.click();
				await page.getByRole('button', { name: 'Open Folder', exact: true }).click();
			} else {
				await page.getByRole('button', { name: 'Open folder', exact: true }).click();
			}
			await page.getByRole('dialog', { name: 'Ash', exact: true }).getByRole('button', { name: 'Trust Folder', exact: true }).click();
			const showSidebar = page.getByRole('button', { name: 'Show Primary Side Bar', exact: true });
			if (await showSidebar.isVisible()) await showSidebar.click();
			const file = page.locator('.ash-explorer .ash-tree-row').filter({ hasText: 'main.ts' });
			await expect(file).toHaveCount(1);
			await file.dblclick();
			await expect(page.locator('.stanza-editor-line-text').first()).toContainText('const value = 1;');
		} finally {
			await application.evaluate(({ dialog }, original) => { dialog.showOpenDialog = original; }, originalDialog);
			await originalDialog.dispose();
		}
	});
}

test('desktop Recents removes shared history without deleting projects and stays empty after restart', { tag: ['@electron-ui', '@electron-app-server'] }, async ({ workbench, reloadWorkbench }, testInfo) => {
	const folder = testInfo.outputPath('Alpha project');
	const workspace = testInfo.outputPath('Team #1.code-workspace');
	const workspaceContents = JSON.stringify({ folders: [{ path: folder }] });
	await mkdir(folder, { recursive: true });
	await writeFile(workspace, workspaceContents);
	const history = (command: string, arg?: unknown): Promise<unknown> => workbench.page.evaluate(({ command, arg }) => globalThis.ashTestMainProcess.call('workspaces', command, arg), { command, arg });
	await history('clearRecentlyOpened');
	await history('addRecentlyOpened', {
		workspaces: [
			{ folderUri: URI.file(folder).toString(), label: 'Alpha' },
			{ workspace: { id: 'team', configPath: URI.file(workspace).toString() }, label: 'Team' },
		]
	});
	const page = workbench.page;
	const recents = page.locator('.ash-getting-started-recent');
	await expect(recents.getByRole('heading', { name: 'Recents', exact: true })).toBeVisible();
	await expect(recents.locator('.ash-getting-started-recent-item')).toHaveCount(2);
	const alpha = recents.locator('.ash-getting-started-recent-item').filter({ hasText: 'Alpha' });
	await alpha.locator('.ash-getting-started-recent-content').focus();
	await page.keyboard.press('Tab');
	await expect(alpha.getByRole('button', { name: 'Remove Alpha from Recents', exact: true })).toBeFocused();
	await page.keyboard.press('Enter');
	await expect(alpha).toHaveCount(0);
	const team = recents.locator('.ash-getting-started-recent-item');
	await expect(team.locator('.ash-getting-started-recent-content')).toBeFocused();
	await expect.poll(() => history('getRecentlyOpened')).toEqual({
		workspaces: [
			{ workspace: { id: 'team', configPath: URI.file(workspace).toString() }, label: 'Team' },
		]
	});
	await team.hover();
	await team.getByRole('button', { name: 'Remove Team from Recents', exact: true }).click();
	await expect(recents).toBeHidden();
	await expect(page.getByRole('button', { name: 'Open folder', exact: true })).toBeFocused();
	await expect.poll(() => history('getRecentlyOpened')).toEqual({ workspaces: [] });
	expect((await stat(folder)).isDirectory()).toBe(true);
	expect(await readFile(workspace, 'utf8')).toBe(workspaceContents);
	({ workbench } = await reloadWorkbench());
	await expect(workbench.page.locator('.ash-getting-started-recent')).toBeHidden();
	expect(await history('getRecentlyOpened')).toEqual({ workspaces: [] });
});

persistedZoomTest('desktop window commands update and persist zoom', { tag: ['@electron-ui', '@electron-app-server'] }, async ({ application, target, workbench }) => {
	if (target.kind !== 'electron' || !('windows' in application)) return;
	const page = workbench.page;
	page.on('dialog', dialog => { expect(dialog.type()).toBe('beforeunload'); });
	const window = await application.browserWindow(page);
	try {
		await expect(page.locator('[data-statusbar-item-id="ash.status.zoom"]')).toHaveCount(0);

		await workbench.quickaccess.runCommand('workbench.action.zoomIn');
		await expect.poll(() => window.evaluate(window => window.webContents.getZoomLevel())).toBe(1);
		const profileRoot = await application.evaluate(() => process.env.ASH_HOME);
		if (!profileRoot) throw new Error('Test profile is unavailable');
		await expect.poll(async () => {
			return (JSON.parse(await readFile(join(profileRoot, 'settings.json'), 'utf8')) as Record<string, unknown>)['window.zoomLevel'];
		}).toBe(1);
		await page.reload({ waitUntil: 'domcontentloaded' });
		await workbench.waitForReady();
		await application.evaluate(({ app }) => app.focus({ steal: true }));
		await window.evaluate(window => window.focus());
		await page.bringToFront();
		await expect.poll(() => window.evaluate(window => window.webContents.getZoomLevel())).toBe(1);
		await expect(page.locator('[data-statusbar-item-id="ash.status.zoom"]')).toHaveCount(0);

		await workbench.quickaccess.runCommand('workbench.action.zoomReset');
		await expect.poll(() => window.evaluate(window => window.webContents.getZoomLevel())).toBe(0);
	} finally { await window.dispose(); }
});

// The current-window marker belongs to the calling window, even across OS focus changes.
focusTest('desktop window switcher marks the calling window as current', { tag: ['@electron-ui', '@electron-app-server'] }, async ({ application, target, workbench }) => {
	if (!('windows' in application)) throw new Error('Expected Electron windows');
	const page = workbench.page;
	await application.evaluate(({ app, BrowserWindow }) => {
		app.focus({ steal: true });
		BrowserWindow.getAllWindows()[0]!.focus();
	});
	await waitForElectronWindowState(application, page, { focused: true });
	await workbench.quickaccess.runCommand('workbench.action.switchWindow');
	const picker = page.locator('.ash-quick-pick');
	await expect(picker.getByRole('combobox')).toHaveAttribute('aria-label', 'Select a window');
	await expect(picker.locator('.ash-window-switch-current')).toHaveCount(1);
	await page.keyboard.press('Escape');
	await expect(picker).toHaveCount(0);
});

focusTest('window switcher keeps the calling window current after losing OS focus', { tag: ['@electron-ui', '@electron-app-server', '@darwin'] }, async ({ application, workbench }) => {
	if (!('windows' in application)) throw new Error('Expected Electron windows');
	const page = workbench.page;
	await application.evaluate(({ app }) => app.hide());
	try {
		await waitForElectronWindowState(application, page, { focused: false });
		await workbench.quickaccess.runCommand('workbench.action.switchWindow');
		const picker = page.locator('.ash-quick-pick');
		await expect(picker.getByRole('combobox')).toHaveAttribute('aria-label', 'Select a window');
		await expect(picker.locator('.ash-window-switch-current')).toHaveCount(1);
		await expect(picker.locator('.ash-window-switch-current')).toContainText('Current window');
		await page.keyboard.press('Escape');
	} finally {
		await application.evaluate(({ app }) => app.show());
	}
});

test('keyboard layout stays in commands while the status bar is quiet', async ({ workbench }) => {
	const page = workbench.page;
	await expect(page.locator('[data-statusbar-item-id="ash.status.keyboardLayout"]')).toHaveCount(0);
	await expect(page.locator('.ash-workbench-statusbar')).toHaveAttribute('aria-live', 'off');

	await workbench.quickaccess.runCommand('workbench.action.changeKeyboardLayout');
	await expect(page.locator('.ash-quick-pick').getByRole('combobox')).toHaveAttribute('placeholder', 'Select keyboard layout');
	await page.keyboard.press('Escape');
	await workbench.quickaccess.runCommand('workbench.action.toggleKeyboardShortcutsTroubleshooting');
	const output = page.locator('.ash-output:visible');
	await expect(output).toBeVisible();
	await expect(output.locator('.view-line').filter({ hasText: 'Keyboard shortcuts troubleshooting enabled.' })).toBeVisible();
	await workbench.quickaccess.runCommand('workbench.action.toggleKeyboardShortcutsTroubleshooting');
	await expect(output.locator('.view-line').filter({ hasText: 'Keyboard shortcuts troubleshooting disabled.' })).toBeVisible();
});

test('cancelling directory authorization during startup keeps the window usable and allows retry', { tag: ['@electron-app-server'] }, async ({ application, testWorkspace }, testInfo) => {
	if (!('windows' in application)) throw new Error('Expected Electron');
	const opening = application.waitForEvent('window');
	await application.evaluate(({ app }, directory) => {
		app.emit('second-instance', {} as never, [process.execPath, app.getAppPath(), '--folder', directory], process.cwd(), {});
	}, testWorkspace.directory);
	const page = await opening;
	const workbench = new Workbench(page);
	const prompt = page.getByRole('dialog', { name: 'Ash', exact: true });
	const reconnect = page.getByRole('button', { name: 'Reconnect', exact: true });
	await prompt.getByRole('button', { name: 'Cancel', exact: true }).click();
	await workbench.waitForReady();
	await expect(page.getByRole('heading', { name: 'Unable to start Ash' })).toHaveCount(0);
	await expect(prompt).toHaveCount(0);
	await expect(reconnect).toBeVisible();
	await page.screenshot({ path: testInfo.outputPath('cancelled-startup-authorization.png') });
	// Cancellation must not persist a grant: reloading still asks for authorization.
	await page.reload();
	await expect(prompt.getByRole('button', { name: 'Open Read-Only', exact: true })).toBeFocused();
	await page.keyboard.press('Escape');
	await workbench.waitForReady();
	await expect(reconnect).toBeVisible();
	await reconnect.click();
	await expect(prompt).toBeVisible();
	await prompt.getByRole('button', { name: 'Open Read-Only', exact: true }).click();
	await expect(reconnect).toHaveCount(0);
	await expect(page.locator('.ash-explorer .ash-tree-row').filter({ hasText: 'main.ts' })).toHaveCount(1);
	await expect(page.locator('.ash-explorer').getByRole('alert')).toHaveCount(0);
	await workbench.quickaccess.open(join(testWorkspace.directory, 'main.ts'));
	await workbench.quickaccess.select('main.ts');
	await workbench.editors.groupAt(0).editor.waitForEditorContents(text => text === 'const value = 1;\n');
	await expect(page.locator('[data-statusbar-item-id="ash.status.workspacePermissions"]')).toContainText('Read-only');
	await page.screenshot({ path: testInfo.outputPath('retried-startup-authorization.png') });
});

test('opening a folder names the target and explains the permission choice in the selected language', { tag: ['@electron-app-server'] }, async ({ application, target, testWorkspace, workbench, restartWorkbench }) => {
	if (target.kind !== 'electron' || !('windows' in application)) return;

	await workbench.quickaccess.runCommand('workbench.action.configureLocale');
	const language = workbench.page.getByRole('dialog', { name: 'Select Display Language' }).getByRole('combobox');
	await language.fill('简体中文');
	await language.press('Enter');
	({ application, workbench } = await restartWorkbench());
	if (!('windows' in application)) throw new Error('Expected Electron after restart');

	await application.evaluate(({ dialog }, folder) => {
		dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [folder] })) as typeof dialog.showOpenDialog;
	}, testWorkspace.directory);

	const page = workbench.page;
	await expect(page.locator('[data-statusbar-item-id="ash.status.editor.state"]')).toHaveCount(0);
	await page.getByRole('button', { name: /^(Open folder|打开文件夹)$/ }).click();
	const prompt = page.getByRole('dialog', { name: 'Ash' });
	await expect(prompt).toBeVisible();
	await expect(prompt.locator('.ash-dialog-message')).toHaveText('是否信任此文件夹中的文件？');
	await expect(prompt.locator('.ash-dialog-detail')).toContainText(`文件夹：${URI.file(testWorkspace.directory).fsPath}`);
	await expect(prompt.locator('.ash-dialog-detail')).toContainText('Ash 可以修改文件和运行命令');
	const readOnly = prompt.getByRole('button', { name: '以只读模式打开' });
	await expect(readOnly).toBeFocused();
	await expect(page.getByText('No Folder Opened')).toHaveCount(1);
	await prompt.getByRole('button', { name: '取消' }).click();
	await expect(prompt).toHaveCount(0);
	const workspaceAfterCancel = await page.evaluate(() => {
		const ipc = (globalThis as unknown as { ash: { ipcRenderer: { invoke(channel: string): Promise<unknown>; }; }; }).ash.ipcRenderer;
		return ipc.invoke('ash:workspace:context:read');
	});
	expect(parseWorkspace(workspaceAfterCancel).folders).toHaveLength(0);
	await page.getByRole('button', { name: /^(Open folder|打开文件夹)$/ }).click();
	await page.getByRole('dialog', { name: 'Ash' }).getByRole('button', { name: '以只读模式打开' }).click();
	await expect.poll(async () => {
		const value = await workbench.page.evaluate(() => {
			const ipc = (globalThis as unknown as { ash: { ipcRenderer: { invoke(channel: string): Promise<unknown>; }; }; }).ash.ipcRenderer;
			return ipc.invoke('ash:workspace:context:read');
		});
		return parseWorkspace(value).folders[0]?.uri.fsPath;
	}).toBe(URI.file(testWorkspace.directory).fsPath);
	await expect(page.locator('[data-statusbar-item-id="ash.status.workspacePermissions"]')).toContainText('只读文件夹');
});
