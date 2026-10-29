import { expectIconFontLoaded } from '../../automation/iconFonts.js';
import { test } from '../../fixtures/browser/rustSyntaxProcessFixture.js';
import { expect } from '@playwright/test';


test('decoration icons follow font product themes while retaining the label and icon', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto('/themes.html');
	await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
	const label = page.locator('#decorated-label .ash-icon-label');
	await page.evaluate(() => window.setLabelDecoration({ letter: { id: 'add', color: { id: 'error.foreground' } }, tooltip: 'Added' }));
	await expect(label).toHaveAttribute('aria-label', 'ignored.log, Added');
	const icon = label.locator('.ash-icon-label-suffix-icon .ash-icon');
	await expect(icon).toHaveCount(1);
	const retainedLabel = await label.elementHandle();
	const retainedIcon = await icon.elementHandle();
	const original = await icon.getAttribute('data-ash-icon-character');
	await page.locator('#font-icons').click();
	await expect(icon).toHaveAttribute('data-ash-icon-character', '\ue005');
	const color = await page.locator('#root').evaluate(element => {
		const probe = document.createElement('span');
		probe.style.color = 'var(--ash-error-foreground)';
		element.append(probe);
		const result = getComputedStyle(probe).color;
		probe.remove();
		return result;
	});
	await expect(icon).toHaveCSS('color', color);
	await page.evaluate(() => window.setThemeSetting('workbench.productIconTheme', 'test-font-product'));
	await expectIconFontLoaded(icon);
	await expect(icon.locator('svg')).toHaveCount(0);
	await expect(icon).toHaveCSS('font-weight', '700');
	await expect(icon).toHaveCSS('font-style', 'italic');
	const font = await icon.evaluate(async element => {
		const query = 'italic 700 16px ' + getComputedStyle(element).fontFamily;
		return { loaded: (await document.fonts.load(query)).length, ready: document.fonts.check(query) };
	});
	expect(font).toEqual({ loaded: 1, ready: true });
	expect(await retainedLabel!.evaluate(element => element === document.querySelector('#decorated-label .ash-icon-label'))).toBe(true);
	expect(await retainedIcon!.evaluate(element => element === document.querySelector('#decorated-label .ash-icon-label-suffix-icon .ash-icon'))).toBe(true);
	await page.locator('#default-icons').click();
	await expect(icon).toHaveAttribute('data-ash-icon-character', original!);
	await page.evaluate(() => window.removeLabelDecorationProvider());
	await expect(icon).toHaveCount(0);
	await expect(label.locator('.ash-icon-label-suffix-icon')).toBeHidden();
	await expect.poll(() => page.locator('[data-ash-decorations]').textContent()).toBe('');
	expect(errors).toEqual([]);
});

