import { expect, test, type Page } from '@playwright/test';

const pageErrors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => {
	const errors: string[] = [];
	pageErrors.set(page, errors);
	page.on('pageerror', error => errors.push(error.message));
});
test.afterEach(({ page }) => { expect(pageErrors.get(page)).toEqual([]); });

test('external opener chooser supports keyboard selection, cancellation, browser choice and Chinese settings labels', async ({ page }) => {
	await page.goto('/link.html');
	await page.evaluate(() => window.ashLinkIntegration.installExternalOpeners(true));
	const link = page.getByRole('button', { name: 'Documentation', exact: true });
	await link.focus();
	await link.press('Enter');
	const chooser = page.getByRole('dialog', { name: '选择链接打开方式', exact: true });
	await expect(chooser).toBeVisible();
	const input = chooser.getByRole('combobox', { name: '选择链接打开方式', exact: true });
	await expect(input).toBeFocused();
	await input.press('ArrowDown');
	await input.press('Enter');
	await expect(chooser).toHaveCount(0);
	await expect(link).toBeFocused();
	expect(await page.evaluate(() => window.ashLinkIntegration.contributed)).toEqual(['Second viewer:https://example.test/docs']);

	await link.press('Enter');
	await expect(chooser).toBeVisible();
	await input.press('Escape');
	await expect(chooser).toHaveCount(0);
	await expect(link).toBeFocused();
	expect(await page.evaluate(() => window.ashLinkIntegration.opened)).toEqual([]);

	await link.press('Enter');
	await chooser.getByRole('option', { name: '在默认浏览器中打开', exact: true }).click();
	await expect.poll(() => page.evaluate(() => window.ashLinkIntegration.opened)).toEqual(['https://example.test/docs']);
	await link.focus();
	await link.press('Enter');
	await chooser.getByRole('option', { name: '配置默认打开方式...', exact: true }).click();
	await expect.poll(() => page.evaluate(() => window.ashLinkIntegration.settingsRevealed)).toEqual(['workbench.externalUriOpeners']);
	await expect(chooser).toHaveCount(0);
});

test('ordinary links route pointer and keyboard activation through the opener', async ({ page }) => {
	await page.goto('/link.html');
	const link = page.getByRole('button', { name: 'Documentation', exact: true });
	await page.locator('#before').focus();
	await page.keyboard.press('Tab');
	await expect(link).toBeFocused();
	await link.press('Enter');
	await link.press('Space');
	await link.click();
	await expect.poll(() => page.evaluate(() => window.ashLinkIntegration.opened)).toEqual(Array(3).fill('https://example.test/docs'));
	await page.getByRole('button', { name: 'Custom action', exact: true }).click();
	expect(await page.evaluate(() => window.ashLinkIntegration.customOpened)).toEqual(['https://example.test/custom']);
	await page.evaluate(() => window.ashLinkIntegration.blockOpening());
	await link.click();
	expect(await page.evaluate(() => window.ashLinkIntegration.opened)).toHaveLength(3);
	await expect(page).toHaveURL(/\/link.html$/u);
});

test('disabled links suppress navigation and restore the descriptor tab order', async ({ page }) => {
	await page.goto('/link.html');
	await page.evaluate(() => {
		window.ashLinkIntegration.update('Updated destination', 'Updated hover', 3, true);
		window.ashLinkIntegration.setEnabled(false);
	});
	const link = page.getByRole('button', { name: 'Updated destination', exact: true });
	await expect(link).toHaveAttribute('aria-disabled', 'true');
	await expect(link).toHaveAttribute('tabindex', '-1');
	// Programmatic activation must be blocked even though disabled controls are excluded from Tab.
	await link.evaluate(element => (element as HTMLElement).click());
	await link.press('Enter');
	await link.press('Space');
	expect(await page.evaluate(() => window.ashLinkIntegration.opened)).toEqual([]);
	await expect(page).toHaveURL(/\/link.html$/u);
	await page.evaluate(() => window.ashLinkIntegration.setEnabled(true));
	await expect(link).toHaveAttribute('aria-disabled', 'false');
	await expect(link).toHaveAttribute('tabindex', '3');
	await link.press('Enter');
	await expect.poll(() => page.evaluate(() => window.ashLinkIntegration.opened)).toEqual(['https://example.test/updated']);
});

