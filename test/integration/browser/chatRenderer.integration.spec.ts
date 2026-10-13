import { expect, test } from '@playwright/test';
import type { IChatListItem } from '../../../src/ash/workbench/contrib/chat/browser/widget/chatListItems.js';

const code = '```typescript\nconst value = 1;\n```';
const image = { type: 'imageAttachment' as const, detail: 'auto' as const, attachment: { contentDigest: `sha256:${'a'.repeat(64)}`, mediaType: 'png' as const, encodedBytes: 70, width: 2, height: 1 } };
const source = { sessionId: 'session', threadId: 'thread', itemId: 'image', kind: 'item' as const };
const rows: readonly IChatListItem[] = [
	{ id: 'media', type: 'agentMessage', text: 'Delayed media.', content: [image], attachmentSource: source, transient: false },
	...Array.from({ length: 12 }, (_, index): IChatListItem => ({ id: `reading-${index}`, type: 'agentMessage', text: `Section ${index}.\n\n` + Array.from({ length: 4 }, (_, line) => `Paragraph ${index}.${line}.`).join('\n\n'), transient: false })),
];

test('provider corrections preserve the reading position while retaining a selected code editor and focused action', async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto('/chatTranscript.html');
	await page.evaluate(() => {
		// The product mounts the transcript in a column with a retained composer below it.
		const host = document.querySelector('.ash-chat-list-widget')!.parentElement!;
		host.classList.add('ash-chat');
		host.style.cssText = 'display:flex;flex-direction:column;width:916px;height:650px';
		const composer = document.createElement('div');
		composer.style.cssText = 'flex:0 0 220px';
		host.append(composer);
	});
	const paragraphs = Array.from({ length: 32 }, (_, index) => `Response section ${index}. ${'Synthetic reading content. '.repeat(8)}`).join('\n\n');
	const response: IChatListItem = { id: 'reply', type: 'agentMessage', text: code, transient: true };
	const pendingMedia: IChatListItem = { id: 'media', type: 'agentMessage', text: 'Synthetic media is being prepared.', transient: true };
	await page.evaluate(items => window.ashChatTranscriptIntegration.renderItems(items), [pendingMedia, response]);
	const block = page.locator('[data-item-id="reply"] .ash-chat-code-block');
	const editor = block.locator('.stanza-editor');
	const original = await editor.elementHandle();
	await block.locator('.stanza-editor-input').focus();
	await page.keyboard.press('ControlOrMeta+A');
	const selection = () => block.locator('.stanza-editor-input').evaluate(element => {
		const context = (element as HTMLElement & { editContext?: { selectionStart: number; selectionEnd: number; }; }).editContext;
		const input = element as HTMLTextAreaElement;
		return context ? { start: context.selectionStart, end: context.selectionEnd } : { start: input.selectionStart, end: input.selectionEnd };
	});
	const selected = await selection();
	expect(selected).toEqual({ start: 0, end: 'const value = 1;'.length });
	const copy = block.getByRole('button', { name: 'Copy', exact: true });
	await copy.focus();
	const viewport = page.locator('.ash-chat-list-widget .ash-scrollbar-viewport');
	await viewport.evaluate(element => { element.scrollTop = element.scrollHeight; });
	const streamed = { ...response, text: code + '\n\n' + paragraphs };
	await page.evaluate(items => window.ashChatTranscriptIntegration.renderItems(items), [pendingMedia, streamed]);
	await expect(page.locator('[data-item-id="reply"]')).toContainText('Response section 31.');
	await expect.poll(() => viewport.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)).toBe(0);
	expect(await selection()).toEqual(selected);
	await expect(copy).toBeFocused();
	const paragraph = page.locator('[data-item-id="reply"] p').filter({ hasText: /^Response section 12\./u });
	await viewport.evaluate((element, target) => { element.scrollTop += target!.getBoundingClientRect().top - element.getBoundingClientRect().top + 20; }, await paragraph.elementHandle());
	await expect.poll(() => viewport.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeGreaterThan(100);
	const top = await paragraph.evaluate(element => element.getBoundingClientRect().top);
	const png = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADklEQVR4nGP4z8DwHwQBEPgD/U6VwW8AAAAASUVORK5CYII=';
	const media = { ...pendingMedia, text: `Synthetic media is ready.\n\n![Synthetic response media](data:image/png;base64,${png}|width=320,height=320)`, transient: false };
	await page.evaluate(items => window.ashChatTranscriptIntegration.renderItems(items), [media, streamed]);
	await page.evaluate(items => window.ashChatTranscriptIntegration.renderItems(items), [media, { ...streamed, text: streamed.text.replace('= 1', '= 2'), transient: false }]);
	await expect.poll(() => page.getByRole('img', { name: 'Synthetic response media', exact: true }).evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(2);
	await expect(block.locator('.view-lines')).toContainText('const value = 2;');
	await expect.poll(async () => Math.abs(await paragraph.evaluate(element => element.getBoundingClientRect().top) - top)).toBeLessThanOrEqual(1);
	expect(await viewport.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeGreaterThan(100);
	expect(await editor.evaluate((element, previous) => element === previous, original)).toBe(true);
	expect(await selection()).toEqual(selected);
	await expect(copy).toBeFocused();
	await original?.dispose();
});

for (const locale of ['en', 'zh-CN']) {
	test(`provider corrections retain code selections, keyboard focus and updated copy text in ${locale}`, async ({ page }) => {
		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto(`/chatTranscript.html?locale=${locale}`);
		await page.evaluate(text => window.ashChatTranscriptIntegration.stream(text, false), `Original.\n\n${code}`);
		const block = page.locator('[data-item-id="stream"] .ash-chat-code-block');
		const editor = block.locator('.stanza-editor');
		const original = await editor.elementHandle();
		await editor.click();
		await page.keyboard.press('ControlOrMeta+A');
		const selection = await page.evaluate(() => window.ashChatTranscriptIntegration.state().selection);
		const copy = block.getByRole('button', { name: locale === 'en' ? 'Copy' : '复制', exact: true });
		await copy.focus();
		await expect(copy).toBeFocused();
		await page.evaluate(text => window.ashChatTranscriptIntegration.stream(text, true), `Correction.\n\n${code.replace('= 1', '= 2')}`);
		expect(await editor.evaluate((element, previous) => element === previous, original)).toBe(true);
		await expect(copy).toBeFocused();
		expect(await page.evaluate(() => window.ashChatTranscriptIntegration.state().selection)).toEqual(selection);
		await copy.press('Enter');
		await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.state().copied)).toBe('const value = 2;');
		await page.evaluate(() => window.ashChatTranscriptIntegration.remove());
		expect(await page.evaluate(() => window.ashChatTranscriptIntegration.state().editorCount)).toBe(1);
		await original?.dispose();
		expect(errors).toEqual([]);
	});
}

