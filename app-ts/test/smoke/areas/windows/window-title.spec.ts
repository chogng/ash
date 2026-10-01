import { readFile } from 'node:fs/promises';
import { expect, test } from '../../../automation/test.js';

test.beforeEach(async ({ workbench }) => {
	await workbench.page.keyboard.press('F1');
	const command = workbench.page.locator('.ash-quick-pick').getByRole('combobox');
	await command.fill('Close All Editors');
	await command.press('Enter');
	await expect(workbench.editors.groupAt(0).tabs).toHaveCount(0);
});

test('window title follows the active editor, unsaved changes, restored content and close', async ({ target, application, workbench }) => {
	test.skip(target.workbenchMode !== 'code', 'This scenario uses Code text editors');
	const page = workbench.page;
	const workspaceTitle = await page.title();
	expect(workspaceTitle).toMatch(/Ash Code$/u);
	await workbench.editors.newUntitledFile();
	await expect(page).toHaveTitle(`Untitled-1 — ${workspaceTitle}`);
	const input = workbench.editors.groupAt(0).content.locator('.stanza-editor-input');
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
	await workbench.editors.newUntitledFile();
	await expect(page).toHaveTitle(`Untitled-2 — ${workspaceTitle}`);
	await page.keyboard.press('ControlOrMeta+W');
	await expect(page).toHaveTitle(`Untitled-1 — ${workspaceTitle}`);
	await page.keyboard.press('ControlOrMeta+W');
	await expect(page).toHaveTitle(workspaceTitle);
});

test('detached editor titles follow their own window when focus and dirty state change', async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== 'code', 'This scenario uses Code text editors');
	const page = workbench.page;
	const workspaceTitle = await page.title();
	await workbench.editors.newUntitledFile();
	await expect(page).toHaveTitle(`Untitled-1 — ${workspaceTitle}`);
	await workbench.editors.newUntitledFile();
	await expect(page).toHaveTitle(`Untitled-2 — ${workspaceTitle}`);
	await page.keyboard.press('F1');
	const command = page.locator('.ash-quick-pick').getByRole('combobox');
	await command.fill('Move Editor into New Window');
	const opened = page.context().waitForEvent('page');
	await command.press('Enter');
	const popup = await opened;
	try {
		await expect(popup).toHaveTitle(`Untitled-2 — ${workspaceTitle}`);
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
		await expect(workbench.editors.groupAt(0).tabs).toHaveCount(2);
		await workbench.editors.newUntitledFile();
		await expect(page).toHaveTitle(`Untitled-3 — ${workspaceTitle}`);
	} finally {
		if (!popup.isClosed()) {
			await popup.close();
		}
	}
});

test('saving a workspace file clears the window title dirty marker', async ({ target, testWorkspace, workbench }) => {
	test.skip(target.appServerMode !== 'required' || target.workbenchMode !== 'code', 'This scenario requires the Code App Server product');
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
