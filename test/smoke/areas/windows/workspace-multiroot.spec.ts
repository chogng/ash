import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ElectronApplication, Page } from '@playwright/test';
import { expect, test } from '../../../automation/test.js';
import { parseWorkspace } from '../../../../src/ash/platform/workspace/common/workspace.js';

async function workspace(page: Page) {
	return parseWorkspace(await page.evaluate(() => (globalThis as unknown as {
		ash: { ipcRenderer: { invoke(channel: string): Promise<unknown>; }; };
	}).ash.ipcRenderer.invoke('ash:workspace:context:read')));
}

test('local multi-root commands, live folders and retained second-root terminals work through App Server', { tag: ['@electron-app-server'] }, async ({ application, workbench, testWorkspace, reloadWorkbench }, testInfo) => {
	test.setTimeout(180_000);
	const electron = application as ElectronApplication;
	const second = testInfo.outputPath('second-root');
	const saved = testInfo.outputPath('saved', 'team.ash-workspace');
	await mkdir(join(second, '.vscode'), { recursive: true });
	await writeFile(join(second, 'second.txt'), 'second_root_search_token\n');
	const platform = process.platform === 'darwin' ? 'osx' : process.platform === 'win32' ? 'windows' : 'linux';
	await writeFile(join(second, '.vscode', 'settings.json'), JSON.stringify({ 'terminal.integrated.cwd': '${workspaceFolder}' }));
	const originals = await electron.evaluateHandle(({ dialog }) => ({ open: dialog.showOpenDialog, save: dialog.showSaveDialog }));
	await electron.evaluate(({ dialog }, paths) => {
		dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [paths.second] })) as typeof dialog.showOpenDialog;
		dialog.showSaveDialog = (async () => ({ canceled: false, filePath: paths.saved })) as typeof dialog.showSaveDialog;
	}, { second, saved });
	try {
		const page = workbench.page;
		await page.locator('.ash-explorer .ash-tree-row').filter({ hasText: 'main.ts' }).dblclick();
		const editor = workbench.editors.groupAt(0).editor;
		await editor.waitForEditorFocus();
		await page.keyboard.press('ControlOrMeta+End');
		await page.keyboard.insertText('// kept across workspace creation');
		await workbench.quickaccess.runCommand('workbench.action.addRootFolder');
		await page.getByRole('dialog', { name: 'Ash', exact: true }).getByRole('button', { name: 'Trust Folder & Enable Features', exact: true }).click();
		await expect.poll(async () => (await workspace(page)).folders.length).toBe(2);
		await editor.waitForEditorContents(text => text.includes('kept across workspace creation'));
		await editor.waitForEditorFocus();
		await page.keyboard.press('ControlOrMeta+s');
		await expect.poll(() => readFile(testWorkspace.file, 'utf8')).toContain('kept across workspace creation');
		await workbench.quickaccess.runCommand('workbench.action.saveWorkspaceAs');
		await expect.poll(async () => (await workspace(page)).configuration?.fsPath).toBe(saved);
		const contents = JSON.parse(await readFile(saved, 'utf8')) as { folders: { path: string; name: string; }[]; settings?: unknown; };
		expect(contents.folders).toHaveLength(2);
		// Environment settings belong to the workspace scope in VS Code. Their
		// variable expansion still follows the terminal's selected directory.
		contents.settings = { [`terminal.integrated.env.${platform}`]: { ASH_SELECTED_ROOT: '${workspaceFolder}' } };
		await writeFile(saved, JSON.stringify(contents, null, 2));
		const root = page.locator('.ash-explorer .ash-tree-row').filter({ has: page.locator(`[data-resource="${pathToFileURL(second).toString()}"]`) });
		await expect(root).toBeVisible();
		if (await root.getAttribute('aria-expanded') === 'false') await root.locator('.ash-tree-twistie').click();
		await page.locator('.ash-explorer .ash-tree-row').filter({ hasText: 'second.txt' }).dblclick();
		await editor.waitForEditorContents(text => text.includes('second_root_search_token'));
		await editor.waitForEditorFocus();
		await page.keyboard.press('ControlOrMeta+End');
		await page.keyboard.insertText('second_root_saved\n');
		await page.keyboard.press('ControlOrMeta+s');
		await expect.poll(() => readFile(join(second, 'second.txt'), 'utf8')).toContain('second_root_saved');
		await workbench.terminal.show();
		await workbench.terminal.runCommand(`node -e "console.log('SELECTED='+process.cwd());console.log('ENV='+process.env.ASH_SELECTED_ROOT)"`);
		await expect(workbench.terminal.activeInstance.locator('.xterm-rows')).toContainText(`SELECTED=${second}`);
		await expect(workbench.terminal.activeInstance.locator('.xterm-rows')).toContainText(`ENV=${second}`);
		const reordered = { ...contents, folders: contents.folders.map((folder, index) => ({ ...folder, name: index === 0 ? 'Client' : 'Server' })).reverse() };
		await writeFile(saved, JSON.stringify(reordered, null, 2));
		await expect.poll(async () => (await workspace(page)).folders.map(folder => folder.name)).toEqual(['Server', 'Client']);
		await workbench.quickaccess.runCommand('workbench.action.removeRootFolder');
		await workbench.quickaccess.select('Client');
		await expect.poll(async () => (await workspace(page)).folders.map(folder => folder.name)).toEqual(['Server']);
		await workbench.terminal.runCommand(`node -e "console.log(['retained','second','root'].join('-'))"`);
		await expect(workbench.terminal.activeInstance.locator('.xterm-rows')).toContainText('retained-second-root');
		await workbench.quickaccess.runCommand('workbench.action.openWorkspaceConfigFile');
		await editor.waitForEditorContents(text => text.includes('Server'));
		await editor.waitForEditorFocus();
		await page.keyboard.press('ControlOrMeta+a');
		await page.keyboard.insertText(JSON.stringify({ folders: [], settings: { 'editor.tabSize': 3 } }));
		await page.keyboard.press('ControlOrMeta+s');
		await expect.poll(async () => (await workspace(page)).folders.length).toBe(0);
		await writeFile(saved, JSON.stringify({ folders: reordered.folders.filter(folder => folder.name === 'Server'), settings: { 'editor.tabSize': 3 } }));
		await expect.poll(async () => (await workspace(page)).folders.map(folder => folder.name)).toEqual(['Server']);
		await testInfo.attach('local-multi-root', { body: await page.screenshot(), contentType: 'image/png' });
	} finally {
		await electron.evaluate(({ dialog }, original) => { dialog.showOpenDialog = original.open; dialog.showSaveDialog = original.save; }, originals);
		await originals.dispose();
	}
	({ application, workbench } = await reloadWorkbench());
	expect((await workspace(workbench.page)).folders.map(folder => folder.name)).toEqual(['Server']);
	expect((await workspace(workbench.page)).configuration?.fsPath).toBe(saved);
});

test('local workspace management commands are translated in Chinese', { tag: ['@electron-app-server'] }, async ({ application, workbench, restartWorkbench }) => {
	await workbench.quickaccess.runCommand('workbench.action.configureLocale');
	const language = workbench.page.getByRole('dialog', { name: 'Select Display Language' }).getByRole('combobox');
	await language.fill('简体中文');
	await language.press('Enter');
	({ application, workbench } = await restartWorkbench());
	await workbench.quickaccess.open('>workbench.action.addRootFolder');
	await expect(workbench.quickaccess.items).toContainText('将文件夹添加到工作区');
	await workbench.quickaccess.close();
	await workbench.quickaccess.open('>workbench.action.saveWorkspaceAs');
	await expect(workbench.quickaccess.items).toContainText('将工作区另存为');
	await workbench.quickaccess.close();
});
