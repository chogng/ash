import { NotificationService } from '../../../../services/notification/common/notificationService.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resetNlsResolver, setNlsMessages } from '../../../../../nls.js';
import { test } from 'mocha';
import { browserEnvironment } from '../../../../../editor/test/browser/testEditorDom.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { createCodeEditorServices } from '../../../../../editor/test/browser/testCodeEditor.js';
import { createTestEditorServices } from '../../../../test/common/testEditorServices.js';
import { ChatListWidget } from '../../browser/widget/chatListWidget.js';
import { chatTranscriptListItem, chatTranscriptListItems } from '../../browser/widget/chatListItems.js';
import type { ThreadTranscriptEntry, TurnError } from '../../../../services/chat/common/chatService.js';
import type { IChatListItem } from '../../browser/widget/chatListItems.js';
import { ILanguageService } from '../../../../../editor/common/languages/language.js';
import { CodeBlockPart } from '../../browser/widget/chatContentParts/codeBlockPart.js';
import type { URI } from '../../../../../base/common/uri.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { emptyEditorServiceState } from '../../../../test/common/testEditorService.js';
import { ChatResponseResourceFileSystemProvider, IChatResponseResourceFileSystemProvider, type IChatResourceAssociateOptions } from '../../common/widget/chatResponseResourceFileSystemProvider.js';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { IAgentThreadService } from '../../../../../platform/agentHost/common/agentService.js';
import { createDisconnectedRendererApi } from '../../../../browser/rendererApi.js';
import { ICodeEditorService } from '../../../../../editor/browser/services/codeEditorService.js';
import '../../browser/chat.shared.contribution.js';

const document = browserEnvironment.window.document;
const response: IChatListItem = { id: 'reply', type: 'agentMessage', text: 'Stable.\n\n```typescript\nconst value = 1;\n```', transient: true };
class RecordingResponseFiles extends ChatResponseResourceFileSystemProvider {
	public readonly associated: URI[] = [];
	public override associate(data: Uint8Array, options?: IChatResourceAssociateOptions) {
		const association = super.associate(data, options);
		this.associated.push(association.resource);
		return association;
	}
}

const source = { sessionId: 'session', threadId: 'thread', itemId: 'image', kind: 'item' as const };
const image = { type: 'imageAttachment' as const, detail: 'auto' as const, attachment: { contentDigest: `sha256:${'a'.repeat(64)}`, width: 2, height: 1, mediaType: 'png' as const, encodedBytes: 70 } };

function mount(resources: DisposableStore, services: ReturnType<typeof createTestEditorServices>): ChatListWidget {
	if (!services.has(IAgentThreadService)) services.registerInstance(IAgentThreadService, createDisconnectedRendererApi().thread);
	if (!services.has(IChatResponseResourceFileSystemProvider)) services.registerInstance(IChatResponseResourceFileSystemProvider, resources.add(services.createInstance(ChatResponseResourceFileSystemProvider)));
	if (!services.has(IEditorService)) services.registerInstance(IEditorService, { ...emptyEditorServiceState, openEditor: async () => { throw new Error('Unexpected media preview'); }, focusActiveEditor() { } });
	const container = document.createElement('main');
	document.body.append(container);
	resources.add(toDisposable(() => container.remove()));
	return resources.add(services.createInstance(ChatListWidget, container, {}));
}

test('response media updates independently of streamed Markdown and releases removed media', () => {
	using resources = new DisposableStore();
	const services = resources.add(createTestEditorServices(undefined, createCodeEditorServices(resources)));
	const widget = mount(resources, services);
	widget.render([response]);
	const editor = widget.element.querySelector('.stanza-editor');
	widget.render([{ ...response, content: [image], attachmentSource: source }]);
	assert.equal(widget.element.querySelectorAll('.ash-chat-media').length, 1);
	assert.equal(widget.element.querySelector('.stanza-editor'), editor);
	widget.render([{ ...response, text: response.text + '\n\nDone.', transient: false, content: [] }]);
	assert.equal(widget.element.querySelectorAll('.ash-chat-media').length, 0);
	assert.equal(widget.element.querySelector('.stanza-editor'), editor);
});

