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
		await expect(page.locator('.ash-sessions-titlebar-title button')).toBeVisible();
		await expect(attention).toHaveCount(0);
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

	test('the titlebar renames the active session in Chinese', async () => {
		const { page } = browser;
		await page.goto('/sessions.html?multiHost&locale=zh-CN');
		await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
		await page.evaluate(() => window.ashSessionsIntegration.multiHost!.open('Host B'));
		const widget = page.locator('.ash-sessions-titlebar-widget');
		const button = widget.getByRole('button', { name: '重命名会话（Task from Host B）' });
		const input = widget.getByRole('textbox', { name: '会话名称' });
		const titlebarContent = page.locator('.ash-sessions-titlebar-session-content');
		await expect(button).toBeVisible();
		const leftInset = (await button.boundingBox())!.x - (await titlebarContent.boundingBox())!.x;
		expect(leftInset).toBeCloseTo(4, 0);
		await expect(button.locator('.ash-icon')).toHaveCount(0);
		await button.hover();
		await expect(button).toHaveCSS('padding', '2px 4px');
		const titleRadius = await button.evaluate(element => getComputedStyle(element).borderTopLeftRadius);
		const titleTextLeft = await button.locator('.ash-button-label').evaluate(label => label.getBoundingClientRect().left);
		await button.press('Enter');
		await expect(input).toHaveValue('Task from Host B');
		await expect(input).toHaveCSS('padding', '2px 4px');
		await expect(input).toHaveCSS('border-top-left-radius', titleRadius);
		const inputTextLeft = await input.evaluate(element => {
			const style = getComputedStyle(element);
			return element.getBoundingClientRect().left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft);
		});
		expect(inputTextLeft).toBeCloseTo(titleTextLeft, 0);
		await expect(input).toBeFocused();
		await expect(page.locator('.ash-quick-input-host:visible')).toHaveCount(0);
		expect((await input.boundingBox())!.x - (await titlebarContent.boundingBox())!.x).toBe(leftInset);
		const initialWidth = (await input.boundingBox())!.width;
		await input.fill('短');
		expect((await input.boundingBox())!.width).toBeLessThan(initialWidth);
		await input.fill('取消此名称'.repeat(40));
		const expandedBounds = (await input.boundingBox())!;
		const availableBounds = (await titlebarContent.boundingBox())!;
		expect(expandedBounds.width).toBeGreaterThan(initialWidth);
		expect(expandedBounds.x + expandedBounds.width).toBeLessThanOrEqual(availableBounds.x + availableBounds.width);
		await input.fill('取消此名称');
		await input.press('Escape');
		await expect(button).toBeFocused();
		const actions = widget.getByRole('button', { name: '更多会话操作' });
		const menuBounds = (await actions.boundingBox())!;
		expect(menuBounds.width).toBe(menuBounds.height);
		await actions.press('Enter');
		await expect(actions).toHaveAttribute('aria-expanded', 'true');
		await page.getByRole('menuitem', { name: '重命名', exact: true }).click();
		await expect(actions).toHaveAttribute('aria-expanded', 'false');
		await expect(input).toBeFocused();
		await expect(input).toHaveValue('Task from Host B');
		await input.press('Escape');
		await expect(button).toBeFocused();
		await button.click();
		const longTitle = '新的会话名称'.repeat(35);
		await input.fill(longTitle);
		await input.press('Enter');
		const renamedButton = widget.getByRole('button', { name: `重命名会话（${longTitle}）` });
		await expect(renamedButton).toBeVisible();
		await expect(renamedButton).not.toBeFocused();
		await expect(page.locator('.ash-sessions-list-item[aria-current="page"]')).toContainText(longTitle);
		const titleLabel = renamedButton.locator('.ash-button-label');
		expect(await titleLabel.evaluate(label => label.scrollWidth > label.clientWidth)).toBe(true);
		await renamedButton.hover();
		const tooltip = page.getByRole('tooltip').filter({ hasText: longTitle });
		await expect(tooltip).toBeVisible();
		await expect(tooltip).toHaveCSS('overflow-wrap', 'anywhere');
		const renamedHosts = await page.evaluate(() => window.ashSessionsIntegration.multiHost!.calls
			.filter(call => call.method === 'rename').map(call => call.host));
		expect(renamedHosts).toEqual(['Host B']);
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
