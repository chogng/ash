import { test, expect, type Page, type Locator } from '@playwright/test';

async function editColor(field: Locator, value: string): Promise<void> {
	await field.fill(value);
	await field.press('Enter');
}

async function chooseThemeAction(popup: Page, label: string, _locale = 'en'): Promise<void> {
	if (label === 'Open Theme (JSON)' || label === 'Open Theme (UI)') {
		await popup.locator('.ash-breadcrumbs-editor-type:visible').click();
		const editor = label === 'Open Theme (JSON)' ? 'Text Editor' : 'Theme Editor';
		await popup.getByRole('menuitemradio', { name: editor, exact: true }).click();
		if (label === 'Open Theme (JSON)') await popup.getByRole('textbox').focus();
		return;
	}
	const selector = popup.locator('.ash-theme-editor-preview-actions > .ash-button:visible');
	if (await selector.isVisible()) await selector.focus();
	const shortcut =
		label === 'Undo' || label === '撤销'
			? 'ControlOrMeta+z'
			: label === 'Redo' || label === '重做'
				? 'ControlOrMeta+Shift+z'
				: label === 'Save as…' || label === '另存为…'
					? 'ControlOrMeta+Shift+s'
					: 'ControlOrMeta+s';
	await popup.keyboard.press(shortcut);
}

async function expectSaved(page: Page): Promise<void> {
	await expect
		.poll(() => page.evaluate(() => window.themeEditorTest.editors().every(editor => !editor.dirty)))
		.toBe(true);
}

async function saveEditableTheme(popup: Page, locale = 'en'): Promise<void> {
	await chooseThemeAction(popup, locale === 'zh-CN' ? '另存为…' : 'Save as…', locale);
	const dialog = popup.getByRole('dialog', { name: locale === 'zh-CN' ? '另存为…' : 'Save as…', exact: true });
	const name = dialog.getByRole('textbox', { name: locale === 'zh-CN' ? '主题名称' : 'Theme name', exact: true });
	await name.fill('Editable theme');
	await name.press('Enter');
	await expect(dialog).toBeHidden();
}

async function openDetached(page: Page): Promise<Page> {
	await page.locator('#open').click();
	const [popup] = await Promise.all([
		page.waitForEvent('popup'),
		page.evaluate(() => window.themeEditorTest.detach()),
	]);
	return popup;
}

async function openWritableBuiltin(page: Page): Promise<Page> {
	await page.goto('/themeEditor.html');
	await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
	await page.evaluate(async () => {
		await window.themeEditorTest.useWritableThemeSources();
		await window.themeEditorTest.selectTheme('ash-light');
	});
	const popup = await openDetached(page);
	await expect(popup.frameLocator('.ash-theme-editor-preview').locator('body')).toHaveAttribute('data-ready', 'true');
	return popup;
}

async function openEditor(page: Page, locale?: string, theme?: string): Promise<Page> {
	page.on('pageerror', error => console.error('Theme Editor fixture:', error.message));
	await page.goto('/themeEditor.html' + (locale ? '?locale=' + locale : ''));
	await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
	if (theme) await page.evaluate(id => window.themeEditorTest.selectTheme(id), theme);
	const popup = await openDetached(page);
	const errors: string[] = [];
	popup.on('pageerror', error => errors.push(error.message));
	popup.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
	await expect(popup.locator('.ash-theme-editor')).toBeVisible();
	await expect(popup.locator('.ash-theme-editor-message')).not.toHaveClass(/error/);
	await expect(popup.frameLocator('.ash-theme-editor-preview').locator('body')).toHaveAttribute('data-ready', 'true');
	expect(errors, 'The isolated preview must complete startup without missing services or failed contributions').toEqual([]);
	return popup;
}

for (const locale of ['en', 'zh-CN']) {
	test(`theme toolbar names the edited file and marks the applied theme independently (${locale})`, async ({
		page,
	}) => {
		const chinese = locale === 'zh-CN';
		const openLabel = chinese ? '打开主题…' : 'Open Theme…';
		const appliedLabel = chinese ? '当前应用' : 'Currently applied';
		await page.goto('/themeEditor.html' + (chinese ? '?locale=zh-CN' : ''));
		await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
		await page.locator('#open').click();
		const open = page.locator('.ash-theme-editor-preview-actions > .ash-button:visible');
		await expect(open.locator('.ash-button-label')).toBeVisible();
		await expect(open).toHaveText(chinese ? '编辑主题：Aurora' : 'Editing theme: Aurora');
		await expect(open.locator('.ash-icon')).toHaveCount(1);
		await page.evaluate(() =>
			window.themeEditorTest.setSource(window.themeEditorTest.source().replace('#101525', '#234567')),
		);
		const background = await page.locator('#main').evaluate(element => getComputedStyle(element).backgroundColor);
		await open.press('Enter');
		const picker = page.locator('.ash-quick-pick');
		const input = picker.getByRole('combobox', { name: openLabel, exact: true });
		await expect(input).toBeFocused();
		await expect(input).toHaveAttribute('placeholder', chinese ? '搜索要编辑的主题' : 'Search themes to edit');
		const applied = picker.getByRole('option').filter({ hasText: appliedLabel });
		await expect(applied).toHaveCount(1);
		await expect(applied.locator('.ash-quick-pick-row-label')).toHaveText('Aurora');
		await expect(applied).toHaveAccessibleName(new RegExp(appliedLabel));
		await input.fill('Ash Dark');
		await input.press('Enter');
		await expect(picker).toBeHidden();
		await expect
			.poll(() => page.evaluate(() => window.themeEditorTest.editors().map(editor => editor.label)))
			.toEqual(['aurora.json', 'ash-dark.json']);
		expect((await page.evaluate(() => window.themeEditorTest.editors()))[0].dirty).toBe(true);
		await expect(page.locator('#main')).toHaveCSS('background-color', background);
		await open.press('Enter');
		await expect(applied.locator('.ash-quick-pick-row-label')).toHaveText('Aurora');
		await input.fill('Ash');
		await page.evaluate(() => window.themeEditorTest.selectTheme('ash-light'));
		await expect(input).toHaveValue('Ash');
		await expect(applied).toHaveCount(1);
		await expect(applied.locator('.ash-quick-pick-row-label')).toHaveText('Ash Light');
		await input.press('Escape');
		await expect(picker).toBeHidden();
		await expect(open).toBeFocused();
	});
}

for (const locale of ['en', 'zh-CN']) {
	test(`syntax preview uses real token colors and fixed read-only samples (${locale})`, async ({
		page,
	}, testInfo) => {
		const popup = await openEditor(page, locale);
		const source = await page.evaluate(() => window.themeEditorTest.source());
		const tab = popup.getByRole('tab', { name: locale === 'zh-CN' ? '语法' : 'Syntax', exact: true });
		await tab.focus();
		await tab.press('Enter');
		await expect(tab).toHaveAttribute('aria-selected', 'true');
		const frame = popup.frameLocator('.ash-theme-editor-preview');
		await expect(frame.locator('body')).toHaveAttribute('data-ready', 'true');
		const code = frame.getByRole('textbox', { name: 'palette.ts', exact: true });
		await expect(code).toBeVisible();
		await page.evaluate(() =>
			window.themeEditorTest.setSource(
				window.themeEditorTest.source().replace('{', '{"semanticTokenColors":{"keyword":"#b51234"},'),
			),
		);
		await expect
			.poll(() =>
				frame
					.locator('.view-line span')
					.evaluateAll(spans => spans.some(span => getComputedStyle(span).color === 'rgb(181, 18, 52)')),
			)
			.toBe(true);
		await expect
			.poll(() =>
				frame
					.locator('.view-line span')
					.evaluateAll(spans => new Set(spans.map(span => getComputedStyle(span).color)).size),
			)
			.toBeGreaterThan(1);
		await expect(code).toHaveAttribute('aria-readonly', 'true');
		await code.focus();
		await code.press('ControlOrMeta+End');
		await code.press('Enter');
		await code.pressSequentially('// syntax_preview_only');
		await expect
			.poll(() => page.evaluate(() => window.themeEditorTest.accessibleContent()))
			.not.toContain('syntax_preview_only');
		expect(await page.evaluate(() => window.themeEditorTest.source())).not.toContain('syntax_preview_only');
		expect(await page.evaluate(() => window.themeEditorTest.persisted())).toBe(source);
		await popup.screenshot({ path: testInfo.outputPath('syntax-preview.png') });
	});
}

test('saving another theme changes its document without selecting it', async ({ page }) => {
	const popup = await openEditor(page);
	await saveEditableTheme(popup);
	await popup.getByRole('searchbox').fill('editor.background');
	await editColor(popup.getByRole('textbox', { name: 'Hex color for editor.background', exact: true }), '#223344');
	await chooseThemeAction(popup, 'Save');
	await expectSaved(page);
	expect(await page.evaluate(() => window.themeEditorTest.persisted('editable-theme.json'))).toContain('#223344');
	await expect(page.locator('#main')).toHaveCSS('background-color', 'rgb(16, 21, 37)');
	await popup.locator('.ash-theme-editor-preview-actions > .ash-button:visible').click();
	await expect(
		page
			.locator('.ash-quick-pick')
			.getByRole('option')
			.filter({ hasText: 'Currently applied' })
			.locator('.ash-quick-pick-row-label'),
	).toHaveText('Aurora');
});

