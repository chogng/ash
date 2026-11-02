import '../../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { suite, test } from 'mocha';
import { Emitter } from '../../../../../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { resetNlsResolver, setNlsMessages } from '../../../../../../nls.js';
import { ChatResponseAccessibleView } from '../../../browser/accessibility/chatResponseAccessibleView.js';
import type { IChatListItem } from '../../../common/model/chatViewModel.js';

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
