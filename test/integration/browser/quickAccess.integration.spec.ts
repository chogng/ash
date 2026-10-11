import { expect, test } from '@playwright/test';

for (const variant of [{ locale: 'en', theme: 'light' }, { locale: 'zh-CN', theme: 'dark' }, { locale: 'en', theme: 'hc' }]) {
	test(`Command Palette preserves recent history through search and reload (${variant.locale}, ${variant.theme})`, async ({ page }) => {
		await page.goto(`/quickAccess.html?locale=${variant.locale}&theme=${variant.theme}`);
		const open = page.getByRole('button', { name: 'Open commands' });
		const input = page.getByRole('combobox');
		const labels = page.locator('.ash-quick-pick-row-label');
		for (const label of ['Zulu Format', 'Alpha Format', 'Zulu Format']) {
			await open.click();
			await input.fill(`>${label}`);
			await page.keyboard.press('Enter');
			await expect(input).toHaveCount(0);
			await expect(open).toBeFocused();
		}
		await expect(page.getByRole('status', { name: 'Executed commands' })).toHaveText('Zulu Format, Alpha Format, Zulu Format');
		await open.click();
		await expect(labels.nth(0)).toHaveText('Zulu Format');
		await expect(labels.nth(1)).toHaveText('Alpha Format');
		const recent = variant.locale === 'zh-CN' ? '最近使用' : 'recently used';
		const other = variant.locale === 'zh-CN' ? '其他命令' : 'other commands';
		await expect(page.getByRole('separator', { name: recent })).toHaveCount(1);
		await expect(page.getByRole('separator', { name: other })).toHaveCount(1);
		await input.fill('>for');
		await expect(labels).toHaveText(['Zulu Format', 'Alpha Format', 'Format']);
		await expect(input).toBeFocused();
		await input.fill('>Format');
		await expect(labels.nth(0)).toHaveText('Format');
		await input.fill('>Zulu');
		await expect(labels).toHaveText(['Zulu Format']);
		const removeName = variant.locale === 'zh-CN' ? '从命令历史记录中移除' : 'Remove from Command History';
		const remove = page.getByRole('button', { name: removeName });
		await expect(remove.locator('svg.ash-icon')).toHaveAttribute('aria-hidden', 'true');
		await page.keyboard.press('Tab');
		await expect(remove).toBeFocused();
		await expect(remove).toHaveCSS('opacity', '1');
		await page.keyboard.press('Enter');
		await expect(input).toBeFocused();
		await expect(remove).toHaveCount(0);
		await expect(labels).toHaveText(['Zulu Format']);
		await expect(page.getByRole('status', { name: 'Executed commands' })).toHaveText('Zulu Format, Alpha Format, Zulu Format');
		await page.keyboard.press('Escape');
		await page.reload();
		await open.click();
		await expect(labels.nth(0)).toHaveText('Alpha Format');
		await input.fill('>for');
		await expect(labels).toHaveText(['Alpha Format', 'Format', 'Zulu Format']);
		await page.evaluate(() => window.ashQuickAccessIntegration.setHistoryLength(0));
		await expect(page.getByRole('separator', { name: recent })).toHaveCount(0);
		await expect(labels).toHaveText(['Alpha Format', 'Format', 'Zulu Format']);
		await input.fill('>Zulu');
		await page.keyboard.press('Enter');
		await page.evaluate(() => window.ashQuickAccessIntegration.setHistoryLength(50));
		await open.click();
		await expect(page.getByRole('separator', { name: recent })).toHaveCount(0);
	});
}
