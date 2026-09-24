import { expect, test } from '@playwright/test';

test.use({
	userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1',
	hasTouch: true,
	isMobile: true,
	viewport: { width: 820, height: 1180 },
});

test('iPad keyboard control follows editability and returns touch focus to the editor', async ({ page }) => {
	await page.goto('/standalone.html?symbolIconsOff');
	const control = page.locator('#caller .stanza-editor-show-keyboard textarea');
	const widget = page.locator('#caller .stanza-editor-show-keyboard');
	await expect(control).toBeVisible();
	await expect(control).toHaveAttribute('role', 'button');
	await expect(control).toHaveAttribute('aria-label', 'Show Keyboard');
	await expect(widget).toHaveCSS('width', '44px');
	await expect(widget).toHaveCSS('height', '40px');
	await control.tap();
	await expect(page.locator('#caller .stanza-editor-input')).toBeFocused();

	await page.evaluate(() => window.ashStandaloneIntegration.setKeyboardReadOnly(true));
	await expect(control).toHaveCount(0);
	await page.evaluate(() => window.ashStandaloneIntegration.setKeyboardReadOnly(false));
	await expect(control).toBeVisible();

	await page.evaluate(() => window.ashStandaloneIntegration.setStickyTheme('ash-light'));
	const lightIcon = await widget.evaluate(element => getComputedStyle(element, '::before').maskImage);
	expect(lightIcon).not.toBe('none');
	await page.evaluate(() => window.ashStandaloneIntegration.setStickyTheme('ash-dark'));
	const darkIcon = await widget.evaluate(element => getComputedStyle(element, '::before').maskImage);
	expect(darkIcon).not.toBe(lightIcon);
	await page.evaluate(() => window.ashStandaloneIntegration.setStickyTheme('ash-high-contrast-dark'));
	await expect(widget).toHaveCSS('border-color', 'rgb(0, 127, 212)');
	await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	await expect(control).toHaveCount(0);
});