test('managed link hover updates, clears and is released with its control', async ({ page }) => {
	await page.goto('/link.html');
	const link = page.locator('#default-link .ash-link');
	await link.hover();
	await expect(page.getByRole('tooltip')).toHaveText('Read documentation');
	await page.evaluate(() => window.ashLinkIntegration.update('Updated', 'Updated hover'));
	await expect(page.getByRole('tooltip')).toHaveText('Updated hover');
	await page.evaluate(() => window.ashLinkIntegration.update('Updated'));
	await expect(page.getByRole('tooltip')).toHaveCount(0);
	await page.evaluate(() => window.ashLinkIntegration.update('Updated', 'Final hover'));
	await page.mouse.move(0, 0);
	await link.hover();
	await expect(page.getByRole('tooltip')).toHaveText('Final hover');
	await page.evaluate(() => window.ashLinkIntegration.disposeLink());
	await expect(link).toHaveCount(0);
	await expect(page.getByRole('tooltip')).toHaveCount(0);
});

test('link colors and keyboard focus follow all four product themes', async ({ page }) => {
	await page.goto('/link.html');
	const link = page.locator('#default-link .ash-link');
	for (const index of [0, 1, 2, 3]) {
		await page.evaluate(index => window.ashLinkIntegration.setTheme(index), index);
		await page.mouse.move(0, 0);
		await page.locator('#before').focus();
		await page.keyboard.press('Tab');
		const state = await link.evaluate(element => {
			const style = getComputedStyle(element);
			const expected = document.createElement('span');
			element.after(expected);
			expected.style.color = 'var(--ash-accent-foreground)';
			const color = getComputedStyle(expected).color;
			expected.style.color = 'var(--ash-focusBorder)';
			const focus = getComputedStyle(expected).color;
			expected.remove();
			return { color: style.color, expected: color, focus: style.outlineColor, expectedFocus: focus, outline: style.outlineStyle, width: style.outlineWidth, focused: element.matches(':focus-visible'), underline: style.textDecorationLine };
		});
		expect(state).toEqual({ color: state.expected, expected: state.expected, focus: state.expectedFocus, expectedFocus: state.expectedFocus, outline: 'solid', width: '1px', focused: true, underline: 'underline' });
	}
	await page.mouse.move(0, 0);
	expect(await page.locator('#custom-link .ash-link').evaluate(element => getComputedStyle(element).color)).toBe('rgb(255, 128, 128)');
});

test('Output editor links open their reported position from the keyboard', async ({ page }) => {
	await page.goto('/link.html');
	const editor = page.locator('#output .stanza-editor-input');
	await expect(page.locator('#output .view-lines')).toContainText('src/main.ts:12:7');
	await editor.focus();
	await page.keyboard.press('ControlOrMeta+Home');
	await page.evaluate(() => window.ashLinkIntegration.runOpenLink());
	await expect.poll(() => page.evaluate(() => window.ashLinkIntegration.files)).toEqual([{ resource: 'file:///workspace/src/main.ts', line: 12, column: 7 }]);
	await page.evaluate(() => window.ashLinkIntegration.disposeOutput());
	await expect(page.locator('#output .ash-view-pane')).toHaveCount(0);
});

test('Output panel and resource editor share live text while filters only change panel visibility', async ({ page }) => {
	await page.goto('/link.html');
	await page.evaluate(() => window.ashLinkIntegration.openOutputEditor());
	await page.evaluate(() => window.ashLinkIntegration.appendOutput());
	await expect.poll(() => page.evaluate(() => window.ashLinkIntegration.getOutputState())).toEqual({
		panelText: 'src/main.ts:12:7: check this file\nsrc/other.ts(4,2): next file\n',
		editorText: 'src/main.ts:12:7: check this file\nsrc/other.ts(4,2): next file\n',
		sameModel: true, readonly: true,
	});
	await page.evaluate(() => window.ashLinkIntegration.filterOutput('other'));
	await expect(page.locator('#output .view-lines')).not.toContainText('check this file');
	await expect(page.locator('#output .view-lines')).toContainText('next file');
	await expect(page.locator('#live-output-editor .view-lines')).toContainText('check this file');
	const input = page.locator('#live-output-editor .stanza-editor-input');
	await input.focus();
	await page.keyboard.insertText('must not change');
	expect((await page.evaluate(() => window.ashLinkIntegration.getOutputState())).editorText).not.toContain('must not change');
	await page.evaluate(() => window.ashLinkIntegration.clearOutput());
	await expect.poll(() => page.evaluate(() => window.ashLinkIntegration.getOutputState())).toEqual({ panelText: '', editorText: '', sameModel: true, readonly: true });
	await page.evaluate(() => { window.ashLinkIntegration.disposeOutput(); window.ashLinkIntegration.appendOutput(); });
	await expect(page.locator('#live-output-editor .view-lines')).toContainText('next file');
});