test('provider corrections retain selected paragraphs when inserting an earlier block', async ({ page }) => {
	await page.goto('/chatTranscript.html');
	const originalText = 'Selected paragraph.\n\nTail.';
	await page.evaluate(text => window.ashChatTranscriptIntegration.stream(text, false), originalText);
	const paragraph = page.locator('[data-item-id="stream"] p').first();
	const original = await paragraph.elementHandle();
	await paragraph.evaluate(element => {
		const range = document.createRange();
		range.selectNodeContents(element);
		const selection = document.getSelection()!;
		selection.removeAllRanges();
		selection.addRange(range);
	});
	await page.evaluate(text => window.ashChatTranscriptIntegration.stream(text, true), `Inserted explanation.\n\n${originalText}`);
	const selected = page.locator('[data-item-id="stream"] p').nth(1);
	expect(await selected.evaluate((element, previous) => element === previous, original)).toBe(true);
	expect(await page.evaluate(() => document.getSelection()!.toString())).toBe('Selected paragraph.');
	await original?.dispose();
});

test('streamed media appears and disappears without replacing the response code editor', async ({ page }) => {
	await page.goto('/chatTranscript.html');
	const item: IChatListItem = { id: 'reply', type: 'agentMessage', text: code, transient: true };
	await page.evaluate(item => window.ashChatTranscriptIntegration.renderItems([item]), item);
	const editor = page.locator('.ash-chat-code-block .stanza-editor');
	const original = await editor.elementHandle();
	await page.evaluate(item => window.ashChatTranscriptIntegration.renderItems([item]), { ...item, content: [image], attachmentSource: source });
	const media = page.locator('.ash-chat-media');
	await expect(media).toBeVisible();
	await media.getByRole('button', { name: 'Load image', exact: true }).click();
	await expect.poll(() => media.locator('img').evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(2);
	await page.evaluate(item => window.ashChatTranscriptIntegration.renderItems([{ ...item, text: item.text + '\n\nDone.', transient: false }]), item);
	await expect(media).toHaveCount(0);
	expect(await editor.evaluate((element, previous) => element === previous, original)).toBe(true);
	await original?.dispose();
});

test('delayed media above the reader preserves the visible message position', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto('/chatTranscript.html');
	await page.evaluate(rows => { window.ashChatTranscriptIntegration.delayAttachments(true); window.ashChatTranscriptIntegration.renderItems(rows); }, rows);
	const viewport = page.locator('.ash-chat-list-widget .ash-scrollbar-viewport');
	await page.locator('.ash-chat-media img').evaluate(element => { element.style.width = '300px'; element.style.height = '400px'; });
	await viewport.evaluate(element => {
		const target = document.querySelector('[data-item-id="reading-4"]')!;
		element.scrollTop += target.getBoundingClientRect().top - element.getBoundingClientRect().top + 20;
	});
	await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.readingState().shouldFollow)).toBe(false);
	const position = () => page.locator('[data-item-id="reading-4"]').evaluate(element => element.getBoundingClientRect().top);
	const top = await position();
	const before = await viewport.evaluate(element => element.scrollTop);
	await page.locator('.ash-chat-media button').evaluate(element => (element as HTMLButtonElement).click());
	await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.mediaState().requests.length)).toBe(1);
	await page.evaluate(() => window.ashChatTranscriptIntegration.finishMedia());
	await expect.poll(() => page.locator('.ash-chat-media img').evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(2);
	await expect.poll(position).toBe(top);
	expect(await viewport.evaluate(element => element.scrollTop)).toBeGreaterThan(before);
	expect(await page.evaluate(() => window.ashChatTranscriptIntegration.readingState().shouldFollow)).toBe(false);
	expect(errors).toEqual([]);
});

