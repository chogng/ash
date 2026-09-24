import { expect, test } from '@playwright/test';

test('a short dialog detail stays keyboard-accessible while it scrolls', async ({ page }) => {
	await page.setViewportSize({ width: 800, height: 300 });
	await page.goto('/dialog.html');
	const text = Array.from({ length: 26 }, (_, index) => `Line ${index + 1}`).join('\n');
	expect(text.length).toBeLessThan(1_025);
	await page.evaluate(detail => window.ashDialogIntegration.show(detail), text);

	const detail = page.locator('.ash-dialog-detail');
	await expect(detail).toBeVisible();
	await expect(detail).toHaveAttribute('tabindex', '0');
	expect(await detail.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
	const confirm = page.getByRole('button', { name: 'Confirm' });
	await confirm.focus();
	await page.keyboard.press('Shift+Tab');
	await expect(detail).toBeFocused();
	expect(await detail.evaluate(element => getComputedStyle(element).outlineStyle)).not.toBe('none');
	await page.keyboard.press('PageDown');
	await expect.poll(() => detail.evaluate(element => element.scrollTop)).toBeGreaterThan(0);

	await page.setViewportSize({ width: 800, height: 1_200 });
	await expect.poll(() => detail.evaluate(element => element.scrollHeight <= element.clientHeight)).toBe(true);
	await expect(detail).not.toHaveAttribute('tabindex');
	await confirm.focus();
	await page.keyboard.press('Shift+Tab');
	await expect(detail).not.toBeFocused();
	await page.getByRole('button', { name: 'Cancel' }).click();
	await expect(page.getByRole('dialog')).toHaveCount(0);
});
