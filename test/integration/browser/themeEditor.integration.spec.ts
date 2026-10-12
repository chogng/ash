import { test, expect, type Page } from '@playwright/test';

async function openEditor(page: Page, locale?: string, theme?: string): Promise<Page> {
	page.on('pageerror', error => console.error('Theme Editor fixture:', error.message));
	await page.goto('/themeEditor.html' + (locale ? '?locale=' + locale : ''));
	await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
	if (theme) await page.evaluate(id => window.themeEditorTest.selectTheme(id), theme);
	const [popup] = await Promise.all([page.waitForEvent('popup'), page.locator('#open').click()]);
	await expect(popup.locator('.ash-theme-editor')).toBeVisible();
	await expect(popup.locator('.ash-theme-editor-message')).not.toHaveClass(/error/);
	await expect.poll(() => popup.locator('.ash-theme-editor-json .stanza-editor-pane').evaluate(element => element.clientHeight)).toBeGreaterThan(200);
	const colors = await popup.locator('.ash-theme-editor-colors').boundingBox();
	const json = await popup.locator('.ash-theme-editor-json').boundingBox();
	expect(json!.x).toBeGreaterThanOrEqual(colors!.x + colors!.width - 1);
	expect(Math.abs(json!.y - colors!.y)).toBeLessThan(1);
	return popup;
}

test('auxiliary Theme Editor edits the shared JSON and previews the main window without saving', async ({ page }, testInfo) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	const popup = await openEditor(page);
	popup.on('pageerror', error => errors.push(error.message));
	await popup.getByRole('searchbox', { name: 'Search colors' }).fill('editor.background');
	const hex = popup.getByRole('textbox', { name: 'Hex color for editor.background', exact: true });
	await hex.fill('#112233');
	await expect.poll(() => page.locator('#main').evaluate(element => element.style.getPropertyValue('--ash-editor-background'))).toBe('#112233');
	const source = await page.evaluate(() => window.themeEditorTest.source());
	expect(source).toContain('// keep this comment');
	expect(source).toContain('"#112233"');
	expect(source).not.toContain('"statusBar.background"');
	expect(await page.evaluate(() => window.themeEditorTest.persisted())).toContain('"#101525"');
	await popup.screenshot({ path: testInfo.outputPath('theme-editor.png') });
	await page.evaluate(() => window.themeEditorTest.undo());
	await expect.poll(() => hex.inputValue()).toBe('#101525');
	await hex.fill('#223344');
	await expect.poll(() => page.locator('#main').evaluate(element => element.style.getPropertyValue('--ash-editor-background'))).toBe('#223344');
	await popup.getByRole('button', { name: 'Live preview', exact: true }).click();
	await expect.poll(() => page.locator('#main').evaluate(element => element.style.getPropertyValue('--ash-editor-background'))).toBe('#101525');
	await popup.getByRole('button', { name: 'Live preview', exact: true }).click();
	await expect.poll(() => page.locator('#main').evaluate(element => element.style.getPropertyValue('--ash-editor-background'))).toBe('#223344');
	await popup.getByRole('button', { name: 'Save', exact: true }).click();
	await expect.poll(() => page.evaluate(() => window.themeEditorTest.persisted())).toContain('#223344');
	await page.evaluate(() => window.themeEditorTest.close());
	await expect.poll(() => popup.isClosed()).toBe(true);
	expect(errors).toEqual([]);
});