for (const [theme, locale] of [
	['ash-light', 'en'],
	['ash-dark', 'zh-CN'],
	['ash-high-contrast-light', 'en'],
	['ash-high-contrast-dark', 'zh-CN'],
] as const) {
	test(`diff preview updates real line and word highlights in Theme Editor (${theme}, ${locale})`, async ({
		page,
	}, testInfo) => {
		const popup = await openEditor(page, locale, theme);
		await saveEditableTheme(popup, locale);
		const terminal = popup.frameLocator('.ash-theme-editor-preview').locator('.ash-theme-preview-terminal');
		await expect(terminal).toContainText(locale === 'zh-CN' ? '终端配色预览，不执行命令。' : 'Terminal color preview. Commands are not executed.');
		await expect(terminal.locator('[data-color]')).toHaveCount(16);
		await expect(popup.frameLocator('.ash-theme-editor-preview').locator('.xterm, .ash-terminal-status, [data-statusbar-item-id="ash.status.languageServers"]')).toHaveCount(0);
		await popup.getByRole('searchbox').fill('terminal.ansiRed');
		await editColor(popup.locator('.ash-theme-color').getByRole('textbox'), '#b51234');
		await expect(terminal.locator('[data-color="terminal.ansiRed"]')).toHaveCSS('color', 'rgb(181, 18, 52)');
		const tabs = popup.getByRole('tablist', { name: locale === 'zh-CN' ? '预览窗口' : 'Preview window', exact: true });
		await tabs.getByRole('tab', { name: locale === 'zh-CN' ? '桌面工作台' : 'Workbench', exact: true }).focus();
		await popup.keyboard.press('ArrowRight');
		const diffTab = tabs.getByRole('tab', { name: locale === 'zh-CN' ? '差异对比' : 'Diff', exact: true });
		await expect(diffTab).toBeFocused();
		await diffTab.press('Enter');
		await expect(diffTab).toHaveAttribute('aria-selected', 'true');
		await popup.getByRole('searchbox').fill('diffEditor.');
		const frame = popup.frameLocator('.ash-theme-editor-preview');
		const preview = frame.locator('#app');
		const diff = frame.locator('.stanza-diff-editor');
		await expect(diff).toBeVisible();
		await expect(frame.getByRole('tab', { name: locale === 'zh-CN' ? '颜色更改' : 'Color changes', exact: true })).toBeVisible();
		const initialEditor = await diff.elementHandle();
		for (const [id, value, selector, expected] of [
			['diffEditor.insertedLineBackground', '#d0e8d7', '.stanza-diff-line-added', 'rgb(208, 232, 215)'],
			['diffEditor.removedLineBackground', '#f5d9d5', '.stanza-diff-line-removed', 'rgb(245, 217, 213)'],
			['diffEditor.insertedTextBackground', '#a7cdb3', '.stanza-diff-inline-added', 'rgb(167, 205, 179)'],
			['diffEditor.removedTextBackground', '#e4aaa5', '.stanza-diff-inline-removed', 'rgb(228, 170, 165)'],
		] as const) {
			const row = popup.locator('#theme-color-group-editor .ash-theme-color').filter({
				has: popup.locator('.ash-theme-color-name').getByText(id, { exact: true }),
			});
			const field = row.getByRole('textbox');
			await expect(field).toBeEnabled();
			const initial = await field.inputValue();
			const variable = `--ash-${id.replaceAll('.', '-')}`;
			const inherited = await preview.evaluate((element, name) => getComputedStyle(element).getPropertyValue(name).trim(), variable);
			const highlight = diff.locator(selector).first();
			await expect(highlight).toBeVisible();
			const initialBackground = await highlight.evaluate(element => getComputedStyle(element).backgroundColor);
			await editColor(field, value);
			await expect(preview).toHaveCSS(variable, value);
			await expect(highlight).toHaveCSS('background-color', expected);
			expect(await page.evaluate(() => window.themeEditorTest.source())).toContain(`"${id}": "${value}"`);
			await row.locator('.ash-theme-color-reset').press('Enter');
			await expect(field).toHaveValue(initial);
			await expect(preview).toHaveCSS(variable, inherited);
			await expect(highlight).toHaveCSS('background-color', initialBackground);
			expect(await page.evaluate(() => window.themeEditorTest.source())).not.toContain(`"${id}"`);
		}
		expect(await initialEditor!.evaluate(element => element.isConnected)).toBe(true);
		await initialEditor!.dispose();
		await popup.screenshot({ path: testInfo.outputPath('diff-theme-colors.png') });
	});
}

test('diff preview keeps its sample fixed through theme undo, redo and switching', async ({ page }) => {
	const popup = await openEditor(page);
	const source = await page.evaluate(() => window.themeEditorTest.source());
	const persisted = await page.evaluate(() => window.themeEditorTest.persisted());
	const tabs = popup.getByRole('tablist', { name: 'Preview window', exact: true });
	const diffTab = tabs.getByRole('tab', { name: 'Diff', exact: true });
	await diffTab.press('Space');
	const frame = popup.frameLocator('.ash-theme-editor-preview');
	const input = frame.locator('.stanza-diff-editor-side.modified').getByRole('textbox');
	await input.focus();
	await input.press('ControlOrMeta+End');
	await input.press('Enter');
	await input.pressSequentially('// preview_only');
	await expect
		.poll(() => page.evaluate(() => window.themeEditorTest.accessibleContent()))
		.not.toContain('preview_only');
	await input.press('Alt+F2');
	const accessible = popup.getByRole('dialog', { name: 'Accessible View', exact: true }).getByRole('textbox');
	await expect(accessible).toHaveValue(
		/palette\.before\.ts[\s\S]*legacyColor[\s\S]*palette\.after\.ts[\s\S]*withOpacity/u,
	);
	await popup.keyboard.press('Escape');
	expect(await page.evaluate(() => window.themeEditorTest.source())).toBe(source);

	await popup.getByRole('searchbox').fill('diffEditor.insertedTextBackground');
	const field = popup.getByRole('textbox', { name: 'Hex color for diffEditor.insertedTextBackground', exact: true });
	const initial = await field.inputValue();
	await editColor(field, '#123456');
	const highlight = frame.locator('.stanza-diff-inline-added').first();
	await expect(highlight).toHaveCSS('background-color', 'rgb(18, 52, 86)');
	await chooseThemeAction(popup, 'Undo');
	await expect(field).toHaveValue(initial);
	await chooseThemeAction(popup, 'Redo');
	await expect(highlight).toHaveCSS('background-color', 'rgb(18, 52, 86)');
	await input.focus();
	await expect
		.poll(() => page.evaluate(() => window.themeEditorTest.accessibleContent()))
		.not.toContain('preview_only');

	await tabs.getByRole('tab', { name: 'Workbench', exact: true }).press('Enter');
	await expect(frame.getByRole('textbox', { name: 'palette.ts', exact: true })).toBeVisible();
	await diffTab.press('Space');
	await expect(highlight).toHaveCSS('background-color', 'rgb(18, 52, 86)');
	await input.focus();
	await expect.poll(() => page.evaluate(() => window.themeEditorTest.accessibleContent())).toContain('withOpacity');
	await expect.poll(() => page.evaluate(() => window.themeEditorTest.accessibleContent())).not.toContain('preview_only');
	await expect(popup.locator('iframe.ash-theme-editor-preview')).toHaveCount(1);
	expect(await page.evaluate(() => window.themeEditorTest.persisted())).toBe(persisted);
});

test('the standard source editor preserves theme edits and undo through editor type switches', async ({ page }) => {
	const popup = await openEditor(page);
	await popup.getByRole('searchbox').fill('editor.background');
	const color = popup.getByRole('textbox', { name: 'Hex color for editor.background', exact: true });
	await editColor(color, '#223344');
	const colorSource = await page.evaluate(() => window.themeEditorTest.source());
	await popup.getByRole('button', { name: 'editor.background', exact: true }).click();
	const input = popup.getByRole('textbox', { name: 'aurora.json', exact: true });
	await expect(input).toBeVisible();
	await input.press('ControlOrMeta+Home');
	await input.press('Space');
	await expect.poll(() => page.evaluate(() => window.themeEditorTest.source())).toBe(' ' + colorSource);
	await chooseThemeAction(popup, 'Open Theme (UI)');
	await popup.getByRole('searchbox').fill('editor.background');
	await expect(color).toHaveValue('223344');
	await chooseThemeAction(popup, 'Undo');
	await expect.poll(() => page.evaluate(() => window.themeEditorTest.source())).toBe(colorSource);
	await chooseThemeAction(popup, 'Undo');
	await expect(color).toHaveValue('101525');
	expect(await page.evaluate(() => window.themeEditorTest.editors())).toHaveLength(1);
});

for (const [locale, theme] of [
	['en', 'aurora'],
	['zh-CN', 'ash-high-contrast-dark'],
] as const) {
	test(`preview toolbar keeps document save state and localized actions (${locale})`, async ({ page }, testInfo) => {
		const popup = await openEditor(page, locale, theme);
		if (theme !== 'aurora') await saveEditableTheme(popup, locale);
		const chinese = locale === 'zh-CN';
		const toolbar = popup.locator('.ash-theme-editor-preview-toolbar');
		const tabs = toolbar.getByRole('tab');
		await expect(tabs).toHaveText(
			chinese
				? ['桌面工作台', '差异对比', 'Agent 窗口', '语法']
				: ['Workbench', 'Diff', 'Agent Window', 'Syntax'],
		);
		await expect(popup.getByRole('button', { name: /^(Save and Apply|保存并应用)$/ })).toHaveCount(0);
		await expect(toolbar.locator('.ash-toolbar')).toHaveCount(0);
		await expect(toolbar.getByRole('button', { name: /More Actions|更多操作/u })).toHaveCount(0);
		await popup.getByRole('searchbox').fill('editor.background');
		const hex = popup.getByRole('textbox', {
			name: chinese ? 'editor.background 的十六进制颜色' : 'Hex color for editor.background',
			exact: true,
		});
		const original = await hex.inputValue();
		await editColor(hex, '#223344');
		await expect(popup.locator('.ash-tab[data-state=dirty]')).toHaveCount(1);
		await chooseThemeAction(popup, chinese ? '撤销' : 'Undo');
		await expect(hex).toHaveValue(original);
		await chooseThemeAction(popup, chinese ? '重做' : 'Redo');
		await expect(hex).toHaveValue('223344');
		await chooseThemeAction(popup, 'Save');
		await expectSaved(page);
		await expect(popup.locator('.ash-tab[data-state=dirty]')).toHaveCount(0);
		await expect(popup.locator('.ash-theme-editor-message')).toBeHidden();
		const selector = toolbar.locator('.ash-theme-editor-preview-actions > .ash-button:visible');
		const lastTab = tabs.last();
		const selectorBounds = await selector.boundingBox();
		const tabBounds = await lastTab.boundingBox();
		expect(tabBounds!.x + tabBounds!.width).toBeLessThanOrEqual(selectorBounds!.x);
		await popup.screenshot({ path: testInfo.outputPath('theme-document-toolbar.png') });
	});
}

