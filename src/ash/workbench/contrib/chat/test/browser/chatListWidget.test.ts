import { expect } from '@playwright/test';
import type { IChatListItem } from '../../browser/widget/chatListItems.js';
import { useBrowserTests } from '../../../../../../../test/unit/browser/context.js';
import { createTestLanguageModelToolsService } from '../common/tools/testLanguageModelToolsService.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { BrowserClipboardService } from '../../../../../platform/clipboard/browser/clipboardService.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { registerChatCopyActions } from '../../browser/actions/chatCopyActions.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { ITextModelService } from '../../../../../editor/common/services/resolverService.js';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { IPromptsService } from '../../common/promptSyntax/service/promptsService.js';
import { PromptsService } from '../../common/promptSyntax/service/promptsServiceImpl.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { MarkdownString } from '../../../../../base/common/htmlContent.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IChatTipService } from '../../browser/chatTipService.js';
import { ChatInputTipPresenter } from '../../browser/widget/input/chatInputTipPresenter.js';
import { IChatTipService as ICoworkTipService } from '../../../../../sessions/contrib/cowork/browser/chatTipService.js';
import { ChatInputTipPresenter as CoworkTipPresenter } from '../../../../../sessions/contrib/cowork/browser/widget/input/chatInputTipPresenter.js';
import { ILanguageModelToolsService } from '../../common/tools/languageModelToolsService.js';
import { AccessibleViewRegistry } from '../../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { AccessibleViewType } from '../../../../../platform/accessibility/browser/accessibleView.js';
import { PromptLanguageFeaturesProvider } from '../../browser/promptSyntax/promptFileContributions.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { ICodeEditorService } from '../../../../../editor/browser/services/codeEditorService.js';
import {
	AccessibilitySupport,
	IAccessibilityService,
} from '../../../../../platform/accessibility/common/accessibility.js';
import { getWindows } from '../../../../../base/browser/window.js';
import { PixelRatio } from '../../../../../base/browser/pixelRatio.js';
import { FontMeasurements } from '../../../../../editor/browser/config/fontMeasurements.js';
import { BareFontInfo } from '../../../../../editor/common/config/fontInfo.js';
import { ILanguageService } from '../../../../../editor/common/languages/language.js';
import { IMarkerService, MarkerSeverity } from '../../../../../platform/markers/common/markers.js';
import { URI } from '../../../../../base/common/uri.js';
import { buildOpenSessionLinkUri } from '../../../../../platform/agentHost/common/openSessionLink.js';
import { browserEnvironment } from '../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resetNlsResolver, setNlsMessages } from '../../../../../nls.js';
import { suite, suiteSetup, test } from 'mocha';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import {
	createCodeEditorServices,
	registerCodeEditorServices,
} from '../../../../../editor/test/browser/testCodeEditor.js';
import { createTestEditorServices } from '../../../../test/common/testEditorServices.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { chatTranscriptListItems } from '../../browser/widget/chatListItems.js';
import type { ThreadTranscriptEntry } from '../../../../services/chat/common/chatService.js';
import { ChatListWidget } from '../../browser/widget/chatListWidget.js';
import '../../browser/chat.shared.contribution.js';
import { ChatEditorConfiguration, ChatInputConfiguration } from '../../common/constants.js';
import { CodeEditorConfiguration } from '../../../codeEditor/common/editorConfiguration.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';

registerChatCopyActions();
const document = browserEnvironment.window.document;

test('Chat renders connection-qualified conversation links without permitting script links', () => {
	using resources = new DisposableStore();
	const services = resources.add(createTestEditorServices(undefined, createCodeEditorServices(resources)));
	const opened: string[] = [];
	using widget = services.createInstance(ChatListWidget, document.createElement('main'), {
		onDidRequestLink: (target: string) => opened.push(target),
	});
	const link = buildOpenSessionLinkUri('session-1', 'peer-1', 'local').toString();
	widget.render([
		{
			id: 'links',
			type: 'agentMessage',
			text: `[Conversation](${link}) [Script](javascript:alert%281%29)`,
			transient: false,
		},
	]);
	const anchor = widget.element.querySelector<HTMLAnchorElement>('a[href]')!;
	assert.equal(anchor.getAttribute('href'), link);
	anchor.click();
	assert.deepEqual(opened, [link]);
	assert.equal(widget.element.querySelector('a[href^="javascript:"]'), null);
});

test('Workbench and Cowork tips use injected Markdown opening and preserve dismissal', () => {
	using resources = new DisposableStore();
	const services = resources.add(createTestEditorServices(undefined, createCodeEditorServices(resources)));
	const dismissed = resources.add(new Emitter<void>());
	let visible = true;
	const tips = {
		onDidDismissTip: dismissed.event,
		getWelcomeTip: () =>
			visible
				? { id: 'documentation', content: new MarkdownString('[Docs](https://example.com/tip)') }
				: undefined,
		dismissTip: () => {
			visible = false;
			dismissed.fire();
		},
	};
	services.registerInstance(IChatTipService, tips);
	services.registerInstance(ICoworkTipService, tips);
	const opened: string[] = [];
	services.get(IOpenerService).setDefaultExternalOpener({
		openExternal: async href => {
			opened.push(href);
			return true;
		},
	});
	const container = document.createElement('main');
	const focused: string[] = [];
	using workbench = services.createInstance(ChatInputTipPresenter, {
		container,
		isEligible: () => true,
		focusInput: () => {
			focused.push('workbench');
		},
	});
	using cowork = services.createInstance(CoworkTipPresenter, {
		container,
		isEligible: () => true,
		focusInput: () => {
			focused.push('cowork');
		},
	});
	workbench.current!.domNode.querySelector<HTMLAnchorElement>('a')!.click();
	cowork.current!.domNode.querySelector<HTMLAnchorElement>('a')!.click();
	assert.deepEqual(opened, ['https://example.com/tip', 'https://example.com/tip']);
	workbench.current!.domNode.querySelector<HTMLButtonElement>('button')!.click();
	assert.deepEqual({ children: container.childElementCount, focused }, { children: 0, focused: ['workbench'] });
});

