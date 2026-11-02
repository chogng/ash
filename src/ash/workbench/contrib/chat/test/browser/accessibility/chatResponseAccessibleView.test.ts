import '../../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { suite, test } from 'mocha';
import { Emitter } from '../../../../../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { resetNlsResolver, setNlsMessages } from '../../../../../../nls.js';
import { ChatResponseAccessibleView } from '../../../browser/accessibility/chatResponseAccessibleView.js';
import { chatTranscriptListItems, type IChatListItem } from '../../../common/model/chatViewModel.js';
import type { ThreadTranscriptEntry, Turn } from '../../../../../services/chat/common/chatService.js';

suite('ChatResponseAccessibleView', () => {
	test('reads current model order, plain Markdown, exact context and complete code without rendered rows', () => {
		using resources = new DisposableStore();
		const changes = resources.add(new Emitter<void>());
		const button = document.createElement('button');
		document.body.append(button);
		resources.add(toDisposable(() => button.remove()));
		button.focus();
		let items: readonly IChatListItem[] = [
			{ id: 'request', type: 'userMessage', text: '**literal request**', transient: false },
			{ id: 'context', type: 'userContext', text: 'Saved context', contextText: '<script>untrusted()</script>', transient: false },
			{ id: 'response', type: 'agentMessage', text: '**Reply** with [label](https://example.com).\n\n```ts\nconst exact = "<b>";\n```', transient: true },
		];
		let focused: HTMLElement | undefined;
		const implementation = new ChatResponseAccessibleView({ getItems: () => items, getFocusedElement: () => focused, onDidChangeContent: changes.event });
		assert.equal(implementation.getProvider(), undefined);
		focused = button;
		using provider = implementation.getProvider()!;
		assert.equal(provider.provideContent(), 'You\n\n**literal request**\n\nYou\n\nSaved context\n\n<script>untrusted()</script>\n\nAsh\n\nReply with label.\nconst exact = "<b>";');
		let notifications = 0;
		resources.add(provider.onDidChangeContent!(() => notifications++));
		items = [{ id: 'response', type: 'agentMessage', text: 'Updated **reply**', transient: false }, items[0]];
		changes.fire();
		assert.equal(notifications, 1);
		assert.equal(provider.provideContent(), 'Ash\n\nUpdated reply\n\nYou\n\n**literal request**');
		button.blur();
		provider.dispose();
		assert.equal(document.activeElement, button);
	});

	for (const locale of ['en', 'zh-CN']) {
		test(`reads tool status from current backend evidence in ${locale}`, () => {
			if (locale === 'zh-CN') {
				setNlsMessages(locale, JSON.parse(readFileSync('extensions/language-pack-zh-cn/translations/chat.json', 'utf8')));
			}
			try {
				const entries: ThreadTranscriptEntry[] = [{
					type: 'item', entryId: 'call', turnId: 'turn', transient: false,
					item: { type: 'toolCall', itemId: 'call', turnId: 'turn', toolCallId: 'tool', name: 'shell', argumentsJson: '{}' },
				}];
				const total = { reported: 0, complete: true };
				const turn: Turn = {
					turnId: 'turn', status: 'running', mode: 'agent', approvalMode: 'manual', items: [],
					usage: { modelInvocations: 0, inputTokens: total, outputTokens: total, cachedInputTokens: total, cacheWriteInputTokens: total, reasoningTokens: total },
				};
				let turns: readonly Turn[] = [turn];
				const implementation = new ChatResponseAccessibleView({ getItems: () => chatTranscriptListItems(entries, undefined, turns), getFocusedElement: () => document.body, onDidChangeContent: () => toDisposable(() => { }) });
				using provider = implementation.getProvider()!;
				assert.ok(provider.provideContent().includes(locale === 'en' ? 'shell · Awaiting result' : 'shell · 等待结果'));
				turns = [{ ...turn, startedToolCallIds: ['tool'] }];
				assert.ok(provider.provideContent().includes(locale === 'en' ? 'shell · Running' : 'shell · 执行中'));
				for (const [kind, status, english, chinese] of [
					['approval', 'waitingForApproval', 'Awaiting approval', '等待批准'],
					['permissions', 'waitingForUserInput', 'Awaiting permissions', '等待授予权限'],
					['userInput', 'waitingForUserInput', 'Awaiting your response', '等待你的回复'],
					['dynamicTool', 'waitingForCapability', 'Awaiting client tool', '等待客户端工具'],
				] as const) {
					turns = [{ ...turn, status, startedToolCallIds: ['tool'], pendingInteraction: { requestId: kind, itemId: 'call', kind } }];
					assert.ok(provider.provideContent().includes(`shell · ${locale === 'en' ? english : chinese}`));
				}
				turns = [turn];
				entries.push({ type: 'toolOutput', entryId: 'output', turnId: 'turn', toolCallId: 'tool', stream: 'stderr', text: 'diagnostic output' });
				assert.ok(provider.provideContent().includes(locale === 'en' ? 'shell · Running' : 'shell · 执行中'));
				turns = [{ ...turn, status: 'waitingForApproval', pendingInteraction: { requestId: 'approval', itemId: 'call', kind: 'approval' } }];
				assert.ok(provider.provideContent().includes(locale === 'en' ? 'shell · Awaiting approval' : 'shell · 等待批准'));
				turns = [turn];
				assert.ok(provider.provideContent().includes(locale === 'en' ? 'shell · Running' : 'shell · 执行中'));
				entries.push({ type: 'turnError', entryId: 'error', turnId: 'turn', error: { code: 'connectionFailed', message: 'lost connection', retryable: true } });
				assert.ok(provider.provideContent().includes(locale === 'en' ? 'shell · No result' : 'shell · 无结果'));
				entries.push({ type: 'item', entryId: 'result', turnId: 'turn', transient: false, item: { type: 'toolResult', itemId: 'result', turnId: 'turn', toolCallId: 'tool', text: 'done', isError: false } });
				assert.ok(provider.provideContent().includes(locale === 'en' ? 'shell · Completed' : 'shell · 已完成'));
			} finally {
				resetNlsResolver();
			}
		});
	}

	test('includes tool evidence and resource metadata in Chinese without creating resource DOM', () => {
		setNlsMessages('zh-CN', JSON.parse(readFileSync('extensions/language-pack-zh-cn/translations/chat.json', 'utf8')));
		try {
			const items: readonly IChatListItem[] = [{
				id: 'call', type: 'toolCall', text: '', transient: false,
				toolInvocation: {
					call: { type: 'toolCall', itemId: 'call', turnId: 'turn', toolCallId: 'tool', name: 'shell', argumentsJson: '{"command":"pwd"}' },
					output: [{ type: 'toolOutput', entryId: 'output', turnId: 'turn', toolCallId: 'tool', stream: 'stdout', text: '<img src=x onerror=alert(1)>' }],
					result: {
						type: 'toolResult', itemId: 'result', turnId: 'turn', toolCallId: 'tool', text: 'failed', isError: true,
						content: [{ type: 'artifact', artifact: { source: { type: 'resourceLink', uri: 'https://example.com/result' }, mimeType: 'application/octet-stream', data: { type: 'bytes', bytes: new Uint8Array(3) }, contentDigest: 'digest', truncated: true } }],
					},
					stopped: true,
				},
			}];
			const implementation = new ChatResponseAccessibleView({ getItems: () => items, getFocusedElement: () => document.body, onDidChangeContent: () => toDisposable(() => { }) });
			using provider = implementation.getProvider()!;
			const text = provider.provideContent();
			assert.match(text, /shell · 失败/);
			assert.match(text, /输入\n\{"command":"pwd"\}/);
			assert.match(text, /标准输出\n<img src=x onerror=alert\(1\)>/);
			assert.match(text, /application\/octet-stream · 内容已截断/);
			assert.match(text, /二进制资源（3 字节）/);
			assert.match(text, /https:\/\/example.com\/result/);
			assert.equal(document.querySelector('img[src="x"]'), null);
		} finally { resetNlsResolver(); }
	});
});
