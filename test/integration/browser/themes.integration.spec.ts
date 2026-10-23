import { expectIconFontLoaded } from '../../automation/iconFonts.js';
import { test } from './rustSyntaxProcessFixture.js';
import { expect } from '@playwright/test';

test('host styles reach nested inputs, select popups, submenus, tree find and dialog buttons', async ({ page }) => {
	await page.goto('/themes.html');
	await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
	await page.evaluate(() => window.mountDefaultStyleProbes());
	const input = page.getByRole('textbox', { name: 'Styled input', exact: true });
	const find = page.getByRole('searchbox', { name: 'Find in Tree', exact: true });
	const select = page.getByRole('combobox', { name: 'Styled select', exact: true });
	const retainedInput = await input.elementHandle();
	for (const id of ['ash-dark', 'ash-light', 'ash-high-contrast-dark', 'ash-high-contrast-light']) {
		await page.evaluate(id => { window.selectColorTheme(id); window.openStyledTreeFind(); }, id);
		const colors = await page.locator('#root').evaluate(root => {
			const probe = document.createElement('span');
			root.append(probe);
			try {
				return Object.fromEntries([
					'error-foreground', 'selection-background', 'accent-background',
					'foreground', 'badge-background', 'widget-border',
					'list-activeSelectionBackground', 'list-activeSelectionForeground', 'list-inactiveSelectionBackground', 'list-hoverBackground',
				].map(id => {
					probe.style.color = `var(--ash-${id})`;
					return [id, getComputedStyle(probe).color];
				}));
			} finally { probe.remove(); }
		});
		await expect(input.locator('..')).toHaveCSS('background-color', colors['selection-background']!);
		await expect(find.locator('..')).toHaveCSS('background-color', colors['error-foreground']!);
		await find.fill('missing');
		await expect(page.locator('#styled-tree .ash-tree-find-widget')).toHaveCSS('border-top-color', colors['error-foreground']!);
		await find.fill('');
		await expect(page.locator('#styled-tree .ash-tree-find-widget')).toHaveCSS('border-top-color', colors['widget-border']!);
		await find.press('Escape');
		await page.locator('#styled-tree .ash-tree').focus();
		await expect(page.locator('#styled-tree .ash-tree-row.focused')).toHaveCSS('outline-color', colors['error-foreground']!);
		const selected = page.locator('#styled-tree .ash-tree-row.selected');
		await expect(selected).toHaveAttribute('aria-selected', 'true');
		await selected.hover();
		await expect(selected).toHaveCSS('background-color', colors['list-activeSelectionBackground']!);
		await expect(selected).toHaveCSS('color', colors['list-activeSelectionForeground']!);
		await input.focus();
		await expect(selected).toHaveCSS('background-color', colors['list-inactiveSelectionBackground']!);
		await selected.hover();
		await expect(selected).toHaveCSS('background-color', colors['list-inactiveSelectionBackground']!);
		const hovered = page.locator('#styled-tree .ash-tree-row').nth(1);
		await hovered.hover();
		await expect(hovered).toHaveCSS('background-color', colors['list-hoverBackground']!);
		await expect(page.locator('#default-style-probes .ash-count-badge')).toHaveCSS('background-color', colors['badge-background']!);
		await expect(page.locator('#default-style-probes progress')).toHaveCSS('accent-color', colors['accent-background']!);
		await expect(page.getByRole('checkbox', { name: 'Styled checkbox' })).toHaveCSS('accent-color', colors['accent-background']!);
		await expect(page.locator('#default-style-probes .ash-switch-track')).toHaveCSS(
			'background-color', colors[id.includes('high-contrast') ? 'foreground' : 'error-foreground']!,
		);
		const list = page.getByRole('listbox', { name: 'Styled list', exact: true });
		await list.focus();
		await expect(list.locator('.ash-list-row.selected')).toHaveCSS('background-color', colors['error-foreground']!);
		await input.focus();
		await expect(list.locator('.ash-list-row.selected')).toHaveCSS('background-color', colors['selection-background']!);
		await list.locator('.ash-list-row').nth(1).hover();
		await expect(list.locator('.ash-list-row').nth(1)).toHaveCSS('background-color', colors['selection-background']!);
		await expect(select).toHaveCSS('background-color', colors['selection-background']!);
		await select.click();
		await expect(page.locator('.ash-select-box-list')).toHaveCSS('background-color', colors['error-foreground']!);
		for (const option of await page.locator('.ash-select-box-option').all()) {
			expect((await option.boundingBox())!.height).toBe(22);
			await expect(option.locator('.ash-icon')).toHaveCSS('height', '16px');
		}
		await page.keyboard.press('Escape');
		const submenu = page.getByRole('menuitem', { name: 'Styled submenu', exact: true });
		await submenu.focus();
		await submenu.press('ArrowRight');
		const leaf = page.getByRole('menuitem', { name: 'Styled leaf', exact: true });
		await expect(leaf).toBeVisible();
		await expect.poll(() => leaf.evaluate(element => getComputedStyle(element.closest('.ash-menu')!).backgroundColor))
			.toBe(colors['error-foreground']);
		await leaf.press('Escape');
		await page.evaluate(() => window.openStyledDialog());
		const dialog = page.getByRole('dialog', { name: 'Styled dialog', exact: true });
		await expect(dialog).toHaveCSS('background-color', colors['selection-background']!);
		await expect(dialog.getByRole('button', { name: 'Styled done' })).toHaveCSS('background-color', colors['error-foreground']!);
		await page.keyboard.press('Escape');
		await expect(dialog).toBeHidden();
	}
	expect(await retainedInput!.evaluate(element => element === document.querySelector('#default-style-probes input'))).toBe(true);
	await test.info().attach('nested-default-styles', { body: await page.screenshot(), contentType: 'image/png' });
});

