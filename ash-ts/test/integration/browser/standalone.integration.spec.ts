import { expect, test, type Page } from '@playwright/test';

test('standalone token themes recolor text and retain matching colors when copied', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto('/standalone.html?symbolIconsOff');
	await page.evaluate(() => window.ashStandaloneIntegration.prepareTokenTheme('plain'));
	const alpha = page.locator('#caller .view-line .stanza-editor-token').filter({ hasText: 'alpha' });
	await expect(alpha).toHaveCSS('color', 'rgb(18, 52, 86)');
	await expect(alpha).toHaveCSS('font-style', 'italic');
	const first = await page.evaluate(() => window.ashStandaloneIntegration.readTokenTheme());
	expect(first.colors).toEqual(['#123456', '#654321']);
	expect(first.styles).toEqual([1, 0]);
	expect(first.html).toContain('#123456');
	expect(first.html).toContain('font-style: italic');
	await page.evaluate(() => window.ashStandaloneIntegration.setStickyTheme('token-theme-second'));
	await expect(alpha).toHaveCSS('color', 'rgb(35, 69, 103)');
	await expect(alpha).toHaveCSS('font-weight', '700');
	await expect(alpha).toHaveCSS('font-style', 'normal');
	const second = await page.evaluate(() => window.ashStandaloneIntegration.readTokenTheme());
	expect(second.colors).toEqual(['#234567', '#765432']);
	expect(second.styles).toEqual([2, 0]);
	expect(second.html).toContain('#234567');
	await page.evaluate(() => window.ashStandaloneIntegration.removeTokenProvider());
	await expect(page.locator('#caller .view-line .stanza-editor-token')).toHaveCount(0);
	await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	expect(errors).toEqual([]);
});

test('standalone encoded tokens use the supplied palette and font metadata', async ({ page }) => {
	await page.goto('/standalone.html?symbolIconsOff');
	await page.evaluate(() => window.ashStandaloneIntegration.prepareTokenTheme('encoded'));
	const alpha = page.locator('#caller .view-line .stanza-editor-token').filter({ hasText: 'alpha' });
	await expect(alpha).toHaveCSS('color', 'rgb(18, 52, 86)');
	await expect(alpha).toHaveCSS('font-weight', '700');
	const tokens = await page.evaluate(() => window.ashStandaloneIntegration.readTokenTheme());
	expect(tokens.colors).toEqual(['#123456', '#abcdef']);
	expect(tokens.styles).toEqual([2, 0]);
	expect(tokens.html).toContain('#abcdef');
	await page.evaluate(() => window.ashStandaloneIntegration.dispose());
});

test('standalone language activation registers a tokenizer once when the model changes language', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto('/standalone.html?symbolIconsOff');
	await page.evaluate(() => window.ashStandaloneIntegration.prepareTokenTheme('activation'));
	const alpha = page.locator('#caller .view-line .stanza-editor-token').filter({ hasText: 'alpha' });
	await expect(alpha).toHaveCSS('color', 'rgb(18, 52, 86)');
	expect(await page.evaluate(() => window.ashStandaloneIntegration.readTokenTheme().factoryCalls)).toBe(1);
	await page.evaluate(() => window.ashStandaloneIntegration.removeTokenProvider());
	await expect(page.locator('#caller .view-line .stanza-editor-token')).toHaveCount(0);
	await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	expect(errors).toEqual([]);
});

test('standalone Monarch updates following lines after editing a comment boundary', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto('/standalone.html?symbolIconsOff');
	await page.evaluate(() => window.ashStandaloneIntegration.prepareTokenTheme('monarch'));
	const alpha = page.locator('#caller .view-line .stanza-editor-token').filter({ hasText: 'alpha' });
	const beta = page.locator('#caller .view-line .stanza-editor-token').filter({ hasText: 'beta' });
	await expect(alpha).toHaveCSS('color', 'rgb(18, 52, 86)');
	await expect(beta).toHaveCSS('color', 'rgb(101, 67, 33)');
	await page.evaluate(() => window.ashStandaloneIntegration.removeMonarchCommentStart());
	await expect(beta).not.toHaveCSS('color', 'rgb(101, 67, 33)');
	await page.evaluate(() => window.ashStandaloneIntegration.setStickyTheme('token-theme-second'));
	await expect(alpha).toHaveCSS('color', 'rgb(35, 69, 103)');
	await page.evaluate(() => window.ashStandaloneIntegration.removeTokenProvider());
	await expect(page.locator('#caller .view-line .stanza-editor-token')).toHaveCount(0);
	await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	expect(errors).toEqual([]);
});

test('standalone Monarch activates embedded token providers and returns to the host language', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto('/standalone.html?symbolIconsOff');
	await page.evaluate(() => window.ashStandaloneIntegration.prepareTokenTheme('monarch-embedded'));
	const alpha = page.locator('#caller .view-line .stanza-editor-token').filter({ hasText: 'alpha' });
	const beta = page.locator('#caller .view-line .stanza-editor-token').filter({ hasText: 'beta' });
	await expect(alpha).toHaveCSS('color', 'rgb(18, 52, 86)');
	await expect(beta).toHaveCSS('color', 'rgb(101, 67, 33)');
	const tokens = await page.evaluate(() => window.ashStandaloneIntegration.readTokenTheme());
	expect(tokens.languages).toEqual(['monarch-host', 'monarch-child', 'monarch-child', 'monarch-host']);
	expect(tokens.factoryCalls).toBe(1);
	await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	expect(errors).toEqual([]);
});

test('standalone colorizer renders escaped themed HTML without creating an editor model', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto('/standalone.html?symbolIconsOff');
	await page.evaluate(() => window.ashStandaloneIntegration.prepareTokenTheme('monarch'));
	const models = await page.evaluate(() => window.ashStandaloneIntegration.colorizePreview());
	expect(models.modelsAfter).toBe(models.modelsBefore);
	const preview = page.locator('#colorized-preview');
	await expect(preview.locator('span').filter({ hasText: /^alpha$/ })).toHaveCSS('color', 'rgb(18, 52, 86)');
	await expect(preview.locator('span').filter({ hasText: '/* hello */' })).toHaveCSS('color', 'rgb(101, 67, 33)');
	await expect(preview.locator('img, script')).toHaveCount(0);
	await expect(preview.locator('br')).toHaveCount(1);
	expect(await preview.textContent()).toContain('alpha\u00a0\u00a0\u00a0<img');
	await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	await expect(preview).toHaveCount(0);
	expect(errors).toEqual([]);
});

for (const removed of [false, true]) {
	test(`standalone lazy token provider resolves once and respects removal=${removed}`, async ({ page }) => {
		await page.goto('/standalone.html?symbolIconsOff');
		await page.evaluate(() => window.ashStandaloneIntegration.prepareTokenTheme('lazy'));
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readTokenTheme().factoryCalls)).toBe(1);
		if (removed) {
			await page.evaluate(() => window.ashStandaloneIntegration.removeTokenProvider());
		}
		await page.evaluate(() => window.ashStandaloneIntegration.finishTokenProvider());
		const tokens = page.locator('#caller .view-line .stanza-editor-token');
		if (removed) {
			await expect(tokens).toHaveCount(0);
		} else {
			await expect(tokens.filter({ hasText: 'alpha' })).toHaveCSS('color', 'rgb(18, 52, 86)');
		}
		expect(await page.evaluate(() => window.ashStandaloneIntegration.readTokenTheme().factoryCalls)).toBe(1);
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	});
}

test('standalone command picker executes editor actions, restores focus and follows editor disposal', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto('/standalone.html');
	const input = page.locator('#caller .stanza-editor-input');
	await input.focus();
	await page.keyboard.press('F1');
	const picker = page.locator('#caller .ash-quick-pick');
	const query = picker.getByRole('combobox');
	await expect(query).toBeFocused();
	const bounds = await picker.boundingBox();
	const editorBounds = await page.locator('#caller').boundingBox();
	expect(bounds!.width).toBeLessThanOrEqual(editorBounds!.width);
	await page.keyboard.press('Escape');
	await expect(picker).toHaveCount(0);
	await expect(input).toBeFocused();
	const ownedInput = page.locator('#owned .stanza-editor-input');
	await ownedInput.focus();
	await page.keyboard.press('F1');
	await expect(page.locator('#owned .ash-quick-pick')).toBeVisible();
	await expect(page.locator('#caller .ash-quick-pick')).toHaveCount(0);
	await page.keyboard.press('Escape');
	await expect(ownedInput).toBeFocused();
	await input.focus();
	await page.keyboard.press('F1');
	await query.fill('editor.action.gotoLine');
	await expect(picker.locator('.ash-quick-pick-row-label')).toHaveCount(1);
	await page.keyboard.press('Enter');
	await expect(picker).toHaveCount(0);
	await expect(page.locator('#caller .stanza-editor-goto-line-input')).toBeFocused();
	await page.keyboard.press('Escape');
	await expect(input).toBeFocused();
	await page.keyboard.press('F1');
	await expect(query).toBeFocused();
	await query.fill('editor.action.gotoOffset');
	await expect(picker.locator('.ash-quick-pick-row-label')).toHaveCount(1);
	await page.keyboard.press('Enter');
	await expect(page.locator('#caller .stanza-editor-goto-line-input')).toHaveAttribute('aria-label', 'Character offset');
	await page.keyboard.press('Escape');
	await expect(input).toBeFocused();
	await page.keyboard.press('F1');
	await expect(query).toBeFocused();
	await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	await expect(page.locator('.ash-quick-input-host')).toHaveCount(0);
	expect(errors).toEqual([]);
});

for (const scheme of ['dark', 'light'] as const) {
	test(`standalone command picker toggles ${scheme} high contrast and restores the theme`, async ({ page }) => {
		await page.goto('/standalone.html');
		await page.evaluate(theme => window.ashStandaloneIntegration.setStickyTheme(theme), `ash-${scheme}`);
		await page.locator('#caller .stanza-editor-input').focus();
		for (const expected of [`ash-high-contrast-${scheme}`, `ash-${scheme}`]) {
			await page.keyboard.press('F1');
			const picker = page.locator('#caller .ash-quick-pick');
			await picker.getByRole('combobox').fill('editor.action.toggleHighContrast');
			await expect(picker.locator('.ash-quick-pick-row-label')).toHaveCount(1);
			await page.keyboard.press('Enter');
			await expect(page.locator('#caller')).toHaveAttribute('data-color-theme', expected);
			await expect(page.locator('#owned')).toHaveAttribute('data-color-theme', expected);
			await expect(page.locator('#caller .stanza-editor-input')).toBeFocused();
		}
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	});
}

test('an initially empty standalone editor attaches, edits and releases a shared model', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto('/standalone.html');
	const empty = await page.evaluate(() => window.ashStandaloneIntegration.createEmptyEditor());
	expect(empty).toEqual({ modelsAdded: 0, model: null, id: expect.any(String) });
	await expect(page.locator('#empty .stanza-editor-input')).toHaveCount(0);
	await page.evaluate(() => window.ashStandaloneIntegration.attachEmptyEditor());
	await expect(page.locator('#empty .stanza-editor-input')).toBeFocused();
	await page.keyboard.press('ControlOrMeta+End');
	await page.keyboard.type(' attached');
	await expect(page.locator('#caller .view-line')).toContainText(['caller attached']);
	expect(await page.evaluate(() => window.ashStandaloneIntegration.detachEmptyEditor())).toEqual({ value: 'caller attached', modelDisposed: false });
	await expect(page.locator('#empty .stanza-editor-input')).toHaveCount(0);
	await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	await expect(page.locator('#empty')).toHaveCount(0);
	expect(errors).toEqual([]);
});

async function stickyDefinitionPoint(page: Page): Promise<{ x: number; y: number; column: number }> {
	const text = page.locator('#caller .stanza-editor-sticky-scroll-text').last();
	await expect(text).toHaveText('  function inner() {');
	return text.evaluate(element => {
		const text = element.firstElementChild!.firstChild!;
		const offset = text.textContent!.indexOf('inner') + 2;
		const range = document.createRange();
		range.setStart(text, offset);
		range.setEnd(text, offset + 1);
		const bounds = range.getBoundingClientRect();
		return { x: bounds.left + bounds.width / 4, y: bounds.top + bounds.height / 2, column: offset + 1 };
	});
}

test.describe('contribution lifecycle', () => {
	test.afterEach(async ({ page }) => {
		await page.evaluate(() => window.ashStandaloneIntegration?.dispose());
	});

	for (const reason of ['escape', 'language', 'selection', 'blur', 'readonly', 'provider', 'dispose'] as const) {
		test(`completion ${reason} cancels a pending request and rejects its late result`, async ({ page }) => {
			await page.goto('/standalone.html');
			await page.evaluate(() => window.ashStandaloneIntegration.prepareContributionRequests('completion'));
			await page.keyboard.press('Control+Space');
			await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readContributionRequests().length)).toBe(1);
			if (reason === 'escape') {
				await page.keyboard.press('Escape');
			} else {
				await page.evaluate(reason => window.ashStandaloneIntegration.changeContributionState(reason), reason);
			}
			expect(await page.evaluate(() => window.ashStandaloneIntegration.readContributionRequests())).toEqual([{ languageId: 'typescript', aborted: true }]);
			await page.evaluate(() => window.ashStandaloneIntegration.finishContributionRequest(0));
			await expect(page.locator('#caller .stanza-editor-completion:not([hidden])')).toHaveCount(0);
			await expect(page.locator('#caller .stanza-editor-input[aria-activedescendant]')).toHaveCount(0);
		});
	}

	test('completion provider removal hides resolved suggestions and prevents acceptance', async ({ page }) => {
		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.prepareContributionRequests('completion'));
		await page.keyboard.press('Control+Space');
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readContributionRequests().length)).toBe(1);
		await page.evaluate(() => window.ashStandaloneIntegration.finishContributionRequest(0));
		await expect(page.locator('#caller .stanza-editor-completion')).toBeVisible();
		await page.evaluate(() => window.ashStandaloneIntegration.changeContributionState('provider'));
		await expect(page.locator('#caller .stanza-editor-completion')).toBeHidden();
		await page.keyboard.press('Enter');
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing())).value).not.toContain('result');
	});

	for (const scrolled of [false, true]) {
		test(`completion and public coordinates include the gutter with scroll=${scrolled}`, async ({ page }) => {
			await page.goto('/standalone.html');
			await page.evaluate(() => window.ashStandaloneIntegration.prepareContributionRequests('completion'));
			await page.evaluate(scrolled => window.ashStandaloneIntegration.prepareCompletionGeometry(scrolled), scrolled);
			await page.keyboard.press('Control+Space');
			await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readContributionRequests().length)).toBe(1);
			await page.evaluate(() => window.ashStandaloneIntegration.finishContributionRequest(0));
			await expect(page.locator('#caller .stanza-editor-completion')).toBeVisible();
			const geometry = await page.evaluate(() => window.ashStandaloneIntegration.readCompletionGeometry());
			expect(geometry.contentLeft).toBeGreaterThan(0);
			expect(Math.abs(geometry.api.left - geometry.caret.left)).toBeLessThan(2);
			expect(Math.abs(geometry.widget.left - geometry.caret.left)).toBeLessThan(2);
			expect(Math.abs(geometry.widget.top - geometry.api.top - geometry.api.height)).toBeLessThan(2);
			expect(geometry.textLeft).toBeGreaterThan(0);
		});
	}

	for (const kind of ['colors', 'highlights'] as const) {
		for (const initiallyOff of [false, true]) {
			test(`${kind} responds to option toggles from initiallyOff=${initiallyOff} and rejects disabled requests`, async ({ page }) => {
				await page.goto(initiallyOff ? '/standalone.html?contributionsOff' : '/standalone.html');
				await page.evaluate(kind => window.ashStandaloneIntegration.prepareContributionRequests(kind), kind);
				if (initiallyOff) {
					expect(await page.evaluate(() => window.ashStandaloneIntegration.readContributionRequests())).toEqual([]);
					await page.evaluate(kind => window.ashStandaloneIntegration.updateContributionOptions(kind === 'colors' ? { colorDecorators: true } : { occurrencesHighlight: 'singleFile' }), kind);
				}
				if (kind === 'highlights' && !initiallyOff) await page.keyboard.press('ArrowRight');
				await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readContributionRequests().length)).toBe(1);
				await page.evaluate(() => window.ashStandaloneIntegration.finishContributionRequest(0));
				await expect.poll(() => page.evaluate(kind => window.ashStandaloneIntegration.readContributionDecorations()[kind], kind)).toBe(2);
				await page.evaluate(kind => window.ashStandaloneIntegration.updateContributionOptions(kind === 'colors' ? { colorDecorators: false } : { occurrencesHighlight: 'off' }), kind);
				expect(await page.evaluate(kind => window.ashStandaloneIntegration.readContributionDecorations()[kind], kind)).toBe(0);
				await page.keyboard.press('ArrowRight');
				await page.evaluate(kind => window.ashStandaloneIntegration.updateContributionOptions(kind === 'colors' ? { colorDecorators: true, colorDecoratorsLimit: 1 } : { occurrencesHighlight: 'singleFile' }), kind);
				await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readContributionRequests().length)).toBe(2);
				await page.evaluate(kind => window.ashStandaloneIntegration.updateContributionOptions(kind === 'colors' ? { colorDecorators: false } : { occurrencesHighlight: 'off' }), kind);
				expect((await page.evaluate(() => window.ashStandaloneIntegration.readContributionRequests()))[1]!.aborted).toBe(true);
				await page.evaluate(() => window.ashStandaloneIntegration.finishContributionRequest(1));
				expect(await page.evaluate(kind => window.ashStandaloneIntegration.readContributionDecorations()[kind], kind)).toBe(0);
				await page.evaluate(kind => window.ashStandaloneIntegration.updateContributionOptions(kind === 'colors' ? { colorDecorators: true } : { occurrencesHighlight: 'singleFile' }), kind);
				await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readContributionRequests().length)).toBe(3);
				await page.evaluate(() => window.ashStandaloneIntegration.finishContributionRequest(2));
				await expect.poll(() => page.evaluate(kind => window.ashStandaloneIntegration.readContributionDecorations()[kind], kind)).toBe(kind === 'colors' ? 1 : 2);
			});
		}
	}

	for (const initiallyOff of [false, true]) {
		test(`folding toggles from initiallyOff=${initiallyOff}, restores hidden text and cancels providers`, async ({ page }) => {
			await page.goto(initiallyOff ? '/standalone.html?contributionsOff' : '/standalone.html');
			await page.evaluate(() => window.ashStandaloneIntegration.prepareContributionRequests('folding'));
			if (initiallyOff) {
				expect(await page.evaluate(() => window.ashStandaloneIntegration.readContributionRequests())).toEqual([]);
				await page.evaluate(() => window.ashStandaloneIntegration.updateContributionOptions({ folding: true }));
			}
			await page.evaluate(() => window.ashStandaloneIntegration.updateContributionOptions({ showFoldingControls: 'always' }));
			await expect(page.locator('#caller .ash-icon-folding-expanded').first()).toBeVisible();
			await page.locator('#caller .ash-icon-folding-expanded').first().click();
			await expect(page.locator('#caller .view-line[data-logical-line-index="1"]')).toHaveCount(0);
			await page.evaluate(() => window.ashStandaloneIntegration.updateContributionOptions({ folding: false }));
			expect((await page.evaluate(() => window.ashStandaloneIntegration.readContributionRequests())).every(request => request.aborted)).toBe(true);
			await page.evaluate(async () => {
				const requests = window.ashStandaloneIntegration.readContributionRequests();
				for (let index = 0; index < requests.length; index++) await window.ashStandaloneIntegration.finishContributionRequest(index);
			});
			await expect(page.locator('#caller .view-line[data-logical-line-index="1"]')).toHaveCount(1);
			expect((await page.evaluate(() => window.ashStandaloneIntegration.readContributionDecorations())).folding).toBe(0);
			await page.evaluate(() => window.ashStandaloneIntegration.updateContributionOptions({ folding: true }));
			await expect(page.locator('#caller .ash-icon-folding-expanded').first()).toBeVisible();
			await page.locator('#caller .ash-icon-folding-expanded').first().click();
			await expect(page.locator('#caller .view-line[data-logical-line-index="1"]')).toHaveCount(0);
		});
	}

	for (const initiallyOff of [false, true]) {
		test(`sticky headers toggle from initiallyOff=${initiallyOff} and keep focused nodes through layout`, async ({ page }) => {
			await page.goto(initiallyOff ? '/standalone.html?contributionsOff' : '/standalone.html');
			await page.evaluate(() => {
				window.ashStandaloneIntegration.updateContributionOptions({ folding: true });
				window.ashStandaloneIntegration.prepareStickyHeaders();
			});
			const buttons = page.locator('#caller .stanza-editor-sticky-scroll-item');
			if (initiallyOff) {
				await expect(buttons).toHaveCount(0);
				await page.evaluate(() => window.ashStandaloneIntegration.updateContributionOptions({ stickyScroll: { enabled: true } }));
			}
			await expect(buttons).toHaveCount(2);
			await expect(buttons.last()).toBeInViewport();
			const button = await buttons.first().elementHandle();
			await buttons.first().focus();
			await page.evaluate(() => window.ashStandaloneIntegration.layoutContribution(590));
			expect(await button!.evaluate(element => ({ connected: element.isConnected, focused: document.activeElement === element }))).toEqual({ connected: true, focused: true });
			await page.evaluate(() => window.ashStandaloneIntegration.updateContributionOptions({ stickyScroll: { maxLineCount: 1 } }));
			await expect(buttons).toHaveCount(1);
			await expect(buttons.first()).toHaveText('function outer() {');
			expect(await button!.evaluate(element => document.activeElement === element)).toBe(true);
			await page.evaluate(() => window.ashStandaloneIntegration.updateContributionOptions({ stickyScroll: { enabled: false } }));
			await expect(buttons).toHaveCount(0);
			expect((await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing())).focused).toBe(true);
			await page.evaluate(() => window.ashStandaloneIntegration.updateContributionOptions({ stickyScroll: { enabled: true, maxLineCount: 5 } }));
			await expect(buttons).toHaveCount(2);
		});
	}

	test('sticky scroll commands navigate headers, reveal the selection and return focus', async ({ page }) => {
		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.prepareStickyHeaders());
		const buttons = page.locator('#caller .stanza-editor-sticky-scroll-item');
		await expect(buttons).toHaveCount(2);
		await page.evaluate(() => window.ashStandaloneIntegration.runStickyCommand('editor.action.focusStickyScroll'));
		await expect(buttons.last()).toBeFocused();
		await page.keyboard.press('ArrowUp');
		await expect(buttons.first()).toBeFocused();
		await page.keyboard.press('ArrowDown');
		await expect(buttons.last()).toBeFocused();
		await page.keyboard.press('Escape');
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing())).focused).toBe(true);
		await page.evaluate(() => window.ashStandaloneIntegration.runStickyCommand('editor.action.focusStickyScroll'));
		await page.keyboard.press('Enter');
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readStickyState())).line).toBe(2);
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing())).focused).toBe(true);
		await page.evaluate(() => window.ashStandaloneIntegration.scrollSticky(200));
		await expect(buttons).toHaveCount(2);
		await buttons.first().click();
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readStickyState())).line).toBe(1);
		await page.evaluate(() => window.ashStandaloneIntegration.scrollSticky(200));
		await page.evaluate(() => window.ashStandaloneIntegration.runStickyCommand('editor.action.focusStickyScroll'));
		await page.evaluate(() => window.ashStandaloneIntegration.runStickyCommand('editor.action.toggleStickyScroll'));
		await expect(buttons).toHaveCount(0);
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing())).focused).toBe(true);
	});

	test('sticky scroll uses declaration lines, live line height and horizontal scroll options', async ({ page }) => {
		await page.goto('/standalone.html?symbolIconsOff');
		await page.evaluate(() => window.ashStandaloneIntegration.prepareStickySymbols());
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readLanguageRequests().length)).toBe(1);
		await page.evaluate(() => window.ashStandaloneIntegration.finishLanguageRequest(0));
		const buttons = page.locator('#caller .stanza-editor-sticky-scroll-item');
		await expect(buttons).toHaveText(['class Outer {', '  method() {']);
		await page.evaluate(() => window.ashStandaloneIntegration.updateContributionOptions({ lineHeight: 28 }));
		await expect.poll(() => buttons.first().evaluate(element => element.getBoundingClientRect().height)).toBe(28);
		await page.evaluate(() => window.ashStandaloneIntegration.scrollSticky(200, 80));
		await expect(buttons.first().locator('.stanza-editor-sticky-scroll-text')).toHaveCSS('text-indent', '-80px');
		await page.evaluate(() => window.ashStandaloneIntegration.updateContributionOptions({ stickyScroll: { scrollWithEditor: false } }));
		await expect(buttons.first().locator('.stanza-editor-sticky-scroll-text')).toHaveCSS('text-indent', '0px');
		for (const theme of ['ash-high-contrast-dark', 'ash-high-contrast-light']) {
			await page.evaluate(theme => window.ashStandaloneIntegration.setStickyTheme(theme), theme);
			await page.evaluate(() => window.ashStandaloneIntegration.runStickyCommand('editor.action.focusStickyScroll'));
			await expect(buttons.last()).toBeFocused();
			const focus = await buttons.last().evaluate(element => {
				const style = getComputedStyle(element);
				return { width: style.outlineWidth, color: style.outlineColor, token: style.getPropertyValue('--ash-focus-border').trim() };
			});
			expect(focus.width).toBe('1px');
			expect(focus.token).not.toBe('');
		}
	});

	for (const reason of ['text', 'language', 'provider', 'model', 'dispose'] as const) {
		test(`sticky scroll cancels stale outline requests on ${reason}`, async ({ page }) => {
			await page.goto('/standalone.html?symbolIconsOff');
			await page.evaluate(() => window.ashStandaloneIntegration.prepareStickySymbols());
			await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readLanguageRequests().length)).toBe(1);
			await page.evaluate(reason => window.ashStandaloneIntegration.changeLanguageRequest(reason), reason);
			expect((await page.evaluate(() => window.ashStandaloneIntegration.readLanguageRequests()))[0]!.aborted).toBe(true);
			await page.evaluate(() => window.ashStandaloneIntegration.finishLanguageRequest(0));
			await expect(page.locator('#caller .stanza-editor-sticky-scroll-item')).not.toHaveText(['class Outer {', '  method() {']);
		});
	}

	test('sticky scroll selects the widest outline and preserves its source until removal', async ({ page }) => {
		await page.goto('/standalone.html?symbolIconsOff');
		await page.evaluate(() => window.ashStandaloneIntegration.changeStickySources('initial'));
		const headers = page.locator('#caller .stanza-editor-sticky-scroll-text');
		await expect(headers).toHaveText(['  function inner() {', '    item 0']);
		await page.evaluate(() => window.ashStandaloneIntegration.changeStickySources('larger'));
		await expect(headers).toHaveText(['  function inner() {', '    item 0']);
		await page.evaluate(() => window.ashStandaloneIntegration.changeStickySources('remove'));
		await expect(headers).toHaveText(['function outer() {', '  function inner() {']);
	});

	test('sticky scroll uses indentation when every outline is empty and folding is disabled', async ({ page }) => {
		await page.goto('/standalone.html?symbolIconsOff');
		await page.evaluate(() => window.ashStandaloneIntegration.changeStickySources('initial'));
		await page.evaluate(() => {
			window.ashStandaloneIntegration.updateContributionOptions({ folding: false });
			return window.ashStandaloneIntegration.changeStickySources('empty');
		});
		await expect(page.locator('#caller .stanza-editor-sticky-scroll-text')).toHaveText(['function outer() {', '  function inner() {']);
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readStickyState())).hidden).toEqual([]);
	});

	test('sticky scroll clips a leaving scope and excludes headers inside hidden lines', async ({ page }) => {
		await page.goto('/standalone.html');
		await page.evaluate(() => {
			window.ashStandaloneIntegration.updateContributionOptions({ lineHeight: 20 });
			window.ashStandaloneIntegration.prepareStickyHeaders();
		});
		const buttons = page.locator('#caller .stanza-editor-sticky-scroll-item');
		await expect(buttons).toHaveCount(2);
		const state = await page.evaluate(() => window.ashStandaloneIntegration.readStickyState());
		await page.evaluate(end => window.ashStandaloneIntegration.scrollSticky(end * 20 - 30), state.ends[1]!);
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readStickyState().offset)).toBe(-10);
		await expect(page.locator('#caller .stanza-editor-sticky-scroll-row').last()).toHaveCSS('clip-path', 'inset(10px 0px 0px)');
		await page.evaluate(end => window.ashStandaloneIntegration.scrollSticky(end * 20 - 20), state.ends[1]!);
		await expect(buttons).toHaveCount(1);
		await page.evaluate(() => {
			window.ashStandaloneIntegration.scrollSticky(200);
			window.ashStandaloneIntegration.hideStickyLines(2, 4);
		});
		await expect(buttons).toHaveText(['function outer() {']);
	});

	test('sticky scroll follows live syntax and semantic tokens without changing header identity', async ({ page }) => {
		await page.goto('/standalone.html');
		await page.evaluate(() => {
			window.ashStandaloneIntegration.prepareStickyHeaders();
			window.ashStandaloneIntegration.setStickySyntax('#123456');
		});
		const header = page.locator('#caller .stanza-editor-sticky-scroll-item').first();
		const token = header.locator('.stanza-editor-token').first();
		await expect(token).toHaveCSS('color', 'rgb(18, 52, 86)');
		await expect(token).toHaveCSS('font-weight', '700');
		const bodyToken = page.locator('#caller .view-line .stanza-editor-token').first();
		await expect(bodyToken).toHaveCSS('color', 'rgb(18, 52, 86)');
		await header.focus();
		const retained = await header.elementHandle();
		await page.evaluate(() => window.ashStandaloneIntegration.setStickySyntax('#654321'));
		await expect(token).toHaveCSS('color', 'rgb(101, 67, 33)');
		expect(await retained!.evaluate(element => element.isConnected && document.activeElement === element)).toBe(true);
		await page.evaluate(() => {
			window.ashStandaloneIntegration.setStickySyntax(null);
			window.ashStandaloneIntegration.setSemanticProvider('variable');
		});
		await expect(token).toHaveClass(/token-variable/);
		await page.evaluate(() => window.ashStandaloneIntegration.setSemanticProvider('function'));
		await expect(token).toHaveClass(/token-function/);
	});

	test('sticky scroll reduces its line limit with editor height and restores focus when no header fits', async ({ page }) => {
		await page.goto('/standalone.html');
		await page.evaluate(() => {
			window.ashStandaloneIntegration.updateContributionOptions({ lineHeight: 20 });
			window.ashStandaloneIntegration.prepareStickyHeaders();
		});
		const headers = page.locator('#caller .stanza-editor-sticky-scroll-item');
		await expect(headers).toHaveCount(2);
		await page.evaluate(() => window.ashStandaloneIntegration.layoutContribution(590, 40));
		await expect(headers).toHaveCount(1);
		await headers.first().focus();
		await page.evaluate(() => window.ashStandaloneIntegration.layoutContribution(590, 20));
		await expect(headers).toHaveCount(0);
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing())).focused).toBe(true);
		await page.evaluate(() => window.ashStandaloneIntegration.layoutContribution(590, 180));
		await expect(headers).toHaveCount(2);
	});

	test('sticky scroll keeps line numbers fixed and updates numbering with the cursor and options', async ({ page }) => {
		await page.goto('/standalone.html?symbolIconsOff');
		await page.evaluate(() => window.ashStandaloneIntegration.prepareStickySymbols());
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readLanguageRequests().length)).toBe(1);
		await page.evaluate(() => window.ashStandaloneIntegration.finishLanguageRequest(0));
		const numbers = page.locator('#caller .stanza-editor-sticky-scroll-number');
		await expect(numbers).toHaveText(['2', '4']);
		const left = await numbers.first().evaluate(element => element.getBoundingClientRect().left);
		await page.evaluate(() => window.ashStandaloneIntegration.scrollSticky(200, 80));
		expect(await numbers.first().evaluate(element => element.getBoundingClientRect().left)).toBe(left);
		await page.evaluate(() => {
			window.ashStandaloneIntegration.updateContributionOptions({ lineNumbers: 'relative' });
			window.ashStandaloneIntegration.moveGutterCaret(20, 1);
		});
		await expect(numbers).toHaveText(['18', '16']);
		await page.evaluate(() => window.ashStandaloneIntegration.updateContributionOptions({ lineNumbers: 'off' }));
		await expect(numbers).toHaveText(['', '']);
		await page.evaluate(() => window.ashStandaloneIntegration.updateContributionOptions({ lineNumbers: line => `L${line}` }));
		await expect(numbers).toHaveText(['L2', 'L4']);
	});

	test('sticky scroll folding controls update the shared hidden ranges by mouse and keyboard', async ({ page }) => {
		await page.goto('/standalone.html');
		await page.evaluate(() => {
			window.ashStandaloneIntegration.prepareStickyHeaders();
			window.ashStandaloneIntegration.updateContributionOptions({ showFoldingControls: 'always' });
		});
		const folds = page.locator('#caller .stanza-editor-sticky-scroll-folding');
		await expect(folds).toHaveCount(2);
		await folds.last().click();
		await expect(folds.last()).toHaveAttribute('aria-expanded', 'false');
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readStickyState().hidden)).toEqual([[3, 83]]);
		await folds.last().focus();
		await page.keyboard.press('Enter');
		await expect(folds.last()).toHaveAttribute('aria-expanded', 'true');
		await expect(folds.last()).toBeFocused();
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readStickyState().hidden)).toEqual([]);
		await page.keyboard.press('Space');
		await expect(folds.last()).toHaveAttribute('aria-expanded', 'false');
		await page.evaluate(() => window.ashStandaloneIntegration.updateContributionOptions({ showFoldingControls: 'never' }));
		await expect(folds.last()).toBeHidden();
		await expect(page.locator('#caller .stanza-editor-sticky-scroll-item').last()).toBeFocused();
	});

	test('sticky scroll Shift hover previews the ending line and restores the same focused header', async ({ page }) => {
		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.prepareStickyHeaders());
		const header = page.locator('#caller .stanza-editor-sticky-scroll-item').last();
		await expect(header).toHaveText('  function inner() {');
		await header.focus();
		const retained = await header.elementHandle();
		const end = await page.evaluate(() => window.ashStandaloneIntegration.readStickyState().ends[1]!);
		await header.hover();
		await page.keyboard.down('Shift');
		await expect(header).toHaveAttribute('data-line-number', String(end));
		await expect(page.locator('#caller .stanza-editor-sticky-scroll-number').last()).toHaveText(String(end));
		await expect(page.locator('#caller .stanza-editor-sticky-scroll-folding').last()).toBeHidden();
		await page.keyboard.up('Shift');
		await expect(header).toHaveText('  function inner() {');
		expect(await retained!.evaluate(element => element.isConnected && document.activeElement === element)).toBe(true);
		await header.click({ modifiers: ['Shift'] });
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readStickyState())).line).toBe(end);
	});

	for (const modifier of ['ControlOrMeta', 'Alt'] as const) {
		test(`sticky scroll ${modifier} click sends the clicked column to definition navigation`, async ({ page }) => {
			await page.goto('/standalone.html');
			await page.evaluate(modifier => {
				window.ashStandaloneIntegration.prepareLanguageRequest('definition');
				window.ashStandaloneIntegration.prepareStickyHeaders();
				if (modifier === 'Alt') window.ashStandaloneIntegration.updateContributionOptions({ multiCursorModifier: 'ctrlCmd' });
			}, modifier);
			const point = await stickyDefinitionPoint(page);
			await page.keyboard.down(modifier);
			await page.mouse.click(point.x, point.y);
			await page.keyboard.up(modifier);
			await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readDefinitionPosition())).toEqual({ lineNumber: 2, column: point.column });
			await page.evaluate(() => {
				const index = window.ashStandaloneIntegration.readLanguageRequests().findIndex(request => !request.aborted);
				return window.ashStandaloneIntegration.finishLanguageRequest(index);
			});
			await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.getCallerPosition())).toEqual({ lineNumber: 1, column: 13 });
			expect((await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing())).focused).toBe(true);
		});

		test(`sticky scroll ${modifier} hover underlines definitions without moving the selection`, async ({ page }) => {
			await page.goto('/standalone.html');
			await page.evaluate(modifier => {
				window.ashStandaloneIntegration.prepareLanguageRequest('definition');
				window.ashStandaloneIntegration.prepareStickyHeaders();
				window.ashStandaloneIntegration.setStickyTheme(modifier === 'Alt' ? 'ash-high-contrast-light' : 'ash-high-contrast-dark');
				if (modifier === 'Alt') window.ashStandaloneIntegration.updateContributionOptions({ multiCursorModifier: 'ctrlCmd' });
			}, modifier);
			const point = await stickyDefinitionPoint(page);
			const selection = await page.evaluate(() => window.ashStandaloneIntegration.getCallerPosition());
			await page.mouse.move(point.x, point.y);
			expect(await page.evaluate(() => window.ashStandaloneIntegration.readLanguageRequests())).toEqual([]);
			await page.keyboard.down(modifier);
			await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readLanguageRequests().length)).toBe(1);
			await page.evaluate(() => window.ashStandaloneIntegration.finishLanguageRequest(0));
			const token = page.locator('#caller .stanza-editor-sticky-scroll-text > span').last();
			await expect(token).toHaveCSS('text-decoration-line', 'underline');
			expect(await page.evaluate(() => window.ashStandaloneIntegration.getCallerPosition())).toEqual(selection);
			await page.mouse.move(point.x + 1, point.y);
			expect((await page.evaluate(() => window.ashStandaloneIntegration.readLanguageRequests())).length).toBe(1);
			await page.keyboard.up(modifier);
			await expect(token).toHaveCSS('text-decoration-line', 'none');
		});
	}

	for (const reason of ['pointer', 'modifier', 'text', 'language', 'provider', 'model', 'dispose', 'layout', 'option'] as const) {
		test(`sticky scroll definition hover cancels on ${reason} and rejects its late result`, async ({ page }) => {
			await page.goto('/standalone.html');
			await page.evaluate(() => {
				window.ashStandaloneIntegration.prepareLanguageRequest('definition');
				window.ashStandaloneIntegration.prepareStickyHeaders();
			});
			const point = await stickyDefinitionPoint(page);
			await page.mouse.move(point.x, point.y);
			await page.keyboard.down('ControlOrMeta');
			await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readLanguageRequests().length)).toBe(1);
			if (reason === 'pointer') {
				await page.mouse.move(0, 0);
			} else if (reason === 'modifier') {
				await page.keyboard.up('ControlOrMeta');
			} else if (reason === 'layout') {
				await page.evaluate(() => window.ashStandaloneIntegration.layoutContribution(590));
			} else if (reason === 'option') {
				await page.evaluate(() => window.ashStandaloneIntegration.updateContributionOptions({ multiCursorModifier: 'ctrlCmd' }));
			} else {
				await page.evaluate(reason => window.ashStandaloneIntegration.changeLanguageRequest(reason), reason);
			}
			expect((await page.evaluate(() => window.ashStandaloneIntegration.readLanguageRequests()))[0]!.aborted).toBe(true);
			await page.evaluate(() => window.ashStandaloneIntegration.finishLanguageRequest(0));
			await expect(page.locator('#caller .stanza-editor-sticky-scroll.definition-link')).toHaveCount(0);
		});
	}

	test('sticky scroll definition hover leaves text unchanged when no definition exists', async ({ page }) => {
		await page.goto('/standalone.html');
		await page.evaluate(() => {
			window.ashStandaloneIntegration.prepareLanguageRequest('definition', true);
			window.ashStandaloneIntegration.prepareStickyHeaders();
		});
		const point = await stickyDefinitionPoint(page);
		await page.keyboard.down('ControlOrMeta');
		await page.mouse.move(point.x, point.y);
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readLanguageRequests().length)).toBe(1);
		await page.evaluate(() => window.ashStandaloneIntegration.finishLanguageRequest(0));
		await expect(page.locator('#caller .stanza-editor-sticky-scroll.definition-link')).toHaveCount(0);
		await expect(page.locator('#caller .stanza-editor-sticky-scroll-text').last()).toHaveText('  function inner() {');
	});

	test('sticky scroll definition navigation cancels when its source editor changes model', async ({ page }) => {
		await page.goto('/standalone.html');
		await page.evaluate(() => {
			window.ashStandaloneIntegration.prepareLanguageRequest('definition');
			window.ashStandaloneIntegration.prepareStickyHeaders();
		});
		const text = page.locator('#caller .stanza-editor-sticky-scroll-text').last();
		await expect(text).toHaveText('  function inner() {');
		await text.locator('span').first().click({ modifiers: ['ControlOrMeta'] });
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readLanguageRequests().filter(request => !request.aborted).length)).toBe(1);
		await page.evaluate(() => window.ashStandaloneIntegration.changeLanguageRequest('model'));
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readLanguageRequests())).every(request => request.aborted)).toBe(true);
		const position = await page.evaluate(() => window.ashStandaloneIntegration.getCallerPosition());
		await page.evaluate(async () => {
			for (const [index] of window.ashStandaloneIntegration.readLanguageRequests().entries()) {
				await window.ashStandaloneIntegration.finishLanguageRequest(index);
			}
		});
		expect(await page.evaluate(() => window.ashStandaloneIntegration.getCallerPosition())).toEqual(position);
	});

	test('sticky scroll context menu restores focus, keeps the source editor and supports keyboard invocation', async ({ page }) => {
		await page.goto('/standalone.html');
		await page.evaluate(() => {
			window.ashStandaloneIntegration.prepareStickyHeaders();
			window.ashStandaloneIntegration.changeContributionState('blur');
		});
		const header = page.locator('#caller .stanza-editor-sticky-scroll-item').last();
		await expect(header).toBeVisible();
		const position = await page.evaluate(() => window.ashStandaloneIntegration.getCallerPosition());
		await header.click({ button: 'right' });
		const toggle = page.getByRole('menuitemcheckbox', { name: 'Toggle Editor Sticky Scroll' });
		await expect(toggle).toBeVisible();
		await expect(toggle).toHaveAttribute('aria-checked', 'true');
		expect(await page.evaluate(() => window.ashStandaloneIntegration.getCallerPosition())).toEqual(position);
		await page.keyboard.press('Escape');
		await expect(header).toBeFocused();
		await page.keyboard.press('Shift+F10');
		await expect(toggle).toBeFocused();
		await page.keyboard.press('Enter');
		await expect(page.locator('#caller .stanza-editor-sticky-scroll-item')).toHaveCount(0);
		expect(await page.evaluate(() => window.ashStandaloneIntegration.readStickyMenu())).toEqual({ callerEnabled: false, ownedEnabled: true, inChordMode: false, errors: [] });
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing())).focused).toBe(true);
	});

	test('sticky scroll menu uses the active theme, reports action errors and dispatches registered chords', async ({ page }) => {
		await page.goto('/standalone.html');
		await page.evaluate(() => {
			window.ashStandaloneIntegration.prepareStickyHeaders();
			window.ashStandaloneIntegration.prepareStickyMenu();
		});
		const header = page.locator('#caller .stanza-editor-sticky-scroll-item').last();
		for (const theme of ['ash-high-contrast-dark', 'ash-high-contrast-light']) {
			await page.evaluate(theme => window.ashStandaloneIntegration.setStickyTheme(theme), theme);
			await header.click({ button: 'right' });
			const menu = page.getByRole('menu');
			await expect(menu).toBeVisible();
			const colors = await menu.evaluate(element => {
				const style = getComputedStyle(element.parentElement!);
				return { background: style.backgroundColor, token: style.getPropertyValue('--ash-editor-background').trim(), position: style.position };
			});
			expect(colors.token).not.toBe('');
			expect(colors.background).not.toBe('rgba(0, 0, 0, 0)');
			expect(colors.position).toBe('fixed');
			await page.keyboard.press('Escape');
		}
		await header.click({ button: 'right' });
		await page.getByRole('menuitem', { name: 'Fail sticky command' }).click();
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readStickyMenu().errors)).toEqual(['Sticky command failed']);
		await page.evaluate(() => window.ashStandaloneIntegration.runStickyCommand('editor.action.selectEditor'));
		await page.keyboard.press('F9');
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readStickyMenu())).inChordMode).toBe(true);
		await page.keyboard.press('Escape');
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readStickyMenu())).inChordMode).toBe(false);
		await page.keyboard.press('F9');
		await page.keyboard.press('F10');
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readStickyMenu().callerEnabled)).toBe(false);
	});

	test('sticky scroll menu closes with its model and respects the contextmenu option', async ({ page }) => {
		await page.goto('/standalone.html');
		await page.evaluate(() => {
			window.ashStandaloneIntegration.prepareStickyHeaders();
			window.ashStandaloneIntegration.updateContributionOptions({ contextmenu: false });
		});
		const header = page.locator('#caller .stanza-editor-sticky-scroll-item').last();
		await header.click({ button: 'right' });
		await expect(page.getByRole('menu')).toHaveCount(0);
		await page.evaluate(() => window.ashStandaloneIntegration.updateContributionOptions({ contextmenu: true }));
		await header.click({ button: 'right' });
		await expect(page.getByRole('menu')).toBeVisible();
		await page.evaluate(() => window.ashStandaloneIntegration.changeLanguageRequest('model'));
		await expect(page.getByRole('menu')).toHaveCount(0);
	});

	test('completion uses the new language and Escape stops incomplete refreshes', async ({ page }) => {
		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.prepareContributionRequests('completion'));
		await page.evaluate(() => window.ashStandaloneIntegration.changeContributionState('language'));
		await page.keyboard.press('Control+Space');
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readContributionRequests())).toEqual([{ languageId: 'javascript', aborted: false }]);
		await page.evaluate(() => window.ashStandaloneIntegration.finishContributionRequest(0));
		await expect(page.locator('#caller .stanza-editor-completion')).toContainText('completion: javascript');
		await page.keyboard.press('Escape');
		await page.keyboard.type('z');
		await expect(page.locator('#caller .stanza-editor-completion:not([hidden])')).toHaveCount(0);
		expect(await page.evaluate(() => window.ashStandaloneIntegration.readContributionRequests())).toHaveLength(1);
	});

	test('folding cancels old language requests and queries the current language after edits', async ({ page }) => {
		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.prepareContributionRequests('folding'));
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readContributionRequests().length)).toBeGreaterThan(0);
		const count = await page.evaluate(() => window.ashStandaloneIntegration.readContributionRequests().length);
		await page.evaluate(() => window.ashStandaloneIntegration.changeContributionState('language'));
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readContributionRequests().at(-1)?.languageId)).toBe('javascript');
		const requests = await page.evaluate(() => window.ashStandaloneIntegration.readContributionRequests());
		expect(requests.slice(0, count).every(request => request.aborted)).toBe(true);
		expect(requests.slice(count).every(request => request.languageId === 'javascript')).toBe(true);
		await page.evaluate(() => window.ashStandaloneIntegration.changeContributionState('edit'));
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readContributionRequests().length)).toBeGreaterThan(requests.length);
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readContributionRequests())).slice(count).every(request => request.languageId === 'javascript')).toBe(true);
	});

	for (const reason of ['language', 'provider', 'dispose'] as const) {
		test(`links ${reason} cancels an unresolved request`, async ({ page }) => {
			await page.goto('/standalone.html');
			await page.evaluate(() => window.ashStandaloneIntegration.prepareContributionRequests('links'));
			const point = await page.evaluate(() => window.ashStandaloneIntegration.contributionPoint(3));
			await page.mouse.move(point.x, point.y);
			await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readContributionRequests().length)).toBe(1);
			await page.mouse.move(point.x + 1, point.y);
			expect(await page.evaluate(() => window.ashStandaloneIntegration.readContributionRequests())).toHaveLength(1);
			await page.evaluate(reason => window.ashStandaloneIntegration.changeContributionState(reason), reason);
			expect(await page.evaluate(() => window.ashStandaloneIntegration.readContributionRequests())).toEqual([{ languageId: 'typescript', aborted: true }]);
			await page.evaluate(() => window.ashStandaloneIntegration.finishContributionRequest(0));
			await expect(page.locator('#caller .stanza-editor-link-target')).toHaveCount(0);
		});
	}

	test('links discard cached targets when language changes', async ({ page }) => {
		await page.goto('/standalone.html');
		await page.keyboard.down('ControlOrMeta');
		await page.evaluate(() => window.ashStandaloneIntegration.prepareContributionRequests('links'));
		const point = await page.evaluate(() => window.ashStandaloneIntegration.contributionPoint(3));
		await page.mouse.move(point.x, point.y);
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readContributionRequests().length)).toBe(1);
		await page.evaluate(() => window.ashStandaloneIntegration.finishContributionRequest(0));
		await expect(page.locator('#caller .stanza-editor-link-target')).toHaveCount(1);
		await page.evaluate(() => window.ashStandaloneIntegration.changeContributionState('language'));
		await page.mouse.click(point.x, point.y);
		expect(await page.evaluate(() => window.ashStandaloneIntegration.readOpenedLinks())).toEqual([]);
		await page.mouse.move(point.x + 1, point.y);
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readContributionRequests().length)).toBe(2);
		await page.evaluate(() => window.ashStandaloneIntegration.finishContributionRequest(1));
		await expect(page.locator('#caller .stanza-editor-link-target')).toHaveCount(1);
		await page.mouse.click(point.x + 1, point.y);
		expect(await page.evaluate(() => window.ashStandaloneIntegration.readOpenedLinks())).toEqual(['https://example.invalid/javascript']);
		await page.keyboard.up('ControlOrMeta');
	});

	test('CodeLens removes old language commands and rejects late responses', async ({ page }) => {
		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.prepareContributionRequests('codelens'));
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readContributionRequests().length)).toBe(1);
		await page.evaluate(() => window.ashStandaloneIntegration.finishContributionRequest(0));
		await expect(page.locator('#caller .stanza-editor-codelens')).toHaveText('lens: typescript');
		await page.evaluate(() => window.ashStandaloneIntegration.changeContributionState('language'));
		await expect(page.locator('#caller .stanza-editor-codelens')).toHaveCount(0);
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readContributionRequests().length)).toBe(2);
		await page.evaluate(() => window.ashStandaloneIntegration.changeContributionState('off'));
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readContributionRequests()))[1]!.aborted).toBe(true);
		await page.evaluate(() => window.ashStandaloneIntegration.finishContributionRequest(1));
		await expect(page.locator('#caller .stanza-editor-codelens')).toHaveCount(0);
	});

	test('CodeLens can be enabled after creation and toggled without restoring stale widgets', async ({ page }) => {
		await page.goto('/standalone.html?codeLensOff');
		await page.evaluate(() => window.ashStandaloneIntegration.prepareContributionRequests('codelens'));
		expect(await page.evaluate(() => window.ashStandaloneIntegration.readContributionRequests())).toEqual([]);
		await page.evaluate(() => window.ashStandaloneIntegration.changeContributionState('on'));
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readContributionRequests().length)).toBe(1);
		await page.evaluate(() => window.ashStandaloneIntegration.finishContributionRequest(0));
		await expect(page.locator('#caller .stanza-editor-codelens')).toHaveText('lens: typescript');
		await page.evaluate(() => window.ashStandaloneIntegration.changeContributionState('off'));
		await expect(page.locator('#caller .stanza-editor-codelens')).toHaveCount(0);
		await page.evaluate(() => window.ashStandaloneIntegration.changeContributionState('on'));
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readContributionRequests().length)).toBe(2);
		await page.evaluate(() => window.ashStandaloneIntegration.finishContributionRequest(1));
		await expect(page.locator('#caller .stanza-editor-codelens')).toHaveText('lens: typescript');
	});

	test('selection highlighting responds to configuration without moving the selection', async ({ page }) => {
		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.prepareContributionRequests('hover'));
		await page.evaluate(() => window.ashStandaloneIntegration.changeContributionState('selection'));
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readSelectionHighlights())).toBe(1);
		const state = await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing());
		await page.evaluate(() => window.ashStandaloneIntegration.changeContributionState('off'));
		expect(await page.evaluate(() => window.ashStandaloneIntegration.readSelectionHighlights())).toBe(0);
		await page.evaluate(() => window.ashStandaloneIntegration.changeContributionState('on'));
		expect(await page.evaluate(() => window.ashStandaloneIntegration.readSelectionHighlights())).toBe(1);
		expect(await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing())).toEqual(state);
	});

	test('hover clears documentation when the next word has no result', async ({ page }) => {
		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.prepareContributionRequests('hover'));
		const first = await page.evaluate(() => window.ashStandaloneIntegration.contributionPoint(3));
		await page.mouse.move(first.x, first.y);
		await expect(page.locator('#caller .stanza-editor-hover:not([hidden])')).toHaveText('alpha documentation');
		const next = await page.evaluate(() => window.ashStandaloneIntegration.contributionPoint(9));
		await page.mouse.move(next.x, next.y);
		await expect(page.locator('#caller .stanza-editor-hover')).toBeHidden();
		await expect(page.locator('#caller .stanza-editor-hover')).toHaveText('');
	});
});

