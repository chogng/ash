import { tmpdir } from 'node:os';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
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
		await page.getByRole('dialog', { name: 'Ash', exact: true }).getByRole('button', { name: 'Trust Folder', exact: true }).click();
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
		const emptyConfiguration = JSON.stringify({ folders: [], settings: { 'editor.tabSize': 3 } });
		// Replacing a document is a paste; typing its opening brace surrounds the selection.
		await editor.input.evaluate((element, text) => {
			const clipboardData = new DataTransfer();
			clipboardData.setData('text/plain', text);
			element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
		}, emptyConfiguration);
		await editor.waitForEditorContents(text => text === emptyConfiguration);
		await page.keyboard.press('ControlOrMeta+s');
		await expect.poll(async () => (await workspace(page)).folders.length).toBe(0);
		await writeFile(saved, JSON.stringify({ folders: reordered.folders.filter(folder => folder.name === 'Server'), settings: { 'editor.tabSize': 3 } }));
		await expect.poll(async () => (await workspace(page)).folders.map(folder => folder.name)).toEqual(['Server']);
		const terminalCount = await workbench.terminal.instances.count();
		await page.getByRole('button', { name: 'New Terminal', exact: true }).click();
		await expect(workbench.terminal.instances).toHaveCount(terminalCount + 1);
		await workbench.terminal.runCommand(`node -e "console.log(['restored','root'].join('-')+'='+process.cwd())"`);
		await expect(workbench.terminal.activeInstance.locator('.xterm-rows')).toContainText(`restored-root=${second}`);
		await testInfo.attach('local-multi-root', { body: await page.screenshot(), contentType: 'image/png' });
	} finally {
		await electron.evaluate(({ dialog }, original) => { dialog.showOpenDialog = original.open; dialog.showSaveDialog = original.save; }, originals);
		await originals.dispose();
	}
	({ application, workbench } = await reloadWorkbench());
	// The fixture relaunches with the original folder argument. Reopen the saved
	// workspace explicitly, as opening its file after restarting the application.
	await (application as ElectronApplication).evaluate(({ app }, file) => {
		app.emit('second-instance', {} as never, [process.execPath, app.getAppPath(), '--workspace', file, '--reuse-window'], process.cwd(), {});
	}, saved);
	await expect.poll(async () => (await workspace(workbench.page)).configuration?.fsPath).toBe(saved);
	await workbench.waitForReady();
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