test('default widget styles and overrides follow the containing theme without replacing their controls', async ({ page }) => {
	await page.goto('/themes.html');
	await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
	const defaultButton = page.getByRole('button', { name: 'Default theme styles', exact: true });
	const overrideButton = page.getByRole('button', { name: 'Override theme styles', exact: true });
	const swappedButton = page.getByRole('button', { name: 'Swapped theme styles', exact: true });
	const retained = await overrideButton.elementHandle();
	for (const id of ['ash-dark', 'ash-light', 'ash-high-contrast-dark', 'ash-high-contrast-light']) {
		await page.evaluate(id => window.selectColorTheme(id), id);
		await page.mouse.move(0, 0);
		const colors = await page.locator('#root').evaluate(root => {
			const probe = document.createElement('span');
			root.append(probe);
			const resolve = (variable: string): string => {
				probe.style.color = `var(${variable})`;
				return getComputedStyle(probe).color;
			};
			try {
				return {
					background: resolve('--ash-button-primaryBackground'), foreground: resolve('--ash-button-primaryForeground'),
					customBackground: resolve('--ash-error-foreground'), customForeground: resolve('--ash-editor-background'),
					hover: resolve('--ash-focusBorder'),
				};
			} finally { probe.remove(); }
		});
		await expect(defaultButton).toHaveCSS('background-color', colors.background);
		await expect(defaultButton).toHaveCSS('color', colors.foreground);
		await expect(overrideButton).toHaveCSS('background-color', colors.customBackground);
		await expect(overrideButton).toHaveCSS('color', colors.customForeground);
		await expect(swappedButton).toHaveCSS('background-color', colors.foreground);
		await expect(swappedButton).toHaveCSS('color', colors.background);
		await overrideButton.hover();
		await expect(overrideButton).toHaveCSS('background-color', colors.hover);
		await test.info().attach(`default-styles-${id}`, {
			body: await page.screenshot(), contentType: 'image/png',
		});
	}
	expect(await retained!.evaluate(element => element === document.querySelector('#default-style-buttons button:nth-child(2)'))).toBe(true);
});

