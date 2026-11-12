import '../../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { expect } from '@playwright/test';
import { useBrowserTests } from '../../../../../../../../test/unit/browser/context.js';
import type { } from '../../../../../../../../test/fixtures/browser/chatTranscript.page.js';
import type { } from '../../../../../../../../test/fixtures/browser/chatInput.page.js';
import { browserEnvironment } from '../../../../../../editor/test/browser/testEditorDom.js';
import { cloneVisibleSelection, getLinkTarget, sanitizeChatClipboardFragment, toPortableMarkdown } from '../../../browser/widget/chatClipboard.js';

suite('Chat clipboard', () => {
	test('uses routing metadata and sanitizes local destinations in the fragment owner document', () => {
		const document = browserEnvironment.window.document.implementation.createHTMLDocument();
		const template = document.createElement('template');
		template.innerHTML = '<p><a href="" data-href=" file:///private/file.ts "><strong>file.ts</strong></a> <a data-href="https://example.com" href="">Docs</a><img src="blob:local" alt="Chart"><a href="command:run"></a></p>';
		assert.equal(getLinkTarget(template.content.querySelector('a')!), 'file:///private/file.ts');
		assert.equal(sanitizeChatClipboardFragment(template.content), true);
		assert.equal(template.innerHTML, '<p><code>file.ts</code> <a href="https://example.com">Docs</a><code>Chart</code></p>');
		assert.equal(sanitizeChatClipboardFragment(template.content), false);
	});

	test('clones partial references with their heading and leaves live content unchanged', () => {
		const document = browserEnvironment.window.document;
		const root = document.createElement('main');
		root.innerHTML = '<h2>See <a href="/repo/source.ts">source.ts:20</a></h2>';
		document.body.append(root);
		try {
			const before = root.innerHTML;
			const range = document.createRange();
			range.setStart(root.querySelector('a')!.firstChild!, 2);
			range.setEnd(root.querySelector('a')!.firstChild!, 6);
			const fragment = cloneVisibleSelection(range, root);
			sanitizeChatClipboardFragment(fragment);
			const holder = document.createElement('div');
			holder.append(fragment);
			assert.equal(holder.innerHTML, '<h2><code>source.ts:20</code></h2>');
			assert.equal(root.innerHTML, before);
			assert.equal(range.toString(), 'urce');
		} finally { root.remove(); }
	});

	test('rewrites machine and application targets, preserves portable targets and code examples', () => {
		const source = '**[File](/workspace/a.ts)** [Windows](C:/src/a.ts) [Session](ash://session/id) [Reference](http://_ashcontentref_/1) '
			+ '[Web](https://example.com/a) [Mail](mailto:a@example.com) [Section](#part) [Relative](../guide.md)\n\n'
			+ '`[File](/workspace/a.ts)`\n\n```md\n[File](/workspace/a.ts)\n```';
		assert.equal(toPortableMarkdown(source), '**`File`** `Windows` `Session` `Reference` '
			+ '[Web](https://example.com/a) [Mail](mailto:a@example.com) [Section](#part) [Relative](../guide.md)\n\n'
			+ '`[File](/workspace/a.ts)`\n\n```md\n[File](/workspace/a.ts)\n```');
	});

	test('rewrites repeated links inside structural Markdown and multiline block prefixes', () => {
		assert.equal(toPortableMarkdown('## [a](/a)\n\n- **[a](/b)**\n- [two\n  lines](/c)\n\n> [two\n> lines](/d)\n\n| file |\n| --- |\n| [a](/e) |\n'),
			'## `a`\n\n- **`a`**\n- `two lines`\n\n> `two lines`\n\n| file |\n| --- |\n| `a` |\n');
	});

	test('retains reference links after removing complete definitions and leaves literal definitions alone', () => {
		assert.equal(toPortableMarkdown('[Local][a] and [Docs][b].\n\n[a]:\n  /private/a.ts\n  "Private title"\n\n[b]: https://example.com\n\n[unused]: /private/unused\n'),
			'`Local` and [Docs](<https://example.com>).\n\n\n\n\n\n');
		const literal = 'A paragraph\n[a]: /private/a\n\n```md\n[b]: /private/b\n```\n\n<div>\nhref="/private/a"\n</div>';
		assert.equal(toPortableMarkdown(literal), literal);
	});

	test('converts image labels and formatted labels without corrupting code delimiters or entities', () => {
		assert.equal(toPortableMarkdown('[![chart](/local.png)](https://example.com) [**A &amp; B**](/a) [`` `x` ``](/b) ![image](https://example.com/i.png)'),
			'[`chart`](https://example.com) `A & B` `` `x` `` ![image](https://example.com/i.png)');
	});
});

