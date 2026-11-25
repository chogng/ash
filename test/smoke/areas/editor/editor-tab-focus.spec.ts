import { expect, test } from '../../../automation/test.js';
import { writeFile } from 'node:fs/promises';

test('Tab focus mode moves focus past active suggestions and snippet placeholders', { tag: '@electron-app-server' }, async ({ workbench, testWorkspace }) => {
	const page = workbench.page;
	await writeFile(testWorkspace.file, 'forof');
	await workbench.openExplorer();
	await page.locator('.ash-explorer').getByRole('treeitem', { name: 'main.ts', exact: true }).dblclick();
	const editor = workbench.editors.groupAt(0).editor;
	await editor.waitForEditorFocus();
	await expect(editor.lines).toHaveText(['forof']);
	await page.keyboard.press('End');
	const suggestion = page.getByRole('option').filter({ hasText: 'For-Of Loop' });
	await page.keyboard.press('Control+Space');
	await expect(suggestion).toHaveAttribute('aria-selected', 'true');
	await page.keyboard.press('Tab');
	await expect(editor.lines.first()).toHaveText('for (const element of object) {');
	await expect(editor.input).toBeFocused();
	await editor.input.press('ControlOrMeta+z');
	await expect(editor.lines).toHaveText(['forof']);

	await workbench.quickaccess.runCommand('editor.action.toggleTabFocusMode');
	await editor.waitForEditorFocus();
	await page.keyboard.press('Control+Space');
	await expect(suggestion).toHaveAttribute('aria-selected', 'true');
	await page.keyboard.press('Tab');
	await expect(editor.input).not.toBeFocused();
	await expect(editor.lines).toHaveText(['forof']);

	await editor.waitForEditorFocus();
	await page.keyboard.press('Control+Space');
	await expect(suggestion).toHaveAttribute('aria-selected', 'true');
	await page.keyboard.press('Enter');
	await expect(editor.lines.first()).toHaveText('for (const element of object) {');
	await editor.input.press('Tab');
	await expect(editor.input).not.toBeFocused();
	await editor.input.press('Shift+Tab');
	await expect(editor.input).not.toBeFocused();
	await editor.input.focus();
	await page.keyboard.insertText('entry');
	await expect(editor.lines.first()).toHaveText('for (const entry of object) {');
});
