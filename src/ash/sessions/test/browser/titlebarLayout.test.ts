import { expect } from '@playwright/test';
import { suite, test } from 'mocha';
import { useBrowserTests } from '../../../../../test/unit/browser/context.js';
import type { } from '../../../../../test/fixtures/browser/sessions.page.js';

suite('Sessions native titlebar layout', () => {
	const browser = useBrowserTests();

	test('mouse side buttons traverse the Sessions navigation history', async () => {
		const { page } = browser;
		await page.goto('/sessions.html?multiHost');
		await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
		await page.evaluate(async () => {
			const host = window.ashSessionsIntegration.multiHost!;
			await host.open('Host A');
			await host.open('Host B');
		});
		const selected = page.locator('.ash-sessions-list-item[aria-current="page"]');
		await expect(selected).toContainText('Task from Host B');
		await selected.focus();
		await selected.dispatchEvent('mousedown', { button: 3, bubbles: true, cancelable: true });
		await expect(selected).toContainText('Task from Host A');
		await selected.focus();
		await selected.dispatchEvent('mousedown', { button: 4, bubbles: true, cancelable: true });
		await expect(selected).toContainText('Task from Host B');
	});

	test('ignoring an attention alert survives reloading the Sessions window', async () => {
		const { page } = browser;
		await page.goto('/sessions.html?multiHost&blockedTitlebar');
		await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
		await page.evaluate(() => window.ashSessionsIntegration.multiHost!.showAttentionDraft());
		const attention = page.getByRole('button', { name: '1 session requires attention' });
		await attention.press('Enter');
		await page.getByRole('button', { name: 'Ignore all current alerts' }).click();
		await expect(attention).toHaveCount(0);
		await page.reload();
		await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
		await page.evaluate(() => window.ashSessionsIntegration.multiHost!.showAttentionDraft());
		await expect(page.locator('.ash-sessions-titlebar-widget button')).toHaveAccessibleName(/Show Session History/);
	});

	test('the attention list opens the blocked session on its host and clears the visible item', async () => {
		const { page } = browser;
		await page.goto('/sessions.html?multiHost&blockedTitlebar');
		await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
		await page.evaluate(() => window.ashSessionsIntegration.multiHost!.showAttentionDraft());
		const widget = page.locator('.ash-sessions-titlebar-widget');
		const attention = widget.getByRole('button', { name: '1 session requires attention' });
		await expect(attention).toBeVisible();
		await attention.press('Enter');
		const picker = page.locator('.ash-quick-input-host:visible');
		await expect(picker.getByText('Task from Host B', { exact: true })).toBeVisible();
		await expect(picker.getByText('Needs input', { exact: true })).toBeVisible();
		await page.keyboard.press('ArrowDown');
		await page.keyboard.press('Enter');
		await expect(page.locator('.ash-sessions-list-item[aria-current="page"]').filter({ hasText: 'Task from Host B' })).toBeVisible();
		await expect(attention).toHaveCount(0);
	});

	test('the workspace button opens Session History from the keyboard in Chinese', async () => {
		const { page } = browser;
		await page.goto('/sessions.html?multiHost&locale=zh-CN');
		await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
		const widget = page.locator('.ash-sessions-titlebar-widget');
		const button = widget.getByRole('button', { name: '显示会话历史（无工作区）' });
		await expect(button).toBeVisible();
		await button.focus();
		await button.press('Enter');
		await expect(page.locator('.ash-quick-input-host:visible')).toHaveCount(1);
		await page.keyboard.press('Escape');
		await expect(page.locator('.ash-quick-input-host:visible')).toHaveCount(0);
	});

	for (const os of ['windows', 'mac']) {
		test(`${os} sidebar minimum contains navigation and mode controls as native insets change`, async () => {
			const { page } = browser;
			await page.goto(`/sessionsTitlebar.html?os=${os}`);
			await page.waitForFunction(() => !!window.ashSessionsTitlebarFixture);
			await page.setViewportSize({ width: 640, height: 720 });
			for (const leftInset of os === 'mac' ? [90, 110, 0, 90] : [0]) {
				await page.evaluate(() => window.ashSessionsTitlebarFixture.setSidebarWidth(0));
				await page.evaluate(left => window.ashSessionsTitlebarFixture.setInsets(left, 0), leftInset);
				await expect.poll(() =>
					page.locator('.ash-sessions-titlebar-left').evaluate(element => {
						const mode = element.querySelector('.ash-sessions-workspace-mode')!.getBoundingClientRect();
						const inset = Number.parseFloat(getComputedStyle(element).paddingRight);
						return Math.ceil(mode.right + inset) - window.ashSessionsTitlebarFixture.minimumSidebarWidth;
					}),
				).toBe(0);
				await page.evaluate(() => window.ashSessionsTitlebarFixture.setSidebarWidth(window.ashSessionsTitlebarFixture.minimumSidebarWidth));
				const navigation = (await page.locator('.ash-titlebar-left-actions.ash-sessions-titlebar-actions').boundingBox())!;
				const mode = (await page.locator('.ash-sessions-workspace-mode').boundingBox())!;
				expect(navigation.x).toBeGreaterThanOrEqual(leftInset);
				expect(mode.x).toBeGreaterThanOrEqual(navigation.x + navigation.width);
			}
		});

		test(`${os} keeps actions inside the native control area through resize and fullscreen`, async () => {
			const { page } = browser;
			await page.goto(`/sessionsTitlebar.html?os=${os}`);
			await page.waitForFunction(() => !!window.ashSessionsTitlebarFixture);
			const button = page.getByRole('button', { name: 'Session information', exact: true });
			const leftInset = os === 'mac' ? 90 : 0;
			const rightInset = os === 'windows' ? 140 : 0;
			await page.evaluate(({ left, right }) => window.ashSessionsTitlebarFixture.setInsets(left, right), { left: leftInset, right: rightInset });
			for (const width of [1280, 640]) {
				await page.setViewportSize({ width, height: 720 });
				for (let theme = 0; theme < 4; theme++) {
					await page.evaluate(index => window.ashSessionsTitlebarFixture.setTheme(index), theme);
					for (const action of await page.locator('[data-part="titlebar"] button:visible').all()) {
						const bounds = (await action.boundingBox())!;
						expect(bounds.x).toBeGreaterThanOrEqual(leftInset);
						expect(bounds.x + bounds.width).toBeLessThanOrEqual(width - rightInset);
					}
					const mode = (await page.locator('.ash-sessions-workspace-mode').boundingBox())!;
					expect(mode.x + mode.width).toBeLessThanOrEqual(260);
					await expect(page.locator('.ash-sessions-titlebar-right')).toHaveCSS('-webkit-app-region', 'no-drag');
					const bounds = (await button.boundingBox())!;
					const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
					expect(await button.evaluate((element, point) => element.contains(document.elementFromPoint(point.x, point.y)), center)).toBe(true);
				}
			}
			await button.focus();
			await button.press('Enter');
			expect(await page.evaluate(() => window.ashSessionsTitlebarFixture.runs)).toBe(1);
			await browser.info.attach(`${os}-native-titlebar`, { body: await page.screenshot(), contentType: 'image/png' });
			await page.evaluate(() => window.ashSessionsTitlebarFixture.setFullscreen(true));
			await expect(page.locator('[data-part="titlebar"]')).toHaveCSS('padding-left', '0px');
			await expect(page.locator('[data-part="titlebar"]')).toHaveCSS('padding-right', '0px');
			const bounds = (await button.boundingBox())!;
			expect(bounds.x + bounds.width).toBeGreaterThan(640 - 40);
			await page.evaluate(() => window.ashSessionsTitlebarFixture.setFullscreen(false));
			await expect(page.locator('[data-part="titlebar"]')).toHaveCSS('padding-left', `${leftInset}px`);
			await expect(page.locator('[data-part="titlebar"]')).toHaveCSS('padding-right', `${rightInset}px`);
		});
	}
});