suite('Chat clipboard in the rendered transcript', () => {
	const browser = useBrowserTests();

	for (const locale of ['en', 'zh-CN']) {
		test(`copied transcript structure pastes into Chat as Markdown with plain-text fallback in ${locale}`, async () => {
			const { page } = browser;
			await page.goto('/chatTranscript.html');
			await page.evaluate(() => window.ashChatTranscriptIntegration.renderItems([{ id: 'roundtrip', type: 'agentMessage', text: '## Result\n\nSee **[source.ts](ash-remote://host/source.ts)** and [Docs](https://example.com).', transient: false }]));
			const copied = await page.evaluate(() => {
				const body = document.querySelector('[data-item-id="roundtrip"] .ash-chat-markdown-part')!;
				const selection = window.getSelection()!;
				const range = document.createRange();
				range.selectNodeContents(body);
				selection.removeAllRanges();
				selection.addRange(range);
				const clipboardData = new DataTransfer();
				const event = new ClipboardEvent('copy', { clipboardData, bubbles: true, cancelable: true });
				body.dispatchEvent(event);
				if (!event.defaultPrevented) { throw new Error('The transcript did not prepare its rich clipboard'); }
				return { text: clipboardData.getData('text/plain'), html: clipboardData.getData('text/html') };
			});
			await page.goto(`/chatInput.html?inlineCode=1&locale=${locale}`);
			const input = page.getByRole('textbox', { name: 'Chat message', exact: true });
			await input.focus();
			await input.evaluate((element, copied) => {
				const clipboardData = new DataTransfer();
				clipboardData.setData('text/plain', copied.text);
				clipboardData.setData('text/html', copied.html);
				element.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
			}, copied);
			await page.evaluate(() => window.ashChatInputIntegration.finishPaste());
			const markdown = '## Result\n\nSee **`source.ts`** and [Docs](https://example.com).';
			await expect.poll(() => page.evaluate(() => window.ashChatInputIntegration.dropState().text)).toBe(markdown);
			await page.locator('.stanza-editor-post-edit-selector button').click();
			await expect(page.getByRole('menuitem', { name: locale === 'en' ? 'Paste as Markdown' : '粘贴为 Markdown', exact: true })).toBeVisible();
			await page.getByRole('menuitem', { name: locale === 'en' ? 'Insert Plain Text' : '插入纯文本', exact: true }).click();
			await expect.poll(() => page.evaluate(() => window.ashChatInputIntegration.dropState().text)).toBe(copied.text);
			await page.locator('.stanza-editor-post-edit-selector button').click();
			await page.getByRole('menuitem', { name: locale === 'en' ? 'Paste as Markdown' : '粘贴为 Markdown', exact: true }).click();
			await expect.poll(() => page.evaluate(() => window.ashChatInputIntegration.dropState().text)).toBe(markdown);
			await input.focus();
			await input.press('ControlOrMeta+z');
			await expect.poll(() => page.evaluate(() => window.ashChatInputIntegration.dropState().text)).toBe('');
			await input.press('ControlOrMeta+Shift+z');
			await expect.poll(() => page.evaluate(() => window.ashChatInputIntegration.dropState().text)).toBe(markdown);
		});
	}

	test('Chinese accessibility help explains portable copying and restores transcript focus', async () => {
		const { page } = browser;
		await page.goto('/chatTranscript.html?locale=zh-CN');
		await page.evaluate(() => window.ashChatTranscriptIntegration.renderItems([{ id: 'copy-help', type: 'agentMessage', text: '复制说明', transient: false }]));
		const row = page.locator('[data-item-id="copy-help"]');
		await row.focus();
		assert.equal(await page.evaluate(() => window.ashChatTranscriptIntegration.openAccessibleView(true)), true);
		const help = page.getByRole('dialog').getByRole('textbox');
		await expect(help).toHaveValue(/“复制消息”保留 Markdown，并将内部资源链接复制为代码标签。复制选区时，内部链接也会替换为可见标签。将复制的消息粘贴到富文本编辑器，可保留正文中的图和图注。/u);
		await help.press('Escape');
		await expect(row).toBeFocused();
	});

	test('copying part of an internal link preserves native plain text and a complete rich label', async () => {
		const { page } = browser;
		await page.goto('/chatTranscript.html');
		await page.evaluate(() => window.ashChatTranscriptIntegration.renderItems([{ id: 'copy', type: 'agentMessage', text: '## See [source.ts:20](ash-remote://host/workspace/source.ts)', transient: false }]));
		const result = await page.evaluate(() => {
			const anchor = document.querySelector('[data-item-id="copy"] a')!;
			const range = document.createRange();
			range.setStart(anchor.firstChild!, 2);
			range.setEnd(anchor.firstChild!, 6);
			const selection = window.getSelection()!;
			selection.removeAllRanges();
			selection.addRange(range);
			const clipboardData = new DataTransfer();
			const event = new ClipboardEvent('copy', { clipboardData, bubbles: true, cancelable: true });
			anchor.dispatchEvent(event);
			const holder = document.createElement('div');
			holder.innerHTML = clipboardData.getData('text/html');
			return { handled: event.defaultPrevented, plain: clipboardData.getData('text/plain'), label: holder.querySelector('h2 code')?.textContent, links: holder.querySelectorAll('a').length, selection: selection.toString(), target: anchor.getAttribute('data-href') ?? anchor.getAttribute('href') };
		});
		assert.deepEqual(result, { handled: true, plain: 'urce', label: 'source.ts:20', links: 0, selection: 'urce', target: 'ash-remote://host/workspace/source.ts' });
	});

	test('rich copying excludes hidden content and controls while retaining display contents descendants', async () => {
		const { page } = browser;
		await page.goto('/chatTranscript.html');
		await page.evaluate(() => window.ashChatTranscriptIntegration.renderItems([{ id: 'copy', type: 'agentMessage', text: '[File](/workspace/source.ts)', transient: false }]));
		const result = await page.evaluate(() => {
			const anchor = document.querySelector('[data-item-id="copy"] a')!;
			const container = anchor.parentElement!;
			const hidden = document.createElement('div');
			hidden.innerHTML = '<span style="display:none">hidden display</span><span style="visibility:hidden">hidden visibility</span><span style="opacity:0">hidden opacity</span><style>.clipboard-test{}</style><div role="toolbar">toolbar</div><span style="display:contents">Visible text</span>';
			container.append(hidden);
			const before = container.innerHTML;
			const range = document.createRange();
			range.selectNodeContents(container);
			window.getSelection()!.removeAllRanges();
			window.getSelection()!.addRange(range);
			const clipboardData = new DataTransfer();
			container.dispatchEvent(new ClipboardEvent('copy', { clipboardData, bubbles: true, cancelable: true }));
			const holder = document.createElement('div');
			holder.innerHTML = clipboardData.getData('text/html');
			return { text: holder.textContent, controls: holder.querySelectorAll('style,[role="toolbar"]').length, unchanged: before === container.innerHTML };
		});
		assert.deepEqual(result, { text: 'FileVisible text', controls: 0, unchanged: true });
	});

	test('external links use native copy and editor selections remain owned by their input', async () => {
		const { page } = browser;
		await page.goto('/chatTranscript.html');
		await page.evaluate(() => window.ashChatTranscriptIntegration.renderItems([{ id: 'copy', type: 'agentMessage', text: '[Docs](https://example.com)', transient: false }]));
		const result = await page.evaluate(() => {
			const anchor = document.querySelector('[data-item-id="copy"] a')!;
			const range = document.createRange();
			range.selectNodeContents(anchor);
			window.getSelection()!.removeAllRanges();
			window.getSelection()!.addRange(range);
			const native = new ClipboardEvent('copy', { clipboardData: new DataTransfer(), bubbles: true, cancelable: true });
			anchor.dispatchEvent(native);
			anchor.setAttribute('href', '/private/a');
			const input = document.createElement('textarea');
			anchor.parentElement!.append(input);
			const editor = new ClipboardEvent('copy', { clipboardData: new DataTransfer(), bubbles: true, cancelable: true });
			input.dispatchEvent(editor);
			window.ashChatTranscriptIntegration.dispose();
			const disposed = new ClipboardEvent('copy', { clipboardData: new DataTransfer(), bubbles: true, cancelable: true });
			anchor.dispatchEvent(disposed);
			return [native.defaultPrevented, editor.defaultPrevented, disposed.defaultPrevented];
		});
		assert.deepEqual(result, [false, false, false]);
	});
});