test('a response rewrite retains its existing code editor and focused action', () => {
	using resources = new DisposableStore();
	const services = resources.add(createTestEditorServices(undefined, createCodeEditorServices(resources)));
	const widget = mount(resources, services);
	widget.render([response]);
	const editor = services.get(ICodeEditorService).listCodeEditors()[0];
	const copy = widget.element.querySelector<HTMLButtonElement>('.ash-chat-code-block button')!;
	copy.focus();
	widget.render([{ ...response, text: 'Corrected.\n\n```typescript\nconst value = 2;\n```', transient: false }]);
	assert.equal(services.get(ICodeEditorService).listCodeEditors()[0], editor);
	assert.equal(document.activeElement, copy);
	assert.equal(editor.getModel()!.getValue(), 'const value = 2;');
});

test('a changed media source cancels the original read while retaining the response editor', async () => {
	using resources = new DisposableStore();
	const services = resources.add(createTestEditorServices(undefined, createCodeEditorServices(resources)));
	const pending = new DeferredPromise<{ bytes: Uint8Array; mimeType: string; }>();
	let signal: AbortSignal | undefined;
	services.registerInstance(IAgentThreadService, { ...createDisconnectedRendererApi().thread, readAttachment: async (_source, cancellation) => { signal = cancellation; return pending.p; } });
	const widget = mount(resources, services);
	widget.render([{ ...response, content: [image], attachmentSource: source }]);
	widget.element.querySelector<HTMLButtonElement>('.ash-chat-media button')!.click();
	assert.equal(signal?.aborted, false);
	const editor = widget.element.querySelector('.stanza-editor');
	widget.render([{ ...response, text: response.text + '\nMore.', content: [image], attachmentSource: { ...source, threadId: 'other-thread' } }]);
	assert.equal(signal?.aborted, true);
	assert.equal(widget.element.querySelector('.stanza-editor'), editor);
	await pending.complete({ bytes: new Uint8Array(), mimeType: 'image/png' });
	assert.equal(widget.element.querySelector('img')!.hasAttribute('src'), false);
});

test('response view state restores focus inside its code editor', () => {
	using resources = new DisposableStore();
	const services = resources.add(createTestEditorServices(undefined, createCodeEditorServices(resources)));
	const widget = mount(resources, services);
	widget.render([response]);
	services.get(ICodeEditorService).listCodeEditors()[0].focus();
	const state = widget.getViewState();
	assert.ok(state.focus);
	const restored = mount(resources, services);
	restored.restoreViewState(state, [response]);
	assert.equal(restored.element.contains(document.activeElement), true);
	assert.equal(document.activeElement!.closest('.stanza-editor') !== null, true);
});


test('clearing response media origin cancels an outstanding read and cannot fall back to the original Thread', async () => {
	using resources = new DisposableStore();
	const services = resources.add(createTestEditorServices(undefined, createCodeEditorServices(resources)));
	const pending = new DeferredPromise<{ bytes: Uint8Array; mimeType: string; }>();
	let signal: AbortSignal | undefined;
	let reads = 0;
	services.registerInstance(IAgentThreadService, { ...createDisconnectedRendererApi().thread, readAttachment: async (_source, cancellation) => { signal = cancellation; reads++; return pending.p; } });
	const widget = mount(resources, services);
	widget.render([{ ...response, content: [image], attachmentSource: source }]);
	widget.element.querySelector<HTMLButtonElement>('.ash-chat-media button')!.click();
	widget.render([{ ...response, content: [image] }]);
	assert.equal(signal?.aborted, true);
	widget.element.querySelector<HTMLButtonElement>('.ash-chat-media button')!.click();
	assert.equal(reads, 1);
	assert.match(widget.element.querySelector('figcaption')!.textContent!, /original conversation/);
	await pending.complete({ bytes: new Uint8Array(), mimeType: 'image/png' });
	assert.equal(widget.element.querySelector('img')!.hasAttribute('src'), false);
});

