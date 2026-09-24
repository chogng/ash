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