test('design token links navigate across groups, follow changes and restore after reset', async ({ page }, testInfo) => {
	const popup = await openEditor(page);
	const search = popup.getByRole('searchbox', { name: 'Search colors' });
	const frame = popup.frameLocator('.ash-theme-editor-preview');
	await search.fill('input.foreground');
	const hex = popup.getByRole('textbox', { name: 'Hex color for input.foreground', exact: true });
	const row = popup.locator('.ash-theme-color').filter({ has: hex });
	await expect(row.locator('.ash-theme-color-source')).toHaveText('Linked to foreground');
	await expect.poll(() => row.evaluate(element => {
		const style = getComputedStyle(element);
		const field = element.querySelector<HTMLElement>('.ash-color-picker-input')!;
		return Math.abs(element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - field.getBoundingClientRect().width);
	})).toBeLessThanOrEqual(1);
	const link = row.getByRole('button', { name: 'Go to design token foreground', exact: true });
	await link.focus();
	await link.press('Enter');
	const foreground = popup.getByRole('textbox', { name: 'Hex color for foreground', exact: true });
	await expect(popup.getByRole('button', { name: 'Choose color for foreground', exact: true })).toBeFocused();
	await expect(foreground).toBeInViewport();
	await expect(search).toHaveValue('');
	await editColor(foreground, '#bb8855');
	await expect(frame.locator('#app')).toHaveCSS('--ash-input-foreground', '#bb8855');
	await search.fill('input.foreground');
	await expect(hex).toHaveValue('BB8855');
	// Even an equal value is an explicit override, not a link inferred from color equality.
	await editColor(hex, '#bb8855');
	await expect(row.locator('.ash-theme-color-source')).toHaveText('Set in this file');
	await editColor(hex, '#aabbcc');
	const source = await page.evaluate(() => window.themeEditorTest.source());
	await page.evaluate(text => window.themeEditorTest.setSource(text.replace('#bb8855', '#447799')), source);
	await expect(frame.locator('#app')).toHaveCSS('--ash-foreground', '#447799');
	await expect(frame.locator('#app')).toHaveCSS('--ash-input-foreground', '#aabbcc');
	const reset = row.getByRole('button', { name: 'Remove the override for input.foreground', exact: true });
	await row.hover();
	expect(await reset.boundingBox()).toMatchObject({ width: 22, height: 22 });
	await expect(reset.locator('.ash-icon')).toHaveCSS('width', '16px');
	await reset.click();
	await expect(row.locator('.ash-theme-color-source')).toHaveText('Linked to foreground');
	await expect(hex).toHaveValue('447799');
	await expect(frame.locator('#app')).toHaveCSS('--ash-input-foreground', '#447799');
	await chooseThemeAction(popup, 'Save');
	await expect.poll(() => page.evaluate(() => window.themeEditorTest.persisted())).toContain('#447799');
	expect(await page.evaluate(() => window.themeEditorTest.persisted())).not.toContain('"input.foreground"');
	await search.fill('input.');
	await popup.screenshot({ path: testInfo.outputPath('design-token-links.png') });
});

test('included overrides do not claim a default token relationship after reset', async ({ page }) => {
	const popup = await openEditor(page);
	await page.evaluate(() => window.themeEditorTest.setSource(JSON.stringify({
		name: 'Included colors', type: 'dark', include: './includes/base.json',
		colors: { foreground: '#aabbcc', 'input.foreground': '#778899' },
	})));
	await popup.getByRole('searchbox', { name: 'Search colors' }).fill('input.foreground');
	const hex = popup.getByRole('textbox', { name: 'Hex color for input.foreground', exact: true });
	const row = popup.locator('.ash-theme-color').filter({ has: hex });
	await expect(hex).toHaveValue('778899');
	await row.getByRole('button', { name: 'Remove the override for input.foreground', exact: true }).click();
	await expect(hex).toHaveValue('112233');
	await expect(row.locator('.ash-theme-color-source')).toHaveText('Inherited / default');
	await expect(row.locator('.ash-theme-color-link')).toHaveCount(0);
	await expect(popup.frameLocator('.ash-theme-editor-preview').locator('#app')).toHaveCSS('--ash-input-foreground', '#112233');
});

test('Agent Window reports transformed token dependencies and keeps their alpha', async ({ page }) => {
	const popup = await openEditor(page);
	await popup.getByRole('tablist', { name: 'Preview window', exact: true }).getByRole('tab', { name: 'Agent Window', exact: true }).click();
	const frame = popup.frameLocator('.ash-theme-editor-preview');
	await expect(frame.locator('.ash-sessions-window')).toBeVisible();
	const search = popup.getByRole('searchbox', { name: 'Search colors' });
	await search.fill('sessions.accentGlow');
	const hex = popup.getByRole('textbox', { name: 'Hex color for sessions.accentGlow', exact: true });
	const row = popup.locator('.ash-theme-color').filter({ has: hex });
	await expect(row.locator('.ash-theme-color-source')).toHaveText('Derived from button.primaryBackground');
	await row.getByRole('button', { name: 'Go to design token button.primaryBackground', exact: true }).click();
	const source = popup.getByRole('textbox', { name: 'Hex color for button.primaryBackground', exact: true });
	await expect(popup.getByRole('button', { name: 'Choose color for button.primaryBackground', exact: true })).toBeFocused();
	await editColor(source, '#2288ee');
	await expect(frame.locator('#app')).toHaveCSS('--ash-sessions-accentGlow', 'rgba(34, 136, 238, 0.16)');
	await search.fill('sessions.accentGlow');
	await expect(hex).toHaveValue('2288EE');
	await editColor(hex, '#88442240');
	await expect(row.locator('.ash-theme-color-source')).toHaveText('Set in this file');
	await row.getByRole('button', { name: 'Remove the override for sessions.accentGlow', exact: true }).click();
	await expect(row.locator('.ash-theme-color-source')).toHaveText('Derived from button.primaryBackground');
	await expect(hex).toHaveValue('2288EE');
});

for (const theme of ['ash-light', 'ash-high-contrast-dark']) {
	test(`design token links are localized and keyboard accessible in ${theme}`, async ({ page }, testInfo) => {
		const popup = await openEditor(page, 'zh-CN', theme);
		await saveEditableTheme(popup, 'zh-CN');
		await popup.getByRole('searchbox', { name: '搜索颜色' }).fill('editorGroup.border');
		const token = theme === 'ash-light' ? 'border' : 'contrastBorder';
		const hex = popup.getByRole('textbox', { name: 'editorGroup.border 的十六进制颜色', exact: true });
		const row = popup.locator('.ash-theme-color').filter({ has: hex });
		await expect(row.locator('.ash-theme-color-source')).toHaveText(`关联到 ${token}`);
		await expect(row.locator('.ash-theme-color-reset')).toBeHidden();
		const link = row.getByRole('button', { name: `转到设计令牌 ${token}`, exact: true });
		await link.focus();
		await link.press('Shift+Tab');
		await popup.keyboard.press('Tab');
		await expect(link).toBeFocused();
		await expect(link).toHaveCSS('outline-style', 'solid');
		await popup.screenshot({ path: testInfo.outputPath('design-token-links-zh-cn.png') });
		await link.press('Space');
		await expect(popup.getByRole('button', { name: `为 ${token} 选择颜色`, exact: true })).toBeFocused();
	});
}

test('draft edits remain isolated until document save refreshes the applied theme', async ({ page }, testInfo) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	const popup = await openEditor(page);
	popup.on('pageerror', error => errors.push(error.message));
	await popup.getByRole('searchbox', { name: 'Search colors' }).fill('editor.background');
	const hex = popup.getByRole('textbox', { name: 'Hex color for editor.background', exact: true });
	await editColor(hex, '#112233');
	await expect.poll(() => popup.frameLocator('.ash-theme-editor-preview').locator('#app').evaluate(element => getComputedStyle(element).getPropertyValue('--ash-editor-background'))).toBe('#112233');
	const source = await page.evaluate(() => window.themeEditorTest.source());
	expect(source).toContain('// keep this comment');
	expect(source).toContain('"#112233"');
	expect(source).not.toContain('"statusBar.background"');
	expect(await page.evaluate(() => window.themeEditorTest.persisted())).toContain('"#101525"');
	await popup.screenshot({ path: testInfo.outputPath('theme-editor.png') });
	await page.evaluate(() => window.themeEditorTest.undo());
	await expect.poll(() => hex.inputValue()).toBe('101525');
	await editColor(hex, '#223344');
	await expect
		.poll(() =>
			popup
				.frameLocator('.ash-theme-editor-preview')
				.locator('#app')
				.evaluate(element => getComputedStyle(element).getPropertyValue('--ash-editor-background')),
		)
		.toBe('#223344');
	await expect
		.poll(() =>
			page
				.locator('#main')
				.evaluate(element => getComputedStyle(element).getPropertyValue('--ash-editor-background')),
		)
		.toBe('#101525');
	await chooseThemeAction(popup, 'Save');
	await expect.poll(() => page.evaluate(() => window.themeEditorTest.persisted())).toContain('#223344');
	await expect
		.poll(() =>
			page
				.locator('#main')
				.evaluate(element => getComputedStyle(element).getPropertyValue('--ash-editor-background')),
		)
		.toBe('#223344');
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
	await expect(hex).toHaveValue('101525');
	await value.fill('336699');
	await value.press('Enter');
	await expect(hex).toHaveValue('336699');
	await expect.poll(() => popup.frameLocator('.ash-theme-editor-preview').locator('#app').evaluate(element => getComputedStyle(element).getPropertyValue('--ash-editor-background'))).toBe('rgba(51, 102, 153, 0.5)');
	await page.evaluate(() => window.themeEditorTest.undo());
	await expect(hex).toHaveValue('101525');
	await expect(value).toHaveValue('101525');
	const source = await page.evaluate(() => window.themeEditorTest.source());
	await page.evaluate(text => window.themeEditorTest.setSource(text.replace('#10152580', '#abcdef40')), source);
	await expect(value).toHaveValue('ABCDEF');
	await expect(opacity).toHaveValue('25.1');
	await picker.getByRole('combobox', { name: 'Color format' }).selectOption('rgb');
	const blue = picker.getByRole('spinbutton', { name: 'RGB B', exact: true });
	await blue.fill('12');
	await blue.press('Enter');
	await expect(hex).toHaveValue('ABCD0C');
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
	await expect.poll(() => hex.inputValue()).not.toBe('ABCD0C');
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
	await expect.poll(() => hex.inputValue()).not.toBe('101525');
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
		await saveEditableTheme(popup);
		await expect(popup.frameLocator('.ash-theme-editor-preview').locator('#app')).toHaveAttribute('data-color-scheme', scheme);
		await popup.getByRole('searchbox', { name: 'Search colors' }).fill('editor.background');
		await popup.getByRole('button', { name: 'Choose color for editor.background', exact: true }).click();
		const picker = popup.getByRole('dialog', { name: 'Color picker', exact: true });
		await expect(popup.locator('html')).toHaveAttribute('data-color-scheme', scheme);
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
	await expect(popup.getByRole('textbox', { name: 'Hex color for editor.background', exact: true })).toHaveValue('ABCDEF');
	await page.evaluate(() => window.themeEditorTest.setSource('{"colors":'));
	await expect(popup.locator('.ash-theme-editor-message')).toHaveClass(/error/);
	await expect
		.poll(() =>
			popup
				.frameLocator('.ash-theme-editor-preview')
				.locator('#app')
				.evaluate(element => getComputedStyle(element).getPropertyValue('--ash-editor-background')),
		)
		.toBe('rgba(171, 205, 239, 0.5)');
	await chooseThemeAction(popup, 'Save');
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
	await editColor(popup.getByRole('textbox', { name: 'Hex color for editor.background', exact: true }), '#334455');
	await chooseThemeAction(popup, 'Save as…');
	const dialog = popup.getByRole('dialog', { name: 'Save as…' });
	await expect(dialog).toBeVisible();
	await dialog.getByRole('textbox', { name: 'Theme name' }).fill('New Aurora');
	await dialog.getByRole('button', { name: 'Save', exact: true }).click();
	await expect.poll(() => page.evaluate(() => window.themeEditorTest.persisted('new-aurora.json'))).toContain('#334455');
	await expect(popup.getByRole('tabpanel', { name: 'new-aurora.json', exact: true })).toBeVisible();
	expect(await page.evaluate(() => window.themeEditorTest.persisted())).toContain('#101525');
	await expect(popup.locator('.ash-theme-editor-message')).not.toHaveClass(/error/);
	await page.evaluate(() => window.themeEditorTest.close());
	await expect.poll(() => page.locator('#main').evaluate(element => getComputedStyle(element).getPropertyValue('--ash-editor-background'))).toBe('#101525');
});

