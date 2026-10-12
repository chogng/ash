import { AccessibleViewRegistry } from '../../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { AccessibleViewType } from '../../../../../platform/accessibility/browser/accessibleView.js';
import { browserEnvironment } from '../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resetNlsResolver, setNlsMessages } from '../../../../../nls.js';
import { test } from 'mocha';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { createCodeEditorServices } from '../../../../../editor/test/browser/testCodeEditor.js';
import { createTestEditorServices } from '../../../../test/common/testEditorServices.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { chatTranscriptListItems } from '../../browser/widget/chatListItems.js';
import type { ChatHookRun, ThreadTranscriptEntry } from '../../../../services/chat/common/chatService.js';
import { ChatListWidget } from '../../browser/widget/chatListWidget.js';
import '../../browser/chat.shared.contribution.js';
import { ChatEditorConfiguration, ChatInputConfiguration } from '../../common/constants.js';
import { CodeEditorConfiguration } from '../../../codeEditor/common/editorConfiguration.js';

const document = browserEnvironment.window.document;

test('code blocks inherit editor typography, retain their nodes on updates, and reset independently of message input', async () => {
	using resources = new DisposableStore();
	const services = resources.add(createTestEditorServices(undefined, createCodeEditorServices(resources)));
	const configuration = services.get(IConfigurationService);
	await configuration.updateValue(CodeEditorConfiguration.fontFamily, 'Fira Code');
	await configuration.updateValue(CodeEditorConfiguration.fontSize, 16);
	await configuration.updateValue(CodeEditorConfiguration.lineHeight, 25);
	using widget = services.createInstance(ChatListWidget, document.createElement('main'), {});
	widget.render([{ id: 'reply', type: 'agentMessage', text: 'Text with `inline code`.\n\n```ts\nconst value = 1;\n```', transient: false }]);
	const transcript = widget.element.querySelector<HTMLElement>('[role="log"]')!;
	const code = transcript.querySelector<HTMLElement>('.ash-chat-code-block .stanza-editor')!;
	const inlineCode = transcript.querySelector('p code')!;
	assert.match(transcript.style.getPropertyValue('--ash-chat-code-font-family'), /^"Fira Code",/u);
	assert.equal(transcript.style.getPropertyValue('--ash-chat-code-font-size'), '16px');
	assert.equal(transcript.style.getPropertyValue('--ash-chat-code-line-height'), '25px');
	await configuration.updateValue(ChatEditorConfiguration.fontFamily, 'Courier New');
	await configuration.updateValue(ChatEditorConfiguration.fontSize, 20);
	await configuration.updateValue(ChatEditorConfiguration.lineHeight, 32);
	await configuration.updateValue(ChatEditorConfiguration.wordWrap, 'on');
	assert.equal(transcript.querySelector('.ash-chat-code-block .stanza-editor'), code);
	assert.equal(code.style.fontSize, '20px');
	assert.equal(code.style.lineHeight, '32px');
	assert.equal(transcript.querySelector('p code'), inlineCode);
	assert.match(transcript.style.getPropertyValue('--ash-chat-code-font-family'), /^"Courier New",/u);
	assert.equal(transcript.style.getPropertyValue('--ash-chat-code-font-size'), '20px');
	assert.equal(transcript.style.getPropertyValue('--ash-chat-code-line-height'), '32px');
	assert.equal(widget.element.classList.contains('code-word-wrap'), true);
	await configuration.updateValue(CodeEditorConfiguration.fontSize, 18);
	await configuration.updateValue(ChatInputConfiguration.fontSize, 22);
	assert.equal(transcript.style.getPropertyValue('--ash-chat-code-font-size'), '20px');
	assert.equal(configuration.getValue(CodeEditorConfiguration.fontSize), 18);
	assert.equal(configuration.getValue(ChatInputConfiguration.fontSize), 22);
	for (const key of Object.values(ChatEditorConfiguration)) await configuration.updateValue(key, undefined);
	assert.equal(transcript.style.getPropertyValue('--ash-chat-code-font-size'), '18px');
	assert.equal(transcript.style.getPropertyValue('--ash-chat-code-line-height'), '25px');
	assert.equal(widget.element.classList.contains('code-word-wrap'), false);
	widget.dispose();
	await configuration.updateValue(CodeEditorConfiguration.fontSize, 24);
	assert.equal(transcript.style.getPropertyValue('--ash-chat-code-font-size'), '18px');
});

