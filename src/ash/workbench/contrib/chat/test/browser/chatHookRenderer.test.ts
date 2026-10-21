import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { ChatResponseResourceFileSystemProvider, IChatResponseResourceFileSystemProvider } from '../../common/widget/chatResponseResourceFileSystemProvider.js';
import { emptyEditorServiceState } from '../../../../test/common/testEditorService.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { readFileSync } from 'node:fs';
import { resetNlsResolver, setNlsMessages } from '../../../../../nls.js';
import { ChatHookContentPart } from '../../browser/widget/chatContentParts/chatHookContentPart.js';
import { browserEnvironment } from '../../../../../editor/test/browser/testEditorDom.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { createCodeEditorServices } from '../../../../../editor/test/browser/testCodeEditor.js';
import { createTestEditorServices } from '../../../../test/common/testEditorServices.js';
import { ChatListWidget } from '../../browser/widget/chatListWidget.js';
import { chatTranscriptListItems } from '../../browser/widget/chatListItems.js';
import { IAgentThreadService } from '../../../../../platform/agentHost/common/agentService.js';
import { createDisconnectedRendererApi } from '../../../../browser/rendererApi.js';
import type { ChatHookRun, ThreadTranscriptEntry } from '../../../../services/chat/common/chatService.js';
import '../../browser/chat.shared.contribution.js';

const document = browserEnvironment.window.document;
const run: ChatHookRun = { runId: 'run', hookId: 'user:hook:test', event: 'preToolUse', status: { type: 'running' }, startedAtUnixMs: 1, durationMs: 0, turnId: 'turn', toolCallId: 'tool', toolName: 'shell-command' };
const reason = '<img src=x onerror=alert(1)> & literal process reason';
const statuses: readonly ChatHookRun['status'][] = [{ type: 'running' }, { type: 'continued' }, { type: 'denied', reason }, { type: 'failed', message: reason }, { type: 'cancelled', reason }];
const entry = (status: ChatHookRun['status']): Extract<ThreadTranscriptEntry, { type: 'hookRun'; }> => ({ type: 'hookRun', entryId: 'hook:run', turnId: 'turn', run: { ...run, status, durationMs: status.type === 'running' ? 0 : 25 } });

test('Hook transcript retains all five domain states and their canonical run identities', () => {
	for (const status of statuses) {
		const canonical = entry(status);
		const items = chatTranscriptListItems([canonical]);
		assert.equal(items.length, 1, `visible ${status.type} Hook`);
		assert.deepEqual(items[0].hookPart, { kind: 'hook', run: canonical.run });
		assert.equal(items[0].id, canonical.entryId);
		assert.equal(items[0].isError, status.type === 'denied' || status.type === 'failed');
		assert.equal(items[0].transient, status.type === 'running');
	}
});

for (const host of [
	{ name: 'Code', create: (services: ReturnType<typeof createTestEditorServices>, container: HTMLElement) => services.createInstance(ChatListWidget, container, {}) },
	{ name: 'Cowork', create: (services: ReturnType<typeof createTestEditorServices>, container: HTMLElement) => services.createInstance(ChatListWidget, container, { classPrefix: 'ash-cowork' }) },
]) {

	test(`${host.name} Hook status updates retain the summary focus, disclosure and literal process reason`, () => {
		using resources = new DisposableStore();
		const services = resources.add(createTestEditorServices(undefined, createCodeEditorServices(resources)));
		if (!services.has(IAgentThreadService)) services.registerInstance(IAgentThreadService, createDisconnectedRendererApi().thread);
		if (!services.has(IChatResponseResourceFileSystemProvider)) services.registerInstance(IChatResponseResourceFileSystemProvider, resources.add(services.createInstance(ChatResponseResourceFileSystemProvider)));
		if (!services.has(IEditorService)) services.registerInstance(IEditorService, { ...emptyEditorServiceState, openEditor: async () => { throw new Error('Unexpected media preview'); }, focusActiveEditor() { } });
		const container = document.createElement('main');
		document.body.append(container);
		resources.add(toDisposable(() => container.remove()));
		const widget = resources.add(host.create(services, container));
		widget.render(chatTranscriptListItems([entry({ type: 'denied', reason })]));
		const disclosure = widget.element.querySelector<HTMLDetailsElement>('.ash-chat-hook')!;
		const summary = disclosure.querySelector<HTMLElement>('summary')!;
		assert.equal(disclosure.open, false);
		disclosure.open = true;
		summary.focus();
		const labels = new Set<string>();
		for (const status of statuses) {
			widget.render(chatTranscriptListItems([entry(status)]));
			assert.equal(widget.element.querySelector('.ash-chat-hook'), disclosure);
			assert.equal(disclosure.querySelector('summary'), summary);
			assert.equal(disclosure.open, true);
			assert.equal(document.activeElement, summary);
			assert.equal(disclosure.querySelector('p')!.textContent, status.type === 'running' || status.type === 'continued' ? '' : reason);
			assert.equal(disclosure.querySelector('img'), null);
			assert.equal(disclosure.closest('article')!.classList.contains('error'), status.type === 'denied' || status.type === 'failed');
			labels.add(summary.textContent!);
		}
		assert.equal(labels.size, 5, 'each domain state has its own localized summary');
		widget.render(chatTranscriptListItems([entry({ type: 'failed', message: 'process exited' })]));
		assert.equal(disclosure.querySelector('p')!.textContent, 'process exited');
		widget.render([]);
		assert.equal(widget.element.querySelector('.ash-chat-hook'), null);
	});
}

for (const locale of ['en', 'zh-CN']) {
	test(`Hook summaries distinguish all five statuses in ${locale} without translating process reasons`, () => {
		if (locale === 'zh-CN') setNlsMessages(locale, JSON.parse(readFileSync('extensions/language-pack-zh-cn/translations/chat.json', 'utf8')));
		try {
			const labels = locale === 'zh-CN'
				? ['正在为 shell-command 运行 preToolUse Hook', '已允许 shell-command · preToolUse Hook', '已阻断 shell-command · preToolUse Hook', '针对 shell-command 的 preToolUse Hook 失败', '针对 shell-command 的 preToolUse Hook 已取消']
				: ['Running preToolUse Hook for shell-command', 'Allowed shell-command · preToolUse Hook', 'Blocked shell-command · preToolUse Hook', 'preToolUse Hook failed for shell-command', 'preToolUse Hook cancelled for shell-command'];
			const withoutTool = locale === 'zh-CN'
				? ['正在运行 preToolUse Hook', 'preToolUse Hook 已允许继续', '已被 preToolUse Hook 阻断', 'preToolUse Hook 失败', 'preToolUse Hook 已取消']
				: ['Running preToolUse Hook', 'Allowed by preToolUse Hook', 'Blocked by preToolUse Hook', 'preToolUse Hook failed', 'preToolUse Hook cancelled'];
			using part = new ChatHookContentPart(document, { kind: 'hook', run });
			for (const [index, status] of statuses.entries()) {
				part.render({ kind: 'hook', run: { ...run, status } });
				assert.equal(part.domNode.querySelector('summary')!.textContent, labels[index]);
				assert.equal(part.domNode.querySelector('p')!.textContent, index < 2 ? '' : reason);
				part.render({ kind: 'hook', run: { ...run, toolName: null, status } });
				assert.equal(part.domNode.querySelector('summary')!.textContent, withoutTool[index]);
			}
		} finally { resetNlsResolver(); }
	});
}
