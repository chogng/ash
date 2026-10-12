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
