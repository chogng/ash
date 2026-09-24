import { expect, test } from '@playwright/test';

test.afterEach(async ({ page }) => {
	await page.evaluate(() => window.ashDiffIntegration?.dispose());
});

test('frontend diff renders Unicode inline changes and Multi Diff without a backend', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto('/diff.html');
	await expect(page.locator('#single .stanza-diff-editor-inline.removed')).toHaveText('😀');
	await expect(page.locator('#single .stanza-diff-editor-inline.added')).toHaveText('🤖');
	await expect(page.locator('#multi .stanza-multi-diff-editor-section')).toHaveCount(2);
	await expect(page.locator('#multi .stanza-diff-editor-row.removed')).toHaveCount(1);
	await page.locator('#single .stanza-diff-editor').focus();
	await page.keyboard.press('F7');
	await expect(page.locator('#single .stanza-diff-editor-row.modified')).toHaveClass(/active/);
	await expect(page.locator('#single .stanza-diff-editor-accessibility-status')).toContainText('2');
	expect(errors).toEqual([]);
});

test('word wrap keeps both diff columns, scrolling, highlights, and the overview aligned', async ({ page }) => {
	await page.goto('/diff.html');
	const original = `same\n${'before '.repeat(70)}😀 tail\nold end`;
	const modified = `same\n${'before '.repeat(70)}🤖 tail\nnew end`;
	await page.evaluate(([left, right]) => window.ashDiffIntegration.setComparisonText(left, right), [original, modified]);
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().state)).toBe('ready');
	const editor = page.locator('#single .stanza-diff-editor');
	await editor.focus();
	await page.keyboard.press('Alt+Z');
	await expect(editor).toHaveClass(/word-wrapped/);
	const row = page.locator('#single .stanza-diff-editor-row.modified').first();
	await expect(row.locator('.stanza-diff-editor-cell.original .stanza-diff-editor-visual-line')).not.toHaveCount(1);
	await expect(row.locator('.stanza-diff-editor-cell.modified .stanza-diff-editor-visual-line')).not.toHaveCount(1);
	const geometry = await row.evaluate(element => {
		const left = element.querySelector<HTMLElement>('.stanza-diff-editor-cell.original')!;
		const right = element.querySelector<HTMLElement>('.stanza-diff-editor-cell.modified')!;
		return { row: element.getBoundingClientRect().height, left: left.getBoundingClientRect().height, right: right.getBoundingClientRect().height };
	});
	expect(geometry.row).toBeGreaterThan(20);
	expect(geometry.left).toBe(geometry.row);
	expect(geometry.right).toBe(geometry.row);
	await page.locator('#single').evaluate(element => { element.style.width = '400px'; });
	await expect.poll(() => row.evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThan(geometry.row);
	await expect(row.locator('.stanza-diff-editor-inline.removed')).toContainText('😀');
	await expect(row.locator('.stanza-diff-editor-inline.added')).toContainText('🤖');
	await page.keyboard.press('F7');
	await page.keyboard.press('F7');
	await expect(page.locator('#single .stanza-diff-editor-accessibility-status')).toContainText('Change 2 of 2');
	await editor.evaluate(element => { element.scrollTop = element.scrollHeight; element.dispatchEvent(new Event('scroll')); });
	await expect(page.locator('#single .stanza-diff-editor-row.modified').last()).toBeVisible();
	const marker = page.locator('#single .stanza-diff-overview-lane.modified .stanza-diff-overview-marker.inserted').first();
	const markerTop = await marker.evaluate(element => Number.parseFloat((element as HTMLElement).style.top));
	const contentHeight = await page.locator('#single .stanza-diff-editor-content').evaluate(element => element.getBoundingClientRect().height);
	expect(markerTop).toBeCloseTo(20 / contentHeight * 100, 2);
	await page.keyboard.press('Alt+Z');
	await expect(editor).not.toHaveClass(/word-wrapped/);
	await expect(page.locator('#single .stanza-diff-editor-visual-line')).toHaveCount(0);
});

