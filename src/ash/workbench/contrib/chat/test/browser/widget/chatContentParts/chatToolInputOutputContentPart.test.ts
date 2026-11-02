import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { suite, suiteSetup, test } from 'mocha';
import { expect } from '@playwright/test';
import { useBrowserTests } from '../../../../../../../../../test/unit/browser/context.js';
import { DisposableStore, toDisposable } from '../../../../../../../base/common/lifecycle.js';
import { getWindows } from '../../../../../../../base/browser/window.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../../base/test/common/utils.js';
import { createCodeEditorServices } from '../../../../../../../editor/test/browser/testCodeEditor.js';
import { browserEnvironment } from '../../../../../../../editor/test/browser/testEditorDom.js';
import { createTestEditorServices } from '../../../../../../test/common/testEditorServices.js';
import { resetNlsResolver, setNlsMessages } from '../../../../../../../nls.js';
import type { ChatToolCallBinding } from '../../../../../../../platform/agentHost/common/agent.js';
import { ChatListWidget } from '../../../../browser/widget/chatListWidget.js';
import { chatTranscriptListItems, type IChatListItem } from '../../../../common/model/chatViewModel.js';
import type { ThreadTranscriptEntry } from '../../../../../../services/chat/common/chatService.js';

const document = browserEnvironment.window.document;

function toolItem(activity?: ChatToolCallBinding['activity']): IChatListItem {
	return chatTranscriptListItems([{
		type: 'item', entryId: 'tool-call', turnId: 'turn', transient: false,
		item: {
			type: 'toolCall', itemId: 'call', turnId: 'turn', toolCallId: 'call',
			name: 'fixture_tool', argumentsJson: '{"path":"src/main.ts"}',
			binding: { registryGeneration: 1, definitionDigest: 'fixture', sourceChain: [], caller: { type: 'direct' }, activity },
		},
	}])[0];
}

