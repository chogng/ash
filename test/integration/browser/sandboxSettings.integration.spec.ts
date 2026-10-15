import { expect, test } from '@playwright/test';

for (const locale of ['en', 'zh-CN']) for (const theme of ['light', 'dark', 'hc']) {
	test(`Chat Sandbox defaults preserve approval and effective policy in ${locale} ${theme}`, async ({ page }) => {
		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto(`/extensions.html?locale=${locale}&theme=${theme}`);
		await page.evaluate(() => window.ashSandboxIntegration.open());
		expect(await page.evaluate(() => window.ashSandboxIntegration.location())).toEqual(['agents']);
		const root = page.locator('#sandbox-settings');
		const files = root.getByRole('combobox', { name: locale === 'en' ? 'Command file access' : '命令文件访问', exact: true });
		const network = root.getByRole('combobox', { name: locale === 'en' ? 'Command network access' : '命令联网', exact: true });
		await expect(network).toBeEnabled();
		await files.focus(); await page.keyboard.press('Tab'); await expect(network).toBeFocused();
		await network.press('Enter');
		await page.getByRole('option', { name: locale === 'en' ? 'Allowed' : '允许', exact: true }).click();
		const save = root.getByRole('button', { name: locale === 'en' ? 'Save sandbox defaults' : '保存沙箱默认值', exact: true });
		await expect(save).toBeEnabled(); await save.focus(); await save.press('Enter');
		await expect.poll(() => page.evaluate(() => window.ashSandboxIntegration.snapshot())).toEqual({ revision: 2, settings: { approvalMode: 'auto', commandFileAccess: 'readOnly', commandNetworkAccess: 'allowed' } });
		await expect(save).toBeDisabled();
		await expect(root).toContainText(':readOnly');
		await expect(root).toContainText(locale === 'en' ? 'Managed host constraints' : '管理员宿主约束');
		await expect(root).toContainText(locale === 'en' ? 'Workbench terminals are separate' : '工作台终端使用独立路径');
		await root.screenshot({ path: test.info().outputPath('sandbox-settings.png') });
		expect(errors).toEqual([]);
	});
}
