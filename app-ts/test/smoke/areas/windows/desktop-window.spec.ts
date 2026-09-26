import { expect, test } from '../../../automation/test.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BrowserWindow, MessageBoxOptions } from 'electron';
import { parseWorkspace } from '../../../../src/ash/platform/workspace/common/workspace.js';

test.use({ openWorkspace: false });

test('desktop window commands update zoom and open the window switcher', async ({ application, target, workbench }) => {
	test.skip(target.kind !== 'electron' || target.workbenchMode !== 'code', 'This scenario requires the Code desktop');
	if (target.kind !== 'electron' || !('windows' in application)) return;
	const page = workbench.page;
	const zoom = page.locator('[data-statusbar-item-id="ash.status.zoom"]');
	await expect(zoom).toContainText('100%');

	await page.keyboard.press('F1');
	await page.locator('.ash-quick-pick').getByRole('combobox').fill('Zoom In');
	await page.keyboard.press('Enter');
	await expect(zoom).toContainText('120%');
	const profileRoot = await application.evaluate(() => process.env.ASH_HOME);
	if (!profileRoot) throw new Error('Test profile is unavailable');
	await expect.poll(async () => {
		const document = JSON.parse(await readFile(join(profileRoot, 'configuration.json'), 'utf8')) as { source: string };
		return (JSON.parse(document.source) as Record<string, unknown>)['window.zoomLevel'];
	}).toBe(1);
	await page.reload({ waitUntil: 'domcontentloaded' });
	await expect(page.locator('.ash-workbench')).toBeVisible();
	await expect(zoom).toContainText('120%');

	await page.keyboard.press('F1');
	await page.locator('.ash-quick-pick').getByRole('combobox').fill('Reset Zoom');
	await page.keyboard.press('Enter');
	await expect(zoom).toContainText('100%');

	await page.keyboard.press('F1');
	await page.locator('.ash-quick-pick').getByRole('combobox').fill('Switch Window');
	await page.keyboard.press('Enter');
	const picker = page.locator('.ash-quick-pick');
	await expect(picker.getByRole('combobox')).toHaveAttribute('aria-label', 'Select a window');
	await expect(picker.locator('.ash-window-switch-current')).toHaveCount(1);
	await page.keyboard.press('Escape');
	await expect(picker).toHaveCount(0);
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
		const showMessageBox = dialog.showMessageBox.bind(dialog);
		dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [folder] })) as typeof dialog.showOpenDialog;
		dialog.showMessageBox = (async (...args: [MessageBoxOptions] | [BrowserWindow, MessageBoxOptions]) => {
			const options = args.length === 1 ? args[0] : args[1];
			if (options.detail?.includes(folder)) {
				(globalThis as typeof globalThis & { ashPermissionPrompt?: MessageBoxOptions }).ashPermissionPrompt = options;
				return { response: 1, checkboxChecked: false };
			}
			return args.length === 1 ? showMessageBox(args[0]) : showMessageBox(args[0], args[1]);
		}) as typeof dialog.showMessageBox;
	}, testWorkspace.directory);

	await workbench.page.getByRole('button', { name: /^(Open Folder|打开文件夹)$/ }).click();
	await expect.poll(() => application.evaluate(() => (globalThis as typeof globalThis & { ashPermissionPrompt?: MessageBoxOptions }).ashPermissionPrompt)).toMatchObject({
		message: '是否信任此文件夹中的文件？',
		buttons: ['信任文件夹并启用开发功能', '以只读模式打开', '取消'],
		defaultId: 1,
		cancelId: 2,
	});
	const prompt = await application.evaluate(() => (globalThis as typeof globalThis & { ashPermissionPrompt?: MessageBoxOptions }).ashPermissionPrompt);
	expect(prompt?.detail).toContain(`文件夹：${testWorkspace.directory}`);
	expect(prompt?.detail).toContain('Ash 可以修改文件、运行命令');
	await expect.poll(async () => {
		const value = await workbench.page.evaluate(() => {
			const ipc = (globalThis as unknown as { ash: { ipcRenderer: { invoke(channel: string): Promise<unknown> } } }).ash.ipcRenderer;
			return ipc.invoke('ash:workspace:context:read');
		});
		return parseWorkspace(value).folders[0]?.uri.fsPath;
	}).toBe(testWorkspace.directory);
});
