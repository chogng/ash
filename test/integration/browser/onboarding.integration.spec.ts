import { expect, test } from '@playwright/test';

test('spotlight follows the scoped control and restores keyboard focus', async ({ page }) => {
	await page.goto('/onboarding.html');
	await page.locator('#previous').focus();
	await page.evaluate(() => window.ashOnboardingIntegration.show('second'));
	const dialog = page.getByRole('dialog', { name: 'Find the target' });
	await expect(dialog).toBeVisible();
	const target = await page.locator('#second').boundingBox();
	const frame = await page.locator('.ash-onboarding-spotlight-frame').boundingBox();
	expect(frame?.x).toBeCloseTo(target!.x, 0);
	expect(frame?.y).toBeCloseTo(target!.y, 0);
	await page.keyboard.press('F1');
	await expect(dialog.getByText('Use Tab to reach Next or Dismiss.')).toBeVisible();
	await dialog.getByRole('button', { name: 'Done' }).click();
	await expect(dialog).toHaveCount(0);
	await expect(page.locator('#previous')).toBeFocused();
	await expect.poll(() => page.evaluate(() => window.ashOnboardingIntegration.result)).toBe('completed');
});
