import { expect } from '@playwright/test';
import { suite, test } from 'mocha';
import { useBrowserTests } from '../../../../../../../test/unit/browser/context.js';

suite('chatSessionHistory browser component', () => {
	const browserTests = useBrowserTests();
	for (const locale of ['en', 'zh-CN']) {
		for (const theme of ['light', 'dark', 'hc', 'hcLight'] as const) {
			test(`Chat history recovery is keyboard accessible and preserves the draft in ${locale} ${theme}`, async function () {
				const { page } = browserTests;

				await page.goto(`/chatTranscript.html${locale === 'en' ? '' : '?locale=zh-CN'}`);
				await page.evaluate(theme => {
					window.ashChatTranscriptIntegration.setTheme(theme);
					window.ashChatTranscriptIntegration.showHistoryFailure();
					(document.querySelector('#app-chat')!.parentElement as HTMLElement).style.width = '360px';
				}, theme);
				const chat = page.locator('#app-chat');
				const input = chat.locator('.ash-chat-textarea-input');
				await input.fill('Preserved synthetic draft');
				await page.evaluate(() => window.ashChatTranscriptIntegration.addUserContext());
				const originalDraft = await input.inputValue();
				await input.press('Enter');
				expect(await page.evaluate(() => window.ashChatTranscriptIntegration.chatMessages())).toEqual([]);
				const recovery = chat.locator('.ash-chat-history-status');
				const retry = recovery.getByRole('button', { name: locale === 'en' ? 'Retry loading chat' : '重新加载聊天', exact: true });
				await expect(recovery.getByRole('status')).toContainText(locale === 'en' ? 'Could not load chat history' : '无法加载聊天历史');
				await retry.focus();
				expect(await page.evaluate(() => window.ashChatTranscriptIntegration.openAccessibleView(true))).toBe(true);
				const accessible = page.getByRole('dialog');
				await expect(accessible.getByRole('textbox')).toHaveValue(locale === 'en' ? /never sends a message/u : /不会发送消息/u);
				await page.keyboard.press('Escape');
				await expect(retry).toBeFocused();
				const geometry = await recovery.evaluate(element => ({ width: element.clientWidth, content: element.scrollWidth }));
				expect(geometry.content).toBeLessThanOrEqual(geometry.width);
				await chat.screenshot({ path: browserTests.info.outputPath('history-recovery.png') });
				await retry.press('Enter');
				await expect(retry).toBeDisabled();
				await expect(recovery).toHaveAttribute('aria-busy', 'true');
				expect(await page.evaluate(() => window.ashChatTranscriptIntegration.historyRecoveries())).toBe(1);
				await page.evaluate(() => window.ashChatTranscriptIntegration.finishHistoryRecovery());
				await expect(recovery).toBeHidden();
				await expect(input).toBeFocused();
				await expect(input).toHaveValue(originalDraft);
				expect(await page.evaluate(() => window.ashChatTranscriptIntegration.chatDraftContextNames())).toEqual(['private.txt']);
				expect(await page.evaluate(() => window.ashChatTranscriptIntegration.chatMessages())).toEqual([]);
			});
		}
	}
});