test('shared color picker edits alpha and formats, follows JSON and Undo, and restores keyboard focus', async ({ page }, testInfo) => {
	const popup = await openEditor(page);
	await popup.getByRole('searchbox', { name: 'Search colors' }).fill('editor.background');
	const swatch = popup.getByRole('button', { name: 'Choose color for editor.background', exact: true });
	await swatch.focus();
	await swatch.press('Enter');
	const picker = popup.getByRole('dialog', { name: 'Color picker', exact: true });
	const value = picker.getByRole('textbox', { name: 'Color value', exact: true });
	const area = picker.getByRole('slider', { name: 'Saturation and brightness', exact: true });
	await expect(area).toBeFocused();
	await expect(swatch).toHaveAttribute('aria-expanded', 'true');
	await expect(value).toHaveValue('101525');
	await expect(picker).toHaveCSS('background-color', 'rgb(37, 37, 38)');
	const opacity = picker.getByRole('spinbutton', { name: 'Opacity (%)', exact: true });
	await opacity.fill('50');
	await opacity.press('Enter');
	const hex = popup.getByRole('textbox', { name: 'Hex color for editor.background', exact: true });
	await expect(hex).toHaveValue('#10152580');
	await value.fill('336699');
	await value.press('Enter');
	await expect(hex).toHaveValue('#33669980');
	await expect.poll(() => page.locator('#main').evaluate(element => element.style.getPropertyValue('--ash-editor-background'))).toBe('rgba(51, 102, 153, 0.5)');
	await page.evaluate(() => window.themeEditorTest.undo());
	await expect(hex).toHaveValue('#10152580');
	await expect(value).toHaveValue('101525');
	const source = await page.evaluate(() => window.themeEditorTest.source());
	await page.evaluate(text => window.themeEditorTest.setSource(text.replace('#10152580', '#abcdef40')), source);
	await expect(value).toHaveValue('ABCDEF');
	await expect(opacity).toHaveValue('25.1');
	await picker.getByRole('combobox', { name: 'Color format' }).selectOption('rgb');
	const blue = picker.getByRole('spinbutton', { name: 'RGB B', exact: true });
	await blue.fill('12');
	await blue.press('Enter');
	await expect(hex).toHaveValue('#abcd0c40');
	await popup.bringToFront();
	await area.focus();
	await popup.keyboard.press('Alt+F1');
	const help = popup.getByRole('dialog', { name: 'Accessibility Help', exact: true });
	await expect(help.getByRole('textbox')).toHaveValue(/Left and Right adjust saturation/u);
	await popup.keyboard.press('Escape');
	await expect(area).toBeFocused();
	await popup.keyboard.press('Alt+F2');
	const accessible = popup.getByRole('dialog', { name: 'Accessible View', exact: true });
	await expect(accessible.getByRole('textbox')).toHaveValue(/RGB: 171, 205, 12/u);
	await popup.keyboard.press('Escape');
	await expect(area).toBeFocused();
	await area.press('ArrowLeft');
	await expect.poll(() => hex.inputValue()).not.toBe('#abcd0c40');
	await popup.screenshot({ path: testInfo.outputPath('theme-editor-color-picker.png') });
	await popup.keyboard.press('Escape');
	await expect(picker).not.toBeVisible();
	await expect(swatch).toBeFocused();
	await expect(swatch).toHaveAttribute('aria-expanded', 'false');
	await swatch.press('Space');
	await expect(picker).toBeVisible();
	await popup.getByRole('searchbox', { name: 'Search colors' }).click();
	await expect(picker).not.toBeVisible();
	await swatch.click();
	await picker.getByRole('button', { name: 'Close', exact: true }).click();
	await expect(picker).not.toBeVisible();
	await expect(swatch).toBeFocused();
});

test('shared color picker keeps dragging across preview refreshes', async ({ page }) => {
	const popup = await openEditor(page);
	await popup.getByRole('searchbox', { name: 'Search colors' }).fill('editor.background');
	await popup.getByRole('button', { name: 'Choose color for editor.background', exact: true }).click();
	const area = popup.getByRole('dialog', { name: 'Color picker', exact: true }).getByRole('slider', { name: 'Saturation and brightness', exact: true });
	const bounds = (await area.boundingBox())!;
	const hex = popup.getByRole('textbox', { name: 'Hex color for editor.background', exact: true });
	await popup.mouse.move(bounds.x + bounds.width * 0.2, bounds.y + bounds.height * 0.2);
	await popup.mouse.down();
	await expect.poll(() => hex.inputValue()).not.toBe('#101525');
	const first = await hex.inputValue();
	await popup.mouse.move(bounds.x + bounds.width * 0.8, bounds.y + bounds.height * 0.7);
	await expect.poll(() => hex.inputValue()).not.toBe(first);
	await popup.mouse.up();
	await expect(area).toBeFocused();
	await popup.getByRole('searchbox', { name: 'Search colors' }).fill('sideBar.background');
	await expect(popup.getByRole('dialog', { name: 'Color picker', exact: true })).not.toBeVisible();
});

