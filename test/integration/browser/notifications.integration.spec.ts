import { expect, test } from '@playwright/test';

test('notification rows share standard controls, preserve focus, and fit narrow themed surfaces', async ({ page }, testInfo) => {
	await page.setViewportSize({ width: 360, height: 480 });
	await page.goto('/notifications.html');
	await page.evaluate(() => window.ashNotificationsIntegration.notify('A long notification with a URL https://example.test/very/long/path/without/spaces and another line\nSecond line'));
	const toast = page.locator('.ash-notification');
	const close = toast.getByRole('button', { name: 'Remove notification', exact: true });
	await expect(close).toBeVisible();
	for (let theme = 0; theme < 4; theme++) {
		await page.evaluate(index => window.ashNotificationsIntegration.theme(index), theme);
		await page.mouse.move(0, 0);
		await expect(close).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
		await expect(close).toHaveCSS('width', '22px');
		await expect(close).toHaveCSS('height', '22px');
		await expect(close.locator('svg')).toHaveCount(1);
		await expect(toast).toHaveCSS('border-radius', '8px');
		expect(await toast.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
		await toast.getByRole('button', { name: 'Run action', exact: true }).focus();
		await page.keyboard.press('Tab');
		await expect(close).toBeFocused();
		await expect(close).toHaveCSS('outline-style', 'solid');
		await testInfo.attach(`theme-${theme}`, { body: await page.screenshot(), contentType: 'image/png' });
	}
	const id = await toast.getAttribute('data-notification-id');
	await page.evaluate(() => window.ashNotificationsIntegration.notify('Another notification'));
	await expect(page.locator('.ash-notification')).toHaveCount(2);
	await expect(close.filter({ has: page.locator('svg') }).first()).toBeFocused();
	await page.evaluate(() => window.ashNotificationsIntegration.show());
	await page.evaluate(() => window.ashNotificationsIntegration.notify('Arrival with hidden toasts'));
	await expect(page.locator('.ash-aria-status').filter({ hasText: 'Arrival with hidden toasts' })).toHaveCount(1);
	await expect(page.locator('.ash-notification')).toHaveCount(0);
	const row = page.locator(`.ash-notifications-row[data-notification-id="${id}"]`);
	await row.getByRole('button', { name: 'Run action', exact: true }).click();
	await expect.poll(() => page.evaluate(() => window.ashNotificationsIntegration.actionRuns)).toBe(1);
	await row.getByRole('button', { name: 'Remove notification', exact: true }).click();
	await expect(row).toHaveCount(0);
	await expect(page.locator('.ash-notifications-row')).toHaveCount(2);
	await page.evaluate(() => window.ashNotificationsIntegration.clear());
	await expect(page.locator('.ash-notifications-center')).toBeHidden();
	await expect.poll(() => page.evaluate(() => window.ashNotificationsIntegration.history())).toEqual([]);
});

test('scheduled toasts are cancelled on removal and center opening while a rapid burst retains only three controls', async ({ page }) => {
	await page.goto('/notifications.html');
	await page.evaluate(() => {
		const fixture = window.ashNotificationsIntegration;
		const id = fixture.notify('Removed before its frame');
		fixture.remove(id);
		fixture.notify('Hidden before its frame');
		fixture.show();
	});
	await expect(page.locator('.ash-notification')).toHaveCount(0);
	await expect(page.locator('.ash-notifications-row')).toHaveCount(1);
	await page.evaluate(() => {
		window.ashNotificationsIntegration.hide();
		for (let index = 0; index < 8; index++) window.ashNotificationsIntegration.notify(`Burst ${index}`);
	});
	await expect(page.locator('.ash-notification')).toHaveCount(3);
	await expect(page.locator('.ash-notification .ash-notification-message')).toHaveText(['Burst 5', 'Burst 6', 'Burst 7']);
	await expect.poll(() => page.evaluate(() => window.ashNotificationsIntegration.history().length)).toBe(9);
});
