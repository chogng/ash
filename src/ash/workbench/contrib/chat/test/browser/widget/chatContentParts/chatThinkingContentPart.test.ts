import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { suite, suiteSetup, test } from 'mocha';
import { expect } from '@playwright/test';
import { useBrowserTests } from '../../../../../../../../../test/unit/browser/context.js';
import type { } from '../../../../../../../../../test/fixtures/browser/chatTranscript.page.js';
import { getWindows } from '../../../../../../../base/browser/window.js';
import { DisposableStore, toDisposable } from '../../../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../../base/test/common/utils.js';
import { createCodeEditorServices } from '../../../../../../../editor/test/browser/testCodeEditor.js';
import { browserEnvironment } from '../../../../../../../editor/test/browser/testEditorDom.js';
import { createTestEditorServices } from '../../../../../../test/common/testEditorServices.js';
import { resetNlsResolver, setNlsMessages } from '../../../../../../../nls.js';
import { ChatListWidget } from '../../../../browser/widget/chatListWidget.js';
import { chatTranscriptListItems, type IChatListItem } from '../../../../common/model/chatViewModel.js';
import { ChatResponseAccessibleView } from '../../../../browser/accessibility/chatResponseAccessibleView.js';
import { Event } from '../../../../../../../base/common/event.js';

const document = browserEnvironment.window.document;

function reasoning(text: string, transient = true): IChatListItem {
	return chatTranscriptListItems([{
		type: 'item', entryId: 'reasoning-entry', turnId: 'turn', transient,
		item: {
			type: 'reasoning', itemId: 'reasoning-item', turnId: 'turn', text,
			state: [{ scope: 'provider', item: { encrypted: 'opaque-state-never-rendered' } }],
		},
	}])[0];
}

suite('Chat thinking transcript lifecycle', () => {
	suiteSetup(() => { getWindows(); });
	ensureNoDisposablesAreLeakedInTestSuite();

	for (const classPrefix of ['ash-chat', 'ash-cowork']) {
		test(`${classPrefix} retains one disclosure and restores user expansion after completion`, async () => {
			using resources = new DisposableStore();
			const services = resources.add(createTestEditorServices(undefined, createCodeEditorServices(resources)));
			const container = document.createElement('main');
			document.body.append(container);
			resources.add(toDisposable(() => container.remove()));
			using widget = services.createInstance(ChatListWidget, container, { classPrefix });
			widget.render([reasoning('Initial **reasoning**')]);
			const details = widget.element.querySelector<HTMLDetailsElement>('.ash-chat-thinking')!;
			const summary = details.querySelector<HTMLElement>('summary')!;
			assert.equal(details.open, false);
			assert.equal(summary.textContent, 'Thinking…');
			widget.reveal(reasoning('Initial **reasoning**'));
			assert.equal(details.open, false, 'Revealing a message must preserve its disclosure choice');
			summary.focus();
			widget.render([reasoning('Updated **reasoning**')]);
			assert.equal(widget.element.querySelector('.ash-chat-thinking'), details);
			assert.equal(document.activeElement, summary);
			const toggled = new Promise<void>(resolve => details.addEventListener('toggle', () => resolve(), { once: true }));
			details.open = true;
			await toggled;
			assert.equal(details.querySelector('strong')!.textContent, 'reasoning');
			const completed = reasoning('Updated **reasoning**', false);
			widget.render([completed]);
			assert.equal(summary.textContent, 'Reasoning complete');
			assert.equal(details.dataset.state, 'complete');
			assert.equal(summary.getAttribute('aria-busy'), 'false');
			assert.equal(details.open, true);
			assert.equal(document.activeElement, summary);
			const state = widget.getViewState();
			using restored = services.createInstance(ChatListWidget, container, { classPrefix });
			restored.restoreViewState(state, [completed]);
			assert.equal(restored.element.querySelector<HTMLDetailsElement>('.ash-chat-thinking')!.open, true);
			assert.equal(document.activeElement, restored.element.querySelector('summary'));
			restored.render([]);
			assert.equal(restored.element.querySelector('.ash-chat-thinking'), null);
		});
	}

	test('collapsed and hidden updates publish only the latest safe Markdown when opened', async () => {
		using resources = new DisposableStore();
		const services = resources.add(createTestEditorServices(undefined, createCodeEditorServices(resources)));
		using widget = services.createInstance(ChatListWidget, document.createElement('main'), {});
		widget.render([reasoning('Old text')]);
		const details = widget.element.querySelector<HTMLDetailsElement>('details')!;
		widget.setVisible(false);
		widget.render([reasoning('Retired text')]);
		widget.render([reasoning('Latest **summary** <script>untrusted()</script>', false)]);
		widget.setVisible(true);
		assert.equal(details.open, false);
		assert.equal(details.querySelector('summary')!.textContent, 'Reasoning complete');
		const toggled = new Promise<void>(resolve => details.addEventListener('toggle', () => resolve(), { once: true }));
		details.open = true;
		await toggled;
		assert.equal(details.querySelector('strong')!.textContent, 'summary');
		assert.doesNotMatch(details.textContent!, /Old text|Retired text|opaque-state/);
		assert.equal(details.querySelector('script'), null);
		widget.render([]);
		widget.render([reasoning('A new entry lifetime')]);
		assert.equal(widget.element.querySelector<HTMLDetailsElement>('details')!.open, false);
	});

	test('Chinese accessible reasoning includes current collapsed text and canonical completion', () => {
		setNlsMessages('zh-CN', JSON.parse(readFileSync('extensions/language-pack-zh-cn/translations/chat.json', 'utf8')));
		try {
			using resources = new DisposableStore();
			const services = resources.add(createTestEditorServices(undefined, createCodeEditorServices(resources)));
			using widget = services.createInstance(ChatListWidget, document.createElement('main'), {});
			let item = reasoning('Provider **text**');
			widget.render([item]);
			const accessible = new ChatResponseAccessibleView({ getItems: () => [item], getFocusedElement: () => document.body, onDidChangeContent: Event.None });
			using provider = accessible.getProvider()!;
			assert.equal(widget.element.querySelector('summary')!.textContent, '正在思考…');
			assert.equal(provider.provideContent(), '正在思考…\n\nProvider text');
			item = reasoning('Committed **text**', false);
			widget.render([item]);
			assert.equal(widget.element.querySelector('summary')!.textContent, '推理已完成');
			assert.equal(provider.provideContent(), '推理已完成\n\nCommitted text');
			assert.equal(widget.element.querySelector('details')!.open, false);
		} finally {
			resetNlsResolver();
		}
	});
});