test.describe('inlay hints', () => {
	test.afterEach(async ({ page }) => {
		await page.evaluate(() => window.ashStandaloneIntegration?.dispose());
	});

	for (const mode of ['on', 'offUnlessPressed', 'onUnlessPressed'] as const) {
		test(`inlay visibility follows ${mode}, modifier release and window blur without replacing nodes`, async ({ page }) => {
			await page.goto('/standalone.html');
			await page.evaluate(mode => {
				window.ashStandaloneIntegration.updateContributionOptions({ inlayHints: { enabled: mode } });
				window.ashStandaloneIntegration.prepareInlayRequests();
			}, mode);
			await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readInlayRequests().length)).toBe(1);
			await page.evaluate(() => window.ashStandaloneIntegration.finishInlayRequest(0, 'value:'));
			const hint = page.locator('#caller .stanza-editor-inlay-hint');
			await expect(hint).toBeVisible({ visible: mode !== 'offUnlessPressed' });
			const node = await hint.elementHandle();
			await page.keyboard.down('Control');
			await page.keyboard.down('Alt');
			await expect(hint).toBeVisible({ visible: mode !== 'onUnlessPressed' });
			await page.keyboard.up('Alt');
			await page.keyboard.up('Control');
			await expect(hint).toBeVisible({ visible: mode !== 'offUnlessPressed' });
			await page.keyboard.down('Control');
			await page.keyboard.down('Alt');
			await page.evaluate(() => window.dispatchEvent(new Event('blur')));
			await expect(hint).toBeVisible({ visible: mode !== 'offUnlessPressed' });
			await page.keyboard.up('Alt');
			await page.keyboard.up('Control');
			expect(await node!.evaluate(element => element.isConnected)).toBe(true);
			expect(await page.evaluate(() => window.ashStandaloneIntegration.readInlayRequests())).toHaveLength(1);
		});
	}

	test('late provider registration displays hints and layout retains their nodes', async ({ page }) => {
		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.prepareInlayRequests());
		const editorState = await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing());
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readInlayRequests())).toEqual([{
			text: 'call(value)', languageId: 'plaintext', resource: 'inmemory://stanza/caller.txt', range: '[1,1 -> 1,12]', aborted: false,
		}]);
		await page.evaluate(() => window.ashStandaloneIntegration.finishInlayRequest(0, 'value:'));
		const hint = page.locator('#caller .stanza-editor-inlay-hint');
		await expect(hint).toHaveText('value:');
		await expect(hint).toHaveAttribute('title', 'inlay detail');
		const node = await hint.elementHandle();
		await page.evaluate(() => window.ashStandaloneIntegration.changeInlayState('layout'));
		expect(await node!.evaluate(element => element.isConnected)).toBe(true);
		const box = await hint.boundingBox();
		expect(box!.width).toBeGreaterThan(0);
		expect(box!.height).toBeGreaterThan(0);
		await expect(hint).toHaveCount(1);
		expect(await page.evaluate(() => window.ashStandaloneIntegration.readInlayRequests())).toHaveLength(1);
		expect(await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing())).toEqual(editorState);
	});

	test('edits clear old hints immediately and coalesce requests for the latest text', async ({ page }) => {
		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.prepareInlayRequests());
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readInlayRequests().length)).toBe(1);
		await page.evaluate(() => window.ashStandaloneIntegration.finishInlayRequest(0, 'old:'));
		await expect(page.locator('#caller .stanza-editor-inlay-hint')).toHaveText('old:');
		const cleared = await page.evaluate(() => {
			window.ashStandaloneIntegration.changeInlayState('text');
			return document.querySelectorAll('#caller .stanza-editor-inlay-hint').length;
		});
		expect(cleared).toBe(0);
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readInlayRequests().map(request => request.text))).toEqual(['call(value)', 'bacall(value)']);
		await page.evaluate(() => window.ashStandaloneIntegration.changeInlayState('language'));
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readInlayRequests().map(request => [request.languageId, request.aborted]))).toEqual([
			['plaintext', false], ['plaintext', true], ['typescript', false],
		]);
		await page.evaluate(() => window.ashStandaloneIntegration.finishInlayRequest(2, 'current:'));
		await expect(page.locator('#caller .stanza-editor-inlay-hint')).toHaveText('current:');
		await page.evaluate(() => window.ashStandaloneIntegration.finishInlayRequest(1, 'stale:'));
		await expect(page.locator('#caller .stanza-editor-inlay-hint')).toHaveText('current:');
	});

	test('shortening the document removes hints before layout reads obsolete positions', async ({ page }) => {
		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.prepareInlayRequests());
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readInlayRequests().length)).toBe(1);
		await page.evaluate(() => window.ashStandaloneIntegration.finishInlayRequest(0, 'obsolete:'));
		await expect(page.locator('#caller .stanza-editor-inlay-hint')).toHaveText('obsolete:');
		await page.evaluate(() => window.ashStandaloneIntegration.changeInlayState('shrink'));
		await expect(page.locator('#caller .stanza-editor-inlay-hint')).toHaveCount(0);
		expect(errors).toEqual([]);
	});

	for (const reason of ['provider', 'off', 'contribution', 'model', 'dispose'] as const) {
		test(`${reason} removes rendered hints and stops requests`, async ({ page }) => {
			await page.goto('/standalone.html');
			await page.evaluate(() => window.ashStandaloneIntegration.prepareInlayRequests());
			await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readInlayRequests().length)).toBe(1);
			await page.evaluate(() => window.ashStandaloneIntegration.finishInlayRequest(0, 'visible:'));
			await expect(page.locator('#caller .stanza-editor-inlay-hint')).toHaveText('visible:');
			await page.evaluate(reason => window.ashStandaloneIntegration.changeInlayState(reason), reason);
			await expect(page.locator('#caller .stanza-editor-inlay-hint')).toHaveCount(0);
			if (reason !== 'dispose') {
				await page.evaluate(() => {
					window.ashStandaloneIntegration.changeInlayState('text');
					window.ashStandaloneIntegration.changeInlayState('language');
				});
			}
			expect(await page.evaluate(() => window.ashStandaloneIntegration.readInlayRequests())).toHaveLength(1);
		});

		test(`${reason} aborts an unresolved provider`, async ({ page }) => {
			await page.goto('/standalone.html');
			await page.evaluate(() => window.ashStandaloneIntegration.prepareInlayRequests());
			await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readInlayRequests().length)).toBe(1);
			await page.evaluate(reason => window.ashStandaloneIntegration.changeInlayState(reason), reason);
			expect((await page.evaluate(() => window.ashStandaloneIntegration.readInlayRequests()))[0]!.aborted).toBe(true);
			await page.evaluate(() => window.ashStandaloneIntegration.finishInlayRequest(0, 'late:'));
			await expect(page.locator('#caller .stanza-editor-inlay-hint')).toHaveCount(0);
		});
	}

	test('initially disabled hints can be enabled and toggled during a request', async ({ page }) => {
		await page.goto('/standalone.html?inlayHintsOff');
		await page.evaluate(() => window.ashStandaloneIntegration.prepareInlayRequests());
		expect(await page.evaluate(() => window.ashStandaloneIntegration.readInlayRequests())).toEqual([]);
		await page.evaluate(() => window.ashStandaloneIntegration.changeInlayState('on'));
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readInlayRequests().length)).toBe(1);
		await page.evaluate(() => {
			window.ashStandaloneIntegration.changeInlayState('off');
			window.ashStandaloneIntegration.changeInlayState('on');
		});
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readInlayRequests().length)).toBe(2);
		await page.evaluate(() => window.ashStandaloneIntegration.finishInlayRequest(1, 'enabled:'));
		await page.evaluate(() => window.ashStandaloneIntegration.finishInlayRequest(0, 'cancelled:'));
		await expect(page.locator('#caller .stanza-editor-inlay-hint')).toHaveText('enabled:');
	});

	test('a failing provider does not discard hints from another provider', async ({ page }) => {
		const errors: string[] = [];
		page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
		await page.goto('/standalone.html');
		await page.evaluate(() => {
			window.ashStandaloneIntegration.prepareInlayRequests();
			window.ashStandaloneIntegration.addBrokenInlayProvider();
		});
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readInlayRequests().length)).toBe(1);
		await page.evaluate(() => window.ashStandaloneIntegration.finishInlayRequest(0, 'healthy:'));
		await expect(page.locator('#caller .stanza-editor-inlay-hint')).toHaveText('healthy:');
		expect(errors.some(message => message.includes('inlay provider failed'))).toBe(true);
	});
});

test('detected document links reach the editor host without a language provider', async ({ page }) => {
	await page.goto('/standalone.html');
	await page.evaluate(() => window.ashStandaloneIntegration.prepareLinks());
	const link = page.locator('#caller .view-line > span > span').filter({ hasText: 'https://example.test/path' }).first();
	await expect(link).toBeVisible();
	const bounds = await link.boundingBox();
	expect(bounds).not.toBeNull();
	const point = { x: bounds!.x + bounds!.width / 2, y: bounds!.y + bounds!.height / 2 };
	await page.mouse.move(point.x, point.y);
	await page.mouse.click(point.x, point.y);
	expect(await page.evaluate(() => window.ashStandaloneIntegration.readOpenedLinks())).toEqual([]);
	await page.keyboard.down('ControlOrMeta');
	await expect(page.locator('#caller .stanza-editor-link-target')).toHaveCount(1);
	await page.mouse.click(point.x, point.y);
	await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readOpenedLinks())).toEqual(['https://example.test/path']);
	await page.evaluate(() => window.ashStandaloneIntegration.prepareClipboard('plain text'));
	await expect(page.locator('#caller .stanza-editor-link-target')).toHaveCount(0);
	await page.keyboard.up('ControlOrMeta');
});

test('links combine provider targets and detected URLs and honor disabled state and modifiers', async ({ page }) => {
	await page.goto('/standalone.html');
	await page.evaluate(() => {
		window.ashStandaloneIntegration.updateContributionOptions({ links: false });
		window.ashStandaloneIntegration.prepareLinkCandidates();
	});
	const first = await page.evaluate(() => window.ashStandaloneIntegration.contributionPoint(4));
	await page.keyboard.down('ControlOrMeta');
	await page.mouse.click(first.x, first.y);
	expect(await page.evaluate(() => window.ashStandaloneIntegration.readOpenedLinks())).toEqual([]);
	await page.evaluate(() => window.ashStandaloneIntegration.updateContributionOptions({ links: true }));
	await page.mouse.move(first.x + 1, first.y);
	await expect(page.locator('#caller .stanza-editor-link-target')).toHaveCount(1);
	await page.mouse.click(first.x + 1, first.y);
	await page.keyboard.up('ControlOrMeta');
	await expect(page.locator('#caller .stanza-editor-link-target')).toHaveCount(0);
	const second = await page.evaluate(() => window.ashStandaloneIntegration.contributionPoint(23));
	await page.evaluate(() => window.ashStandaloneIntegration.updateContributionOptions({ multiCursorModifier: 'ctrlCmd' }));
	await page.keyboard.down('Alt');
	await page.mouse.move(second.x, second.y);
	await expect(page.locator('#caller .stanza-editor-link-target')).toHaveCount(1);
	await page.mouse.click(second.x, second.y);
	await page.keyboard.up('Alt');
	expect(await page.evaluate(() => window.ashStandaloneIntegration.readOpenedLinks())).toEqual(['https://resolved.test', 'https://two.test']);
	await page.evaluate(() => window.ashStandaloneIntegration.dispose());
});

test('links disabling aborts pending results and prevents further provider requests', async ({ page }) => {
	await page.goto('/standalone.html');
	await page.evaluate(() => window.ashStandaloneIntegration.prepareContributionRequests('links'));
	const point = await page.evaluate(() => window.ashStandaloneIntegration.contributionPoint(3));
	await page.mouse.move(point.x, point.y);
	await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readContributionRequests().length)).toBe(1);
	await page.evaluate(() => window.ashStandaloneIntegration.updateContributionOptions({ links: false }));
	expect((await page.evaluate(() => window.ashStandaloneIntegration.readContributionRequests()))[0]!.aborted).toBe(true);
	await page.evaluate(() => window.ashStandaloneIntegration.finishContributionRequest(0));
	await page.keyboard.down('ControlOrMeta');
	await page.mouse.click(point.x + 1, point.y);
	expect(await page.evaluate(() => window.ashStandaloneIntegration.readOpenedLinks())).toEqual([]);
	expect(await page.evaluate(() => window.ashStandaloneIntegration.readContributionRequests())).toHaveLength(1);
	await page.keyboard.up('ControlOrMeta');
	await page.evaluate(() => window.ashStandaloneIntegration.dispose());
});

