import { expect, test } from '@playwright/test';

for (const locale of ['en', 'zh-CN']) {
	test(`approval targets and keyboard decisions use ${locale}`, async ({ page }) => {
		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto(locale === 'en' ? '/chatInput.html' : `/chatInput.html?locale=${locale}`);
		expect(errors).toEqual([]);
		const chinese = locale === 'zh-CN';
		const targets = page.getByRole('list', { name: chinese ? '请求的操作与目标' : 'Requested actions and targets' });
		await expect(targets.getByRole('listitem')).toHaveCount(10);
		await expect(targets.locator('code')).toHaveText(['/workspace/file with spaces.ts', String.raw`C:\Users\name\file.ts`, String.raw`\\server\share\file.ts`, 'pnpm test <script>', 'https://api.example.test', 'provider-key', 'issue:42', 'git.user.email', 'current window', `/workspace/${'a'.repeat(160)}.ts`]);
		await expect(targets.getByRole('listitem').first()).toHaveText(chinese ? '读取文件: /workspace/file with spaces.ts' : 'Read file: /workspace/file with spaces.ts');
		const decline = page.getByRole('button', { name: chinese ? '拒绝' : 'Decline', exact: true });
		const approve = page.getByRole('button', { name: chinese ? '批准一次' : 'Approve once', exact: true });
		await decline.focus();
		await page.evaluate(() => window.ashChatInputIntegration.refresh());
		await expect(decline).toBeFocused();
		await page.keyboard.press('Enter');
		await expect(page.getByRole('status', { name: 'Decision' })).toHaveText('decline');
		await page.keyboard.press('Tab');
		await expect(approve).toBeFocused();
		await page.keyboard.press('Space');
		await expect(page.getByRole('status', { name: 'Decision' })).toHaveText('approveOnce');
		await page.setViewportSize({ width: 320, height: 600 });
		expect(await targets.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
		expect(errors).toEqual([]);
	});
}
