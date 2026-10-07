import { expect, test } from '@playwright/test';

test('extension channel delivery and Chat link updates retain keyboard navigation and targets', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto('/dataChannel.html');
	const link = page.locator('a[href="https://example.com/issues/1"]');
	await expect(link).toHaveText('Issue one · #1 · Open · +2 −1');
	await expect(link).toHaveAccessibleName('Issue one · #1 · Open · +2 −1');
	await page.getByRole('button', { name: 'Publish edit event' }).click();
	await expect(page.getByRole('status', { name: 'Extension channel delivery' })).toHaveText('{"data":{"eventName":"inlineCompletion.endOfLife","data":{"accepted":true,"durationMs":5}}}');
	await page.getByRole('button', { name: 'Replace extension' }).click();
	await expect(link).toHaveText('<img src=x onerror=alert(1)> · #1 · Open · +2 −1');
	await expect(link).toBeFocused();
	await expect(link.locator('img')).toHaveCount(0);
	await page.keyboard.press('Enter');
	await expect(page.getByRole('status', { name: 'Opened target' })).toHaveText('https://example.com/issues/1');
	await expect(page.getByRole('status', { name: 'Extension URL delivery' })).toHaveText(JSON.stringify({ incarnation: 2, payload: { resolvedUri: 'https://example.com/issues/1', sourceUri: 'https://example.com/issues/1' } }));
	await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
	await expect(link).toHaveText('Original issue');
	await expect(link).not.toHaveAttribute('aria-busy');
	await link.focus();
	await page.keyboard.press('Enter');
	await expect(page.getByRole('status', { name: 'Extension URL delivery' })).toHaveText('default:https://example.com/issues/1');
	await expect(page.getByRole('link', { name: 'Plain link' })).toHaveAttribute('href', 'https://example.org/');
	expect(errors).toEqual([]);
});