test('Save as reverts the original shared JSON working copy without writing the original file', async ({ page }) => {
	const popup = await openEditor(page);
	const original = await page.evaluate(() => window.themeEditorTest.persisted());
	await page.evaluate(() => window.themeEditorTest.openJsonSource());
	await popup.getByRole('searchbox', { name: 'Search colors' }).fill('editor.background');
	await editColor(popup.getByRole('textbox', { name: 'Hex color for editor.background', exact: true }), '#abcdef');
	expect(await page.evaluate(() => window.themeEditorTest.mainEditors())).toEqual([expect.objectContaining({ resource: 'file:///themes/aurora.json', dirty: true })]);
	await saveEditableTheme(popup);
	expect(await page.evaluate(() => window.themeEditorTest.mainEditors())).toEqual([expect.objectContaining({ resource: 'file:///themes/aurora.json', dirty: false })]);
	expect(await page.evaluate(() => window.themeEditorTest.mainSource())).toBe(original);
	expect(await page.evaluate(() => window.themeEditorTest.persisted())).toBe(original);
	expect(await page.evaluate(() => window.themeEditorTest.persisted('editable-theme.json'))).toContain('#abcdef');
	expect(await page.evaluate(() => window.themeEditorTest.editors())).toEqual([
		expect.objectContaining({ resource: 'file:///themes/aurora.json', dirty: false }),
		expect.objectContaining({ resource: 'file:///themes/editable-theme.json', dirty: false }),
	]);
});

for (const setting of ['files.insertFinalNewline', 'files.trimTrailingWhitespace']) {
	test(`Document save accepts ${setting} cleanup from the shared save participants`, async ({ page }) => {
		const popup = await openEditor(page);
		await page.evaluate(async key => {
			await window.themeEditorTest.setSetting(key, true);
			window.themeEditorTest.setSource(window.themeEditorTest.source().trimEnd().replace('#101525', '#abcdef') + '  ');
		}, setting);
		await expect(popup.frameLocator('.ash-theme-editor-preview').locator('#app')).toHaveCSS(
			'--ash-editor-background',
			'#abcdef',
		);
		await chooseThemeAction(popup, 'Save');
		await expectSaved(page);
		await expect(page.locator('#main')).toHaveCSS('background-color', 'rgb(171, 205, 239)');
		const saved = await page.evaluate(() => window.themeEditorTest.persisted());
		expect(saved).toContain('#abcdef');
		if (setting === 'files.insertFinalNewline') expect(saved).toMatch(/\n$/);
		else expect(saved).not.toMatch(/ +$/);
		expect(await page.evaluate(() => window.themeEditorTest.editors())).toEqual([expect.objectContaining({ resource: 'file:///themes/aurora.json', dirty: false })]);
	});
}

test('Document save applies only the published content and retains newer dirty edits', async ({ page }) => {
	const popup = await openEditor(page);
	await popup.getByRole('searchbox', { name: 'Search colors' }).fill('editor.background');
	await editColor(popup.getByRole('textbox', { name: 'Hex color for editor.background', exact: true }), '#abcdef');
	await expect(popup.frameLocator('.ash-theme-editor-preview').locator('#app')).toHaveCSS('--ash-editor-background', '#abcdef');
	await page.evaluate(() => window.themeEditorTest.holdNextWrite());
	try {
		await chooseThemeAction(popup, 'Save');
		await page.evaluate(() => window.themeEditorTest.waitForWrite());
		await page.evaluate(() => window.themeEditorTest.setSource(window.themeEditorTest.source().replace('#abcdef', '#112233')));
	} finally {
		await page.evaluate(() => window.themeEditorTest.releaseWrite());
	}
	await expect.poll(() => page.evaluate(() => window.themeEditorTest.persisted())).toContain('#abcdef');
	expect(await page.evaluate(() => window.themeEditorTest.persisted())).toContain('#abcdef');
	expect(await page.evaluate(() => window.themeEditorTest.editors())).toEqual([
		expect.objectContaining({ resource: 'file:///themes/aurora.json', dirty: true }),
	]);
	await expect(page.locator('#main')).toHaveCSS('background-color', 'rgb(171, 205, 239)');
	await expect(popup.frameLocator('.ash-theme-editor-preview').locator('#app')).toHaveCSS(
		'--ash-editor-background',
		'#112233',
	);
});

for (const theme of ['aurora', 'ash-light']) {
	test(`closing ${theme} with Save refreshes its applied content across reloads`, async ({ page }) => {
		const popup = theme === 'aurora' ? await openEditor(page) : await openWritableBuiltin(page);
		await popup.getByRole('searchbox', { name: 'Search colors' }).fill('editor.background');
		await editColor(popup.getByRole('textbox', { name: 'Hex color for editor.background', exact: true }), '#abcdef');
		await expect(popup.frameLocator('.ash-theme-editor-preview').locator('#app')).toHaveCSS('--ash-editor-background', '#abcdef');
		await page.evaluate(() => window.themeEditorTest.saveOnClose());
		expect(await page.evaluate(() => window.themeEditorTest.close())).toBe(true);
		await expect.poll(() => popup.isClosed()).toBe(true);
		await page.evaluate(() => window.themeEditorTest.reloadThemes());
		expect(
			await page.evaluate(
				isUser =>
					isUser
						? window.themeEditorTest.persisted()
						: window.themeEditorTest.themeSource('themes/ash-light.json'),
				theme === 'aurora',
			),
		).toContain('#abcdef');
		await expect(page.locator('#main')).toHaveCSS('background-color', 'rgb(171, 205, 239)');
	});
}

test('an explicit save consumes its pending watcher refresh and later external writes still reload', async ({ page }) => {
	const popup = await openEditor(page);
	await popup.getByRole('searchbox', { name: 'Search colors' }).fill('editor.background');
	await editColor(popup.getByRole('textbox', { name: 'Hex color for editor.background', exact: true }), '#abcdef');
	await expect(popup.frameLocator('.ash-theme-editor-preview').locator('#app')).toHaveCSS('--ash-editor-background', '#abcdef');
	await page.clock.install();
	await page.evaluate(() => window.themeEditorTest.directoryReads(true));
	await chooseThemeAction(popup, 'Save');
	await expectSaved(page);
	await page.clock.runFor(200);
	expect(await page.evaluate(() => window.themeEditorTest.directoryReads())).toBe(1);
	const external = (await page.evaluate(() => window.themeEditorTest.persisted())).replace('#abcdef', '#135790');
	await page.evaluate(source => window.themeEditorTest.externalWrite(source), external);
	await page.clock.runFor(200);
	await expect.poll(() => page.evaluate(() => window.themeEditorTest.directoryReads())).toBe(2);
	await expect.poll(() => page.evaluate(() => window.themeEditorTest.source())).toBe(external);
});

test('an extension source save reuses its validated preview instead of recompiling its includes', async ({ page }) => {
	await page.goto('/themeEditor.html');
	await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
	await page.evaluate(async () => {
		await window.themeEditorTest.useWritableThemeSources();
		await window.themeEditorTest.selectTheme('ash-light');
	});
	await page.locator('#open').click();
	const popup = page;
	await expect(popup.frameLocator('.ash-theme-editor-preview').locator('body')).toHaveAttribute('data-ready', 'true');
	await page.evaluate(() =>
		window.themeEditorTest.setSource(window.themeEditorTest.source().replace('#ffffff', '#abcdef')),
	);
	await expect(popup.frameLocator('.ash-theme-editor-preview').locator('#app')).toHaveCSS(
		'--ash-editor-background',
		'#abcdef',
	);
	await page.evaluate(() => window.themeEditorTest.sourceReads(true));
	await popup.keyboard.press('ControlOrMeta+s');
	await expectSaved(page);
	// One validation read and one registration read; save publication reuses the preview.
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					window.themeEditorTest.sourceReads().filter(path => path.endsWith('/themes/light_syntax.json'))
						.length,
			),
		)
		.toBe(2);
	await expect(page.locator('#main')).toHaveCSS('background-color', 'rgb(171, 205, 239)');
});