for (const backend of ['rust', 'offline']) test(`Tree-sitter applies current theme rules after edits and in a new document (${backend})`, async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto(`/themes.html?backend=${backend}`);
	await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
	expect(await page.evaluate(() => window.tokenizeWithSyntax())).toEqual([
		{ type: 'keyword', modifiers: [] },
		{ type: 'keyword', modifiers: [], presentation: { foreground: '#ff0000', fontStyle: ['italic'] } },
		{ type: 'keyword', modifiers: [], presentation: { foreground: '#0000ff', fontStyle: ['bold'] } },
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
	await expect(icon).toHaveClass(/typescript-lang-file-icon/);
	await expect(icon).toHaveClass(/ts-ext-file-icon/);
	const suggestionIcon = page.locator('#suggestion-file-icon');
	await page.locator('#root').evaluate(root => {
		root.classList.add('ash-workbench');
		const element = document.createElement('span');
		element.id = 'suggestion-file-icon';
		element.className = 'ash-themed-file-icon file-icon ts-ext-file-icon typescript-lang-file-icon';
		element.textContent = 'File';
		root.append(element);
	});
	const suggestionStyle = async () => suggestionIcon.evaluate(element => ({
		labelSize: getComputedStyle(element).fontSize,
		iconContent: getComputedStyle(element, '::before').content,
		iconColor: getComputedStyle(element, '::before').color,
		iconFont: getComputedStyle(element, '::before').fontFamily,
	}));
	const darkSuggestion = await suggestionStyle();
	expect(darkSuggestion.labelSize).toBe('0px');
	expect(darkSuggestion.iconContent).not.toBe('none');
	expect(darkSuggestion.iconFont).toContain('ash-file-icon-');
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
	await expect.poll(async () => (await suggestionStyle()).iconColor).not.toBe(darkSuggestion.iconColor);
	await page.getByRole('button', { name: 'None', exact: true }).click();
	await expect(icon).toHaveText('');
	expect((await suggestionStyle()).labelSize).not.toBe('0px');
	await page.getByRole('button', { name: 'Seti', exact: true }).click();
	await expect(icon).not.toHaveText('');
	expect((await suggestionStyle()).labelSize).toBe('0px');
	expect(errors).toEqual([]);
});

test('product font themes replace mounted glyphs and restore built-in glyphs', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto('/themes.html');
	await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
	const icon = page.locator('#product-icon .ash-icon');
	const semanticIcon = page.locator('#semantic-product-icon .ash-icon');
	const originalCharacter = await icon.getAttribute('data-ash-icon-character');
	const originalSemanticCharacter = await semanticIcon.getAttribute('data-ash-icon-character');
	const mounted = await icon.elementHandle();
	const mountedSemantic = await semanticIcon.elementHandle();
	await page.getByRole('button', { name: 'Font icons' }).click();
	await expect(icon).toHaveAttribute('data-ash-icon-character', '\ue005');
	await expect(semanticIcon).toHaveAttribute('data-ash-icon-character', '\ue005');
	expect(await mounted!.evaluate(element => element === document.querySelector('#product-icon .ash-icon'))).toBe(true);
	expect(await mountedSemantic!.evaluate(element => element === document.querySelector('#semantic-product-icon .ash-icon'))).toBe(true);
	await page.getByRole('button', { name: 'Default icons' }).click();
	await expect(icon).toHaveAttribute('data-ash-icon-character', originalCharacter!);
	await expect(icon.locator('svg')).toHaveCount(0);
	await expect(semanticIcon).toHaveAttribute('data-ash-icon-character', originalSemanticCharacter!);
	expect(errors).toEqual([]);
});

test('Font icon select box filters, navigates, selects, and follows product icon themes', async ({ page }) => {
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
	await page.getByRole('button', { name: 'Font icons' }).click();
	await expect(options.first().locator('.ash-icon')).toHaveAttribute('data-ash-icon-character', '\ue005');
	await page.getByRole('button', { name: 'Default icons' }).click();
	await expectIconFontLoaded(options.first().locator('.ash-icon'));
	await expect(options.first().locator('svg')).toHaveCount(0);
	await page.evaluate(() => window.disposeIconSelectBox());
	await expect(picker.locator('.ash-icon-select-box')).toHaveCount(0);
	expect(errors).toEqual([]);
});


test('Tree-sitter tokenizes hypothetical lines in context without changing the document', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto('/themes.html');
	await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
	expect(await page.evaluate(() => window.previewWithRustSyntax())).toEqual({ hasString: true, hasKeyword: true, unchanged: true, text: 'const text = `start\nend`;\nif (true) {}' });
	expect(errors).toEqual([]);
});

test('standard product icon fonts load into mounted icons and unload with their extension', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto('/themes.html');
	await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
	const icon = page.locator('#product-icon .ash-icon');
	const mounted = await icon.elementHandle();
	await page.evaluate(() => window.setThemeSetting('workbench.productIconTheme', 'test-font-product'));
	await expectIconFontLoaded(icon);
	await expect(icon.locator('svg')).toHaveCount(0);
	await expect(icon).toHaveCSS('font-weight', '700');
	await expect(icon).toHaveCSS('font-style', 'italic');
	const font = await icon.evaluate(async element => {
		const family = getComputedStyle(element).fontFamily;
		const query = 'italic 700 16px ' + family;
		const loaded = await document.fonts.load(query);
		return { loaded: loaded.length, ready: document.fonts.check(query) };
	});
	expect(font).toEqual({ loaded: 1, ready: true });
	expect(await mounted!.evaluate(element => element === document.querySelector('#product-icon .ash-icon'))).toBe(true);
	await page.evaluate(() => window.disposeThemeExtensions());
	await expect(icon).toHaveAttribute('data-ash-icon-character', '\ue001');
	await expect(page.locator('style[data-ash-icon-fonts]')).toBeEmpty();
	expect(errors).toEqual([]);
});