suite('Tool activity and input/output presentation', () => {
	suiteSetup(() => { getWindows(); });
	ensureNoDisposablesAreLeakedInTestSuite();

	test('the transcript uses backend activity for summaries without inferring success or guessing tool arguments', () => {
		using resources = new DisposableStore();
		const services = resources.add(createTestEditorServices(undefined, createCodeEditorServices(resources)));
		using widget = services.createInstance(ChatListWidget, document.createElement('main'), {});
		const activities: readonly [ChatToolCallBinding['activity'], string][] = [
			[{ type: 'fileRead', path: 'src/main.ts', offset: 0, limit: 10 }, 'Read src/main.ts'],
			[{ type: 'read', target: 'resource://data' }, 'Read resource://data'],
			[{ type: 'fileSearch', pattern: 'needle', path: '/workspace' }, 'Search needle in /workspace'],
			[{ type: 'search', target: 'needle' }, 'Search needle'],
			[{ type: 'fileList', pattern: '*.ts', path: '/workspace' }, 'List *.ts in /workspace'],
			[{ type: 'list', target: '/workspace' }, 'List /workspace'],
			[{ type: 'fileEdit', path: 'src/main.ts' }, 'Edit src/main.ts'],
			[{ type: 'edit', target: 'draft' }, 'Edit draft'],
			[{ type: 'command', program: 'git', arguments: ['diff', 'two words'], workingDirectory: '/workspace' }, 'Run git "diff" "two words"'],
			[{ type: 'run' }, 'Run fixture_tool'],
			[undefined, 'fixture_tool'],
		];
		for (const [activity, label] of activities) {
			const item = toolItem(activity);
			widget.render([item]);
			assert.equal(widget.element.querySelector('summary')!.textContent, `${label} · Awaiting result`);
			widget.render([{ ...item, transient: false, toolInvocation: { ...item.toolInvocation!, stopped: true } }]);
			assert.equal(widget.element.querySelector('summary')!.textContent, `${label} · No result`);
		}
	});

	test('streaming retains independently expanded regions, selected output, focus and literal tool evidence', () => {
		using resources = new DisposableStore();
		const services = resources.add(createTestEditorServices(undefined, createCodeEditorServices(resources)));
		const container = document.createElement('main');
		document.body.append(container);
		resources.add(toDisposable(() => container.remove()));
		using widget = services.createInstance(ChatListWidget, container, {});
		const item = toolItem({ type: 'read', target: '<img src=x onerror=alert(1)>' });
		const output: Extract<ThreadTranscriptEntry, { type: 'toolOutput'; }>[] = [{
			type: 'toolOutput', entryId: 'out', turnId: 'turn', toolCallId: 'call', stream: 'stdout', text: 'selected output',
		}];
		widget.render([{ ...item, toolInvocation: { ...item.toolInvocation!, output } }]);
		const outer = widget.element.querySelector<HTMLDetailsElement>('.ash-chat-tool-invocation')!;
		const input = outer.querySelector<HTMLDetailsElement>('[data-tool-section="input"]')!;
		const stdout = outer.querySelector<HTMLDetailsElement>('[data-tool-section="stdout"]')!;
		outer.open = true;
		stdout.open = true;
		const region = stdout.querySelector('pre')!;
		region.focus();
		const range = document.createRange();
		range.setStart(region.firstChild!, 0);
		range.setEnd(region.firstChild!, region.textContent!.length);
		const selection = document.getSelection()!;
		selection.removeAllRanges();
		selection.addRange(range);
		const textNode = region.firstChild;
		const result = { type: 'toolResult' as const, itemId: 'result', turnId: 'turn', toolCallId: 'call', text: '<script>neverRun()</script>', isError: true, content: [] };
		widget.render([{ ...item, toolInvocation: { ...item.toolInvocation!, output: [...output, { ...output[0], entryId: 'next', text: '\u001b[31m<script>literal()</script>' }], result } }]);
		assert.equal(outer.querySelector('[data-tool-section="stdout"]'), stdout);
		assert.equal(region.firstChild, textNode);
		assert.equal(stdout.open, true);
		assert.equal(input.open, false);
		assert.equal(document.activeElement, region);
		assert.equal(selection.toString(), 'selected output');
		assert.equal(region.textContent, 'selected output\n\u001b[31m<script>literal()</script>');
		assert.equal(outer.querySelector('[data-tool-section="result"] pre')!.textContent, result.text);
		assert.equal(outer.querySelector('[data-tool-section="result"] summary')!.textContent, 'Error');
		assert.equal(outer.querySelector('[data-tool-section="stderr"]')!.hasAttribute('hidden'), true);
		assert.equal(outer.querySelector('img, script, a'), null);
		selection.removeAllRanges();
	});

	test('Chinese activity summaries and region labels retain untranslated evidence', () => {
		setNlsMessages('zh-CN', JSON.parse(readFileSync('extensions/language-pack-zh-cn/translations/chat.json', 'utf8')));
		try {
			using resources = new DisposableStore();
			const services = resources.add(createTestEditorServices(undefined, createCodeEditorServices(resources)));
			using widget = services.createInstance(ChatListWidget, document.createElement('main'), {});
			widget.render([toolItem({ type: 'fileSearch', path: '/workspace', pattern: 'TODO' })]);
			assert.equal(widget.element.querySelector('summary')!.textContent, '在 /workspace 中搜索 TODO · 等待结果');
			assert.equal(widget.element.querySelector('[data-tool-section="input"] summary')!.textContent, '输入');
			assert.equal(widget.element.querySelector('[data-tool-section="input"] pre')!.getAttribute('aria-label'), '输入');
			assert.equal(widget.element.querySelector('[data-tool-section="input"] pre')!.textContent, '{"path":"src/main.ts"}');
		} finally {
			resetNlsResolver();
		}
	});
});

