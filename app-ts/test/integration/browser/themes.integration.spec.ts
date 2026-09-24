import { expect, test } from '@playwright/test';

test('an active workbench theme includes later colors and restores host variables on disposal', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto('/themes.html');
	await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
	const root = page.locator('#root');
	await root.evaluate(element => element.style.setProperty('--ash-test-browser-late', '#fedcba', 'important'));
	await page.evaluate(() => window.registerLateThemeColor());
	expect(await root.evaluate(element => getComputedStyle(element).getPropertyValue('--ash-test-browser-late'))).toBe('#123456');
	await page.getByRole('button', { name: 'Light', exact: true }).click();
	expect(await root.evaluate(element => getComputedStyle(element).getPropertyValue('--ash-test-browser-late'))).toBe('#abcdef');
	await page.evaluate(() => window.disposeThemeRoot());
	expect(await root.evaluate(element => [element.style.getPropertyValue('--ash-test-browser-late'), element.style.getPropertyPriority('--ash-test-browser-late')])).toEqual(['#fedcba', 'important']);
	expect(errors).toEqual([]);
});

test('TextMate Worker registers its provider at startup and restores current catalogs after restart', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto('/themes.html');
	await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
	expect(await page.evaluate(() => window.tokenizeInTextMateWorker())).toEqual([
		{ type: 'keyword', modifiers: [] },
		{ type: 'keyword', modifiers: ['declaration'] },
		{ type: 'keyword', modifiers: ['declaration'], presentation: { foreground: '#ff0000', fontStyle: ['italic'] } },
		{ type: 'keyword', modifiers: ['declaration'], presentation: { foreground: '#0000ff', fontStyle: ['bold'] } },
		{ type: 'string', modifiers: [] },
		{ type: 'string', modifiers: [] },
	]);
	expect(errors).toEqual([]);
});

test('extension file icons load a real font and update existing labels on theme changes', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto('/themes.html');
	await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
	const icon = page.locator('#icon');
	await expect(icon).not.toHaveText('');
	const dark = await icon.evaluate(element => getComputedStyle(element).color);
	const font = await icon.evaluate(async element => {
		const family = getComputedStyle(element).fontFamily;
		const loaded = await document.fonts.load('16px ' + family);
		return { family, loaded: loaded.length, ready: document.fonts.check('16px ' + family) };
	});
	expect(font.family).toContain('ash-file-icon-');
	expect(font.loaded).toBe(1);
	expect(font.ready).toBe(true);
	await page.getByRole('button', { name: 'Light', exact: true }).click();
	await expect.poll(() => icon.evaluate(element => getComputedStyle(element).color)).not.toBe(dark);
	await page.getByRole('button', { name: 'None', exact: true }).click();
	await expect(icon).toHaveText('');
	await page.getByRole('button', { name: 'Seti', exact: true }).click();
	await expect(icon).not.toHaveText('');
	expect(errors).toEqual([]);
});


test('TextMate Worker tokenizes hypothetical lines in context without changing the document', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto('/themes.html');
	await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
	expect(await page.evaluate(() => window.previewInTextMateWorker())).toEqual({ preview: ['[)":2', 'if:0'], unchanged: true, text: '"start\nend"\nif' });
	expect(errors).toEqual([]);
});
