import { expect, test } from '../../../automation/test.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseWorkspace } from '../../../../src/ash/platform/workspace/common/workspace.js';
import { URI } from '../../../../src/ash/base/common/uri.js';

test.use({ openWorkspace: false });

for (const entry of ['welcome', 'explorer'] as const) {
	test(`desktop ${entry} folder entry opens the Windows folder chooser`, async ({ application, target, workbench }) => {
		test.skip(process.platform !== 'win32' || target.kind !== 'electron', 'Requires the Windows Code desktop');
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
	test(`desktop ${entry} folder entry loads the workspace and file contents`, async ({ application, target, testWorkspace, workbench }) => {
		test.skip(target.kind !== 'electron' || target.appServerMode !== 'required', 'Requires the Code desktop and App Server');
		if (!('windows' in application)) throw new Error('Expected Electron');
		const originalDialog = await application.evaluateHandle(({ dialog }) => dialog.showOpenDialog);
		await application.evaluate(({ dialog }, folder) => {
			dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [folder] })) as typeof dialog.showOpenDialog;
		}, testWorkspace.directory);
		try {
			const page = workbench.page;
			if (entry === 'recent') {
				await page.evaluate(async folder => {
					const ipc = (globalThis as unknown as { ash: { ipcRenderer: { invoke(channel: string, argument: unknown): Promise<unknown> } } }).ash.ipcRenderer;
					await ipc.invoke('ash:workspaces:recent:add', { workspaces: [{ folderUri: folder }] });
				}, URI.file(testWorkspace.directory).toString());
				await page.locator('.ash-getting-started-recent-item').click();
			} else if (entry === 'explorer') {
				const showSidebar = page.getByRole('button', { name: 'Show Primary Side Bar', exact: true });
				if (await showSidebar.isVisible()) await showSidebar.click();
				await page.getByRole('button', { name: 'Open Folder', exact: true }).click();
			} else {
				await page.getByRole('button', { name: 'Open folder', exact: true }).click();
			}
			await page.getByRole('dialog', { name: 'Ash', exact: true }).getByRole('button', { name: 'Trust Folder & Enable Features', exact: true }).click();
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

test('desktop window commands update zoom and open the window switcher', async ({ application, target, workbench }) => {
	test.skip(target.kind !== 'electron', 'This scenario requires the Code desktop');
	if (target.kind !== 'electron' || !('windows' in application)) return;
	const page = workbench.page;
	await expect(page.locator('[data-statusbar-item-id="ash.status.zoom"]')).toHaveCount(0);

	await page.keyboard.press('F1');
	await page.locator('.ash-quick-pick').getByRole('combobox').fill('Zoom In');
	await page.keyboard.press('Enter');
	await expect.poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.webContents.getZoomLevel())).toBe(1);
	const profileRoot = await application.evaluate(() => process.env.ASH_HOME);
	if (!profileRoot) throw new Error('Test profile is unavailable');
	await expect.poll(async () => {
		return (JSON.parse(await readFile(join(profileRoot, 'settings.json'), 'utf8')) as Record<string, unknown>)['window.zoomLevel'];
	}).toBe(1);
	await page.reload({ waitUntil: 'domcontentloaded' });
	await expect(page.locator('.ash-workbench')).toBeVisible();
	await expect.poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.webContents.getZoomLevel())).toBe(1);
	await expect(page.locator('[data-statusbar-item-id="ash.status.zoom"]')).toHaveCount(0);

	await page.keyboard.press('F1');
	await page.locator('.ash-quick-pick').getByRole('combobox').fill('Reset Zoom');
	await page.keyboard.press('Enter');
	await expect.poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.webContents.getZoomLevel())).toBe(0);

	await page.keyboard.press('F1');
	await page.locator('.ash-quick-pick').getByRole('combobox').fill('Switch Window');
	await page.keyboard.press('Enter');
	const picker = page.locator('.ash-quick-pick');
	await expect(picker.getByRole('combobox')).toHaveAttribute('aria-label', 'Select a window');
	await expect(picker.locator('.ash-window-switch-current')).toHaveCount(1);
	await page.keyboard.press('Escape');
	await expect(picker).toHaveCount(0);
});

test('keyboard layout stays in commands while the status bar is quiet', async ({ workbench }) => {
	const page = workbench.page;
	await expect(page.locator('[data-statusbar-item-id="ash.status.keyboardLayout"]')).toHaveCount(0);
	await expect(page.locator('.ash-workbench-statusbar')).toHaveAttribute('aria-live', 'off');

	await page.keyboard.press('F1');
	await page.locator('.ash-quick-pick').getByRole('combobox').fill('Change Keyboard Layout');
	await page.keyboard.press('Enter');
	await expect(page.locator('.ash-quick-pick').getByRole('combobox')).toHaveAttribute('placeholder', 'Select keyboard layout');
	await page.keyboard.press('Escape');
});

test('opening a folder names the target and explains the permission choice in the selected language', async ({ application, target, testWorkspace, workbench, restartWorkbench }) => {
	test.skip(target.kind !== 'electron' || target.appServerMode !== 'required', 'This scenario requires the Code desktop and App Server');
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
	await expect(prompt.locator('.ash-dialog-detail')).toContainText(`文件夹：${testWorkspace.directory}`);
	await expect(prompt.locator('.ash-dialog-detail')).toContainText('Ash 可以修改文件、运行命令');
	const readOnly = prompt.getByRole('button', { name: '以只读模式打开' });
	await expect(readOnly).toBeFocused();
	await expect(page.getByText('No Folder Opened')).toHaveCount(1);
	await prompt.getByRole('button', { name: '取消' }).click();
	await expect(prompt).toHaveCount(0);
	const workspaceAfterCancel = await page.evaluate(() => {
		const ipc = (globalThis as unknown as { ash: { ipcRenderer: { invoke(channel: string): Promise<unknown> } } }).ash.ipcRenderer;
		return ipc.invoke('ash:workspace:context:read');
	});
	expect(parseWorkspace(workspaceAfterCancel).folders).toHaveLength(0);
	await page.getByRole('button', { name: /^(Open folder|打开文件夹)$/ }).click();
	await page.getByRole('dialog', { name: 'Ash' }).getByRole('button', { name: '以只读模式打开' }).click();
	await expect.poll(async () => {
		const value = await workbench.page.evaluate(() => {
			const ipc = (globalThis as unknown as { ash: { ipcRenderer: { invoke(channel: string): Promise<unknown> } } }).ash.ipcRenderer;
			return ipc.invoke('ash:workspace:context:read');
		});
		return parseWorkspace(value).folders[0]?.uri.fsPath;
	}).toBe(testWorkspace.directory);
	await expect(page.locator('[data-statusbar-item-id="ash.status.workspacePermissions"]')).toContainText('只读文件夹');
});