test('code block settings reject invalid persisted values without changing the active preferences', async () => {
	using resources = new DisposableStore();
	const configuration = createCodeEditorServices(resources).get(IConfigurationService);
	for (const [key, value] of [
		[ChatEditorConfiguration.fontFamily, 'Menlo\nArial'],
		[ChatEditorConfiguration.fontSize, 7],
		[ChatEditorConfiguration.fontSize, 12.5],
		[ChatEditorConfiguration.lineHeight, -1],
		[ChatEditorConfiguration.lineHeight, 7],
		[ChatEditorConfiguration.wordWrap, true],
	] as const) await assert.rejects(configuration.updateValue(key, value));
	assert.deepEqual(Object.values(ChatEditorConfiguration).map(key => configuration.getValue(key)), ['', 0, 0, 'off']);
});


test('Hook feedback stays collapsed, renders process text safely, and successful runs stay silent', () => {
	using resources = new DisposableStore();
	const services = resources.add(createTestEditorServices(undefined, createCodeEditorServices(resources)));
	using widget = services.createInstance(ChatListWidget, document.createElement('main'), {});
	const run: ChatHookRun = { runId: 'run', hookId: 'user:hook:test', event: 'preToolUse', status: { type: 'running' }, startedAtUnixMs: 1, durationMs: 0, turnId: 'turn', toolCallId: 'tool', toolName: 'shell-command' };
	const entry = (status: ChatHookRun['status']): ThreadTranscriptEntry => ({ type: 'hookRun', entryId: 'hook:run', turnId: 'turn', run: { ...run, status } });
	assert.deepEqual(chatTranscriptListItems([entry({ type: 'running' }), entry({ type: 'continued' })]), []);
	const denied = chatTranscriptListItems([entry({ type: 'denied', reason: '<img src=x onerror=alert(1)>' })]);
	widget.render(denied);
	const feedback = widget.element.querySelector<HTMLDetailsElement>('.ash-chat-hook')!;
	assert.equal(feedback.open, false);
	assert.match(feedback.querySelector('summary')!.textContent!, /Blocked shell-command/);
	assert.equal(feedback.querySelector('p')!.textContent, '<img src=x onerror=alert(1)>');
	assert.equal(feedback.querySelector('img'), null);
	feedback.open = true;
	widget.render(denied);
	assert.equal(widget.element.querySelector('.ash-chat-hook'), feedback);
	assert.equal(feedback.open, true);
	widget.render(chatTranscriptListItems([entry({ type: 'failed', message: 'process exited' })]));
	assert.equal(widget.element.querySelector('p')!.textContent, 'process exited');
	widget.render([]);
	assert.equal(widget.element.querySelector('.ash-chat-hook'), null);
});


test('Hook summaries use the active Chinese locale', () => {
	setNlsMessages('zh-CN', JSON.parse(readFileSync('extensions/language-pack-zh-cn/translations/chat.json', 'utf8')));
	try {
		using resources = new DisposableStore();
		const services = resources.add(createTestEditorServices(undefined, createCodeEditorServices(resources)));
		using widget = services.createInstance(ChatListWidget, document.createElement('main'), {});
		widget.render([{ id: 'hook', type: 'hook', text: 'reason', transient: false, hookPart: { kind: 'hook', hookType: 'preToolUse', stopReason: 'reason', toolDisplayName: 'shell-command' } }]);
		assert.match(widget.element.querySelector('summary')!.textContent!, /已阻断 shell-command/);
	} finally { resetNlsResolver(); }
});


test('tool evidence is Turn-scoped and keeps result-before-call and orphan output', () => {
	const call = (turnId: string): ThreadTranscriptEntry => ({ type: 'item', entryId: `call:${turnId}`, turnId, transient: false, item: { type: 'toolCall', itemId: `call:${turnId}`, turnId, toolCallId: 'reused', name: 'read', argumentsJson: '{}' } });
	const result: ThreadTranscriptEntry = { type: 'item', entryId: 'result', turnId: 'first', transient: false, item: { type: 'toolResult', itemId: 'result', turnId: 'first', toolCallId: 'reused', text: 'first result', isError: false } };
	const output: ThreadTranscriptEntry = { type: 'toolOutput', entryId: 'output', turnId: 'second', toolCallId: 'reused', stream: 'stdout', text: 'second output' };
	const orphan: ThreadTranscriptEntry = { type: 'toolOutput', entryId: 'orphan', turnId: 'third', toolCallId: 'missing', stream: 'stderr', text: 'orphan output' };
	const items = chatTranscriptListItems([result, call('first'), output, call('second'), orphan]);
	assert.deepEqual(items.map(item => item.id), ['call:first', 'call:second', 'orphan']);
	assert.equal(items[0].toolInvocation?.result?.text, 'first result');
	assert.deepEqual(items[0].toolInvocation?.output, []);
	assert.equal(items[1].toolInvocation?.result, undefined);
	assert.deepEqual(items[1].toolInvocation?.output, [output]);
	assert.equal(items[2].text, 'orphan output');
	assert.equal(chatTranscriptListItems([result])[0].text, 'first result');
	const stopped = chatTranscriptListItems([call('second'), { type: 'turnError', entryId: 'error', turnId: 'second', error: { code: 'connectionFailed', message: 'lost', retryable: true } }]);
	assert.equal(stopped[0].toolInvocation?.stopped, true);
	assert.equal(stopped[0].transient, false);
});

