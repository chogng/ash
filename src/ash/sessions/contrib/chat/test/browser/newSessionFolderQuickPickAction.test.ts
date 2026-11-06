import { expect } from '@playwright/test';
import { suite, test } from 'mocha';
import { useBrowserTests } from '../../../../../../../test/unit/browser/context.js';

suite('New Session in Folder', () => {
	const browser = useBrowserTests();

	test('selects a recent folder from the command palette and opens a fresh Code draft', async () => {
		const { page } = browser;
		await page.goto('/sessions.html?multiHost&catalog&search&projectPicker&environmentSetup&locale=zh-CN');
		await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
		await page.locator('.ash-window-mode-control').getByRole('button', { name: '代码', exact: true }).click();
		const composer = page.locator('.ash-sessions-chat-slot.active .ash-chat-input-editor');
		const message = composer.getByRole('textbox');
		await message.focus();
		await page.keyboard.insertText('Keep this draft');
		const quickInput = page.locator('.ash-quick-pick');
		const prompt = quickInput.getByRole('combobox');
		const showFolderPicker = async () => {
			await page.keyboard.press('F1');
			await prompt.fill('>在文件夹中创建会话');
			await quickInput.getByText('在文件夹中创建会话…', { exact: true }).click();
			await expect(prompt).toHaveAttribute('placeholder', '选择用于启动新会话的文件夹');
		};
		await showFolderPicker();
		await page.keyboard.press('Escape');
		await expect(composer.locator('.view-lines')).toHaveText('Keep this draft');
		await showFolderPicker();
		await quickInput.getByText('host-a', { exact: true }).click();
		await expect(page.locator('.ash-sessions-chat-slot.active .ash-sessions-workspace-picker')).toHaveText('Code project fixture');
		await expect(composer.locator('.view-lines')).toHaveText('');
	});
});