test('Chinese labels and keyboard color adjustment work in the auxiliary window', async ({ page }) => {
	const popup = await openEditor(page, 'zh-CN');
	await expect(popup.locator('.ash-theme-editor')).toHaveAccessibleName('主题编辑器');
	await expect(popup.getByRole('button', { name: '界面表面', exact: true })).toHaveAttribute('aria-expanded', 'true');
	await expect(popup.frameLocator('.ash-theme-editor-preview').getByRole('button', { name: '搜索命令', exact: true })).toBeVisible();
	await popup.getByRole('searchbox', { name: '搜索颜色' }).fill('editor.background');
	const rowOpacity = popup.getByRole('spinbutton', { name: 'editor.background 的不透明度 (%)', exact: true });
	await editColor(rowOpacity, '50');
	await expect.poll(() => page.evaluate(() => window.themeEditorTest.source())).toContain('#10152580');
	await rowOpacity.press('Alt+F1');
	await expect(popup.getByRole('dialog').getByRole('textbox')).toHaveValue(/左侧是色块和十六进制颜色值，右侧是不透明度百分比/u);
	await expect(popup.getByRole('dialog').getByRole('textbox')).toHaveValue(/包括可见区域之外的颜色/u);
	await popup.keyboard.press('Escape');
	await expect(rowOpacity).toBeFocused();
	const swatch = popup.getByRole('button', { name: '为 editor.background 选择颜色', exact: true });
	await swatch.focus();
	await swatch.press('Enter');
	const picker = popup.getByRole('dialog', { name: '颜色选择器', exact: true });
	await expect(picker.getByRole('slider', { name: '饱和度和亮度', exact: true })).toBeFocused();
	const opacity = picker.getByRole('spinbutton', { name: '不透明度 (%)', exact: true });
	await opacity.fill('99');
	await opacity.press('Enter');
	await expect.poll(() => page.evaluate(() => window.themeEditorTest.source())).toContain('#101525fc');
	const value = picker.getByRole('textbox', { name: '颜色值', exact: true });
	await value.fill('224466');
	await value.press('Enter');
	await expect(popup.getByRole('textbox', { name: 'editor.background 的十六进制颜色', exact: true })).toHaveValue('224466');
	await popup.keyboard.press('Escape');
	await expect(picker).not.toBeVisible();
	await expect(swatch).toBeFocused();
	await chooseThemeAction(popup, '另存为…', 'zh-CN');
	await expect(popup.getByRole('dialog', { name: '另存为…' })).toBeVisible();
	await popup.keyboard.press('Escape');
	await expect(popup.getByRole('dialog')).not.toBeVisible();
});

test('closing an unsaved preview leaves the main window unchanged and leaves the theme file unchanged', async ({ page }) => {
	const popup = await openEditor(page);
	await popup.getByRole('searchbox', { name: 'Search colors' }).fill('editor.background');
	await editColor(popup.getByRole('textbox', { name: 'Hex color for editor.background', exact: true }), '#556677');
	await expect.poll(() => popup.frameLocator('.ash-theme-editor-preview').locator('#app').evaluate(element => getComputedStyle(element).getPropertyValue('--ash-editor-background'))).toBe('#556677');
	await page.evaluate(() => window.themeEditorTest.close());
	await expect.poll(() => popup.isClosed()).toBe(true);
	await expect.poll(() => page.locator('#main').evaluate(element => getComputedStyle(element).getPropertyValue('--ash-editor-background'))).toBe('#101525');
	expect(await page.evaluate(() => window.themeEditorTest.persisted())).toContain('#101525');
});

test('built-in themes open their clean source and only Save as creates a user theme', async ({ page }) => {
	const popup = await openEditor(page, undefined, 'ash-dark');
	await expect(popup.locator('.ash-theme-editor-message')).not.toHaveClass(/error/);
	expect(await page.evaluate(() => window.themeEditorTest.source())).toContain('"include":');
	expect(await page.evaluate(() => window.themeEditorTest.draft())).toBeUndefined();
	await chooseThemeAction(popup, 'Save as…');
	const dialog = popup.getByRole('dialog', { name: 'Save as…' });
	await expect(dialog).toBeVisible();
	await dialog.getByRole('textbox', { name: 'Theme name' }).fill('Custom Dark');
	await dialog.getByRole('textbox', { name: 'Theme name' }).press('Enter');
	await expect(dialog).not.toBeVisible();
	const exported = await page.evaluate(() => window.themeEditorTest.persisted('custom-dark.json'));
	expect(JSON.parse(exported!)).not.toHaveProperty('include');
	await popup.getByRole('searchbox', { name: 'Search colors' }).fill('editor.background');
	await editColor(popup.getByRole('textbox', { name: 'Hex color for editor.background', exact: true }), '#667788');
	await chooseThemeAction(popup, 'Save');
	await page.evaluate(() => window.themeEditorTest.selectTheme('custom-dark'));
	await expect
		.poll(() =>
			page
				.locator('#main')
				.evaluate(element => getComputedStyle(element).getPropertyValue('--ash-editor-background')),
		)
		.toBe('#667788');
	await page.evaluate(() => window.themeEditorTest.close());
});

for (const theme of ['aurora', 'ash-light']) {
	test(`reopening ${theme} reuses its source and closing leaves no main-window tabs`, async ({ page }) => {
		const popup = await openEditor(page, 'zh-CN', theme);
		const original = await page.evaluate(() => window.themeEditorTest.editors());
		expect(original).toHaveLength(1);
		expect(original[0].resource).toContain(theme === 'aurora' ? '/themes/aurora.json' : '/themes/ash-light.json');
		expect(original[0].label).not.toMatch(/Copy|副本/);
		expect(original[0].dirty).toBe(false);
		if (theme === 'ash-light') {
			await expect(popup.locator('.ash-theme-editor-message')).toHaveText('此主题源文件为只读。选择“另存为”可创建可编辑的用户主题。');
			await popup.getByRole('searchbox', { name: '搜索颜色' }).press('Alt+F1');
			await expect(popup.getByRole('dialog').getByRole('textbox')).toHaveValue(/原始主题源文件/u);
			await popup.keyboard.press('Escape');
		}
		await page.evaluate(async () => { await Promise.all(Array.from({ length: 4 }, () => window.themeEditorTest.open())); });
		expect(page.context().pages()).toHaveLength(2);
		expect(await page.evaluate(() => window.themeEditorTest.editors())).toEqual(original);
		await popup.close();
		await expect.poll(() => page.evaluate(() => window.themeEditorTest.editors())).toEqual([]);
		expect(await page.evaluate(() => window.themeEditorTest.mainEditors())).toEqual([]);
		const [reopened] = await Promise.all([
			page.waitForEvent('popup'),
			page.evaluate(async () => {
				await Promise.all(Array.from({ length: 4 }, () => window.themeEditorTest.open()));
				await window.themeEditorTest.detach();
			}),
		]);
		await expect(reopened.frameLocator('.ash-theme-editor-preview').locator('body')).toHaveAttribute(
			'data-ready',
			'true',
		);
		expect(page.context().pages()).toHaveLength(2);
		expect(await page.evaluate(() => window.themeEditorTest.editors())).toEqual(original);
		await page.evaluate(() => window.themeEditorTest.close());
		await expect.poll(() => reopened.isClosed()).toBe(true);
		expect(await page.evaluate(() => window.themeEditorTest.mainEditors())).toEqual([]);
	});
}

test('a development built-in theme opens and saves its checkout source instead of its installed copy', async ({
	page,
}) => {
	await page.goto('/themeEditor.html');
	await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
	await page.evaluate(async () => {
		await window.themeEditorTest.useWritableThemeSources();
		await window.themeEditorTest.selectTheme('ash-light');
	});
	const original = await page.evaluate(() => window.themeEditorTest.themeSource('themes/ash-light.json'));
	const installed = await page.evaluate(() => window.themeEditorTest.installedThemeSource('themes/ash-light.json'));
	await page.locator('#open').click();
	const popup = page;
	await expect(popup.frameLocator('.ash-theme-editor-preview').locator('body')).toHaveAttribute('data-ready', 'true');
	expect(await page.evaluate(() => window.themeEditorTest.source())).toBe(original);
	expect(await page.evaluate(() => window.themeEditorTest.editors())).toEqual([
		{
			resource: 'file:///extension-sources/theme-defaults/themes/ash-light.json',
			label: 'ash-light.json',
			dirty: false,
		},
	]);
	await chooseThemeAction(popup, 'Open Theme (JSON)');
	await page.evaluate(() =>
		window.themeEditorTest.setSource(window.themeEditorTest.source().replace('#ffffff', '#abcdef')),
	);
	await page.evaluate(() => window.themeEditorTest.extensionCatalogReads(true));
	await popup.keyboard.press('ControlOrMeta+s');
	await expectSaved(page);
	expect(await page.evaluate(() => window.themeEditorTest.extensionCatalogReads())).toBe(1);
	expect(await page.evaluate(() => window.themeEditorTest.themeSource('themes/ash-light.json'))).toContain('#abcdef');
	expect(await page.evaluate(() => window.themeEditorTest.themeSource('themes/ash-light.json'))).toContain(
		'"include":',
	);
	expect(await page.evaluate(() => window.themeEditorTest.installedThemeSource('themes/ash-light.json'))).toBe(
		installed,
	);
	await expect(page.locator('#main')).toHaveCSS('background-color', 'rgb(171, 205, 239)');
	await chooseThemeAction(popup, 'Open Theme (UI)');
	await chooseThemeAction(popup, 'Save as…');
	const dialog = popup.getByRole('dialog', { name: 'Save as…', exact: true });
	await dialog.getByRole('textbox', { name: 'Theme name', exact: true }).fill('Editable theme');
	await dialog.getByRole('textbox', { name: 'Theme name', exact: true }).press('Enter');
	await expect(dialog).toBeHidden();
	expect(await page.evaluate(() => window.themeEditorTest.persisted('editable-theme.json'))).toContain('#abcdef');
	expect(await page.evaluate(() => window.themeEditorTest.editors())).toEqual([{ resource: 'file:///themes/editable-theme.json', label: 'editable-theme.json', dirty: false }]);
});

