import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { ITextModelService } from '../../../../../editor/common/services/resolverService.js';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { IPromptsService } from '../../common/promptSyntax/service/promptsService.js';
import { PromptsService } from '../../common/promptSyntax/service/promptsServiceImpl.js';
import { Event } from '../../../../../base/common/event.js';
import { IAgentCapabilitiesService } from '../../../../../platform/agentCapabilities/common/agentCapabilitiesService.js';
import { AccessibleViewRegistry } from '../../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { AccessibleViewType } from '../../../../../platform/accessibility/browser/accessibleView.js';
import { PromptLanguageFeaturesProvider } from '../../browser/promptSyntax/promptFileContributions.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { ILanguageService } from '../../../../../editor/common/languages/language.js';
import { IMarkerService, MarkerSeverity } from '../../../../../platform/markers/common/markers.js';
import { URI } from '../../../../../base/common/uri.js';
import { browserEnvironment } from '../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resetNlsResolver, setNlsMessages } from '../../../../../nls.js';
import { test } from 'mocha';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { createCodeEditorServices, registerCodeEditorServices } from '../../../../../editor/test/browser/testCodeEditor.js';
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


test('streaming Markdown reuses static blocks and code editors, then releases rewritten code', () => {
	using resources = new DisposableStore();
	const services = resources.add(createTestEditorServices(undefined, createCodeEditorServices(resources)));
	using widget = services.createInstance(ChatListWidget, document.createElement('main'), {});
	const text = 'Stable text.\n\n```ts\nconst a = 1;';
	widget.render([{ id: 'reply', type: 'agentMessage', text, transient: true }]);
	const paragraph = widget.element.querySelector('p');
	const code = widget.element.querySelector('.stanza-editor');
	widget.render([{ id: 'reply', type: 'agentMessage', text: `${text}\nconst b = 2;`, transient: true }]);
	assert.equal(widget.element.querySelector('p'), paragraph);
	assert.equal(widget.element.querySelector('.stanza-editor'), code);
	widget.render([{ id: 'reply', type: 'agentMessage', text: `${text}\nconst b = 2;\n\x60\x60\x60\n\nDone.`, transient: false }]);
	assert.equal(widget.element.querySelector('p'), paragraph);
	assert.equal(widget.element.querySelector('.stanza-editor'), code);
	widget.render([{ id: 'reply', type: 'agentMessage', text: 'Replacement', transient: false }]);
	assert.equal(widget.element.querySelector('.stanza-editor'), null);
});


test('Skill diagnostic contribution handles open, edits, language changes and disposal without removing other markers', async () => {
	using resources = new DisposableStore();
	const services = resources.add(createTestEditorServices(undefined, createCodeEditorServices(resources)));
	const models = services.get(IModelService);
	const languages = services.get(ILanguageService);
	resources.add(languages.registerLanguage({ id: 'markdown' }));
	const markers = services.get(IMarkerService);
	const uri = URI.file('/skills/review/SKILL.md');
	const model = resources.add(models.createModel('---\nname: review\n---', languages.createById('markdown'), uri));
	markers.changeOne('other', uri, [{ range: { start: { lineIndex: 0, columnIndex: 0 }, end: { lineIndex: 0, columnIndex: 1 } }, severity: MarkerSeverity.Warning, message: 'existing' }]);
	services.registerInstance(IAgentCapabilitiesService, { isAvailable: true, read: async () => ({ tools: [{ name: 'read_file', description: 'Read authorized files', source: 'local', sourceDetails: ['Ash'], exposure: 'direct', authority: 'directoryRead' }, { name: 'internal_tool', description: 'Internal', source: 'local', sourceDetails: [], exposure: 'hidden', authority: 'providerDefined' }], toolSets: [], localProcessSandboxConfigured: false, directoryGrantsReadable: true, sandboxBackends: [], sandboxDiagnostics: [] }) });
	services.registerInstance(IPromptsService, resources.add(new PromptsService({ onDidChangeSkills: Event.None, list: async () => ({ generation: 1, skills: [] }), read: async () => ({ revision: 0, catalog: { generation: 1, skills: [] }, diagnostics: [] }), setEnabled: async () => { }, readTextResource: async () => { throw new Error('No discovered Skill'); } })));
	using contribution = services.createInstance(PromptLanguageFeaturesProvider);
	assert.deepEqual(markers.read(uri, PromptLanguageFeaturesProvider.ID).map(marker => marker.code), ['requiredField']);
	model.setValue('---\nname: review\ndescription: Review changes\n---');
	await new Promise(resolve => setTimeout(resolve, 150));
	assert.equal(markers.read(uri, PromptLanguageFeaturesProvider.ID).length, 0);
	model.setValue('---\nname: review\n---');
	model.setLanguage('plaintext');
	await new Promise(resolve => setTimeout(resolve, 150));
	assert.equal(markers.read(uri, PromptLanguageFeaturesProvider.ID).length, 0);
	model.setLanguage('markdown');
	assert.equal(markers.read(uri, PromptLanguageFeaturesProvider.ID).length, 1);
	contribution.dispose();
	assert.equal(markers.read(uri, PromptLanguageFeaturesProvider.ID).length, 0);
	assert.equal(markers.read(uri, 'other').length, 1);
});