test('high contrast classes activate focused icon borders and are cleared and restored with the binding', async ({ page }) => {
	await page.goto('/themes.html');
	await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
	const root = page.locator('#root');
	const search = page.getByRole('combobox', { name: 'Search icons' });
	await search.focus();
	await search.press('ArrowRight');
	const focused = page.locator('.ash-icon-select-item.focused');
	await expect(focused).toHaveCount(1);
	for (const [id, themeClass, border] of [
		['ash-high-contrast-dark', 'hc-black', 'rgb(255, 255, 255)'],
		['ash-high-contrast-light', 'hc-light', 'rgb(0, 0, 0)'],
	] as const) {
		await page.evaluate(id => window.selectColorTheme(id), id);
		await expect(root).toHaveClass(new RegExp(`\\b${themeClass}\\b`));
		await expect(root).toHaveClass(/\bash-high-contrast\b/);
		await expect(focused).toHaveCSS('border-top-color', border);
		await expect(focused).toHaveCSS('border-top-style', 'solid');
	}
	await page.evaluate(() => window.selectColorTheme('ash-light'));
	await expect(root).not.toHaveClass(/\b(?:hc-black|hc-light|ash-high-contrast)\b/);
	await page.evaluate(() => window.selectColorTheme('ash-high-contrast-dark'));
	await page.evaluate(() => window.disposeThemeRoot());
	await expect(root).not.toHaveClass(/\b(?:hc-black|hc-light|ash-high-contrast)\b/);
});

test('size tokens preserve camelCase and resolve in every color theme', async ({ page }) => {
	await page.goto('/themes.html');
	await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
	for (const id of ['ash-dark', 'ash-light', 'ash-high-contrast-dark', 'ash-high-contrast-light']) {
		await page.evaluate(id => window.selectColorTheme(id), id);
		await expect.poll(() => page.locator('#root').evaluate(element => {
			const probe = document.createElement('span');
			probe.style.fontSize = 'var(--ash-fontSize-body1)';
			probe.style.fontWeight = 'var(--ash-fontWeight-semiBold)';
			probe.style.borderRadius = 'var(--ash-cornerRadius-medium)';
			element.append(probe);
			try {
				const rootStyle = getComputedStyle(element);
				const style = getComputedStyle(probe);
				return {
					fontSize: style.fontSize,
					fontWeight: style.fontWeight,
					borderRadius: style.borderRadius,
					oldFontSize: rootStyle.getPropertyValue('--ash-font-size-body1'),
					oldFontWeight: rootStyle.getPropertyValue('--ash-font-weight-semi-bold'),
				};
			} finally {
				probe.remove();
			}
		})).toEqual({ fontSize: '13px', fontWeight: '600', borderRadius: '6px', oldFontSize: '', oldFontWeight: '' });
	}
});

test('resource decorations resolve asynchronously, follow themes and clear after provider removal', async ({ page }) => {
	await page.goto('/themes.html');
	await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
	const label = page.locator('#decorated-label .ash-icon-label');
	const name = label.locator('.ash-icon-label-text');
	await page.evaluate(() => window.setLabelDecoration({ color: 'description.foreground', letter: 'I', tooltip: 'Ignored by Git' }));
	await expect(label).toHaveAttribute('aria-label', 'ignored.log, Ignored by Git');
	await expect.poll(() => label.evaluate(element => getComputedStyle(element, '::after').content)).toBe('"I"');
	for (const id of ['ash-dark', 'ash-light', 'ash-high-contrast-dark', 'ash-high-contrast-light']) {
		await page.evaluate(id => window.selectColorTheme(id), id);
		await expect.poll(async () => {
			return name.evaluate(element => {
				const reference = document.createElement('span');
				reference.style.color = 'var(--ash-description-foreground)';
				element.parentElement!.append(reference);
				const matches = getComputedStyle(element).color === getComputedStyle(reference).color;
				reference.remove();
				return matches;
			});
		}).toBe(true);
	}
	await page.evaluate(() => window.removeLabelDecorationProvider());
	await expect(label).not.toHaveAttribute('aria-label', /Ignored/u);
	await expect.poll(() => label.evaluate(element => getComputedStyle(element, '::after').content)).toBe('none');
	await expect.poll(() => page.locator('[data-ash-decorations]').textContent()).toBe('');
});


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