test('streaming tool content preserves disclosure focus, failure state and restored expansion', () => {
	using resources = new DisposableStore();
	const services = resources.add(createTestEditorServices(undefined, createCodeEditorServices(resources)));
	const container = document.createElement('main');
	document.body.append(container);
	resources.add(toDisposable(() => container.remove()));
	using widget = services.createInstance(ChatListWidget, container, {});
	const entries: ThreadTranscriptEntry[] = [{ type: 'item', entryId: 'call', turnId: 'turn', transient: false, item: { type: 'toolCall', itemId: 'call', turnId: 'turn', toolCallId: 'tool', name: 'shell', argumentsJson: '{}' } }];
	widget.render(chatTranscriptListItems(entries));
	const disclosure = widget.element.querySelector<HTMLDetailsElement>('details')!;
	const summary = disclosure.querySelector<HTMLElement>('summary')!;
	assert.equal(disclosure.open, false);
	disclosure.open = true;
	summary.focus();
	entries.push({ type: 'toolOutput', entryId: 'stdout', turnId: 'turn', toolCallId: 'tool', stream: 'stdout', text: '<img src=x onerror=alert(1)>' });
	widget.render(chatTranscriptListItems(entries));
	assert.equal(widget.element.querySelector('details'), disclosure);
	assert.equal(disclosure.open, true);
	assert.equal(document.activeElement, summary);
	assert.equal(disclosure.querySelector('img'), null);
	assert.match(disclosure.textContent!, /Standard output\n<img/);
	entries.push({ type: 'item', entryId: 'result', turnId: 'turn', transient: false, item: { type: 'toolResult', itemId: 'result', turnId: 'turn', toolCallId: 'tool', text: 'rejected', isError: true } });
	widget.render(chatTranscriptListItems(entries));
	assert.equal(summary.textContent, 'shell · Failed');
	assert.equal(disclosure.classList.contains('error'), true);
	assert.equal(document.activeElement, summary);
	const provider = services.invokeFunction(accessor => AccessibleViewRegistry.getImplementations().filter(implementation => implementation.type === AccessibleViewType.View && implementation.name.startsWith('chatTranscript-')).map(implementation => implementation.getProvider(accessor)).find(provider => provider !== undefined)!);
	assert.match(provider.provideContent(), /Standard output\n<img/);
	provider.dispose();
	assert.equal(document.activeElement, summary);
	const help = services.invokeFunction(accessor => AccessibleViewRegistry.getImplementations().filter(implementation => implementation.type === AccessibleViewType.Help && implementation.name.startsWith('chatTranscript-')).map(implementation => implementation.getProvider(accessor)).find(provider => provider !== undefined)!);
	assert.match(help.provideContent(), /tool summary/);
	help.dispose();
	const state = widget.getViewState();
	using restored = services.createInstance(ChatListWidget, document.createElement('main'), {});
	restored.restoreViewState(state, chatTranscriptListItems(entries));
	assert.equal(restored.element.querySelector<HTMLDetailsElement>('details')!.open, true);
	widget.render([]);
	assert.equal(disclosure.isConnected, false);
});

test('tool invocation summaries and sections use the Chinese locale', () => {
	setNlsMessages('zh-CN', JSON.parse(readFileSync('extensions/language-pack-zh-cn/translations/chat.json', 'utf8')));
	try {
		using resources = new DisposableStore();
		const services = resources.add(createTestEditorServices(undefined, createCodeEditorServices(resources)));
		using widget = services.createInstance(ChatListWidget, document.createElement('main'), {});
		widget.render(chatTranscriptListItems([{ type: 'item', entryId: 'call', turnId: 'turn', transient: false, item: { type: 'toolCall', itemId: 'call', turnId: 'turn', toolCallId: 'read', name: 'read', argumentsJson: '{}' } }]));
		assert.equal(widget.element.querySelector('summary')!.textContent, 'read · 等待结果');
		assert.match(widget.element.textContent!, /输入\n\{\}/);
		assert.equal(widget.element.querySelector('[role="log"]')!.getAttribute('aria-label'), '聊天记录');
	} finally { resetNlsResolver(); }
});
