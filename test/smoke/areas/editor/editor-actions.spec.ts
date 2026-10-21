import { expect, test } from '../../../automation/test.js';

test('editor color picker uses shared controls and applies one undoable color edit', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ workbench }) => {
	const page = workbench.page;
	await page.keyboard.press('ControlOrMeta+N');
	const editor = workbench.editors.groupAt(0).editor;
	await editor.waitForEditorFocus();
	await editor.waitForTypeInEditor('#ff000080');
	await workbench.quickaccess.runCommand('editor.action.showOrFocusStandaloneColorPicker');
	const picker = page.getByRole('dialog', { name: 'Color picker', exact: true });
	await expect(picker).toBeVisible();
	await expect(picker.getByRole('slider', { name: 'Saturation and brightness' })).toBeFocused();
	const hue = picker.getByRole('slider', { name: 'Hue', exact: true });
	await hue.focus();
	await hue.evaluate(element => {
		(element as HTMLInputElement).value = '119';
		element.dispatchEvent(new Event('input', { bubbles: true }));
	});
	await hue.press('ArrowRight');
	await expect(picker.getByRole('combobox', { name: 'Document color format' })).toHaveValue('#00ff0080');
	await picker.getByRole('button', { name: 'Apply', exact: true }).click();
	// Inline color decorators contribute visual spacing to rendered viewport text.
	await editor.waitForEditorContents(text => text.trim() === '#00ff0080');
	await expect(editor.input).toBeFocused();
	await page.keyboard.press('ControlOrMeta+z');
	await editor.waitForEditorContents(text => text.trim() === '#ff000080');
	await page.keyboard.press('ControlOrMeta+Shift+c');
	await expect(picker).toBeVisible();
	await page.keyboard.press('Alt+F1');
	const help = page.getByRole('dialog', { name: 'Accessibility Help', exact: true });
	await expect(help).toBeVisible();
	await expect(help.getByRole('textbox')).toHaveValue(/Document color format/u);
	await page.keyboard.press('Escape');
	await expect(picker.getByRole('slider', { name: 'Saturation and brightness' })).toBeFocused();
	await page.keyboard.press('Escape');
	await expect(picker).toBeHidden();
});

test('browser editor breadcrumbs start at the opened workspace and navigate its directories', { tag: ['@browser-ui'] }, async ({ target, workbench }) => {
	const page = workbench.page;
	const folderName = await page.evaluate(async () => {
		const storage = await navigator.storage.getDirectory();
		const folder = await storage.getDirectoryHandle(`breadcrumbs-${crypto.randomUUID()}`, { create: true });
		const source = await folder.getDirectoryHandle('src', { create: true });
		for (const [directory, name] of [[folder, 'main.ts'], [source, 'sibling.ts']] as const) {
			const file = await directory.getFileHandle(name, { create: true });
			const writer = await file.createWritable();
			await writer.write('const value = 1;');
			await writer.close();
		}
		Object.defineProperty(window, 'showDirectoryPicker', { configurable: true, value: async () => folder });
		return folder.name;
	});
	await workbench.editors.groupAt(0).welcome.getByRole('button', { name: 'Open folder', exact: true }).click();
	const explorer = page.locator('.ash-explorer');
	await explorer.getByRole('treeitem', { name: 'main.ts', exact: true }).dblclick();
	const group = workbench.editors.groupAt(0);
	const breadcrumbs = group.title.getByRole('navigation', { name: 'Editor breadcrumbs' });
	await expect(breadcrumbs.getByRole('button')).toHaveText([folderName, 'main.ts']);
	await breadcrumbs.getByRole('button').last().focus();
	await page.keyboard.press('Home');
	await expect(breadcrumbs.getByRole('button').first()).toBeFocused();
	await page.keyboard.press('Enter');
	const picker = page.locator('.ash-quick-pick');
	await expect(picker.getByRole('combobox')).toBeFocused();
	await picker.getByRole('combobox').fill('src');
	await picker.getByRole('combobox').press('Enter');
	await picker.getByRole('combobox').fill('sibling.ts');
	await page.keyboard.press('Enter');
	await expect(picker).toHaveCount(0);
	await expect(breadcrumbs.getByRole('button')).toHaveText([folderName, 'src', 'sibling.ts']);
});
