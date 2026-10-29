import { expect } from '@playwright/test';
import { suite, test } from 'mocha';
import { useBrowserTests } from '../../../../../../../test/unit/browser/context.js';

suite('chatSettings browser component', () => {
	const browserTests = useBrowserTests();
	for (const locale of ['en', 'zh-CN']) {
		for (const cowork of [false, true]) {
			test(`AI settings preserve the keyboard draft and contexts in ${locale} ${cowork ? 'Cowork' : 'Chat'}`, async function () {
				const { page } = browserTests;

				const errors: string[] = [];
				page.on('pageerror', error => errors.push(error.message));
				await page.goto(`/chatTranscript.html${locale === 'en' ? '' : '?locale=zh-CN'}`);
				await page.waitForFunction(() => !!window.ashChatTranscriptIntegration);
				await page.evaluate(cowork => window.ashChatTranscriptIntegration.showChatApp(false, cowork), cowork);
				const chat = page.locator('#app-chat');
				const input = chat.locator(cowork ? '.stanza-editor-input' : '.ash-chat-textarea-input');
				if (cowork) {
					await input.focus();
					await page.keyboard.insertText('Preserved synthetic AI draft');
				} else await input.fill('Preserved synthetic AI draft');
				await page.evaluate(() => window.ashChatTranscriptIntegration.addUserContext());
				const originalDraft = await page.evaluate(() => window.ashChatTranscriptIntegration.chatDraft());
				expect(await page.evaluate(() => window.ashChatTranscriptIntegration.isCodeChatActive())).toBe(true);
				await page.evaluate(() => window.ashChatTranscriptIntegration.setAIDisabled(true));
				expect(await page.evaluate(() => window.ashChatTranscriptIntegration.isCodeChatActive())).toBe(false);
				await expect(chat.locator('.ash-chat-status, .ash-chat-status-summary')).toContainText(
					locale === 'en' ? 'AI features are disabled' : 'AI 功能已禁用',
				);
				await input.press('Enter');
				expect(await page.evaluate(() => window.ashChatTranscriptIntegration.chatMessages())).toEqual([]);
				expect(await page.evaluate(() => window.ashChatTranscriptIntegration.chatDraft())).toBe(originalDraft);
				expect(await page.evaluate(() => window.ashChatTranscriptIntegration.chatDraftContextNames())).toEqual([
					'private.txt',
				]);
				expect(await page.evaluate(() => window.ashChatTranscriptIntegration.openAccessibleView(true))).toBe(
					true,
				);
				await expect(page.getByRole('dialog').getByRole('textbox')).toHaveValue(
					locale === 'en' ? /Disable AI features in Settings/u : /禁用 AI 功能/u,
				);
				await page.keyboard.press('Escape');
				await expect(input).toBeFocused();
				await chat.screenshot({ path: browserTests.info.outputPath('ai-disabled.png') });
				await page.evaluate(() => window.ashChatTranscriptIntegration.setAIDisabled(false));
				expect(await page.evaluate(() => window.ashChatTranscriptIntegration.isCodeChatActive())).toBe(true);
				await input.press('Enter');
				await expect
					.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.chatMessages().length))
					.toBe(1);
				expect(errors).toEqual([]);
			});
		}
	}

	for (const locale of ['en', 'zh-CN']) {
		for (const cowork of [false, true]) {
			test(`Disabling AI closes the window's active voice conversation in ${locale} ${cowork ? 'Cowork' : 'Chat'}`, async function () {
				const { page } = browserTests;

				const errors: string[] = [];
				page.on('pageerror', error => errors.push(error.message));
				await page.goto(`/chatTranscript.html${locale === 'en' ? '' : '?locale=zh-CN'}`);
				await page.evaluate(cowork => window.ashChatTranscriptIntegration.showChatApp(true, cowork), cowork);
				const chat = page.locator('#app-chat');
				const voice = chat.getByRole('button', {
					name: locale === 'en' ? 'Voice conversation' : '语音对话',
					exact: true,
				});
				await voice.focus();
				await voice.press('Enter');
				const options = page.getByRole('combobox', {
					name: locale === 'en' ? 'Voice conversation options' : '语音对话选项',
					exact: true,
				});
				await options.fill('marin');
				await options.press('Enter');
				await expect
					.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.voiceState()))
					.toEqual(['start']);
				await page.evaluate(() => window.ashChatTranscriptIntegration.setAIDisabled(true));
				await expect
					.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.voiceState()))
					.toEqual(['start', 'stop']);
				await expect(voice).toBeDisabled();
				await page.evaluate(() => window.ashChatTranscriptIntegration.proposeVoiceTask());
				expect(await page.evaluate(() => window.ashChatTranscriptIntegration.chatMessages())).toEqual([]);
				await page.evaluate(() => window.ashChatTranscriptIntegration.setAIDisabled(false));
				await expect(voice).toBeEnabled();
				expect(await page.evaluate(() => window.ashChatTranscriptIntegration.voiceState())).toEqual([
					'start',
					'stop',
				]);
				expect(errors).toEqual([]);
			});
		}
	}
});