test('semantic provider replacement and removal update rendered token styles', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto('/standalone.html');
	await page.evaluate(() => window.ashStandaloneIntegration.setSemanticProvider('variable'));
	const variable = page.locator('#caller .view-lines .token-variable.token-modifier-readonly');
	await expect(variable).toHaveText('caller');
	await page.evaluate(() => window.ashStandaloneIntegration.setSemanticProvider('function'));
	await expect(page.locator('#caller .view-lines .token-function.token-modifier-readonly')).toHaveText('caller');
	await expect(variable).toHaveCount(0);
	await page.evaluate(() => window.ashStandaloneIntegration.setSemanticProvider(null));
	await expect(page.locator('#caller .view-lines .token-modifier-readonly')).toHaveCount(0);
	expect(errors).toEqual([]);
});


for (const inputKind of ['editContext', 'textarea'] as const) {
	for (const command of ['copy', 'cut', 'paste'] as const) {
		for (const target of ['outside', 'readonly', 'find'] as const) {
			test(`${inputKind} active clipboard ${command} respects ${target} target`, async ({ page }) => {
				if (inputKind === 'textarea') {
					await page.addInitScript(() => { Reflect.deleteProperty(window, 'EditContext'); });
				}
				await page.goto('/standalone.html');
				const handled = target === 'outside' || target === 'readonly' && command === 'copy';
				const edited = target === 'outside' && command !== 'copy';
				expect(await page.evaluate(({ command, target }) => window.ashStandaloneIntegration.runActiveClipboard(command, target), { command, target })).toEqual({
					values: [edited ? (command === 'cut' ? '' : 'omega') : 'alpha', 'bravo'],
					written: handled && command !== 'paste' ? 'alpha' : '',
					reads: handled && command === 'paste' ? 1 : 0,
					focused: handled,
					documentCommands: target === 'find' || handled && command !== 'paste' ? [command] : [],
				});
				if (edited) {
					await page.keyboard.press('ControlOrMeta+z');
					expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).value).toBe('alpha');
				}
			});
		}
	}

	for (const label of ['Find', 'Replace']) {
		for (const useAlias of [false, true]) {
			test(`${inputKind} ${useAlias ? 'aliased' : 'public'} history commands undo and redo ${label} input`, async ({ page }) => {
				if (inputKind === 'textarea') {
					await page.addInitScript(() => { Reflect.deleteProperty(window, 'EditContext'); });
				}
				await page.goto('/standalone.html');
				await page.evaluate(() => window.ashStandaloneIntegration.prepareInputHistory());
				const input = page.locator(`#caller input[aria-label="${label}"]`);
				await input.fill('');
				await input.pressSequentially('needle');
				await input.press('ControlOrMeta+z');
				const undoneValue = await input.inputValue();
				expect(undoneValue).not.toBe('needle');
				await input.press('ControlOrMeta+Shift+z');
				await expect(input).toHaveValue('needle');
				expect(await page.evaluate(useAlias => window.ashStandaloneIntegration.runInputHistoryCommand(useAlias ? 'default:undo' : 'undo'), useAlias)).toEqual(['alpha!', 'bravo']);
				await expect(input).toHaveValue(undoneValue);
				expect(await page.evaluate(useAlias => window.ashStandaloneIntegration.runInputHistoryCommand(useAlias ? 'default:redo' : 'redo'), useAlias)).toEqual(['alpha!', 'bravo']);
				await expect(input).toHaveValue('needle');
			});
		}
	}

	test(`${inputKind} public select all targets text, active editor, and find input`, async ({ page }) => {
		if (inputKind === 'textarea') {
			await page.addInitScript(() => { Reflect.deleteProperty(window, 'EditContext'); });
		}
		await page.goto('/standalone.html');
		expect(await page.evaluate(() => window.ashStandaloneIntegration.runSelectAllCommand())).toEqual({
			selections: ['[1,1 -> 2,4]|[1,2 -> 1,2]', '[1,1 -> 2,4]|[1,2 -> 1,2]', '[1,2 -> 1,2]|[1,2 -> 1,2]'],
			inputSelection: 'needle',
		});
	});

	for (const useAlias of [false, true]) {
		test(`${inputKind} ${useAlias ? 'aliased' : 'public'} history commands respect focus and dynamic readonly state`, async ({ page }) => {
			if (inputKind === 'textarea') {
				await page.addInitScript(() => { Reflect.deleteProperty(window, 'EditContext'); });
			}
			await page.goto('/standalone.html');
			expect(await page.evaluate(useAlias => window.ashStandaloneIntegration.runHistoryCommands(useAlias), useAlias)).toEqual([
				'alpha|bravo', 'alpha|bravo', 'alpha!|bravo', 'alpha!|bravo', 'alpha!|bravo', 'alpha|bravo',
			]);
		});
	}

	test(`${inputKind} editor focus stays coherent across find, replace, and external commands`, async ({ page }) => {
		if (inputKind === 'textarea') {
			await page.addInitScript(() => { Reflect.deleteProperty(window, 'EditContext'); });
		}
		await page.goto('/standalone.html');
		const result = await page.evaluate(() => window.ashStandaloneIntegration.runFocusRouting());
		expect(result).toEqual({
			states: [
				{ stage: 'text', text: true, widget: true, observedText: true, observedWidget: true, contextText: true, contextWidget: true, widgetEvents: 'focus' },
				{ stage: 'find', text: false, widget: true, observedText: false, observedWidget: true, contextText: false, contextWidget: true, widgetEvents: 'focus' },
				{ stage: 'replace', text: false, widget: true, observedText: false, observedWidget: true, contextText: false, contextWidget: true, widgetEvents: 'focus' },
				{ stage: 'outside', text: false, widget: false, observedText: false, observedWidget: false, contextText: false, contextWidget: false, widgetEvents: 'focus,blur' },
			],
			events: ['focus', 'blur'],
			activeAfterBlur: true,
			values: ['alpha\nalpha', 'bravo'],
			activeAfterDispose: true,
		});
	});

	test(`${inputKind} active editor follows use across creation, model switches, and removal`, async ({ page }) => {
		if (inputKind === 'textarea') {
			await page.addInitScript(() => { Reflect.deleteProperty(window, 'EditContext'); });
		}
		await page.goto('/standalone.html');
		expect(await page.evaluate(() => window.ashStandaloneIntegration.runEditorActivity())).toEqual([true, true, true, true]);
	});

	for (const fail of [false, true]) {
		test(`${inputKind} ordinary copy stays plain during a rich copy that ${fail ? 'fails' : 'succeeds'}`, async ({ page }) => {
			if (inputKind === 'textarea') {
				await page.addInitScript(() => { Reflect.deleteProperty(window, 'EditContext'); });
			}
			await page.goto('/standalone.html');
			expect(await page.evaluate(fail => window.ashStandaloneIntegration.runDeferredRichCopy(fail), fail)).toEqual({
				pendingHtml: '', finishedHtml: '', rejected: fail, writtenText: 'const',
			});
		});
	}

	for (const fromOutside of [false, true]) {
		for (const command of ['cut', 'paste'] as const) {
			for (const change of ['none', 'selection', 'focus', 'readonly', 'composition', 'escape', 'model', 'dispose'] as const) {
				test(`${inputKind} ${fromOutside ? 'external' : 'focused'} delayed clipboard ${command} respects ${change}`, async ({ page }) => {
					if (inputKind === 'textarea') {
						await page.addInitScript(() => { Reflect.deleteProperty(window, 'EditContext'); });
					}
					await page.goto('/standalone.html');
					const result = await page.evaluate(({ command, change, fromOutside }) => window.ashStandaloneIntegration.runDeferredClipboard(command, change, fromOutside), { command, change, fromOutside });
					expect(result).toEqual({
						value: change === 'none' ? (command === 'cut' ? '' : 'omega') : 'alpha',
						finishedBeforeTransfer: change !== 'none',
					});
					if (change === 'none') {
						await page.keyboard.press('ControlOrMeta+z');
						expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).value).toBe('alpha');
					}
				});
			}
		}
	}

	for (const change of ['none', 'writableAgain', 'selection', 'composition', 'escape'] as const) {
		test(`${inputKind} deferred file paste respects ${change} state before committing`, async ({ page }) => {
			if (inputKind === 'textarea') {
				await page.addInitScript(() => { Reflect.deleteProperty(window, 'EditContext'); });
			}
			await page.goto('/standalone.html');
			expect(await page.evaluate(change => window.ashStandaloneIntegration.runDeferredPaste(change), change)).toEqual({
				value: change === 'none' ? 'alpha file' : 'alpha',
				handled: true,
				finishedBeforeDecode: change !== 'none',
			});
			if (change === 'none') {
				await page.keyboard.press('ControlOrMeta+z');
				expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).value).toBe('alpha');
			}
		});
	}
}

for (const change of ['none', 'readonly', 'writableAgain'] as const) {
	test(`deferred file drop respects ${change} state before committing`, async ({ page }) => {
		await page.goto('/standalone.html');
		expect(await page.evaluate(change => window.ashStandaloneIntegration.runDeferredDrop(change), change)).toEqual({
			value: change === 'none' ? 'alpha file' : 'alpha',
			selectionUnchanged: change !== 'none',
			handled: true,
		});
		if (change === 'none') {
			await page.keyboard.press('ControlOrMeta+z');
			expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).value).toBe('alpha');
		}
	});
}

test('occurrence shortcuts and actions share the same selections and edit transaction', async ({ page }) => {
	await page.goto('/standalone.html');
	await page.evaluate(() => window.ashStandaloneIntegration.prepareBrackets('echo echo echo', [2]));
	await page.keyboard.press('ControlOrMeta+d');
	expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).selections).toEqual(['[1,1 -> 1,5]']);
	await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.action.addSelectionToNextFindMatch'));
	expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).selections).toEqual(['[1,1 -> 1,5]', '[1,6 -> 1,10]']);
	await page.keyboard.press('ControlOrMeta+Shift+l');
	expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).selections).toHaveLength(3);
	await page.keyboard.type('X');
	expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).value).toBe('X X X');
	await page.keyboard.press('ControlOrMeta+z');
	expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).value).toBe('echo echo echo');
});

test('cursor actions share line-end and adjacent cursor operations', async ({ page }) => {
	await page.goto('/standalone.html');
	await page.evaluate(() => window.ashStandaloneIntegration.prepareMulticursor());
	await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.action.insertCursorAtEndOfEachLineSelected'));
	expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).selections).toEqual(['[1,6 -> 1,6]', '[2,5 -> 2,5]']);
	await page.evaluate(() => window.ashStandaloneIntegration.prepareBrackets('alpha\nbeta\ngamma', [2]));
	await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.action.insertCursorBelow'));
	expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).selections).toHaveLength(2);
	await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.action.insertCursorAbove'));
	expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).value).toBe('alpha\nbeta\ngamma');
	await page.evaluate(() => window.ashStandaloneIntegration.prepareBrackets('echo echo', [2]));
	await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.action.selectHighlights'));
	expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).selections).toEqual(['[1,1 -> 1,5]', '[1,6 -> 1,10]']);
});

test('multicursor registration handles line-end cursors and one undoable edit', async ({ page }) => {
	await page.goto('/standalone.html');
	await page.evaluate(() => window.ashStandaloneIntegration.prepareMulticursor());
	await page.keyboard.press('Alt+Shift+i');
	expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).selections).toEqual(['[1,6 -> 1,6]', '[2,5 -> 2,5]']);
	await page.keyboard.type('X');
	expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).value).toBe('alphaX\nbetaX');
	await page.keyboard.press('ControlOrMeta+z');
	expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).value).toBe('alpha\nbeta');
});

test('bracket navigation shares the controller with its action for multiple cursors', async ({ page }) => {
	await page.goto('/standalone.html');
	await page.evaluate(() => window.ashStandaloneIntegration.prepareBrackets('(one) [two]', [1, 7]));
	await page.keyboard.press('ControlOrMeta+Shift+Backslash');
	expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).selections).toEqual(['[1,5 -> 1,5]', '[1,11 -> 1,11]']);
	await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.action.jumpToBracket'));
	expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).selections).toEqual(['[1,1 -> 1,1]', '[1,7 -> 1,7]']);
});

for (const inputKind of ['editContext', 'textarea'] as const) {
	test(`${inputKind} editor actions keep their context across read-only and model changes`, async ({ page }) => {
		if (inputKind === 'textarea') {
			await page.addInitScript(() => { Reflect.deleteProperty(window, 'EditContext'); });
		}
		await page.goto('/standalone.html');
		expect(await page.evaluate(() => window.ashStandaloneIntegration.runScopedActions())).toEqual({
			supported: [false, true], values: ['alpha\nbeta\ngamma', 'beta\ngamma', 'gamma'],
			otherValue: 'owned', sameContext: true, focusRetained: true,
		});
	});
}

test('model bracket decorations reach the viewport and follow per-editor color settings', async ({ page }) => {
	await page.goto('/standalone.html');
	await page.evaluate(() => window.ashStandaloneIntegration.prepareBrackets('{([])}', [1]));
	const colors = page.locator('#caller .view-line [class*="stanza-editor-bracket-level-"]');
	await expect(colors).toHaveCount(6);
	expect(await colors.evaluateAll(elements => elements.map(element => [...element.classList].find(value => value.startsWith('stanza-editor-bracket-level-'))))).toEqual([1, 2, 3, 3, 2, 1].map(level => `stanza-editor-bracket-level-${level}`));
	await page.evaluate(() => window.ashStandaloneIntegration.configureBracketColors(false, false));
	await expect(colors).toHaveCount(0);
	await page.evaluate(() => window.ashStandaloneIntegration.configureBracketColors(true, true));
	await expect(page.locator('#caller .view-line .stanza-editor-bracket-level-1')).toHaveCount(6);
	await page.keyboard.press('ArrowRight');
	await page.keyboard.type('x');
	expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).value).toBe('{x([])}');
	await expect(colors).toHaveCount(6);
	await page.keyboard.press('ControlOrMeta+z');
	expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).value).toBe('{([])}');
	await page.evaluate(() => {
		window.ashStandaloneIntegration.prepareBrackets('{\n  value\n}', [1]);
		window.ashStandaloneIntegration.configureBracketColors(false, false);
	});
	await expect(colors).toHaveCount(0);
	await expect(page.locator('#caller .stanza-editor-bracket-guide')).not.toHaveCount(0);
});

for (const inputKind of ['editContext', 'textarea'] as const) {
	test(`bracket themes override token foreground and preserve ${inputKind} text and focus`, async ({ page }) => {
		if (inputKind === 'textarea') {
			await page.addInitScript(() => { Reflect.deleteProperty(window, 'EditContext'); });
		}
		await page.goto('/standalone.html');
		await page.evaluate(() => {
			window.ashStandaloneIntegration.prepareBrackets('({[({[x]})]})', [1]);
			window.ashStandaloneIntegration.prepareBracketToken();
		});
		const brackets = page.locator('#caller .view-line [class*="stanza-editor-bracket-level-"]');
		const readColors = (): Promise<string[]> => brackets.evaluateAll(elements => elements.map(element => getComputedStyle(element).color));
		const palettes = {
			Dark: ['rgb(229, 192, 123)', 'rgb(198, 120, 221)', 'rgb(86, 182, 194)', 'rgb(152, 195, 121)', 'rgb(224, 108, 117)', 'rgb(97, 175, 239)'],
			Light: ['rgb(121, 94, 0)', 'rgb(136, 65, 160)', 'rgb(0, 118, 129)', 'rgb(56, 125, 34)', 'rgb(161, 44, 64)', 'rgb(0, 95, 184)'],
			HighContrastDark: ['rgb(255, 255, 0)', 'rgb(255, 112, 232)', 'rgb(0, 255, 255)', 'rgb(140, 255, 102)', 'rgb(255, 157, 157)', 'rgb(154, 200, 255)'],
			HighContrastLight: ['rgb(121, 94, 0)', 'rgb(136, 65, 160)', 'rgb(0, 118, 129)', 'rgb(56, 125, 34)', 'rgb(161, 44, 64)', 'rgb(0, 95, 184)'],
		};
		for (const scheme of Object.keys(palettes) as (keyof typeof palettes)[]) {
			await page.evaluate(scheme => window.ashStandaloneIntegration.setBracketTheme(scheme), scheme);
			const expected = [...palettes[scheme], ...[...palettes[scheme]].reverse()];
			await expect.poll(readColors).toEqual(expected);
			await expect(page.locator('#caller .stanza-editor-line-text')).toHaveText('({[({[x]})]})');
			await expect(page.locator('#caller .view-line .stanza-editor-token').filter({ hasText: /^x$/ })).toHaveCSS('color', 'rgb(18, 52, 86)');
			expect((await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing())).focused).toBe(true);
		}
		await page.evaluate(() => window.ashStandaloneIntegration.setBracketTheme('Light', ['#aabb01', '#aabb02', '#aabb03', '#aabb04', '#aabb05', '#aabb06']));
		const custom = [1, 2, 3, 4, 5, 6].map(value => `rgb(170, 187, ${value})`);
		await expect.poll(readColors).toEqual([...custom, ...[...custom].reverse()]);
		await page.evaluate(() => window.ashStandaloneIntegration.configureBracketColors(false, false));
		await expect(brackets).toHaveCount(0);
		await expect(page.locator('#caller .view-line .stanza-editor-token')).toHaveCSS('color', 'rgb(18, 52, 86)');
		await page.evaluate(() => window.ashStandaloneIntegration.configureBracketColors(true, true));
		await expect.poll(readColors).toEqual([custom[0], custom[0], custom[0], custom[1], custom[1], custom[1], custom[1], custom[1], custom[1], custom[0], custom[0], custom[0]]);
		await expect(brackets.first()).toHaveCSS('font-weight', '700');
	});
}

test('indent guides show blank-line depth, theme strokes and preserve pointer editing', async ({ page }) => {
	await page.goto('/standalone.html');
	await page.evaluate(() => {
		window.ashStandaloneIntegration.prepareGuides('root\n\tchild\n\n    sibling\nroot');
		window.ashStandaloneIntegration.moveGutterCaret(3, 1);
	});
	const row = (line: number) => page.locator(`#caller .view-overlay-line[data-line-index="${line}"]`);
	const guides = row(2).locator('.stanza-editor-indent-guide');
	await expect(guides).toHaveCount(2);
	await expect(guides.last()).toHaveClass(/active/);
	const positions = (line: number) => row(line).locator('.stanza-editor-indent-guide').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().x));
	expect(await positions(2)).toEqual(await positions(1));
	expect(await positions(2)).toEqual(await positions(3));
	for (const [scheme, inactive, active] of [
		['Dark', 'rgb(69, 69, 69)', 'rgb(144, 144, 144)'],
		['Light', 'rgb(196, 196, 196)', 'rgb(112, 112, 112)'],
		['HighContrastDark', 'rgb(160, 160, 160)', 'rgb(255, 255, 255)'],
		['HighContrastLight', 'rgb(102, 102, 102)', 'rgb(0, 0, 0)'],
	] as const) {
		await page.evaluate(scheme => window.ashStandaloneIntegration.setGuideTheme(scheme), scheme);
		await expect(guides.first()).toHaveCSS('border-left-color', inactive);
		await expect(guides.last()).toHaveCSS('border-left-color', active);
		await expect(guides.first()).toHaveCSS('border-left-width', '1px');
		await expect(guides.last()).toHaveCSS('border-left-width', '2px');
	}
	await page.evaluate(() => window.ashStandaloneIntegration.setGuideTheme('Dark', {
		'editorIndentGuide.background1': '#123456', 'editorIndentGuide.activeBackground1': '#abcdef',
	}));
	await expect(guides.first()).toHaveCSS('border-left-color', 'rgb(18, 52, 86)');
	await expect(guides.last()).toHaveCSS('border-left-color', 'rgb(171, 205, 239)');
	await expect(guides.last()).toHaveCSS('pointer-events', 'none');
	const bounds = await guides.last().boundingBox();
	expect(bounds?.height).toBe(20);
	expect(await guides.last().evaluate(element => element.closest('[aria-hidden="true"]') !== null)).toBe(true);
	await page.mouse.click(bounds!.x, bounds!.y + 10);
	await page.keyboard.type('x');
	expect((await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing())).value).toBe('root\n\tchild\nx\n    sibling\nroot');
	expect((await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing())).focused).toBe(true);
	await page.evaluate(() => window.ashStandaloneIntegration.configureGuides({ guides: { indentation: false } }));
	await expect(page.locator('#caller .stanza-editor-indent-guide')).toHaveCount(0);
});

test('bracket guides use nesting themes, active strokes and half-line endpoints', async ({ page }) => {
	await page.goto('/standalone.html');
	await page.evaluate(() => {
		window.ashStandaloneIntegration.prepareGuides('{\n  [\n    value\n    ]\n  tail\n}');
		window.ashStandaloneIntegration.moveGutterCaret(3, 5);
	});
	const vertical = page.locator('#caller .stanza-editor-bracket-guide');
	const levelOne = page.locator('#caller .stanza-editor-bracket-guide.stanza-editor-guide-level-1');
	const levelTwo = page.locator('#caller .stanza-editor-bracket-guide.stanza-editor-guide-level-2');
	await expect(levelOne).toHaveCount(6);
	await expect(levelTwo).toHaveCount(3);
	await expect(page.locator('#caller .view-overlay-line[data-line-index="2"] .stanza-editor-indent-guide')).toHaveCount(0);
	await expect(levelTwo.first()).toHaveClass(/active/);
	await expect(levelOne.first()).toHaveCSS('border-left-width', '1px');
	await expect(levelTwo.first()).toHaveCSS('border-left-width', '2px');
	expect(await levelOne.evaluateAll(elements => elements.map(element => ({ height: element.getBoundingClientRect().height, top: (element as HTMLElement).style.top })))).toEqual([
		{ height: 10, top: '10px' }, ...Array(4).fill({ height: 20, top: '0px' }), { height: 10, top: '0px' },
	]);
	const horizontal = page.locator('#caller .stanza-editor-bracket-guide-horizontal.stanza-editor-guide-level-2');
	await expect(horizontal).toHaveCSS('border-top-width', '2px');
	expect((await horizontal.boundingBox())!.width).toBeGreaterThan(0);
	for (const [scheme, color] of [
		['Dark', 'rgb(198, 120, 221)'], ['Light', 'rgb(136, 65, 160)'],
		['HighContrastDark', 'rgb(255, 112, 232)'], ['HighContrastLight', 'rgb(136, 65, 160)'],
	] as const) {
		await page.evaluate(scheme => window.ashStandaloneIntegration.setGuideTheme(scheme), scheme);
		await expect(levelTwo.first()).toHaveCSS('border-left-color', color);
		await expect(horizontal).toHaveCSS('border-top-color', color);
	}
	await page.evaluate(() => window.ashStandaloneIntegration.setGuideTheme('Dark', {
		'editorBracketPairGuide.background1': '#123456', 'editorBracketPairGuide.activeBackground2': '#abcdef',
	}));
	await expect(levelOne.first()).toHaveCSS('border-left-color', 'rgb(18, 52, 86)');
	await expect(levelTwo.first()).toHaveCSS('border-left-color', 'rgb(171, 205, 239)');
	await page.evaluate(() => window.ashStandaloneIntegration.configureGuides({ guides: { bracketPairs: 'active', bracketPairsHorizontal: false } }));
	await expect(levelOne).toHaveCount(0);
	await expect(levelTwo).toHaveCount(3);
	await expect(horizontal).toHaveCount(0);
	await page.evaluate(() => window.ashStandaloneIntegration.moveGutterCaret(5, 3));
	await expect(levelTwo).toHaveCount(0);
	await expect(levelOne).toHaveCount(6);
	await page.evaluate(() => window.ashStandaloneIntegration.configureBracketColors(true, true));
	await expect(levelTwo).toHaveCount(0);
	await expect(levelOne).toHaveCount(9);
	await page.evaluate(() => window.ashStandaloneIntegration.configureGuides({ guides: { bracketPairs: false } }));
	await expect(vertical).toHaveCount(0);
	await page.evaluate(() => window.ashStandaloneIntegration.prepareGuides('({[]})'));
	await expect(vertical).toHaveCount(0);
});

test('wrapped indentation guides stay in the reserved indentation space', async ({ page }) => {
	await page.goto('/standalone.html');
	await page.evaluate(() => {
		window.ashStandaloneIntegration.prepareGuides(`    ${'word '.repeat(100)}`);
		window.ashStandaloneIntegration.configureGuides({ wordWrap: 'wordWrapColumn', wordWrapColumn: 24, wrappingIndent: 'same', guides: { bracketPairs: false } });
	});
	const rows = page.locator('#caller .view-line');
	await expect.poll(() => rows.count()).toBeGreaterThan(1);
	await expect(page.locator('#caller .view-overlay-line[data-line-index="1"] .stanza-editor-indent-guide')).toHaveCount(2);
	await page.evaluate(() => window.ashStandaloneIntegration.configureGuides({ wrappingIndent: 'none' }));
	await expect(page.locator('#caller .view-overlay-line[data-line-index="1"] .stanza-editor-indent-guide')).toHaveCount(0);
	await expect(page.locator('#caller .view-overlay-line[data-line-index="0"] .stanza-editor-indent-guide')).toHaveCount(2);
});

test('bracket guides follow block indentation without crossing function text', async ({ page }) => {
	await page.goto('/standalone.html');
	await page.evaluate(() => {
		window.ashStandaloneIntegration.prepareGuides('function example() {\n    call();\n}');
		window.ashStandaloneIntegration.moveGutterCaret(2, 10);
	});
	const vertical = page.locator('#caller .stanza-editor-bracket-guide');
	await expect(vertical).toHaveCount(3);
	await expect(vertical.first()).toHaveClass(/active/);
	const row = page.locator('#caller .view-overlay-line[data-line-index="0"]').filter({ has: page.locator('.stanza-editor-bracket-guide') });
	const horizontal = page.locator('#caller .stanza-editor-bracket-guide-horizontal');
	await expect(horizontal).toHaveCount(1);
	const opening = (await row.boundingBox())!;
	const connector = (await horizontal.boundingBox())!;
	expect(connector.y + connector.height).toBeCloseTo(opening.y + opening.height);
	const columns = await vertical.evaluateAll(elements => elements.map(element => element.getBoundingClientRect().x));
	expect(columns).toEqual([columns[0], columns[0], columns[0]]);
	const text = (await page.locator('#caller .view-line').nth(1).locator('.stanza-editor-line-text').boundingBox())!;
	expect(columns[1]).toBeCloseTo(text.x);
	const indent = await page.locator('#caller .view-overlay-line[data-line-index="1"] .stanza-editor-indent-guide').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().x));
	expect(indent).not.toContain(columns[1]);
});

test('guide rows track folding and scrolling without retaining hidden lines', async ({ page }) => {
	await page.goto('/standalone.html');
	await page.evaluate(() => {
		window.ashStandaloneIntegration.prepareGuides(['{', '    child', '}', ...Array(50).fill('tail')].join('\n'));
		window.ashStandaloneIntegration.configureGuides({ showFoldingControls: 'always', scrollBeyondLastLine: false });
	});
	const guides = page.locator('#caller .stanza-editor-bracket-guide');
	await expect(guides).toHaveCount(3);
	await page.locator('#caller .ash-icon-folding-expanded').first().click();
	await expect(page.locator('#caller .ash-icon-folding-collapsed').first()).toBeVisible();
	await expect.poll(() => guides.count()).toBeLessThan(3);
	await expect(page.locator('#caller .view-line').filter({ hasText: 'child' })).toHaveCount(0);
	await page.locator('#caller .ash-icon-folding-collapsed').first().click();
	await expect(guides).toHaveCount(3);
	await page.evaluate(() => window.ashStandaloneIntegration.scrollVisibleRows(500));
	await expect(guides).toHaveCount(0);
	await expect(page.locator('#caller .stanza-editor-indent-guide')).toHaveCount(0);
	await page.evaluate(() => window.ashStandaloneIntegration.scrollVisibleRows(0));
	await expect(guides).toHaveCount(3);
});

test('common text operations preserve multi-cursor joins, deletions and undo', async ({ page }) => {
	await page.goto('/standalone.html');
	await page.evaluate(() => window.ashStandaloneIntegration.prepareLineJoin());
	const before = await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy());
	await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.action.joinLines'));
	expect(await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).toEqual({ value: '😀 one two\r\nkeep\r\n三 four', selections: ['[3,2 -> 3,2]', '[1,7 -> 1,7]'] });
	await page.keyboard.press('ControlOrMeta+z');
	expect(await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).toEqual(before);
	await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.action.deleteLines'));
	expect(await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).toEqual({ value: '  two\r\nkeep\r\n  four', selections: ['[3,1 -> 3,1]', '[1,1 -> 1,1]'] });
	await page.keyboard.press('ControlOrMeta+z');
	expect(await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).toEqual(before);
});

for (const entry of ['shortcut', 'action'] as const) {
	test(`bracket removal via ${entry} is one undo step`, async ({ page }) => {
		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.prepareBrackets('(one) [two]', [1, 7]));
		if (entry === 'shortcut') await page.keyboard.press('ControlOrMeta+Alt+Backspace');
		else await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.action.removeBrackets'));
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).value).toBe('one two');
		await page.keyboard.press('ControlOrMeta+z');
		expect(await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).toEqual({ value: '(one) [two]', selections: ['[1,1 -> 1,1]', '[1,7 -> 1,7]'] });
	});
}

for (const entry of ['shortcut', 'action'] as const) {
	test(`bracket removal via ${entry} preserves unrelated selected text`, async ({ page }) => {
		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.prepareBrackets('(value) keep', [1, [13, 9]]));
		if (entry === 'shortcut') await page.keyboard.press('ControlOrMeta+Alt+Backspace');
		else await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.action.removeBrackets'));
		expect(await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).toEqual({ value: 'value keep', selections: ['[1,1 -> 1,1]', '[1,11 -> 1,7]'] });
		await page.keyboard.press('ControlOrMeta+z');
		expect(await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).toEqual({ value: '(value) keep', selections: ['[1,1 -> 1,1]', '[1,13 -> 1,9]'] });
	});
}

test('bracket removal respects read-only state while navigation remains available', async ({ page }) => {
	await page.goto('/standalone.html');
	await page.evaluate(() => window.ashStandaloneIntegration.prepareBrackets('(one)', [1], true));
	await page.keyboard.press('ControlOrMeta+Alt+Backspace');
	await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.action.removeBrackets'));
	expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).value).toBe('(one)');
	await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.action.jumpToBracket'));
	expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).selections).toEqual(['[1,5 -> 1,5]']);
});

test('document formatting uses a range-only provider and remains undoable', async ({ page }) => {
	const workers: string[] = [];
	page.on('worker', worker => workers.push(worker.url()));
	await page.goto('/standalone.html');
	expect(await page.evaluate(() => window.ashStandaloneIntegration.runFormatting('range'))).toBe('ALPHA');
	expect(workers.some(url => /editorWebWorkerMain/u.test(url))).toBe(true);
	await page.keyboard.press('ControlOrMeta+z');
	expect(await page.evaluate(() => window.ashStandaloneIntegration.readDeferredFormatting().value)).toBe('alpha');
});

test('line comment shortcuts share actions and preserve the primary selection below a secondary caret', async ({ page }) => {
	await page.goto('/standalone.html');
	await page.evaluate(() => window.ashStandaloneIntegration.prepareLineComment());
	const before = await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy());
	await page.keyboard.press('ControlOrMeta+/');
	const commented = { value: '// alpha\nbeta\n// gamma', selections: ['[3,7 -> 3,5]', '[1,5 -> 1,5]'] };
	expect(await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).toEqual(commented);
	await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.action.commentLine'));
	expect(await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).toEqual(before);
	await page.keyboard.press('ControlOrMeta+z');
	expect(await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).toEqual(commented);
	await page.keyboard.press('ControlOrMeta+z');
	expect(await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).toEqual(before);
	await page.evaluate(() => window.ashStandaloneIntegration.dispose());
});

for (const kind of ['line', 'block'] as const) {
	test(`${kind} comment shortcuts honor spacing and toggle through the action`, async ({ page }) => {
		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.prepareLineComment({ insertSpace: false, value: 'alpha' }));
		await page.keyboard.press(kind === 'line' ? 'ControlOrMeta+/' : 'Alt+Shift+a');
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).value).toBe(kind === 'line' ? '//alpha' : '/*alpha*/');
		await page.evaluate(kind => window.ashStandaloneIntegration.runLineAction(kind === 'line' ? 'editor.action.commentLine' : 'editor.action.blockComment'), kind);
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).value).toBe('alpha');
		await page.keyboard.press('ControlOrMeta+z');
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).value).toBe(kind === 'line' ? '//alpha' : '/*alpha*/');
	});

	for (const mode of ['readonly', 'unsupported'] as const) {
		test(`${kind} comment shortcuts leave ${mode} text unchanged`, async ({ page }) => {
			await page.goto('/standalone.html');
			await page.evaluate(mode => window.ashStandaloneIntegration.prepareLineComment({ readOnly: mode === 'readonly', languageId: mode === 'unsupported' ? 'plaintext' : 'typescript' }), mode);
			const before = await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy());
			await page.keyboard.press(kind === 'line' ? 'ControlOrMeta+/' : 'Alt+Shift+a');
			expect(await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).toEqual(before);
		});
	}
}

