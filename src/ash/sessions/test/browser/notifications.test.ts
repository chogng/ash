import { expect } from '@playwright/test';
import { suite, test } from 'mocha';
import { useBrowserTests } from '../../../../../test/unit/browser/context.js';
import { NotificationsPosition } from '../../../workbench/common/notifications.js';

suite('Sessions notification presentation', () => {
	const browser = useBrowserTests();

	test('toasts use the window edge, light elevation and accessible controls in every theme', async () => {
		const { page } = browser;
		await page.goto('/sessionsNotifications.html?noStatusbar&zh');
		await page.evaluate(() => window.ashNotificationsIntegration.notify('通知保留操作和完整内容。'));
		const toast = page.locator('.ash-notification');
		const close = toast.getByRole('button', { name: '移除通知', exact: true });
		await expect(toast).toBeVisible();
		await expect(page.locator('.ash-notifications-toggle')).toHaveCount(0);
		for (let theme = 0; theme < 4; theme++) {
			await page.evaluate(index => window.ashNotificationsIntegration.theme(index), theme);
			await expect(toast).toHaveCSS('border-radius', '12px');
			await expect(toast).toHaveCSS('font-size', '14px');
			await expect(close).toHaveCSS('width', '28px');
			await expect(close).toHaveCSS('height', '28px');
			const geometry = await toast.evaluate(element => {
				const bounds = element.getBoundingClientRect();
				return {
					bottom: innerHeight - bounds.bottom,
					right: innerWidth - bounds.right,
					shadow: getComputedStyle(element).boxShadow,
				};
			});
			expect(geometry.bottom).toBe(12);
			expect(geometry.right).toBe(12);
			if (theme >= 2) {
				expect(geometry.shadow).toBe('none');
				await expect(toast).toHaveCSS('border-top-color', theme === 2 ? 'rgb(255, 255, 255)' : 'rgb(0, 0, 0)');
			} else {
				expect(geometry.shadow).toContain('0px 2px 8px 0px');
			}
			await toast.getByRole('button', { name: 'Run action', exact: true }).focus();
			await page.keyboard.press('Tab');
			await expect(close).toBeFocused();
			await expect(close).toHaveCSS('outline-style', 'solid');
			await browser.info.attach(`sessions-notification-theme-${theme}`, {
				body: await page.screenshot(),
				contentType: 'image/png',
			});
		}
		await close.click();
		await expect(toast).toHaveCount(0);
		expect(await page.evaluate(() => window.ashNotificationsIntegration.history())).toEqual([]);
	});

	test('position settings, history and narrow layouts retain the Sessions presentation', async () => {
		const { page } = browser;
		await page.setViewportSize({ width: 360, height: 480 });
		await page.goto('/sessionsNotifications.html?noStatusbar');
		await page.evaluate(() =>
			window.ashNotificationsIntegration.notify(
				'A long notification with https://example.test/very/long/path/without/spaces and actions.',
			),
		);
		const toast = page.locator('.ash-notification');
		await expect(toast).toBeVisible();
		for (const position of [
			NotificationsPosition.BOTTOM_LEFT,
			NotificationsPosition.TOP_RIGHT,
			NotificationsPosition.BOTTOM_RIGHT,
		]) {
			await page.evaluate(value => window.ashNotificationsIntegration.setPosition(value), position);
			const geometry = await toast.evaluate(element => {
				const bounds = element.getBoundingClientRect();
				return {
					left: bounds.left,
					top: bounds.top,
					right: innerWidth - bounds.right,
					bottom: innerHeight - bounds.bottom,
					fits: element.scrollWidth <= element.clientWidth,
				};
			});
			expect(geometry.fits).toBe(true);
			if (position === 'top-right') expect(geometry.top).toBe(43);
			else expect(geometry.bottom).toBe(12);
			if (position === 'bottom-left') expect(geometry.left).toBe(12);
			else expect(geometry.right).toBe(12);
		}
		await page.evaluate(() => window.ashNotificationsIntegration.show());
		const center = page.locator('.ash-notifications-center');
		await expect(center).toBeVisible();
		await expect(center).toHaveCSS('border-radius', '12px');
		expect(await center.evaluate(element => innerHeight - element.getBoundingClientRect().bottom)).toBe(12);
		await page.keyboard.press('Escape');
		await expect(center).toBeHidden();
	});
});
