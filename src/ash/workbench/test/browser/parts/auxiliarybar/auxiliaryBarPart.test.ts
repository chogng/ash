import { expect } from '@playwright/test';
import type { ActivityBarPosition } from '../../../../common/configuration.js';
import type { ViewContainerLocation } from '../../../../common/views.js';
import { suite, test } from 'mocha';
import { useBrowserTests } from '../../../../../../../test/unit/browser/context.js';

suite('auxiliaryBar browser component', () => {
	const browserTests = useBrowserTests();
	for (const chinese of [false, true]) {
		test(`Auxiliary Bar selector follows position and active containers while retaining custom title controls (${chinese ? 'zh-CN' : 'en'})`, async function () {
			const { page } = browserTests;
			const testInfo = browserTests.info;

			const errors: string[] = [];
			page.on('pageerror', error => errors.push(error.message));
			await page.goto(`/auxiliaryBar.html${chinese ? '?chinese' : ''}`);
			await page.waitForFunction(() => !!window.ashAuxiliaryBarIntegration);
			const bar = page.locator('[data-part="auxiliarybar"]');
			const selector = bar.locator('.ash-composite-bar');
			const row = bar.locator('.ash-auxiliarybar-view-selector');
			const content = bar.locator(':scope > .ash-auxiliarybar-content');
			const draft = bar.getByRole('textbox', { name: 'Chat draft', exact: true });
			const title = bar.getByRole('button', { name: 'Chat title control', exact: true });
			await draft.fill('Retained draft');
			await expect(selector).toBeVisible();
			await expect(title).toBeVisible();
			await page.evaluate(() => window.ashAuxiliaryBarIntegration.setAutoHide(true));
			await expect(selector).toBeVisible();
			for (const position of ['top', 'bottom']) {
				await page.evaluate(position => window.ashAuxiliaryBarIntegration.setLocation(position as ActivityBarPosition), position);
				await expect(selector).toBeHidden();
				await expect(title).toBeVisible();
				await page.evaluate(() => window.ashAuxiliaryBarIntegration.setAutoHide(false));
				await expect(selector).toBeVisible();
				const before = await content.evaluate(element => element.clientHeight);
				const rowBounds = (await row.boundingBox())!;
				const contentBounds = (await content.boundingBox())!;
				if (position === 'top') expect(rowBounds.y + rowBounds.height).toBeLessThanOrEqual(contentBounds.y);
				else expect(rowBounds.y).toBeGreaterThanOrEqual(contentBounds.y + contentBounds.height);
				await selector.getByRole('tab', { name: 'Chat', exact: true }).focus();
				await page.evaluate(() => window.ashAuxiliaryBarIntegration.setAutoHide(true));
				await expect(selector).toBeHidden();
				await expect(draft).toBeFocused();
				expect(await content.evaluate(element => element.clientHeight)).toBe(before + 36);
				for (const theme of [0, 1, 2, 3]) {
					await page.evaluate(theme => window.ashAuxiliaryBarIntegration.setTheme(theme), theme);
					await expect(title).toBeVisible();
					await expect(draft).toHaveValue('Retained draft');
				}
				await page.evaluate(() => window.ashAuxiliaryBarIntegration.setOtherActive(true));
				await expect(selector).toBeVisible();
				await expect(selector.getByRole('tab', { name: 'Other', exact: true })).toBeVisible();
				await page.evaluate(() => window.ashAuxiliaryBarIntegration.moveOther('sidebar' as ViewContainerLocation));
				await expect(selector).toBeHidden();
				await page.evaluate(() => window.ashAuxiliaryBarIntegration.moveOther('auxiliarybar' as ViewContainerLocation));
				await expect(selector).toBeVisible();
				await page.evaluate(() => window.ashAuxiliaryBarIntegration.setOtherActive(false));
				await expect(selector).toBeHidden();
				await expect(title).toBeVisible();
			}
			await page.evaluate(() => window.ashAuxiliaryBarIntegration.setLocation('hidden' as ActivityBarPosition));
			await expect(selector).toBeHidden();
			await expect(title).toBeVisible();
			await page.evaluate(() => window.ashAuxiliaryBarIntegration.setLocation('default' as ActivityBarPosition));
			await expect(selector).toBeVisible();
			await bar.getByRole('button', { name: 'Clear draft', exact: true }).press('Enter');
			await expect(draft).toHaveValue('');
			await bar.screenshot({ path: testInfo.outputPath('auxiliary-container-selector.png') });
			expect(errors).toEqual([]);
		});
	}

	test('Auxiliary Bar title buttons maximize, restore and close without losing the retained draft', async function () {
		const { page } = browserTests;
		const testInfo = browserTests.info;

		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto('/auxiliaryBar.html');
		await page.waitForFunction(() => !!window.ashAuxiliaryBarIntegration);
		const bar = page.locator('[data-part="auxiliarybar"]');
		const maximize = bar.locator('[data-action-id="workbench.action.toggleMaximizedAuxiliaryBar"] button');
		const close = bar.locator('[data-action-id="workbench.action.closeAuxiliaryBar"] button');
		const draft = page.getByRole('textbox', { name: 'Chat draft', exact: true });
		await draft.fill('Keep this unsent message');
		const ordinary = await page.evaluate(() => window.ashAuxiliaryBarIntegration.state());
		for (const theme of [0, 1, 2, 3]) {
			await page.evaluate(index => window.ashAuxiliaryBarIntegration.setTheme(index), theme);
			await maximize.focus();
			await expect(maximize).toBeFocused();
			await expect(maximize).toHaveCSS('outline-style', 'solid');
			await maximize.press('Enter');
			await expect.poll(() => page.evaluate(() => window.ashAuxiliaryBarIntegration.state().maximized)).toBe(true);
			for (const part of ['editor', 'sidebar', 'panel', 'agentSidebar']) await expect(page.locator(`[data-part="${part}"]`)).toBeHidden();
			await expect(maximize).toBeFocused();
			expect((await bar.boundingBox())!.width).toBeGreaterThan((await page.viewportSize())!.width - 100);
			await expect(maximize.locator('[data-ash-icon-id="screen-normal"]')).toBeVisible();
			await expect(maximize).toHaveAttribute('aria-pressed', 'true');
			await maximize.press('Enter');
			await expect.poll(() => page.evaluate(() => window.ashAuxiliaryBarIntegration.state())).toEqual(ordinary);
			await expect(draft).toHaveValue('Keep this unsent message');
		}
		await page.getByRole('textbox', { name: 'editor', exact: true }).focus();
		await page.evaluate(() => window.ashAuxiliaryBarIntegration.command('workbench.action.toggleMaximizedAuxiliaryBar'));
		await expect(draft).toBeFocused();
		await page.evaluate(() => window.ashAuxiliaryBarIntegration.setSide('right'));
		await expect(page.locator('[data-part="editor"]')).toBeHidden();
		await maximize.focus();
		await maximize.press('ArrowRight');
		await expect(close).toBeFocused();
		await close.press('Enter');
		await expect(bar).toBeHidden();
		await expect(page.getByRole('textbox', { name: 'editor', exact: true })).toBeFocused();
		await page.evaluate(() => window.ashAuxiliaryBarIntegration.command('workbench.action.toggleAuxiliaryBar'));
		await expect(draft).toHaveValue('Keep this unsent message');
		await expect.poll(() => page.evaluate(() => window.ashAuxiliaryBarIntegration.state().width)).toBe(ordinary.width);
		await page.screenshot({ path: testInfo.outputPath('auxiliary-bar-actions.png') });
		expect(errors).toEqual([]);
	});

	test('Auxiliary Bar action tooltips and accessible names use Chinese translations', async function () {
		const { page } = browserTests;

		await page.goto('/auxiliaryBar.html?chinese');
		await page.waitForFunction(() => !!window.ashAuxiliaryBarIntegration);
		const maximize = page.locator('[data-action-id="workbench.action.toggleMaximizedAuxiliaryBar"] button');
		await expect(maximize).toHaveAttribute('aria-label', '最大化辅助侧栏');
		await maximize.click();
		await expect(maximize).toHaveAttribute('aria-label', '还原辅助侧栏');
		await expect(page.locator('[data-action-id="workbench.action.closeAuxiliaryBar"] button')).toHaveAttribute('aria-label', '隐藏辅助侧栏');
	});
});