test('line comment shortcuts use the configured empty-line policy', async ({ page }) => {
	await page.goto('/standalone.html');
	await page.evaluate(() => window.ashStandaloneIntegration.prepareLineComment({ value: 'alpha\n\nbeta' }));
	await page.keyboard.press('ControlOrMeta+/');
	expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).value).toBe('// alpha\n\n// beta');
});

test('transpose letters keeps a selected primary range while editing a secondary caret', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto('/standalone.html');
	await page.evaluate(() => window.ashStandaloneIntegration.prepareLineCopy());
	const before = await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy());
	await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.action.transposeLetters'));
	const after = { value: 'lapha\nbeta\ngamma', selections: ['[3,4 -> 3,2]', '[1,3 -> 1,3]'] };
	expect(await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).toEqual(after);
	await page.keyboard.press('ControlOrMeta+z');
	expect(await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).toEqual(before);
	await page.keyboard.press('ControlOrMeta+Shift+z');
	expect(await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).toEqual(after);
	await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	expect(errors).toEqual([]);
});

for (const direction of ['Up', 'Down']) {
	test(`copy final lines ${direction} includes the empty last line and restores selections on undo`, async ({ page }) => {
		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.prepareLineCopy(true));
		const before = await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy());
		await page.evaluate(id => window.ashStandaloneIntegration.runLineAction(id), `editor.action.copyLines${direction}Action`);
		const delta = direction === 'Down' ? 1 : 0;
		const copied = { value: 'head\ntail\ntail\n\n', selections: [`[${4 + delta},1 -> ${4 + delta},1]`, `[${2 + delta},3 -> ${2 + delta},1]`] };
		expect(await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).toEqual(copied);
		await page.keyboard.press('ControlOrMeta+z');
		expect(await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).toEqual(before);
		await page.keyboard.press('ControlOrMeta+Shift+z');
		expect(await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).toEqual(copied);
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	});

	test(`copy lines ${direction} retains multiple cursors and separates undo from typing`, async ({ page }) => {
		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.prepareLineCopy());
		await page.keyboard.type('X');
		const before = await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy());
		await page.evaluate(id => window.ashStandaloneIntegration.runLineAction(id), `editor.action.copyLines${direction}Action`);
		const copied = await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy());
		const delta = direction === 'Down' ? 1 : 0;
		expect(copied).toEqual({ value: 'aXlpha\naXlpha\nbeta\ngXma\ngXma', selections: [`[${4 + delta},3 -> ${4 + delta},3]`, `[${1 + delta},3 -> ${1 + delta},3]`] });
		await page.keyboard.type('!');
		await page.keyboard.press('ControlOrMeta+z');
		expect(await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).toEqual(copied);
		await page.keyboard.press('ControlOrMeta+z');
		expect(await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).toEqual(before);
		await page.keyboard.press('ControlOrMeta+z');
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).value).toBe('alpha\nbeta\ngamma');
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
		expect(errors).toEqual([]);
	});
}

for (const id of ['editor.action.duplicateSelection', 'editor.action.moveLinesDownAction', 'editor.action.sortLinesDescending']) {
	test(`${id} has its own undo step between typing operations`, async ({ page }) => {
		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.prepareKeyboardEditing());
		await page.locator('#caller .stanza-editor-input').focus();
		await page.keyboard.type('Z');
		const before = await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy());
		await page.evaluate(id => window.ashStandaloneIntegration.runLineAction(id), id);
		const edited = await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy());
		expect(edited.value).not.toBe(before.value);
		await page.keyboard.type('!');
		await page.keyboard.press('ControlOrMeta+z');
		expect(await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).toEqual(edited);
		await page.keyboard.press('ControlOrMeta+z');
		expect(await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).toEqual(before);
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	});
}

test('public range selection replaces the selected text through keyboard input and undo', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto('/standalone.html');
	const before = await page.evaluate(() => window.ashStandaloneIntegration.prepareKeyboardEditing());
	const input = page.locator('#caller .stanza-editor-input');
	await input.focus();
	const selected = await page.evaluate(() => window.ashStandaloneIntegration.selectRange());
	expect(selected).toEqual({ value: 'first\nsecond', version: before.version, selection: '[1,2 -> 2,4]', focused: true });
	await expect(page.locator('#caller .stanza-editor-selection')).toHaveCount(2);
	await expect(input).toBeFocused();
	await page.keyboard.type('X');
	await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing().value)).toBe('fXond');
	await page.keyboard.press('ControlOrMeta+z');
	await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing().value)).toBe('first\nsecond');
	await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing().selection)).toBe('[1,2 -> 2,4]');
	await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	expect(errors).toEqual([]);
});

test('standalone editors type and release their models, contributions, registry entries, and DOM', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.stack ?? error.message));
	await page.goto('/standalone.html');
	await expect(page.locator('#caller .stanza-editor')).toBeVisible();
	await expect(page.locator('#owned .stanza-editor')).toBeVisible();
	const initial = await page.evaluate(() => ({
		events: window.ashStandaloneIntegration.events,
		caller: window.ashStandaloneIntegration.state('caller'),
		owned: window.ashStandaloneIntegration.state('owned'),
	}));
	expect(initial).toEqual({
		events: [
			{ model: 'inmemory://stanza/caller.txt', registered: true, mounted: true, placeholder: true, theme: 'ash-light' },
			{ model: 'inmemory://stanza/owned.txt', registered: true, mounted: true, placeholder: true, theme: 'ash-light' },
		],
		caller: {
			value: 'caller', disposed: false, registered: true, modelRegistered: true,
			mounted: true, placeholder: true, theme: 'ash-light',
		},
		owned: {
			value: 'owned', disposed: false, registered: true, modelRegistered: true,
			mounted: true, placeholder: true, theme: 'ash-light',
		},
	});

	for (const kind of ['caller', 'owned'] as const) {
		const input = page.locator(`#${kind} .stanza-editor-input`);
		await expect(input).toHaveAttribute('aria-label', /.+/u);
		await input.focus();
		await page.keyboard.press('ControlOrMeta+End');
		await page.keyboard.type('!');
		await expect.poll(() => page.evaluate(name => window.ashStandaloneIntegration.state(name).value, kind)).toBe(`${kind}!`);
	}

	await page.evaluate(() => window.ashStandaloneIntegration.releaseCaller());
	await expect(page.locator('#caller .stanza-editor')).toHaveCount(0);
	expect(await page.evaluate(() => window.ashStandaloneIntegration.state('caller'))).toEqual({
		value: 'changed after editor disposal', disposed: false, registered: false, modelRegistered: true,
		mounted: false, placeholder: false, theme: null,
	});
	await page.evaluate(() => window.ashStandaloneIntegration.releaseOwned());
	await expect(page.locator('#owned .stanza-editor')).toHaveCount(0);
	expect(await page.evaluate(() => window.ashStandaloneIntegration.state('owned'))).toEqual({
		value: null, disposed: true, registered: false, modelRegistered: false,
		mounted: false, placeholder: false, theme: null,
	});
	await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	expect(errors).toEqual([]);
});

test('standalone editor switches a live model in place and keeps caller ownership', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.stack ?? error.message));
	await page.goto('/standalone.html');
	await page.locator('#owned .stanza-editor-input').focus();
	const switched = await page.evaluate(() => window.ashStandaloneIntegration.switchOwnedToCaller());
	expect(switched).toEqual({
		ownedModelDisposed: true,
		ownedModelRegistered: false,
		rootRetained: true,
		editorCount: 2,
		currentModelIsCaller: true,
	});
	await expect(page.locator('#owned .stanza-editor')).toHaveCount(1);
	await expect(page.locator('#owned .stanza-editor-input')).toBeFocused();
	await page.keyboard.press('ControlOrMeta+End');
	await page.keyboard.type('!');
	await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.getOwnedValue())).toBe('caller!');
	await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.state('caller').value)).toBe('caller!');

	expect(await page.evaluate(() => window.ashStandaloneIntegration.detachOwned())).toEqual({
		modelIsNull: true,
		value: '',
		rootMounted: true,
		inputCount: 0,
	});
	await page.evaluate(() => window.ashStandaloneIntegration.reattachOwned());
	await expect(page.locator('#owned .stanza-editor-input')).toHaveCount(1);
	await page.locator('#owned .stanza-editor-input').focus();
	await page.keyboard.press('ControlOrMeta+End');
	await page.keyboard.type('?');
	await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.state('caller').value)).toBe('caller!?');
	expect(await page.evaluate(() => window.ashStandaloneIntegration.events.length)).toBe(2);
	await page.evaluate(() => window.ashStandaloneIntegration.releaseOwned());
	expect(await page.evaluate(() => window.ashStandaloneIntegration.state('caller').disposed)).toBe(false);
	await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	expect(errors).toEqual([]);
});

test('public editor edits preserve complete UTF-16 characters and reject overlapping batches', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.stack ?? error.message));
	await page.goto('/standalone.html');
	expect((await page.evaluate(() => window.ashStandaloneIntegration.switchOwnedToCaller())).currentModelIsCaller).toBe(true);
	expect(await page.evaluate(() => window.ashStandaloneIntegration.tryOverlappingSurrogateEdits())).toEqual({
		rejected: true,
		value: 'a📚b',
		versionUnchanged: true,
	});
	await expect(page.locator('#caller .view-line')).toContainText('a📚b');
	await expect(page.locator('#owned .view-line')).toContainText('a📚b');
	expect(await page.evaluate(() => window.ashStandaloneIntegration.applySurrogateEdit())).toBe('ab');
	await expect(page.locator('#caller .view-line')).toContainText('ab');
	await expect(page.locator('#owned .view-line')).toContainText('ab');
	await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	expect(errors).toEqual([]);
});

test('same-value reset advances the shared model version and preserves existing snapshots', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.stack ?? error.message));
	await page.goto('/standalone.html');
	expect((await page.evaluate(() => window.ashStandaloneIntegration.switchOwnedToCaller())).currentModelIsCaller).toBe(true);
	const result = await page.evaluate(() => window.ashStandaloneIntegration.resetSameValue());
	expect(result).toEqual({
		beforeVersion: result.beforeVersion,
		afterVersion: result.beforeVersion + 1,
		alternativeVersion: result.beforeVersion + 1,
		snapshotValue: 'stable',
		events: [{ version: result.beforeVersion + 1, reason: 'reset', changes: 0 }],
	});
	await expect(page.locator('#caller .view-line')).toContainText('stable');
	await expect(page.locator('#owned .view-line')).toContainText('stable');
	await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	expect(errors).toEqual([]);
});

test('keyboard undo and redo restore multi-cursor selections in a shared model', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.stack ?? error.message));
	await page.goto('/standalone.html');
	expect((await page.evaluate(() => window.ashStandaloneIntegration.switchOwnedToCaller())).currentModelIsCaller).toBe(true);
	const input = page.locator('#caller .stanza-editor-input');
	const before = await page.evaluate(() => window.ashStandaloneIntegration.prepareSelectionUndo());
	expect(before.ownedSelections).toEqual(['[2,3 -> 2,3]']);
	await input.focus();
	await expect(input).toBeFocused();
	const focused = await page.evaluate(() => window.ashStandaloneIntegration.readSelectionUndo());
	expect({
		caller: focused.callerFocused,
		owned: focused.ownedFocused,
		activeInput: focused.activeInput,
	}).toEqual({ caller: true, owned: false, activeInput: 'caller' });
	const edited = await page.evaluate(() => window.ashStandaloneIntegration.applySelectionEdit());
	expect(edited.value).toBe('A\nB');
	expect(edited.callerSelections).toEqual(['[1,2 -> 1,2]', '[2,2 -> 2,2]']);
	expect(edited.ownedSelections).toHaveLength(1);
	expect({
		caller: edited.callerFocused,
		owned: edited.ownedFocused,
		activeInput: edited.activeInput,
	}).toEqual({ caller: true, owned: false, activeInput: 'caller' });

	await page.keyboard.press('ControlOrMeta+z');
	const undone = await page.evaluate(() => window.ashStandaloneIntegration.readSelectionUndo());
	expect({ value: undone.value, version: undone.version, selections: undone.callerSelections }).toEqual({
		value: 'alpha\nbeta',
		version: edited.version + 1,
		selections: ['[1,6 -> 1,1]', '[2,1 -> 2,5]'],
	});
	expect(undone.ownedSelections).toHaveLength(1);
	await expect(page.locator('#caller .view-line')).toContainText(['alpha', 'beta']);
	await expect(page.locator('#owned .view-line')).toContainText(['alpha', 'beta']);

	await page.keyboard.press('ControlOrMeta+Shift+z');
	const redone = await page.evaluate(() => window.ashStandaloneIntegration.readSelectionUndo());
	expect({ value: redone.value, version: redone.version, selections: redone.callerSelections }).toEqual({
		value: 'A\nB',
		version: undone.version + 1,
		selections: edited.callerSelections,
	});
	expect(redone.ownedSelections).toHaveLength(1);
	await expect(page.locator('#caller .view-line')).toContainText(['A', 'B']);
	await expect(page.locator('#owned .view-line')).toContainText(['A', 'B']);
	await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	expect(errors).toEqual([]);
});

test('model word lookup handles empty regular-expression matches before an emoji', async ({ page }) => {
	await page.goto('/standalone.html');
	expect(await page.evaluate(() => window.ashStandaloneIntegration.runEmptyWordPattern())).toEqual({ word: 'foo', startColumn: 4, endColumn: 7 });
});

for (const kind of ['codeAction', 'rename', 'parameterHints', 'queuedParameterHints'] as const) {
	test(`disposing the editor cancels ${kind} work`, async ({ page }) => {
		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto('/standalone.html');
		expect(await page.evaluate(kind => window.ashStandaloneIntegration.runDisposedLanguageRequest(kind), kind)).toEqual(
			kind === 'queuedParameterHints' ? { calls: 0, aborted: false } : { calls: 1, aborted: true },
		);
		expect(errors).toEqual([]);
	});
}

test.describe('parameter hints requests', () => {
	test.afterEach(async ({ page }) => {
		await page.evaluate(() => window.ashStandaloneIntegration?.dispose());
	});

	const signatures = [
		{ label: 'call(value)', parameters: [{ label: 'value' }], activeParameter: 0 },
		{ label: 'call(other)', parameters: [{ label: 'other' }], activeParameter: 0 },
		{ label: 'call(last)', parameters: [{ label: 'last' }], activeParameter: 0 },
	];

	for (const global of [false, true]) {
		test(`${global ? 'global' : 'editor'} signature commands trigger, switch and close the current result`, async ({ page }) => {
			await page.goto('/standalone.html');
			await page.evaluate(() => window.ashStandaloneIntegration.prepareParameterHints());
			// The trigger action returns when its provider finishes; dispatch without waiting for it.
			await page.evaluate(global => { void window.ashStandaloneIntegration.runParameterHintCommand('editor.action.triggerParameterHints', global); }, global);
			await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readParameterHintRequests().length)).toBe(1);
			await page.evaluate(signatures => window.ashStandaloneIntegration.finishParameterHintRequest(0, 'hints', { signatures, activeSignature: 1 }), signatures);
			const dialog = page.getByRole('dialog', { name: 'Parameter hints' });
			const active = dialog.locator('.stanza-editor-parameter-hints-signature.active');
			await expect(active).toHaveText('call(other)');
			expect(await page.evaluate(() => window.ashStandaloneIntegration.readParameterHintContext())).toEqual({ supported: true, visible: true, multiple: true });
			await page.evaluate(global => window.ashStandaloneIntegration.runParameterHintCommand('showNextParameterHint', global), global);
			await expect(active).toHaveText('call(last)');
			await page.evaluate(global => window.ashStandaloneIntegration.runParameterHintCommand('showPrevParameterHint', global), global);
			await expect(active).toHaveText('call(other)');
			await page.evaluate(global => window.ashStandaloneIntegration.runParameterHintCommand('closeParameterHints', global), global);
			await expect(dialog).toBeHidden();
			expect(await page.evaluate(() => window.ashStandaloneIntegration.readParameterHintContext())).toEqual({ supported: true, visible: false, multiple: false });
			expect(await page.evaluate(() => window.ashStandaloneIntegration.readParameterHintRequests().length)).toBe(1);
			await expect(page.locator('#caller .stanza-editor-input')).toBeFocused();
		});
	}

	for (const modifier of ['', 'Alt+']) {
		test(`${modifier || 'unmodified '}arrow keys cycle signatures without changing text, selection or hint nodes`, async ({ page }) => {
			await page.goto('/standalone.html');
			await page.evaluate(() => window.ashStandaloneIntegration.prepareParameterHints());
			await page.keyboard.press('ControlOrMeta+Shift+Space');
			await page.evaluate(signatures => window.ashStandaloneIntegration.finishParameterHintRequest(0, 'hints', { signatures }), signatures);
			const before = await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy());
			const dialog = page.getByRole('dialog', { name: 'Parameter hints' });
			const nodes = await dialog.evaluateHandle(element => [...element.children]);
			try {
				const active = dialog.locator('.stanza-editor-parameter-hints-signature.active');
				await expect(dialog).toHaveAttribute('aria-description', /Up and Down/);
				for (const [key, label] of [
					['ArrowDown', 'call(other)'], ['ArrowDown', 'call(last)'], ['ArrowDown', 'call(value)'], ['ArrowUp', 'call(last)'],
				]) {
					await page.keyboard.press(`${modifier}${key}`);
					await expect(active).toHaveText(label!);
					await expect(active).toHaveAttribute('aria-current', 'true');
					await expect(dialog.locator('[aria-current="true"]')).toHaveCount(1);
				}
				expect(await nodes.evaluate(nodes => nodes.every(node => node.isConnected))).toBe(true);
				expect(await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).toEqual(before);
				expect(await page.evaluate(() => window.ashStandaloneIntegration.readParameterHintRequests().length)).toBe(1);
				await expect(page.locator('#caller .stanza-editor-input')).toBeFocused();
				await page.keyboard.press('Shift+Escape');
				await expect(dialog).toBeHidden();
			} finally {
				await nodes.dispose();
			}
		});
	}

	for (const direction of ['previous', 'next'] as const) {
		test(`non-cycling signatures close beyond the ${direction} boundary`, async ({ page }) => {
			await page.goto('/standalone.html');
			await page.evaluate(() => window.ashStandaloneIntegration.prepareParameterHints(true, false));
			await page.keyboard.press('ControlOrMeta+Shift+Space');
			await page.evaluate(({ signatures, direction }) => window.ashStandaloneIntegration.finishParameterHintRequest(0, 'hints', {
				signatures, activeSignature: direction === 'next' ? 2 : 0,
			}), { signatures, direction });
			const before = await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy());
			await page.keyboard.press(direction === 'next' ? 'ArrowDown' : 'ArrowUp');
			await expect(page.locator('#caller .stanza-editor-parameter-hints')).toBeHidden();
			expect(await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).toEqual(before);
			expect(await page.evaluate(() => window.ashStandaloneIntegration.readParameterHintContext())).toEqual({ supported: true, visible: false, multiple: false });
		});
	}

	test('a single signature leaves normal arrow navigation available', async ({ page }) => {
		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.prepareParameterHints());
		await page.keyboard.press('ControlOrMeta+Shift+Space');
		await page.evaluate(() => window.ashStandaloneIntegration.finishParameterHintRequest(0, 'hints'));
		const before = await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy());
		await page.evaluate(() => window.ashStandaloneIntegration.runParameterHintCommand('showNextParameterHint'));
		await expect(page.getByRole('dialog', { name: 'Parameter hints' })).toBeVisible();
		await page.keyboard.press('ArrowUp');
		await expect(page.locator('#caller .stanza-editor-parameter-hints')).toBeHidden();
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).selections).not.toEqual(before.selections);
	});

	test('the close signature command cancels a request before hints are visible', async ({ page }) => {
		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.prepareParameterHints());
		await page.keyboard.press('ControlOrMeta+Shift+Space');
		await page.evaluate(() => window.ashStandaloneIntegration.runParameterHintCommand('closeParameterHints', true));
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readParameterHintRequests()))[0]!.aborted).toBe(true);
		await page.evaluate(() => window.ashStandaloneIntegration.finishParameterHintRequest(0, 'hints'));
		await expect(page.locator('#caller .stanza-editor-parameter-hints')).toBeHidden();
	});

	for (const reason of ['text', 'selection', 'language', 'provider', 'off', 'model', 'contribution', 'dispose', 'blur'] as const) {
		test(`${reason} cancels pending parameter hints and rejects late results`, async ({ page }) => {
			const errors: string[] = [];
			page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
			await page.goto('/standalone.html');
			await page.evaluate(() => window.ashStandaloneIntegration.prepareParameterHints());
			await page.keyboard.press('ControlOrMeta+Shift+Space');
			await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readParameterHintRequests().length)).toBe(1);
			await page.evaluate(reason => window.ashStandaloneIntegration.changeParameterHintsState(reason), reason);
			expect((await page.evaluate(() => window.ashStandaloneIntegration.readParameterHintRequests()))[0]!.aborted).toBe(true);
			await page.evaluate(() => window.ashStandaloneIntegration.finishParameterHintRequest(0, 'hints'));
			await expect(page.locator('#caller .stanza-editor-parameter-hints')).toBeHidden();
			if (reason === 'blur') await expect(page.locator('#owned .stanza-editor-input')).toBeFocused();
			expect(errors).toEqual([]);
		});
	}

	for (const reason of ['escape', 'selection', 'off', 'blur', 'dispose'] as const) {
		test(`${reason} cancels queued parameter hints before calling a provider`, async ({ page }) => {
			await page.goto('/standalone.html');
			await page.evaluate(() => window.ashStandaloneIntegration.prepareParameterHints());
			await page.evaluate(reason => window.ashStandaloneIntegration.queueParameterHints(reason), reason);
			// Allow both microtask and timer-based triggers to run before inspecting provider calls.
			await page.evaluate(() => new Promise<void>(resolve => setTimeout(resolve, 20)));
			expect(await page.evaluate(() => window.ashStandaloneIntegration.readParameterHintRequests())).toEqual([]);
			await expect(page.locator('#caller .stanza-editor-parameter-hints')).toBeHidden();
		});
	}

	test('Escape cancels pending parameter hints without closing a newer result', async ({ page }) => {
		const errors: string[] = [];
		page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.prepareParameterHints());
		await page.keyboard.press('ControlOrMeta+Shift+Space');
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readParameterHintRequests().length)).toBe(1);
		await page.keyboard.press('Escape');
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readParameterHintRequests()))[0]!.aborted).toBe(true);
		await page.keyboard.press('ControlOrMeta+Shift+Space');
		await page.evaluate(() => window.ashStandaloneIntegration.finishParameterHintRequest(1, 'hints'));
		await page.evaluate(() => window.ashStandaloneIntegration.finishParameterHintRequest(0, 'error'));
		await expect(page.getByRole('dialog', { name: 'Parameter hints' })).toContainText('call(value): plaintext');
		await expect(page.locator('#caller .stanza-editor-input')).toBeFocused();
		expect(errors).toEqual([]);
	});

	test('first parameter hints are positioned beside the cursor and mark the default signature', async ({ page }) => {
		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.prepareParameterHints());
		await page.keyboard.press('ControlOrMeta+Shift+Space');
		await page.evaluate(() => window.ashStandaloneIntegration.finishParameterHintRequest(0, 'hints'));
		const dialog = page.getByRole('dialog', { name: 'Parameter hints' });
		await expect(dialog).toBeVisible();
		await expect(dialog.locator('.stanza-editor-parameter-hints-signature.active')).toHaveText('call(value): plaintext');
		await expect(dialog.locator('strong')).toHaveText('value');
		const position = await dialog.evaluate(element => ({ left: parseFloat((element as HTMLElement).style.left), top: parseFloat((element as HTMLElement).style.top), live: element.getAttribute('aria-live') }));
		expect(position.left).toBeGreaterThan(8);
		expect(position.top).toBeGreaterThan(8);
		expect(position.live).toBe('polite');
		await expect(page.locator('#caller .stanza-editor-input')).toBeFocused();
	});

	test('parameter hints respect runtime disabling and enabling', async ({ page }) => {
		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.prepareParameterHints(false));
		await page.keyboard.press('ControlOrMeta+Shift+Space');
		expect(await page.evaluate(() => window.ashStandaloneIntegration.readParameterHintRequests())).toEqual([]);
		await page.evaluate(() => window.ashStandaloneIntegration.changeParameterHintsState('on'));
		await page.keyboard.press('ControlOrMeta+Shift+Space');
		await page.evaluate(() => window.ashStandaloneIntegration.finishParameterHintRequest(0, 'hints'));
		await expect(page.getByRole('dialog', { name: 'Parameter hints' })).toBeVisible();
		await page.evaluate(() => window.ashStandaloneIntegration.changeParameterHintsState('off'));
		await expect(page.locator('#caller .stanza-editor-parameter-hints')).toBeHidden();
	});

	test('quick edits coalesce into one parameter request at the final cursor', async ({ page }) => {
		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.prepareParameterHints());
		await page.evaluate(() => window.ashStandaloneIntegration.queueParameterHints('type'));
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readParameterHintRequests())).toEqual([{
			text: 'call(a,)', languageId: 'plaintext', position: '(1,8)', context: { kind: 'triggerCharacter', triggerCharacter: ',', isRetrigger: true }, aborted: false,
		}]);
		await page.evaluate(() => window.ashStandaloneIntegration.finishParameterHintRequest(0, 'hints'));
		await expect(page.getByRole('dialog', { name: 'Parameter hints' })).toBeVisible();
	});

	test('typing refreshes active parameter hints and cancels the previous request', async ({ page }) => {
		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.prepareParameterHints());
		await page.keyboard.type('(');
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readParameterHintRequests().length)).toBe(1);
		await page.keyboard.type('a');
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readParameterHintRequests().length)).toBe(2);
		const requests = await page.evaluate(() => window.ashStandaloneIntegration.readParameterHintRequests());
		expect(requests[0]!.aborted).toBe(true);
		expect(requests[1]!).toMatchObject({ position: '(1,7)', context: { kind: 'contentChange' } });
		await page.evaluate(() => window.ashStandaloneIntegration.finishParameterHintRequest(1, 'hints'));
		await page.evaluate(() => window.ashStandaloneIntegration.finishParameterHintRequest(0, 'hints'));
		await expect(page.getByRole('dialog', { name: 'Parameter hints' })).toBeVisible();
		await page.keyboard.type('b');
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readParameterHintRequests().length)).toBe(3);
		await page.evaluate(() => window.ashStandaloneIntegration.finishParameterHintRequest(2, 'empty'));
		await expect(page.locator('#caller .stanza-editor-parameter-hints')).toBeHidden();
	});

	test('background editors sharing the model do not request parameter hints', async ({ page }) => {
		await page.goto('/standalone.html');
		await page.evaluate(() => {
			window.ashStandaloneIntegration.prepareParameterHints();
			window.ashStandaloneIntegration.shareParameterHintsModel();
		});
		await page.keyboard.type('(');
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readParameterHintRequests().length)).toBe(1);
		await page.evaluate(() => window.ashStandaloneIntegration.finishParameterHintRequest(0, 'hints'));
		await expect(page.locator('#caller .stanza-editor-parameter-hints')).toBeVisible();
		await expect(page.locator('#owned .stanza-editor-parameter-hints')).toBeHidden();
	});

	test('new parameter requests use the current language', async ({ page }) => {
		await page.goto('/standalone.html');
		await page.evaluate(() => {
			window.ashStandaloneIntegration.prepareParameterHints();
			window.ashStandaloneIntegration.changeParameterHintsState('language');
		});
		await page.keyboard.press('ControlOrMeta+Shift+Space');
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readParameterHintRequests()))[0]!.languageId).toBe('typescript');
		await page.evaluate(() => window.ashStandaloneIntegration.finishParameterHintRequest(0, 'hints'));
		await expect(page.getByRole('dialog', { name: 'Parameter hints' })).toContainText('typescript');
	});

	for (const outcome of ['empty', 'error'] as const) {
		test(`${outcome} parameter result leaves no visible stale hint`, async ({ page }) => {
			await page.goto('/standalone.html');
			await page.evaluate(() => window.ashStandaloneIntegration.prepareParameterHints());
			await page.keyboard.press('ControlOrMeta+Shift+Space');
			await page.evaluate(() => window.ashStandaloneIntegration.finishParameterHintRequest(0, 'hints'));
			await expect(page.getByRole('dialog', { name: 'Parameter hints' })).toBeVisible();
			await page.keyboard.press('ControlOrMeta+Shift+Space');
			await page.evaluate(outcome => window.ashStandaloneIntegration.finishParameterHintRequest(1, outcome), outcome);
			await expect(page.locator('#caller .stanza-editor-parameter-hints')).toBeHidden();
		});
	}
});

