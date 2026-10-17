import { test, expect } from '@playwright/test';

test('Auxiliary Bar title buttons maximize, restore and close without losing the retained draft', async ({ page }, testInfo) => {
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

test('Auxiliary Bar action tooltips and accessible names use Chinese translations', async ({ page }) => {
	await page.goto('/auxiliaryBar.html?chinese');
	await page.waitForFunction(() => !!window.ashAuxiliaryBarIntegration);
	const maximize = page.locator('[data-action-id="workbench.action.toggleMaximizedAuxiliaryBar"] button');
	await expect(maximize).toHaveAttribute('aria-label', '最大化辅助侧栏');
	await maximize.click();
	await expect(maximize).toHaveAttribute('aria-label', '还原辅助侧栏');
	await expect(page.locator('[data-action-id="workbench.action.closeAuxiliaryBar"] button')).toHaveAttribute('aria-label', '隐藏辅助侧栏');
});