test('unchanged response media keeps its DOM and corrected metadata updates its caption', () => {
	using resources = new DisposableStore();
	const services = resources.add(createTestEditorServices(undefined, createCodeEditorServices(resources)));
	const widget = mount(resources, services);
	const item = { ...response, content: [image], attachmentSource: source };
	widget.render([item]);
	const media = widget.element.querySelector('.ash-chat-media')!;
	const observer = new browserEnvironment.window.MutationObserver(() => { });
	observer.observe(media.parentNode!, { childList: true });
	try {
		widget.render([{ ...item, text: response.text + '\nDone.' }]);
		assert.equal(widget.element.querySelector('.ash-chat-media'), media);
		assert.deepEqual(observer.takeRecords(), []);
		widget.render([{ ...item, content: [{ ...image, attachment: { ...image.attachment, width: 30 } }] }]);
		assert.equal(widget.element.querySelector('figcaption')!.textContent, 'Image (30 × 1)');
	} finally { observer.disconnect(); }
});

test('changing a completed code fence language retains the response document', () => {
	using resources = new DisposableStore();
	const services = resources.add(createTestEditorServices(undefined, createCodeEditorServices(resources)));
	resources.add(services.get(ILanguageService).registerLanguage({ id: 'typescript' }));
	using part = services.createInstance(CodeBlockPart, document);
	const data = { text: 'const value = 1;', languageId: 'plaintext', codeBlockIndex: 0, element: response, chatSessionResource: undefined };
	part.render(data, 300);
	const model = part.editor.getModel()!;
	part.render({ ...data, languageId: 'typescript' }, 300);
	assert.equal(part.editor.getModel(), model);
	assert.equal(model.getLanguageId(), 'typescript');
	assert.equal(model.isDisposed(), false);
});

test('corrected response resources retain disclosure identity, expansion and summary focus and retire previous bytes', async () => {
	using resources = new DisposableStore();
	const services = resources.add(createTestEditorServices(undefined, createCodeEditorServices(resources)));
	const files = resources.add(new RecordingResponseFiles());
	services.registerInstance(IChatResponseResourceFileSystemProvider, files);
	services.registerInstance(IEditorService, { ...emptyEditorServiceState, openEditor: async () => { throw new Error('Unexpected resource open'); }, focusActiveEditor() { } });
	const widget = mount(resources, services);
	const artifact = { type: 'artifact' as const, artifact: { source: { type: 'embeddedResource' as const, uri: 'mcp://resource/readme.md' }, mimeType: 'text/markdown', data: { type: 'text' as const, text: 'First version' }, contentDigest: 'first', truncated: false } };
	widget.render([{ ...response, content: [artifact] }]);
	const disclosure = widget.element.querySelector<HTMLDetailsElement>('.ash-chat-resources details')!;
	const summary = disclosure.querySelector<HTMLElement>('summary')!;
	disclosure.open = true;
	summary.focus();
	widget.render([{ ...response, content: [{ ...artifact, artifact: { ...artifact.artifact, data: { type: 'text', text: 'Corrected version' }, contentDigest: 'second' } }] }]);
	assert.equal(widget.element.querySelector('.ash-chat-resources details'), disclosure);
	assert.equal(disclosure.open, true);
	assert.equal(document.activeElement, summary);
	assert.equal(disclosure.querySelector('pre')!.textContent, 'Corrected version');
	await assert.rejects(files.readFile(files.associated[0]), /no longer available/);
	assert.equal(new TextDecoder().decode((await files.readFile(files.associated[1])).bytes), 'Corrected version');
	widget.render([response]);
	await assert.rejects(files.readFile(files.associated[1]), /no longer available/);
	assert.equal(widget.element.querySelector('.ash-chat-resources'), null);
});


