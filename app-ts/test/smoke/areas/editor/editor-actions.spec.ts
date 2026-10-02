import { expect, test } from '../../../automation/test.js';

test('opening find focuses its input and leaves editor text unchanged', async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== 'code', 'This scenario requires the Code product');
	const page = workbench.page;
	await page.keyboard.press('ControlOrMeta+N');
	const editor = workbench.editors.groupAt(0).editor;
	await editor.waitForEditorFocus();
	await editor.waitForTypeInEditor('alpha beta');
	await page.keyboard.press('ControlOrMeta+F');
	const dialog = workbench.editors.groupAt(0).content.getByRole('dialog', { name: 'Find and replace', exact: true });
	const input = dialog.getByRole('textbox', { name: 'Find', exact: true });
	await expect(input).toBeFocused();
	await page.keyboard.press('ControlOrMeta+A');
	await page.keyboard.insertText('beta');
	await expect(input).toHaveValue('beta');
	await editor.waitForEditorContents(contents => contents === 'alpha beta');
	await page.keyboard.press('Escape');
	await expect(dialog).toBeHidden();
	await expect(editor.input).toBeFocused();
});

test('closed find options show a checked button when toggled from the editor', async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== 'code', 'This scenario requires the Code product');
	const page = workbench.page;
	await page.keyboard.press('ControlOrMeta+N');
	const editor = workbench.editors.groupAt(0).editor;
	await editor.waitForEditorFocus();
	await editor.waitForTypeInEditor('alpha beta');
	await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Alt+c' : 'Alt+c');
	const options = workbench.editors.groupAt(0).content.getByRole('group', { name: 'Find options' });
	const matchCase = options.getByRole('button', { name: 'Match case', exact: true });
	await expect(options).toBeVisible();
	await expect(matchCase).toHaveAttribute('aria-pressed', 'true');
	await expect(matchCase).toHaveClass(/checked/u);
	await matchCase.hover();
	const checkedColor = await matchCase.evaluate(button => getComputedStyle(button).backgroundColor);
	expect(checkedColor).not.toBe('rgba(0, 0, 0, 0)');
	await matchCase.click();
	await expect(matchCase).toHaveAttribute('aria-pressed', 'false');
	await expect(matchCase).not.toHaveClass(/checked/u);
	await options.getByRole('button', { name: 'Match whole word', exact: true }).hover();
	await expect(matchCase).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
});

test('editor breadcrumbs use the base widget for keyboard focus and activation', async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== 'code', 'This scenario requires the Code product');
	const page = workbench.page;
	await page.keyboard.press('ControlOrMeta+N');
	const breadcrumbs = workbench.editors.groupAt(0).title.getByRole('navigation', { name: 'Editor breadcrumbs' });
	const current = breadcrumbs.getByRole('button').last();
	await expect(breadcrumbs.locator('.ash-breadcrumbs-widget')).toBeVisible();
	await current.focus();
	await current.press('Home');
	await page.keyboard.press('End');
	await expect(current).toBeFocused();
	await expect(current).toHaveClass(/focused/u);
	await current.press('Enter');
	await expect(current).toHaveAttribute('aria-pressed', 'true');
	await expect(current).toHaveClass(/selected/u);
	const focusStyle = await current.evaluate(element => ({
		outline: getComputedStyle(element).outlineStyle,
		color: getComputedStyle(element).color,
	}));
	expect(focusStyle.outline).toBe('solid');
	expect(focusStyle.color).not.toBe('rgba(0, 0, 0, 0)');
	for (const [theme, outlineColor] of [
		['Ash Light', 'rgb(0, 120, 212)'],
		['Ash High Contrast Dark', 'rgb(255, 255, 255)'],
		['Ash High Contrast Light', 'rgb(0, 0, 0)'],
	] as const) {
		await workbench.quickaccess.runCommand('workbench.action.selectTheme');
		const search = page.locator('.ash-quick-pick').getByRole('combobox');
		await search.fill(theme);
		await search.press('Enter');
		await expect(page.locator('.ash-quick-pick')).toHaveCount(0);
		await current.focus();
		await current.press('End');
		await expect(current).toHaveCSS('outline-color', outlineColor);
		await expect(current).toHaveCSS('outline-style', 'solid');
	}
	await page.keyboard.press('ControlOrMeta+W');
	await expect(breadcrumbs).toBeHidden();
});

test('browser editor breadcrumbs start at the opened workspace and navigate its directories', async ({ target, workbench }) => {
	test.skip(target.kind !== 'browser' || target.appServerMode !== 'disabled' || target.workbenchMode !== 'code', 'Requires the browser filesystem');
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

test('Code exposes editor view actions in the command palette', async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== 'code', 'This scenario requires the Code product');

	await workbench.page.keyboard.press('F1');
	const picker = workbench.page.locator('.ash-quick-pick');
	const colors = await picker.evaluate(element => {
		const initial = getComputedStyle(element).backgroundColor;
		(element as HTMLElement).style.setProperty('--ash-quick-input-background', '#123456');
		const overridden = getComputedStyle(element).backgroundColor;
		(element as HTMLElement).style.removeProperty('--ash-quick-input-background');
		return { initial, overridden, restored: getComputedStyle(element).backgroundColor };
	});
	expect(colors.initial).not.toBe('rgba(0, 0, 0, 0)');
	expect(colors.overridden).toBe('rgb(18, 52, 86)');
	expect(colors.restored).toBe(colors.initial);
	const query = picker.getByRole('combobox');
	for (const label of ['Toggle Minimap', 'Toggle Render Whitespace', 'Toggle Control Characters', 'View: Toggle Word Wrap', 'Go to Line/Column...']) {
		await query.fill(label);
		await expect(picker.locator('.ash-quick-pick-row-label').filter({ hasText: label })).toBeVisible();
	}
});