test('extension publisher metadata remains editable and exports through Save as', async ({ page }) => {
	await page.goto('/themeEditor.html');
	await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
	await page.evaluate(async () => {
		await window.themeEditorTest.useWritableThemeSources();
		await window.themeEditorTest.selectTheme('ash-light');
	});
	const popup = await openDetached(page);
	const preview = popup.frameLocator('.ash-theme-editor-preview').locator('#app');
	await expect(popup.frameLocator('.ash-theme-editor-preview').locator('body')).toHaveAttribute('data-ready', 'true');
	await page.evaluate(() => {
		const source = window.themeEditorTest.source()
			.replace('{', '{ "author": "Publisher", "maintainers": ["Publisher"],')
			.replace(/"colors"\s*:\s*\{/, '$& "unavailableExtension.accent": "#12345680",');
		window.themeEditorTest.setSource(source);
	});
	await popup.getByRole('searchbox', { name: 'Search colors' }).fill('editor.background');
	const hex = popup.getByRole('textbox', { name: 'Hex color for editor.background', exact: true });
	await expect(hex).toBeEnabled();
	await editColor(hex, '#abcdef');
	await expect(preview).toHaveCSS('--ash-editor-background', '#abcdef');
	await expect(popup.locator('.ash-theme-editor-message')).not.toHaveClass(/error/);
	await expect(popup.locator('.ash-theme-color').filter({ has: hex }).locator('.ash-theme-color-source')).toHaveText(
		'Set in this file',
	);
	await chooseThemeAction(popup, 'Save');
	await expectSaved(page);
	expect(await page.evaluate(() => window.themeEditorTest.themeSource('themes/ash-light.json'))).toContain(
		'"author": "Publisher"',
	);
	await saveEditableTheme(popup);
	const exported = await page.evaluate(() => window.themeEditorTest.persisted('editable-theme.json'));
	expect(exported).toContain('#abcdef');
	const document = JSON.parse(exported!);
	expect(document.colors['unavailableExtension.accent']).toBe('#12345680');
	expect(document).not.toHaveProperty('author');
	expect(document).not.toHaveProperty('include');
	await expect(popup.locator('.ash-theme-editor-message')).not.toHaveClass(/error/);
});

test('accessibility help opens in the auxiliary window and restores its focused control', async ({ page }) => {
	const popup = await openEditor(page);
	await popup.bringToFront();
	const search = popup.getByRole('searchbox', { name: 'Search colors' });
	await search.focus();
	await popup.keyboard.press('Alt+F1');
	await expect(popup.getByRole('dialog', { name: 'Accessibility Help', exact: true })).toBeVisible();
	await expect(popup.getByRole('dialog').getByRole('textbox')).toHaveValue(/isolated preview/u);
	await expect(page.getByRole('dialog')).not.toBeVisible();
	await popup.keyboard.press('Escape');
	await expect(search).toBeFocused();
});

test('shared Workbench editors, file tree, split groups and terminal stay in the preview', async ({ page }, testInfo) => {
	const popup = await openEditor(page);
	const frame = popup.frameLocator('.ash-theme-editor-preview');
	const source = await page.evaluate(() => window.themeEditorTest.source());
	const colorMap = await page.evaluate(() => window.themeEditorTest.colorMap());
	const input = frame.getByRole('textbox', { name: 'palette.ts', exact: true });
	await input.focus();
	await input.press('ControlOrMeta+End');
	await input.press('Enter');
	await input.pressSequentially('preview_only');
	await expect
		.poll(() => page.evaluate(() => window.themeEditorTest.accessibleContent()))
		.not.toContain('preview_only');
	await input.press('ControlOrMeta+s');
	await input.press('Alt+F2');
	const accessible = popup.getByRole('dialog', { name: 'Accessible View', exact: true });
	await expect(accessible.getByRole('textbox')).toHaveValue(/export interface Palette/u);
	await popup.keyboard.press('Escape');
	await frame.getByRole('button', { name: 'Close palette.ts', exact: true }).click();
	await frame.getByRole('treeitem', { name: 'palette.ts', exact: true }).dblclick();
	await expect(input).toBeVisible();
	await expect
		.poll(() => page.evaluate(() => window.themeEditorTest.accessibleContent()))
		.not.toContain('preview_only');
	await frame.getByRole('button', { name: 'Split Right', exact: true }).click();
	await expect(frame.getByRole('region', { name: 'Editor group', exact: true })).toHaveCount(2);
	await frame.getByRole('treeitem', { name: 'src', exact: true }).click();
	await expect(frame.getByRole('treeitem', { name: 'src/index.ts', exact: true })).toBeVisible();
	await frame.getByRole('treeitem', { name: 'src/index.ts', exact: true }).dblclick();
	await expect(frame.getByRole('textbox', { name: 'index.ts', exact: true })).toBeVisible();
	const terminal = frame.getByRole('region', { name: 'Preview only', exact: true });
	await expect(frame.locator('.xterm, .ash-terminal-status')).toHaveCount(0);
	await terminal.focus();
	await expect.poll(() => page.evaluate(() => window.themeEditorTest.accessibleContent())).toContain('Terminal color preview. Commands are not executed.');
	await terminal.press('Alt+F2');
	await expect(accessible.getByRole('textbox')).toHaveValue(/Terminal color preview/u);
	await popup.keyboard.press('Escape');
	expect(await page.evaluate(() => window.themeEditorTest.source())).toBe(source);
	expect(await page.evaluate(() => window.themeEditorTest.persisted())).toBe(source);
	await popup.getByRole('searchbox', { name: 'Search colors' }).fill('editor.background');
	await editColor(popup.getByRole('textbox', { name: 'Hex color for editor.background', exact: true }), '#335577');
	await expect.poll(() => frame.locator('#app').evaluate(element => getComputedStyle(element).getPropertyValue('--ash-editor-background'))).toBe('#335577');
	expect(await page.evaluate(() => window.themeEditorTest.colorMap())).toEqual(colorMap);
	await expect(page.locator('#main')).toHaveCSS('background-color', 'rgb(16, 21, 37)');
	await popup.screenshot({ path: testInfo.outputPath('shared-workbench-interaction.png') });
	await page.evaluate(() => window.themeEditorTest.close());
	await expect.poll(() => popup.isClosed()).toBe(true);
	const reopened = await openDetached(page);
	const freshPreview = reopened.frameLocator('.ash-theme-editor-preview');
	await expect(freshPreview.locator('body')).toHaveAttribute('data-ready', 'true');
	await expect(freshPreview.getByRole('textbox', { name: 'palette.ts', exact: true })).toBeVisible();
	await freshPreview.getByRole('textbox', { name: 'palette.ts', exact: true }).focus();
	await expect.poll(() => page.evaluate(() => window.themeEditorTest.accessibleContent())).toContain('export interface Palette');
	await expect.poll(() => page.evaluate(() => window.themeEditorTest.accessibleContent())).not.toContain('preview_only');
});

test('Save and closing the editor retain the newly saved applied content', async ({ page }) => {
	const popup = await openEditor(page);
	await popup.getByRole('searchbox', { name: 'Search colors' }).fill('editor.background');
	await editColor(popup.getByRole('textbox', { name: 'Hex color for editor.background', exact: true }), '#445566');
	await chooseThemeAction(popup, 'Save');
	await expectSaved(page);
	await expect.poll(() => page.evaluate(() => window.themeEditorTest.persisted())).toContain('#445566');
	await expect(page.locator('#main')).toHaveCSS('background-color', 'rgb(68, 85, 102)');
	await page.evaluate(() => window.themeEditorTest.close());
	await expect.poll(() => popup.isClosed()).toBe(true);
	await expect(page.locator('#main')).toHaveCSS('background-color', 'rgb(68, 85, 102)');
	await page.evaluate(() => window.themeEditorTest.selectTheme('aurora'));
	await expect(page.locator('#main')).toHaveCSS('background-color', 'rgb(68, 85, 102)');
});

test('color list virtualizes scrolling and keeps an active edit through recycling', async ({ page }, testInfo) => {
	const popup = await openEditor(page);
	const search = popup.getByRole('searchbox');
	await search.fill('.');
	const rows = popup.locator('.ash-theme-color');
	const viewport = popup.locator('.ash-theme-editor-scroll .ash-scrollbar-viewport');
	const count = await popup.locator('.ash-theme-color-group-count').evaluateAll(nodes => nodes.reduce((sum, node) => sum + Number(node.textContent), 0));
	expect(count).toBeGreaterThan(200);
	await expect.poll(() => rows.count()).toBeLessThan(25);
	const id = await rows.nth(2).getByRole('textbox').getAttribute('aria-label');
	const first = popup.getByRole('textbox', { name: id!, exact: true });
	await first.fill('#12');
	const input = await first.elementHandle();
	for (const fraction of [0.5, 1, 0]) {
		await viewport.evaluate((element, fraction) => { element.scrollTop = (element.scrollHeight - element.clientHeight) * fraction; }, fraction);
		await expect.poll(() => rows.count()).toBeLessThan(25);
		await expect(first).toBeFocused();
		await expect(first).toHaveValue('#12');
		expect(await input!.evaluate(element => element.isConnected)).toBe(true);
	}
	await search.focus();
	await viewport.evaluate(element => { element.scrollTop = (element.scrollHeight - element.clientHeight) / 2; });
	await expect(first).toHaveCount(0);
	await expect.poll(() => viewport.evaluate(element => {
		const view = element.getBoundingClientRect();
		return [...element.querySelectorAll('.ash-theme-color')].some(row => {
			const bounds = row.getBoundingClientRect();
			return bounds.top < view.bottom && bounds.bottom > view.top;
		});
	})).toBe(true);
	const accessible = await page.evaluate(() => window.themeEditorTest.accessibleContent());
	expect(accessible.match(/^[a-z][\w.]*:/gmu)?.length).toBe(count);
	expect(accessible).toContain('terminal.ansiRed:');
	expect(accessible).toContain('editor.background:');
	await search.fill('terminal.ansiRed');
	const red = popup.getByRole('textbox', { name: 'Hex color for terminal.ansiRed', exact: true });
	await expect(red).toBeInViewport();
	await editColor(red, '#b51234');
	await expect(popup.frameLocator('.ash-theme-editor-preview').locator('[data-color="terminal.ansiRed"]')).toHaveCSS('color', 'rgb(181, 18, 52)');
	await search.fill('.');
	const swatchLabel = await rows.nth(2).locator('.ash-color-picker-input-swatch').getAttribute('aria-label');
	const swatch = popup.getByRole('button', { name: swatchLabel!, exact: true });
	await swatch.click();
	const picker = popup.getByRole('dialog', { name: 'Color picker', exact: true });
	await expect(picker).toBeVisible();
	await viewport.evaluate(element => { element.scrollTop = element.scrollHeight; });
	await expect(picker).toBeVisible();
	await popup.keyboard.press('Escape');
	await expect(picker).toBeHidden();
	await expect(swatch).toBeFocused();
	await search.focus();
	await popup.setViewportSize({ width: 1100, height: 580 });
	await expect.poll(() => rows.count()).toBeLessThan(20);
	await popup.screenshot({ path: testInfo.outputPath('virtual-colors.png') });
	await input!.dispose();
});

test('color list keyboard traversal reaches recycled rows and crosses group boundaries', async ({ page }) => {
	const popup = await openEditor(page);
	await popup.getByRole('searchbox').fill('terminal.');
	const heading = popup.getByRole('button', { name: 'Terminal', exact: true });
	await heading.focus();
	const names: string[] = [];
	for (let step = 0; step < 180; step++) {
		await popup.keyboard.press('Tab');
		const active = await popup.evaluate(() => {
			const element = document.activeElement;
			return { name: element?.matches('.ash-theme-color-name') ? element.textContent : undefined, inside: !!element?.closest('.ash-theme-editor-list') };
		});
		if (!active.inside) break;
		if (active.name) names.push(active.name);
	}
	expect(names.length).toBe(Number(await heading.locator('.ash-theme-color-group-count').textContent()));
	expect(new Set(names).size).toBe(names.length);
	expect(names).toContain('terminal.ansiBrightWhite');
	await popup.keyboard.press('Shift+Tab');
	await expect.poll(() => popup.evaluate(() => document.activeElement?.closest('.ash-theme-color')?.querySelector('.ash-theme-color-name')?.textContent)).toBe(names.at(-1));
	for (let step = 0; step < 180; step++) {
		if (await heading.evaluate(element => element === document.activeElement)) break;
		await popup.keyboard.press('Shift+Tab');
	}
	await expect(heading).toBeFocused();
	await popup.keyboard.press('Shift+Tab');
	await expect(popup.getByRole('searchbox')).toBeFocused();
	await popup.getByRole('searchbox').fill('');
	const textHeading = popup.getByRole('button', { name: 'Text and borders', exact: true });
	await textHeading.focus();
	await popup.keyboard.press('Shift+Tab');
	await expect.poll(() => popup.evaluate(() => document.activeElement?.closest('.ash-theme-color-group-body')?.id)).toBe('theme-color-group-surface');
	await popup.keyboard.press('Tab');
	await expect(textHeading).toBeFocused();
});

test('color categories use shared color and opacity rows and restore expansion after searching', async ({ page }) => {
	const popup = await openEditor(page);
	const surface = popup.getByRole('button', { name: 'Surface', exact: true });
	const editor = popup.getByRole('button', { name: 'Editor', exact: true });
	const swatch = popup.getByRole('button', { name: 'Choose color for editor.background', exact: true });
	await expect(surface).toHaveAttribute('aria-expanded', 'true');
	await expect(editor).toHaveAttribute('aria-expanded', 'false');
	await expect(swatch).toHaveCount(0);
	await expect(popup.locator('.ash-theme-color-group-body[hidden] .ash-theme-color')).toHaveCount(0);
	await surface.focus();
	await surface.press('Enter');
	await expect(surface).toHaveAttribute('aria-expanded', 'false');
	await expect(popup.locator('.ash-theme-color')).toHaveCount(0);
	await expect(surface).toBeFocused();
	await expect(surface).toHaveCSS('outline-style', 'solid');
	const liveRegion = page.locator('.ash-aria-live').first();
	await expect(liveRegion).toHaveCSS('position', 'fixed');
	await expect(liveRegion).toHaveCSS('width', '1px');
	const search = popup.getByRole('searchbox', { name: 'Search colors' });
	await search.fill('editor.background');
	await expect(editor).toHaveAttribute('aria-expanded', 'true');
	await expect(swatch).toBeVisible();
	await expect(popup.locator('.ash-theme-color-group[hidden] .ash-theme-color')).toHaveCount(0);
	await popup.getByRole('button', { name: 'editor.background', exact: true }).hover();
	const tooltip = popup.getByRole('tooltip').filter({ hasText: 'editor.background' });
	await expect(tooltip).toBeVisible();
	await expect(tooltip).toHaveCSS('padding', '6px 8px');
	const row = popup.locator('.ash-theme-color').filter({ has: swatch });
	const field = row.locator('.ash-color-picker-input');
	const alpha = row.getByRole('spinbutton', { name: 'Opacity for editor.background (%)', exact: true });
	await expect.poll(() => field.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
	const colorBounds = (await row.getByRole('textbox').boundingBox())!;
	const alphaBounds = (await alpha.boundingBox())!;
	expect(Math.abs(colorBounds.y - alphaBounds.y)).toBeLessThanOrEqual(1);
	expect(alphaBounds.x).toBeGreaterThan(colorBounds.x + colorBounds.width - 1);
	await expect(row.getByRole('slider')).toHaveCount(0);
	const hex = row.getByRole('textbox');
	await editColor(hex, '#12');
	await expect(hex).toHaveAttribute('aria-invalid', 'true');
	await editColor(hex, '#aabbcc');
	await hex.press('Tab');
	await expect(alpha).toBeFocused();
	await editColor(alpha, '40');
	await expect(hex).toHaveValue('AABBCC');
	await expect(swatch.locator('.ash-color-picker-input-preview')).toHaveCSS('background-image', /rgba\(170, 187, 204, 0.4\)/);
	await expect.poll(() => page.evaluate(() => window.themeEditorTest.source())).toContain('#aabbcc66');
	await row.getByRole('button', { name: 'Remove the override for editor.background', exact: true }).click();
	await expect.poll(() => page.evaluate(() => window.themeEditorTest.source())).not.toContain('"editor.background"');
	await search.fill('');
	await expect(surface).toHaveAttribute('aria-expanded', 'false');
	await expect(editor).toHaveAttribute('aria-expanded', 'false');
	await editor.focus();
	await editor.press('Space');
	await expect(swatch).toBeVisible();
	await search.fill('no-such-theme-token');
	await expect(popup.getByText('No matching colors', { exact: true })).toBeVisible();
	await search.fill('');
	await expect(editor).toHaveAttribute('aria-expanded', 'true');
});

for (const theme of ['ash-light', 'ash-dark']) {
	test(`desktop preview uses the production layout and chrome in ${theme}`, async ({ page }, testInfo) => {
		const popup = await openEditor(page, undefined, theme);
		await saveEditableTheme(popup);
		const frame = popup.frameLocator('.ash-theme-editor-preview');
		await popup.setViewportSize({ width: 1600, height: 1000 });
		const settingsTabs = popup.getByRole('tablist', { name: 'Preview window', exact: true }).getByRole('tab');
		const firstTab = await settingsTabs.nth(0).boundingBox();
		const secondTab = await settingsTabs.nth(1).boundingBox();
		expect(Math.abs(firstTab!.y - secondTab!.y)).toBeLessThan(1);
		expect(secondTab!.x).toBeGreaterThanOrEqual(firstTab!.x + firstTab!.width);
		const colors = await popup.locator('.ash-theme-editor-settings').boundingBox();
		const preview = await popup.locator('.ash-theme-editor-preview-host').boundingBox();
		expect(preview!.x).toBeGreaterThanOrEqual(colors!.x + colors!.width - 1);
		expect(Math.abs(preview!.y - colors!.y)).toBeLessThan(1);
		const windowBounds = await popup.locator('.ash-theme-editor-preview-viewport').boundingBox();
		expect(windowBounds!.x - preview!.x).toBeGreaterThanOrEqual(24);
		expect(windowBounds!.y - preview!.y).toBeGreaterThanOrEqual(24);
		expect(preview!.x + preview!.width - windowBounds!.x - windowBounds!.width).toBeGreaterThanOrEqual(24);
		expect(preview!.y + preview!.height - windowBounds!.y - windowBounds!.height).toBeGreaterThanOrEqual(24);
		await expect(frame.locator('#app')).toHaveAttribute('data-layout-style', 'modern');
		await expect(frame.locator('.ash-workbench-titlebar')).toHaveCSS('height', '35px');
		await expect(frame.locator('.ash-workbench-statusbar')).toHaveCSS('height', '32px');
		// With terminal.background unset, the panel terminal follows panel.background.
		await expect(frame.locator('.ash-theme-preview-terminal')).toHaveCSS('background-color', theme === 'ash-light' ? 'rgb(248, 248, 248)' : 'rgb(37, 37, 38)');
		await expect(frame.getByRole('tab', { name: 'Explorer', exact: true })).toBeVisible();
		await frame.getByRole('button', { name: 'Hide Primary Side Bar', exact: true }).click();
		await expect(frame.getByRole('region', { name: 'Primary sidebar', exact: true })).toBeHidden();
		await frame.getByRole('button', { name: 'Show Primary Side Bar', exact: true }).click();
		await expect(frame.getByRole('region', { name: 'Primary sidebar', exact: true })).toBeVisible();
		await frame.getByRole('button', { name: 'Hide Panel', exact: true }).click();
		await expect(frame.getByRole('region', { name: 'Panel', exact: true })).toBeHidden();
		await frame.getByRole('button', { name: 'Toggle Panel Visibility', exact: true }).click();
		await expect(frame.getByRole('region', { name: 'Panel', exact: true })).toBeVisible();
		await frame.getByRole('button', { name: 'Search commands', exact: true }).click();
		const quickOpen = frame.getByRole('combobox');
		await quickOpen.fill('settings.json');
		await quickOpen.press('Enter');
		await expect(frame.getByRole('textbox', { name: 'settings.json', exact: true })).toBeVisible();
		await frame.getByRole('tab', { name: 'palette.ts', exact: true }).click();
		await popup.screenshot({ path: testInfo.outputPath('desktop-preview.png') });
		await popup.setViewportSize({ width: 1100, height: 760 });
		await expect.poll(() => popup.locator('.ash-theme-editor-preview').evaluate(element => {
			const scale = new DOMMatrix(getComputedStyle(element).transform).a;
			return scale > 0 && scale < 1;
		})).toBe(true);
		await expect(frame.locator('.ash-workbench-titlebar')).toHaveCSS('height', '35px');
		expect(await frame.locator('#app').evaluate(element => {
			const bounds = element.getBoundingClientRect();
			const parts = [...element.querySelectorAll('.ash-workbench-titlebar, .ash-workbench-statusbar, .ash-workbench-editor')];
			return parts.length === 3 && parts.every(part => {
				const box = part.getBoundingClientRect();
				return box.width > 0 && box.height > 0 && box.left >= bounds.left && box.top >= bounds.top && box.right <= bounds.right + 1 && box.bottom <= bounds.bottom + 1;
			});
		})).toBe(true);
		await popup.screenshot({ path: testInfo.outputPath('desktop-preview-fit.png') });
		await popup.getByRole('searchbox', { name: 'Search colors' }).fill('titleBar.background');
		await editColor(popup.getByRole('textbox', { name: 'Hex color for titleBar.background', exact: true }), '#335577');
		await expect(frame.locator('.ash-workbench-titlebar')).toHaveCSS('background-color', 'rgb(51, 85, 119)');
	});
}

test('desktop presentation changes flow into the fixed preview', async ({ page }) => {
	const popup = await openEditor(page);
	const frame = popup.frameLocator('.ash-theme-editor-preview');
	const input = frame.getByRole('textbox', { name: 'palette.ts', exact: true });
	await input.focus();
	await input.press('ControlOrMeta+End');
	await input.pressSequentially('keep_local_edit');
	await page.evaluate(() => window.themeEditorTest.setSetting('workbench.layoutStyle', 'flat'));
	await expect(frame.locator('#app')).toHaveAttribute('data-layout-style', 'flat');
	await page.evaluate(() => window.themeEditorTest.setSetting('workbench.sideBar.location', 'right'));
	await expect.poll(async () => {
		const sidebar = await frame.getByRole('region', { name: 'Primary sidebar', exact: true }).boundingBox();
		const editor = await frame.getByRole('region', { name: 'Editor', exact: true }).boundingBox();
		return sidebar!.x > editor!.x;
	}).toBe(true);
	await page.evaluate(() => window.themeEditorTest.setSetting('workbench.layoutStyle', 'modern'));
	await expect(frame.locator('#app')).toHaveAttribute('data-layout-style', 'modern');
	await expect
		.poll(() => page.evaluate(() => window.themeEditorTest.accessibleContent()))
		.not.toContain('keep_local_edit');
});

test('preview follows consecutive shared color field commits', async ({ page }) => {
	const popup = await openEditor(page);
	await popup.getByRole('searchbox', { name: 'Search colors' }).fill('editor.background');
	const color = popup.getByRole('textbox', { name: 'Hex color for editor.background', exact: true });
	const observed = await color.evaluate(async element => {
		const input = element as HTMLInputElement;
		const preview = element.ownerDocument.querySelector<HTMLIFrameElement>('.ash-theme-editor-preview')!;
		const colors = new Set<string>();
		const initial = preview.contentWindow!.getComputedStyle(preview.contentDocument!.getElementById('app')!).getPropertyValue('--ash-editor-background');
		let last = '';
		for (let index = 0; index < 40; index++) {
			await new Promise<void>(resolve => element.ownerDocument.defaultView!.requestAnimationFrame(() => resolve()));
			last = '#' + (0x223300 + index).toString(16);
			input.value = last;
			input.dispatchEvent(new Event('change', { bubbles: true }));
			const value = preview.contentWindow!.getComputedStyle(preview.contentDocument!.getElementById('app')!).getPropertyValue('--ash-editor-background');
			if (value !== initial) colors.add(value);
		}
		return { colors: [...colors], last };
	});
	expect(observed.colors.length).toBeGreaterThan(1);
	await expect(popup.frameLocator('.ash-theme-editor-preview').locator('#app')).toHaveCSS('--ash-editor-background', observed.last);
});

test('resizing the preview and toggling its panel delivers layout without observer loops', async ({ page }) => {
	const errors: string[] = [];
	page.context().on('weberror', event => errors.push(event.error().message));
	page.context().on('console', message => {
		if (message.type() === 'error' && message.text().includes('ResizeObserver')) errors.push(message.text());
	});
	const popup = await openEditor(page);
	const frame = popup.frameLocator('.ash-theme-editor-preview');
	for (let iteration = 0; iteration < 6; iteration++) {
		await popup.setViewportSize(iteration % 2 ? { width: 1600, height: 1000 } : { width: 1100, height: 760 });
		await frame.getByRole('button', { name: 'Hide Panel', exact: true }).click();
		await frame.getByRole('button', { name: 'Toggle Panel Visibility', exact: true }).click();
		await expect(frame.getByRole('region', { name: 'Preview only', exact: true })).toBeVisible();
		await expect.poll(() => frame.locator('#app').evaluate(element => {
			const window = element.ownerDocument.defaultView!;
			return Math.abs(element.getBoundingClientRect().height - window.innerHeight);
		})).toBeLessThan(1);
	}
	expect(errors).toEqual([]);
});

test('switches to the production Agent Window, edits its colors and keeps one isolated preview', async ({ page }, testInfo) => {
	const popup = await openEditor(page);
	const errors: string[] = [];
	popup.on('pageerror', error => errors.push(error.message));
	popup.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
	const tabs = popup.getByRole('tablist', { name: 'Preview window', exact: true });
	const agent = tabs.getByRole('tab', { name: 'Agent Window', exact: true });
	await tabs.getByRole('tab', { name: 'Workbench', exact: true }).focus();
	await popup.keyboard.press('ArrowRight');
	await expect(tabs.getByRole('tab', { name: 'Diff', exact: true })).toBeFocused();
	await popup.keyboard.press('ArrowRight');
	await expect(agent).toBeFocused();
	await popup.keyboard.press('Enter');
	await expect(agent).toHaveAttribute('aria-selected', 'true');
	const frame = popup.frameLocator('.ash-theme-editor-preview');
	await expect(frame.locator('.ash-sessions-window')).toBeVisible();
	await expect(frame.locator('body')).toHaveAttribute('data-ready', 'true');
	await page.evaluate(() => window.themeEditorTest.setSetting('sessions.layoutStyle', 'flat'));
	await expect(frame.locator('.ash-sessions-window')).toHaveAttribute('data-layout-style', 'flat');
	await page.evaluate(() => window.themeEditorTest.setSetting('sessions.layoutStyle', 'modern'));
	await expect(frame.locator('.ash-sessions-window')).toHaveAttribute('data-layout-style', 'modern');
	await popup.getByRole('searchbox', { name: 'Search colors' }).fill('sessions.activityBar.foreground');
	const color = popup.getByRole('textbox', { name: 'Hex color for sessions.activityBar.foreground', exact: true });
	await expect(color).toBeVisible();
	await editColor(color, '#ff9900');
	await expect.poll(() => frame.locator('#app').evaluate(element => getComputedStyle(element).getPropertyValue('--ash-sessions-activityBar-foreground'))).toBe('#ff9900');
	const navigation = frame.locator('.ash-sessions-activity-content');
	await frame.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
	await expect(frame.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true })).toHaveAttribute('aria-pressed', 'true');
	await navigation.getByRole('button', { name: 'New', exact: true }).click();
	await expect(navigation.getByRole('button', { name: 'New', exact: true })).toHaveAttribute('aria-current', 'page');
	await popup.screenshot({ path: testInfo.outputPath('agent-window-theme-preview.png') });
	await tabs.getByRole('tab', { name: 'Workbench', exact: true }).click();
	await expect(frame.locator('body')).toHaveAttribute('data-ready', 'true');
	await expect(frame.locator('.ash-sessions-window')).toHaveCount(0);
	await expect(popup.locator('iframe.ash-theme-editor-preview')).toHaveCount(1);
	await agent.click();
	await expect(frame.locator('.ash-sessions-window')).toBeVisible();
	await expect.poll(() => frame.locator('#app').evaluate(element => getComputedStyle(element).getPropertyValue('--ash-sessions-activityBar-foreground'))).toBe('#ff9900');
	expect(await page.evaluate(() => window.themeEditorTest.source())).toContain('#ff9900');
	expect(await page.evaluate(() => window.themeEditorTest.persisted())).not.toContain('#ff9900');
	expect(errors).toEqual([]);
});

