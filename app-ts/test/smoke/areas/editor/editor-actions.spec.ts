import { expect, test } from '../../../automation/test.js';

test('closed find options show a checked button when toggled from the editor', async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== 'code', 'This scenario requires the Code product');
	const page = workbench.page;
	await page.keyboard.press('ControlOrMeta+N');
	const input = workbench.editors.groupAt(0).content.locator('.stanza-editor-input');
	await expect(input).toBeAttached();
	await input.focus();
	await input.type('alpha beta');
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
		await page.getByRole('button', { name: 'Manage', exact: true }).click();
		await page.getByRole('menu').last().getByRole('menuitem', { name: 'Themes', exact: true }).hover();
		await page.getByRole('menu').last().getByRole('menuitem', { name: 'Color Theme', exact: true }).click();
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