test.describe('rename requests', () => {
	test.afterEach(async ({ page }) => {
		await page.evaluate(() => window.ashStandaloneIntegration?.dispose());
	});

	for (const phase of ['prepare', 'edit'] as const) {
		for (const reason of ['text', 'selection', 'language', 'provider', 'readonly', 'model', 'contribution', 'dispose', 'blur'] as const) {
			test(`${reason} cancels ${phase} and rejects its late rename`, async ({ page }) => {
				const errors: string[] = [];
				page.on('pageerror', error => errors.push(error.message));
				await page.goto('/standalone.html');
				await page.evaluate(phase => window.ashStandaloneIntegration.prepareRenameRequests(phase), phase);
				await page.keyboard.press('F2');
				if (phase === 'edit') {
					const input = page.getByRole('textbox', { name: 'New symbol name' });
					await input.fill('result');
					await input.press('Enter');
				}
				await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readRenameRequests().length)).toBe(1);
				await page.evaluate(reason => window.ashStandaloneIntegration.changeRenameState(reason), reason);
				await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readRenameRequests()[0]!.aborted)).toBe(true);
				await page.evaluate(() => window.ashStandaloneIntegration.finishRenameRequest(0, 'edit'));
				expect((await page.evaluate(() => window.ashStandaloneIntegration.state('caller'))).value).toBe(reason === 'text' ? 'changed' : 'value');
				await expect(page.locator('#caller .stanza-editor-rename')).toBeHidden();
				if (reason === 'blur') await expect(page.locator('#owned .stanza-editor-input')).toBeFocused();
				expect(errors).toEqual([]);
			});
		}
	}

	for (const phase of ['prepare', 'edit'] as const) {
		test(`leaving focus and completing ${phase} in the same turn cannot revive the rename`, async ({ page }) => {
			await page.goto('/standalone.html');
			await page.evaluate(phase => window.ashStandaloneIntegration.prepareRenameRequests(phase), phase);
			await page.keyboard.press('F2');
			if (phase === 'edit') {
				const input = page.getByRole('textbox', { name: 'New symbol name' });
				await input.fill('result');
				await input.press('Enter');
			}
			await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readRenameRequests().length)).toBe(1);
			await page.evaluate(async () => {
				window.ashStandaloneIntegration.changeRenameState('blur');
				await window.ashStandaloneIntegration.finishRenameRequest(0, 'edit');
			});
			await expect(page.locator('#owned .stanza-editor-input')).toBeFocused();
			await expect(page.locator('#caller .stanza-editor-rename')).toBeHidden();
			expect((await page.evaluate(() => window.ashStandaloneIntegration.state('caller'))).value).toBe('value');
		});
	}

	test('clicking the input preserves the symbol and repeated Enter submits one undoable rename', async ({ page }) => {
		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.prepareRenameRequests('edit'));
		const before = await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing());
		await page.keyboard.press('F2');
		const input = page.getByRole('textbox', { name: 'New symbol name' });
		await expect(input).toBeFocused();
		await expect(input).toHaveValue('value');
		await input.click();
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing())).selection).toBe(before.selection);
		await input.fill('result');
		await input.press('Enter');
		await input.press('Enter');
		expect(await page.evaluate(() => window.ashStandaloneIntegration.readRenameRequests())).toEqual([{
			phase: 'edit', languageId: 'plaintext', version: before.version, position: '(1,3)',
			newName: 'result', sameSnapshot: true, aborted: false,
		}]);
		await expect(page.locator('#caller .stanza-editor-rename')).toHaveAttribute('aria-busy', 'true');
		await page.evaluate(() => window.ashStandaloneIntegration.finishRenameRequest(0, 'edit'));
		expect((await page.evaluate(() => window.ashStandaloneIntegration.state('caller'))).value).toBe('result');
		await expect(page.locator('#caller .stanza-editor-rename')).toBeHidden();
		await expect(page.locator('#caller .stanza-editor-input')).toBeFocused();
		await page.keyboard.press('ControlOrMeta+z');
		expect((await page.evaluate(() => window.ashStandaloneIntegration.state('caller'))).value).toBe('value');
	});

	for (const phase of ['prepare', 'edit'] as const) {
		test(`Escape cancels ${phase} without allowing its late failure to dismiss a new session`, async ({ page }) => {
			const errors: string[] = [];
			page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
			await page.goto('/standalone.html');
			await page.evaluate(phase => window.ashStandaloneIntegration.prepareRenameRequests(phase), phase);
			await page.keyboard.press('F2');
			const input = page.getByRole('textbox', { name: 'New symbol name' });
			if (phase === 'edit') {
				await input.fill('first');
				await input.press('Enter');
			}
			await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readRenameRequests().length)).toBe(1);
			await page.keyboard.press('Escape');
			expect((await page.evaluate(() => window.ashStandaloneIntegration.readRenameRequests()))[0]!.aborted).toBe(true);
			await expect(page.locator('#caller .stanza-editor-input')).toBeFocused();
			await page.keyboard.press('F2');
			if (phase === 'prepare') {
				await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readRenameRequests().length)).toBe(2);
				await page.evaluate(() => window.ashStandaloneIntegration.finishRenameRequest(1, 'edit'));
			}
			await input.fill('second');
			await page.evaluate(() => window.ashStandaloneIntegration.finishRenameRequest(0, 'error'));
			await expect(input).toBeFocused();
			await expect(input).toHaveValue('second');
			await input.press('Enter');
			if (phase === 'edit') await page.evaluate(() => window.ashStandaloneIntegration.finishRenameRequest(1, 'edit'));
			expect((await page.evaluate(() => window.ashStandaloneIntegration.state('caller'))).value).toBe('second');
			expect(errors).toEqual([]);
		});
	}

	test('an empty name stays editable and announces validation before submission', async ({ page }) => {
		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.prepareRenameRequests('edit'));
		await page.keyboard.press('F2');
		const input = page.getByRole('textbox', { name: 'New symbol name' });
		await input.fill('   ');
		await input.press('Enter');
		await expect(input).toBeFocused();
		await expect(input).toHaveAttribute('aria-invalid', 'true');
		await expect(page.locator('#caller .stanza-editor-rename-status')).toHaveText('Name cannot be empty');
		expect(await page.evaluate(() => window.ashStandaloneIntegration.readRenameRequests())).toEqual([]);
		await input.fill('result');
		await expect(input).not.toHaveAttribute('aria-invalid');
		await input.press('Enter');
		await page.evaluate(() => window.ashStandaloneIntegration.finishRenameRequest(0, 'edit'));
		expect((await page.evaluate(() => window.ashStandaloneIntegration.state('caller'))).value).toBe('result');
	});

	for (const outcome of ['stale', 'error', 'empty'] as const) {
		test(`${outcome} rename result does not change the document`, async ({ page }) => {
			const errors: string[] = [];
			page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
			await page.goto('/standalone.html');
			await page.evaluate(() => window.ashStandaloneIntegration.prepareRenameRequests('edit'));
			await page.keyboard.press('F2');
			const input = page.getByRole('textbox', { name: 'New symbol name' });
			await input.fill('result');
			await input.press('Enter');
			await page.evaluate(outcome => window.ashStandaloneIntegration.finishRenameRequest(0, outcome), outcome);
			expect((await page.evaluate(() => window.ashStandaloneIntegration.state('caller'))).value).toBe('value');
			await expect(page.locator('#caller .stanza-editor-rename')).not.toHaveAttribute('aria-busy');
			if (outcome === 'empty') {
				await expect(input).toBeHidden();
				expect(errors).toEqual([]);
			} else {
				await expect(input).toBeEditable();
				expect(errors.some(message => message.includes(outcome === 'stale' ? 'requested document version' : 'rename request failed'))).toBe(true);
			}
		});
	}

	test('read-only editors do not start rename preparation', async ({ page }) => {
		await page.goto('/standalone.html');
		await page.evaluate(() => {
			window.ashStandaloneIntegration.prepareRenameRequests('prepare');
			window.ashStandaloneIntegration.changeRenameState('readonly');
		});
		await page.keyboard.press('F2');
		expect(await page.evaluate(() => window.ashStandaloneIntegration.readRenameRequests())).toEqual([]);
		await expect(page.locator('#caller .stanza-editor-rename')).toBeHidden();
	});

	test('new rename preparation uses the current language', async ({ page }) => {
		await page.goto('/standalone.html');
		await page.evaluate(() => {
			window.ashStandaloneIntegration.prepareRenameRequests('prepare');
			window.ashStandaloneIntegration.changeRenameState('language');
		});
		await page.keyboard.press('F2');
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readRenameRequests().map(request => request.languageId))).toEqual(['typescript']);
		await page.evaluate(() => window.ashStandaloneIntegration.finishRenameRequest(0, 'edit'));
		const input = page.getByRole('textbox', { name: 'New symbol name' });
		await input.fill('result');
		await input.press('Enter');
		expect((await page.evaluate(() => window.ashStandaloneIntegration.state('caller'))).value).toBe('result');
	});
});

test.describe('code action requests', () => {
	test.afterEach(async ({ page }) => {
		await page.evaluate(() => window.ashStandaloneIntegration?.dispose());
	});

	for (const phase of ['query', 'resolve'] as const) {
		for (const reason of ['text', 'selection', 'language', 'provider', 'readonly', 'model', 'contribution', 'dispose'] as const) {
			test(`${reason} cancels ${phase} and rejects its late edit`, async ({ page }) => {
				const errors: string[] = [];
				page.on('pageerror', error => errors.push(error.message));
				await page.goto('/standalone.html');
				await page.evaluate(phase => window.ashStandaloneIntegration.prepareCodeActionRequests(phase), phase);
				await page.keyboard.press('ControlOrMeta+.');
				if (phase === 'resolve') {
					await page.getByRole('menuitem', { name: 'Replace value' }).click();
				}
				await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readCodeActionRequests().length)).toBe(1);
				await page.evaluate(reason => window.ashStandaloneIntegration.changeCodeActionState(reason), reason);
				expect((await page.evaluate(() => window.ashStandaloneIntegration.readCodeActionRequests()))[0]!.aborted).toBe(true);
				await page.evaluate(() => window.ashStandaloneIntegration.finishCodeActionRequest(0, 'edit'));
				expect((await page.evaluate(() => window.ashStandaloneIntegration.state('caller'))).value).toBe(reason === 'text' ? 'changed' : 'value');
				await expect(page.locator('#caller .stanza-editor-code-action')).toBeHidden();
				expect(errors).toEqual([]);
			});
		}
	}

	for (const activation of ['double click', 'Enter', 'Space']) {
		test(`${activation} resolves the original action once and applies one undoable edit`, async ({ page }) => {
			await page.goto('/standalone.html');
			await page.evaluate(() => window.ashStandaloneIntegration.prepareCodeActionRequests('resolve'));
			const version = (await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing())).version;
			await page.keyboard.press('ControlOrMeta+.');
			const action = page.getByRole('menuitem', { name: 'Replace value' });
			if (activation === 'double click') {
				await action.dblclick();
			} else {
				await action.press(activation);
			}
			expect(await page.evaluate(() => window.ashStandaloneIntegration.readCodeActionRequests())).toEqual([{
				phase: 'resolve',
				languageId: 'plaintext',
				version,
				range: '[1,1 -> 1,6]',
				original: true,
				sameContext: true,
				aborted: false,
			}]);
			await expect(page.locator('#caller .stanza-editor-code-action')).toHaveAttribute('aria-busy', 'true');
			await page.evaluate(() => window.ashStandaloneIntegration.finishCodeActionRequest(0, 'edit'));
			expect((await page.evaluate(() => window.ashStandaloneIntegration.state('caller'))).value).toBe('result');
			await expect(page.locator('#caller .stanza-editor-code-action')).toBeHidden();
			await expect(page.locator('#caller .stanza-editor-input')).toBeFocused();
			await page.keyboard.press('ControlOrMeta+z');
			expect((await page.evaluate(() => window.ashStandaloneIntegration.state('caller'))).value).toBe('value');
		});
	}

	test('Escape cancels a pending query before a menu is displayed', async ({ page }) => {
		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.prepareCodeActionRequests('query'));
		await page.keyboard.press('ControlOrMeta+.');
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readCodeActionRequests().length)).toBe(1);
		await page.keyboard.press('Escape');
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readCodeActionRequests()))[0]!.aborted).toBe(true);
		await page.evaluate(() => window.ashStandaloneIntegration.finishCodeActionRequest(0, 'edit'));
		await expect(page.locator('#caller .stanza-editor-code-action')).toBeHidden();
		await expect(page.locator('#caller .stanza-editor-input')).toBeFocused();
	});

	test('Escape cancels resolution without allowing its late failure to close a new menu', async ({ page }) => {
		const errors: string[] = [];
		page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.prepareCodeActionRequests('resolve'));
		await page.keyboard.press('ControlOrMeta+.');
		await page.getByRole('menuitem', { name: 'Replace value' }).click();
		await page.keyboard.press('Escape');
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readCodeActionRequests()))[0]!.aborted).toBe(true);
		await page.keyboard.press('ControlOrMeta+.');
		const action = page.getByRole('menuitem', { name: 'Replace value' });
		await expect(action).toBeFocused();
		await page.evaluate(() => window.ashStandaloneIntegration.finishCodeActionRequest(0, 'error'));
		await expect(action).toBeFocused();
		await action.click();
		await page.evaluate(() => window.ashStandaloneIntegration.finishCodeActionRequest(1, 'edit'));
		expect((await page.evaluate(() => window.ashStandaloneIntegration.state('caller'))).value).toBe('result');
		expect(errors).toEqual([]);
	});

	for (const outcome of ['disabled', 'stale', 'error'] as const) {
		test(`${outcome} resolution does not edit the document`, async ({ page }) => {
			const errors: string[] = [];
			page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
			await page.goto('/standalone.html');
			await page.evaluate(() => window.ashStandaloneIntegration.prepareCodeActionRequests('resolve'));
			await page.keyboard.press('ControlOrMeta+.');
			await page.getByRole('menuitem', { name: 'Replace value' }).click();
			await page.evaluate(outcome => window.ashStandaloneIntegration.finishCodeActionRequest(0, outcome), outcome);
			expect((await page.evaluate(() => window.ashStandaloneIntegration.state('caller'))).value).toBe('value');
			await expect(page.locator('#caller .stanza-editor-code-action')).not.toHaveAttribute('aria-busy');
			if (outcome === 'disabled') {
				await expect(page.locator('#caller .stanza-editor-code-action')).toBeHidden();
				expect(errors).toEqual([]);
			} else {
				await expect(page.getByRole('menuitem', { name: 'Replace value' })).toBeVisible();
				expect(errors.some(message => message.includes(outcome === 'stale' ? 'requested document version' : 'code action resolve failed'))).toBe(true);
			}
		});
	}

	test('a new request uses the current model language', async ({ page }) => {
		await page.goto('/standalone.html');
		await page.evaluate(() => {
			window.ashStandaloneIntegration.prepareCodeActionRequests('query');
			window.ashStandaloneIntegration.changeCodeActionState('language');
		});
		await page.keyboard.press('ControlOrMeta+.');
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readCodeActionRequests().map(request => request.languageId))).toEqual(['typescript']);
		await page.evaluate(() => window.ashStandaloneIntegration.finishCodeActionRequest(0, 'edit'));
		await page.getByRole('menuitem', { name: 'Replace value' }).click();
		expect((await page.evaluate(() => window.ashStandaloneIntegration.state('caller'))).value).toBe('result');
	});
});

test('code action dismissal restores focus only when its menu owns focus', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.stack ?? error.message));
	await page.goto('/standalone.html');
	await page.evaluate(() => window.ashStandaloneIntegration.enableCodeActions());
	const input = page.locator('#caller .stanza-editor-input');
	const menu = page.locator('#caller .stanza-editor-code-action');
	const action = menu.getByRole('menuitem', { name: 'Example code action' });
	await input.focus();
	await page.keyboard.press('ControlOrMeta+.');
	await expect(action).toBeFocused();
	await page.keyboard.press('Escape');
	await expect(menu).toBeHidden();
	await expect(input).toBeFocused();

	await page.keyboard.press('ControlOrMeta+.');
	await expect(action).toBeFocused();
	await page.evaluate(() => window.ashStandaloneIntegration.resetSameValue());
	await expect(menu).toBeHidden();
	await expect(input).toBeFocused();
	await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	expect(errors).toEqual([]);
});

test('shared editors retain line identities through split, undo, and redo', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.stack ?? error.message));
	await page.goto('/standalone.html');
	expect((await page.evaluate(() => window.ashStandaloneIntegration.switchOwnedToCaller())).currentModelIsCaller).toBe(true);
	const initial = await page.evaluate(() => window.ashStandaloneIntegration.prepareLineIdentity());
	expect({
		value: initial.value,
		lineCount: initial.ids.length,
		longLineIndex: initial.longLineIndex,
		longLineEnd: initial.longLineEnd,
	}).toEqual({
		value: 'a\nlonger',
		lineCount: 2,
		longLineIndex: 1,
		longLineEnd: [2, 7],
	});
	const input = page.locator('#caller .stanza-editor-input');
	await input.focus();
	const split = await page.evaluate(() => window.ashStandaloneIntegration.splitLineIdentity());
	expect(split).toEqual({
		value: 'a\n\nlonger',
		version: initial.version + 1,
		ids: [initial.ids[0], split.ids[1], initial.ids[1]],
		longLineIndex: 2,
		longLineEnd: [3, 7],
	});
	expect(split.ids[1]).not.toBe(initial.ids[0]);
	expect(split.ids[1]).not.toBe(initial.ids[1]);
	await expect(page.locator('#caller .view-line')).toHaveCount(3);
	await expect(page.locator('#owned .view-line')).toHaveCount(3);

	await page.keyboard.press('ControlOrMeta+z');
	const undone = await page.evaluate(() => window.ashStandaloneIntegration.readLineIdentity());
	expect(undone).toEqual({ ...initial, version: split.version + 1 });
	await expect(page.locator('#caller .view-line')).toHaveCount(2);
	await expect(page.locator('#owned .view-line')).toHaveCount(2);

	await page.keyboard.press('ControlOrMeta+Shift+z');
	const redone = await page.evaluate(() => window.ashStandaloneIntegration.readLineIdentity());
	expect(redone).toEqual({ ...split, version: undone.version + 1 });
	await expect(page.locator('#caller .view-line')).toHaveCount(3);
	await expect(page.locator('#owned .view-line')).toHaveCount(3);
	await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	expect(errors).toEqual([]);
});

test('large standalone models keep both editors readable within the tokenization budget', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.stack ?? error.message));
	await page.goto('/standalone.html');
	const state = await page.evaluate(() => window.ashStandaloneIntegration.openLargeModel());
	expect(state).toEqual({
		textUnits: 20_500 * 1_024 + 20_499,
		lineCount: 20_500,
		tooLargeForTokenization: true,
		tooLargeForSynchronization: false,
		attachedEditors: 2,
		firstChunkPrefix: 'x'.repeat(32),
	});
	await expect(page.locator('#caller .view-line').first()).toContainText('x'.repeat(32));
	await expect(page.locator('#owned .view-line').first()).toContainText('x'.repeat(32));
	await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	expect(errors).toEqual([]);
});

test('completion snippets navigate and undo through the mounted editor', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto('/standalone.html');
	await page.evaluate(() => window.ashStandaloneIntegration.enableCompletionNavigation('${1:name}(${2:value})$0'));
	const input = page.locator('#caller .stanza-editor-input');
	await input.focus();
	await page.keyboard.press('Control+Space');
	await expect(page.locator('#caller .stanza-editor-completion-option')).toHaveCount(2);
	await page.keyboard.press('Enter');
	await expect(page.locator('#caller .view-line').first()).toContainText('conname(value)');
	await page.keyboard.type('fn');
	await page.keyboard.press('Tab');
	await page.keyboard.type('arg');
	await page.keyboard.press('Tab');
	await page.keyboard.type(';');
	await expect(page.locator('#caller .view-line').first()).toContainText('confn(arg);');
	await page.keyboard.press('Escape');
	await page.keyboard.press('ControlOrMeta+z');
	await expect(page.locator('#caller .view-line').first()).toContainText('confn(arg)');
	await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	expect(errors).toEqual([]);
});

for (const { placement, snippet, initial, expanded } of [
	{ placement: 'interleaved', snippet: '${1|a,long|} => ${1/(.*)/${1:/upcase}/} $1$0', initial: 'cona => A a', expanded: 'conlong => LONG long' },
	{ placement: 'forward', snippet: '${1/(.*)/${1:/upcase}/} ${1|a,long|}-$1$0', initial: 'conA a-a', expanded: 'conLONG long-long' },
	{ placement: 'nested forward mirror', snippet: '${2:$1-${1|a,long|}} => ${1/(.*)/${1:/upcase}/}$0', initial: 'cona-a => A', expanded: 'conlong-long => LONG' },
]) {
	test(`snippet choices keep ${placement} transforms and mirrors together through undo and redo`, async ({ page }) => {
		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto('/standalone.html');
		await page.evaluate(snippet => window.ashStandaloneIntegration.enableCompletionNavigation(snippet), snippet);
		await page.locator('#caller .stanza-editor-input').focus();
		await page.keyboard.press('Control+Space');
		await expect(page.locator('#caller .stanza-editor-completion-option')).toHaveCount(2);
		await page.keyboard.press('Enter');
		const line = page.locator('#caller .view-line').first();
		await expect(line).toContainText(initial);
		const version = await page.evaluate(() => window.ashStandaloneIntegration.getCallerVersion());
		await page.keyboard.press('Alt+ArrowDown');
		await expect(line).toContainText(expanded);
		expect(await page.evaluate(() => window.ashStandaloneIntegration.getCallerVersion())).toBe(version + 1);
		await page.keyboard.press('ControlOrMeta+z');
		await expect(line).toContainText(initial);
		await page.keyboard.press('Alt+ArrowDown');
		await expect(line).toContainText(expanded);
		await page.keyboard.press('ControlOrMeta+z');
		await expect(line).toContainText(initial);
		await page.keyboard.press('ControlOrMeta+Shift+z');
		await expect(line).toContainText(expanded);
		await page.keyboard.press('Alt+ArrowUp');
		await expect(line).toContainText(initial);
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
		expect(errors).toEqual([]);
	});
}

test('completion arrow keys select a suggestion before editor navigation', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.stack ?? error.message));
	await page.goto('/standalone.html');
	await page.evaluate(() => window.ashStandaloneIntegration.enableCompletionNavigation());
	const input = page.locator('#caller .stanza-editor-input');
	await input.focus();
	await page.keyboard.press('Control+Space');
	const options = page.locator('#caller .stanza-editor-completion-option');
	await expect(options).toHaveCount(2);
	await expect(options.nth(0)).toHaveAttribute('aria-selected', 'true');
	expect(await page.evaluate(() => window.ashStandaloneIntegration.getCallerPosition())).toEqual({ lineNumber: 1, column: 4 });

	await page.keyboard.press('ArrowDown');
	await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
	const optionId = await options.nth(1).getAttribute('id');
	expect(optionId).toBeTruthy();
	await expect(input).toHaveAttribute('aria-activedescendant', optionId!);
	expect(await page.evaluate(() => window.ashStandaloneIntegration.getCallerPosition())).toEqual({ lineNumber: 1, column: 4 });
	await page.keyboard.press('Enter');
	await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.state('caller').value)).toBe('conconsole');
	await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	expect(errors).toEqual([]);
});

test('keyboard selection, deletion, undo, and typing share one edit path', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.stack ?? error.message));
	await page.goto('/standalone.html');
	const initial = await page.evaluate(() => window.ashStandaloneIntegration.prepareKeyboardEditing());
	const input = page.locator('#caller .stanza-editor-input');
	await input.focus();
	await page.keyboard.press('Shift+ArrowDown');
	const selected = await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing());
	expect({ value: selected.value, version: selected.version, selection: selected.selection }).toEqual({
		value: 'first\nsecond',
		version: initial.version,
		selection: '[1,3 -> 2,3]',
	});

	await page.keyboard.press('Backspace');
	const deleted = await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing());
	expect({ value: deleted.value, version: deleted.version, selection: deleted.selection }).toEqual({
		value: 'ficond',
		version: initial.version + 1,
		selection: '[1,3 -> 1,3]',
	});
	await page.keyboard.press('ControlOrMeta+z');
	const undone = await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing());
	expect({ value: undone.value, version: undone.version, selection: undone.selection }).toEqual({
		value: 'first\nsecond',
		version: deleted.version + 1,
		selection: '[1,3 -> 2,3]',
	});

	await page.keyboard.press('ArrowLeft');
	await page.keyboard.press('ArrowRight');
	await page.keyboard.type('X');
	const typed = await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing());
	expect({ value: typed.value, version: typed.version, selection: typed.selection, focused: typed.focused }).toEqual({
		value: 'firXst\nsecond',
		version: undone.version + 1,
		selection: '[1,5 -> 1,5]',
		focused: true,
	});
	await expect(page.locator('#caller .view-line').first()).toContainText('firXst');
	await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	expect(errors).toEqual([]);
});

test('double-clicking editor text selects the whole word', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.stack ?? error.message));
	await page.goto('/standalone.html');
	await page.evaluate(() => window.ashStandaloneIntegration.preparePointerSelection());
	const before = await page.evaluate(() => window.ashStandaloneIntegration.readPointerSelection());
	const character = await page.evaluate(() => {
		const spans = [...document.querySelectorAll('#caller .view-line > span > span')];
		const box = spans[0]?.getBoundingClientRect();
		return { text: spans.map(span => span.textContent).join(''), box: box && { x: box.x, y: box.y, width: box.width, height: box.height } };
	});
	expect(character.text.startsWith('alpha beta')).toBe(true);
	expect(character.box).toBeTruthy();
	await page.mouse.dblclick(character.box!.x + character.box!.width / 4, character.box!.y + character.box!.height / 2);
	expect(await page.evaluate(() => window.ashStandaloneIntegration.readPointerSelection())).toEqual({
		value: 'alpha beta\nsecond line',
		version: before.version,
		selection: '[1,1 -> 1,6]',
		ownedSelection: before.ownedSelection,
		focused: true,
		mouseUpEvents: 2,
	});
	await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	expect(errors).toEqual([]);
});

test('pointer drag extends one editor selection and stops on release', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.stack ?? error.message));
	await page.goto('/standalone.html');
	expect((await page.evaluate(() => window.ashStandaloneIntegration.switchOwnedToCaller())).currentModelIsCaller).toBe(true);
	await page.evaluate(() => window.ashStandaloneIntegration.preparePointerSelection());
	const before = await page.evaluate(() => window.ashStandaloneIntegration.readPointerSelection());
	const lines = await page.evaluate(() => [...document.querySelectorAll('#caller .view-line > span > span')].map(span => {
		const box = span.getBoundingClientRect();
		return { text: span.textContent, x: box.x, y: box.y, width: box.width, height: box.height };
	}));
	expect(lines.map(line => line.text)).toEqual(['alpha beta', 'second line']);
	await page.mouse.move(lines[0]!.x + lines[0]!.width * 0.3, lines[0]!.y + lines[0]!.height / 2);
	await page.mouse.down();
	await page.mouse.move(lines[1]!.x + lines[1]!.width * 0.7, lines[1]!.y + lines[1]!.height / 2, { steps: 5 });
	await page.mouse.up();
	const selected = await page.evaluate(() => window.ashStandaloneIntegration.readPointerSelection());
	expect(selected.selection).toMatch(/^\[1,\d+ -> 2,\d+\]$/u);
	expect({ value: selected.value, version: selected.version, ownedSelection: selected.ownedSelection, focused: selected.focused, mouseUpEvents: selected.mouseUpEvents }).toEqual({
		value: before.value,
		version: before.version,
		ownedSelection: before.ownedSelection,
		focused: true,
		mouseUpEvents: 1,
	});
	await page.mouse.move(lines[0]!.x + lines[0]!.width * 0.8, lines[0]!.y + lines[0]!.height / 2);
	const released = await page.evaluate(() => window.ashStandaloneIntegration.readPointerSelection());
	expect({ selection: released.selection, mouseUpEvents: released.mouseUpEvents }).toEqual({ selection: selected.selection, mouseUpEvents: 1 });
	await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	expect(errors).toEqual([]);
});

test('Alt-click toggles editor-local cursors and one typing transaction edits both lines', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.stack ?? error.message));
	await page.goto('/standalone.html');
	expect((await page.evaluate(() => window.ashStandaloneIntegration.switchOwnedToCaller())).currentModelIsCaller).toBe(true);
	await page.evaluate(() => window.ashStandaloneIntegration.prepareMultiCursor());
	const lines = await page.evaluate(() => [...document.querySelectorAll('#caller .view-line > span > span')].map(span => {
		const box = span.getBoundingClientRect();
		return { text: span.textContent, x: box.x, y: box.y, width: box.width, height: box.height };
	}));
	expect(lines.map(line => line.text)).toEqual(['abcd', 'efgh']);
	const first = { x: lines[0]!.x + lines[0]!.width * 0.4, y: lines[0]!.y + lines[0]!.height / 2 };
	const second = { x: lines[1]!.x + lines[1]!.width * 0.4, y: lines[1]!.y + lines[1]!.height / 2 };
	await page.mouse.click(first.x, first.y);
	const initial = await page.evaluate(() => window.ashStandaloneIntegration.readMultiCursor());
	await page.keyboard.down('Alt');
	await page.mouse.click(second.x, second.y);
	await page.keyboard.up('Alt');
	const added = await page.evaluate(() => window.ashStandaloneIntegration.readMultiCursor());
	expect(added.selections).toHaveLength(2);
	expect(added.selections.map(selection => Number(selection.match(/^\[(\d+),/u)?.[1])).sort()).toEqual([1, 2]);
	expect({ value: added.value, version: added.version, ownedSelections: added.ownedSelections }).toEqual({
		value: initial.value,
		version: initial.version,
		ownedSelections: initial.ownedSelections,
	});

	await page.keyboard.down('Alt');
	await page.mouse.click(second.x, second.y);
	await page.keyboard.up('Alt');
	const removed = await page.evaluate(() => window.ashStandaloneIntegration.readMultiCursor());
	expect(removed.selections).toHaveLength(1);
	expect(removed.selections[0]).toMatch(/^\[1,/u);
	await page.keyboard.down('Alt');
	await page.mouse.click(second.x, second.y);
	await page.keyboard.up('Alt');
	await page.keyboard.type('X');
	const typed = await page.evaluate(() => window.ashStandaloneIntegration.readMultiCursor());
	expect(typed.value.split('\n').map(line => (line.match(/X/gu) ?? []).length)).toEqual([1, 1]);
	expect(typed.version).toBe(initial.version + 1);
	expect(typed.ownedSelections).toHaveLength(1);
	await page.keyboard.press('ControlOrMeta+z');
	const undone = await page.evaluate(() => window.ashStandaloneIntegration.readMultiCursor());
	expect(undone.value).toBe('abcd\nefgh');
	expect(undone.version).toBe(typed.version + 1);
	await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	expect(errors).toEqual([]);
});