for (const theme of ['ash-light', 'ash-high-contrast-dark']) {
	test(`Agent Window switch is localized and keyboard accessible in ${theme}`, async ({ page }, testInfo) => {
		const popup = await openEditor(page, 'zh-CN', theme);
		const tabs = popup.getByRole('tablist', { name: '预览窗口', exact: true });
		await tabs.getByRole('tab', { name: '桌面工作台', exact: true }).focus();
		await popup.keyboard.press('End');
		await popup.keyboard.press('ArrowLeft');
		const agent = tabs.getByRole('tab', { name: 'Agent 窗口', exact: true });
		await expect(agent).toBeFocused();
		await popup.keyboard.press('Space');
		const frame = popup.frameLocator('.ash-theme-editor-preview');
		await expect(frame.locator('.ash-sessions-window')).toBeVisible();
		await expect(frame.locator('body')).toHaveAttribute('data-ready', 'true');
		await expect(agent).toHaveAttribute('aria-selected', 'true');
		await popup.setViewportSize({ width: 900, height: 720 });
		const bounds = await popup.locator('.ash-theme-editor-preview-viewport').boundingBox();
		expect(bounds!.width).toBeGreaterThan(300);
		expect(bounds!.height).toBeGreaterThan(400);
		await expect(frame.locator('html')).toHaveAttribute('lang', 'zh-CN');
		await popup.getByRole('searchbox', { name: '搜索颜色' }).fill('sessions.');
		await expect(popup.getByRole('button', { name: /^Agent 窗口/u })).toBeVisible();
		await popup.screenshot({ path: testInfo.outputPath('agent-window-zh-cn.png') });
	});
}