test.describe('Workspace menu entrypoints', () => {
	test.use({ electronUserSettings: { 'window.menuStyle': 'custom' } });

	test('File and Explorer menus edit the targeted workspace root through App Server', { tag: ['@electron-app-server'] }, async ({ application, workbench }, testInfo) => {
		test.setTimeout(180_000);
		const electron = application as ElectronApplication;
		const page = workbench.page;
		const fixture = await realpath(await mkdtemp(join(tmpdir(), 'ash-workspace-menu-')));
		const second = join(fixture, 'server');
		const saved = join(fixture, 'saved', 'menu-team.ash-workspace');
		await mkdir(second, { recursive: true });
		await writeFile(join(second, 'kept.txt'), 'removing a workspace root keeps this file\n');
		const original = await electron.evaluateHandle(({ dialog }) => ({ open: dialog.showOpenDialog, save: dialog.showSaveDialog }));
		await electron.evaluate(({ dialog }, paths) => {
			dialog.showOpenDialog = (async () => {
				const state = globalThis as typeof globalThis & { workspacePickerCalls?: number; };
				state.workspacePickerCalls = (state.workspacePickerCalls ?? 0) + 1;
				return { canceled: false, filePaths: [paths.second] };
			}) as typeof dialog.showOpenDialog;
			dialog.showSaveDialog = (async () => ({ canceled: false, filePath: paths.saved })) as typeof dialog.showSaveDialog;
		}, { second, saved });
		const openFileMenu = async () => {
			await page.getByRole('button', { name: 'Application menu', exact: true }).click();
			await page.getByRole('menu').first().getByRole('menuitem', { name: 'File', exact: true }).click();
			return page.getByRole('menu').last();
		};
		const runFileMenu = async (label: string) => {
			if (process.platform === 'darwin') {
				await expect.poll(() => electron.evaluate(({ Menu }, label) => Menu.getApplicationMenu()?.items.find(item => item.label === 'File')?.submenu?.items.find(item => item.label === label)?.enabled, label)).toBe(true);
				await electron.evaluate(({ Menu }, label) => {
					Menu.getApplicationMenu()!.items.find(item => item.label === 'File')!.submenu!.items.find(item => item.label === label)!.click({ altKey: false });
				}, label);
			} else {
				await (await openFileMenu()).getByRole('menuitem', { name: label, exact: true }).click();
			}
		};
		const rootRow = (uri: string) => page.locator('.ash-explorer .ash-tree-row').filter({ has: page.locator(`[data-resource=${JSON.stringify(uri)}]`) });
		try {
			await runFileMenu('Add Folder to Workspace...');
			await page.getByRole('dialog', { name: 'Ash', exact: true }).getByRole('button', { name: 'Trust Folder', exact: true }).click();
			await expect.poll(async () => (await workspace(page)).folders.length).toBe(2);
			const roots = (await workspace(page)).folders;
			const secondRoot = roots[1]!;
			const secondRow = rootRow(secondRoot.uri.toString());
			await expect(secondRow).toBeVisible();
			const rootMenu = await workbench.menus.inspect(application, () => secondRow.click({ button: 'right' }));
			expect(rootMenu).toEqual(expect.arrayContaining([
				expect.objectContaining({ label: 'Add Folder to Workspace...', enabled: true }),
				expect.objectContaining({ label: 'Remove Folder from Workspace...', enabled: true }),
			]));
			if (await secondRow.getAttribute('aria-expanded') === 'false') await secondRow.locator('.ash-tree-twistie').click();
			const file = page.locator('.ash-explorer .ash-tree-row').filter({ hasText: 'kept.txt' });
			await expect(file).toBeVisible();
			const fileMenu = await workbench.menus.inspect(application, () => file.click({ button: 'right' }));
			expect(fileMenu.map(item => item.label)).not.toContain('Remove Folder from Workspace...');
			expect(fileMenu.map(item => item.label)).not.toContain('Add Folder to Workspace...');
			// Keyboard context menus must carry the focused root, independently of the active editor.
			await secondRow.click();
			await secondRow.press('Shift+F10');
			const menu = page.getByRole('menu').last();
			await expect(menu.getByRole('menuitem', { name: 'Remove Folder from Workspace...', exact: true })).toBeVisible();
			await testInfo.attach('workspace-root-keyboard-menu', { body: await page.screenshot(), contentType: 'image/png' });
			await menu.getByRole('menuitem', { name: 'Remove Folder from Workspace...', exact: true }).click();
			await expect.poll(async () => (await workspace(page)).folders.map(folder => folder.id)).toEqual([roots[0]!.id]);
			expect(await readFile(join(second, 'kept.txt'), 'utf8')).toContain('keeps this file');
			await expect(page.locator('.ash-quick-pick')).not.toBeVisible();
			await workbench.menus.select(application, () => rootRow(roots[0]!.uri.toString()).click({ button: 'right' }), ['Add Folder to Workspace...']);
			await expect.poll(() => electron.evaluate(() => (globalThis as typeof globalThis & { workspacePickerCalls?: number; }).workspacePickerCalls)).toBe(2);
			await expect.poll(async () => (await workspace(page)).folders.length).toBe(2);
			await runFileMenu('Remove Folder from Workspace...');
			await expect(page.locator('.ash-quick-pick')).toBeVisible();
			await page.keyboard.press('Escape');
			expect((await workspace(page)).folders).toHaveLength(2);
			await runFileMenu('Save Workspace As...');
			await expect.poll(async () => (await workspace(page)).configuration?.fsPath).toBe(saved);
			expect(JSON.parse(await readFile(saved, 'utf8')).folders).toHaveLength(2);
			await runFileMenu('Close Workspace');
			await expect.poll(async () => (await workspace(page)).folders.length).toBe(0);
			await workbench.waitForReady();
			await electron.evaluate(({ dialog }, saved) => {
				dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [saved] })) as typeof dialog.showOpenDialog;
			}, saved);
			await runFileMenu('Open Workspace from File...');
			await expect.poll(async () => (await workspace(page)).configuration?.fsPath).toBe(saved);
			await expect.poll(async () => (await workspace(page)).folders.map(folder => folder.id)).toEqual(roots.map(folder => folder.id));
			await testInfo.attach('workspace-menus-reopened', { body: await page.screenshot(), contentType: 'image/png' });
		} finally {
			await electron.evaluate(({ dialog }, original) => { dialog.showOpenDialog = original.open; dialog.showSaveDialog = original.save; }, original);
			await original.dispose();
			await rm(fixture, { recursive: true, force: true });
		}
	});
});
