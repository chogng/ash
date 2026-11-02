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
import type { ThreadTranscriptEntry, Turn } from '../../../../../../services/chat/common/chatService.js';

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

function approvalTurn(pendingInteraction: Turn['pendingInteraction'], status: Turn['status'] = 'waitingForApproval'): Turn {
	const total = { reported: 0, complete: true };
	return {
		turnId: 'turn', status, mode: 'agent', approvalMode: 'manual', items: [], pendingInteraction,
		usage: { modelInvocations: 0, inputTokens: total, outputTokens: total, cachedInputTokens: total, cacheWriteInputTokens: total, reasoningTokens: total },
	};
}

suite('Tool activity and input/output presentation', () => {
	suiteSetup(() => { getWindows(); });
	ensureNoDisposablesAreLeakedInTestSuite();

	test('approval matches the exact Turn and Item and never spreads to parallel or completed calls', () => {
		const call = { ...toolItem().toolInvocation!.call, toolCallId: 'provider-call' };
		const entries: ThreadTranscriptEntry[] = [
			{ type: 'item', entryId: 'render-entry', turnId: 'turn', transient: false, item: call },
			{ type: 'item', entryId: 'parallel-entry', turnId: 'turn', transient: false, item: { ...call, itemId: 'parallel-item', toolCallId: 'parallel-call' } },
			{ type: 'item', entryId: 'older-entry', turnId: 'older-turn', transient: false, item: { ...call, turnId: 'older-turn' } },
		];
		const pending = { requestId: 'request', itemId: call.itemId, kind: 'approval' as const };
		const flags = (turn: Turn, transcript = entries): boolean[] => chatTranscriptListItems(transcript, undefined, [turn]).map(item => item.toolInvocation?.waitingFor === 'approval');
		assert.deepEqual(flags(approvalTurn(pending)), [true, false, false]);
		for (const [kind, status] of [['approval', 'waitingForApproval'], ['permissions', 'waitingForUserInput'], ['userInput', 'waitingForUserInput'], ['dynamicTool', 'waitingForCapability']] as const) {
			const turn = approvalTurn({ ...pending, kind }, status);
			const items = chatTranscriptListItems(entries, undefined, [{ ...turn, startedToolCallIds: [call.toolCallId] }]);
			assert.deepEqual(items.map(item => item.toolInvocation?.waitingFor), [kind, undefined, undefined]);
			assert.deepEqual(items.map(item => item.toolInvocation?.executionStarted), [true, false, false]);
		}
		for (const itemId of [undefined, null, 'render-entry', 'provider-call', 'missing-item']) {
			assert.deepEqual(flags(approvalTurn({ ...pending, itemId })), [false, false, false]);
		}
		for (const status of ['running', 'cancelling', 'completed', 'failed', 'interrupted'] as const) {
			assert.deepEqual(flags(approvalTurn(pending, status)), [false, false, false]);
		}
		for (const kind of ['userInput', 'dynamicTool', 'permissions'] as const) {
			assert.deepEqual(flags(approvalTurn({ ...pending, kind })), [false, false, false]);
		}
		assert.deepEqual(flags(approvalTurn(null)), [false, false, false]);
		for (const isError of [false, true]) {
			const result: ThreadTranscriptEntry = { type: 'item', entryId: 'result', turnId: 'turn', transient: false, item: { type: 'toolResult', itemId: 'result', turnId: 'turn', toolCallId: call.toolCallId, text: 'done', isError } };
			assert.deepEqual(flags(approvalTurn(pending), [...entries, result]), [false, false, false]);
		}
	});

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

	for (const replaced of ['call', 'turn', 'content'] as const) {
		test(`a changed ${replaced} retires the old tool owner even when the row text is unchanged`, () => {
			using resources = new DisposableStore();
			const services = resources.add(createTestEditorServices(undefined, createCodeEditorServices(resources)));
			using widget = services.createInstance(ChatListWidget, document.createElement('main'), {});
			const item = toolItem();
			widget.render([item]);
			const old = widget.element.querySelector('[data-tool-call-id]')!;
			const invocation = item.toolInvocation!;
			widget.render([{
				...item,
				toolInvocation: replaced === 'content' ? undefined : {
					...invocation, call: { ...invocation.call, ...(replaced === 'turn' ? { turnId: 'next-turn' } : { toolCallId: 'next-call' }) },
				},
			}]);
			assert.equal(widget.element.contains(old), false);
			const next = widget.element.querySelector('[data-tool-call-id]');
			if (replaced === 'content') { assert.equal(next, null); }
			else { assert.equal(next?.getAttribute('data-tool-call-id'), replaced === 'call' ? 'next-call' : invocation.call.toolCallId); }
		});
	}

	for (const locale of ['en', 'zh-CN']) {
		test(`tool status follows call evidence and preserves the focused disclosure in ${locale}`, () => {
			if (locale === 'zh-CN') {
				setNlsMessages(locale, JSON.parse(readFileSync('extensions/language-pack-zh-cn/translations/chat.json', 'utf8')));
			}
			try {
				using resources = new DisposableStore();
				const services = resources.add(createTestEditorServices(undefined, createCodeEditorServices(resources)));
				const container = document.createElement('main');
				document.body.append(container);
				resources.add(toDisposable(() => container.remove()));
				using widget = services.createInstance(ChatListWidget, container, {});
				const call: ThreadTranscriptEntry = {
					type: 'item', entryId: 'call', turnId: 'turn', transient: false,
					item: toolItem().toolInvocation!.call,
				};
				const output: ThreadTranscriptEntry = {
					type: 'toolOutput', entryId: 'output', turnId: 'turn', toolCallId: 'call', stream: 'stderr', text: 'warning, still running',
				};
				const stopped: ThreadTranscriptEntry = {
					type: 'turnError', entryId: 'error', turnId: 'turn', error: { code: 'connectionFailed', message: 'lost connection', retryable: true },
				};
				const result = {
					type: 'item' as const, entryId: 'result', turnId: 'turn', transient: false,
					item: { type: 'toolResult' as const, itemId: 'result', turnId: 'turn', toolCallId: 'call', text: 'done', isError: false },
				};
				const approval = approvalTurn({ requestId: 'request', itemId: call.item.itemId, kind: 'approval' });
				const started = { ...approvalTurn(null, 'running'), startedToolCallIds: ['call'] };
				widget.render(chatTranscriptListItems([call]));
				const details = widget.element.querySelector<HTMLDetailsElement>('.ash-chat-tool-invocation')!;
				const summary = details.querySelector('summary')!;
				details.open = true;
				summary.focus();
				const states: readonly [readonly ThreadTranscriptEntry[], string, string, string, string, (readonly Turn[])?][] = [
					[[call], 'pending', 'Awaiting result', '等待结果', 'clockface'],
					[[call], 'waitingForApproval', 'Awaiting approval', '等待批准', 'lock', [approval]],
					[[call], 'pending', 'Awaiting result', '等待结果', 'clockface', [approvalTurn(null, 'running')]],
					[[call], 'running', 'Running', '执行中', 'play', [started]],
					[[call], 'waitingForPermissions', 'Awaiting permissions', '等待授予权限', 'lock', [{ ...started, status: 'waitingForUserInput', pendingInteraction: { requestId: 'permissions', itemId: 'call', kind: 'permissions' } }]],
					[[call], 'waitingForUserInput', 'Awaiting your response', '等待你的回复', 'question', [{ ...started, status: 'waitingForUserInput', pendingInteraction: { requestId: 'input', itemId: 'call', kind: 'userInput' } }]],
					[[call], 'waitingForCapability', 'Awaiting client tool', '等待客户端工具', 'plug', [{ ...started, status: 'waitingForCapability', pendingInteraction: { requestId: 'dynamic', itemId: 'call', kind: 'dynamicTool' } }]],
					[[call], 'running', 'Running', '执行中', 'play', [started]],
					[[call, output], 'running', 'Running', '执行中', 'play'],
					[[call, output], 'waitingForApproval', 'Awaiting approval', '等待批准', 'lock', [approval]],
					[[call, output, stopped], 'stopped', 'No result', '无结果', 'stop-circle'],
					[[call, output, stopped, result], 'completed', 'Completed', '已完成', 'check'],
					[[call, output, stopped, { ...result, item: { ...result.item, isError: true } }], 'failed', 'Failed', '失败', 'error'],
				];
				for (const [entries, state, english, chinese, icon, turns] of states) {
					widget.render(chatTranscriptListItems(entries, undefined, turns));
					assert.equal(summary.textContent, `fixture_tool · ${locale === 'en' ? english : chinese}`);
					assert.equal(details.dataset.state, state);
					assert.equal(details.getAttribute('aria-busy'), String(state === 'pending' || state === 'running'));
					assert.equal(details.classList.contains('error'), state === 'failed');
					assert.equal(summary.querySelector('.ash-chat-tool-status-icon')!.getAttribute('aria-hidden'), 'true');
					assert.ok(summary.querySelector(`.ash-icon-${icon}`));
					assert.equal(widget.element.querySelector('.ash-chat-tool-invocation'), details);
					assert.equal(details.open, true);
					assert.equal(document.activeElement, summary);
				}
			} finally {
				resetNlsResolver();
			}
		});
	}

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
				window.ashChatTranscriptIntegration.renderItems([{ ...rendering, toolInvocation: { ...rendering.toolInvocation, output: [], executionStarted: false } }]);
			}, { theme, rendering });
			const outer = page.locator('.ash-chat-tool-invocation');
			const summary = outer.locator(':scope > summary');
			await expect(summary).toHaveText('Run git \"diff\" · Awaiting result');
			await page.evaluate(rendering => window.ashChatTranscriptIntegration.renderItems([{
				...rendering, toolInvocation: { ...rendering.toolInvocation, output: [], executionStarted: true },
			}]), rendering);
			await expect(summary).toHaveText('Run git "diff" · Running');
			await expect(outer).toHaveAttribute('aria-busy', 'true');
			await expect(summary.locator('.ash-chat-tool-status-icon')).toHaveAttribute('aria-hidden', 'true');
			await expect(summary.locator('.ash-icon-play')).toBeVisible();
			await summary.focus();
			await page.evaluate(rendering => window.ashChatTranscriptIntegration.renderItems([rendering]), rendering);
			await page.evaluate(rendering => window.ashChatTranscriptIntegration.renderItems([{
				...rendering, toolInvocation: { ...rendering.toolInvocation, waitingFor: 'approval' as const },
			}]), rendering);
			await expect(summary).toHaveText('Run git "diff" · Awaiting approval');
			await expect(summary.locator('.ash-icon-lock')).toBeVisible();
			await expect(outer).toHaveAttribute('aria-busy', 'false');
			await expect(summary).toBeFocused();
			await page.evaluate(rendering => window.ashChatTranscriptIntegration.renderItems([rendering]), rendering);
			await expect(summary).toHaveText('Run git "diff" · Running');
			await expect(summary).toBeFocused();
			await page.keyboard.press('Enter');
			await expect(outer.getByText('Working directory: /workspace', { exact: true })).toBeVisible();
			const copyCommand = outer.getByRole('button', { name: 'Copy command and arguments', exact: true });
			await copyCommand.focus();
			await copyCommand.press('Enter');
			await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.state().copied)).toBe('git ["diff"]');
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
			await expect(outer).toHaveAttribute('aria-busy', 'false');
			await expect(summary.locator('.ash-icon-check')).toBeVisible();
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

	test('command output admission cancels fast completion and respects user disclosure choices', async () => {
		const { page } = browserTests;
		await page.goto('/chatTranscript.html');
		const time = new Date('2026-11-02T00:00:00Z');
		await page.clock.install({ time });
		await page.clock.pauseAt(time);
		const item = toolItem({ type: 'command', program: 'git', arguments: ['diff'], workingDirectory: '/workspace' });
		const invocation = item.toolInvocation!;
		const output: Extract<ThreadTranscriptEntry, { type: 'toolOutput'; }>[] = [{
			type: 'toolOutput', entryId: 'out', turnId: 'turn', toolCallId: 'call', stream: 'stdout', text: 'changes',
		}];
		const running = { ...item, toolInvocation: { ...invocation, output, executionStarted: true } };
		const completed = {
			...running, toolInvocation: {
				...running.toolInvocation, result: {
					type: 'toolResult' as const, itemId: 'result', turnId: 'turn', toolCallId: 'call', text: 'done', isError: false,
				}
			}
		};
		const render = async (value: IChatListItem) => page.evaluate(value => window.ashChatTranscriptIntegration.renderItems([value]), value);
		const reset = async () => page.evaluate(() => window.ashChatTranscriptIntegration.renderItems([]));
		const outer = page.locator('.ash-chat-tool-invocation');
		await render(running);
		await outer.locator(':scope > summary').focus();
		await page.clock.runFor(49);
		await expect(outer).not.toHaveAttribute('open');
		await page.clock.runFor(2);
		await expect(outer).toHaveAttribute('open');
		await expect(outer.locator(':scope > summary')).toBeFocused();
		await render(completed);
		await expect(outer).not.toHaveAttribute('open');
		await reset();
		await render(running);
		await page.clock.runFor(20);
		await render(completed);
		await page.clock.runFor(600);
		await expect(outer).not.toHaveAttribute('open');
		await reset();
		await render(running);
		await page.clock.runFor(51);
		await outer.locator('button').first().focus();
		await render(completed);
		await expect(outer).toHaveAttribute('open');
		await reset();
		await render(running);
		await outer.locator(':scope > summary').evaluate(element => {
			element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
			(element.parentElement as HTMLDetailsElement).open = false;
		});
		await page.clock.runFor(600);
		await expect(outer).not.toHaveAttribute('open');
		await reset();
		await render({ ...running, toolInvocation: { ...running.toolInvocation, waitingFor: 'approval' } });
		await page.clock.runFor(600);
		await expect(outer).not.toHaveAttribute('open');
		await reset();
		const failed = { ...completed, toolInvocation: { ...completed.toolInvocation, result: { ...completed.toolInvocation.result, isError: true } } };
		await render(failed);
		await expect(outer).toHaveAttribute('open');
		await reset();
		await page.evaluate(() => window.ashChatTranscriptIntegration.setAutoExpandToolFailures(false));
		await render(failed);
		await expect(outer).not.toHaveAttribute('open');
	});

	test('image generation suspends its progress surface while waiting for approval', async () => {
		const { page } = browserTests;
		await page.goto('/chatTranscript.html');
		const original = toolItem();
		const item = {
			...original,
			toolInvocation: { ...original.toolInvocation!, call: { ...original.toolInvocation!.call, name: 'imagegen' }, waitingFor: 'approval' as const },
		};
		await page.evaluate(item => window.ashChatTranscriptIntegration.renderItems([item]), item);
		const summary = page.locator('.ash-chat-tool-invocation > summary');
		const progress = page.locator('.ash-chat-image-generation-placeholder');
		await expect(summary).toHaveText('imagegen · Awaiting approval');
		await expect(progress).toHaveCount(0);
		await summary.focus();
		await page.evaluate(item => window.ashChatTranscriptIntegration.renderItems([{
			...item, toolInvocation: { ...item.toolInvocation, waitingFor: undefined },
		}]), item);
		await expect(summary).toHaveText('Generating image');
		await expect(progress).toBeVisible();
		await page.evaluate(item => window.ashChatTranscriptIntegration.renderItems([item]), item);
		await expect(summary).toHaveText('imagegen · Awaiting approval');
		await expect(progress).toHaveCount(0);
		await expect(summary).toBeFocused();
	});
});
