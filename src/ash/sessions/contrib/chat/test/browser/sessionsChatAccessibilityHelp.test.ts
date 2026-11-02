import { suite, test } from 'mocha';
import { expect } from '@playwright/test';
import { useBrowserTests } from '../../../../../../../test/unit/browser/context.js';

suite('Sessions Chat accessibility help', () => {
	const browser = useBrowserTests();

	for (const locale of ['en', 'zh-CN']) {
		test(`input help combines shared operations and Sessions policy and restores focus (${locale})`, async () => {
			const { page } = browser;
			await page.goto(`/sessions.html?locale=${locale}`);
			await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
			await page.locator('.ash-window-mode-control').getByRole('button', { name: locale === 'en' ? 'Code' : '代码', exact: true }).click();
			const input = page.locator('.ash-sessions-chat-slot.active .ash-chat-input-editor .stanza-editor').getByRole('textbox');
			await expect(input).toBeVisible();
			await input.focus();
			await page.keyboard.insertText('Keep this draft');
			await page.keyboard.press('Alt+F1');
			const content = page.locator('.ash-accessible-view-content');
			await expect(content).toBeVisible();
			const text = await content.inputValue();
			expect(text).toMatch(locale === 'en' ? /Chat: Configure Tools/ : /聊天：配置工具/);
			expect(text).toMatch(locale === 'en' ? /New worktree asks for a new Git branch name/ : /新建 worktree/);
			expect(text.match(locale === 'en' ? /Chat: Configure Tools/g : /聊天：配置工具/g)).toHaveLength(1);
			await page.keyboard.press('Escape');
			await expect(content).toBeHidden();
			await expect(input).toBeFocused();
			await expect(page.locator('.ash-sessions-chat-slot.active .ash-chat-input-editor .view-lines')).toHaveText('Keep this draft');
			const permissions = page.locator('.ash-sessions-chat-slot.active .ash-chat-input-permission-picker');
			await permissions.focus();
			await page.keyboard.press('Alt+F1');
			await expect(content).toHaveValue(locale === 'en' ? /New worktree asks for a new Git branch name/ : /新建 worktree/);
			await page.keyboard.press('Escape');
			await expect(permissions).toBeFocused();
		});
	}
});
