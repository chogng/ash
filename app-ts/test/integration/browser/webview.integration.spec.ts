import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
	await page.goto('/webview.html');
});

test('queues messages until content is ready and preserves the page for identical HTML', async ({ page }) => {
	const frame = page.frameLocator('iframe[title="First view"]');
	await expect(frame.locator('output')).toHaveText('before mount');
	expect(await page.evaluate(() => window.ashWebviewIntegration.initialSent())).toBe(true);
	await frame.getByRole('textbox', { name: 'First input' }).fill('keep this state');
	await page.evaluate(() => window.ashWebviewIntegration.sameHtml());
	await expect(frame.getByRole('textbox', { name: 'First input' })).toHaveValue('keep this state');
	await expect.poll(() => page.evaluate(() => window.ashWebviewIntegration.received)).toEqual([
		{ view: 'first', message: 'before mount' },
	]);
});

test('replacement cancels queued old messages and sends to the new document', async ({ page }) => {
	await expect(page.frameLocator('iframe[title="First view"]').locator('output')).toHaveText('before mount');
	expect(await page.evaluate(() => window.ashWebviewIntegration.replace())).toEqual([false, true]);
	await expect(page.frameLocator('iframe[title="First view"]').locator('output')).toHaveText('replacement');
	await expect.poll(() => page.evaluate(() => window.ashWebviewIntegration.received)).toEqual([
		{ view: 'first', message: 'before mount' },
		{ view: 'first', message: 'replacement' },
	]);
});

test('tracks real iframe focus, forwards keyboard input and removes disposed instances', async ({ page }) => {
	const firstInput = page.frameLocator('iframe[title="First view"]').getByRole('textbox', { name: 'First input' });
	await firstInput.click();
	await expect.poll(() => page.evaluate(() => window.ashWebviewIntegration.active)).toBe('first');
	await firstInput.press('F1');
	await expect.poll(() => page.evaluate(() => window.ashWebviewIntegration.keyboard)).toContain('F1');
	await page.frameLocator('iframe[title="Second view"]').getByRole('textbox', { name: 'Second input' }).click();
	await expect.poll(() => page.evaluate(() => window.ashWebviewIntegration.active)).toBe('second');
	await page.getByRole('textbox', { name: 'Workbench input' }).click();
	await expect.poll(() => page.evaluate(() => window.ashWebviewIntegration.active)).toBeUndefined();
	await firstInput.click();
	await expect.poll(() => page.evaluate(() => window.ashWebviewIntegration.active)).toBe('first');
	expect(await page.evaluate(() => window.ashWebviewIntegration.disposeFirst())).toBe(false);
	await expect(page.locator('iframe')).toHaveCount(1);
	expect(await page.evaluate(() => ({
		active: window.ashWebviewIntegration.active,
		count: window.ashWebviewIntegration.count,
	}))).toEqual({ active: undefined, count: 1 });
	await page.evaluate(() => window.ashWebviewIntegration.focusSecond());
	await expect.poll(() => page.evaluate(() => window.ashWebviewIntegration.active)).toBe('second');
});