suite('Rendered tool input/output', () => {
	const browserTests = useBrowserTests();
	for (const theme of ['light', 'dark', 'hc', 'hcLight'] as const) {
		test(`keyboard disclosures and bounded output survive updates in ${theme}`, async () => {
			const { page } = browserTests;
			await page.goto('/chatTranscript.html');
			const item = toolItem({ type: 'command', program: 'git', arguments: ['diff'], workingDirectory: '/workspace' });
			const invocation = item.toolInvocation!;
			const output: Extract<ThreadTranscriptEntry, { type: 'toolOutput'; }>[] = [{
				type: 'toolOutput', entryId: 'out', turnId: 'turn', toolCallId: 'call', stream: 'stdout',
				text: Array.from({ length: 60 }, (_, index) => `${index} ${'literal output '.repeat(30)}`).join('\n'),
			}];
			const rendering = { ...item, toolInvocation: { ...invocation, output } };
			await page.evaluate(({ theme, rendering }) => {
				window.ashChatTranscriptIntegration.setTheme(theme);
				document.body.style.background = 'var(--ash-editor-background)';
				window.ashChatTranscriptIntegration.renderItems([rendering]);
			}, { theme, rendering });
			const outer = page.locator('.ash-chat-tool-invocation');
			const summary = outer.locator(':scope > summary');
			await expect(summary).toHaveText('Run git "diff" · Awaiting result');
			await summary.focus();
			await page.keyboard.press('Enter');
			const stdout = outer.locator('[data-tool-section="stdout"]');
			await stdout.locator('summary').focus();
			await page.keyboard.press('Space');
			const region = stdout.getByRole('region', { name: 'Standard output' });
			await expect(region).toBeVisible();
			await page.keyboard.press('Tab');
			await expect(region).toBeFocused();
			await expect(region).toHaveCSS('overflow-x', 'auto');
			await expect(region).toHaveCSS('white-space', 'pre');
			assert.equal(await region.evaluate(element => element.scrollHeight > element.clientHeight && element.scrollWidth > element.clientWidth), true);
			await page.keyboard.press('ArrowDown');
			await expect.poll(() => region.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
			const selected = await region.evaluate(element => {
				const selection = element.ownerDocument.getSelection()!;
				selection.setBaseAndExtent(element.firstChild!, 0, element.firstChild!, 14);
				return selection.toString();
			});
			const retained = await region.elementHandle();
			await page.evaluate(rendering => window.ashChatTranscriptIntegration.renderItems([{
				...rendering, transient: false,
				toolInvocation: {
					...rendering.toolInvocation,
					output: [...rendering.toolInvocation.output, { ...rendering.toolInvocation.output[0], entryId: 'tail', text: 'streamed tail' }],
					result: { type: 'toolResult', itemId: 'result', turnId: 'turn', toolCallId: 'call', text: 'done', isError: false },
				},
			}]), rendering);
			await expect(summary).toHaveText('Run git "diff" · Completed');
			await expect(region).toBeFocused();
			assert.equal(await region.evaluate(element => element.ownerDocument.getSelection()!.toString()), selected);
			assert.equal(await region.evaluate((element, retained) => element === retained, retained), true);
			await expect(outer.locator('[data-tool-section="input"]')).not.toHaveAttribute('open');
			await page.setViewportSize({ width: 420, height: 720 });
			await page.locator('main').evaluate(element => { element.style.width = '360px'; });
			await expect.poll(() => outer.evaluate(element => element.getBoundingClientRect().width)).toBeLessThanOrEqual(360);
			await stdout.locator('summary').focus();
			await page.keyboard.press('Space');
			await expect(region).toBeHidden();
			await expect(stdout.locator('summary')).toBeFocused();
			await expect(stdout.locator('summary')).not.toHaveCSS('outline-style', 'none');
			await page.keyboard.press('Space');
			await expect(region).toBeVisible();
			await page.locator('main').evaluate(element => { element.style.height = '600px'; });
			await page.locator('.ash-chat-list-widget .ash-scrollbar-viewport').evaluate(element => { element.scrollTop = 0; });
			await page.locator('main').screenshot({ path: browserTests.info.outputPath(`tool-io-${theme}.png`) });
			await retained?.dispose();
		});
	}
});