for (const inputKind of ['EditContext', 'textarea'] as const) {
	test(`${inputKind} commits one Enter edit and restores its selection on undo`, async ({ page }) => {
		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.stack ?? error.message));
		if (inputKind === 'textarea') {
			await page.addInitScript(() => { Reflect.deleteProperty(window, 'EditContext'); });
		}
		await page.goto('/standalone.html');
		const initial = await page.evaluate(() => window.ashStandaloneIntegration.prepareKeyboardEditing());
		const input = page.locator('#caller .stanza-editor-input');
		expect(await input.evaluate(element => element.tagName)).toBe(inputKind === 'textarea' ? 'TEXTAREA' : 'DIV');
		await input.focus();
		await page.keyboard.press('Enter');
		const entered = await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing());
		expect({ value: entered.value, version: entered.version, selection: entered.selection, focused: entered.focused }).toEqual({
			value: 'fi\nrst\nsecond',
			version: initial.version + 1,
			selection: '[2,1 -> 2,1]',
			focused: true,
		});
		await page.keyboard.press('ControlOrMeta+z');
		const undone = await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing());
		expect({ value: undone.value, version: undone.version, selection: undone.selection }).toEqual({
			value: initial.value,
			version: entered.version + 1,
			selection: '[1,3 -> 1,3]',
		});
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
		expect(errors).toEqual([]);
	});

	test(`${inputKind} ignores input delivered after focus leaves the editor`, async ({ page }) => {
		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.stack ?? error.message));
		if (inputKind === 'textarea') {
			await page.addInitScript(() => { Reflect.deleteProperty(window, 'EditContext'); });
		}
		await page.goto('/standalone.html');
		const caller = page.locator('#caller .stanza-editor-input');
		const owned = page.locator('#owned .stanza-editor-input');
		await caller.focus();
		await page.keyboard.type('X');
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.state('caller').value)).toBe('Xcaller');
		await owned.focus();
		await expect(owned).toBeFocused();
		const before = await page.evaluate(() => ({
			value: window.ashStandaloneIntegration.state('caller').value,
			version: window.ashStandaloneIntegration.getCallerVersion(),
		}));
		await page.evaluate(kind => {
			const input = document.querySelector<HTMLElement>('#caller .stanza-editor-input');
			if (!input) throw new Error('Caller input is unavailable');
			if (kind === 'textarea') {
				input.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: 'X' }));
				return;
			}
			const context = (input as HTMLElement & { editContext?: EventTarget }).editContext;
			if (!context) throw new Error('Browser EditContext is unavailable');
			context.dispatchEvent(Object.assign(new Event('textupdate'), {
				text: 'X', updateRangeStart: 0, updateRangeEnd: 0, selectionStart: 1, selectionEnd: 1,
			}));
		}, inputKind);
		await caller.evaluate(input => {
			input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'z', ctrlKey: true }));
		});
		expect(await page.evaluate(() => ({
			value: window.ashStandaloneIntegration.state('caller').value,
			version: window.ashStandaloneIntegration.getCallerVersion(),
		}))).toEqual(before);
		await expect(owned).toBeFocused();
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
		expect(errors).toEqual([]);
	});

	test(`${inputKind} commits revised IME text as one undo step`, async ({ page }) => {
		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.stack ?? error.message));
		if (inputKind === 'textarea') {
			await page.addInitScript(() => { Reflect.deleteProperty(window, 'EditContext'); });
		}
		await page.goto('/standalone.html');
		const initial = await page.evaluate(() => window.ashStandaloneIntegration.prepareKeyboardEditing());
		const caller = page.locator('#caller .stanza-editor-input');
		await caller.focus();
		await page.evaluate(kind => {
			const input = document.querySelector<HTMLElement>('#caller .stanza-editor-input');
			if (!input) throw new Error('Caller input is unavailable');
			const target = kind === 'textarea' ? input : (input as HTMLElement & { editContext?: EventTarget }).editContext;
			if (!target) throw new Error('Composition target is unavailable');
			target.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
			if (kind === 'textarea') {
				const textArea = input as HTMLTextAreaElement;
				textArea.value = '你';
				textArea.setSelectionRange(1, 1);
				target.dispatchEvent(new CompositionEvent('compositionupdate', { data: '你' }));
				textArea.value = '你好';
				textArea.setSelectionRange(2, 2);
				target.dispatchEvent(new CompositionEvent('compositionupdate', { data: '你好' }));
			} else {
				target.dispatchEvent(Object.assign(new Event('textupdate'), {
					text: '你',
					updateRangeStart: 2,
					updateRangeEnd: 2,
					selectionStart: 3,
					selectionEnd: 3,
				}));
				target.dispatchEvent(Object.assign(new Event('textupdate'), {
					text: '你好',
					updateRangeStart: 2,
					updateRangeEnd: 3,
					selectionStart: 4,
					selectionEnd: 4,
				}));
			}
			target.dispatchEvent(new CompositionEvent('compositionend', { data: '你好' }));
		}, inputKind);
		const committed = await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing());
		expect(committed).toEqual({
			value: 'fi你好rst\nsecond',
			version: initial.version + 2,
			selection: '[1,5 -> 1,5]',
			focused: true,
		});
		await expect(page.locator('#caller .stanza-editor')).not.toHaveClass(/\bcomposing\b/u);
		await page.keyboard.press('ControlOrMeta+z');
		expect(await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing())).toEqual({
			...initial,
			version: committed.version + 1,
			focused: true,
		});
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
		expect(errors).toEqual([]);
	});

	test(`${inputKind} cancels IME text with Escape without leaving an undo step`, async ({ page }) => {
		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.stack ?? error.message));
		if (inputKind === 'textarea') {
			await page.addInitScript(() => { Reflect.deleteProperty(window, 'EditContext'); });
		}
		await page.goto('/standalone.html');
		const initial = await page.evaluate(() => window.ashStandaloneIntegration.prepareKeyboardEditing());
		const caller = page.locator('#caller .stanza-editor-input');
		await caller.focus();
		await page.evaluate(kind => {
			const input = document.querySelector<HTMLElement>('#caller .stanza-editor-input');
			if (!input) throw new Error('Caller input is unavailable');
			const target = kind === 'textarea' ? input : (input as HTMLElement & { editContext?: EventTarget }).editContext;
			if (!target) throw new Error('Composition target is unavailable');
			target.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
			if (kind === 'textarea') {
				const textArea = input as HTMLTextAreaElement;
				textArea.value = '你';
				textArea.setSelectionRange(1, 1);
				target.dispatchEvent(new CompositionEvent('compositionupdate', { data: '你' }));
			} else {
				target.dispatchEvent(Object.assign(new Event('textupdate'), {
					text: '你',
					updateRangeStart: 2,
					updateRangeEnd: 2,
					selectionStart: 3,
					selectionEnd: 3,
				}));
			}
			input.dispatchEvent(new KeyboardEvent('keydown', {
				bubbles: true,
				cancelable: true,
				isComposing: true,
				key: 'Escape',
			}));
			target.dispatchEvent(new CompositionEvent('compositionend', { data: '' }));
		}, inputKind);
		const canceled = await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing());
		expect(canceled).toEqual({
			value: initial.value,
			version: initial.version + 2,
			selection: initial.selection,
			focused: true,
		});
		await expect(page.locator('#caller .stanza-editor')).not.toHaveClass(/\bcomposing\b/u);
		await page.keyboard.type('X');
		const typed = await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing());
		expect(typed.value).toBe('fiXrst\nsecond');
		await page.keyboard.press('ControlOrMeta+z');
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing())).value).toBe(initial.value);
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
		expect(errors).toEqual([]);
	});

	test(`${inputKind} cancels provisional IME text on blur and rejects late composition`, async ({ page }) => {
		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.stack ?? error.message));
		if (inputKind === 'textarea') {
			await page.addInitScript(() => { Reflect.deleteProperty(window, 'EditContext'); });
		}
		await page.goto('/standalone.html');
		const initial = await page.evaluate(() => window.ashStandaloneIntegration.prepareKeyboardEditing());
		const caller = page.locator('#caller .stanza-editor-input');
		const owned = page.locator('#owned .stanza-editor-input');
		await caller.focus();
		await page.evaluate(kind => {
			const input = document.querySelector<HTMLElement>('#caller .stanza-editor-input');
			if (!input) throw new Error('Caller input is unavailable');
			const target = kind === 'textarea' ? input : (input as HTMLElement & { editContext?: EventTarget }).editContext;
			if (!target) throw new Error('Composition target is unavailable');
			target.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
			if (kind === 'textarea') {
				const textArea = input as HTMLTextAreaElement;
				textArea.value = '你';
				textArea.setSelectionRange(1, 1);
				target.dispatchEvent(new CompositionEvent('compositionupdate', { data: '你' }));
			} else {
				target.dispatchEvent(Object.assign(new Event('textupdate'), {
					text: '你',
					updateRangeStart: 2,
					updateRangeEnd: 2,
					selectionStart: 3,
					selectionEnd: 3,
				}));
			}
		}, inputKind);
		const provisional = await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing());
		expect({ value: provisional.value, version: provisional.version, selection: provisional.selection }).toEqual({
			value: 'fi你rst\nsecond',
			version: initial.version + 1,
			selection: '[1,4 -> 1,4]',
		});
		await expect(page.locator('#caller .stanza-editor')).toHaveClass(/\bcomposing\b/u);

		await owned.focus();
		await expect(owned).toBeFocused();
		const canceled = await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing());
		expect({ value: canceled.value, version: canceled.version, selection: canceled.selection, focused: canceled.focused }).toEqual({
			value: initial.value,
			version: provisional.version + 1,
			selection: initial.selection,
			focused: false,
		});
		await expect(page.locator('#caller .stanza-editor')).not.toHaveClass(/\bcomposing\b/u);
		const lateStart = await page.evaluate(kind => {
			const input = document.querySelector<HTMLElement>('#caller .stanza-editor-input');
			if (!input) throw new Error('Caller input is unavailable');
			const target = kind === 'textarea' ? input : (input as HTMLElement & { editContext?: EventTarget }).editContext;
			if (!target) throw new Error('Composition target is unavailable');
			target.dispatchEvent(new CompositionEvent('compositionend', { data: '你' }));
			target.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
			return document.querySelector('#caller .stanza-editor')?.classList.contains('composing');
		}, inputKind);
		expect(lateStart).toBe(false);
		await page.evaluate(kind => {
			const input = document.querySelector<HTMLElement>('#caller .stanza-editor-input');
			if (!input) throw new Error('Caller input is unavailable');
			const target = kind === 'textarea' ? input : (input as HTMLElement & { editContext?: EventTarget }).editContext;
			if (!target) throw new Error('Composition target is unavailable');
			if (kind === 'textarea') {
				const textArea = input as HTMLTextAreaElement;
				textArea.value = '迟';
				textArea.setSelectionRange(1, 1);
				target.dispatchEvent(new CompositionEvent('compositionupdate', { data: '迟' }));
			} else {
				target.dispatchEvent(Object.assign(new Event('textupdate'), {
					text: '迟',
					updateRangeStart: 2,
					updateRangeEnd: 2,
					selectionStart: 3,
					selectionEnd: 3,
				}));
			}
			target.dispatchEvent(new CompositionEvent('compositionend', { data: '迟' }));
		}, inputKind);
		await expect(owned).toBeFocused();
		expect(await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing())).toEqual(canceled);
		await expect(page.locator('#caller .stanza-editor')).not.toHaveClass(/\bcomposing\b/u);
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
		expect(errors).toEqual([]);
	});

	for (const mode of ['full', 'partial', 'line', 'multi', 'disabled', 'missingColors'] as const) {
		test(`${inputKind} rich clipboard copy preserves ${mode} content and token styles`, async ({ page }) => {
			if (inputKind === 'textarea') {
				await page.addInitScript(() => { Reflect.deleteProperty(window, 'EditContext'); });
			}
			await page.goto('/standalone.html');
			await page.evaluate(mode => {
				const ranges: Record<typeof mode, [number, number, number, number][]> = {
					full: [[1, 1, 2, 9]], partial: [[1, 3, 1, 5]], line: [[1, 3, 1, 3]],
					multi: [[1, 3, 1, 5], [2, 2, 2, 5]], disabled: [[1, 1, 2, 9]], missingColors: [[1, 1, 2, 9]],
				};
				window.ashStandaloneIntegration.prepareClipboard('const <x>&\n\t"value"', ranges[mode]);
				window.ashStandaloneIntegration.configureClipboardTokens(mode !== 'disabled', mode !== 'missingColors');
			}, mode);
			const input = page.locator('#caller .stanza-editor-input');
			await input.focus();
			const copied = await input.evaluate(input => {
				const clipboardData = new DataTransfer();
				input.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData }));
				const html = clipboardData.getData('text/html');
				const content = new DOMParser().parseFromString(html, 'text/html');
				return {
					text: clipboardData.getData('text/plain'), html, richText: content.querySelector('code')?.textContent,
					injected: content.querySelector('x, script') !== null,
					styles: [...content.querySelectorAll('span')].map(span => ({ text: span.textContent, color: span.style.color, weight: span.style.fontWeight, italic: span.style.fontStyle, decoration: span.style.textDecoration })),
				};
			});
			const expected = { full: 'const <x>&\n\t"value"', partial: 'ns', line: 'const <x>&\n', multi: 'ns\n"va', disabled: 'const <x>&\n\t"value"', missingColors: 'const <x>&\n\t"value"' }[mode];
			expect(copied.text).toBe(expected);
			if (mode === 'disabled') {
				expect(copied.html).toBe('');
			} else {
				expect(copied.richText).toBe(expected);
				expect(copied.injected).toBe(false);
				expect(copied.styles[0]).toMatchObject({ color: mode === 'missingColors' ? '' : 'rgb(18, 52, 86)', weight: 'bold', italic: 'italic' });
				if (mode === 'full' || mode === 'multi' || mode === 'missingColors') {
					expect(copied.styles.at(-1)).toMatchObject({ color: mode === 'missingColors' ? '' : 'rgb(101, 67, 33)', decoration: 'underline' });
				}
			}
		});
	}

	test(`${inputKind} explicit rich copy writes HTML even when default highlighting is disabled`, async ({ page, context }) => {
		await context.grantPermissions(['clipboard-read', 'clipboard-write']);
		if (inputKind === 'textarea') {
			await page.addInitScript(() => { Reflect.deleteProperty(window, 'EditContext'); });
		}
		await page.goto('/standalone.html');
		await page.evaluate(() => {
			window.ashStandaloneIntegration.prepareClipboard('const <x>&\n\t"value"', [[1, 1, 1, 6]]);
			window.ashStandaloneIntegration.configureClipboardTokens(false);
		});
		await page.locator('#caller .stanza-editor-input').focus();
		await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.action.clipboardCopyWithSyntaxHighlightingAction'));
		const copied = await page.evaluate(async () => {
			const items = await navigator.clipboard.read();
			const item = items.find(item => item.types.includes('text/html'));
			if (!item) return null;
			const html = await (await item.getType('text/html')).text();
			const content = new DOMParser().parseFromString(html, 'text/html');
			const token = content.querySelector('span');
			return { text: content.querySelector('code')?.textContent, color: token?.style.color, weight: token?.style.fontWeight };
		});
		expect(copied).toEqual({ text: 'const', color: 'rgb(18, 52, 86)', weight: 'bold' });
		await page.keyboard.press('ControlOrMeta+c');
		expect(await page.evaluate(async () => {
			const items = await navigator.clipboard.read();
			return { text: await navigator.clipboard.readText(), hasHtml: items.some(item => item.types.includes('text/html')) };
		})).toEqual({ text: 'const', hasHtml: false });
	});

	for (const scenario of [
		{ name: 'consecutive breaks', html: '<div>one<br><br><br>two</div>', text: 'one\n\n\ntwo' },
		{ name: 'boundary breaks', html: '<br>one<br>', text: '\none\n' },
		{ name: 'code whitespace', html: '<pre><code>\n  one\n\n\n\ttwo\n</code></pre>', text: '\n  one\n\n\n\ttwo\n' },
		{ name: 'adjacent code blocks', html: '<pre>one</pre><pre>two</pre>', text: 'one\ntwo' },
		{ name: 'nested blocks', html: '<div><div>one</div><div>two</div></div>', text: 'one\ntwo' },
	]) {
		test(`${inputKind} HTML clipboard preserves ${scenario.name}`, async ({ page }) => {
			if (inputKind === 'textarea') {
				await page.addInitScript(() => { Reflect.deleteProperty(window, 'EditContext'); });
			}
			await page.goto('/standalone.html');
			await page.evaluate(() => window.ashStandaloneIntegration.prepareBrackets('alpha', [6]));
			const input = page.locator('#caller .stanza-editor-input');
			await input.focus();
			await input.evaluate((input, html) => {
				const clipboardData = new DataTransfer();
				clipboardData.setData('text/html', html);
				input.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
			}, scenario.html);
			expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).value).toBe('alpha' + scenario.text);
			await page.keyboard.press('ControlOrMeta+z');
			expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).value).toBe('alpha');
		});
	}

	for (const mode of ['html', 'plain', 'readonly'] as const) {
		test(`${inputKind} HTML clipboard paste respects ${mode} and remains undoable`, async ({ page }) => {
			if (inputKind === 'textarea') {
				await page.addInitScript(() => { Reflect.deleteProperty(window, 'EditContext'); });
			}
			await page.goto('/standalone.html');
			await page.evaluate(mode => window.ashStandaloneIntegration.prepareBrackets('alpha', [6], mode === 'readonly'), mode);
			const input = page.locator('#caller .stanza-editor-input');
			await input.focus();
			await input.evaluate((input, mode) => {
				const clipboardData = new DataTransfer();
				clipboardData.setData('text/html', '<div>&lt;x&gt; &amp; one</div><div>two<br>three</div><script>window.clipboardScriptRan = true</script>');
				if (mode === 'plain') clipboardData.setData('text/plain', ' plain');
				input.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
			}, mode);
			const expected = { html: 'alpha<x> & one\ntwo\nthree', plain: 'alpha plain', readonly: 'alpha' }[mode];
			expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).value).toBe(expected);
			expect(await page.evaluate(() => Reflect.get(window, 'clipboardScriptRan'))).toBeUndefined();
			if (mode !== 'readonly') {
				await page.keyboard.press('ControlOrMeta+z');
				expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).value).toBe('alpha');
			}
		});
	}

	for (const mode of ['selections', 'externalLines', 'line', 'emptyDisabled'] as const) {
		test(`${inputKind} clipboard preserves ${mode} behavior through the production input`, async ({ page }) => {
			if (inputKind === 'textarea') {
				await page.addInitScript(() => { Reflect.deleteProperty(window, 'EditContext'); });
			}
			await page.goto('/standalone.html');
			await page.evaluate(mode => {
				if (mode === 'selections') {
					window.ashStandaloneIntegration.prepareClipboard('a b', [[1, 1, 1, 2], [1, 3, 1, 4]]);
				} else if (mode === 'externalLines') {
					window.ashStandaloneIntegration.prepareClipboard('a b', [[1, 1, 1, 1], [1, 3, 1, 3]]);
				} else {
					window.ashStandaloneIntegration.prepareClipboard('alpha\nbeta', [[1, 3, 1, 3]], mode === 'line');
				}
			}, mode);
			const input = page.locator('#caller .stanza-editor-input');
			await input.focus();
			const result = await input.evaluate((input, mode) => {
				const data = new DataTransfer();
				if (mode === 'externalLines') {
					data.setData('text/plain', 'X\r\nY');
					data.setData('vscode-editor-data', '{invalid metadata');
				} else {
					input.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: data }));
				}
				const text = data.getData('text/plain');
				const metadata = data.getData('vscode-editor-data');
				if (mode === 'emptyDisabled') {
					input.dispatchEvent(new ClipboardEvent('cut', { bubbles: true, cancelable: true, clipboardData: new DataTransfer() }));
				} else {
					if (mode === 'selections') {
						window.ashStandaloneIntegration.prepareClipboard('x y', [[1, 1, 1, 2], [1, 3, 1, 4]]);
					}
					input.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
				}
				return { text, metadata, state: window.ashStandaloneIntegration.readLineCopy() };
			}, mode);
			if (mode === 'selections') {
				expect(result.text).toBe('a\nb');
				expect(JSON.parse(result.metadata)).toMatchObject({ isFromEmptySelection: false, multicursorText: ['a', 'b'] });
				expect(result.state.value).toBe('a b');
			} else if (mode === 'externalLines') {
				expect(result.state.value).toBe('Xa Yb');
			} else if (mode === 'line') {
				expect(result.text).toBe('alpha\n');
				expect(JSON.parse(result.metadata)).toMatchObject({ isFromEmptySelection: true });
				expect(result.state).toEqual({ value: 'alpha\nalpha\nbeta', selections: ['[2,3 -> 2,3]'] });
			} else {
				expect(result.text).toBe('');
				expect(result.state).toEqual({ value: 'alpha\nbeta', selections: ['[1,3 -> 1,3]'] });
			}
			if (mode !== 'emptyDisabled') {
				await page.keyboard.press('ControlOrMeta+z');
				const expected = { selections: 'x y', externalLines: 'a b', line: 'alpha\nbeta' }[mode];
				expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).value).toBe(expected);
			}
		});
	}

	test(`${inputKind} copies, cuts, pastes and undoes through its clipboard events`, async ({ page }) => {
		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.stack ?? error.message));
		if (inputKind === 'textarea') {
			await page.addInitScript(() => { Reflect.deleteProperty(window, 'EditContext'); });
		}
		await page.goto('/standalone.html');
		const initial = await page.evaluate(() => window.ashStandaloneIntegration.prepareClipboard());
		const caller = page.locator('#caller .stanza-editor-input');
		await caller.focus();
		const copied = await caller.evaluate(input => {
			const clipboardData = new DataTransfer();
			const event = new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData });
			input.dispatchEvent(event);
			return {
				prevented: event.defaultPrevented,
				text: clipboardData.getData('text/plain'),
				metadata: clipboardData.getData('vscode-editor-data'),
			};
		});
		expect({ prevented: copied.prevented, text: copied.text }).toEqual({ prevented: true, text: 'alpha' });
		expect(JSON.parse(copied.metadata)).toMatchObject({ version: 1, isFromEmptySelection: false });
		const cutPrevented = await caller.evaluate(input => {
			const event = new ClipboardEvent('cut', { bubbles: true, cancelable: true, clipboardData: new DataTransfer() });
			input.dispatchEvent(event);
			return event.defaultPrevented;
		});
		expect(cutPrevented).toBe(true);
		const cut = await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing());
		expect({ value: cut.value, version: cut.version, selection: cut.selection }).toEqual({
			value: ' beta',
			version: initial.version + 1,
			selection: '[1,1 -> 1,1]',
		});
		await page.keyboard.press('ControlOrMeta+z');
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing())).value).toBe(initial.value);
		await page.keyboard.press('ArrowRight');
		const pastePrevented = await caller.evaluate((input, data) => {
			const clipboardData = new DataTransfer();
			clipboardData.setData('text/plain', data.text);
			clipboardData.setData('vscode-editor-data', data.metadata);
			const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData });
			input.dispatchEvent(event);
			return event.defaultPrevented;
		}, copied);
		expect(pastePrevented).toBe(true);
		const pasted = await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing());
		expect({ value: pasted.value, version: pasted.version, selection: pasted.selection }).toEqual({
			value: 'alphaalpha beta',
			version: cut.version + 2,
			selection: '[1,11 -> 1,11]',
		});
		await page.keyboard.press('ControlOrMeta+z');
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing())).value).toBe(initial.value);
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
		expect(errors).toEqual([]);
	});

	test(`${inputKind} ignores clipboard events delivered after focus leaves the editor`, async ({ page }) => {
		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.stack ?? error.message));
		if (inputKind === 'textarea') {
			await page.addInitScript(() => { Reflect.deleteProperty(window, 'EditContext'); });
		}
		await page.goto('/standalone.html');
		const initial = await page.evaluate(() => window.ashStandaloneIntegration.prepareClipboard());
		const caller = page.locator('#caller .stanza-editor-input');
		const owned = page.locator('#owned .stanza-editor-input');
		await caller.focus();
		await owned.focus();
		const late = await caller.evaluate(input => {
			const copyData = new DataTransfer();
			input.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: copyData }));
			const cut = new ClipboardEvent('cut', { bubbles: true, cancelable: true, clipboardData: new DataTransfer() });
			input.dispatchEvent(cut);
			const pasteData = new DataTransfer();
			pasteData.setData('text/plain', 'X');
			const paste = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: pasteData });
			input.dispatchEvent(paste);
			return { copiedText: copyData.getData('text/plain'), cutPrevented: cut.defaultPrevented, pastePrevented: paste.defaultPrevented };
		});
		expect(late).toEqual({ copiedText: '', cutPrevented: true, pastePrevented: true });
		expect(await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing())).toEqual(initial);
		await expect(owned).toBeFocused();
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
		expect(errors).toEqual([]);
	});

	test(`${inputKind} uses the browser clipboard for keyboard copy, cut and paste`, async ({ page, context }) => {
		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.stack ?? error.message));
		await context.grantPermissions(['clipboard-read', 'clipboard-write']);
		if (inputKind === 'textarea') {
			await page.addInitScript(() => { Reflect.deleteProperty(window, 'EditContext'); });
		}
		await page.goto('/standalone.html');
		const initial = await page.evaluate(() => window.ashStandaloneIntegration.prepareClipboard());
		const caller = page.locator('#caller .stanza-editor-input');
		await caller.focus();
		await page.keyboard.press('ControlOrMeta+c');
		expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('alpha');
		await page.keyboard.press('ControlOrMeta+x');
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing().value)).toBe(' beta');
		await page.keyboard.press('ControlOrMeta+z');
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing())).value).toBe(initial.value);
		await page.keyboard.press('ArrowRight');
		await page.keyboard.press('ControlOrMeta+v');
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing().value)).toBe('alphaalpha beta');
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
		expect(errors).toEqual([]);
	});
}

test('soft wrapping keeps layout, model coordinates and pointer selection in sync after resize and edit', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.stack ?? error.message));
	await page.goto('/standalone.html');
	const initial = await page.evaluate(() => window.ashStandaloneIntegration.prepareWrappedLayout());
	expect(initial.modelLineCount).toBe(1);
	expect(initial.contentHeight).toBeGreaterThan(80);
	const rows = page.locator('#caller .view-line');
	const initialRows = await rows.count();
	expect(initialRows).toBeGreaterThan(1);
	const firstText = (await rows.first().textContent()) ?? '';
	const second = await rows.nth(1).boundingBox();
	expect(second).not.toBeNull();
	await page.mouse.click(second!.x + 8, second!.y + second!.height / 2);
	const selected = await page.evaluate(() => window.ashStandaloneIntegration.getCallerPosition());
	expect(selected?.lineNumber).toBe(1);
	expect(selected?.column).toBeGreaterThan(firstText.length);
	expect(await page.evaluate(() => window.ashStandaloneIntegration.readWrappedLayout())).toEqual(initial);

	const wider = await page.evaluate(() => window.ashStandaloneIntegration.resizeWrappedLayout(320));
	expect({ value: wider.value, version: wider.version, modelLineCount: wider.modelLineCount }).toEqual({
		value: initial.value,
		version: initial.version,
		modelLineCount: 1,
	});
	expect(wider.contentHeight).toBeLessThan(initial.contentHeight);
	await expect.poll(() => rows.count()).toBeLessThan(initialRows);
	expect(await page.evaluate(() => window.ashStandaloneIntegration.getCallerPosition())).toEqual(selected);

	const short = await page.evaluate(() => window.ashStandaloneIntegration.editWrappedText('short'));
	expect(short).toEqual({ value: 'short', version: initial.version + 1, modelLineCount: 1, contentHeight: 80 });
	await expect(rows).toHaveCount(1);
	await expect(rows.first()).toContainText('short');
	await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	expect(errors).toEqual([]);
});

test('proportional-font soft wrapping keeps a word together at the available width', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.stack ?? error.message));
	await page.goto('/standalone.html');
	const state = await page.evaluate(() => window.ashStandaloneIntegration.prepareProportionalWrap());
	expect({ value: state.value, modelLineCount: state.modelLineCount }).toEqual({ value: 'abc defgh', modelLineCount: 1 });
	const rows = page.locator('#caller .view-line');
	await expect(rows).toHaveCount(2);
	expect(await rows.allTextContents()).toEqual(['abc ', 'defgh']);
	await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	expect(errors).toEqual([]);
});

test('scrolling keeps overlapping visible rows attached and releases rows that leave the viewport', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.stack ?? error.message));
	await page.goto('/standalone.html');
	const initial = await page.evaluate(() => window.ashStandaloneIntegration.prepareVisibleRows());
	expect(initial.lineCount).toBe(80);
	const result = await page.evaluate(async () => {
		const layers = [...document.querySelectorAll<HTMLElement>('#caller .view-lines, #caller .stanza-editor-row-layer.view-overlays')];
		const tracked = layers.map(layer => {
			const before = new Map<number, HTMLElement>();
			for (const child of layer.children) {
				const row = child as HTMLElement;
				before.set(Number(row.dataset.lineIndex), row);
			}
			const removed = new Set<Node>();
			const observer = new MutationObserver(records => {
				for (const record of records) {
					for (const node of record.removedNodes) {
						removed.add(node);
					}
				}
			});
			observer.observe(layer, { childList: true });
			return { layer, before, removed, observer };
		});
		let scrollTop = 0;
		try {
			scrollTop = window.ashStandaloneIntegration.scrollVisibleRows(60);
			await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
			await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
		} finally {
			for (const entry of tracked) {
				entry.observer.disconnect();
			}
		}
		const snapshots = tracked.map(({ layer, before, removed }) => {
			const after = new Map<number, HTMLElement>();
			for (const child of layer.children) {
				const row = child as HTMLElement;
				after.set(Number(row.dataset.lineIndex), row);
			}
			const overlap = [...before.keys()].filter(index => after.has(index));
			return {
				kind: layer.classList.contains('view-lines') ? 'text' : 'overlay',
				beforeCount: before.size,
				afterCount: after.size,
				firstBefore: Math.min(...before.keys()),
				firstAfter: Math.min(...after.keys()),
				firstText: after.values().next().value?.textContent ?? '',
				overlap: overlap.length,
				stable: overlap.every(index => before.get(index) === after.get(index)),
				removedOverlap: overlap.filter(index => removed.has(before.get(index)!)).length,
				staleDetached: [...before].filter(([index]) => !after.has(index)).every(([, row]) => !row.isConnected),
			};
		});
		return { scrollTop, snapshots };
	});
	expect(result.scrollTop).toBe(60);
	expect(result.snapshots.length).toBeGreaterThanOrEqual(2);
	for (const layer of result.snapshots) {
		expect(layer.beforeCount).toBeGreaterThan(0);
		expect(layer.afterCount).toBeLessThan(20);
		expect(layer.firstAfter).toBeGreaterThan(layer.firstBefore);
		expect(layer.overlap).toBeGreaterThan(0);
		expect(layer.stable).toBe(true);
		expect(layer.removedOverlap).toBe(0);
		expect(layer.staleDetached).toBe(true);
	}
	const textLayer = result.snapshots.find(layer => layer.kind === 'text');
	if (!textLayer) throw new Error('Visible text layer is unavailable');
	expect(textLayer.firstText).toContain(`line-${String(textLayer.firstAfter).padStart(2, '0')}`);
	expect(await page.evaluate(() => window.ashStandaloneIntegration.getCallerVersion())).toBe(initial.version);
	const updated = await page.evaluate(async lineIndex => {
		const selector = `#caller .view-line[data-line-index="${lineIndex}"]`;
		const row = document.querySelector<HTMLElement>(selector);
		const layer = document.querySelector<HTMLElement>('#caller .view-lines');
		if (!row || !layer) throw new Error('Visible text row is unavailable');
		let removed = false;
		const observer = new MutationObserver(records => {
			for (const record of records) {
				for (const node of record.removedNodes) {
					if (node === row) removed = true;
				}
			}
		});
		observer.observe(layer, { childList: true });
		try {
			const value = window.ashStandaloneIntegration.editVisibleRow(lineIndex);
			await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
			return { value, sameNode: document.querySelector(selector) === row, connected: row.isConnected, removed, text: row.textContent };
		} finally {
			observer.disconnect();
		}
	}, textLayer.firstAfter);
	expect(updated).toEqual({
		value: `changed-${textLayer.firstAfter}`,
		sameNode: true,
		connected: true,
		removed: false,
		text: `changed-${textLayer.firstAfter}`,
	});
	expect(await page.evaluate(() => window.ashStandaloneIntegration.getCallerVersion())).toBe(initial.version + 1);
	const released = await page.evaluate(() => {
		const rows = [...document.querySelectorAll('#caller .view-line')];
		window.ashStandaloneIntegration.dispose();
		return { detached: rows.every(row => !row.isConnected), roots: document.querySelectorAll('#caller .view-lines').length };
	});
	expect(released).toEqual({ detached: true, roots: 0 });
	expect(errors).toEqual([]);
});

test('wrapped cursor and gutter markers stay on their model lines through navigation and editing', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.stack ?? error.message));
	await page.goto('/standalone.html');
	const initial = await page.evaluate(() => window.ashStandaloneIntegration.prepareCursorGutter());
	expect(initial.modelLineCount).toBe(2);
	await page.locator('#caller .stanza-editor-input').focus();
	const readGeometry = async () => page.evaluate(() => {
		const firstRows = [...document.querySelectorAll<HTMLElement>('#caller .view-line[data-logical-line-index="0"]')];
		const secondRow = document.querySelector<HTMLElement>('#caller .view-line[data-logical-line-index="1"]');
		const caret = document.querySelector<HTMLElement>('#caller .stanza-editor-caret.primary');
		const glyphs = [...document.querySelectorAll<HTMLElement>('#caller .ash-gutter-probe')];
		const numberRows = [...document.querySelectorAll<HTMLElement>('#caller .margin-view-overlays .view-overlay-line')];
		if (!firstRows.length || !secondRow || !caret) {
			throw new Error(`Cursor and gutter rows are unavailable: first=${firstRows.length}, second=${Boolean(secondRow)}, caret=${Boolean(caret)}`);
		}
		return {
			wrappedRows: firstRows.length,
			firstTop: firstRows[0]!.getBoundingClientRect().top,
			lastTop: firstRows.at(-1)!.getBoundingClientRect().top,
			secondTop: secondRow.getBoundingClientRect().top,
			caretTop: caret.getBoundingClientRect().top,
			glyphTops: glyphs.map(glyph => glyph.getBoundingClientRect().top),
			numbers: numberRows.map(row => row.querySelector('.line-numbers')?.textContent ?? ''),
		};
	});
	const wrapped = await readGeometry();
	expect(wrapped.wrappedRows).toBeGreaterThan(1);
	expect(wrapped.numbers[0]).toBe('1');
	expect(wrapped.numbers.slice(1, wrapped.wrappedRows)).toEqual(Array(wrapped.wrappedRows - 1).fill(''));
	expect(wrapped.numbers[wrapped.wrappedRows]).toBe('1');
	expect(wrapped.glyphTops).toEqual([wrapped.firstTop]);
	expect(wrapped.caretTop).toBe(wrapped.lastTop);

	await page.evaluate(() => window.ashStandaloneIntegration.moveGutterCaret(2, 1));
	const moved = await readGeometry();
	expect(moved.caretTop).toBe(moved.secondTop);
	expect(moved.glyphTops).toEqual([moved.firstTop]);
	expect(moved.numbers[0]).toBe('1');
	expect(moved.numbers[moved.wrappedRows]).toBe('2');
	expect(await page.evaluate(() => window.ashStandaloneIntegration.getCallerVersion())).toBe(initial.version);

	const editedVersion = await page.evaluate(() => window.ashStandaloneIntegration.shortenGutterLine());
	expect(editedVersion).toBe(initial.version + 1);
	const shortened = await readGeometry();
	expect(shortened.secondTop).toBeLessThan(moved.secondTop);
	expect(shortened.caretTop).toBe(shortened.secondTop);
	expect(shortened.glyphTops).toEqual([shortened.firstTop]);
	expect(shortened.numbers[0]).toBe('1');
	expect(shortened.numbers[shortened.wrappedRows]).toBe('2');
	await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	await expect(page.locator('#caller .ash-gutter-probe')).toHaveCount(0);
	expect(errors).toEqual([]);
});

for (const unit of ['pixels', 'lines'] as const) {
	test(`standalone view zones collapse and expand in ${unit} without changing text or decoration anchors`, async ({ page }) => {
		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto('/standalone.html');
		const initial = await page.evaluate(value => window.ashStandaloneIntegration.prepareViewZone(value), unit);
		expect(initial.computedHeights).toEqual([0]);
		const zone = page.locator('#caller .ash-zone-probe');
		const margin = page.locator('#caller .ash-zone-margin-probe');
		const block = page.locator('#caller .ash-zone-block-probe');
		const caret = page.locator('#caller .stanza-editor-caret.primary');
		await page.locator('#caller .stanza-editor-input').focus();
		await expect(zone).toHaveCount(1);
		await expect(zone).toHaveAttribute('data-computed-height', '0');
		await expect(zone).toBeHidden();
		await expect(margin).toBeHidden();
		const originalBlock = await block.boundingBox();
		expect(originalBlock).not.toBeNull();
		const originalCaret = await caret.boundingBox();
		expect(originalCaret).not.toBeNull();
		const node = await zone.elementHandle();
		const height = unit === 'pixels' ? 40 : 2;
		const expanded = await page.evaluate(value => window.ashStandaloneIntegration.resizeViewZone(value, 1), height);
		expect(expanded).toEqual({
			version: initial.version,
			lineTop: initial.lineTop + 40,
			contentHeight: initial.contentHeight + 40,
			computedHeights: [0, 40],
		});
		await expect(zone).toBeVisible();
		await expect(zone).toHaveCSS('height', '40px');
		await expect(zone).toHaveAttribute('data-computed-height', '40');
		await expect(zone).toHaveAttribute('data-top', '20');
		await expect(margin).toHaveCSS('height', '40px');
		await expect.poll(async () => (await block.boundingBox())?.height).toBe(originalBlock!.height + 40);
		await expect.poll(async () => (await caret.boundingBox())?.y).toBe(originalCaret!.y + 40);
		expect(await node!.evaluate(element => element === document.querySelector('#caller .ash-zone-probe'))).toBe(true);

		const moved = await page.evaluate(value => window.ashStandaloneIntegration.resizeViewZone(value, 2), height);
		expect(moved.lineTop).toBe(initial.lineTop);
		await expect.poll(async () => (await caret.boundingBox())?.y).toBe(originalCaret!.y);
		await expect.poll(async () => (await block.boundingBox())?.y).toBe(originalBlock!.y);
		const collapsed = await page.evaluate(() => window.ashStandaloneIntegration.resizeViewZone(0, 1));
		expect(collapsed).toEqual({ ...initial, computedHeights: [0, 40, 40, 0] });
		await expect.poll(async () => (await block.boundingBox())?.height).toBe(originalBlock!.height);
		await expect(zone).toBeHidden();
		await expect(margin).toBeHidden();
		await page.evaluate(value => window.ashStandaloneIntegration.resizeViewZone(value, 1), height);
		await expect(zone).toBeVisible();
		await page.evaluate(() => window.ashStandaloneIntegration.removeViewZone());
		await expect(zone).toHaveCount(0);
		await expect(margin).toHaveCount(0);
		await expect.poll(async () => (await block.boundingBox())?.y).toBe(originalBlock!.y);
		expect(await node!.evaluate(element => element.isConnected)).toBe(false);
		await node!.dispose();
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
		expect(errors).toEqual([]);
	});
}