suite('Chat hidden response resources', () => {
	suiteSetup(() => {
		// These facilities belong to the shared test window, beyond a single widget's lifetime.
		getWindows();
		const window = browserEnvironment.window as unknown as Window;
		PixelRatio.getInstance(window);
		FontMeasurements.readFontInfo(
			window,
			BareFontInfo._create('monospace', 'normal', 14, 'normal', 'normal', 20, 0, 1, true),
		);
	});
	ensureNoDisposablesAreLeakedInTestSuite();
	test('hidden response code blocks release documents and restore selection with current content', () => {
		using resources = new DisposableStore();
		const services = resources.add(createTestEditorServices(undefined, createCodeEditorServices(resources)));
		services.registerInstance(IAccessibilityService, {
			onDidChangeScreenReaderOptimized: Event.None,
			onDidChangeReducedMotion: Event.None,
			onDidChangeReducedTransparency: Event.None,
			onDidChangeLinkUnderlines: Event.None,
			alwaysUnderlineAccessKeys: async () => false,
			isScreenReaderOptimized: () => false,
			isMotionReduced: () => false,
			isTransparencyReduced: () => false,
			getAccessibilitySupport: () => AccessibilitySupport.Disabled,
			setAccessibilitySupport: () => {},
			alert: () => {},
			status: () => {},
		});
		using widget = services.createInstance(ChatListWidget, document.createElement('main'), {});
		const items = (value: number) => [
			{
				id: 'reply',
				type: 'agentMessage' as const,
				text: `\`\`\`ts\nconst value = ${value};\n\`\`\``,
				transient: false,
			},
		];
		widget.render(items(1));
		const block = widget.element.querySelector('.ash-chat-code-block');
		const editor = services
			.get(ICodeEditorService)
			.listCodeEditors()
			.find(candidate => candidate.getModel()?.getValue() === 'const value = 1;')!;
		assert.ok(editor);
		const original = editor.getModel()!;
		editor.setSelection({ startLineNumber: 1, startColumn: 7, endLineNumber: 1, endColumn: 12 });
		const selection = editor.getSelections();
		widget.setVisible(false);
		assert.equal(editor.getModel(), null);
		assert.equal(original.isDisposed(), true);
		widget.render(items(2));
		assert.equal(editor.getModel(), null, 'Hidden streaming updates must not recreate editor documents');
		assert.equal(widget.element.querySelector('.ash-chat-code-block'), block);
		widget.setVisible(true);
		assert.equal(editor.getModel()?.getValue(), 'const value = 2;');
		assert.notEqual(editor.getModel(), original);
		assert.deepEqual(editor.getSelections(), selection);
		widget.setVisible(false);
		widget.setVisible(true);
		assert.deepEqual(editor.getSelections(), selection);
	});
});

test('code blocks inherit editor typography, retain their nodes on updates, and reset independently of message input', async () => {
	using resources = new DisposableStore();
	const services = resources.add(createTestEditorServices(undefined, createCodeEditorServices(resources)));
	const configuration = services.get(IConfigurationService);
	await configuration.updateValue(CodeEditorConfiguration.fontFamily, 'Fira Code');
	await configuration.updateValue(CodeEditorConfiguration.fontSize, 16);
	await configuration.updateValue(CodeEditorConfiguration.lineHeight, 25);
	using widget = services.createInstance(ChatListWidget, document.createElement('main'), {});
	widget.render([
		{
			id: 'reply',
			type: 'agentMessage',
			text: 'Text with `inline code`.\n\n```ts\nconst value = 1;\n```',
			transient: false,
		},
	]);
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
	] as const)
		await assert.rejects(configuration.updateValue(key, value));
	assert.deepEqual(
		Object.values(ChatEditorConfiguration).map(key => configuration.getValue(key)),
		['', 0, 0, 'off'],
	);
});