for (const [theme, scheme] of [['ash-high-contrast-dark', 'hcDark'], ['ash-high-contrast-light', 'hcLight']] as const) {
	test(`shared color picker inherits ${theme} and keeps keyboard focus visible`, async ({ page }) => {
		const popup = await openEditor(page, undefined, theme);
		await popup.getByRole('searchbox', { name: 'Search colors' }).fill('editor.background');
		await popup.getByRole('button', { name: 'Choose color for editor.background', exact: true }).click();
		const picker = popup.getByRole('dialog', { name: 'Color picker', exact: true });
		await expect(picker).toHaveAttribute('data-color-scheme', scheme);
		await expect(picker).toHaveCSS('box-shadow', 'none');
		await expect(picker).toHaveCSS('border-style', 'solid');
		const area = picker.getByRole('slider', { name: 'Saturation and brightness', exact: true });
		await area.press('ArrowRight');
		await expect(area).toBeFocused();
		await expect(area).toHaveCSS('outline-style', 'solid');
	});
}

test('JSON updates colors, rejects invalid saves, retains valid preview and resets overrides', async ({ page }) => {
	const popup = await openEditor(page);
	await popup.getByRole('searchbox', { name: 'Search colors' }).fill('editor.background');
	const source = await page.evaluate(() => window.themeEditorTest.source());
	const candidate = source.replace('#101525', '#abcdef80');
	await page.evaluate(text => window.themeEditorTest.setSource(text), candidate);
	await expect(popup.getByRole('textbox', { name: 'Hex color for editor.background', exact: true })).toHaveValue('#abcdef80');
	await page.evaluate(() => window.themeEditorTest.setSource('{"colors":'));
	await expect(popup.locator('.ash-theme-editor-message')).toHaveClass(/error/);
	await expect.poll(() => page.locator('#main').evaluate(element => element.style.getPropertyValue('--ash-editor-background'))).toBe('rgba(171, 205, 239, 0.5)');
	await popup.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(popup.locator('.ash-theme-editor-message')).toContainText('Could not save');
	expect(await page.evaluate(() => window.themeEditorTest.persisted())).toContain('#101525');
	await page.evaluate(text => window.themeEditorTest.setSource(text), candidate);
	await expect(popup.getByRole('button', { name: 'Remove the override for editor.background', exact: true })).toBeEnabled();
	await popup.getByRole('button', { name: 'Remove the override for editor.background', exact: true }).click();
	await expect.poll(() => page.evaluate(() => window.themeEditorTest.source())).not.toContain('"editor.background"');
});

test('Save as runs inside the auxiliary window and persists a selectable user theme', async ({ page }) => {
	const popup = await openEditor(page);
	await popup.getByRole('searchbox', { name: 'Search colors' }).fill('editor.background');
	await popup.getByRole('textbox', { name: 'Hex color for editor.background', exact: true }).fill('#334455');
	await popup.getByRole('button', { name: 'Save as…', exact: true }).click();
	const dialog = popup.getByRole('dialog', { name: 'Save as…' });
	await expect(dialog).toBeVisible();
	await dialog.getByRole('textbox', { name: 'Theme name' }).fill('New Aurora');
	await dialog.getByRole('button', { name: 'Save', exact: true }).click();
	await expect.poll(() => page.evaluate(() => window.themeEditorTest.persisted('new-aurora.json'))).toContain('#334455');
	await expect(popup.getByRole('tab', { name: 'new-aurora.json', exact: true })).toBeVisible();
	expect(await page.evaluate(() => window.themeEditorTest.persisted())).toContain('#101525');
	await expect(popup.locator('.ash-theme-editor-message')).not.toHaveClass(/error/);
	await page.evaluate(() => window.themeEditorTest.close());
	await expect.poll(() => page.locator('#main').evaluate(element => element.style.getPropertyValue('--ash-editor-background'))).toBe('#334455');
});