test('public editor contracts honor initial wrapping, animated scrolling, content events, and detachment', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto('/standalone.html');
	expect(await page.evaluate(() => window.ashStandaloneIntegration.checkContracts())).toEqual({
		wrapping: 'on', wrapped: true, animated: true, settled: true, top: 600, interrupted: true, detached: true, eventTexts: ['X'],
	});
	await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	expect(errors).toEqual([]);
});


test('standalone marker decorations appear and clear through the shared marker service', async ({ page }) => {
	await page.goto('/standalone.html');
	await page.evaluate(() => window.ashStandaloneIntegration.setTestMarkers(true));
	await expect(page.locator('#caller .squiggly-error')).toHaveCount(1);
	await page.evaluate(() => window.ashStandaloneIntegration.setTestMarkers(false));
	await expect(page.locator('#caller .squiggly-error')).toHaveCount(0);
	await page.evaluate(() => window.ashStandaloneIntegration.dispose());
});

test('reference Peek embeds a read-only editor that follows parent configuration and releases on Escape', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto('/standalone.html');
	await page.evaluate(() => window.ashStandaloneIntegration.prepareReferencePreview());
	const input = page.locator('#caller > .stanza-editor .stanza-editor-input').first();
	await input.focus();
	await page.keyboard.press('Shift+F12');
	const preview = page.locator('.stanza-editor-language-preview .stanza-editor');
	await expect(preview).toBeVisible();
	await expect(preview.locator('.stanza-editor-line-text').first()).toContainText('alpha beta');
	await page.evaluate(() => window.ashStandaloneIntegration.setParentFontSize());
	await expect(preview.locator('.stanza-editor-line-text').first()).toHaveCSS('font-size', '18px');
	await preview.locator('.stanza-editor-input').focus();
	await page.keyboard.type('X');
	await expect(preview.locator('.stanza-editor-line-text').first()).toContainText('alpha beta');
	await page.keyboard.press('Escape');
	await expect(preview).toHaveCount(0);
	await expect(input).toBeFocused();
	await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	expect(errors).toEqual([]);
});

test('minimap repaints token colors when the registry palette changes', async ({ page }) => {
	await page.goto('/standalone.html');
	await page.evaluate(() => window.ashStandaloneIntegration.setMinimapColor('#ff0000'));
	await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readMinimapPixel().slice(0, 3))).toEqual([255, 0, 0]);
	await page.evaluate(() => window.ashStandaloneIntegration.setMinimapColor('#0000ff'));
	await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readMinimapPixel().slice(0, 3))).toEqual([0, 0, 255]);
	await page.evaluate(() => window.ashStandaloneIntegration.dispose());
});

test('standalone view zones stay after the wrapped fold header while folded and scrolled', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto('/standalone.html');
	const version = await page.evaluate(() => window.ashStandaloneIntegration.prepareFoldedViewZone(true));
	const zone = page.locator('#caller .ash-folded-zone-probe');
	const margin = page.locator('#caller .ash-folded-zone-margin-probe');
	await expect(zone).toHaveCSS('top', '80px');
	const node = await zone.elementHandle();
	await page.locator('#caller .ash-icon-folding-expanded').first().click();
	await expect(page.locator('#caller .ash-icon-folding-collapsed').first()).toBeVisible();
	await expect(zone).toHaveCSS('top', '60px');
	await expect(zone).toHaveAttribute('data-computed-height', '40');
	await expect(zone).toHaveAttribute('data-top', '60');
	await expect(margin).toHaveCSS('top', '60px');
	await page.evaluate(() => window.ashStandaloneIntegration.scrollVisibleRows(40));
	await expect(zone).toBeVisible();
	await expect(zone).toHaveAttribute('data-top', '20');
	await expect.poll(async () => {
		const bounds = await zone.boundingBox();
		const root = await page.locator('#caller .stanza-editor').boundingBox();
		return bounds && root ? Math.round(bounds.y - root.y) : null;
	}).toBe(20);
	await page.evaluate(() => window.ashStandaloneIntegration.scrollVisibleRows(0));
	await page.locator('#caller .ash-icon-folding-collapsed').first().click();
	await expect(zone).toHaveCSS('top', '80px');
	expect(await page.evaluate(() => window.ashStandaloneIntegration.getCallerVersion())).toBe(version);
	expect(await node!.evaluate(element => element === document.querySelector('#caller .ash-folded-zone-probe'))).toBe(true);
	await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	expect(await node!.evaluate(element => element.isConnected)).toBe(false);
	await node!.dispose();
	expect(errors).toEqual([]);
});


test('folding hides view zones and restores their layout callbacks after scrolling and unfolding', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto('/standalone.html');
	const version = await page.evaluate(() => window.ashStandaloneIntegration.prepareFoldedViewZone(false));
	const zone = page.locator('#caller .ash-folded-zone-probe');
	const margin = page.locator('#caller .ash-folded-zone-margin-probe');
	await expect(zone).toHaveAttribute('data-computed-height', '40');
	await expect(zone).toHaveAttribute('data-top', '80');
	const node = await zone.elementHandle();
	await page.locator('#caller .ash-icon-folding-expanded').first().click();
	await expect(zone).toBeHidden();
	await expect(margin).toBeHidden();
	await expect(zone).toHaveAttribute('data-computed-height', '0');
	await page.evaluate(() => window.ashStandaloneIntegration.scrollVisibleRows(40));
	await expect(zone).toBeHidden();
	await expect.poll(() => zone.getAttribute('data-top').then(Number)).toBeLessThan(0);
	await page.evaluate(() => window.ashStandaloneIntegration.scrollVisibleRows(0));
	await page.locator('#caller .ash-icon-folding-collapsed').first().click();
	await expect(zone).toBeVisible();
	await expect(margin).toBeVisible();
	await expect(zone).toHaveAttribute('data-computed-height', '40');
	await expect(zone).toHaveAttribute('data-top', '80');
	expect(await page.evaluate(() => window.ashStandaloneIntegration.getCallerVersion())).toBe(version);
	expect(await node!.evaluate(element => element === document.querySelector('#caller .ash-folded-zone-probe'))).toBe(true);
	await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	expect(await node!.evaluate(element => element.isConnected)).toBe(false);
	await node!.dispose();
	expect(errors).toEqual([]);
});


test('editor rendering follows updated configuration without replacing the view', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto('/standalone.html');
	const root = page.locator('#caller .stanza-editor');
	const minimap = page.locator('#caller .minimap');
	const node = await root.elementHandle();
	const version = await page.evaluate(() => window.ashStandaloneIntegration.getCallerVersion());
	for (const enabled of [false, true, false]) {
		expect(await page.evaluate(value => window.ashStandaloneIntegration.updateRenderingOptions(value), enabled)).toBe(version);
		await expect(minimap).toBeVisible({ visible: enabled });
		await expect(root).toHaveCSS('font-size', enabled ? '18px' : '14px');
		await expect(root).toHaveClass(enabled ? /stanza-editor-mouse-copy/ : /stanza-editor-mouse-default/);
		if (enabled) {
			await expect(root).toHaveClass(/word-wrapped/);
			await expect(minimap).toHaveCSS('left', '0px');
		} else {
			await expect(root).not.toHaveClass(/word-wrapped/);
		}
	}
	expect(await node!.evaluate(element => element === document.querySelector('#caller .stanza-editor'))).toBe(true);
	await node!.dispose();
	await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	expect(errors).toEqual([]);
});

test('editor configuration widens and shrinks the line-number gutter while typing and undoing', async ({ page }) => {
	await page.goto('/standalone.html');
	await page.evaluate(() => window.ashStandaloneIntegration.prepareLineCountConfiguration(9, 'fit'));
	const before = await page.evaluate(() => window.ashStandaloneIntegration.readLineCountConfiguration());
	await page.keyboard.press('Enter');
	const after = await page.evaluate(() => window.ashStandaloneIntegration.readLineCountConfiguration());
	expect(after.lines).toBe(10);
	expect(after.layout.lineNumbersWidth).toBe(Math.round(2 * after.digitWidth));
	expect(after.layout.contentLeft).toBeGreaterThan(before.layout.contentLeft);
	await expect(page.locator('#caller .line-numbers').last()).toHaveCSS('width', `${after.layout.lineNumbersWidth}px`);
	await page.keyboard.press('ControlOrMeta+z');
	const undone = await page.evaluate(() => window.ashStandaloneIntegration.readLineCountConfiguration());
	expect(undone.lines).toBe(9);
	expect(undone.layout.lineNumbersWidth).toBe(before.layout.lineNumbersWidth);
	await expect(page.locator('#caller .line-numbers').last()).toHaveCSS('width', `${before.layout.lineNumbersWidth}px`);
	await page.evaluate(() => window.ashStandaloneIntegration.dispose());
});

for (const size of ['fill', 'fit'] as const) {
	test(`editor configuration keeps ${size} minimap in sync with folded and wrapped lines`, async ({ page }) => {
		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.stack ?? error.message));
		await page.goto('/standalone.html');
		await page.evaluate(size => window.ashStandaloneIntegration.prepareLineCountConfiguration(1000, size), size);
		const initial = await page.evaluate(() => window.ashStandaloneIntegration.readLineCountConfiguration());
		expect(initial.layout.minimap.minimapIsSampling).toBe(true);
		await page.evaluate(() => window.ashStandaloneIntegration.foldConfigurationLines(true));
		const folded = await page.evaluate(() => window.ashStandaloneIntegration.readLineCountConfiguration());
		expect(folded.viewLines).toBe(2);
		expect(folded.layout.minimap.minimapIsSampling).toBe(false);
		await page.evaluate(() => window.ashStandaloneIntegration.foldConfigurationLines(false));
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCountConfiguration())).layout.minimap).toEqual(initial.layout.minimap);

		await page.evaluate(size => window.ashStandaloneIntegration.prepareLineCountConfiguration(80, size, 'content '.repeat(30)), size);
		await page.evaluate(() => window.ashStandaloneIntegration.updateContributionOptions({ wordWrap: 'on' }));
		await expect.poll(async () => (await page.evaluate(() => window.ashStandaloneIntegration.readLineCountConfiguration())).layout.minimap.minimapIsSampling).toBe(true);
		const wrapped = await page.evaluate(() => window.ashStandaloneIntegration.readLineCountConfiguration());
		expect(wrapped.viewLines).toBeGreaterThan(wrapped.lines);
		await expect(page.locator('#caller .minimap')).toHaveCSS('width', `${wrapped.layout.minimap.minimapWidth}px`);
		await page.evaluate(() => window.ashStandaloneIntegration.updateContributionOptions({ wordWrap: 'off' }));
		await expect.poll(async () => (await page.evaluate(() => window.ashStandaloneIntegration.readLineCountConfiguration())).viewLines).toBe(80);
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
		expect(errors).toEqual([]);
	});
}

test('editor configuration wraps an attached long-line file for screen readers and respects explicit off', async ({ page }) => {
	await page.goto('/standalone.html');
	await page.evaluate(() => window.ashStandaloneIntegration.configureAccessibility(true, 'auto'));
	await page.evaluate(() => window.ashStandaloneIntegration.prepareLineCountConfiguration(1, 'fit', 'x'.repeat(20000)));
	const wrapped = await page.evaluate(() => window.ashStandaloneIntegration.readLineCountConfiguration());
	expect(wrapped.layout.isWordWrapMinified).toBe(true);
	expect(wrapped.viewLines).toBeGreaterThan(1);
	await page.evaluate(() => window.ashStandaloneIntegration.configureAccessibility(true, 'off'));
	const unwrapped = await page.evaluate(() => window.ashStandaloneIntegration.readLineCountConfiguration());
	expect(unwrapped.layout.isWordWrapMinified).toBe(false);
	expect(unwrapped.viewLines).toBe(1);
	await page.evaluate(() => window.ashStandaloneIntegration.dispose());
});

test('editor font measurements stay in layout pixels when the host is transformed', async ({ page }) => {
	await page.goto('/standalone.html');
	const before = await page.evaluate(() => window.ashStandaloneIntegration.readFontMetrics());
	expect(before.halfwidth).toBeGreaterThan(2);
	for (const scale of [0.75, 1.5, 1]) {
		const after = await page.evaluate(scale => {
			document.body.style.transform = `scale(${scale})`;
			return window.ashStandaloneIntegration.readFontMetrics();
		}, scale);
		expect(after).toEqual(before);
	}
	await page.evaluate(() => window.ashStandaloneIntegration.dispose());
});

test('editor accessibility configuration follows the host and honors per-editor overrides', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto('/standalone.html');
	const input = page.locator('#caller .stanza-native-edit-context');
	const mirror = page.locator('#caller .stanza-native-screen-reader-content');
	for (const [host, option, enabled] of [
		[true, 'auto', true],
		[true, 'off', false],
		[true, 'auto', true],
		[false, 'auto', false],
		[false, 'on', true],
	] as const) {
		expect(await page.evaluate(([host, option]) => window.ashStandaloneIntegration.configureAccessibility(host, option), [host, option] as const))
			.toEqual({ support: enabled ? 2 : 1, indent: enabled ? 0 : 2 });
		await expect(mirror).toHaveAttribute('aria-hidden', enabled ? 'false' : 'true');
		await expect(input).toBeFocused();
	}
	await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	expect(errors).toEqual([]);
});

for (const [original, formatted] of [['😀 hello', '😀 Hello'], ['a😀z', 'a😁z'], ['a😀z', 'a🨀z'], ['first\n😀 hello', 'first\n😀 Hello']]) {
	test(`formatting preserves UTF-16 characters: ${JSON.stringify(original)} to ${JSON.stringify(formatted)}`, async ({ page }) => {
		await page.goto('/standalone.html');
		expect(await page.evaluate(([before, after]) => window.ashStandaloneIntegration.runUnicodeFormatting(before!, after!), [original, formatted])).toBe(formatted);
		await page.keyboard.press('ControlOrMeta+z');
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).value).toBe(original);
		await page.keyboard.press('ControlOrMeta+Shift+z');
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).value).toBe(formatted);
	});
}

for (const change of ['none', 'position', 'model', 'readonly', 'eol', 'returnPosition'] as const) {
	test(`formatting validates ${change} state before applying delayed edits`, async ({ page }) => {
		await page.goto('/standalone.html');
		const value = await page.evaluate(change => window.ashStandaloneIntegration.runFormatting(change), change);
		expect(value).toBe(change === 'eol' ? '\r\n' : change === 'none' ? 'ALPHA' : change === 'model' ? 'owned' : 'alpha');
		if (change === 'eol') {
			await page.keyboard.press('ControlOrMeta+z');
			expect(await page.evaluate(() => window.ashStandaloneIntegration.readEOL())).toBe('\n');
			await page.keyboard.press('ControlOrMeta+Shift+z');
			expect(await page.evaluate(() => window.ashStandaloneIntegration.readEOL())).toBe('\r\n');
		}
		if (change === 'none') {
			await page.keyboard.press('ControlOrMeta+z');
			expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).value).toBe('alpha');
			await page.keyboard.press('ControlOrMeta+Shift+z');
			expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).value).toBe('ALPHA');
		}
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	});
}

for (const cancel of ['escape', 'supersede'] as const) {
	test(`format action cancels pending provider on ${cancel}`, async ({ page }) => {
		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.prepareDeferredFormatting());
		await page.keyboard.press('ControlOrMeta+Shift+i');
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readDeferredFormatting())).toEqual({ aborted: [false], value: 'alpha' });
		if (cancel === 'escape') {
			await page.keyboard.press('Escape');
		} else {
			await page.evaluate(() => { void window.ashStandaloneIntegration.runLineAction('editor.action.formatDocument'); });
		}
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readDeferredFormatting())).toEqual({ aborted: cancel === 'escape' ? [true] : [true, false], value: 'alpha' });
		await page.evaluate(() => window.ashStandaloneIntegration.finishDeferredFormatting());
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readDeferredFormatting().value)).toBe(cancel === 'escape' ? 'alpha' : 'ALPHA');
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	});
}

for (const mode of ['ranges', 'single', 'empty', 'cancel', 'readonly'] as const) {
	test(`selection formatting handles ${mode} through the registered action`, async ({ page }) => {
		await page.goto('/standalone.html');
		const result = await page.evaluate(mode => window.ashStandaloneIntegration.runSelectionFormatting(mode), mode);
		const original = 'alpha\nbeta\ngamma';
		if (mode === 'cancel' || mode === 'readonly') {
			expect(result.value).toBe(original);
			if (mode === 'cancel') expect(result.cancelled).toBe(true);
			if (mode === 'readonly') expect(result.ranges).toEqual([]);
		} else {
			expect(result.value).toBe(mode === 'empty' ? 'alpha\nBETA\ngamma' : 'ALPHA\nbeta\nGAMMA');
			expect(result.ranges).toEqual(mode === 'empty' ? ['[2,1 -> 2,5]'] : ['[1,1 -> 1,6]', '[3,1 -> 3,6]']);
			await page.keyboard.press('ControlOrMeta+z');
			expect(await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy().value)).toBe(original);
		}
	});
}

for (const cancel of [false, true]) {
	test(`overlapping formatting re-queries the combined range${cancel ? ' and cancels' : ' before one undoable edit'}`, async ({ page }) => {
		await page.goto('/standalone.html');
		const result = await page.evaluate(cancel => window.ashStandaloneIntegration.runOverlappingFormatting(cancel), cancel);
		expect(result).toEqual({
			value: cancel ? 'alpha\nbeta\ngamma' : 'ALPHA\nBETA\nGAMMA',
			ranges: ['[1,1 -> 1,6]', '[3,1 -> 3,6]', '[1,1 -> 3,6]'],
			cancelled: cancel,
		});
		expect(await page.evaluate(() => window.ashStandaloneIntegration.readEOL())).toBe('\n');
		if (!cancel) {
			await page.keyboard.press('ControlOrMeta+z');
			expect(await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy().value)).toBe('alpha\nbeta\ngamma');
		}
	});
}

for (const outcome of ['second', 'empty', 'decline', 'error', 'cancel', 'silent', 'languageChoice', 'languageResult'] as const) {
	test(`formatter selection honors ${outcome} without running another provider`, async ({ page }) => {
		await page.goto('/standalone.html');
		const result = await page.evaluate(outcome => window.ashStandaloneIntegration.runFormatterChoice(outcome), outcome);
		expect(result).toEqual({
			value: outcome === 'second' || outcome === 'silent' ? 'SELECTED' : 'alpha',
			calls: outcome === 'decline' || outcome === 'cancel' || outcome === 'languageChoice' ? [] : ['selected'],
			modes: [outcome === 'silent' ? 2 : 1],
			errors: outcome === 'error' ? ['formatter failed'] : [],
		});
	});
}


test('inline suggestions respect automatic enablement and cancel disabled requests', async ({ page }) => {
	await page.clock.install();
	await page.goto('/standalone.html');
	await page.evaluate(() => {
		window.ashStandaloneIntegration.updateContributionOptions({ inlineSuggest: { enabled: false } });
		window.ashStandaloneIntegration.prepareInlineRequests();
	});
	await page.keyboard.type('abc');
	await page.clock.runFor(600);
	expect((await page.evaluate(() => window.ashStandaloneIntegration.readInlineRequests())).requests).toEqual([]);
	await page.evaluate(() => window.ashStandaloneIntegration.updateContributionOptions({ inlineSuggest: { enabled: true } }));
	await page.keyboard.type('d');
	await page.clock.runFor(600);
	expect((await page.evaluate(() => window.ashStandaloneIntegration.readInlineRequests())).requests).toHaveLength(1);
	await page.evaluate(() => window.ashStandaloneIntegration.updateContributionOptions({ inlineSuggest: { enabled: false } }));
	expect((await page.evaluate(() => window.ashStandaloneIntegration.readInlineRequests())).requests[0]!.aborted).toBe(true);
	await page.evaluate(() => window.ashStandaloneIntegration.finishInlineRequest(0));
	await expect(page.locator('#caller .stanza-editor-inline-completion')).toBeHidden();
	await page.keyboard.press('Control+Alt+Space');
	expect((await page.evaluate(() => window.ashStandaloneIntegration.readInlineRequests())).requests[1]!.kind).toBe('explicit');
	await page.evaluate(() => window.ashStandaloneIntegration.finishInlineRequest(1));
	await expect(page.locator('#caller .stanza-editor-inline-completion')).toBeVisible();
	await page.evaluate(() => window.ashStandaloneIntegration.updateContributionOptions({ readOnly: true }));
	await expect(page.locator('#caller .stanza-editor-inline-completion')).toBeHidden();
	await page.evaluate(() => window.ashStandaloneIntegration.dispose());
});

test('standard contribution commands operate the existing find, fold and goto widgets', async ({ page }) => {
	await page.goto('/standalone.html');
	await page.evaluate(() => window.ashStandaloneIntegration.prepareClipboard('alpha\n  child\nend'));
	await page.evaluate(() => window.ashStandaloneIntegration.invokeLanguageAction('actions.find'));
	const find = page.locator('#caller .stanza-editor-find-widget');
	await expect(find).toBeVisible();
	await find.getByRole('textbox', { name: 'Find', exact: true }).fill('alpha');
	await expect(find.locator('.stanza-editor-find-result')).toHaveText('1 of 1');
	await page.keyboard.press('Escape');
	await page.evaluate(() => window.ashStandaloneIntegration.invokeLanguageAction('editor.action.startFindReplaceAction'));
	await expect(find.getByRole('textbox', { name: 'Replace', exact: true })).toBeVisible();
	await page.keyboard.press('Escape');
	await page.evaluate(() => window.ashStandaloneIntegration.invokeLanguageAction('editor.fold'));
	await expect(page.locator('#caller .view-line[data-logical-line-index="1"]')).toHaveCount(0);
	await page.evaluate(() => window.ashStandaloneIntegration.invokeLanguageAction('editor.unfold'));
	await expect(page.locator('#caller .view-line[data-logical-line-index="1"]')).toHaveCount(1);
	await page.evaluate(() => window.ashStandaloneIntegration.invokeLanguageAction('editor.action.gotoLine'));
	const location = page.locator('#caller .stanza-editor-goto-line-input');
	await expect(location).toBeFocused();
	await location.fill('3:2');
	await page.keyboard.press('Enter');
	await expect(location).toBeHidden();
	await expect(page.locator('#caller .stanza-editor-input')).toBeFocused();
	await page.keyboard.type('X');
	expect((await page.evaluate(() => window.ashStandaloneIntegration.state('caller'))).value).toBe('alpha\n  child\neXnd');
	await page.evaluate(() => window.ashStandaloneIntegration.invokeLanguageAction('editor.action.gotoOffset'));
	await expect(location).toBeFocused();
	await expect(location).toHaveAttribute('aria-label', 'Character offset');
	await location.fill('7');
	await page.keyboard.press('Enter');
	await expect(location).toBeHidden();
	await expect(page.locator('#caller .stanza-editor-input')).toBeFocused();
	await page.keyboard.type('Y');
	expect((await page.evaluate(() => window.ashStandaloneIntegration.state('caller'))).value).toBe('alpha\nY  child\neXnd');
	await page.evaluate(() => window.ashStandaloneIntegration.dispose());
});

test('standard suggestion commands trigger, hide and commit through one undoable edit', async ({ page }) => {
	await page.goto('/standalone.html');
	await page.evaluate(() => {
		window.ashStandaloneIntegration.prepareContributionRequests('completion');
		window.ashStandaloneIntegration.invokeLanguageAction('editor.action.triggerSuggest');
	});
	await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readContributionRequests().length)).toBe(1);
	await page.evaluate(() => window.ashStandaloneIntegration.finishContributionRequest(0));
	await expect(page.locator('#caller .stanza-editor-completion')).toBeVisible();
	await page.keyboard.press('Escape');
	await page.evaluate(() => {
		window.ashStandaloneIntegration.prepareInlineRequests();
		window.ashStandaloneIntegration.invokeLanguageAction('editor.action.inlineSuggest.trigger');
	});
	await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readInlineRequests().requests.length)).toBe(1);
	await page.evaluate(() => window.ashStandaloneIntegration.finishInlineRequest(0));
	const ghost = page.locator('#caller .stanza-editor-inline-completion');
	await expect(ghost).toBeVisible();
	await page.evaluate(() => window.ashStandaloneIntegration.invokeLanguageAction('editor.action.inlineSuggest.hide'));
	await expect(ghost).toBeHidden();
	expect((await page.evaluate(() => window.ashStandaloneIntegration.state('caller'))).value).toBe('');
	await page.evaluate(() => window.ashStandaloneIntegration.invokeLanguageAction('editor.action.inlineSuggest.trigger'));
	await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readInlineRequests().requests.length)).toBe(2);
	await page.evaluate(() => window.ashStandaloneIntegration.finishInlineRequest(1));
	await page.evaluate(() => window.ashStandaloneIntegration.invokeLanguageAction('editor.action.inlineSuggest.commit'));
	expect((await page.evaluate(() => window.ashStandaloneIntegration.state('caller'))).value).toBe(' suggestion');
	await expect(ghost).toBeHidden();
	await page.keyboard.press('ControlOrMeta+z');
	expect((await page.evaluate(() => window.ashStandaloneIntegration.state('caller'))).value).toBe('');
	await page.evaluate(() => window.ashStandaloneIntegration.dispose());
});

test('inline completion snooze is shared and survives closing another editor', async ({ page }) => {
	await page.goto('/standalone.html');
	expect(await page.evaluate(() => window.ashStandaloneIntegration.runSharedInlineSnooze())).toEqual({
		shared: true,
		visibleBefore: 2,
		visibleAfter: 0,
		callsWhilePaused: 0,
		pausedAfterDispose: true,
		resumed: true,
	});
});

for (const inputKind of ['editContext', 'textarea'] as const) {
	test(`${inputKind} inline completion debounces typing, learns latency and keeps explicit requests immediate`, async ({ page }) => {
		if (inputKind === 'textarea') {
			await page.addInitScript(() => { Reflect.deleteProperty(window, 'EditContext'); });
		}
		await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
		await page.goto('/standalone.html');
		await page.clock.pauseAt(new Date('2026-01-01T00:01:00Z'));
		await page.evaluate(() => window.ashStandaloneIntegration.prepareInlineRequests());
		await page.keyboard.type('abc');
		await page.clock.runFor(49);
		expect(await page.evaluate(() => window.ashStandaloneIntegration.readInlineRequests())).toEqual({ requests: [], delay: 50, shared: true });
		await page.clock.runFor(1);
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readInlineRequests())).requests).toEqual([{ kind: 'automatic', text: 'abc', languageId: 'plaintext', aborted: false }]);
		await page.clock.runFor(240);
		await page.evaluate(() => window.ashStandaloneIntegration.finishInlineRequest(0));
		await expect(page.locator('#caller .stanza-editor-inline-completion')).toBeVisible();
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readInlineRequests())).delay).toBe(240);
		await page.keyboard.type('d');
		await page.clock.runFor(200);
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readInlineRequests())).requests).toHaveLength(1);
		await page.keyboard.press('Control+Alt+Space');
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readInlineRequests())).requests[1]).toEqual({ kind: 'explicit', text: 'abcd', languageId: 'plaintext', aborted: false });
		await page.evaluate(() => window.ashStandaloneIntegration.finishInlineRequest(1));
		await page.clock.runFor(500);
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readInlineRequests())).requests).toHaveLength(2);
		await page.keyboard.press('Alt+Enter');
		expect(await page.evaluate(() => window.ashStandaloneIntegration.state('caller').value)).toBe('abcd suggestion');
		await expect(page.locator('#caller .stanza-editor-input')).toBeFocused();
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	});

	test(`${inputKind} inline completion waits for composition to finish`, async ({ page }) => {
		if (inputKind === 'textarea') {
			await page.addInitScript(() => { Reflect.deleteProperty(window, 'EditContext'); });
		}
		await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
		await page.goto('/standalone.html');
		await page.clock.pauseAt(new Date('2026-01-01T00:01:00Z'));
		await page.evaluate(() => window.ashStandaloneIntegration.prepareInlineRequests());
		await page.keyboard.type('abc');
		await page.evaluate(() => {
			const input = document.querySelector<HTMLElement>('#caller .stanza-editor-input')!;
			const target = (input as HTMLElement & { editContext?: EventTarget }).editContext ?? input;
			target.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
		});
		await page.clock.runFor(500);
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readInlineRequests())).requests).toEqual([]);
		await page.evaluate(() => {
			const input = document.querySelector<HTMLElement>('#caller .stanza-editor-input')!;
			const target = (input as HTMLElement & { editContext?: EventTarget }).editContext ?? input;
			target.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
		});
		await page.clock.runFor(50);
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readInlineRequests())).requests).toEqual([{ kind: 'automatic', text: 'abc', languageId: 'plaintext', aborted: false }]);
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	});
}

test('inline completion uses the new language after cancelling an old request', async ({ page }) => {
	await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
	await page.goto('/standalone.html');
	await page.clock.pauseAt(new Date('2026-01-01T00:01:00Z'));
	await page.evaluate(() => window.ashStandaloneIntegration.prepareInlineRequests());
	await page.keyboard.type('a');
	await page.clock.runFor(50);
	await page.evaluate(() => window.ashStandaloneIntegration.cancelInlineRequests('language'));
	await page.keyboard.type('b');
	await page.clock.runFor(50);
	expect((await page.evaluate(() => window.ashStandaloneIntegration.readInlineRequests())).requests).toEqual([
		{ kind: 'automatic', text: 'a', languageId: 'plaintext', aborted: true },
		{ kind: 'automatic', text: 'ab', languageId: 'typescript', aborted: false },
	]);
	await page.evaluate(() => window.ashStandaloneIntegration.dispose());
});

test('inline completion ignores late responses after more typing', async ({ page }) => {
	await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
	await page.goto('/standalone.html');
	await page.clock.pauseAt(new Date('2026-01-01T00:01:00Z'));
	await page.evaluate(() => window.ashStandaloneIntegration.prepareInlineRequests());
	await page.keyboard.type('a');
	await page.clock.runFor(200);
	await page.keyboard.type('b');
	await page.clock.runFor(50);
	await page.evaluate(() => window.ashStandaloneIntegration.finishInlineRequest(0));
	expect(await page.evaluate(() => window.ashStandaloneIntegration.readInlineRequests())).toEqual({
		requests: [{ kind: 'automatic', text: 'a', languageId: 'plaintext', aborted: true }, { kind: 'automatic', text: 'ab', languageId: 'plaintext', aborted: false }],
		delay: 50,
		shared: true,
	});
	await expect(page.locator('#caller .stanza-editor-inline-completion:not([hidden])')).toHaveCount(0);
	await page.evaluate(() => window.ashStandaloneIntegration.finishInlineRequest(1));
	await expect(page.locator('#caller .stanza-editor-inline-completion')).toBeVisible();
	await page.evaluate(() => window.ashStandaloneIntegration.dispose());
});

for (const reason of ['position', 'provider', 'snooze', 'dispose', 'model', 'blur', 'language'] as const) {
	for (const queued of [true, false]) {
		test(`inline completion ${queued ? 'queued' : 'running'} request is cancelled on ${reason}`, async ({ page }) => {
			const errors: string[] = [];
			page.on('pageerror', error => errors.push(error.message));
			await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
			await page.goto('/standalone.html');
			await page.clock.pauseAt(new Date('2026-01-01T00:01:00Z'));
			await page.evaluate(() => window.ashStandaloneIntegration.prepareInlineRequests());
			await page.keyboard.type('abc');
			if (!queued) {
				await page.clock.runFor(50);
			}
			await page.evaluate(reason => window.ashStandaloneIntegration.cancelInlineRequests(reason), reason);
			await page.clock.runFor(1_000);
			const state = await page.evaluate(() => window.ashStandaloneIntegration.readInlineRequests());
			expect(state.requests).toEqual(queued ? [] : [{ kind: 'automatic', text: 'abc', languageId: 'plaintext', aborted: true }]);
			expect(state.delay).toBe(50);
			if (!queued) {
				await page.evaluate(() => window.ashStandaloneIntegration.finishInlineRequest(0));
			}
			await expect(page.locator('#caller .stanza-editor-inline-completion:not([hidden])')).toHaveCount(0);
			await page.evaluate(() => window.ashStandaloneIntegration.dispose());
			expect(errors).toEqual([]);
		});
	}
}