test('an active workbench theme includes later colors and preserves host overrides on disposal', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto('/themes.html');
	await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
	const root = page.locator('#root');
	await page.evaluate(() => window.registerLateThemeColor());
	expect(await root.evaluate(element => getComputedStyle(element).getPropertyValue('--ash-test-browserLate'))).toBe('#123456');
	await page.getByRole('button', { name: 'Light', exact: true }).click();
	expect(await root.evaluate(element => getComputedStyle(element).getPropertyValue('--ash-test-browserLate'))).toBe('#abcdef');
	await root.evaluate(element => element.style.setProperty('--ash-test-browserLate', '#fedcba', 'important'));
	expect(await root.evaluate(element => getComputedStyle(element).getPropertyValue('--ash-test-browserLate'))).toBe('#fedcba');
	await page.evaluate(() => window.disposeThemeRoot());
	expect(await root.evaluate(element => [element.style.getPropertyValue('--ash-test-browserLate'), element.style.getPropertyPriority('--ash-test-browserLate')])).toEqual(['#fedcba', 'important']);
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
	const editorHover = page.locator('.stanza-editor-hover');
	await root.evaluate(element => {
		element.classList.add('ash-workbench');
		for (const className of ['ash-notification', 'ash-context-view-default', 'ash-context-view-hover', 'ash-list-row ash-dnd-drop-before', 'ash-pdf-page', 'stanza-editor-hover']) {
			const item = document.createElement('div');
			item.className = className;
			item.textContent = className;
			element.append(item);
		}

	});
	expect(await notification.evaluate(element => getComputedStyle(element).boxShadow)).not.toBe('none');
	expect(await contextView.evaluate(element => getComputedStyle(element).boxShadow)).not.toBe('none');
	expect(await hoverView.evaluate(element => getComputedStyle(element).boxShadow)).not.toBe('none');
	expect(await dropRow.evaluate(element => getComputedStyle(element).boxShadow)).not.toBe('none');
	expect(await pdfPage.evaluate(element => getComputedStyle(element).boxShadow)).not.toBe('none');
	for (const [id, border] of [['ash-high-contrast-dark', 'rgb(255, 255, 255)'], ['ash-high-contrast-light', 'rgb(0, 0, 0)']] as const) {
		await page.evaluate(id => window.selectColorTheme(id), id);
		await expect(root).toHaveAttribute('data-color-theme', id);
		await expect(editorHover).toHaveCSS('box-shadow', 'none');
		await expect(editorHover).toHaveCSS('border-top-color', border);
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
		await expect(nested).toHaveAttribute('data-color-scheme', 'hcDark');
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
			<div class="ash-menu ash-action-widget"><div class="ash-action-view-item focused"><button class="ash-button" id="focus-code-action">Code action</button></div></div>
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

test('Seti TODO icons match between resource labels and completion CSS across color schemes', async ({ page }) => {
	await page.goto('/themes.html');
	await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
	await page.locator('#root').evaluate(root => {
		root.classList.add('ash-workbench');
		const icon = document.createElement('span');
		icon.id = 'todo-suggestion-icon';
		icon.className = 'ash-themed-file-icon file-icon todo.md-name-file-icon md-ext-file-icon markdown-lang-file-icon';
		icon.setAttribute('aria-hidden', 'true');
		root.append(icon);
	});
	const icon = page.locator('#todo-icon .ash-icon-label-icon');
	const suggestion = page.locator('#todo-suggestion-icon');
	for (const id of ['ash-dark', 'ash-light', 'ash-high-contrast-dark', 'ash-high-contrast-light']) {
		await page.evaluate(id => window.selectColorTheme(id), id);
		await expect(icon).toHaveText('\uE096');
		await expect(icon).toHaveAttribute('aria-hidden', 'true');
		const expectedColor = id === 'ash-light' || id === 'ash-high-contrast-light' ? 'rgb(73, 139, 167)' : 'rgb(81, 154, 186)';
		await expect(icon).toHaveCSS('color', expectedColor);
		await expect(page.locator('#markdown-icon .ash-icon-label-icon')).toHaveCSS('color', expectedColor);
		await expect.poll(() => suggestion.evaluate(element => {
			const style = getComputedStyle(element, '::before');
			return { content: style.content, color: style.color, font: style.fontFamily };
		})).toEqual({ content: '"\uE096"', color: expectedColor, font: await icon.evaluate(element => getComputedStyle(element).fontFamily) });
		await icon.evaluate(element => document.fonts.load('16px ' + getComputedStyle(element).fontFamily));
		await test.info().attach(`seti-todo-${id}`, { body: await page.screenshot(), contentType: 'image/png' });
	}
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


test('open models update file and untitled icons in place and release their language state', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto('/themes.html');
	await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
	const host = page.locator('#model-icon');
	const icon = host.locator('.ash-icon-label-icon');
	const untitledIcon = page.locator('#untitled-icon .ash-icon-label-icon');
	await expect(icon).toHaveClass(/typescript-lang-file-icon/u);
	await expect(untitledIcon).toHaveClass(/typescript-lang-file-icon/u);
	const glyph = await icon.textContent();
	const retained = await icon.elementHandle();
	await host.focus();
	await page.evaluate(() => window.changeIconModelLanguage('rust'));
	await expect(icon).toHaveClass(/rust-lang-file-icon/u);
	await expect(untitledIcon).toHaveClass(/rust-lang-file-icon/u);
	await expect(icon).not.toHaveText(glyph!);
	await expect(host).toBeFocused();
	expect(await retained!.evaluate(node => node === document.querySelector('#model-icon .ash-icon-label-icon'))).toBe(true);
	await page.getByRole('button', { name: 'None', exact: true }).click();
	await expect(icon).toBeHidden();
	await expect(untitledIcon).not.toHaveClass(/is-reserved/u);
	await page.getByRole('button', { name: 'Seti', exact: true }).click();
	await expect(icon).toBeVisible();
	await expect(icon).toHaveClass(/rust-lang-file-icon/u);
	await page.evaluate(() => window.releaseIconModels());
	await expect(icon).not.toHaveClass(/rust-lang-file-icon/u);
	await expect(untitledIcon).not.toHaveClass(/rust-lang-file-icon/u);
	await page.evaluate(() => window.disposeIconLabels());
	await expect(host.locator('.ash-icon-label')).toHaveCount(0);
	await page.getByRole('button', { name: 'None', exact: true }).click();
	expect(errors).toEqual([]);
});

test('system appearance and forced colors select preferred themes and release their queries on disposal', async ({ page }) => {
	await page.goto('/themes.html');
	await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
	await page.evaluate(async () => {
		await window.setThemeSetting('workbench.preferredDarkColorTheme', 'ash-high-contrast-dark');
		await window.setThemeSetting('window.autoDetectColorScheme', true);
	});
	await page.emulateMedia({ colorScheme: 'dark' });
	await expect(page.locator('#root')).toHaveAttribute('data-color-theme', 'ash-high-contrast-dark');
	await page.emulateMedia({ colorScheme: 'light' });
	await expect(page.locator('#root')).toHaveAttribute('data-color-theme', 'ash-light');
	await page.emulateMedia({ forcedColors: 'active' });
	await expect(page.locator('#root')).toHaveAttribute('data-color-theme', 'ash-high-contrast-light');
	await expect(page.locator('#root')).toHaveCSS('forced-color-adjust', 'none');
	await page.emulateMedia({ forcedColors: 'none' });
	await expect(page.locator('#root')).toHaveAttribute('data-color-theme', 'ash-light');
	await page.evaluate(() => window.disposeThemeRoot());
	await page.emulateMedia({ colorScheme: 'dark' });
	await expect(page.locator('#root')).not.toHaveAttribute('data-color-theme', /.+/);
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


test('resource labels keep the filename readable before truncating its directory', async ({ page }) => {
	await page.goto('/themes.html');
	await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
	const host = page.locator('#path-label');
	const name = host.locator('.ash-icon-label-text');
	const description = host.locator('.ash-icon-label-description');
	await expect(name).toHaveText('gitHistoryProvider.ts');
	await expect(description).toHaveText('src/ash/workbench/contrib/git/browser');
	const layout = async () => host.evaluate(element => {
		const container = element.querySelector('.ash-icon-label-container')!;
		const name = element.querySelector('.ash-icon-label-text')!;
		const description = element.querySelector('.ash-icon-label-description')!;
		const bounds = container.getBoundingClientRect();
		return {
			nameFits: name.clientWidth >= name.scrollWidth,
			directoryFits: description.clientWidth >= description.scrollWidth,
			nameContained: name.getBoundingClientRect().right <= bounds.right + 1,
			directoryVisible: description.clientWidth > 0,
		};
	});
	await expect.poll(layout).toEqual({ nameFits: true, directoryFits: false, nameContained: true, directoryVisible: true });
	await expect.poll(() => description.evaluate(element => getComputedStyle(element, '::before').content)).toBe('none');
	await host.evaluate(element => { element.style.width = '100px'; });
	await expect.poll(layout).toEqual({ nameFits: false, directoryFits: false, nameContained: true, directoryVisible: false });
	await expect(name).toHaveCSS('text-overflow', 'ellipsis');
	await host.evaluate(element => { element.style.width = '600px'; });
	await expect.poll(layout).toEqual({ nameFits: true, directoryFits: true, nameContained: true, directoryVisible: true });
	await page.evaluate(() => window.disposeIconLabels());
	await expect(host.locator('.ash-icon-label')).toHaveCount(0);
});


test('window theme styles reach popups outside the workbench without inline theme bindings', async ({ page }) => {
	await page.goto('/themes.html');
	await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
	await page.evaluate(() => {
		const popup = document.createElement('div');
		popup.id = 'detached-theme-probe';
		popup.className = 'ash-context-view-default';
		document.body.append(popup);
	});
	const popup = page.locator('#detached-theme-probe');
	for (const id of ['ash-dark', 'ash-light', 'ash-high-contrast-dark', 'ash-high-contrast-light']) {
		await page.evaluate(id => window.selectColorTheme(id), id);
		await expect(page.locator('html')).toHaveAttribute('data-color-theme', id);
		const colors = await page.locator('#root').evaluate(root => ({
			background: getComputedStyle(root).getPropertyValue('--ash-editor-background').trim(),
			body1: getComputedStyle(root).getPropertyValue('--ash-fontSize-body1').trim(),
		}));
		expect(await popup.evaluate(element => ({
			background: getComputedStyle(element).getPropertyValue('--ash-editor-background').trim(),
			body1: getComputedStyle(element).getPropertyValue('--ash-fontSize-body1').trim(),
			inline: element.style.length,
		}))).toEqual({ ...colors, inline: 0 });
		if (id.includes('high-contrast')) {
			await expect(popup).toHaveCSS('box-shadow', 'none');
			await expect(page.locator('html')).toHaveClass(/ash-high-contrast/);
		}
	}
	await page.evaluate(() => window.disposeThemeRoot());
	expect(await popup.evaluate(element => getComputedStyle(element).getPropertyValue('--ash-editor-background'))).toBe('');
});