test('correcting a linked resource cancels its original read and suppresses a retired origin failure', async () => {
	using resources = new DisposableStore();
	const services = resources.add(createTestEditorServices(undefined, createCodeEditorServices(resources)));
	services.registerInstance(INotificationService, resources.add(new NotificationService()));
	const pending = new DeferredPromise<{ bytes: Uint8Array; mimeType: string; }>();
	let signal: AbortSignal | undefined;
	services.registerInstance(IAgentThreadService, { ...createDisconnectedRendererApi().thread, readToolResource: async (_source, cancellation) => { signal = cancellation; return pending.p; } });
	const files = resources.add(new RecordingResponseFiles());
	services.registerInstance(IChatResponseResourceFileSystemProvider, files);
	let opens = 0;
	services.registerInstance(IEditorService, { ...emptyEditorServiceState, openEditor: async () => { opens++; }, focusActiveEditor() { } });
	const widget = mount(resources, services);
	const artifact = { type: 'artifact' as const, artifact: { source: { type: 'resourceLink' as const, uri: 'mcp://resource/readme.md' }, mimeType: 'text/markdown', data: { type: 'text' as const, text: 'Original description' }, contentDigest: 'first', truncated: false } };
	widget.render([{ ...response, content: [artifact], attachmentSource: source }]);
	widget.element.querySelector<HTMLButtonElement>('.ash-chat-resources button')!.click();
	assert.equal(signal?.aborted, false);
	widget.render([{ ...response, content: [{ ...artifact, artifact: { ...artifact.artifact, data: { type: 'text', text: 'New description' }, contentDigest: 'second' } }], attachmentSource: source }]);
	assert.equal(signal?.aborted, true);
	await pending.error(new Error('Retired origin'));
	// Flush the async action's catch handler before inspecting its visible side effects.
	await Promise.resolve();
	await Promise.resolve();
	assert.equal(opens, 0);
	assert.equal(files.associated.length, 0);
	assert.deepEqual((services.get(INotificationService) as NotificationService).model.getNotifications(), []);
});


for (const locale of ['en', 'zh-CN']) {
	test(`renderer feedback presents plan, Advisor, failures and recovery actions in ${locale} without changing provider text`, () => {
		if (locale === 'zh-CN') setNlsMessages(locale, JSON.parse(readFileSync('extensions/language-pack-zh-cn/translations/chat.json', 'utf8')));
		try {
			const plan = chatTranscriptListItem({ type: 'turnPlan', entryId: 'plan', turnId: 'turn', plan: { explanation: '说明 original', steps: [{ step: '用户步骤 original', status: 'inProgress' }] } });
			assert.equal(plan.text, locale === 'en' ? '说明 original\n\n- [ ] **In progress:** 用户步骤 original' : '说明 original\n\n- [ ] **进行中：** 用户步骤 original');
			const raw = 'Provider error <safe> 用户原文';
			const errors: readonly [TurnError['code'], string, string, string | undefined, string | undefined][] = [
				['connectionFailed', 'Model error', '模型错误', 'Try again', '重试'],
				['contextOverflow', 'Context limit', '上下文限制', 'Start new chat', '开始新聊天'],
				['providerAuth', 'Authentication', '身份验证', 'Choose another model', '选择其他模型'],
				['invalidRequest', 'Invalid request', '请求无效', 'Change approach', '改变方式'],
				['invalidResponse', 'Invalid response', '响应无效', 'Try again', '重试'],
				['completionPersistenceFailed', 'Save failed', '保存失败', 'Try again', '重试'],
				['interactionDeadlineElapsed', 'Interaction expired', '交互已过期', 'Try again', '重试'],
				['toolRepetition', 'Repeated tool failure', '工具反复失败', 'Change approach', '改变方式'],
				['usageLimited', 'Usage limit', '用量限制', 'Choose another model', '选择其他模型'],
				['worktreeCaptureFailed', 'Worktree capture failed', '工作树快照失败', 'Try again', '重试'],
			];
			for (const [code, english, chinese, actionEn, actionZh] of errors) {
				const item = chatTranscriptListItem({ type: 'turnError', entryId: code, turnId: 'turn', error: { code, message: raw, retryable: true } });
				assert.equal(item.text, raw);
				assert.equal(item.label, locale === 'en' ? english : chinese);
				assert.equal(item.action?.label, locale === 'en' ? actionEn : actionZh);
				assert.equal(item.isError, true);
			}
			const call: ThreadTranscriptEntry = { type: 'item', entryId: 'call', turnId: 'turn', transient: true, item: { type: 'toolCall', itemId: 'call', turnId: 'turn', toolCallId: 'advisor', name: 'advisor', argumentsJson: '{}' } };
			const pending = chatTranscriptListItems([call])[0];
			assert.equal(pending.text, locale === 'en' ? 'Consulting the selected model…' : '正在咨询所选模型…');
			assert.equal(pending.label, locale === 'en' ? 'Advisor' : '顾问');
			const result: ThreadTranscriptEntry = { type: 'item', entryId: 'result', turnId: 'turn', transient: false, item: { type: 'toolResult', itemId: 'result', turnId: 'turn', toolCallId: 'advisor', isError: false, text: JSON.stringify({ advice: raw, question: '问题原文', model: { provider: 'provider-I', model: 'model-Ω' }, sourceSequence: 3, usage: { inputTokens: 12 } }) } };
			const completed = chatTranscriptListItems([call, result])[0];
			assert.equal(completed.text, raw);
			assert.equal(completed.label, locale === 'en' ? 'Advisor · provider-I/model-Ω' : '顾问 · provider-I/model-Ω');
			assert.equal(completed.detail, locale === 'en' ? '问题原文 · Conversation sequence 3 · Tokens: 12 input · unknown output' : '问题原文 · 对话序号 3 · 令牌：输入 12 · 输出 未知');
			const output = chatTranscriptListItem({ type: 'toolOutput', entryId: 'orphan', turnId: 'turn', toolCallId: 'missing', stream: 'stderr', text: raw });
			assert.equal(output.label, locale === 'en' ? 'Tool stderr' : '工具标准错误');
			assert.equal(output.text, raw);
		} finally { resetNlsResolver(); }
	});
}