test('standalone without a grammar keeps plain text and no invented diagnostics while word suggestions work', async ({ page }) => {
	const workers: string[] = [];
	page.on('worker', worker => workers.push(worker.url()));
	await page.goto('/standalone.html');
	await page.evaluate(() => window.ashStandaloneIntegration.prepareLanguageWorkers());
	await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readLanguageWorkers())).toEqual({
		tokens: [],
		diagnostics: [],
		current: true,
	});
	await page.keyboard.press('Control+Space');
	await expect(page.locator('#caller .stanza-editor-completion-option')).toHaveCount(2);
	await expect(page.locator('#caller .stanza-editor-completion-option')).toContainText(['alpha', 'alphabet']);
	expect(workers.some(url => url.includes('editorWebWorkerMain'))).toBe(true);
	expect(workers.some(url => /syntaxWorkerMain|languageCompletionWorkerMain/.test(url))).toBe(false);
	await page.evaluate(() => window.ashStandaloneIntegration.dispose());
});


for (const scenario of [
	{ name: 'nested', value: 'let x = ; tail', insertText: 'call({x: [1', column: 9, tokenType: 'other', completeBracketPairs: true, repaired: 'call({x: [1]})', result: 'let x = call({x: [1]}); tail' },
	{ name: 'unexpected closing', value: 'let x = ; tail', insertText: 'value)]', column: 9, tokenType: 'other', completeBracketPairs: true, repaired: 'value', result: 'let x = value; tail' },
	{ name: 'string', value: 'let x = "', insertText: '[)', column: 10, tokenType: 'string', completeBracketPairs: true, repaired: '[)', result: 'let x = "[)' },
	{ name: 'comment', value: '// ', insertText: '[)', column: 4, tokenType: 'comment', completeBracketPairs: true, repaired: '[)', result: '// [)' },
	{ name: 'multiline', value: 'let x = ;', insertText: 'call(\n[1', column: 9, tokenType: 'other', completeBracketPairs: true, repaired: 'call(\n[1])', result: 'let x = call(\n[1]);' },
	{ name: 'explicit replacement', value: 'let x = old; tail', insertText: 'call(', column: 9, tokenType: 'other', completeBracketPairs: true, replaceLength: 3, repaired: 'call()', result: 'let x = call(); tail' },
	{ name: 'unavailable lexer', value: 'let x = ', insertText: 'call(', column: 9, tokenType: 'unavailable', completeBracketPairs: true, repaired: 'call(', result: 'let x = call(' },
	{ name: 'provider opt out', value: 'let x = ', insertText: 'call(', column: 9, tokenType: 'other', completeBracketPairs: false, repaired: 'call(', result: 'let x = call(' },
] as const) {
	test(`inline completion bracket repair ${scenario.name} preserves suffix and accepts with one undo`, async ({ page }) => {
		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto('/standalone.html');
		await page.evaluate(scenario => window.ashStandaloneIntegration.prepareBracketCompletion(scenario.value, scenario.insertText, scenario.column, scenario.tokenType, scenario.completeBracketPairs, 'replaceLength' in scenario ? scenario.replaceLength : 0), scenario);
		await page.keyboard.press('Control+Alt+Space');
		const ghost = page.locator('#caller .stanza-editor-inline-completion');
		await expect(ghost).toBeVisible();
		expect(await ghost.textContent()).toBe(scenario.repaired);
		expect(await page.evaluate(() => window.ashStandaloneIntegration.state('caller').value)).toBe(scenario.value);
		await page.keyboard.press('Alt+Enter');
		expect(await page.evaluate(() => window.ashStandaloneIntegration.state('caller').value)).toBe('/* accepted */ ' + scenario.result);
		await page.keyboard.press('ControlOrMeta+z');
		expect(await page.evaluate(() => window.ashStandaloneIntegration.state('caller').value)).toBe(scenario.value);
		await expect(page.locator('#caller .stanza-editor-input')).toBeFocused();
		expect(errors).toEqual([]);
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	});
}

test('color picker retains one widget, applies one undoable edit and releases its controls', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto('/standalone.html');
	await page.evaluate(() => window.ashStandaloneIntegration.prepareColorPicker());
	await page.keyboard.press('ControlOrMeta+Shift+c');
	const picker = page.locator('#caller .stanza-editor-color-picker');
	await expect(picker).toBeVisible();
	await expect(picker.locator('option')).toHaveCount(3);
	await picker.evaluate(element => { element.dataset.retained = 'true'; });
	const hue = picker.getByRole('slider', { name: 'Hue', exact: true });
	await hue.focus();
	await hue.evaluate(element => {
		(element as HTMLInputElement).value = '119';
		element.dispatchEvent(new Event('input', { bubbles: true }));
	});
	await hue.press('ArrowRight');
	await expect(picker.getByRole('combobox', { name: 'Color format' })).toHaveValue('#00ff0080');
	await picker.getByRole('button', { name: 'Apply', exact: true }).click();
	await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.state('caller').value)).toBe('const color = #00ff0080;');
	await expect(picker).toBeHidden();
	await expect(page.locator('#caller .stanza-editor-input')).toBeFocused();
	await page.keyboard.press('ControlOrMeta+z');
	await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.state('caller').value)).toBe('const color = #ff000080;');
	await page.keyboard.press('ControlOrMeta+Shift+c');
	await expect(picker).toBeVisible();
	await expect(picker).toHaveAttribute('data-retained', 'true');
	await page.keyboard.press('Escape');
	await expect(picker).toBeHidden();
	await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	await expect(picker).toHaveCount(0);
	expect(errors).toEqual([]);
});

test('hover options control requests, delay and keyboard modifiers', async ({ page }) => {
	await page.clock.install();
	await page.goto('/standalone.html');
	await page.evaluate(() => {
		window.ashStandaloneIntegration.updateContributionOptions({ hover: { enabled: 'off', delay: 900 } });
		window.ashStandaloneIntegration.prepareLanguageRequest('hover');
	});
	const point = await page.evaluate(() => window.ashStandaloneIntegration.contributionPoint(2));
	await page.mouse.move(point.x, point.y);
	await page.clock.runFor(1000);
	expect(await page.evaluate(() => window.ashStandaloneIntegration.readLanguageRequests())).toEqual([]);
	await page.evaluate(() => window.ashStandaloneIntegration.updateContributionOptions({ hover: { enabled: 'on' } }));
	await page.clock.runFor(899);
	expect(await page.evaluate(() => window.ashStandaloneIntegration.readLanguageRequests())).toEqual([]);
	await page.clock.runFor(1);
	expect(await page.evaluate(() => window.ashStandaloneIntegration.readLanguageRequests())).toHaveLength(1);
	await page.evaluate(() => window.ashStandaloneIntegration.updateContributionOptions({ hover: { enabled: 'off' } }));
	expect((await page.evaluate(() => window.ashStandaloneIntegration.readLanguageRequests()))[0]!.aborted).toBe(true);
	await page.evaluate(() => window.ashStandaloneIntegration.finishLanguageRequest(0));
	const hover = page.locator('#caller .stanza-editor-hover');
	await expect(hover).toBeHidden();
	await page.evaluate(() => window.ashStandaloneIntegration.updateContributionOptions({ hover: { enabled: 'onKeyboardModifier', delay: 0 }, multiCursorModifier: 'ctrlCmd' }));
	await page.clock.runFor(1);
	expect(await page.evaluate(() => window.ashStandaloneIntegration.readLanguageRequests())).toHaveLength(1);
	await page.keyboard.down('Alt');
	await page.clock.runFor(1);
	expect(await page.evaluate(() => window.ashStandaloneIntegration.readLanguageRequests())).toHaveLength(2);
	await page.evaluate(() => window.ashStandaloneIntegration.finishLanguageRequest(1));
	await expect(hover).toBeVisible();
	await page.keyboard.up('Alt');
	await expect(hover).toBeHidden();
	await page.evaluate(() => window.ashStandaloneIntegration.dispose());
});

test.describe('folding command routing', () => {
	const text = 'first\n  inner\n    body\n  sibling\nsecond\n  inner\n    body\n  sibling\nlast';

	test.afterEach(async ({ page }) => {
		await page.evaluate(() => window.ashStandaloneIntegration?.dispose());
	});

	test('recursive and all actions update every selected scope, including read-only editors', async ({ page }) => {
		await page.goto('/standalone.html');
		await page.evaluate(text => {
			window.ashStandaloneIntegration.prepareClipboard(text, [[1, 1, 1, 1], [5, 1, 5, 1]]);
			window.ashStandaloneIntegration.updateContributionOptions({ foldingStrategy: 'indentation', readOnly: true });
		}, text);
		const lines = page.locator('#caller .view-line');
		await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.foldRecursively'));
		await expect(lines).toHaveCount(3);
		await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.unfold'));
		await expect(lines).toHaveCount(7);
		await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.unfoldRecursively'));
		await expect(lines).toHaveCount(9);
		await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.foldAll'));
		await expect(lines).toHaveCount(3);
		await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.unfoldAll'));
		await expect(lines).toHaveCount(9);
		await page.evaluate(() => window.ashStandaloneIntegration.updateContributionOptions({ folding: false }));
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readFoldingCommandState())).supported).toBe(false);
		await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.foldAll'));
		await expect(lines).toHaveCount(9);
		await page.evaluate(() => window.ashStandaloneIntegration.updateContributionOptions({ folding: true }));
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readFoldingCommandState())).supported).toBe(true);
		await page.evaluate(() => window.ashStandaloneIntegration.setFoldingModelAttached(false));
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readFoldingCommandState())).supported).toBe(false);
		await page.evaluate(() => window.ashStandaloneIntegration.setFoldingModelAttached(true));
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readFoldingCommandState())).supported).toBe(true);
		await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.foldAll'));
		await expect(lines).toHaveCount(3);
		expect((await page.evaluate(() => window.ashStandaloneIntegration.state('caller'))).value).toBe(text);
	});

	test('default and custom chords share timeout, escape and focus cancellation', async ({ page }) => {
		await page.goto('/standalone.html');
		await page.clock.install();
		await page.evaluate(text => {
			window.ashStandaloneIntegration.prepareClipboard(text, [[1, 1, 1, 1]]);
			window.ashStandaloneIntegration.prepareFoldingKeybinding();
		}, text);
		await page.locator('#caller .stanza-editor-input').focus();
		const lines = page.locator('#caller .view-line');
		await page.keyboard.press('ControlOrMeta+k');
		await page.keyboard.press('ControlOrMeta+0');
		await expect(lines).toHaveCount(3);
		await page.keyboard.press('ControlOrMeta+k');
		await page.keyboard.press('ControlOrMeta+j');
		await expect(lines).toHaveCount(9);
		await page.keyboard.press('F9');
		await page.keyboard.press('F10');
		await expect(lines).toHaveCount(3);
		await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.unfoldAll'));
		await expect(lines).toHaveCount(9);
		for (const reason of ['timeout', 'escape', 'blur'] as const) {
			await page.keyboard.press('ControlOrMeta+k');
			expect((await page.evaluate(() => window.ashStandaloneIntegration.readFoldingCommandState())).inChordMode).toBe(true);
			if (reason === 'timeout') await page.clock.runFor(5001);
			if (reason === 'escape') await page.keyboard.press('Escape');
			if (reason === 'blur') {
				await page.locator('#owned .stanza-editor-input').focus();
				await page.locator('#caller .stanza-editor-input').focus();
			}
			expect((await page.evaluate(() => window.ashStandaloneIntegration.readFoldingCommandState())).inChordMode).toBe(false);
			await page.keyboard.press('ControlOrMeta+0');
			await expect(lines).toHaveCount(9);
		}
	});

	test('level actions preserve the selected scope and do not collapse deeper levels', async ({ page }) => {
		await page.goto('/standalone.html');
		await page.evaluate(text => {
			window.ashStandaloneIntegration.prepareClipboard(text, [[2, 1, 2, 1]]);
			window.ashStandaloneIntegration.updateContributionOptions({ foldingStrategy: 'indentation' });
		}, text);
		await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.foldLevel2'));
		await expect(page.locator('#caller .view-line[data-logical-line-index="2"]')).toHaveCount(1);
		await expect(page.locator('#caller .view-line[data-logical-line-index="6"]')).toHaveCount(0);
		await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.foldLevel1'));
		await expect(page.locator('#caller .view-line')).toHaveCount(6);
		await page.evaluate(() => {
			window.ashStandaloneIntegration.setFoldingSelections([[5, 1, 5, 1]]);
			window.ashStandaloneIntegration.invokeLanguageAction('editor.unfold');
		});
		await expect(page.locator('#caller .view-line')).toHaveCount(8);
		for (let level = 3; level <= 7; level++) {
			await page.evaluate(level => window.ashStandaloneIntegration.runLineAction(`editor.foldLevel${level}`), level);
		}
		await expect(page.locator('#caller .view-line')).toHaveCount(8);
	});

	test('manual range actions collapse each selection, preserve text and remove selected ranges', async ({ page }) => {
		await page.goto('/standalone.html');
		const value = 'one\ntwo\nthree\nfour\nfive\nsix\nseven';
		await page.evaluate(value => {
			window.ashStandaloneIntegration.prepareClipboard(value, [[1, 1, 4, 1], [5, 1, 6, 4]]);
			window.ashStandaloneIntegration.updateContributionOptions({ foldingStrategy: 'indentation' });
		}, value);
		await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.createFoldingRangeFromSelection'));
		await expect(page.locator('#caller .view-line')).toHaveCount(4);
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).selections).toEqual(['[1,1 -> 1,1]', '[5,1 -> 5,1]']);
		await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.removeManualFoldingRanges'));
		await expect(page.locator('#caller .view-line')).toHaveCount(7);
		expect((await page.evaluate(() => window.ashStandaloneIntegration.state('caller'))).value).toBe(value);
	});

	test('multiple cursors in one fold collapse it once before moving to the parent', async ({ page }) => {
		await page.goto('/standalone.html');
		await page.evaluate(text => {
			window.ashStandaloneIntegration.prepareClipboard(text, [[2, 1, 2, 1], [3, 1, 3, 1], [6, 1, 6, 1]]);
			window.ashStandaloneIntegration.updateContributionOptions({ foldingStrategy: 'indentation' });
		}, text);
		await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.fold'));
		await expect(page.locator('#caller .view-line')).toHaveCount(7);
		await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.fold'));
		await expect(page.locator('#caller .view-line')).toHaveCount(3);
	});

	test('action arguments select zero-based lines and count levels in both directions', async ({ page }) => {
		await page.goto('/standalone.html');
		await page.evaluate(text => {
			window.ashStandaloneIntegration.prepareClipboard(text, [[1, 1, 1, 1]]);
			window.ashStandaloneIntegration.updateContributionOptions({ foldingStrategy: 'indentation' });
		}, text);
		const input = page.locator('#caller .stanza-editor-input');
		await input.focus();
		const lines = page.locator('#caller .view-line');
		await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.fold', { levels: 2, selectionLines: [4] }));
		await expect(lines).toHaveCount(6);
		await expect(page.locator('#caller .view-line[data-logical-line-index="2"]')).toHaveCount(1);
		await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.unfold', { levels: 1, selectionLines: [4] }));
		await expect(lines).toHaveCount(8);
		await expect(page.locator('#caller .view-line[data-logical-line-index="6"]')).toHaveCount(0);
		await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.unfold', { levels: 2, direction: 'up', selectionLines: [6] }));
		await expect(lines).toHaveCount(9);
		await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.fold', { levels: 2, direction: 'up', selectionLines: [2] }));
		await expect(lines).toHaveCount(6);
		await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.unfold', { selectionLines: [0] }));
		await expect(lines).toHaveCount(8);
		await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.unfold', { selectionLines: [1] }));
		await expect(lines).toHaveCount(9);
		expect(await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).toEqual({ value: text, selections: ['[1,1 -> 1,1]'] });
		await expect(input).toBeFocused();
	});

	test('explicit levels and direction keep repeated folds in the requested scope', async ({ page }) => {
		await page.goto('/standalone.html');
		await page.evaluate(text => {
			window.ashStandaloneIntegration.prepareClipboard(text, [[5, 1, 5, 1]]);
			window.ashStandaloneIntegration.updateContributionOptions({ foldingStrategy: 'indentation' });
		}, text);
		const lines = page.locator('#caller .view-line');
		await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.fold', { levels: 0, selectionLines: [1, 2, 1] }));
		await expect(lines).toHaveCount(8);
		await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.fold', { direction: 'down', selectionLines: [1] }));
		await expect(lines).toHaveCount(8);
		await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.fold', { selectionLines: [1] }));
		await expect(lines).toHaveCount(6);
		await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.unfold', { levels: 0, selectionLines: [0] }));
		await expect(lines).toHaveCount(8);
		await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.fold', { levels: 3, selectionLines: [-1, 99, 8] }));
		await expect(lines).toHaveCount(8);
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).selections).toEqual(['[5,1 -> 5,1]']);
	});

	test('custom keybindings deliver folding arguments through the command service', async ({ page }) => {
		await page.goto('/standalone.html');
		await page.evaluate(text => {
			window.ashStandaloneIntegration.prepareClipboard(text, [[1, 1, 1, 1]]);
			window.ashStandaloneIntegration.updateContributionOptions({ foldingStrategy: 'indentation' });
			window.ashStandaloneIntegration.prepareFoldingKeybinding('editor.fold', { levels: 2, selectionLines: [4] });
		}, text);
		const input = page.locator('#caller .stanza-editor-input');
		await input.focus();
		await page.keyboard.press('F9');
		await page.keyboard.press('F10');
		await expect(page.locator('#caller .view-line')).toHaveCount(6);
		await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.unfold', { selectionLines: [4] }));
		await expect(page.locator('#caller .view-line')).toHaveCount(8);
		await expect(input).toBeFocused();
	});

	test('invalid folding arguments reject without changes and empty line lists retain their scope', async ({ page }) => {
		await page.goto('/standalone.html');
		await page.evaluate(text => {
			window.ashStandaloneIntegration.prepareClipboard(text, [[1, 1, 1, 1]]);
			window.ashStandaloneIntegration.updateContributionOptions({ foldingStrategy: 'indentation' });
		}, text);
		const rejected = await page.evaluate(async () => {
			const errors: string[] = [];
			for (const command of ['editor.fold', 'editor.unfold']) {
				for (const args of [null, false, 0, '', [], 'invalid', { levels: '2' }, { levels: NaN }, { direction: 2 }, { selectionLines: [0, '4'] }]) {
					try {
						await window.ashStandaloneIntegration.runLineAction(command, args);
						errors.push('accepted');
					} catch (error) {
						errors.push((error as Error).name);
					}
				}
			}
			return errors;
		});
		expect(rejected).toEqual(Array(20).fill('TypeError'));
		const lines = page.locator('#caller .view-line');
		await expect(lines).toHaveCount(9);
		await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.fold', { selectionLines: [] }));
		await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.fold', { levels: 10, direction: 'up', selectionLines: [] }));
		await expect(lines).toHaveCount(9);
		await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.fold', { levels: 2, selectionLines: [] }));
		await expect(lines).toHaveCount(3);
		await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.unfold', { levels: 3, selectionLines: [] }));
		await expect(lines).toHaveCount(9);
	});

	test('command service rejects malformed folding arguments before changing editor state', async ({ page }) => {
		await page.goto('/standalone.html');
		await page.evaluate(text => {
			window.ashStandaloneIntegration.prepareClipboard(text, [[1, 1, 1, 1]]);
			window.ashStandaloneIntegration.updateContributionOptions({ foldingStrategy: 'indentation' });
		}, text);
		await page.locator('#caller .stanza-editor-input').focus();
		await page.evaluate(() => window.ashStandaloneIntegration.runFoldingCommand('editor.fold', { levels: 2, selectionLines: [4] }));
		await expect(page.locator('#caller .view-line')).toHaveCount(6);
		const errors = await page.evaluate(async () => {
			const rejected: string[] = [];
			for (const command of ['editor.fold', 'editor.unfold']) {
				for (const args of [null, false, 0, '', { levels: '2' }, { direction: false }, { selectionLines: [null] }]) {
					try {
						await window.ashStandaloneIntegration.runFoldingCommand(command, args);
						rejected.push('accepted');
					} catch (error) {
						rejected.push((error as Error).name);
					}
				}
			}
			return rejected;
		});
		expect(errors).toEqual(Array(14).fill('TypeError'));
		await expect(page.locator('#caller .view-line')).toHaveCount(6);
		await page.evaluate(() => window.ashStandaloneIntegration.runFoldingCommand('editor.unfold', { levels: 2, selectionLines: [4] }));
		await expect(page.locator('#caller .view-line')).toHaveCount(9);
		await page.evaluate(() => window.ashStandaloneIntegration.runFoldingCommand('editor.fold'));
		await expect(page.locator('#caller .view-line')).toHaveCount(6);
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).value).toBe(text);
	});

	test('public folding actions expose argument descriptions and schemas', async ({ page }) => {
		await page.goto('/standalone.html');
		const metadata = await page.evaluate(() => ['editor.fold', 'editor.unfold'].map(command => window.ashStandaloneIntegration.readFoldingMetadata(command)));
		expect(metadata.map(entry => entry.description)).toEqual([
			{ original: 'Collapse the selected folding ranges.', value: 'Collapse the selected folding ranges.' },
			{ original: 'Expand the selected folding ranges.', value: 'Expand the selected folding ranges.' },
		]);
		for (const [index, entry] of metadata.entries()) {
			expect(entry.args[0]?.name).toBe('Folding options');
			expect(entry.args[0]?.description).toContain('zero-based lines');
			expect(entry.args[0]?.schema).toEqual({
				type: 'object',
				properties: {
					levels: index === 0 ? { type: 'number' } : { type: 'number', default: 1 },
					direction: index === 0 ? { type: 'string', enum: ['up', 'down'] } : { type: 'string', enum: ['up', 'down'], default: 'down' },
					selectionLines: { type: 'array', items: { type: 'number' } },
				},
			});
		}
	});
});

test('folding strategy cancels providers and region limits update hidden lines', async ({ page }) => {
	await page.goto('/standalone.html');
	await page.evaluate(() => {
		window.ashStandaloneIntegration.updateContributionOptions({ foldingStrategy: 'indentation', showFoldingControls: 'always' });
		window.ashStandaloneIntegration.prepareContributionRequests('folding');
	});
	expect(await page.evaluate(() => window.ashStandaloneIntegration.readContributionRequests())).toEqual([]);
	await page.evaluate(() => window.ashStandaloneIntegration.updateContributionOptions({ foldingStrategy: 'auto' }));
	await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readContributionRequests().length)).toBeGreaterThan(0);
	await page.evaluate(async () => {
		window.ashStandaloneIntegration.updateContributionOptions({ foldingStrategy: 'indentation' });
		const requests = window.ashStandaloneIntegration.readContributionRequests();
		for (let index = 0; index < requests.length; index++) await window.ashStandaloneIntegration.finishContributionRequest(index);
	});
	expect((await page.evaluate(() => window.ashStandaloneIntegration.readContributionRequests())).every(request => request.aborted)).toBe(true);
	await page.evaluate(() => window.ashStandaloneIntegration.prepareClipboard('first\n  child\nsecond\n  child\nthird\n  child'));
	const controls = page.locator('#caller .ash-icon-folding-expanded');
	await expect(controls).toHaveCount(3);
	await controls.last().click();
	await expect(page.locator('#caller .view-line[data-logical-line-index="5"]')).toHaveCount(0);
	await page.evaluate(() => window.ashStandaloneIntegration.updateContributionOptions({ foldingMaximumRegions: 1 }));
	await expect(controls).toHaveCount(1);
	await expect(page.locator('#caller .view-line[data-logical-line-index="5"]')).toHaveCount(1);
	await page.evaluate(() => window.ashStandaloneIntegration.updateContributionOptions({ foldingMaximumRegions: 3 }));
	await expect(controls).toHaveCount(3);
	await page.evaluate(() => {
		window.ashStandaloneIntegration.prepareClipboard('first\n  inner\n    child\nsecond\n  child');
		window.ashStandaloneIntegration.updateContributionOptions({ foldingMaximumRegions: 2 });
	});
	await expect(controls).toHaveCount(2);
	await controls.last().click();
	await expect(page.locator('#caller .view-line[data-logical-line-index="4"]')).toHaveCount(0);
	await page.evaluate(() => window.ashStandaloneIntegration.dispose());
});

for (const kind of ['hover', 'selection'] as const) {
	for (const reason of ['text', 'selection', 'language', 'provider', 'model', 'dispose', 'blur'] as const) {
		test(`${kind} provider request cancels on ${reason} and rejects late results`, async ({ page }) => {
			await page.goto('/standalone.html');
			await page.evaluate(kind => window.ashStandaloneIntegration.prepareLanguageRequest(kind), kind);
			if (kind === 'hover') {
				const point = await page.evaluate(() => window.ashStandaloneIntegration.languageHoverPoint());
				await page.mouse.move(point.x, point.y);
			} else {
				await page.keyboard.press('ControlOrMeta+Shift+ArrowRight');
			}
			await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readLanguageRequests())).toEqual([{ languageId: 'plaintext', aborted: false }]);
			await page.evaluate(reason => window.ashStandaloneIntegration.changeLanguageRequest(reason), reason);
			await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readLanguageRequests())).toEqual([{ languageId: 'plaintext', aborted: true }]);
			const before = await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing());
			await page.evaluate(() => window.ashStandaloneIntegration.finishLanguageRequest(0));
			await expect(page.locator('#caller .stanza-editor-hover:not([hidden])')).toHaveCount(0);
			expect(await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing())).toEqual(before);
			await page.evaluate(() => window.ashStandaloneIntegration.dispose());
		});
	}
	test(`${kind} provider uses the current model language`, async ({ page }) => {
		await page.goto('/standalone.html');
		await page.evaluate(kind => window.ashStandaloneIntegration.prepareLanguageRequest(kind), kind);
		await page.evaluate(() => window.ashStandaloneIntegration.changeLanguageRequest('language'));
		if (kind === 'hover') {
			const point = await page.evaluate(() => window.ashStandaloneIntegration.languageHoverPoint());
			await page.mouse.move(point.x, point.y);
		} else {
			await page.keyboard.press('ControlOrMeta+Shift+ArrowRight');
		}
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readLanguageRequests())).toEqual([{ languageId: 'typescript', aborted: false }]);
		await page.evaluate(() => window.ashStandaloneIntegration.finishLanguageRequest(0));
		if (kind === 'hover') {
			await expect(page.locator('#caller .stanza-editor-hover')).toHaveText('hover: typescript');
		} else {
			expect((await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing())).selection).toBe('[1,1 -> 1,13]');
		}
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	});
}

for (const kind of ['definition', 'call', 'type', 'symbols'] as const) {
	const shortcut = { definition: 'F12', call: 'Alt+Shift+h', type: 'Alt+Shift+t', symbols: 'ControlOrMeta+Shift+o' }[kind];
	for (const reason of ['text', 'selection', 'language', 'provider', 'model', 'dispose', 'blur'] as const) {
		test(`${kind} provider cancels on ${reason} without applying late results`, async ({ page }) => {
			await page.goto('/standalone.html?symbolIconsOff');
			await page.evaluate(kind => window.ashStandaloneIntegration.prepareLanguageRequest(kind), kind);
			await page.keyboard.press(shortcut);
			await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readLanguageRequests().slice(0, 1))).toEqual([{ languageId: 'plaintext', aborted: false }]);
			await page.evaluate(reason => window.ashStandaloneIntegration.changeLanguageRequest(reason), reason);
			await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readLanguageRequests().slice(0, 1))).toEqual([{ languageId: 'plaintext', aborted: true }]);
			const before = await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing());
			await page.evaluate(() => window.ashStandaloneIntegration.finishLanguageRequest(0));
			expect(await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing())).toEqual(before);
			await expect(page.locator('#caller .stanza-editor-peek-view, #caller .stanza-editor-goto-symbol:not([hidden])')).toHaveCount(0);
			await page.evaluate(() => window.ashStandaloneIntegration.dispose());
		});
	}
	test(`${kind} provider queries the current language and applies the current response`, async ({ page }) => {
		await page.goto('/standalone.html?symbolIconsOff');
		await page.evaluate(kind => window.ashStandaloneIntegration.prepareLanguageRequest(kind), kind);
		await page.evaluate(() => window.ashStandaloneIntegration.changeLanguageRequest('language'));
		await page.keyboard.press(shortcut);
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readLanguageRequests().slice(0, 1))).toEqual([{ languageId: 'typescript', aborted: false }]);
		await page.evaluate(() => window.ashStandaloneIntegration.finishLanguageRequest(0));
		if (kind === 'definition') {
			expect((await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing())).selection).toBe('[1,7 -> 1,13]');
		} else if (kind === 'symbols') {
			await expect(page.locator('#caller .stanza-editor-goto-symbol-item')).toHaveText('second');
		} else {
			await expect(page.locator('#caller .stanza-editor-language-hierarchy-item')).toHaveText('root');
			await page.locator('#caller .stanza-editor-language-hierarchy-expand').first().click();
			await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readLanguageRequests())).toHaveLength(2);
			await page.keyboard.press('Escape');
			expect((await page.evaluate(() => window.ashStandaloneIntegration.readLanguageRequests())).every(request => request.aborted)).toBe(true);
			await page.evaluate(() => window.ashStandaloneIntegration.finishLanguageRequest(1));
			await expect(page.locator('#caller .stanza-editor-peek-view')).toHaveCount(0);
		}
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	});
}


test('signature trigger metadata distinguishes initial and repeated triggers and carries active hints', async ({ page }) => {
	await page.goto('/standalone.html');
	await page.evaluate(() => window.ashStandaloneIntegration.prepareParameterHints(true, true, ['['], [':']));
	await page.keyboard.type('(:');
	await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 20)));
	expect(await page.evaluate(() => window.ashStandaloneIntegration.readParameterHintRequests())).toEqual([]);
	await page.keyboard.type('[');
	await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readParameterHintRequests().length)).toBe(1);
	expect((await page.evaluate(() => window.ashStandaloneIntegration.readParameterHintRequests()))[0]!.context).toEqual({ kind: 'triggerCharacter', triggerCharacter: '[', isRetrigger: false });
	await page.evaluate(() => window.ashStandaloneIntegration.finishParameterHintRequest(0, 'hints'));
	await page.keyboard.type(':');
	await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readParameterHintRequests().length)).toBe(2);
	expect((await page.evaluate(() => window.ashStandaloneIntegration.readParameterHintRequests()))[1]!.context).toMatchObject({ kind: 'triggerCharacter', triggerCharacter: ':', isRetrigger: true, activeSignatureHelp: { signatures: [{ label: 'call(value): plaintext' }] } });
	await page.evaluate(() => window.ashStandaloneIntegration.dispose());
});

test('signature providers without trigger metadata are invoked explicitly', async ({ page }) => {
	await page.goto('/standalone.html');
	await page.evaluate(() => window.ashStandaloneIntegration.prepareParameterHints(true, true, []));
	await page.keyboard.type('(');
	await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 20)));
	expect(await page.evaluate(() => window.ashStandaloneIntegration.readParameterHintRequests())).toEqual([]);
	await page.keyboard.press('ControlOrMeta+Shift+Space');
	await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readParameterHintRequests().length)).toBe(1);
	await page.evaluate(() => window.ashStandaloneIntegration.dispose());
});


for (const kind of ['rename', 'quickFix'] as const) {
	test(`${kind} public action uses its editor and tracks writable provider availability`, async ({ page }) => {
		await page.goto('/standalone.html');
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readLanguageActions()))[kind]).toBe(false);
		await page.evaluate(kind => {
			if (kind === 'rename') window.ashStandaloneIntegration.prepareRenameRequests('prepare');
			else window.ashStandaloneIntegration.prepareCodeActionRequests('query');
			window.ashStandaloneIntegration.changeLanguageRequest('blur');
		}, kind);
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readLanguageActions()))[kind]).toBe(true);
		await page.evaluate(kind => window.ashStandaloneIntegration.invokeLanguageAction(`editor.action.${kind}`), kind);
		await expect.poll(() => page.evaluate(kind => kind === 'rename'
			? window.ashStandaloneIntegration.readRenameRequests().length
			: window.ashStandaloneIntegration.readCodeActionRequests().length, kind)).toBe(1);
		if (kind === 'rename') {
			await page.evaluate(() => window.ashStandaloneIntegration.finishRenameRequest(0, 'edit'));
			await expect(page.locator('#caller .stanza-editor-rename-input')).toBeFocused();
			await page.evaluate(() => window.ashStandaloneIntegration.invokeLanguageAction('cancelRenameInput'));
			await expect(page.locator('#caller .stanza-editor-rename')).toBeHidden();
		} else {
			await page.evaluate(() => window.ashStandaloneIntegration.finishCodeActionRequest(0, 'edit'));
			await expect(page.locator('#caller .stanza-editor-code-action')).toBeVisible();
		}
		await page.evaluate(kind => {
			if (kind === 'rename') window.ashStandaloneIntegration.changeRenameState('readonly');
			else window.ashStandaloneIntegration.changeCodeActionState('readonly');
		}, kind);
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readLanguageActions()))[kind]).toBe(false);
		await page.evaluate(kind => window.ashStandaloneIntegration.invokeLanguageAction(`editor.action.${kind}`), kind);
		expect(await page.evaluate(kind => kind === 'rename'
			? window.ashStandaloneIntegration.readRenameRequests().length
			: window.ashStandaloneIntegration.readCodeActionRequests().length, kind)).toBe(1);
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	});
}
