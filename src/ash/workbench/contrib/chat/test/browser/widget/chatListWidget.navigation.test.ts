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
			messages.map(item => item.type === 'agentMessage' ? { ...item, text: (item.text + '\n\n').repeat(100) }
				: item.id === 'first' ? { ...item, text: 'First request\nSecond line\nThird line' } : item)
		), messages);
		const viewport = page.locator('.ash-chat-transcript-scrollable > .ash-scrollbar-viewport');
		await viewport.evaluate(element => { element.scrollTop = 0; });
		const pinned = page.locator('.ash-chat-sticky-prompt');
		await expect(pinned).toBeHidden();
		await viewport.evaluate(element => {
			const first = element.querySelector('[data-item-id="first"]')!;
			element.scrollTop += first.getBoundingClientRect().top - element.getBoundingClientRect().top + 5;
		});
		await expect(pinned).toHaveAccessibleName('跳转到第 1 条用户消息，共 2 条：First request Second line Third line');
		await expect(pinned.locator('.ash-chat-sticky-prompt-count')).toHaveText('1/2');
		expect(await pinned.evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
		await viewport.evaluate(element => { element.scrollTop = element.scrollHeight; });
		await expect(pinned).toHaveAccessibleName('跳转到第 2 条用户消息，共 2 条：Second request');
		await expect(pinned.locator('.ash-chat-sticky-prompt-count')).toHaveText('2/2');
		await pinned.focus();
		await pinned.press('Enter');
		const second = page.locator('[data-item-id="second"]');
		await expect(second).toBeFocused();
		await expect(pinned).toBeHidden();
		expect(Math.abs((await second.boundingBox())!.y - (await viewport.boundingBox())!.y)).toBeLessThanOrEqual(1);
	});

	test('navigates loaded prompts and opens a turn review directly from its counts', async () => {
		const { page } = browserTests;
		await page.goto('/chatTranscript.html?locale=zh-CN&promptTimeline');
		await page.evaluate(messages => window.ashChatTranscriptIntegration.renderItems(messages), messages);
		const gutter = page.locator('.ash-prompt-timeline-gutter');
		const handle = gutter.getByLabel('显示提问', { exact: true });
		const marks = gutter.locator('.ash-prompt-timeline-gutter-marks > span');
		await expect(marks).toHaveCount(2);
		await expect(marks.first()).toHaveClass('active');
		const host = page.locator('main');
		await host.evaluate(element => element.classList.add('ash-chat-content-layout'));
		for (const width of [1200, 600]) {
			await host.evaluate((element, width) => { element.style.width = `${width}px`; }, width);
			const position = await gutter.evaluate(element => {
				const rail = element.getBoundingClientRect();
				const pane = element.parentElement!.getBoundingClientRect();
				return {
					inset: rail.left - pane.left,
					centerOffset: rail.top + rail.height / 2 - (pane.top + pane.height / 2),
				};
			});
			expect(position.inset).toBeCloseTo(4);
			expect(Math.abs(position.centerOffset)).toBeLessThan(1);
		}
		const panel = gutter.locator('.ash-prompt-timeline-panel');
		const firstPrompt = panel.getByRole('button', { name: 'First request', exact: true });
		const secondPrompt = panel.getByRole('button', { name: 'Second request', exact: true });
		await marks.last().hover();
		await expect(secondPrompt).toBeVisible();
		await expect(secondPrompt.locator('..')).toHaveClass(/\bpreview\b/);
		await page.mouse.move(0, 0);
		await expect(panel).toBeHidden();
		await marks.last().hover();
		await secondPrompt.click();
		await expect(page.locator('[data-item-id="second"]')).toBeFocused();
		await expect(panel).toBeHidden();

		await handle.press('Enter');
		await expect(firstPrompt).toBeFocused();
		await firstPrompt.press('ArrowDown');
		await expect(secondPrompt).toBeFocused();
		await secondPrompt.press('ArrowRight');
		const review = panel.getByRole('button', { name: /查看提问「Second request」的改动.*新增 2 行，删除 1 行/u });
		await expect(review).toBeFocused();
		await expect(review).toHaveText('+2 −1');
		await review.press('Escape');
		await expect(handle).toBeFocused();
		await expect(gutter).not.toHaveAttribute('open');
		await handle.press('Enter');
		await expect(panel.locator('.ash-prompt-timeline-review')).toHaveCount(1);
		await review.click();
		await expect(page.locator('main')).toHaveAttribute('data-reviewed-turn', 'second');
		await expect(panel).toBeHidden();
		await page.evaluate(() => window.ashChatTranscriptIntegration.setPromptTimeline('ruler'));
		const ruler = page.locator('.ash-prompt-timeline-ruler');
		await ruler.getByRole('button', { name: 'First request' }).press('Enter');
		await expect(ruler.getByRole('button', { name: 'First request' }).last()).toBeFocused();
		await ruler.getByRole('button', { name: 'First request' }).last().press('Escape');
		await expect(ruler.getByRole('button', { name: 'First request' })).toHaveAttribute('aria-expanded', 'false');
		await ruler.getByRole('button', { name: 'Second request', exact: true }).press('Enter');
		await ruler.getByText('已更改的文件（1）').press('Enter');
		await ruler.getByRole('button', { name: 'src/example.ts' }).press('Enter');
		await expect(page.locator('main')).toHaveAttribute('data-reviewed-prompt', 'second');
		await page.evaluate(() => window.ashChatTranscriptIntegration.setPromptTimeline('off'));
		await expect(ruler).toHaveCount(0);
	});

	test('highlights the focused prompt, fans out the hovered marks, and scrolls the list independently', async () => {
		const { page } = browserTests;
		await page.goto('/chatTranscript.html?locale=zh-CN&promptTimeline');
		await page.evaluate(() => {
			window.ashChatTranscriptIntegration.renderItems(Array.from({ length: 18 }, (_, index) => ({
				id: `prompt-${index}`, type: 'userMessage', text: `Prompt ${index + 1}`, transient: false,
			})));
		});
		const gutter = page.locator('.ash-prompt-timeline-gutter');
		const handle = gutter.getByLabel('显示提问', { exact: true });
		const marks = gutter.locator('.ash-prompt-timeline-gutter-marks > span');
		const viewport = page.locator('.ash-chat-transcript-scrollable > .ash-scrollbar-viewport');
		await viewport.evaluate(element => { element.scrollTop = 0; });
		await expect(marks.first()).toHaveClass('active');
		const prompt = viewport.locator('[data-item-id="prompt-4"]');
		await expect(prompt).toBeInViewport();
		await prompt.evaluate(element => element.focus({ preventScroll: true }));
		await expect(marks.nth(4)).toHaveClass('active');
		await expect(gutter.locator('.ash-prompt-timeline-gutter-marks > .active')).toHaveCount(1);
		const readStrokes = () => marks.evaluateAll(elements => elements.slice(0, 9).map(element => {
			const stroke = getComputedStyle(element, '::before');
			return { width: parseFloat(stroke.width), color: stroke.borderTopColor };
		}));
		const readWidths = async () => (await readStrokes()).map(stroke => stroke.width);
		const restingWidths = Array<number>(9).fill(6);
		for (const theme of ['light', 'dark', 'hc', 'hcLight'] as const) {
			await page.evaluate(theme => window.ashChatTranscriptIntegration.setTheme(theme), theme);
			const strokes = await readStrokes();
			expect(strokes.map(stroke => stroke.width)).toEqual(restingWidths);
			expect(strokes[4].color).not.toBe(strokes[0].color);
		}
		await page.evaluate(() => window.ashChatTranscriptIntegration.setTheme('light'));
		await marks.nth(4).hover();
		await expect(handle).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
		await expect.poll(readWidths).toEqual([6, 10, 16, 20, 24, 20, 16, 10, 6]);
		await marks.nth(5).hover();
		await expect.poll(readWidths).toEqual([6, 6, 10, 16, 20, 24, 20, 16, 10]);
		await expect(marks.nth(4)).toHaveClass('active');
		await page.mouse.move(0, 0);
		await expect.poll(readWidths).toEqual(restingWidths);

		await handle.focus();
		await expect(marks.first()).toHaveClass('active');
		await handle.press('Enter');
		await expect(handle).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
		const panel = gutter.locator('.ash-prompt-timeline-panel');
		const first = panel.getByRole('button', { name: 'Prompt 1', exact: true });
		await expect(first).toBeFocused();
		expect(await panel.evaluate(element => getComputedStyle(element, '::-webkit-scrollbar').width)).toBe('8px');
		await panel.hover();
		await page.mouse.wheel(0, 240);
		await expect.poll(() => panel.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
		expect(await viewport.evaluate(element => element.scrollTop)).toBe(0);
		await first.press('Escape');
		await expect(handle).toBeFocused();
		await expect(handle).toHaveCSS('outline-style', 'solid');
		await expect(panel).toBeHidden();

		await marks.last().click();
		const lastPrompt = viewport.locator('[data-item-id="prompt-17"]');
		await expect(lastPrompt).toBeFocused();
		await expect(lastPrompt).toBeInViewport();
		await expect(marks.last()).toHaveClass('active');
		await expect(panel).toBeHidden();
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
		await page.goto('/chatTranscript.html?locale=zh-CN&promptTimeline');
		await page.evaluate(messages => window.ashChatTranscriptIntegration.renderItems(messages), messages);
		await page.evaluate(() => window.ashChatTranscriptIntegration.runNavigationCommand('chat.action.focus'));
		expect(await page.evaluate(() => window.ashChatTranscriptIntegration.openAccessibleView(true))).toBe(true);
		const help = page.getByRole('dialog').getByRole('textbox');
		await expect(help).toHaveValue(/悬停在左侧时间线/u);
		await expect(help).toHaveValue(/点击标记即可跳转到预览的提问/u);
		await expect(help).toHaveValue(/固定在对话顶部[\s\S]*用户提问之间移动[\s\S]*聚焦待确认控件/u);
		await expect(help).not.toHaveValue(/Use |<keybinding:/u);
		await help.press('Escape');
		await expect(page.locator('[data-item-id="reply-second"]')).toBeFocused();
	});

	test('transcript scroll layers stay unoutlined even with keyboard focus', async () => {
		const { page } = browserTests;
		await page.goto('/chatTranscript.html');
		await page.evaluate(messages => window.ashChatTranscriptIntegration.renderItems(
			messages.map(item => item.type === 'agentMessage' ? { ...item, text: (item.text + '\n\n').repeat(30) } : item),
		), messages);
		const transcript = page.getByRole('log');
		const viewport = page.locator('.ash-chat-transcript-viewport > .ash-scrollbar-viewport');
		await viewport.evaluate(element => { element.scrollTop = 0; });
		await transcript.click({ position: { x: 2, y: 20 } });
		await expect(transcript).toBeFocused();
		await expect(transcript).toHaveCSS('outline-style', 'none');

		await page.keyboard.press('Tab');
		const row = page.locator('[data-item-id="first"]');
		await row.focus();
		await expect(row).toHaveCSS('outline-style', 'solid');
		for (const layer of [page.locator('.ash-chat-transcript-viewport'), viewport, transcript]) {
			await layer.focus();
			await expect(layer).toBeFocused();
			expect(await layer.evaluate(element => element.matches(':focus-visible'))).toBe(true);
			await expect(layer).toHaveCSS('outline-style', 'none');
		}
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
