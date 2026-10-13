import { expect, test } from '@playwright/test';

for (const locale of ['en', 'zh-CN'] as const) {
	test(`Hook management preserves keyboard focus, disclosure and search across save and reopening (${locale})`, async ({ page }, testInfo) => {
		await page.setViewportSize({ width: 960, height: 800 });
		await page.goto(`/aiCustomization.html?locale=${locale}&hc`);
		const pane = page.locator('.ash-ai-customization-management');
		await expect(pane).toHaveAttribute('aria-busy', 'false');
		const search = pane.getByRole('searchbox');
		await search.fill('synthetic');
		const event = pane.locator('[data-hook-event="preToolUse"]');
		await event.locator(':scope > summary').focus();
		await page.keyboard.press('Enter');
		const hook = event.locator('.ash-hooks-declaration');
		const summary = hook.locator(':scope > summary');
		await summary.focus();
		await page.keyboard.press('Space');
		await expect(hook).toHaveJSProperty('open', true);
		await expect(summary).toBeFocused();
		expect(await summary.evaluate(element => getComputedStyle(element).outlineStyle)).not.toBe('none');
		await expect(hook.locator('dd').last()).toHaveText(JSON.stringify(['<img src=x onerror="throw 1">']));
		await expect(hook.locator('img')).toHaveCount(0);
		await page.screenshot({ path: testInfo.outputPath(`hooks-${locale}-before-save.png`) });
		await page.evaluate(() => window.ashHookManagementIntegration.save());
		await expect.poll(() => page.evaluate(() => window.ashHookManagementIntegration.reads)).toBe(2);
		await expect(hook).toContainText(locale === 'en' ? 'Disabled' : '已禁用');
		await expect(summary).toBeFocused();
		await expect(hook).toHaveJSProperty('open', true);
		await expect(search).toHaveValue('synthetic');
		await page.evaluate(() => window.ashHookManagementIntegration.reopen());
		await expect.poll(() => page.evaluate(() => window.ashHookManagementIntegration.reads)).toBe(3);
		await expect(hook).toHaveJSProperty('open', true);
		await expect(search).toHaveValue('synthetic');
		await page.screenshot({ path: testInfo.outputPath(`hooks-${locale}-reopened.png`) });
	});

	test(`Hook management distinguishes editor failure from cancellation and ignores late workspace reads (${locale})`, async ({ page }, testInfo) => {
		await page.setViewportSize({ width: 960, height: 800 });
		await page.goto(`/aiCustomization.html?locale=${locale}`);
		const pane = page.locator('.ash-ai-customization-management');
		await expect(pane).toHaveAttribute('aria-busy', 'false');
		await pane.locator('[data-hook-event="preToolUse"] > summary').click();
		const hook = pane.locator('.ash-hooks-declaration');
		await hook.locator(':scope > summary').click();
		const edit = hook.locator('[data-hook-action="edit-hook"]');
		await page.evaluate(() => window.ashHookManagementIntegration.setEditOutcome('cancelled'));
		await edit.click();
		await expect.poll(() => page.evaluate(() => window.ashHookManagementIntegration.opened)).toBe(1);
		const status = pane.getByRole('status');
		await expect(status).not.toContainText('Canceled');
		await expect(status).not.toContainText('Could not configure');
		await page.screenshot({ path: testInfo.outputPath(`hooks-${locale}-cancelled.png`) });
		await page.evaluate(() => window.ashHookManagementIntegration.setEditOutcome('failure'));
		await edit.click();
		await expect(status).toContainText('fixture editor failed');
		await page.screenshot({ path: testInfo.outputPath(`hooks-${locale}-failed.png`) });
		await page.evaluate(() => window.ashHookManagementIntegration.beginDelayedRead());
		await pane.locator('[data-hook-action="refresh"]').click();
		await expect(pane).toHaveAttribute('aria-busy', 'true');
		await page.evaluate(() => window.ashHookManagementIntegration.switchWorkspace());
		await expect(status).toContainText('fixture catalog failed');
		await page.evaluate(() => window.ashHookManagementIntegration.completeDelayedRead());
		await expect(pane).toHaveAttribute('aria-busy', 'false');
		await expect(pane.locator('.ash-hooks-declaration')).toHaveCount(0);
		await expect(status).toContainText('fixture catalog failed');
	});
}