test('Output follows new lines until scrolling pauses it and Find returns focus to its editor', async ({ page }) => {
	await page.goto('/link.html');
	await expect(page.locator('#output .view-lines')).toContainText('check this file');
	await page.evaluate(() => window.ashLinkIntegration.appendOutputLines(60));
	await expect.poll(() => page.evaluate(() => {
		const scroll = window.ashLinkIntegration.getOutputScroll();
		return scroll.end > 0 && scroll.top === scroll.end;
	})).toBe(true);
	await page.locator('#output .stanza-editor').hover();
	await page.mouse.wheel(0, -5000);
	await expect.poll(() => page.evaluate(() => window.ashLinkIntegration.getOutputScroll().top)).toBe(0);
	const follow = page.getByRole('button', { name: 'Auto Scroll', exact: true });
	await expect(follow).toHaveAttribute('aria-pressed', 'false');
	await page.evaluate(() => window.ashLinkIntegration.appendOutputLines(10));
	expect(await page.evaluate(() => window.ashLinkIntegration.getOutputScroll().top)).toBe(0);
	await follow.click();
	await expect.poll(() => page.evaluate(() => {
		const scroll = window.ashLinkIntegration.getOutputScroll();
		return scroll.top === scroll.end;
	})).toBe(true);
	const input = page.locator('#output .stanza-editor-input');
	await input.focus();
	await page.keyboard.press('ControlOrMeta+f');
	const find = page.locator('#output').getByRole('textbox', { name: 'Find', exact: true });
	await find.fill('live line 40');
	await find.press('Enter');
	await find.press('Escape');
	await expect(input).toBeFocused();
	await expect(page.locator('#output .view-lines')).toContainText('live line 40');
});

test('Output severity and filter focus use theme colors in all four themes', async ({ page }) => {
	await page.goto('/link.html');
	const warning = page.locator('#output .ash-output-warning').first();
	await expect(warning).toHaveText(/check this file/u);
	const filter = page.getByRole('searchbox', { name: 'Filter Output', exact: true });
	for (const index of [0, 1, 2, 3]) {
		await page.evaluate(index => window.ashLinkIntegration.setTheme(index), index);
		await filter.focus();
		const colors = await warning.evaluate(element => {
			const probe = document.createElement('span');
			element.after(probe);
			probe.style.color = 'var(--ash-warning-foreground)';
			const warningColor = getComputedStyle(probe).color;
			probe.style.color = 'var(--ash-focusBorder)';
			const focusColor = getComputedStyle(probe).color;
			probe.remove();
			const input = document.querySelector('#output .ash-output-filter-input')!;
			return { warning: getComputedStyle(element).color, warningColor, focus: getComputedStyle(input).borderColor, focusColor, width: getComputedStyle(input).borderWidth };
		});
		expect(colors.warning).toBe(colors.warningColor);
		expect(colors.focus).toBe(colors.focusColor);
		expect(colors.width).toBe('1px');
	}
});

test('touch activation opens an ordinary link once', async ({ browser }) => {
	const context = await browser.newContext({ hasTouch: true });
	try {
		const page = await context.newPage();
		await page.goto('http://127.0.0.1:5185/link.html');
		await page.getByRole('button', { name: 'Documentation', exact: true }).tap();
		await expect.poll(() => page.evaluate(() => window.ashLinkIntegration.opened)).toEqual(['https://example.test/docs']);
	} finally {
		await context.close();
	}
});


for (const cowork of [false, true]) {
	test(`trusted command links execute object arguments in ${cowork ? 'Sessions' : 'Workbench'} and stop after failure`, async ({ page }) => {
		await page.goto('/link.html');
		await page.evaluate(cowork => window.ashLinkIntegration.commandLink(true, false, cowork), cowork);
		await page.getByRole('link', { name: 'Run linked commands', exact: true }).click();
		await expect.poll(() => page.evaluate(() => window.ashLinkIntegration.commandCalls)).toEqual([{ text: '%20 中文' }, 'first finished', 'second']);
		await page.evaluate(cowork => window.ashLinkIntegration.commandLink(true, true, cowork), cowork);
		const link = page.getByRole('link', { name: 'Run linked commands', exact: true });
		await link.focus();
		await link.press('Enter');
		await expect(page.locator('#command-link').getByRole('alert')).toHaveText('Unknown command: test.link.missing');
		expect(await page.evaluate(() => window.ashLinkIntegration.commandCalls)).toEqual([{ text: '%20 中文' }, 'first finished', 'second', { text: '%20 中文' }, 'first finished']);
		expect(await page.evaluate(() => window.ashLinkIntegration.opened)).toEqual([]);
		await expect(page).toHaveURL(/\/link.html$/u);
	});
}

test('untrusted Markdown cannot execute a command batch', async ({ page }) => {
	await page.goto('/link.html');
	await page.evaluate(() => window.ashLinkIntegration.commandLink(false));
	await expect(page.getByRole('link', { name: 'Run linked commands', exact: true })).toHaveCount(0);
	await page.locator('#command-link').click();
	expect(await page.evaluate(() => window.ashLinkIntegration.commandCalls)).toEqual([]);
});