suite('Rendered reasoning disclosure', () => {
	const browserTests = useBrowserTests();
	test('code block navigation expands reasoning and retains its editor through streaming and completion', async () => {
		const { page } = browserTests;
		await page.goto('/chatTranscript.html');
		const initial = reasoning('```ts\nconst value = 1;');
		await page.evaluate(item => window.ashChatTranscriptIntegration.renderItems([item]), initial);
		const details = page.locator('.ash-chat-thinking');
		await details.locator('summary').focus();
		await page.evaluate(() => window.ashChatTranscriptIntegration.runNavigationCommand('workbench.action.chat.nextCodeBlock'));
		const input = details.locator('.stanza-editor-input');
		await expect(details).toHaveAttribute('open');
		await expect(input).toBeFocused();
		await page.keyboard.press('ControlOrMeta+A');
		const retained = await details.locator('.stanza-editor').elementHandle();
		const selected = await page.evaluate(() => window.ashChatTranscriptIntegration.state().selection);
		await page.evaluate(item => window.ashChatTranscriptIntegration.renderItems([
			{ ...item, text: item.text + '\nconst next = 2;\n```', transient: false },
		]), initial);
		await expect(details.locator('summary')).toHaveText('Reasoning complete');
		await expect(input).toBeFocused();
		assert.equal(await details.locator('.stanza-editor').evaluate((element, old) => element === old, retained), true);
		assert.deepEqual(await page.evaluate(() => window.ashChatTranscriptIntegration.state().selection), selected);
		await retained?.dispose();
	});

	for (const theme of ['dark', 'light', 'hc', 'hcLight'] as const) {
		test(`streaming and completion retain selection, focus and expansion in ${theme}`, async () => {
			const { page } = browserTests;
			await page.goto('/chatTranscript.html');
			const initial = reasoning('Stable **reasoning**.\n\nStreaming tail');
			await page.evaluate(({ theme, initial }) => {
				window.ashChatTranscriptIntegration.setTheme(theme);
				document.body.style.background = 'var(--ash-editor-background)';
				window.ashChatTranscriptIntegration.renderItems([initial]);
			}, { theme, initial });
			const details = page.locator('.ash-chat-thinking');
			const summary = details.locator('summary');
			await expect(summary).toHaveText('Thinking…');
			await expect(details).not.toHaveAttribute('open');
			await summary.focus();
			await page.keyboard.press('Enter');
			const strong = details.locator('strong');
			await expect(strong).toHaveText('reasoning');
			const retained = await strong.elementHandle();
			await strong.evaluate(element => {
				element.ownerDocument.getSelection()!.setBaseAndExtent(element.firstChild!, 0, element.firstChild!, 9);
			});
			const finished = { ...initial, text: initial.text + ' with additional details.\n\nFinished.', transient: false };
			await page.evaluate(item => window.ashChatTranscriptIntegration.renderItems([item]), finished);
			await expect(summary).toHaveText('Reasoning complete');
			await expect(summary).toHaveAttribute('aria-busy', 'false');
			await expect(summary).toBeFocused();
			await expect(details).toHaveAttribute('open');
			assert.equal(await strong.evaluate((element, old) => element === old, retained), true);
			assert.equal(await page.evaluate(() => window.getSelection()!.toString()), 'reasoning');
			await expect(details).toContainText('Finished.');
			await page.keyboard.press('Space');
			await expect(details.locator('.ash-chat-markdown-part')).toBeHidden();
			await page.evaluate(() => window.ashChatTranscriptIntegration.recreateTranscript());
			await expect(details).not.toHaveAttribute('open');
			await expect(summary).toBeFocused();
			await page.keyboard.press('Space');
			await expect(details).toContainText('Finished.');
			await expect(details.locator('.ash-chat-markdown-part')).toBeVisible();
			await expect(summary).not.toHaveCSS('outline-style', 'none');
			await page.locator('main').screenshot({ path: browserTests.info.outputPath(`reasoning-${theme}.png`) });
			await retained?.dispose();
		});
	}

	test('collapsed reasoning stays outside Find and hidden updates retain its latest text', async () => {
		const { page } = browserTests;
		await page.goto('/chatTranscript.html?locale=zh-CN');
		const item = reasoning('Unique needle inside **reasoning**.', false);
		await page.evaluate(item => window.ashChatTranscriptIntegration.renderItems([item]), item);
		const details = page.locator('.ash-chat-thinking');
		await expect(details).not.toHaveAttribute('open');
		await page.evaluate(() => window.ashChatTranscriptIntegration.showFind('needle'));
		await expect(details).not.toHaveAttribute('open');
		await page.locator('.ash-chat-find input').press('Escape');
		await details.locator('summary').focus();
		await page.evaluate(item => {
			window.ashChatTranscriptIntegration.setTranscriptVisible(false);
			window.ashChatTranscriptIntegration.renderItems([{ ...item, text: 'Latest reasoning **after hiding**.' }]);
			window.ashChatTranscriptIntegration.setTranscriptVisible(true);
		}, item);
		await expect(details).not.toHaveAttribute('open');
		await details.locator('summary').press('Enter');
		await expect(details.locator('strong')).toHaveText('after hiding');
		await expect(details.locator('summary')).toHaveText('推理已完成');
	});

	test('expanding above a reader preserves the transcript reading anchor', async () => {
		const { page } = browserTests;
		await page.goto('/chatTranscript.html');
		const first = reasoning('Long reasoning.\n\n' + 'A paragraph of reasoning.\n\n'.repeat(25), false);
		await page.evaluate(first => window.ashChatTranscriptIntegration.renderItems([
			first,
			...Array.from({ length: 15 }, (_, index) => ({ id: `reply-${index}`, type: 'agentMessage' as const, text: `Reply ${index}.\n\n` + 'Reading content. '.repeat(30), transient: false })),
		]), first);
		const reader = page.locator('[data-item-id="reply-6"]');
		await reader.evaluate(element => element.scrollIntoView({ block: 'start' }));
		const top = await reader.evaluate(element => element.getBoundingClientRect().top);
		// Activate the disclosure without moving the reader's keyboard focus or viewport.
		await page.locator('.ash-chat-thinking > summary').evaluate(element => (element as HTMLElement).click());
		await expect.poll(async () => Math.abs(await reader.evaluate(element => element.getBoundingClientRect().top) - top)).toBeLessThanOrEqual(1);
		await expect(page.locator('.ash-chat-thinking strong')).toHaveCount(0);
	});
});
