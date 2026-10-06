import { expect, test } from '@playwright/test';

test('editing delivers extension document events, shows diagnostics and inserts triggered completion', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto('/extensionHost.html');
	try {
		await expect.poll(() => page.evaluate(() => window.extensionEditorIntegration.markers())).toEqual(['Bad word from extension']);
		await expect.poll(() => page.evaluate(() => window.extensionEditorIntegration.events().length)).toBe(1);
		await page.evaluate(() => window.extensionEditorIntegration.focus());
		await page.keyboard.type('.');
		const option = page.locator('.stanza-editor-completion-option').filter({ hasText: 'alpha_from_extension' });
		await expect(option).toBeVisible();
		await page.keyboard.press('Enter');
		await expect.poll(() => page.evaluate(() => window.extensionEditorIntegration.text())).toBe('bad.alpha');
		await expect.poll(() => page.evaluate(() => window.extensionEditorIntegration.events().length)).toBeGreaterThanOrEqual(3);
		const completions = await page.evaluate(() => window.extensionEditorIntegration.completions());
		expect(completions[0]).toMatchObject({ text: 'bad.', version: 2, context: { kind: 'triggerCharacter', triggerCharacter: '.' } });
		await page.evaluate(() => window.extensionEditorIntegration.close());
		await expect.poll(() => page.evaluate(() => window.extensionEditorIntegration.events().at(-1))).toMatchObject({ type: 'close', document: { text: 'bad.alpha' } });
		await expect.poll(() => page.evaluate(() => window.extensionEditorIntegration.markers())).toEqual([]);
		expect(errors).toEqual([]);
	} finally { await page.evaluate(() => window.extensionEditorIntegration.dispose()); }
});

test('stopping the extension clears its markers and completion contribution', async ({ page }) => {
	await page.goto('/extensionHost.html');
	try {
		await expect.poll(() => page.evaluate(() => window.extensionEditorIntegration.markers())).toHaveLength(1);
		await page.evaluate(() => { window.extensionEditorIntegration.stop(); window.extensionEditorIntegration.focus(); });
		await page.keyboard.press('Control+Space');
		await expect(page.locator('.stanza-editor-completion-option').filter({ hasText: 'alpha_from_extension' })).toHaveCount(0);
		expect(await page.evaluate(() => window.extensionEditorIntegration.markers())).toEqual([]);
		expect(await page.evaluate(() => window.extensionEditorIntegration.completions())).toEqual([]);
	} finally { await page.evaluate(() => window.extensionEditorIntegration.dispose()); }
});