test('delayed media keeps a following transcript at the bottom', async ({ page }) => {
	await page.goto('/chatTranscript.html');
	await page.evaluate(rows => { window.ashChatTranscriptIntegration.delayAttachments(true); window.ashChatTranscriptIntegration.renderItems(rows); }, rows);
	const viewport = page.locator('.ash-chat-list-widget .ash-scrollbar-viewport');
	await expect.poll(() => viewport.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)).toBe(0);
	await page.locator('.ash-chat-media img').evaluate(element => { element.style.width = '300px'; element.style.height = '400px'; });
	await page.locator('.ash-chat-media button').evaluate(element => (element as HTMLButtonElement).click());
	await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.mediaState().requests.length)).toBe(1);
	await page.evaluate(() => window.ashChatTranscriptIntegration.finishMedia());
	await expect.poll(() => page.locator('.ash-chat-media img').evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(2);
	await expect.poll(() => viewport.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)).toBe(0);
	expect(await page.evaluate(() => window.ashChatTranscriptIntegration.readingState().shouldFollow)).toBe(true);
});

test('retained transcript restores editor focus after host recreation and hidden updates', async ({ page }) => {
	await page.goto('/chatTranscript.html');
	const item: IChatListItem = { id: 'reply', type: 'agentMessage', text: code, transient: true };
	await page.evaluate(item => window.ashChatTranscriptIntegration.renderItems([item]), item);
	await page.locator('.ash-chat-code-block .stanza-editor').click();
	const before = await page.evaluate(() => ({ state: window.ashChatTranscriptIntegration.readingState().focus, active: document.activeElement ? { tag: document.activeElement.tagName, role: document.activeElement.getAttribute('role'), className: document.activeElement.className } : undefined }));
	await page.evaluate(() => window.ashChatTranscriptIntegration.recreateTranscript());
	const after = await page.evaluate(() => ({ state: window.ashChatTranscriptIntegration.readingState().focus, active: document.activeElement ? { tag: document.activeElement.tagName, role: document.activeElement.getAttribute('role'), className: document.activeElement.className } : undefined }));
	await test.info().attach('restored-focus', { body: JSON.stringify({ before, after }, null, 2), contentType: 'application/json' });
	await expect(page.locator('.ash-chat-code-block .stanza-editor-input')).toBeFocused();
	await page.evaluate(() => window.ashChatTranscriptIntegration.setTranscriptVisible(false));
	await page.evaluate(item => window.ashChatTranscriptIntegration.renderItems([{ ...item, text: item.text + '\n\nFinished.', transient: false }]), item);
	await page.evaluate(() => window.ashChatTranscriptIntegration.setTranscriptVisible(true));
	await expect(page.locator('.ash-chat-markdown-part')).toContainText('Finished.');
	expect(await page.evaluate(() => window.ashChatTranscriptIntegration.readingState().shouldFollow)).toBe(true);
});


