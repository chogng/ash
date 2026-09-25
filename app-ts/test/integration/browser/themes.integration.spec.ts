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

test('high contrast themes remove decorative shadows while preserving state markers', async ({ page }) => {
	await page.goto('/themes.html');
	await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
	const root = page.locator('#root');
	const notification = page.locator('.ash-notification');
	const contextView = page.locator('.ash-context-view-default');
	const hoverView = page.locator('.ash-context-view-hover');
	const dropRow = page.locator('.ash-list-row.ash-dnd-drop-before');
	const pdfPage = page.locator('.ash-pdf-page');
	const titlebar = page.locator('.ash-workbench-titlebar > .ash-workbench-part-content');
	await root.evaluate(element => {
		element.classList.add('ash-workbench');
		for (const className of ['ash-notification', 'ash-context-view-default', 'ash-context-view-hover', 'ash-list-row ash-dnd-drop-before', 'ash-pdf-page']) {
			const item = document.createElement('div');
			item.className = className;
			item.textContent = className;
			element.append(item);
		}
		const bar = document.createElement('div');
		bar.className = 'ash-workbench-titlebar';
		const content = document.createElement('div');
		content.className = 'ash-workbench-part-content';
		bar.append(content);
		element.append(bar);
	});
	expect(await notification.evaluate(element => getComputedStyle(element).boxShadow)).not.toBe('none');
	expect(await contextView.evaluate(element => getComputedStyle(element).boxShadow)).not.toBe('none');
	expect(await hoverView.evaluate(element => getComputedStyle(element).boxShadow)).not.toBe('none');
	expect(await dropRow.evaluate(element => getComputedStyle(element).boxShadow)).not.toBe('none');
	expect(await pdfPage.evaluate(element => getComputedStyle(element).boxShadow)).not.toBe('none');
	expect(await titlebar.evaluate(element => getComputedStyle(element, '::before').boxShadow)).not.toBe('none');
	for (const [id, border] of [['ash-high-contrast-dark', 'rgb(255, 255, 255)'], ['ash-high-contrast-light', 'rgb(0, 0, 0)']] as const) {
		await page.evaluate(id => window.selectColorTheme(id), id);
		await expect(root).toHaveAttribute('data-color-theme', id);
		expect(await notification.evaluate(element => ({
			shadow: getComputedStyle(element).boxShadow,
			border: getComputedStyle(element).borderColor,
		}))).toEqual({ shadow: 'none', border });
		expect(await contextView.evaluate(element => ({
			shadow: getComputedStyle(element).boxShadow,
			border: getComputedStyle(element).borderColor,
		}))).toEqual({ shadow: 'none', border });
		expect(await hoverView.evaluate(element => ({
			shadow: getComputedStyle(element).boxShadow,
			border: getComputedStyle(element).borderColor,
			style: getComputedStyle(element).borderStyle,
		}))).toEqual({ shadow: 'none', border, style: 'solid' });
		expect(await dropRow.evaluate(element => getComputedStyle(element).boxShadow)).toContain(border);
		expect(await pdfPage.evaluate(element => ({
			shadow: getComputedStyle(element).boxShadow,
			outline: getComputedStyle(element).outlineColor,
			style: getComputedStyle(element).outlineStyle,
		}))).toEqual({ shadow: 'none', outline: border, style: 'solid' });
		expect(await titlebar.evaluate(element => ({
			shadow: getComputedStyle(element, '::before').boxShadow,
			outline: getComputedStyle(element, '::before').outlineColor,
			style: getComputedStyle(element, '::before').outlineStyle,
		}))).toEqual({ shadow: 'none', outline: border, style: 'solid' });
	}
});

test('nested high contrast theme does not inherit an outer shadow color', async ({ page }) => {
	await page.goto('/themes.html');
	await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
	const outer = page.locator('#root');
	expect(await outer.evaluate(element => getComputedStyle(element).getPropertyValue('--ash-widget-shadow'))).not.toBe('');
	await page.evaluate(() => window.mountNestedHighContrastWidget());
	try {
		const nested = page.locator('#nested-high-contrast-root');
		await expect(nested).toHaveAttribute('data-color-scheme', 'high-contrast-dark');
		expect(await nested.locator('.ash-context-view-default').evaluate(element => getComputedStyle(element).boxShadow)).toBe('none');
	} finally {
		await page.evaluate(() => window.disposeNestedHighContrastWidget());
	}
});

test('keyboard focus remains visible across themed controls', async ({ page }) => {
	await page.goto('/themes.html');
	await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
	await page.locator('#root').evaluate(root => {
		root.classList.add('ash-workbench');
		const fixture = document.createElement('div');
		fixture.innerHTML = `
			<div class="ash-menu"><div class="ash-action-view-item focused"><button class="ash-button" id="focus-menu">Menu</button></div></div>
			<div class="ash-select-box-list"><div class="ash-select-box-option ash-select-box-option-active" id="focus-select" tabindex="-1">Option</div></div>
			<div class="ash-scrollbar" id="focus-scrollbar" tabindex="0">Scrollable</div>
			<div class="ash-tree" id="focus-tree" tabindex="0">Empty tree</div>
			<div class="stanza-editor-code-action"><button id="focus-code-action">Code action</button></div>
			<button class="stanza-document-outline-entry" id="focus-outline">Outline</button>
			<button class="ash-scm-graph-change" id="focus-scm">Change</button>
			<section class="ash-modal-editor" id="focus-modal" tabindex="-1">Modal</section>`;
		root.append(fixture);
	});
	for (const theme of ['ash-dark', 'ash-high-contrast-dark']) {
		await page.evaluate(id => window.selectColorTheme(id), theme);
		for (const id of ['focus-menu', 'focus-select', 'focus-scrollbar', 'focus-tree', 'focus-code-action', 'focus-outline', 'focus-scm', 'focus-modal']) {
			await page.keyboard.press('Tab');
			const control = page.locator(`#${id}`);
			await control.focus();
			expect(await control.evaluate(element => ({
				visible: element.matches(':focus-visible'),
				style: getComputedStyle(element).outlineStyle,
				width: getComputedStyle(element).outlineWidth,
				offset: getComputedStyle(element).outlineOffset,
			})), `${theme} ${id}`).toEqual({ visible: true, style: 'solid', width: '1px', offset: '-1px' });
		}
	}
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
