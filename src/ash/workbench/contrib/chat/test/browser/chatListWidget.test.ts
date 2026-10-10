import { browserEnvironment } from '../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resetNlsResolver, setNlsMessages } from '../../../../../nls.js';
import { test } from 'mocha';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { createCodeEditorServices } from '../../../../../editor/test/browser/testCodeEditor.js';
import { createTestEditorServices } from '../../../../test/common/testEditorServices.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { chatTranscriptListItems } from '../../browser/widget/chatListItems.js';
import type { ChatHookRun, ThreadTranscriptEntry } from '../../../../services/chat/common/chatService.js';
import { ChatListWidget } from '../../browser/widget/chatListWidget.js';
import { ChatEditorConfiguration, ChatInputConfiguration } from '../../browser/chat.shared.contribution.js';
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
	const code = transcript.querySelector('pre code')!;
	const inlineCode = transcript.querySelector('p code')!;
	assert.match(transcript.style.getPropertyValue('--ash-chat-code-font-family'), /^"Fira Code",/u);
	assert.equal(transcript.style.getPropertyValue('--ash-chat-code-font-size'), '16px');
	assert.equal(transcript.style.getPropertyValue('--ash-chat-code-line-height'), '25px');
	await configuration.updateValue(ChatEditorConfiguration.fontFamily, 'Courier New');
	await configuration.updateValue(ChatEditorConfiguration.fontSize, 20);
	await configuration.updateValue(ChatEditorConfiguration.lineHeight, 32);
	await configuration.updateValue(ChatEditorConfiguration.wordWrap, 'on');
	assert.equal(transcript.querySelector('pre code'), code);
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
	setNlsMessages('zh-CN', JSON.parse(readFileSync('localization/zh-CN/chat.json', 'utf8')));
	try {
		using resources = new DisposableStore();
		const services = resources.add(createTestEditorServices(undefined, createCodeEditorServices(resources)));
		using widget = services.createInstance(ChatListWidget, document.createElement('main'), {});
		widget.render([{ id: 'hook', type: 'hook', text: 'reason', transient: false, hookPart: { kind: 'hook', hookType: 'preToolUse', stopReason: 'reason', toolDisplayName: 'shell-command' } }]);
		assert.match(widget.element.querySelector('summary')!.textContent!, /已阻断 shell-command/);
	} finally { resetNlsResolver(); }
});
