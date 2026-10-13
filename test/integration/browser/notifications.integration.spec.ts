import { expect, test } from '@playwright/test';

test('notification rows share standard controls, preserve focus, and fit narrow themed surfaces', async ({ page }, testInfo) => {
	await page.setViewportSize({ width: 360, height: 480 });
	await page.goto('/notifications.html');
	await page.evaluate(() => window.ashNotificationsIntegration.notify('A long notification with a URL https://example.test/very/long/path/without/spaces and another line\nSecond line'));
	const toast = page.locator('.ash-notification');
	const close = toast.getByRole('button', { name: 'Remove notification', exact: true });
	await expect(close).toBeVisible();
	await expect(page.locator('.ash-notifications-toggle')).toHaveCount(0);
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

test('extension messages retain source, primary choices and a working configuration menu on both surfaces', async ({ page }, testInfo) => {
	await page.setViewportSize({ width: 600, height: 480 });
	await page.goto('/notifications.html');
	await page.evaluate(() => window.ashNotificationsIntegration.extensionMessage(['Show Git Output', 'Retry']));
	const toast = page.locator('.ash-notification');
	await expect(toast.getByRole('img', { name: 'Error', exact: true })).toBeVisible();
	await expect(toast.locator('.ash-notification-severity svg')).toHaveAttribute('data-ash-icon-id', 'error');
	await expect(toast.locator('.ash-notification-source')).toHaveText('Source: Git');
	await expect(toast.getByRole('button', { name: 'Show Git Output', exact: true })).toHaveClass(/ash-button-primary/);
	await expect(toast.getByRole('button', { name: 'Retry', exact: true })).toHaveClass(/ash-button-secondary/);
	const configure = toast.getByRole('button', { name: 'More Actions', exact: true });
	await expect(configure.locator('svg[data-ash-icon-id="gear"]')).toBeVisible();
	await configure.focus();
	await page.keyboard.press('ArrowDown');
	await expect(configure).toHaveAttribute('aria-expanded', 'true');
	await page.getByRole('menuitem', { name: 'Manage Extension', exact: true }).click();
	await expect.poll(() => page.evaluate(() => window.ashNotificationsIntegration.managed)).toEqual({ query: 'fixture.git' });
	await expect(toast).toBeVisible();
	await testInfo.attach('extension-toast', { body: await page.screenshot(), contentType: 'image/png' });
	await page.evaluate(() => window.ashNotificationsIntegration.show());
	const row = page.locator('.ash-notifications-row');
	await expect(row.locator('.ash-notification-source')).toHaveText('Source: Git');
	await row.getByRole('button', { name: 'More Actions', exact: true }).click();
	await expect(page.getByRole('menuitem', { name: 'Manage Extension', exact: true })).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(page.getByRole('menuitem', { name: 'Manage Extension', exact: true })).toHaveCount(0);
	await expect(page.locator('.ash-notifications-center')).toBeVisible();
	await row.getByRole('button', { name: 'Show Git Output', exact: true }).click();
	await expect.poll(() => page.evaluate(() => window.ashNotificationsIntegration.selection)).toBe(0);
	await expect.poll(() => page.evaluate(() => window.ashNotificationsIntegration.history())).toEqual([]);
});

test('severity icons and source/menu labels use the Chinese catalog and fit narrow themes', async ({ page }, testInfo) => {
	await page.setViewportSize({ width: 360, height: 640 });
	await page.goto('/notifications.html?zh');
	await page.evaluate(() => {
		window.ashNotificationsIntegration.notify('信息消息', 'info' as import('../../../src/ash/platform/notification/common/notification.js').NotificationSeverity);
		window.ashNotificationsIntegration.notify('警告消息', 'warning' as import('../../../src/ash/platform/notification/common/notification.js').NotificationSeverity);
		window.ashNotificationsIntegration.extensionMessage(['显示 Git 输出']);
	});
	const toasts = page.locator('.ash-notification');
	await expect(toasts).toHaveCount(3);
	for (const [index, id] of ['info', 'warning', 'error'].entries()) {
		await expect(toasts.nth(index).locator('.ash-notification-severity svg')).toHaveAttribute('data-ash-icon-id', id);
		await expect(toasts.nth(index).getByRole('img')).toHaveAttribute('aria-label', ['信息', '警告', '错误'][index]);
	}
	const error = toasts.last();
	await expect(error.locator('.ash-notification-source')).toHaveText('来源：Git');
	await expect(error.getByRole('button', { name: '更多操作', exact: true })).toBeVisible();
	for (let theme = 0; theme < 4; theme++) {
		await page.evaluate(index => window.ashNotificationsIntegration.theme(index), theme);
		for (const toast of await toasts.all()) {
			expect(await toast.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
			await expect(toast.locator('.ash-notification-severity svg')).toBeVisible();
		}
		await testInfo.attach(`severity-theme-${theme}`, { body: await page.screenshot(), contentType: 'image/png' });
	}
	await error.getByRole('button', { name: '更多操作', exact: true }).click();
	await expect(page.getByRole('menuitem', { name: '管理扩展', exact: true })).toBeVisible();
});
