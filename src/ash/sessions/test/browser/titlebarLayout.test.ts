import { expect } from '@playwright/test';
import { suite, test } from 'mocha';
import { useBrowserTests } from '../../../../../test/unit/browser/context.js';

suite('Sessions native titlebar layout', () => {
	const browser = useBrowserTests();

	for (const os of ['windows', 'mac']) {
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
