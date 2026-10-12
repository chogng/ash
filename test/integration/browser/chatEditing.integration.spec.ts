import { expect, test } from '@playwright/test';

for (const locale of ['en', 'zh-CN']) {
	test(`pending reviews survive a window reload and decisions remain scoped (${locale})`, async ({ page }) => {
		await page.goto(`/chatEditing.html?locale=${locale}`);
		await page.waitForFunction(() => !!window.ashChatEditingIntegration);
		await page.evaluate(() => window.ashChatEditingIntegration.prepareReload());
		await page.goto(`/chatEditing.html?locale=${locale}&reopen`);
		await page.waitForFunction(() => !!window.ashChatEditingIntegration);
		await expect.poll(() => page.evaluate(() => window.ashChatEditingIntegration.snapshot().entries.length)).toBe(2);
		await page.getByRole('button', { name: 'Reject this chat' }).click();
		await page.getByRole('combobox').fill('first-chat');
		await page.keyboard.press('Enter');
		await expect.poll(() => page.evaluate(() => window.ashChatEditingIntegration.snapshot())).toEqual({ entries: [['/workspace/second.txt']], texts: ['original', 'second change'] });
	});
	test(`chat review commands isolate files and restore focus after cancellation (${locale})`, async ({ page }) => {
		await page.goto(`/chatEditing.html?locale=${locale}`);
		await page.waitForFunction(() => !!window.ashChatEditingIntegration);
		const reject = page.getByRole('button', { name: 'Reject this chat' });
		await reject.click();
		const picker = page.getByRole('combobox');
		await expect(picker).toHaveAttribute('aria-label', locale === 'en' ? 'Choose a chat to review its Agent changes' : '选择要审阅智能体更改的对话');
		await expect(picker).toBeFocused();
		await page.keyboard.press('Escape');
		await expect(picker).toHaveCount(0);
		await expect(reject).toBeFocused();
		await expect.poll(() => page.evaluate(() => window.ashChatEditingIntegration.snapshot().entries.length)).toBe(2);
		await reject.click();
		await picker.fill('first-chat');
		await page.keyboard.press('Enter');
		await expect(picker).toHaveCount(0);
		await expect.poll(() => page.evaluate(() => window.ashChatEditingIntegration.snapshot())).toEqual({ entries: [['/workspace/second.txt']], texts: ['original', 'second change'] });
	});

	test(`shared reviews require an explicit combined decision through the keyboard (${locale})`, async ({ page }) => {
		await page.goto(`/chatEditing.html?locale=${locale}&shared`);
		await page.waitForFunction(() => !!window.ashChatEditingIntegration);
		await page.getByRole('button', { name: 'Reject this chat' }).click();
		const picker = page.getByRole('combobox');
		await picker.fill('second-chat');
		await page.keyboard.press('Enter');
		await expect(page.getByRole('status', { name: 'Review error' })).toHaveText(locale === 'en'
			? 'These changes include edits from other chats. Review the shared file or change set separately.'
			: '这些更改包含其他对话的编辑。请单独审阅共享文件或更改集。');
		await expect.poll(() => page.evaluate(() => window.ashChatEditingIntegration.snapshot().entries.length)).toBe(2);
		await page.getByRole('button', { name: 'Review changes' }).click();
		await picker.fill('first-chat');
		await page.keyboard.press('Enter');
		await expect(page.locator('.ash-quick-pick-row-label')).toHaveText(['first.txt']);
		await expect(page.locator('.ash-quick-pick-row-detail')).toContainText(locale === 'en' ? 'Shared changes from 2 chats' : '来自 2 个对话的共享更改');
		const accept = page.getByRole('button', { name: locale === 'en' ? 'Accept changes from 2 chats' : '接受来自 2 个对话的更改', exact: true });
		const reject = page.getByRole('button', { name: locale === 'en' ? 'Reject changes from 2 chats' : '拒绝来自 2 个对话的更改', exact: true });
		await page.keyboard.press('Tab');
		await expect(accept).toBeFocused();
		await page.keyboard.press('Tab');
		await expect(reject).toBeFocused();
		await page.keyboard.press('Enter');
		await expect(picker).toHaveCount(0);
		await expect.poll(() => page.evaluate(() => window.ashChatEditingIntegration.snapshot())).toEqual({ entries: [['/workspace/second.txt']], texts: ['original', 'second change'] });
	});
}