test('multi diff wraps paired rows and repositions sections through resize and collapse', async ({ page }) => {
	await page.goto('/diff.html');
	const original = `same\n${'before '.repeat(70)}😀 tail\nsame end`;
	const modified = `same\n${'before '.repeat(70)}🤖 tail\nsame end`;
	await page.evaluate(([left, right]) => window.ashDiffIntegration.setComparisonText(left, right), [original, modified]);
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().state)).toBe('ready');
	const editor = page.locator('#multi .stanza-multi-diff-editor');
	await editor.focus();
	await page.keyboard.press('Alt+Z');
	await expect(editor).toHaveClass(/word-wrapped/);
	const sections = editor.locator('.stanza-multi-diff-editor-section');
	const firstRow = sections.first().locator('.stanza-diff-editor-row.modified');
	await expect(firstRow.locator('.stanza-diff-editor-visual-line').first()).toBeVisible();
	const firstHeight = await firstRow.evaluate(element => element.getBoundingClientRect().height);
	expect(firstHeight).toBeGreaterThan(20);
	const sectionGap = await sections.evaluateAll(elements => elements[1]!.getBoundingClientRect().top - elements[0]!.getBoundingClientRect().bottom);
	expect(sectionGap).toBe(8);
	await page.locator('#multi').evaluate(element => { element.style.width = '400px'; });
	await expect.poll(() => firstRow.evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThan(firstHeight);
	const resizedGap = await sections.evaluateAll(elements => elements[1]!.getBoundingClientRect().top - elements[0]!.getBoundingClientRect().bottom);
	expect(resizedGap).toBe(8);
	await sections.first().locator('.stanza-multi-diff-editor-header-toggle').click();
	await expect(sections.first().locator('.stanza-multi-diff-editor-header-toggle')).toHaveAttribute('aria-expanded', 'false');
	await editor.focus();
	await page.keyboard.press('F7');
	await expect(sections.first().locator('.stanza-multi-diff-editor-header-toggle')).toHaveAttribute('aria-expanded', 'true');
	await page.keyboard.press('F7');
	await expect(editor.locator('.stanza-multi-diff-editor-accessibility-status')).toContainText('Change 2 of 2');
	await expect(sections.nth(1).locator('.stanza-diff-editor-row.active')).toHaveCount(1);
	await editor.focus();
	await page.keyboard.press('Alt+Z');
	await expect(editor).not.toHaveClass(/word-wrapped/);
	await expect(editor.locator('.stanza-diff-editor-visual-line')).toHaveCount(0);
});

test('unsaved input updates Diff and Quick Diff locally using the existing baseline', async ({ page }) => {
	await page.goto('/diff.html');
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().quickDiffReady)).toBe(true);
	const before = await page.evaluate(() => window.ashDiffIntegration.read());
	await page.getByRole('textbox', { name: 'Modified text' }).fill('obsolete');
	await page.getByRole('textbox', { name: 'Modified text' }).fill('same\nbefore 😀 after\nlast');
	await expect.poll(() => page.evaluate(() => {
		const state = window.ashDiffIntegration.read();
		return state.state === 'ready' && state.quickDiffReady && state.resultVersion === state.version;
	})).toBe(true);
	const after = await page.evaluate(() => window.ashDiffIntegration.read());
	expect(after.kinds).toEqual(['unchanged', 'unchanged', 'unchanged']);
	expect(after.quickDiffChanges).toBe(0);
	expect(after.baselineRequests).toBe(before.baselineRequests);
	await expect(page.locator('#single .stanza-diff-editor-inline')).toHaveCount(0);
	await expect(page.locator('#multi .stanza-diff-editor-row.modified')).toHaveCount(0);
});

