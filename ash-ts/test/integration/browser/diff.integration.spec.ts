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
	await expect(page.locator('#single [aria-live="polite"]')).toContainText('2');
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
	await page.evaluate(() => window.ashDiffIntegration.setDiffWhitespace(false));
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().quickDiffChanges)).toBe(1);
	expect(await page.evaluate(() => window.ashDiffIntegration.read().baselineRequests)).toBe(baselineRequests);
});

test('cancels expensive Worker computation and completes the next comparison', async ({ page }) => {
	await page.goto('/diff.html');
	await expect(page.locator('#single .stanza-diff-editor-row.modified')).toHaveCount(1);
	expect(await page.evaluate(() => window.ashDiffIntegration.cancelLargeComparison())).toEqual({ outcome: 'CancellationError', kinds: ['modified'] });
});
