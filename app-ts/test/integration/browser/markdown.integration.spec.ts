import { expect, test } from '@playwright/test';

test('Markdown honors raw HTML opt in and preserves safe parsed content', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto('/markdown.html');

	const plain = page.locator('#default .ash-markdown');
	const supported = page.locator('#html-supported .ash-markdown');
	await expect(plain).toBeVisible();
	await expect(supported).toBeVisible();
	await expect(plain.locator('em')).toHaveCount(0);
	await expect(supported.locator('em')).toHaveText('b');
	await expect(plain.locator('code')).toHaveText('<span>code</span>');
	await expect(plain.locator('.ash-markdown-checkbox input')).toBeChecked();
	await expect(plain.locator('a')).toHaveAttribute('href', 'https://example.com');
	expect(errors).toEqual([]);

	await page.evaluate(() => window.ashMarkdownIntegration.dispose());
	await expect(page.locator('.ash-markdown')).toHaveCount(0);
});
