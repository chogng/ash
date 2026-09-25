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

test('extension product icon themes replace mounted SVG artwork and restore built-in artwork', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto('/themes.html');
	await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
	const icon = page.locator('#product-icon svg.ash-icon');
	const semanticIcon = page.locator('#semantic-product-icon svg.ash-icon');
	const originalPath = await icon.locator('path').getAttribute('d');
	const originalSemanticPath = await semanticIcon.locator('path').getAttribute('d');
	const mounted = await icon.elementHandle();
	const mountedSemantic = await semanticIcon.elementHandle();
	await page.getByRole('button', { name: 'SVG icons' }).click();
	await expect(icon.locator('circle')).toHaveCount(1);
	await expect(semanticIcon.locator('circle')).toHaveCount(1);
	expect(await mounted!.evaluate(element => element === document.querySelector('#product-icon svg.ash-icon'))).toBe(true);
	expect(await mountedSemantic!.evaluate(element => element === document.querySelector('#semantic-product-icon svg.ash-icon'))).toBe(true);
	await page.getByRole('button', { name: 'Default icons' }).click();
	await expect(icon.locator('path')).toHaveAttribute('d', originalPath!);
	await expect(semanticIcon.locator('path')).toHaveAttribute('d', originalSemanticPath!);
	expect(errors).toEqual([]);
});

test('SVG icon select box filters, navigates, selects, and follows product icon themes', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto('/themes.html');
	await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
	const picker = page.locator('#icon-select-host');
	const input = picker.getByRole('combobox', { name: 'Search icons' });
	const options = picker.getByRole('option');
	await expect(options).toHaveCount(3);
	await expect(input).toHaveAttribute('aria-controls', /ash-icon-select-box-\d+-icons/);
	await input.fill('CHEV');
	await expect(options).toHaveCount(1);
	await expect(options.first()).toHaveAttribute('aria-label', 'chevron-right');
	await expect(picker.locator('.ash-icon-select-info mark')).toHaveText('chev');
	await input.press('Enter');
	await expect(picker).toHaveAttribute('data-selected-icon', 'chevron-right');
	await expect(options.first()).toHaveAttribute('aria-selected', 'true');
	await input.fill('nothing-matches');
	await expect(options).toHaveCount(0);
	await expect(picker.getByRole('status')).toHaveText('No icons found');
	await expect(input).not.toHaveAttribute('aria-activedescendant');
	await input.fill('');
	await input.press('ArrowUp');
	await expect(input).toHaveAttribute('aria-activedescendant', /ash-icon-select-box-\d+-icon-1/);
	await input.press('ArrowRight');
	await input.press('Enter');
	await expect(picker).toHaveAttribute('data-selected-icon', 'check');
	await options.nth(1).click();
	await expect(picker).toHaveAttribute('data-selected-icon', 'chevron-right');
	expect(await options.nth(1).evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
	await page.getByRole('button', { name: 'SVG icons' }).click();
	await expect(options.first().locator('circle')).toHaveCount(1);
	await page.getByRole('button', { name: 'Default icons' }).click();
	await expect(options.first().locator('path')).toHaveCount(1);
	await page.evaluate(() => window.disposeIconSelectBox());
	await expect(picker.locator('.ash-icon-select-box')).toHaveCount(0);
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