test('streamed memory references retain their buttons, code editor and focus as new references arrive', () => {
	using resources = new DisposableStore();
	const services = resources.add(createTestEditorServices(undefined, createCodeEditorServices(resources)));
	const opened: string[] = [];
	using widget = services.createInstance(ChatListWidget, document.createElement('main'), { onDidRequestMemoryReference: (value: string) => opened.push(value) });
	document.body.append(widget.element);
	resources.add(toDisposable(() => widget.element.remove()));
	const text = 'memory:first\n\n```ts\nconst a = 1;\n```';
	widget.render([{ id: 'reply', type: 'agentMessage', text, transient: true }]);
	const code = widget.element.querySelector('.ash-chat-code-block')!;
	const button = [...widget.element.querySelectorAll('button')].find(button => button.textContent === 'Open memory reference 1')!;
	button.focus();
	widget.render([{ id: 'reply', type: 'agentMessage', text: text + '\n\nmemory:second', transient: false }]);
	assert.equal(widget.element.querySelector('.ash-chat-code-block'), code);
	assert.equal(document.activeElement, button);
	button.click();
	const second = [...widget.element.querySelectorAll('button')].find(button => button.textContent === 'Open memory reference 2')!;
	second.click();
	assert.deepEqual(opened, ['memory:first', 'memory:second']);
	widget.render([]);
	button.click();
	assert.deepEqual(opened, ['memory:first', 'memory:second']);
});


test('Skill resource content provider shares readonly models and cancels a late resource on removal', async () => {
	using resources = new DisposableStore();
	const services = resources.add(createTestEditorServices());
	registerCodeEditorServices(services);
	resources.add(services.get(ILanguageService).registerLanguage({ id: 'markdown', extensions: ['.md'] }));
	services.registerInstance(IAgentCapabilitiesService, { isAvailable: false, read: async () => { throw new Error('Unexpected capabilities read'); } });
	const pending = new DeferredPromise<string>();
	let delayed: AbortSignal | undefined;
	const calls: unknown[] = [];
	const prompts = resources.add(new PromptsService({
		onDidChangeSkills: Event.None,
		list: async () => ({ generation: 1, skills: [{ id: { source: 'user:review', name: 'review' }, description: 'Review', contentDigest: `sha256:${'a'.repeat(64)}`, enabled: true, compatible: true }] }),
		read: async () => { throw new Error('Unexpected management read'); }, setEnabled: async () => { },
		readTextResource: async (reference, path, signal, sessionId) => {
			calls.push([reference, path, sessionId]);
			if (path === 'references/late.md') { delayed = signal; return pending.p; }
			return path === 'SKILL.md' ? '---\nname: review\ndescription: Review changes\n---\n[Guide](references/guide.md)' : 'Read the guide.';
		},
	}));
	services.registerInstance(IPromptsService, prompts);
	using contribution = services.createInstance(PromptLanguageFeaturesProvider);
	const [skill] = await prompts.findAgentSkills(CancellationToken.None, 'session');
	const resolver = services.get(ITextModelService);
	const [first, second] = await Promise.all([resolver.createModelReference(skill.uri), resolver.createModelReference(skill.uri)]);
	assert.equal(first.object.isReadonly(), true);
	assert.equal(first.object.textEditorModel, second.object.textEditorModel);
	first.dispose();
	assert.equal(second.object.textEditorModel.isDisposed(), false);
	const child = skill.uri.with({ path: '/review/references/guide.md' });
	const childModel = await resolver.createModelReference(child);
	assert.equal(childModel.object.textEditorModel.getValue(), 'Read the guide.');
	assert.deepEqual((calls.at(-1) as unknown[]).slice(1), ['references/guide.md', 'session']);
	childModel.dispose();
	second.dispose();
	assert.equal(services.get(IModelService).getModels().length, 0);
	const reading = resolver.createModelReference(skill.uri.with({ path: '/review/references/late.md' }));
	contribution.dispose();
	assert.equal(delayed?.aborted, true);
	await pending.complete('late text');
	await assert.rejects(reading, /cancel/iu);
	assert.equal(services.get(IModelService).getModels().length, 0);
});
