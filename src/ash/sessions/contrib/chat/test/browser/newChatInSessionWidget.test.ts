import { expect } from '@playwright/test';
import { suite, test } from 'mocha';
import { useBrowserTests } from '../../../../../../../test/unit/browser/context.js';
import type { } from '../../../../../../../test/fixtures/browser/sessions.page.js';

suite('New Chat in Current Session', () => {
	const browser = useBrowserTests();

	test('opens an unsent child draft and forks only when the first message is sent', async () => {
		const { page } = browser;
		await page.goto('/sessions.html?multiHost&nestedDraft&locale=zh-CN');
		await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
		await page.locator('.ash-window-mode-control').getByRole('button', { name: '代码', exact: true }).click();
		await page.evaluate(async () => {
			const fixture = window.ashSessionsIntegration.multiHost!;
			await fixture.open('Host A');
			await fixture.newChatInSession();
		});
		const active = page.locator('.ash-sessions-chat-slot.active');
		await expect(active.getByText('使用当前对话的 Agent、代码和历史开始一条并行对话。')).toBeVisible();
		const agent = active.locator('.ash-chat-input-mode-action');
		await expect(agent).toHaveText('Agent A');
		await agent.press('ArrowDown');
		const agentMenu = page.locator('.ash-chat-input-mode-menu');
		await expect(agentMenu.getByRole('menuitemradio', { name: 'Agent A', exact: true })).toBeDisabled();
		await expect(agentMenu.getByText('Agent B', { exact: true })).toHaveCount(0);
		await page.keyboard.press('Escape');
		const nested = page.getByRole('group', { name: 'Task from Host A 中的对话' });
		await expect(nested.getByRole('button', { name: /新对话/ })).toBeVisible();
		const relevantCalls = () => page.evaluate(() => window.ashSessionsIntegration.multiHost!.calls.filter(call => call.method === 'fork' || call.method === 'send'));
		expect(await relevantCalls()).toEqual([]);
		await active.locator('.ash-chat-input-editor .stanza-editor').getByRole('textbox').focus();
		await page.keyboard.insertText('Write a follow-up test');
		await page.screenshot({ path: browser.info.outputPath('new-chat-in-session.png') });
		await page.keyboard.press('Enter');
		await expect.poll(relevantCalls).toEqual([
			{ host: 'Host A', method: 'fork', sessionId: 'same', threadId: 'same' },
			{ host: 'Host A', method: 'send', sessionId: 'same', threadId: 'side' },
		]);
		await expect(page.locator('.ash-sessions-chat-slot:visible')).toHaveCount(2);
		await expect(nested.getByRole('button', { name: '新对话', exact: true })).toHaveAttribute('aria-current', 'page');
		await expect(agent).toHaveText('Agent A');
	});

	test('restores the source Agent when an older draft saved a different Agent', async () => {
		const { page } = browser;
		await page.goto('/sessions.html?multiHost&nestedDraft');
		await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
		await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
		await page.evaluate(async () => {
			const fixture = window.ashSessionsIntegration.multiHost!;
			await fixture.open('Host B');
			await fixture.newChatInSession();
		});
		const active = page.locator('.ash-sessions-chat-slot.active');
		const input = active.locator('.ash-chat-input-editor').getByRole('textbox');
		await input.focus();
		await page.keyboard.insertText('Resume this draft');
		await page.evaluate(() => window.ashSessionsIntegration.multiHost!.saveLegacyNestedDraft());
		await page.reload();
		await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
		await expect(active.locator('.ash-chat-input-editor .view-lines')).toHaveText('Resume this draft');
		await expect(active.locator('.ash-chat-input-mode-action')).toHaveText('Agent A');
		await input.press('Enter');
		await expect.poll(() => page.evaluate(() => window.ashSessionsIntegration.multiHost!.calls.filter(call => call.method === 'fork' || call.method === 'send'))).toEqual([
			{ host: 'Host B', method: 'fork', sessionId: 'same', threadId: 'same' },
			{ host: 'Host B', method: 'send', sessionId: 'same', threadId: 'side' },
		]);
	});
});