test('tool evidence is Turn-scoped and keeps result-before-call and orphan output', () => {
	const call = (turnId: string): ThreadTranscriptEntry => ({
		type: 'item',
		entryId: `call:${turnId}`,
		turnId,
		transient: false,
		item: {
			type: 'toolCall',
			itemId: `call:${turnId}`,
			turnId,
			toolCallId: 'reused',
			name: 'read',
			argumentsJson: '{}',
		},
	});
	const result: ThreadTranscriptEntry = {
		type: 'item',
		entryId: 'result',
		turnId: 'first',
		transient: false,
		item: {
			type: 'toolResult',
			itemId: 'result',
			turnId: 'first',
			toolCallId: 'reused',
			text: 'first result',
			isError: false,
		},
	};
	const output: ThreadTranscriptEntry = {
		type: 'toolOutput',
		entryId: 'output',
		turnId: 'second',
		toolCallId: 'reused',
		stream: 'stdout',
		text: 'second output',
	};
	const orphan: ThreadTranscriptEntry = {
		type: 'toolOutput',
		entryId: 'orphan',
		turnId: 'third',
		toolCallId: 'missing',
		stream: 'stderr',
		text: 'orphan output',
	};
	const items = chatTranscriptListItems([result, call('first'), output, call('second'), orphan]);
	assert.deepEqual(
		items.map(item => item.id),
		['call:first', 'call:second', 'orphan'],
	);
	assert.equal(items[0].toolInvocation?.result?.text, 'first result');
	assert.deepEqual(items[0].toolInvocation?.output, []);
	assert.equal(items[1].toolInvocation?.result, undefined);
	assert.deepEqual(items[1].toolInvocation?.output, [output]);
	assert.equal(items[2].text, 'orphan output');
	assert.equal(chatTranscriptListItems([result])[0].text, 'first result');
	const stopped = chatTranscriptListItems([
		call('second'),
		{
			type: 'turnError',
			entryId: 'error',
			turnId: 'second',
			error: { code: 'connectionFailed', message: 'lost', retryable: true },
		},
	]);
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
	const entries: ThreadTranscriptEntry[] = [
		{
			type: 'item',
			entryId: 'call',
			turnId: 'turn',
			transient: false,
			item: {
				type: 'toolCall',
				itemId: 'call',
				turnId: 'turn',
				toolCallId: 'tool',
				name: 'shell',
				argumentsJson: '{}',
			},
		},
	];
	widget.render(chatTranscriptListItems(entries));
	const disclosure = widget.element.querySelector<HTMLDetailsElement>('details')!;
	const summary = disclosure.querySelector<HTMLElement>('summary')!;
	assert.equal(disclosure.open, false);
	disclosure.open = true;
	summary.focus();
	entries.push({
		type: 'toolOutput',
		entryId: 'stdout',
		turnId: 'turn',
		toolCallId: 'tool',
		stream: 'stdout',
		text: '<img src=x onerror=alert(1)>',
	});
	widget.render(chatTranscriptListItems(entries));
	assert.equal(widget.element.querySelector('details'), disclosure);
	assert.equal(disclosure.open, true);
	assert.equal(document.activeElement, summary);
	assert.equal(disclosure.querySelector('img'), null);
	assert.match(disclosure.textContent!, /Standard output\n<img/);
	entries.push({
		type: 'item',
		entryId: 'result',
		turnId: 'turn',
		transient: false,
		item: {
			type: 'toolResult',
			itemId: 'result',
			turnId: 'turn',
			toolCallId: 'tool',
			text: 'rejected',
			isError: true,
		},
	});
	widget.render(chatTranscriptListItems(entries));
	assert.equal(summary.textContent, 'shell · Failed');
	assert.equal(disclosure.classList.contains('error'), true);
	assert.equal(document.activeElement, summary);
	const provider = services.invokeFunction(accessor =>
		AccessibleViewRegistry.getImplementations()
			.filter(
				implementation =>
					implementation.type === AccessibleViewType.View &&
					implementation.name.startsWith('chatTranscript-'),
			)
			.map(implementation => implementation.getProvider(accessor))
			.find(provider => provider !== undefined)!,
	);
	assert.match(provider.provideContent(), /Standard output\n<img/);
	provider.dispose();
	assert.equal(document.activeElement, summary);
	const help = services.invokeFunction(accessor =>
		AccessibleViewRegistry.getImplementations()
			.filter(
				implementation =>
					implementation.type === AccessibleViewType.Help &&
					implementation.name.startsWith('chatTranscript-'),
			)
			.map(implementation => implementation.getProvider(accessor))
			.find(provider => provider !== undefined)!,
	);
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
		widget.render(
			chatTranscriptListItems([
				{
					type: 'item',
					entryId: 'call',
					turnId: 'turn',
					transient: false,
					item: {
						type: 'toolCall',
						itemId: 'call',
						turnId: 'turn',
						toolCallId: 'read',
						name: 'read',
						argumentsJson: '{}',
					},
				},
			]),
		);
		assert.equal(widget.element.querySelector('summary')!.textContent, 'read · 等待结果');
		assert.match(widget.element.textContent!, /输入\n\{\}/);
		assert.equal(widget.element.querySelector('[role="log"]')!.getAttribute('aria-label'), '聊天记录');
	} finally {
		resetNlsResolver();
	}
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
	widget.render([
		{ id: 'reply', type: 'agentMessage', text: `${text}\nconst b = 2;\n\x60\x60\x60\n\nDone.`, transient: false },
	]);
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
	markers.changeOne('other', uri, [
		{
			startLineNumber: 1,
			startColumn: 1,
			endLineNumber: 1,
			endColumn: 2,
			severity: MarkerSeverity.Warning,
			message: 'existing',
		},
	]);
	services.registerSingleton(ILanguageModelToolsService, () =>
		createTestLanguageModelToolsService({
			isAvailable: true,
			read: async () => ({
				tools: [
					{
						name: 'read_file',
						description: 'Read authorized files',
						source: 'local',
						sourceDetails: ['Ash'],
						exposure: 'direct',
						authority: 'directoryRead',
					},
					{
						name: 'internal_tool',
						description: 'Internal',
						source: 'local',
						sourceDetails: [],
						exposure: 'hidden',
						authority: 'providerDefined',
					},
				],
				sourceGroups: [],
			}),
		}),
	);
	services.registerInstance(
		IPromptsService,
		resources.add(
			new PromptsService(
				{
					onDidChangeSkills: Event.None,
					list: async () => ({ generation: 1, skills: [] }),
					read: async () => ({ revision: 0, catalog: { generation: 1, skills: [] }, diagnostics: [] }),
					registerSource: async () => {
						throw new Error('Unexpected skill source registration');
					},
					setEnabled: async () => {},
					readTextResource: async () => {
						throw new Error('No discovered Skill');
					},
				},
				{
					onDidChangeHooks: Event.None,
					list: async () => {
						throw new Error('Unexpected Hook read in Skill fixture');
					},
				},
			),
		),
	);
	using contribution = services.createInstance(PromptLanguageFeaturesProvider);
	assert.deepEqual(
		markers.read({ resource: uri, owner: PromptLanguageFeaturesProvider.ID }).map(marker => marker.code),
		['requiredField'],
	);
	model.setValue('---\nname: review\ndescription: Review changes\n---');
	await new Promise(resolve => setTimeout(resolve, 150));
	assert.equal(markers.read({ resource: uri, owner: PromptLanguageFeaturesProvider.ID }).length, 0);
	model.setValue('---\nname: review\n---');
	model.setLanguage('plaintext');
	await new Promise(resolve => setTimeout(resolve, 150));
	assert.equal(markers.read({ resource: uri, owner: PromptLanguageFeaturesProvider.ID }).length, 0);
	model.setLanguage('markdown');
	assert.equal(markers.read({ resource: uri, owner: PromptLanguageFeaturesProvider.ID }).length, 1);
	contribution.dispose();
	assert.equal(markers.read({ resource: uri, owner: PromptLanguageFeaturesProvider.ID }).length, 0);
	assert.equal(markers.read({ resource: uri, owner: 'other' }).length, 1);
});

test('streamed memory references retain their buttons, code editor and focus as new references arrive', () => {
	using resources = new DisposableStore();
	const services = resources.add(createTestEditorServices(undefined, createCodeEditorServices(resources)));
	const opened: string[] = [];
	using widget = services.createInstance(ChatListWidget, document.createElement('main'), {
		onDidRequestMemoryReference: (value: string) => opened.push(value),
	});
	document.body.append(widget.element);
	resources.add(toDisposable(() => widget.element.remove()));
	const text = 'memory:first\n\n```ts\nconst a = 1;\n```';
	widget.render([{ id: 'reply', type: 'agentMessage', text, transient: true }]);
	const code = widget.element.querySelector('.ash-chat-code-block')!;
	const button = [...widget.element.querySelectorAll('button')].find(
		button => button.textContent === 'Open memory reference 1',
	)!;
	button.focus();
	widget.render([{ id: 'reply', type: 'agentMessage', text: text + '\n\nmemory:second', transient: false }]);
	assert.equal(widget.element.querySelector('.ash-chat-code-block'), code);
	assert.equal(document.activeElement, button);
	button.click();
	const second = [...widget.element.querySelectorAll('button')].find(
		button => button.textContent === 'Open memory reference 2',
	)!;
	second.click();
	assert.deepEqual(opened, ['memory:first', 'memory:second']);
	widget.render([]);
	button.click();
	assert.deepEqual(opened, ['memory:first', 'memory:second']);
});