test('Opening a stored media row uses immutable read-only response bytes and retires the association with its source', async () => {
	using resources = new DisposableStore();
	const urls = browserEnvironment.window.URL;
	for (const key of ['createObjectURL', 'revokeObjectURL'] as const) {
		const descriptor = Object.getOwnPropertyDescriptor(urls, key);
		Object.defineProperty(urls, key, { configurable: true, value: key === 'createObjectURL' ? () => 'blob:fixture' : () => { } });
		resources.add(toDisposable(() => { if (descriptor) Object.defineProperty(urls, key, descriptor); else Reflect.deleteProperty(urls, key); }));
	}
	const services = resources.add(createTestEditorServices(undefined, createCodeEditorServices(resources)));
	const files = resources.add(new ChatResponseResourceFileSystemProvider());
	services.registerInstance(IChatResponseResourceFileSystemProvider, files);
	const data = new Uint8Array([1, 2, 3]);
	services.registerInstance(IAgentThreadService, { ...createDisconnectedRendererApi().thread, readAttachment: async () => ({ bytes: data, mimeType: 'image/png' }) });
	const opened: { resource: URI; readonly: boolean | undefined; }[] = [];
	services.registerInstance(IEditorService, { ...emptyEditorServiceState, openEditor: async input => { opened.push({ resource: input.resource, readonly: input.readOnly }); }, focusActiveEditor() { } });
	const widget = mount(resources, services);
	widget.render([{ ...response, content: [image], attachmentSource: source }]);
	widget.element.querySelector<HTMLButtonElement>('.ash-chat-media > button')!.click();
	await new Promise(resolve => setTimeout(resolve, 0));
	const open = [...widget.element.querySelectorAll<HTMLButtonElement>('.ash-chat-media > button')].find(button => button.textContent === 'Open image')!;
	assert.equal(open.hidden, false);
	open.click();
	await new Promise(resolve => setTimeout(resolve, 0));
	assert.equal(opened.length, 1);
	assert.equal(opened[0]!.readonly, true);
	assert.deepEqual((await files.readFile(opened[0]!.resource)).bytes, data);
	data.fill(0);
	assert.deepEqual((await files.readFile(opened[0]!.resource)).bytes, new Uint8Array([1, 2, 3]));
	widget.render([]);
	await assert.rejects(files.readFile(opened[0]!.resource), /no longer available/);
});
