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
			const controls = page.locator('.ash-sessions-chat-slot.active').getByRole('toolbar', { name: locale === 'en' ? 'Session controls' : '会话控件', exact: true });
			await expect(controls.getByRole('button')).toHaveCount(2);
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
			expect(text).toMatch(locale === 'en' ? /type #session to find conversations on the same host/ : /输入 #session 可查找同一主机上的对话/);
			expect(text).toMatch(locale === 'en' ? /reach Browsers above the input/ : /聚焦输入框上方的浏览器页签按钮/);
			expect(text).toMatch(locale === 'en' ? /Press Enter or Space on Autopilot or Activities/ : /在“自动跟进”或“活动”上按 Enter 或空格/);
			expect(text).toMatch(locale === 'en' ? /Run New Session in Folder from the Command Palette/ : /从命令面板运行“在文件夹中创建会话”/);
			const worktreeHelp = locale === 'en' ? /Use Enter or Space on New worktree to toggle it/ : /在“新建工作树”上按 Enter 或空格可切换开关/;
			expect(text).toMatch(worktreeHelp);
			expect(text).toMatch(locale === 'en' ? /With focus in the Sessions sidebar, press Control\+F or Command\+F to search/ : /焦点位于会话侧栏时，按 Control\+F 或 Command\+F 搜索/);
			expect(text).toMatch(locale === 'en' ? /Focus Project Picker or Focus Environment Picker/ : /聚焦项目选择器.*聚焦环境选择器/);
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
		const environment = composer.locator('.ash-sessions-environment-picker');
		const workspace = composer.locator('.ash-sessions-workspace-picker');
		await environment.focus();
		await environment.press('ArrowRight');
		await expect(workspace).toBeFocused();
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
