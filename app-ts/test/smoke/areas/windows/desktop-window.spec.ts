import { expect, test } from '../../../automation/test.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseWorkspace } from '../../../../src/ash/platform/workspace/common/workspace.js';

test.use({ openWorkspace: false });

test('desktop window commands update zoom and open the window switcher', async ({ application, target, workbench }) => {
	test.skip(target.kind !== 'electron' || target.workbenchMode !== 'code', 'This scenario requires the Code desktop');
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
		const document = JSON.parse(await readFile(join(profileRoot, 'configuration.json'), 'utf8')) as { source: string };
		return (JSON.parse(document.source) as Record<string, unknown>)['window.zoomLevel'];
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

test('keyboard layout stays in commands while the status bar is quiet', async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== 'code', 'This scenario requires the Code workbench');
	const page = workbench.page;
	await expect(page.locator('[data-statusbar-item-id="ash.status.keyboardLayout"]')).toHaveCount(0);
	await expect(page.locator('.ash-workbench-statusbar')).toHaveAttribute('aria-live', 'off');

	await page.keyboard.press('F1');
	await page.locator('.ash-quick-pick').getByRole('combobox').fill('Change Keyboard Layout');
	await page.keyboard.press('Enter');
	await expect(page.locator('.ash-quick-pick').getByRole('combobox')).toHaveAttribute('placeholder', 'Select keyboard layout');
	await page.keyboard.press('Escape');
});

test('opening a folder names the target and explains the permission choice in the selected language', async ({ application, target, testWorkspace, workbench }) => {
	test.skip(target.kind !== 'electron' || target.appServerMode !== 'required' || target.workbenchMode !== 'code', 'This scenario requires the Code desktop and App Server');
	if (target.kind !== 'electron' || !('windows' in application)) return;

	await workbench.page.evaluate(async () => {
		const ipc = (globalThis as unknown as { ash: { ipcRenderer: { invoke(channel: string, value?: unknown): Promise<unknown> } } }).ash.ipcRenderer;
		const snapshot = await ipc.invoke('ash:configuration:read') as { revision: number; document: { version: 1; source: string } };
		await ipc.invoke('ash:configuration:update', {
			expectedRevision: snapshot.revision,
			document: { version: 1, source: JSON.stringify({ ...JSON.parse(snapshot.document.source), 'workbench.locale': 'zh-CN' }) },
		});
	});
	await application.evaluate(({ dialog }, folder) => {
		dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [folder] })) as typeof dialog.showOpenDialog;
	}, testWorkspace.directory);

	const page = workbench.page;
	await expect(page.locator('[data-statusbar-item-id="ash.status.editor.state"]')).toHaveCount(0);
	await page.getByRole('button', { name: /^(Open Folder|打开文件夹)$/ }).click();
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
	await page.getByRole('button', { name: /^(Open Folder|打开文件夹)$/ }).click();
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
