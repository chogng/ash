import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { expect } from '@playwright/test';
import { useBrowserTests } from '../../../../../../../../test/unit/browser/context.js';
import type { } from '../../../../../../../../test/fixtures/browser/chatTranscript.page.js';

suite('Chat transcript navigation', () => {
	const browserTests = useBrowserTests();
	const messages = [
		{ id: 'first', type: 'userMessage' as const, text: 'First request', transient: false },
		{ id: 'reply-first', type: 'agentMessage' as const, text: 'First answer', transient: false },
		{ id: 'second', type: 'userMessage' as const, text: 'Second request', transient: false },
		{ id: 'reply-second', type: 'agentMessage' as const, text: 'Second answer', transient: false },
	];

	test('real command handlers focus requests, preserve their DOM through streaming and use prepended history', async () => {
		const { page } = browserTests;
		await page.goto('/chatTranscript.html');
		await page.evaluate(messages => window.ashChatTranscriptIntegration.renderItems(messages), messages);
		await page.evaluate(() => window.ashChatTranscriptIntegration.runNavigationCommand('workbench.action.chat.previousUserPrompt'));
		await expect(page.locator('[data-item-id="second"]')).toBeFocused();
		const first = await page.locator('[data-item-id="first"]').elementHandle();
		await page.evaluate(() => window.ashChatTranscriptIntegration.runNavigationCommand('workbench.action.chat.previousUserPrompt'));
		await expect(page.locator('[data-item-id="first"]')).toBeFocused();
		await page.evaluate(messages => window.ashChatTranscriptIntegration.renderItems([
			{ id: 'older', type: 'userMessage', text: 'Earlier request', transient: false },
			...messages.slice(0, -1), { ...messages.at(-1)!, text: 'Corrected answer', transient: true },
		]), messages);
		expect(await first!.evaluate(element => element.isConnected)).toBe(true);
		await page.evaluate(() => window.ashChatTranscriptIntegration.runNavigationCommand('workbench.action.chat.previousUserPrompt'));
		await expect(page.locator('[data-item-id="older"]')).toBeFocused();
		await page.evaluate(() => window.ashChatTranscriptIntegration.runNavigationCommand('workbench.action.chat.previousUserPrompt'));
		await expect(page.locator('[data-item-id="older"]')).toBeFocused();
		await page.evaluate(() => window.ashChatTranscriptIntegration.runNavigationCommand('workbench.action.chat.nextUserPrompt'));
		await expect(page.locator('[data-item-id="first"]')).toBeFocused();
	});

	test('pins the prompt above a long reply and returns focus to the original message', async () => {
		const { page } = browserTests;
		await page.goto('/chatTranscript.html?locale=zh-CN');
		await page.evaluate(messages => window.ashChatTranscriptIntegration.renderItems(
			messages.map(item => item.type === 'agentMessage' ? { ...item, text: (item.text + '\n\n').repeat(100) } : item)
		), messages);
		const viewport = page.locator('.ash-chat-transcript-scrollable > .ash-scrollbar-viewport');
		await viewport.evaluate(element => { element.scrollTop = 0; });
		const pinned = page.locator('.ash-chat-sticky-prompt');
		await expect(pinned).toBeHidden();
		await viewport.evaluate(element => { element.scrollTop = 200; });
		await expect(pinned).toHaveAccessibleName('跳转到用户消息：First request');
		expect(await pinned.evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
		await viewport.evaluate(element => { element.scrollTop = element.scrollHeight; });
		await expect(pinned).toHaveAccessibleName('跳转到用户消息：Second request');
		await pinned.focus();
		await pinned.press('Enter');
		await expect(page.locator('[data-item-id="second"]')).toBeFocused();
		await expect(pinned).toBeHidden();
	});

	test('navigates loaded prompts in the gutter and ruler and dispatches a file review', async () => {
		const { page } = browserTests;
		await page.goto('/chatTranscript.html?locale=zh-CN&promptTimeline');
		await page.evaluate(messages => window.ashChatTranscriptIntegration.renderItems(messages), messages);
		await page.getByLabel('显示提问', { exact: true }).press('Enter');
		const gutter = page.locator('.ash-prompt-timeline-gutter');
		await gutter.getByText('已更改的文件（1）').press('Enter');
		await gutter.getByRole('button', { name: 'src/example.ts' }).press('Enter');
		await expect(page.locator('main[data-reviewed-prompt]')).toHaveAttribute('data-reviewed-prompt', 'second');
		await gutter.getByRole('button', { name: 'Second request' }).press('Enter');
		await expect(page.locator('[data-item-id="second"]')).toBeFocused();
		await page.evaluate(() => window.ashChatTranscriptIntegration.setPromptTimeline('ruler'));
		const ruler = page.locator('.ash-prompt-timeline-ruler');
		await ruler.getByRole('button', { name: 'First request' }).press('Enter');
		await expect(ruler.getByRole('button', { name: 'First request' }).last()).toBeFocused();
		await ruler.getByRole('button', { name: 'First request' }).last().press('Escape');
		await expect(ruler.getByRole('button', { name: 'First request' })).toHaveAttribute('aria-expanded', 'false');
		await page.evaluate(() => window.ashChatTranscriptIntegration.setPromptTimeline('off'));
		await expect(ruler).toHaveCount(0);
	});

	test('latest and remembered focus remain distinct, removed rows retire focus and hidden lists do not steal it', async () => {
		const { page } = browserTests;
		await page.goto('/chatTranscript.html');
		await page.evaluate(messages => window.ashChatTranscriptIntegration.renderItems(messages), messages);
		await page.evaluate(() => window.ashChatTranscriptIntegration.runNavigationCommand('chat.action.focus'));
		await expect(page.locator('[data-item-id="reply-second"]')).toBeFocused();
		await page.locator('[data-item-id="reply-first"]').getByRole('button', { name: 'Copy message', exact: true }).focus();
		await page.locator('.stanza-editor-input').first().focus();
		await page.evaluate(() => window.ashChatTranscriptIntegration.recreateTranscript());
		await page.evaluate(() => window.ashChatTranscriptIntegration.runNavigationCommand('workbench.chat.action.focusLastFocused'));
		await expect(page.locator('[data-item-id="reply-first"]')).toBeFocused();
		await page.evaluate(messages => window.ashChatTranscriptIntegration.renderItems(messages.slice(2)), messages);
		await page.evaluate(() => window.ashChatTranscriptIntegration.runNavigationCommand('workbench.chat.action.focusLastFocused'));
		await expect(page.locator('[data-item-id="reply-second"]')).toBeFocused();
		await page.evaluate(() => window.ashChatTranscriptIntegration.setTranscriptVisible(false));
		await page.locator('.stanza-editor-input').first().focus();
		await page.evaluate(() => window.ashChatTranscriptIntegration.runNavigationCommand('chat.action.focus'));
		await expect(page.locator('.stanza-editor-input').first()).toBeFocused();
	});

	test('Simplified Chinese transcript help documents navigation and confirmation focus', async () => {
		const { page } = browserTests;
		await page.goto('/chatTranscript.html?locale=zh-CN');
		await page.evaluate(messages => window.ashChatTranscriptIntegration.renderItems(messages), messages);
		await page.evaluate(() => window.ashChatTranscriptIntegration.runNavigationCommand('chat.action.focus'));
		expect(await page.evaluate(() => window.ashChatTranscriptIntegration.openAccessibleView(true))).toBe(true);
		const help = page.getByRole('dialog').getByRole('textbox');
		await expect(help).toHaveValue(/固定在对话顶部[\s\S]*用户提问之间移动[\s\S]*聚焦待确认控件/u);
		await expect(help).not.toHaveValue(/Use |<keybinding:/u);
		await help.press('Escape');
		await expect(page.locator('[data-item-id="reply-second"]')).toBeFocused();
	});

	for (const theme of ['light', 'dark', 'hc', 'hcLight'] as const) {
		test(`focused rows have an inset theme outline and remain in the viewport in ${theme}`, async () => {
			const { page } = browserTests;
			await page.goto('/chatTranscript.html');
			await page.evaluate(({ theme, messages }) => {
				window.ashChatTranscriptIntegration.setTheme(theme);
				window.ashChatTranscriptIntegration.renderItems(messages);
			}, { theme, messages });
			await page.keyboard.press('Tab');
			await page.evaluate(() => window.ashChatTranscriptIntegration.runNavigationCommand('chat.action.focus'));
			const row = page.locator('[data-item-id="reply-second"]');
			await expect(row).toBeFocused();
			const style = await row.evaluate(element => {
				const style = getComputedStyle(element);
				return { width: style.outlineWidth, offset: style.outlineOffset, color: style.outlineColor, focusVisible: element.matches(':focus-visible') };
			});
			assert.deepEqual({ width: style.width, offset: style.offset, focusVisible: style.focusVisible }, { width: '1px', offset: '-1px', focusVisible: true });
			expect(style.color).not.toBe('rgba(0, 0, 0, 0)');
			const bounds = await row.boundingBox();
			const viewport = await page.locator('.ash-chat-transcript-scrollable > .ash-scrollbar-viewport').boundingBox();
			expect(bounds!.y).toBeGreaterThanOrEqual(viewport!.y);
			expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport!.y + viewport!.height + 1);
		});
	}
});