test('Quick Diff inherits whitespace settings without reading the baseline again', async ({ page }) => {
	await page.goto('/diff.html');
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().quickDiffReady)).toBe(true);
	const baselineRequests = await page.evaluate(() => window.ashDiffIntegration.read().baselineRequests);
	await page.getByRole('textbox', { name: 'Modified text' }).fill('same\nbefore 😀 after\nlast ');
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().quickDiffChanges)).toBe(1);
	await page.evaluate(() => window.ashDiffIntegration.setQuickDiffWhitespace('inherit'));
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().quickDiffChanges)).toBe(0);
	await page.evaluate(() => window.ashDiffIntegration.setDiffWhitespaceForLanguage('typescript', false));
	await page.evaluate(() => window.ashDiffIntegration.setModifiedLanguage('typescript'));
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().quickDiffChanges)).toBe(1);
	await page.evaluate(() => window.ashDiffIntegration.setDiffWhitespaceForLanguage('typescript', true));
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().quickDiffChanges)).toBe(0);
	await page.evaluate(() => window.ashDiffIntegration.setDiffWhitespace(false));
	await page.evaluate(() => window.ashDiffIntegration.setModifiedLanguage('javascript'));
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().quickDiffChanges)).toBe(1);
	expect(await page.evaluate(() => window.ashDiffIntegration.read().baselineRequests)).toBe(baselineRequests);
});

test('cancels expensive Worker computation and completes the next comparison', async ({ page }) => {
	await page.goto('/diff.html');
	await expect(page.locator('#single .stanza-diff-editor-row.modified')).toHaveCount(1);
	expect(await page.evaluate(() => window.ashDiffIntegration.cancelLargeComparison())).toEqual({ outcome: 'CancellationError', kinds: ['modified'] });
});

test('the browser Worker compares text lines across CRLF and LF models', async ({ page }) => {
	await page.goto('/diff.html');
	expect(await page.evaluate(() => window.ashDiffIntegration.compareLineEndings())).toEqual({
		identical: false,
		changedLines: [[2, 2]],
		inlineColumns: [[1, 4]],
	});
});

test('a timed Worker result is marked incomplete in Diff and Multi Diff', async ({ page }) => {
	await page.goto('/diff.html');
	await page.evaluate(() => {
		document.documentElement.style.setProperty('--ash-warning-foreground', 'rgb(150, 80, 0)');
		document.documentElement.style.setProperty('--ash-editor-background', 'rgb(255, 255, 255)');
	});
	expect(await page.evaluate(() => window.ashDiffIntegration.showTimedComparison())).toBe(true);
	const warning = page.locator('#timed-single .stanza-diff-editor-incomplete-status');
	const multiWarning = page.locator('#timed-multi .stanza-multi-diff-editor-incomplete-status');
	await expect(warning).toBeVisible();
	await expect(warning).toContainText('Results may be incomplete');
	await expect(warning).toHaveAttribute('role', 'status');
	await expect(multiWarning).toBeVisible();
	await expect(multiWarning).toHaveText('Diff may be incomplete');
	await expect(warning).toHaveCSS('color', 'rgb(150, 80, 0)');
	await page.locator('#timed-single .stanza-diff-editor').evaluate(element => { element.scrollTop = 400; element.dispatchEvent(new Event('scroll')); });
	const positions = await page.evaluate(() => ({
		editorTop: document.querySelector('#timed-single .stanza-diff-editor')!.getBoundingClientRect().top,
		warningTop: document.querySelector('#timed-single .stanza-diff-editor-incomplete-status')!.getBoundingClientRect().top,
	}));
	expect(Math.abs(positions.warningTop - positions.editorTop)).toBeLessThan(2);
	await page.evaluate(() => {
		document.documentElement.style.setProperty('--ash-warning-foreground', 'rgb(255, 255, 255)');
		document.documentElement.style.setProperty('--ash-editor-background', 'rgb(0, 0, 0)');
	});
	await expect(warning).toHaveCSS('color', 'rgb(255, 255, 255)');
	await expect(warning).toHaveCSS('background-color', 'rgb(0, 0, 0)');
	await page.evaluate(() => window.ashDiffIntegration.setChineseLocale());
	await expect(warning).toHaveText('差异计算已达到时间上限，结果可能不完整。');
	await expect(multiWarning).toHaveText('差异结果可能不完整');
});