test('Chinese labels and keyboard color adjustment work in the auxiliary window', async ({ page }) => {
	const popup = await openEditor(page, 'zh-CN');
	await expect(popup.getByRole('heading', { name: '主题编辑器', exact: true })).toBeVisible();
	await popup.getByRole('searchbox', { name: '搜索颜色' }).fill('editor.background');
	const slider = popup.getByRole('slider', { name: 'editor.background 的不透明度', exact: true });
	await slider.focus();
	await slider.press('ArrowLeft');
	await expect.poll(() => page.evaluate(() => window.themeEditorTest.source())).toContain('#101525fc');
	await expect(slider).toBeFocused();
	await expect.poll(() => slider.evaluate(element => getComputedStyle(element).outlineStyle)).toBe('solid');
	const swatch = popup.getByRole('button', { name: '为 editor.background 选择颜色', exact: true });
	await swatch.focus();
	await swatch.press('Enter');
	const picker = popup.getByRole('dialog', { name: '颜色选择器', exact: true });
	await expect(picker.getByRole('slider', { name: '饱和度和亮度', exact: true })).toBeFocused();
	const value = picker.getByRole('textbox', { name: '颜色值', exact: true });
	await value.fill('224466');
	await value.press('Enter');
	await expect(popup.getByRole('textbox', { name: 'editor.background 的十六进制颜色', exact: true })).toHaveValue('#224466fc');
	await popup.keyboard.press('Escape');
	await expect(picker).not.toBeVisible();
	await expect(swatch).toBeFocused();
	await popup.getByRole('button', { name: '另存为…', exact: true }).click();
	await expect(popup.getByRole('dialog', { name: '另存为…' })).toBeVisible();
	await popup.keyboard.press('Escape');
	await expect(popup.getByRole('dialog')).not.toBeVisible();
});

test('closing an unsaved preview restores the main window and leaves the theme file unchanged', async ({ page }) => {
	const popup = await openEditor(page);
	await popup.getByRole('searchbox', { name: 'Search colors' }).fill('editor.background');
	await popup.getByRole('textbox', { name: 'Hex color for editor.background', exact: true }).fill('#556677');
	await expect.poll(() => page.locator('#main').evaluate(element => element.style.getPropertyValue('--ash-editor-background'))).toBe('#556677');
	await page.evaluate(() => window.themeEditorTest.close());
	await expect.poll(() => popup.isClosed()).toBe(true);
	await expect.poll(() => page.locator('#main').evaluate(element => element.style.getPropertyValue('--ash-editor-background'))).toBe('#101525');
	expect(await page.evaluate(() => window.themeEditorTest.persisted())).toContain('#101525');
});

test('editing a built-in theme creates an unsaved copy and Save writes it to user themes', async ({ page }) => {
	const popup = await openEditor(page, undefined, 'ash-dark');
	await expect(popup.locator('.ash-theme-editor-message')).not.toHaveClass(/error/);
	await popup.getByRole('searchbox', { name: 'Search colors' }).fill('editor.background');
	await popup.getByRole('textbox', { name: 'Hex color for editor.background', exact: true }).fill('#667788');
	await popup.getByRole('button', { name: 'Save', exact: true }).click();
	const dialog = popup.getByRole('dialog', { name: 'Save as…' });
	await expect(dialog).toBeVisible();
	await dialog.getByRole('textbox', { name: 'Theme name' }).fill('Custom Dark');
	await dialog.getByRole('textbox', { name: 'Theme name' }).press('Enter');
	await expect.poll(() => page.evaluate(() => window.themeEditorTest.persisted('custom-dark.json'))).toContain('#667788');
	await expect(dialog).not.toBeVisible();
	await page.evaluate(() => window.themeEditorTest.close());
	await expect.poll(() => page.locator('#main').evaluate(element => element.style.getPropertyValue('--ash-editor-background'))).toBe('#667788');
});

test('accessibility help opens in the auxiliary window and restores its focused control', async ({ page }) => {
	const popup = await openEditor(page);
	await popup.bringToFront();
	const search = popup.getByRole('searchbox', { name: 'Search colors' });
	await search.focus();
	await popup.keyboard.press('Alt+F1');
	await expect(popup.getByRole('dialog', { name: 'Accessibility Help', exact: true })).toBeVisible();
	await expect(popup.getByRole('dialog').getByRole('textbox')).toHaveValue(/main window previews/u);
	await expect(page.getByRole('dialog')).not.toBeVisible();
	await popup.keyboard.press('Escape');
	await expect(search).toBeFocused();
});
