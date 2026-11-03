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
			expect(text).toMatch(locale === 'en' ? /run Compare Agents from the Command Palette/ : /从命令面板运行“比较 Agent”/);
			expect(text).toMatch(locale === 'en' ? /Open Add context \(\+\) and choose Pull Request/ : /打开添加上下文（\+），选择拉取请求/);
			expect(text).toMatch(locale === 'en' ? /Open Add context \(\+\) and choose Issue/ : /打开添加上下文（\+），选择 Issue/);
			const worktreeHelp = locale === 'en' ? /Use Enter or Space on New worktree to toggle it/ : /在“新建工作树”上按 Enter 或空格可切换开关/;
			expect(text).toMatch(worktreeHelp);
			expect(text).toMatch(locale === 'en' ? /With focus in the Sessions sidebar, press Control\+F or Command\+F to search/ : /焦点位于会话侧栏时，按 Control\+F 或 Command\+F 搜索/);
			expect(text).toMatch(locale === 'en' ? /Focus Workspace Picker or Focus Environment Picker/ : /聚焦工作区选择器.*聚焦环境选择器/);
			expect(text.match(locale === 'en' ? /Chat: Configure Tools/g : /聊天：配置工具/g)).toHaveLength(1);
			await page.keyboard.press('Escape');
			await expect(content).toBeHidden();
			await expect(input).toBeFocused();
			await expect(page.locator('.ash-sessions-chat-slot.active .ash-chat-input-editor .view-lines')).toHaveText('Keep this draft');
			const permissions = page.locator('.ash-sessions-chat-slot.active .ash-chat-input-permission-picker');
			await permissions.focus();
			await page.keyboard.press('Alt+F1');
			await expect(content).toHaveValue(locale === 'en' ? /Open Add context \(\+\) and choose Pull Request/ : /打开添加上下文（\+），选择拉取请求/);
			await expect(content).toHaveValue(worktreeHelp);
			await page.keyboard.press('Escape');
			await expect(permissions).toBeFocused();
		});
	}

	test('Code draft shortcuts open the matching picker and Escape restores its trigger', async () => {
		const { page } = browser;
		await page.goto('/sessions.html');
		await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
		await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
		const composer = page.locator('.ash-sessions-chat-slot.active');
		const input = composer.locator('.ash-chat-input-editor .stanza-editor').getByRole('textbox');
		await input.focus();
		await page.keyboard.insertText('Keep this draft');

		for (const [key, selector] of [['f', '.ash-sessions-workspace-picker'], ['e', '.ash-sessions-environment-picker']] as const) {
			const trigger = composer.locator(selector);
			await input.focus();
			await page.keyboard.press('ControlOrMeta+k');
			await page.keyboard.press(`ControlOrMeta+${key}`);
			await expect(trigger).toHaveAttribute('aria-expanded', 'true');
			await page.keyboard.press('Escape');
			await expect(trigger).toHaveAttribute('aria-expanded', 'false');
			await expect(trigger).toBeFocused();
		}
		await expect(composer.locator('.ash-chat-input-editor .view-lines')).toHaveText('Keep this draft');
	});
});