test('transcript wrapping preserves the visible message position when the host narrows', async ({ page }) => {
	await page.goto('/chatTranscript.html');
	const wrapping = rows.map(item => item.id.startsWith('reading-') ? { ...item, text: item.text + '\n\n' + 'Long wrapping content in this response. '.repeat(10) } : item);
	await page.evaluate(rows => window.ashChatTranscriptIntegration.renderItems(rows), wrapping);
	const viewport = page.locator('.ash-chat-list-widget .ash-scrollbar-viewport');
	await viewport.evaluate(element => {
		const target = document.querySelector('[data-item-id="reading-4"]')!;
		element.scrollTop += target.getBoundingClientRect().top - element.getBoundingClientRect().top + 20;
	});
	await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.readingState().shouldFollow)).toBe(false);
	const position = () => page.locator('[data-item-id="reading-4"]').evaluate(element => element.getBoundingClientRect().top);
	const top = await position();
	const before = await viewport.evaluate(element => element.scrollTop);
	await page.locator('main').evaluate(element => { element.style.width = '220px'; });
	await expect.poll(position).toBe(top);
	await expect.poll(() => viewport.evaluate(element => element.scrollTop)).toBeGreaterThan(before);
});


test('Hook status changes preserve the focused and expanded real browser summary', async ({ page }) => {
	await page.goto('/chatTranscript.html');
	const run = { runId: 'hook-run', hookId: 'user:hook:browser', event: 'beforeTool', status: { type: 'running' as const }, startedAtUnixMs: 1, durationMs: 0, turnId: 'turn', toolCallId: 'tool', toolName: 'shell-command' };
	const item: IChatListItem = { id: 'hook:run', type: 'hook', text: '', transient: true, isError: false, hookPart: { kind: 'hook', run } };
	await page.evaluate(item => window.ashChatTranscriptIntegration.renderItems([item]), item);
	const disclosure = page.locator('.ash-chat-hook');
	const summary = disclosure.locator('summary');
	const original = await summary.elementHandle();
	await summary.press('Enter');
	await expect.poll(() => disclosure.evaluate(element => (element as HTMLDetailsElement).open)).toBe(true);
	await expect(summary).toBeFocused();
	for (const status of [{ type: 'continued' as const }, { type: 'denied' as const, reason: '<img src=x> literal denial' }, { type: 'failed' as const, message: 'literal failure' }, { type: 'cancelled' as const, reason: 'literal cancellation' }]) {
		const isError = status.type === 'denied' || status.type === 'failed';
		const text = status.type === 'denied' || status.type === 'cancelled' ? status.reason : status.type === 'failed' ? status.message : '';
		await page.evaluate(item => window.ashChatTranscriptIntegration.renderItems([item]), { ...item, text, transient: false, isError, hookPart: { kind: 'hook' as const, run: { ...run, status, durationMs: 25 } } });
		await expect(disclosure).toHaveAttribute('data-status', status.type);
		expect(await summary.evaluate((element, previous) => element === previous, original)).toBe(true);
		await expect(summary).toBeFocused();
		expect(await disclosure.evaluate(element => (element as HTMLDetailsElement).open)).toBe(true);
		expect(await disclosure.evaluate(element => element.closest('article')!.classList.contains('error'))).toBe(isError);
		await expect(disclosure.locator('p')).toHaveText(text);
		await expect(disclosure.locator('img')).toHaveCount(0);
	}
	await original?.dispose();
});