test('Skill resource content provider shares readonly models and cancels a late resource on removal', async () => {
	using resources = new DisposableStore();
	const services = resources.add(createTestEditorServices());
	services.registerSingleton(ILanguageModelToolsService, () =>
		createTestLanguageModelToolsService({
			isAvailable: false,
			read: async () => {
				throw new Error('Unexpected capabilities read');
			},
		}),
	);
	registerCodeEditorServices(services);
	resources.add(services.get(ILanguageService).registerLanguage({ id: 'markdown', extensions: ['.md'] }));
	const pending = new DeferredPromise<string>();
	let delayed: AbortSignal | undefined;
	const calls: unknown[] = [];
	const prompts = resources.add(
		new PromptsService(
			{
				onDidChangeSkills: Event.None,
				list: async () => ({
					generation: 1,
					skills: [
						{
							id: { source: 'user:review', name: 'review' },
							description: 'Review',
							contentDigest: `sha256:${'a'.repeat(64)}`,
							enabled: true,
							compatible: true,
						},
					],
				}),
				read: async () => {
					throw new Error('Unexpected management read');
				},
				registerSource: async () => {
					throw new Error('Unexpected skill source registration');
				},
				setEnabled: async () => {},
				readTextResource: async (reference, path, signal, sessionId) => {
					calls.push([reference, path, sessionId]);
					if (path === 'references/late.md') {
						delayed = signal;
						return pending.p;
					}
					return path === 'SKILL.md'
						? '---\nname: review\ndescription: Review changes\n---\n[Guide](references/guide.md)'
						: 'Read the guide.';
				},
			},
			{
				onDidChangeHooks: Event.None,
				list: async () => {
					throw new Error('Unexpected Hook read in Skill fixture');
				},
			},
		),
	);
	services.registerInstance(IPromptsService, prompts);
	using contribution = services.createInstance(PromptLanguageFeaturesProvider);
	const [skill] = await prompts.findAgentSkills(CancellationToken.None, 'session');
	const resolver = services.get(ITextModelService);
	const [first, second] = await Promise.all([
		resolver.createModelReference(skill.uri),
		resolver.createModelReference(skill.uri),
	]);
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

for (const classPrefix of ['ash-chat', 'ash-cowork']) {
	test(`${classPrefix} shows exact accepted context as inert text and preserves its disclosure and focus`, () => {
		using resources = new DisposableStore();
		const services = resources.add(createTestEditorServices(undefined, createCodeEditorServices(resources)));
		const container = document.createElement('main');
		document.body.append(container);
		resources.add(toDisposable(() => container.remove()));
		using widget = services.createInstance(ChatListWidget, container, { classPrefix });
		const items = (content: string) =>
			chatTranscriptListItems([
				{
					type: 'item',
					entryId: 'context',
					turnId: 'turn',
					transient: false,
					item: { type: 'userContext', itemId: 'context', turnId: 'turn', name: 'Context name', content },
				},
			]);
		widget.render(items('<img src=x onerror=alert(1)>\nOriginal text'));
		const disclosure = widget.element.querySelector<HTMLDetailsElement>('.ash-chat-context')!;
		const summary = disclosure.querySelector<HTMLElement>('summary')!;
		const body = disclosure.querySelector<HTMLElement>('pre')!;
		assert.equal(disclosure.open, false);
		assert.equal(summary.textContent, 'Context name');
		assert.equal(body.querySelector('img'), null);
		disclosure.open = true;
		body.focus();
		widget.render(items('Updated exact body'));
		assert.equal(widget.element.querySelector('.ash-chat-context'), disclosure);
		assert.equal(disclosure.open, true);
		assert.equal(document.activeElement, body);
		assert.equal(body.textContent, 'Updated exact body');
		const state = widget.getViewState();
		disclosure.open = false;
		widget.restoreViewState(state, items('Updated exact body'));
		assert.equal(disclosure.open, true);
		assert.equal(document.activeElement, body);
		const provider = resources.add(
			services.invokeFunction(accessor =>
				AccessibleViewRegistry.getImplementations()
					.filter(
						implementation =>
							implementation.type === AccessibleViewType.View &&
							implementation.name.startsWith('chatTranscript-'),
					)
					.map(implementation => implementation.getProvider(accessor))
					.find(candidate => candidate !== undefined)!,
			),
		);
		assert.match(provider.provideContent(), /Context name\n\nUpdated exact body/);
		widget.render([]);
		assert.equal(body.isConnected, false);
	});
}

suite('Chat message copy ownership', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('the actual row command copies current raw text and releases feedback after removal', async () => {
		using resources = new DisposableStore();
		const parent = resources.add(new InstantiationService());
		const entered = new DeferredPromise<string>();
		const completed = new DeferredPromise<void>();
		let writes = 0;
		const clipboard = resources.add(
			new (class extends BrowserClipboardService {
				constructor() {
					super(undefined);
				}
				public override async writeText(text: string): Promise<void> {
					writes++;
					await entered.complete(text);
					await completed.p;
				}
			})(),
		);
		parent.registerInstance(IClipboardService, clipboard);
		const services = createCodeEditorServices(resources, parent);
		using widget = services.createInstance(ChatListWidget, document.createElement('main'), {});
		document.body.append(widget.element);
		widget.setVisible(true);
		widget.render([{ id: 'response', type: 'agentMessage', text: '**first**', transient: true }]);
		widget.render([
			{
				id: 'response',
				type: 'agentMessage',
				text: '**first** and second\n\n[link](https://example.com)',
				transient: false,
			},
		]);
		const button = widget.element.querySelector<HTMLButtonElement>('.ash-chat-message-actions button')!;
		button.click();
		assert.equal(await entered.p, '**first** and second\n\n[link](https://example.com)');
		button.click();
		assert.equal(writes, 1);
		widget.render([]);
		await completed.complete();
		await Promise.resolve();
		assert.equal(button.isConnected, false);
		assert.equal(widget.element.querySelectorAll('.ash-chat-message-actions').length, 0);
		button.click();
		assert.equal(writes, 1);
		widget.element.remove();
	});
});

test('message editing uses the accepted backend request identity and excludes steering and transient messages', () => {
	const initial = {
		type: 'userMessage' as const,
		itemId: 'backend-initial',
		turnId: 'turn',
		text: 'Initial request',
	};
	const steering = { ...initial, itemId: 'backend-steering', text: 'Later steering' };
	const entries: ThreadTranscriptEntry[] = [
		{ type: 'item', entryId: 'presentation-initial', turnId: 'turn', transient: false, item: initial },
		{ type: 'item', entryId: 'presentation-steering', turnId: 'turn', transient: false, item: steering },
		{ type: 'item', entryId: 'presentation-transient', turnId: 'turn', transient: true, item: initial },
	];
	const total = { reported: 0, complete: true };
	const turn: import('../../../../services/chat/common/chatService.js').Turn = {
		turnId: 'turn',
		kind: 'coding',
		status: 'completed',
		mode: 'agent',
		approvalMode: 'manual',
		items: [initial, steering],
		usage: {
			modelInvocations: 0,
			inputTokens: total,
			outputTokens: total,
			cachedInputTokens: total,
			cacheWriteInputTokens: total,
			reasoningTokens: total,
		},
	};
	const items = chatTranscriptListItems(entries, 'turn', [turn], { sessionId: 'session', threadId: 'thread' });
	assert.deepEqual(
		items.map(item => ({ id: item.id, source: item.requestSource })),
		[
			{
				id: 'presentation-initial',
				source: { sessionId: 'session', threadId: 'thread', turnId: 'turn', itemId: 'backend-initial' },
			},
			{ id: 'presentation-steering', source: undefined },
			{ id: 'presentation-transient', source: undefined },
		],
	);
});

suite('chatRenderer browser component', () => {
	const browserTests = useBrowserTests();
	const code = '```typescript\nconst value = 1;\n```';
	const image = {
		type: 'imageAttachment' as const,
		detail: 'auto' as const,
		attachment: {
			contentDigest: `sha256:${'a'.repeat(64)}`,
			mediaType: 'png' as const,
			encodedBytes: 70,
			width: 2,
			height: 1,
		},
	};
	const source = { sessionId: 'session', threadId: 'thread', itemId: 'image', kind: 'item' as const };
	const rows: readonly IChatListItem[] = [
		{
			id: 'media',
			type: 'agentMessage',
			text: 'Delayed media.',
			content: [image],
			attachmentSource: source,
			transient: false,
		},
		...Array.from({ length: 12 }, (_, index): IChatListItem => ({
			id: `reading-${index}`,
			type: 'agentMessage',
			text:
				`Section ${index}.\n\n` +
				Array.from({ length: 4 }, (_, line) => `Paragraph ${index}.${line}.`).join('\n\n'),
			transient: false,
		})),
	];

	test('streaming a new response leaves unchanged history DOM untouched', async function () {
		const { page } = browserTests;
		await page.goto('/chatTranscript.html');
		const items: IChatListItem[] = [
			{ id: 'history', type: 'agentMessage', text: 'A completed **response**.', transient: false },
			{ id: 'stream', type: 'agentMessage', text: 'Starting', transient: true },
		];
		await page.evaluate(items => window.ashChatTranscriptIntegration.renderItems(items), items);
		const changes = await page.evaluate(async items => {
			const history = document.querySelector('[data-item-id="history"]')!;
			const records: MutationRecord[] = [];
			const observer = new MutationObserver(value => records.push(...value));
			observer.observe(history, { attributes: true, childList: true, characterData: true, subtree: true });
			try {
				for (let index = 0; index < 20; index++) {
					window.ashChatTranscriptIntegration.renderItems([
						items[0],
						{ ...items[1], text: `Increment ${index}` },
					]);
				}
				await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
				return records.length;
			} finally {
				observer.disconnect();
			}
		}, items);
		expect(changes).toBe(0);
		await expect(page.locator('[data-item-id="stream"]')).toContainText('Increment 19');
		await page.evaluate(
			items =>
				window.ashChatTranscriptIntegration.renderItems([
					items[0],
					{ ...items[1], text: 'Now with code.\n\n```typescript\nconst added = 19;\n```' },
				]),
			items,
		);
		await expect(page.locator('[data-item-id="stream"] .ash-chat-code-block')).toContainText('const added = 19;');
	});

	test('hidden transcript coalesces short responses until it is shown', async function () {
		const { page } = browserTests;
		await page.goto('/chatTranscript.html');
		await page.evaluate(() => {
			window.ashChatTranscriptIntegration.renderItems([
				{ id: 'reply', type: 'agentMessage', text: 'Before hiding', transient: true },
			]);
			window.ashChatTranscriptIntegration.setTranscriptVisible(false);
		});
		const changes = await page.evaluate(async () => {
			const root = document.querySelector('.ash-chat-list-widget')!;
			const records: MutationRecord[] = [];
			const observer = new MutationObserver(value => records.push(...value));
			observer.observe(root, { childList: true, characterData: true, subtree: true });
			try {
				for (let index = 0; index < 20; index++) {
					window.ashChatTranscriptIntegration.renderItems([
						{ id: 'reply', type: 'agentMessage', text: `Hidden ${index}`, transient: index < 19 },
					]);
				}
				await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
				return records.length;
			} finally {
				observer.disconnect();
			}
		});
		expect(changes).toBe(0);
		await page.evaluate(() => window.ashChatTranscriptIntegration.setTranscriptVisible(true));
		await expect(page.locator('[data-item-id="reply"]')).toContainText('Hidden 19');
		await expect(page.locator('[data-item-id="reply"]')).not.toHaveAttribute('data-transient');
	});

	test('long transcripts release offscreen code models and preserve focused code and text', async function () {
		const { page } = browserTests;
		await page.goto('/chatTranscript.html');
		const items = Array.from({ length: 60 }, (_, index): IChatListItem => ({
			id: `code-${index}`,
			type: 'agentMessage',
			transient: false,
			text: `Section ${index}.\n\n\`\`\`typescript\n${Array.from({ length: 30 }, (_, line) => `const value_${index}_${line} = ${line};`).join('\n')}\n\`\`\``,
		}));
		const firstFrameModels = await page.evaluate(async items => {
			window.ashChatTranscriptIntegration.renderItems(items);
			await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
			return window.ashChatTranscriptIntegration.state().codeModelCount;
		}, items);
		// Allocating every document and releasing it in the observer callback still
		// raises the renderer's high-water mark on every session reconstruction.
		expect(firstFrameModels).toBeLessThan(12);
		await expect(page.locator('article[data-item-id]')).toHaveCount(60);
		await expect
			.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.state().codeModelCount))
			.toBeLessThan(12);
		const viewport = page.locator('.ash-chat-list-widget .ash-scrollbar-viewport');
		await viewport.evaluate(element => {
			element.scrollTop = 0;
		});
		const first = page.locator('[data-item-id="code-0"] .stanza-editor-input');
		await first.focus();
		await first.press('ControlOrMeta+A');
		const selection = await page.evaluate(() => window.ashChatTranscriptIntegration.state().selection);
		await viewport.evaluate(element => {
			element.scrollTop = element.scrollHeight;
		});
		await expect(first).toBeFocused();
		await expect
			.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.state().codeModelCount))
			.toBeLessThan(12);
		expect(await page.evaluate(() => window.ashChatTranscriptIntegration.state().selection)).toEqual(selection);
		await viewport.evaluate(element => {
			element.scrollTop = 0;
		});
		await expect(page.locator('[data-item-id="code-0"]')).toContainText('Section 0.');
		expect(await page.evaluate(() => window.ashChatTranscriptIntegration.state().selection)).toEqual(selection);
		await page.evaluate(() => window.ashChatTranscriptIntegration.renderItems([]));
		expect(await page.evaluate(() => window.ashChatTranscriptIntegration.state().codeModelCount)).toBe(0);
	});

	test('provider corrections preserve the reading position while retaining a selected code editor and focused action', async function () {
		const { page } = browserTests;

		await page.setViewportSize({ width: 1440, height: 900 });
		await page.goto('/chatTranscript.html');
		await page.evaluate(() => {
			// The product mounts the transcript in a column with a retained composer below it.
			const host = document.querySelector('.ash-chat-list-widget')!.parentElement!;
			host.classList.add('ash-chat');
			host.style.cssText = 'display:flex;flex-direction:column;width:916px;height:650px';
			const composer = document.createElement('div');
			composer.style.cssText = 'flex:0 0 220px';
			host.append(composer);
		});
		const paragraphs = Array.from(
			{ length: 32 },
			(_, index) => `Response section ${index}. ${'Synthetic reading content. '.repeat(8)}`,
		).join('\n\n');
		const response: IChatListItem = { id: 'reply', type: 'agentMessage', text: code, transient: true };
		const pendingMedia: IChatListItem = {
			id: 'media',
			type: 'agentMessage',
			text: 'Synthetic media is being prepared.',
			transient: true,
		};
		await page.evaluate(items => window.ashChatTranscriptIntegration.renderItems(items), [pendingMedia, response]);
		const block = page.locator('[data-item-id="reply"] .ash-chat-code-block');
		const editor = block.locator('.stanza-editor');
		const original = await editor.elementHandle();
		await block.locator('.stanza-editor-input').focus();
		await page.keyboard.press('ControlOrMeta+A');
		const selection = () =>
			block.locator('.stanza-editor-input').evaluate(element => {
				const context = (
					element as HTMLElement & { editContext?: { selectionStart: number; selectionEnd: number } }
				).editContext;
				const input = element as HTMLTextAreaElement;
				return context
					? { start: context.selectionStart, end: context.selectionEnd }
					: { start: input.selectionStart, end: input.selectionEnd };
			});
		const selected = await selection();
		expect(selected).toEqual({ start: 0, end: 'const value = 1;'.length });
		const copy = block.getByRole('button', { name: 'Copy', exact: true });
		await copy.focus();
		const viewport = page.locator('.ash-chat-list-widget .ash-scrollbar-viewport');
		await viewport.evaluate(element => {
			element.scrollTop = element.scrollHeight;
		});
		const streamed = { ...response, text: code + '\n\n' + paragraphs };
		await page.evaluate(items => window.ashChatTranscriptIntegration.renderItems(items), [pendingMedia, streamed]);
		await expect(page.locator('[data-item-id="reply"]')).toContainText('Response section 31.');
		await expect
			.poll(() => viewport.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight))
			.toBe(0);
		expect(await selection()).toEqual(selected);
		await expect(copy).toBeFocused();
		const paragraph = page.locator('[data-item-id="reply"] p').filter({ hasText: /^Response section 12\./u });
		await viewport.evaluate(
			(element, target) => {
				element.scrollTop += target!.getBoundingClientRect().top - element.getBoundingClientRect().top + 20;
			},
			await paragraph.elementHandle(),
		);
		await expect
			.poll(() => viewport.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight))
			.toBeGreaterThan(100);
		const top = await paragraph.evaluate(element => element.getBoundingClientRect().top);
		const png = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADklEQVR4nGP4z8DwHwQBEPgD/U6VwW8AAAAASUVORK5CYII=';
		const media = {
			...pendingMedia,
			text: `Synthetic media is ready.\n\n![Synthetic response media](data:image/png;base64,${png}|width=320,height=320)`,
			transient: false,
		};
		await page.evaluate(items => window.ashChatTranscriptIntegration.renderItems(items), [media, streamed]);
		await page.evaluate(
			items => window.ashChatTranscriptIntegration.renderItems(items),
			[media, { ...streamed, text: streamed.text.replace('= 1', '= 2'), transient: false }],
		);
		await expect
			.poll(() =>
				page
					.getByRole('img', { name: 'Synthetic response media', exact: true })
					.evaluate(element => (element as HTMLImageElement).naturalWidth),
			)
			.toBe(2);
		await expect(block.locator('.view-lines')).toContainText('const value = 2;');
		await expect
			.poll(async () =>
				Math.abs((await paragraph.evaluate(element => element.getBoundingClientRect().top)) - top),
			)
			.toBeLessThanOrEqual(1);
		expect(
			await viewport.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight),
		).toBeGreaterThan(100);
		expect(await editor.evaluate((element, previous) => element === previous, original)).toBe(true);
		expect(await selection()).toEqual(selected);
		await expect(copy).toBeFocused();
		await original?.dispose();
	});

	for (const locale of ['en', 'zh-CN']) {
		test(`provider corrections retain code selections, keyboard focus and updated copy text in ${locale}`, async function () {
			const { page } = browserTests;

			const errors: string[] = [];
			page.on('pageerror', error => errors.push(error.message));
			await page.goto(`/chatTranscript.html?locale=${locale}`);
			await page.evaluate(
				text => window.ashChatTranscriptIntegration.stream(text, false),
				`Original.\n\n${code}`,
			);
			const block = page.locator('[data-item-id="stream"] .ash-chat-code-block');
			const editor = block.locator('.stanza-editor');
			const original = await editor.elementHandle();
			await editor.click();
			await page.keyboard.press('ControlOrMeta+A');
			const selection = await page.evaluate(() => window.ashChatTranscriptIntegration.state().selection);
			const copy = block.getByRole('button', { name: locale === 'en' ? 'Copy' : '复制', exact: true });
			await copy.focus();
			await expect(copy).toBeFocused();
			await page.evaluate(
				text => window.ashChatTranscriptIntegration.stream(text, true),
				`Correction.\n\n${code.replace('= 1', '= 2')}`,
			);
			expect(await editor.evaluate((element, previous) => element === previous, original)).toBe(true);
			await expect(copy).toBeFocused();
			expect(await page.evaluate(() => window.ashChatTranscriptIntegration.state().selection)).toEqual(selection);
			await copy.press('Enter');
			await expect
				.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.state().copied))
				.toBe('const value = 2;');
			await page.evaluate(() => window.ashChatTranscriptIntegration.remove());
			expect(await page.evaluate(() => window.ashChatTranscriptIntegration.state().editorCount)).toBe(1);
			await original?.dispose();
			expect(errors).toEqual([]);
		});
	}

	test('provider corrections retain selected paragraphs when inserting an earlier block', async function () {
		const { page } = browserTests;

		await page.goto('/chatTranscript.html');
		const originalText = 'Selected paragraph.\n\nTail.';
		await page.evaluate(text => window.ashChatTranscriptIntegration.stream(text, false), originalText);
		const paragraph = page.locator('[data-item-id="stream"] p').first();
		const original = await paragraph.elementHandle();
		await paragraph.evaluate(element => {
			const range = document.createRange();
			range.selectNodeContents(element);
			const selection = document.getSelection()!;
			selection.removeAllRanges();
			selection.addRange(range);
		});
		await page.evaluate(
			text => window.ashChatTranscriptIntegration.stream(text, true),
			`Inserted explanation.\n\n${originalText}`,
		);
		const selected = page.locator('[data-item-id="stream"] p').nth(1);
		expect(await selected.evaluate((element, previous) => element === previous, original)).toBe(true);
		expect(await page.evaluate(() => document.getSelection()!.toString())).toBe('Selected paragraph.');
		await original?.dispose();
	});

	test('streamed media appears and disappears without replacing the response code editor', async function () {
		const { page } = browserTests;

		await page.goto('/chatTranscript.html');
		const item: IChatListItem = { id: 'reply', type: 'agentMessage', text: code, transient: true };
		await page.evaluate(item => window.ashChatTranscriptIntegration.renderItems([item]), item);
		const editor = page.locator('.ash-chat-code-block .stanza-editor');
		const original = await editor.elementHandle();
		await page.evaluate(item => window.ashChatTranscriptIntegration.renderItems([item]), {
			...item,
			content: [image],
			attachmentSource: source,
		});
		const media = page.locator('.ash-chat-media');
		await expect(media).toBeVisible();
		await media.getByRole('button', { name: 'Load image', exact: true }).click();
		await expect
			.poll(() => media.locator('img').evaluate(element => (element as HTMLImageElement).naturalWidth))
			.toBe(2);
		await page.evaluate(
			item =>
				window.ashChatTranscriptIntegration.renderItems([
					{ ...item, text: item.text + '\n\nDone.', transient: false },
				]),
			item,
		);
		await expect(media).toHaveCount(0);
		expect(await editor.evaluate((element, previous) => element === previous, original)).toBe(true);
		await original?.dispose();
	});

	test('delayed media above the reader preserves the visible message position', async function () {
		const { page } = browserTests;

		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto('/chatTranscript.html');
		await page.evaluate(rows => {
			window.ashChatTranscriptIntegration.delayAttachments(true);
			window.ashChatTranscriptIntegration.renderItems(rows);
		}, rows);
		const viewport = page.locator('.ash-chat-list-widget .ash-scrollbar-viewport');
		await page.locator('.ash-chat-media img').evaluate(element => {
			element.style.width = '300px';
			element.style.height = '400px';
		});
		await viewport.evaluate(element => {
			const target = document.querySelector('[data-item-id="reading-4"]')!;
			element.scrollTop += target.getBoundingClientRect().top - element.getBoundingClientRect().top + 20;
		});
		await expect
			.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.readingState().shouldFollow))
			.toBe(false);
		const position = () =>
			page.locator('[data-item-id="reading-4"]').evaluate(element => element.getBoundingClientRect().top);
		const top = await position();
		const before = await viewport.evaluate(element => element.scrollTop);
		await page
			.locator('.ash-chat-media')
			.getByRole('button', { name: 'Load image', exact: true })
			.evaluate(element => (element as HTMLButtonElement).click());
		await expect
			.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.mediaState().requests.length))
			.toBe(1);
		await page.evaluate(() => window.ashChatTranscriptIntegration.finishMedia());
		await expect
			.poll(() =>
				page.locator('.ash-chat-media img').evaluate(element => (element as HTMLImageElement).naturalWidth),
			)
			.toBe(2);
		await expect.poll(position).toBe(top);
		expect(await viewport.evaluate(element => element.scrollTop)).toBeGreaterThan(before);
		expect(await page.evaluate(() => window.ashChatTranscriptIntegration.readingState().shouldFollow)).toBe(false);
		expect(errors).toEqual([]);
	});

	test('delayed media keeps a following transcript at the bottom', async function () {
		const { page } = browserTests;

		await page.goto('/chatTranscript.html');
		await page.evaluate(rows => {
			window.ashChatTranscriptIntegration.delayAttachments(true);
			window.ashChatTranscriptIntegration.renderItems(rows);
		}, rows);
		const viewport = page.locator('.ash-chat-list-widget .ash-scrollbar-viewport');
		await expect
			.poll(() => viewport.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight))
			.toBe(0);
		await page.locator('.ash-chat-media img').evaluate(element => {
			element.style.width = '300px';
			element.style.height = '400px';
		});
		await page
			.locator('.ash-chat-media')
			.getByRole('button', { name: 'Load image', exact: true })
			.evaluate(element => (element as HTMLButtonElement).click());
		await expect
			.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.mediaState().requests.length))
			.toBe(1);
		await page.evaluate(() => window.ashChatTranscriptIntegration.finishMedia());
		await expect
			.poll(() =>
				page.locator('.ash-chat-media img').evaluate(element => (element as HTMLImageElement).naturalWidth),
			)
			.toBe(2);
		await expect
			.poll(() => viewport.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight))
			.toBe(0);
		expect(await page.evaluate(() => window.ashChatTranscriptIntegration.readingState().shouldFollow)).toBe(true);
	});

	test('retained transcript restores editor focus after host recreation and hidden updates', async function () {
		const { page } = browserTests;

		await page.goto('/chatTranscript.html');
		const item: IChatListItem = { id: 'reply', type: 'agentMessage', text: code, transient: true };
		await page.evaluate(item => window.ashChatTranscriptIntegration.renderItems([item]), item);
		await page.locator('.ash-chat-code-block .stanza-editor').click();
		const before = await page.evaluate(() => ({
			state: window.ashChatTranscriptIntegration.readingState().focus,
			active: document.activeElement
				? {
						tag: document.activeElement.tagName,
						role: document.activeElement.getAttribute('role'),
						className: document.activeElement.className,
					}
				: undefined,
		}));
		await page.evaluate(() => window.ashChatTranscriptIntegration.recreateTranscript());
		const after = await page.evaluate(() => ({
			state: window.ashChatTranscriptIntegration.readingState().focus,
			active: document.activeElement
				? {
						tag: document.activeElement.tagName,
						role: document.activeElement.getAttribute('role'),
						className: document.activeElement.className,
					}
				: undefined,
		}));
		await browserTests.info.attach('restored-focus', {
			body: JSON.stringify({ before, after }, null, 2),
			contentType: 'application/json',
		});
		await expect(page.locator('.ash-chat-code-block .stanza-editor-input')).toBeFocused();
		await page.evaluate(() => window.ashChatTranscriptIntegration.setTranscriptVisible(false));
		await page.evaluate(
			item =>
				window.ashChatTranscriptIntegration.renderItems([
					{ ...item, text: item.text + '\n\nFinished.', transient: false },
				]),
			item,
		);
		await page.evaluate(() => window.ashChatTranscriptIntegration.setTranscriptVisible(true));
		await expect(page.locator('.ash-chat-markdown-part')).toContainText('Finished.');
		expect(await page.evaluate(() => window.ashChatTranscriptIntegration.readingState().shouldFollow)).toBe(true);
	});

	test('transcript wrapping preserves the visible message position when the host narrows', async function () {
		const { page } = browserTests;

		await page.goto('/chatTranscript.html');
		const wrapping = rows.map(item =>
			item.id.startsWith('reading-')
				? { ...item, text: item.text + '\n\n' + 'Long wrapping content in this response. '.repeat(10) }
				: item,
		);
		await page.evaluate(rows => window.ashChatTranscriptIntegration.renderItems(rows), wrapping);
		const viewport = page.locator('.ash-chat-list-widget .ash-scrollbar-viewport');
		await viewport.evaluate(element => {
			const target = document.querySelector('[data-item-id="reading-4"]')!;
			element.scrollTop += target.getBoundingClientRect().top - element.getBoundingClientRect().top + 20;
		});
		await expect
			.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.readingState().shouldFollow))
			.toBe(false);
		const position = () =>
			page.locator('[data-item-id="reading-4"]').evaluate(element => element.getBoundingClientRect().top);
		const top = await position();
		const before = await viewport.evaluate(element => element.scrollTop);
		await page.locator('main').evaluate(element => {
			element.style.width = '220px';
		});
		// Native scroll offsets quantize to device pixels while wrapped text has fractional bounds.
		const pixel = await page.evaluate(() => 1 / devicePixelRatio);
		await expect.poll(async () => Math.abs((await position()) - top)).toBeLessThanOrEqual(pixel);
		await expect.poll(() => viewport.evaluate(element => element.scrollTop)).toBeGreaterThan(before);
	});

	test('Hook status changes preserve the focused and expanded real browser summary', async function () {
		const { page } = browserTests;

		await page.goto('/chatTranscript.html');
		const run = {
			runId: 'hook-run',
			hookId: 'user:hook:browser',
			event: 'beforeTool',
			status: { type: 'running' as const },
			startedAtUnixMs: 1,
			durationMs: 0,
			turnId: 'turn',
			toolCallId: 'tool',
			toolName: 'shell-command',
		};
		const item: IChatListItem = {
			id: 'hook:run',
			type: 'hook',
			text: '',
			transient: true,
			isError: false,
			hookPart: { kind: 'hook', run },
		};
		await page.evaluate(item => window.ashChatTranscriptIntegration.renderItems([item]), item);
		const disclosure = page.locator('.ash-chat-hook');
		const summary = disclosure.locator('summary');
		const original = await summary.elementHandle();
		await summary.press('Enter');
		await expect.poll(() => disclosure.evaluate(element => (element as HTMLDetailsElement).open)).toBe(true);
		await expect(summary).toBeFocused();
		for (const status of [
			{ type: 'continued' as const },
			{ type: 'denied' as const, reason: '<img src=x> literal denial' },
			{ type: 'failed' as const, message: 'literal failure' },
			{ type: 'cancelled' as const, reason: 'literal cancellation' },
		]) {
			const isError = status.type === 'denied' || status.type === 'failed';
			const text =
				status.type === 'denied' || status.type === 'cancelled'
					? status.reason
					: status.type === 'failed'
						? status.message
						: '';
			await page.evaluate(item => window.ashChatTranscriptIntegration.renderItems([item]), {
				...item,
				text,
				transient: false,
				isError,
				hookPart: { kind: 'hook' as const, run: { ...run, status, durationMs: 25 } },
			});
			await expect(disclosure).toHaveAttribute('data-status', status.type);
			expect(await summary.evaluate((element, previous) => element === previous, original)).toBe(true);
			await expect(summary).toBeFocused();
			expect(await disclosure.evaluate(element => (element as HTMLDetailsElement).open)).toBe(true);
			expect(await disclosure.evaluate(element => element.closest('article')!.classList.contains('error'))).toBe(
				isError,
			);
			await expect(disclosure.locator('p')).toHaveText(text);
			await expect(disclosure.locator('img')).toHaveCount(0);
		}
		await original?.dispose();
	});
});
