import { initializeTestLocalization } from '../../../../services/localization/test/common/localizationTestUtils.js';
import { readFileSync } from 'node:fs';
import { expect } from '@playwright/test';
import { useBrowserTests } from '../../../../../../../test/unit/browser/context.js';
import type { } from '../../../../../../../test/fixtures/browser/chatInput.page.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { BrowserContextMenuService } from '../../../../../platform/contextview/browser/contextMenuService.js';
import { IImageEditorService } from '../../../../services/imageEditor/common/imageEditorService.js';
import { BrowserImageEditorService } from '../../../../services/imageEditor/browser/browserImageEditorService.js';
import { IHostService } from '../../../../services/host/browser/host.js';
import { TestHostService } from '../../../../services/host/test/browser/testHostService.js';
import '../../browser/chat.shared.contribution.js';
import { IChatSpeechToTextService, ChatSpeechToTextService } from '../../browser/speechToText/chatSpeechToTextService.js';
import { IDictationOnboardingService } from '../../browser/speechToText/dictationOnboarding.js';
import { TestQuickInputService } from '../../../../../platform/quickinput/test/browser/testQuickInputService.js';
import { isCancellationError } from '../../../../../base/common/errors.js';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { installEditorTestGlobals } from '../../../../../editor/test/browser/editorTestGlobals.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { ImageEditorService } from '../../../../services/imageEditor/browser/imageEditorService.js';
import { emptyEditorServiceState } from '../../../../test/common/testEditorService.js';
import { IMenuService } from '../../../../../platform/actions/common/actions.js';
import { MenuService } from '../../../../../platform/actions/common/menuService.js';
import { ContextKeyService, IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { IMessageHistoryService } from '../../../../../platform/messageHistory/common/messageHistory.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { registerTestDictationOnboarding, createTestDictationBackend, installTestDictationAudio, type TestDictationCapture } from '../../../../test/common/testDictationServices.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ChatSpeechToTextState } from '../../browser/speechToText/chatSpeechToTextService.js';
import { ISpeechService } from '../../../speech/common/speechService.js';
import { SpeechService } from '../../../speech/browser/speechService.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { ChatInputEditors } from '../../browser/widget/input/chatInputEditorRegistry.js';
import assert from 'node:assert/strict';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { NullTelemetryServiceShape } from '../../../../../platform/telemetry/common/telemetryUtils.js';
import { test, suiteTeardown, suite } from 'mocha';
import { JSDOM } from 'jsdom';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { BrowserContextViewService } from '../../../../../platform/contextview/browser/contextViewService.js';
import { ActionWidgetService, IActionWidgetService } from '../../../../../platform/actionWidget/browser/actionWidget.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { InMemoryConfigurationService } from '../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import { ILanguageModelsService } from '../../common/languageModels.js';
import { IAccessibleViewService } from '../../../../../platform/accessibility/browser/accessibleView.js';
import { IVoiceCodeTranscriptionBackendService } from '../../../../../platform/renderer/common/dictation.js';
import { Event as AshEvent, Emitter } from '../../../../../base/common/event.js';
import { ILocalTranscriptionModelService, ILocalTranscriptionService, DictationModelState, type ILocalTranscriptionModelSnapshot } from '../../../../../platform/localTranscription/common/localTranscription.js';
import { Severity } from '../../../../../platform/notification/common/notification.js';
import { TestNotificationService } from '../../../../services/notification/test/common/testNotificationService.js';
import { URI } from '../../../../../base/common/uri.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IAccessibilityService } from '../../../../../platform/accessibility/common/accessibility.js';
import { AccessibilityService } from '../../../../../platform/accessibility/browser/accessibilityService.js';
import { IChatSessionNavigationService } from '../../../../services/chat/common/chatSessionNavigationService.js';
import type { IChatWidgetModel } from '../../browser/widget/chatWidget.js';
import type { IWillShutdownEvent } from '../../../../services/lifecycle/common/lifecycle.js';
import type { IChatDraftStorage } from '../../browser/widget/input/chatInputPart.js';
import { ChatInputPart } from '../../browser/widget/input/chatInputPart.js';
import { IChatPasteTargetService } from '../../browser/chat.js';
import { ChatPasteTargetService } from '../../browser/attachments/chatPasteTargetService.js';
import { ChatAttachmentResolveService, IChatAttachmentResolveService } from '../../browser/attachments/chatAttachmentResolveService.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import type { IFileSearchService } from '../../../../../platform/search/common/fileSearch.js';
import type { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import type { IWorkingCopyService } from '../../../../services/workingCopy/common/workingCopyService.js';
import { setARIAContainer } from '../../../../../base/browser/ui/aria/aria.js';
import type { ChatInputDelegate, ChatInputState } from '../../browser/widget/input/chatInput.js';
import type { ChatAgent } from '../../../../services/chat/common/chatService.js';
import type { ChatContextAttachment } from '../../../../services/chat/common/chatContextService.js';

import { TestConfigurationService } from '../../../../services/configuration/test/common/testServices.js';

const browserEnvironment = new JSDOM('<!doctype html><body></body>');
for (const [name, value] of Object.entries({
	window: browserEnvironment.window,
	document: browserEnvironment.window.document,
	Node: browserEnvironment.window.Node,
	Element: browserEnvironment.window.Element,
	HTMLElement: browserEnvironment.window.HTMLElement,
	Event: browserEnvironment.window.Event,
})) {
	Object.defineProperty(globalThis, name, { configurable: true, value });
}

const inputResources = new DisposableStore();
inputResources.add(installTestDictationAudio(window));
suiteTeardown(() => inputResources.dispose());
const sharedNotifications = new TestNotificationService();
setARIAContainer(document.body);
suiteTeardown(() => sharedNotifications.dispose());

class ObservableInputPart extends ChatInputPart {
	readonly onDidChangeInputForTest = this.onDidChangeInput;
}

function inputPart(notifications: TestNotificationService, dictation?: TestDictationCapture, mode: ChatInputState['mode'] = 'agent', delegate: Partial<ChatInputDelegate> = {}, sharedServices?: InstantiationService, localTranscription?: ILocalTranscriptionModelService & ILocalTranscriptionService, telemetry?: ITelemetryService, layout?: 'compact'): ObservableInputPart {
	const container = document.createElement('div');
	document.body.append(container);
	let state: ChatInputState = { mode, queuedMessages: 0, approvalMode: 'manual', phase: 'loading', canInterrupt: false, models: [], isAutomaticModel: false, slashCommands: [], skillSelectors: [], canSelectAgent: false };
	const service = dictation ? createTestDictationBackend(inputResources, dictation) : undefined;
	const services = sharedServices ?? inputResources.add(new InstantiationService());
	if (!sharedServices) {
		services.registerInstance(INotificationService, notifications);
		if (telemetry) services.registerInstance(ITelemetryService, telemetry);
		services.registerSingleton(IConfigurationService, () => new TestConfigurationService({ source: dictation ? '{"dictation.backend":"cloud"}' : '{}' }));
		if (localTranscription) { services.registerInstance(ILocalTranscriptionService, localTranscription); services.registerInstance(ILocalTranscriptionModelService, localTranscription); }
		services.registerInstance(IVoiceCodeTranscriptionBackendService, service);
		services.registerSingleton(ISpeechService, () => services.createInstance(SpeechService));
		services.registerSingleton(IChatSpeechToTextService, () => services.createInstance(ChatSpeechToTextService));
		registerTestDictationOnboarding(services);
	}
	const partServices = inputResources.add(services.createChild());
	if (!partServices.has(IFileService)) partServices.registerInstance(IFileService, { hasProvider: () => false } as unknown as IFileService);
	if (!partServices.has(IChatPasteTargetService)) partServices.registerSingleton(IChatPasteTargetService, () => new ChatPasteTargetService());
	if (!partServices.has(IChatAttachmentResolveService)) {
		// This small composer fixture only resolves image bytes acquired by native FileReader.
		partServices.registerInstance(IChatAttachmentResolveService, new ChatAttachmentResolveService(
			{} as IFileService,
			{} as IWorkingCopyService,
			{} as IFileSearchService,
			{} as IWorkspaceContextService,
		));
	}
	if (!partServices.has(IHostService)) partServices.registerInstance(IHostService, new TestHostService());
	if (!partServices.has(IImageEditorService)) partServices.registerSingleton(IImageEditorService, () => partServices.createInstance(BrowserImageEditorService));
	if (!partServices.has(IEditorService)) partServices.registerInstance(IEditorService, { ...emptyEditorServiceState, openEditor: async () => { }, focusActiveEditor() { } });
	if (!partServices.has(IMessageHistoryService)) partServices.registerInstance(IMessageHistoryService, undefined);
	if (!partServices.has(IQuickInputService)) partServices.registerSingleton(IQuickInputService, () => new TestQuickInputService({ container: document.body }));
	partServices.registerInstance(IOpenerService, { open: async () => true } as unknown as IOpenerService);
	partServices.registerInstance(ICommandService, { executeCommand: async () => undefined } as unknown as ICommandService);
	partServices.registerInstance(IContextKeyService, inputResources.add(new ContextKeyService()));
	partServices.registerSingleton(IMenuService, () => partServices.createInstance(MenuService));
	partServices.registerInstance(INotificationService, notifications);
	partServices.registerInstance(IChatSessionNavigationService, { openConversation: async () => { } } as unknown as IChatSessionNavigationService);
	partServices.registerInstance(IKeybindingService, { lookupKeybinding: () => undefined } as unknown as IKeybindingService);
	partServices.registerSingleton(IContextMenuService, () => partServices.createInstance(BrowserContextMenuService));
	const contextView = inputResources.add(new BrowserContextViewService(document.body));
	partServices.registerInstance(IContextViewService, contextView);
	if (!partServices.has(IConfigurationService)) partServices.registerInstance(IConfigurationService, inputResources.add(new InMemoryConfigurationService()));
	if (!partServices.has(IAccessibilityService)) partServices.registerSingleton(IAccessibilityService, accessor => new AccessibilityService({
		root: document.body,
		configurationService: accessor.get(IConfigurationService),
		contextKeyService: accessor.get(IContextKeyService),
	}));
	partServices.registerSingleton(IActionWidgetService, () => partServices.createInstance(ActionWidgetService));
	partServices.registerInstance(ILanguageModelsService, {
		readApprovalReviewModel: async () => ({ type: 'automatic' }),
		setApprovalReviewModel: async () => { },
		onDidChangeModels: AshEvent.None,
		setModelPreferences: async () => { },
		listModels: async () => [],
		getDefaultNewChatModel: () => undefined,
		rememberSelectedModel: async () => { },
		readModelDefaults: async () => ({ revision: 1, model: null, reasoningEffort: null }),
		saveReasoningEffort: async () => { },
		listModelCatalog: async () => [],
		listCustomModelProviders: async () => [],
		removeCustomModelProvider: async () => { },
		saveCustomModelProvider: async () => { },
		testProviderModel: async () => ({ type: 'passed' }),
		listModelProviders: async () => [],
		setModelProviderApiKey: async () => { },
		removeModelProviderApiKey: async () => { },
		listAdvisorModels: async () => [],
		refreshModels: async () => [],
		isModelVisible: () => true,
		setModelVisible: async () => { },
		discoverProviderModels: async () => [],
	} satisfies ILanguageModelsService);
	partServices.registerInstance(IAccessibleViewService, { getOpenAriaHint: () => undefined } as unknown as IAccessibleViewService);
	const part = partServices.createInstance(ObservableInputPart, container, { ...delegate, selectMode: delegate.selectMode ?? (selected => { state = { ...state, mode: selected }; part.render(state); }) } as ChatInputDelegate, {} as IContextMenuService, { container: document.body } as IContextViewService, { getOpenAriaHint: () => undefined } as unknown as IAccessibleViewService, notifications, ChatInputEditors, [], { layout, modePicker: 'visible', modelPickerPosition: 'leading' });
	part.render(state);
	return part;
}

test('Chat mode picker loads Agents before opening the shared action widget and dispatches its selection', async () => {
	using resources = new DisposableStore();
	const agent: ChatAgent = { name: 'Reviewer', description: 'Review changes', sourceId: 'workspace' };
	let finishListing!: (agents: readonly ChatAgent[]) => void;
	const agents = new Promise<readonly ChatAgent[]>(resolve => { finishListing = resolve; });
	let finishSelection!: (agent: ChatAgent | undefined) => void;
	const selection = new Promise<ChatAgent | undefined>(resolve => { finishSelection = resolve; });
	using part = inputPart(sharedNotifications, undefined, 'agent', {
		listAgents: () => agents,
		selectAgent: selected => finishSelection(selected),
	});
	part.render({ mode: 'agent', queuedMessages: 0, approvalMode: 'manual', phase: 'ready', canInterrupt: false, models: [], isAutomaticModel: true, slashCommands: [], skillSelectors: [], canSelectAgent: true });
	part.element.querySelector<HTMLButtonElement>('[data-action-id="ash.chat.input.mode"] button')!.click();
	assert.equal(document.querySelector('.ash-action-widget.ash-chat-input-mode-menu'), null);
	const opened = new Promise<HTMLElement>(resolve => {
		const observer = new browserEnvironment.window.MutationObserver(() => {
			const widget = document.querySelector<HTMLElement>('.ash-action-widget.ash-chat-input-mode-menu');
			if (widget) {
				observer.disconnect();
				resolve(widget);
			}
		});
		observer.observe(document.body, { childList: true, subtree: true });
		resources.add(toDisposable(() => observer.disconnect()));
	});
	finishListing([agent]);
	const widget = await opened;
	const choices = Array.from(widget.querySelectorAll<HTMLButtonElement>('[role=menuitemradio]'));
	assert.deepEqual(choices.map(choice => [choice.getAttribute('aria-label'), choice.getAttribute('aria-checked')]), [
		['Agent', 'true'], ['Plan', 'false'], ['Debug', 'false'], ['Multitask', 'false'], ['Ask', 'false'],
		['Default Agent', 'true'], ['Reviewer', 'false'],
	]);
	choices[6]!.click();
	assert.deepEqual(await selection, agent);
	assert.equal(document.querySelector('.ash-chat-input-mode-menu'), null);
	assert.equal(part.element.querySelector('[data-action-id="ash.chat.input.mode"] button')!.getAttribute('aria-expanded'), 'false');
});

test('Session option loading retires with the input and can reopen for the next visible lifetime', async () => {
	const agent: ChatAgent = { name: 'Reviewer', description: 'Review changes', sourceId: 'workspace' };
	const listing = new DeferredPromise<readonly ChatAgent[]>();
	let reads = 0;
	const selected: (ChatAgent | undefined)[] = [];
	using part = inputPart(sharedNotifications, undefined, 'agent', {
		listAgents: () => ++reads === 1 ? listing.p : Promise.resolve([agent]),
		selectAgent: agent => { selected.push(agent); },
	});
	part.render({ mode: 'agent', queuedMessages: 0, approvalMode: 'manual', phase: 'ready', canInterrupt: false, models: [], isAutomaticModel: true, slashCommands: [], skillSelectors: [], canSelectAgent: true });
	const trigger = () => part.element.querySelector<HTMLButtonElement>('[data-action-id="ash.chat.input.mode"] button')!;
	trigger().click();
	part.setVisible(false);
	await listing.complete([agent]);
	await new Promise<void>(resolve => setImmediate(resolve));
	assert.equal(document.querySelector('.ash-chat-input-mode-menu'), null);
	assert.deepEqual(selected, []);
	part.setVisible(true);
	trigger().click();
	await new Promise<void>(resolve => setImmediate(resolve));
	const options = [...document.querySelectorAll<HTMLButtonElement>('.ash-chat-input-mode-menu [role=menuitemradio]')];
	assert.equal(options.length, 7);
	options.find(option => option.getAttribute('aria-label') === agent.name)!.click();
	await new Promise<void>(resolve => setImmediate(resolve));
	assert.deepEqual(selected, [agent]);
	trigger().click();
	await new Promise<void>(resolve => setImmediate(resolve));
	assert.ok(document.querySelector('.ash-chat-input-mode-menu'));
	part.invalidatePendingInput();
	assert.equal(document.querySelector('.ash-chat-input-mode-menu'), null);
});

test('All context kinds insert at the cursor without an attachment bar; tool configuration persists without enabling Send', async () => {
	const sent: ChatContextAttachment[][] = [];
	const commands: string[] = [];
	using part = inputPart(sharedNotifications, undefined, 'agent', {
		send: async (_text, _mode, _skills, contexts) => { sent.push([...(contexts ?? [])]); },
		executeCommand: async invocation => { commands.push(invocation.commandId); },
	});
	part.render({ mode: 'agent', queuedMessages: 0, approvalMode: 'manual', phase: 'ready', canInterrupt: false, models: [], isAutomaticModel: true, slashCommands: [], skillSelectors: [], canSelectAgent: false });
	part.addContext({ id: 'tool-selection', kind: 'toolSelection', name: 'Tool selection: 1 disabled', resolve: async () => ({ name: 'Tools', kind: 'toolSelection', content: '["write_file"]' }) });
	assert.equal(part.element.querySelector('[data-action-id="ash.chat.input.send"]'), null);
	await part.acceptInput();
	assert.equal(sent.length, 0);
	edit(part, part.element.querySelector('textarea')!.value + 'Review ');
	const input = part.element.querySelector('textarea')!;
	input.setSelectionRange(input.value.length - 7, input.value.length - 7);
	part.addContext({ id: 'folder', kind: 'directory', name: 'src', resource: URI.file('/workspace/src'), resolve: async () => ({ name: 'src', content: 'Directory snapshot' }) });
	assert.equal(input.value, 'Tool selection: 1 disabled src Review ');
	assert.equal(part.element.querySelector('.ash-chat-input-attachments'), null);
	const draft = await part.captureDraft();
	assert.deepEqual(draft?.draft.contexts[1]?.reference, { start: 27, end: 30 });
	await part.acceptInput();
	assert.deepEqual(sent[0]?.map(context => context.kind), ['toolSelection', 'directory']);
	assert.equal(input.value, 'Tool selection: 1 disabled ');
	assert.equal(part.element.querySelector('[data-action-id="ash.chat.input.send"]'), null);
	await part.acceptInput('/config');
	assert.equal(commands.length, 1);
	assert.equal(input.value, 'Tool selection: 1 disabled ');
	part.addContext({ id: 'tool-selection-new', kind: 'toolSelection', name: 'Tool selection: all enabled', resolve: async () => ({ name: 'Tools', kind: 'toolSelection', content: '[]' }) });
	assert.equal(input.value, 'Tool selection: all enabled ');
	assert.equal((await part.captureDraft())?.draft.contexts.length, 1);
});

test('Chat input sends attachments without text and rejects duplicate submissions while pending', async () => {
	let complete!: () => void;
	const sent: string[] = [];
	using part = inputPart(sharedNotifications, undefined, 'debug', {
		send: async (text, mode, _skills, contexts) => {
			sent.push(text);
			assert.equal(mode, 'debug');
			assert.equal(contexts?.[0]?.name, 'file.ts');
			await new Promise<void>(resolve => { complete = resolve; });
		},
	});
	part.render({ mode: 'debug', queuedMessages: 0, approvalMode: 'manual', phase: 'ready', canInterrupt: false, models: [], isAutomaticModel: true, slashCommands: [], skillSelectors: [], canSelectAgent: false });
	part.addContext({ id: 'file', kind: 'file', name: 'file.ts', resolve: async () => ({ name: 'file.ts', content: 'let value = 1;' }) });
	assert.equal(part.element.querySelector<HTMLButtonElement>('[data-action-id="ash.chat.input.send"] button')?.disabled, false);
	const pending = part.acceptInput();
	await part.acceptInput();
	edit(part, 'Next draft');
	complete();
	await pending;
	assert.deepEqual(sent, ['file.ts ']);
	assert.equal(part.element.querySelector('textarea')?.value, 'Next draft');
	assert.equal(part.element.querySelector('.ash-chat-input-attachments'), null);
});

test('Chat input keeps failed attachments and restores text for retry', async () => {
	using part = inputPart(sharedNotifications, undefined, 'agent', { send: async () => { throw new Error('Request failed'); } });
	part.render({ mode: 'agent', queuedMessages: 0, approvalMode: 'manual', phase: 'ready', canInterrupt: false, models: [], isAutomaticModel: true, slashCommands: [], skillSelectors: [], canSelectAgent: false });
	edit(part, 'Review image');
	part.addContext({ id: 'image', kind: 'image', name: 'image.png', resolve: async () => ({ name: 'image.png', content: 'data:image/png;base64,aGVsbG8=', kind: 'image' }) });
	await assert.rejects(part.acceptInput(), /Request failed/u);
	const captured = await part.captureDraft();
	assert.equal(captured?.draft.text, 'Review image image.png ');
	assert.equal(captured?.draft.contexts[0]?.kind, 'image');
	assert.deepEqual(captured?.draft.contexts[0]?.reference, { start: 13, end: 22 });
});

function edit(part: ChatInputPart, text: string): void {
	const input = part.element.querySelector('textarea');
	assert.ok(input);
	input.value = text;
	input.dispatchEvent(new Event('input', { bubbles: true }));
}

test('Local permission and Guardian commands work before the model catalog is ready while Turn input waits', async () => {
	const commands: Array<{ commandId: string; argumentsText: string; }> = [];
	let sends = 0;
	using part = inputPart(sharedNotifications, undefined, 'agent', {
		executeCommand: async invocation => { commands.push(invocation); },
		send: async () => { sends++; },
		executeServerCommand: async () => { assert.fail('server commands require a ready conversation'); },
	});
	for (const text of ['/permission auto', '/guardian setup']) {
		edit(part, text);
		assert.equal(part.element.querySelector<HTMLButtonElement>('[data-action-id="ash.chat.input.send"] button')?.disabled, false);
		await part.acceptInput();
		assert.equal(part.element.querySelector('textarea')?.value, '');
	}
	assert.deepEqual(commands, [{ commandId: 'chat.permission', argumentsText: 'auto' }, { commandId: 'chat.guardian.setup', argumentsText: 'setup' }]);
	part.render({ mode: 'agent', queuedMessages: 0, approvalMode: 'manual', phase: 'loading', canInterrupt: false, models: [], isAutomaticModel: true, slashCommands: [{ name: 'compact', description: 'Compact context', argumentMode: 'none' }], skillSelectors: [], canSelectAgent: false });
	for (const text of ['Create a file', '/compact']) {
		edit(part, text);
		assert.equal(part.element.querySelector<HTMLButtonElement>('[data-action-id="ash.chat.input.send"] button')?.disabled, true);
		await part.acceptInput();
		assert.equal(part.element.querySelector('textarea')?.value, text);
	}
	assert.equal(sends, 0);
});

test('source-owned App context survives consecutive submissions, updates in place and respects user removal', async () => {
	const sends: unknown[] = [];
	using part = inputPart(sharedNotifications, undefined, 'agent', { send: async (text, _mode, _skills, contexts) => { sends.push({ text, contexts: await Promise.all((contexts ?? []).map(context => context.resolve())) }); } });
	part.render({ mode: 'agent', queuedMessages: 0, approvalMode: 'manual', phase: 'ready', canInterrupt: false, models: [], isAutomaticModel: true, slashCommands: [], skillSelectors: [], canSelectAgent: false });
	const context = (text: string) => ({ id: 'app-context', kind: 'mcpApp', lifetime: 'source' as const, name: 'App context', resolve: async () => ({ name: 'App context', content: text }) });
	edit(part, 'First turn');
	part.addContext(context('first'));
	part.addContext(context('latest'));
	part.addContext({ id: 'file', kind: 'file', name: 'file.ts', resolve: async () => ({ name: 'file.ts', content: 'file body' }) });
	await part.acceptInput();
	assert.equal(part.attachmentModel.size, 1);
	part.appendToDraft('Next turn');
	await part.acceptInput();
	assert.deepEqual(sends, [
		{ text: 'First turn App context file.ts ', contexts: [{ name: 'App context', content: 'latest' }, { name: 'file.ts', content: 'file body' }] },
		{ text: 'App context \n\nNext turn', contexts: [{ name: 'App context', content: 'latest' }] },
	]);
	const input = part.element.querySelector('textarea')!;
	input.setSelectionRange('App context'.length, 'App context'.length);
	input.dispatchEvent(new browserEnvironment.window.KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }));
	assert.equal(part.attachmentModel.size, 0);
	await part.acceptInput('Without App context');
	assert.deepEqual(sends[2], { text: 'Without App context', contexts: [] });
});

test('Chat configuration requests append without sending or replacing draft attachments', async () => {
	let sends = 0;
	using part = inputPart(sharedNotifications, undefined, 'debug', { send: async () => { sends++; } });
	edit(part, 'Existing draft');
	part.addContext({ id: 'file', kind: 'file', name: 'file.ts', resolve: async () => ({ name: 'file.ts', content: 'const answer = 42;' }) });
	const oldCapture = await part.captureDraft();
	part.appendToDraft('Configure Hooks');
	oldCapture?.clear();
	assert.deepEqual((await part.captureDraft())?.draft, {
		mode: 'debug', text: 'Existing draft file.ts \n\nConfigure Hooks', contexts: [{ id: 'file', kind: 'file', name: 'file.ts', content: 'const answer = 42;', reference: { start: 15, end: 22 } }],
	});
	assert.equal(sends, 0);
});

test('Chat draft handoff moves text and resolved attachments after acknowledgement', async () => {
	using source = inputPart(sharedNotifications, undefined, 'debug');
	using target = inputPart(sharedNotifications);
	edit(source, 'Review this file');
	source.addContext({ id: 'src/file.ts', kind: 'file', resource: URI.file('/workspace/file.ts'), name: 'file.ts', resolve: async () => ({ name: 'file.ts', content: 'const answer = 42;' }) });
	const captured = await source.captureDraft();
	assert.ok(captured);
	assert.deepEqual(captured.draft, {
		mode: 'debug',
		text: 'Review this file file.ts ',
		contexts: [{ id: 'src/file.ts', kind: 'file', name: 'file.ts', content: 'const answer = 42;', resource: 'file:///workspace/file.ts', reference: { start: 17, end: 24 } }],
	});
	target.restoreDraft(captured.draft);
	assert.equal(target.element.querySelector('textarea')?.value, 'Review this file file.ts ');
	assert.equal(target.element.querySelector('[data-action-id="ash.chat.input.mode"] button')?.textContent, 'Debug');
	assert.equal(target.element.querySelector('.ash-chat-input-attachments'), null);
	assert.throws(() => target.restoreDraft(captured.draft), /already has an unsent draft/u);
	captured.clear();
	assert.equal(source.element.querySelector('textarea')?.value, '');
	assert.doesNotMatch(source.element.querySelector('.ash-chat-input-attachments')?.textContent ?? '', /file\.ts/u);
});

test('Chat draft handoff leaves text edited after capture in the source', async () => {
	using source = inputPart(sharedNotifications);
	edit(source, 'First draft');
	const captured = await source.captureDraft();
	assert.ok(captured);
	edit(source, 'Revised draft');
	captured.clear();
	assert.equal(source.element.querySelector('textarea')?.value, 'Revised draft');
});

test('Selected code is inserted at the message cursor and survives handoff without an attachment pill', async () => {
	using source = inputPart(sharedNotifications);
	using target = inputPart(sharedNotifications);
	edit(source, 'Explain  please');
	const input = source.element.querySelector('textarea')!;
	input.setSelectionRange(8, 8);
	source.addContext({ id: 'selection', kind: 'codeSelection', name: 'file.ts (6-9)', resource: URI.file('/workspace/file.ts').with({ fragment: 'L6,1-L9,2' }), resolve: async () => ({ name: 'file.ts (6-9)', content: 'Unsaved selected code' }) });
	assert.equal(input.value, 'Explain file.ts (6-9) please');
	assert.equal(input.selectionStart, 21);
	assert.equal(source.element.querySelector('.ash-chat-input-attachments'), null);
	assert.equal(document.activeElement, input);
	const captured = await source.captureDraft();
	assert.ok(captured);
	assert.deepEqual(captured.draft.contexts[0]?.reference, { start: 8, end: 21 });
	target.restoreDraft(captured.draft);
	assert.deepEqual((await target.captureDraft())?.draft, captured.draft);
	assert.equal(target.element.querySelector('.ash-chat-input-attachments'), null);
	const restored = target.element.querySelector('textarea')!;
	restored.setSelectionRange(21, 21);
	restored.dispatchEvent(new browserEnvironment.window.KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }));
	assert.equal(restored.value, 'Explain  please');
	assert.deepEqual((await target.captureDraft())?.draft.contexts, []);
});

test('A pending file picker inserts its filename before submission captures the message', async () => {
	const prepared = new DeferredPromise<readonly ChatContextAttachment[]>();
	let sent: unknown;
	using part = inputPart(sharedNotifications, undefined, 'agent', {
		send: async (text, _mode, _skills, contexts) => {
			sent = { text, contexts: await Promise.all(contexts!.map(context => context.resolve())) };
		}
	});
	part.render({ mode: 'agent', queuedMessages: 0, approvalMode: 'manual', phase: 'ready', canInterrupt: false, models: [], isAutomaticModel: true, slashCommands: [], skillSelectors: [], canSelectAgent: false });
	edit(part, 'Explain  please');
	part.element.querySelector('textarea')!.setSelectionRange(8, 8);
	const acquiring = part.acquireContext(() => prepared.p);
	const sending = part.acceptInput();
	await prepared.complete([{ id: 'picked-file', kind: 'file', name: 'file.ts', resource: URI.file('/workspace/file.ts'), resolve: async () => ({ name: 'file.ts', content: 'Unsaved whole file' }) }]);
	await Promise.all([acquiring, sending]);
	assert.deepEqual(sent, { text: 'Explain file.ts please', contexts: [{ name: 'file.ts', content: 'Unsaved whole file' }] });
	assert.equal(part.element.querySelector('textarea')!.value, '');
	assert.equal(part.element.querySelector('.ash-chat-input-attachments'), null);
});

test('Restoring an older file attachment draft adds a filename reference instead of a bar pill', async () => {
	using part = inputPart(sharedNotifications);
	part.restoreDraft({ mode: 'agent', text: 'Explain', contexts: [{ id: 'legacy', kind: 'file', name: 'file.ts', resource: 'file:///workspace/file.ts', content: 'Older unsaved snapshot' }] });
	const draft = (await part.captureDraft())!.draft;
	assert.equal(draft.text, 'Explain file.ts ');
	assert.deepEqual(draft.contexts[0]?.reference, { start: 8, end: 15 });
	assert.equal(draft.contexts[0]?.content, 'Older unsaved snapshot');
	assert.equal(part.element.querySelector('.ash-chat-input-attachments'), null);
});

test('Sending a selected code reference forwards its snapshot and restores it after failure', async () => {
	let submitted: unknown;
	using part = inputPart(sharedNotifications, undefined, 'agent', {
		send: async (text, _mode, _skills, contexts) => {
			submitted = { text, contexts: await Promise.all(contexts!.map(context => context.resolve())) };
			throw new Error('Send failed');
		}
	});
	part.render({ mode: 'agent', queuedMessages: 0, approvalMode: 'manual', phase: 'ready', canInterrupt: false, models: [], isAutomaticModel: true, slashCommands: [], skillSelectors: [], canSelectAgent: false });
	part.addContext({ id: 'selection', kind: 'codeSelection', name: 'file.ts (6-9)', resolve: async () => ({ name: 'file.ts (6-9)', content: 'Unsaved selected code' }) });
	const draft = (await part.captureDraft())?.draft;
	await assert.rejects(part.acceptInput(), /Send failed/);
	assert.deepEqual(submitted, { text: 'file.ts (6-9) ', contexts: [{ name: 'file.ts (6-9)', content: 'Unsaved selected code' }] });
	assert.deepEqual((await part.captureDraft())?.draft, draft);
});

test('Chat dictation startup failure appears in notifications and leaves input status clear', async () => {
	using notifications = new TestNotificationService();
	using part = inputPart(notifications, { start: async () => { throw new Error('HTTP 403'); } });
	const failure = new DeferredPromise<void>();
	using notification = notifications.model.onDidAdd(() => { void failure.complete(); });
	part.element.querySelector<HTMLButtonElement>('[data-action-id="workbench.action.chat.toggleSpeechToText"] button')?.click();
	await failure.p;
	assert.deepEqual(notifications.model.getNotifications().map(item => ({ severity: item.severity, message: item.message })), [
		{ severity: Severity.Error, message: 'Dictation failed: Error: HTTP 403' },
	]);
	assert.equal(part.element.querySelector('.ash-chat-status-summary')?.textContent, 'Loading chat…');
	assert.equal(part.element.querySelector<HTMLButtonElement>('[data-action-id="workbench.action.chat.toggleSpeechToText"] button')?.disabled, false);
});

test('Chat keeps model preparation in settings and reads it only when dictation is requested', async () => {
	using changed = new Emitter<void>();
	let snapshot: ILocalTranscriptionModelSnapshot = { model: 'selected', available: false, sizeBytes: 0 };
	let reads = 0;
	let starts = 0;
	let prepared = 0;
	let cancelled = 0;
	const categories: unknown[] = [];
	const sent: string[] = [];
	let settingsOpened!: () => void;
	let opened = new Promise<void>(resolve => { settingsOpened = resolve; });
	using part = inputPart(sharedNotifications, undefined, 'agent', { openModelSettings: async category => { categories.push(category); settingsOpened(); }, send: async text => { sent.push(text); } }, undefined, {
		_serviceBrand: undefined, isSupported: true,
		onDidChangeModels: changed.event, onDidChangeModelStatus: AshEvent.None,
		onDidTranscribe: AshEvent.None,
		getModel: async () => { reads++; return snapshot; },
		getCacheDirectory: async () => 'C:/models',
		getModelStatus: async () => ({ state: 'idle' as import('../../../../../platform/localTranscription/common/localTranscription.js').LocalTranscriptionModelState }),
		listModels: async () => [],
		prepareModel: () => { prepared++; throw new Error('Unexpected model preparation'); },
		importPackage: () => { throw new Error('Unexpected model import'); },
		importModel: async () => { throw new Error('Unexpected model import'); },
		cancelModel: async () => { cancelled++; }, deleteModel: async () => { },
		pushAudio: async () => { }, start: async () => { starts++; }, stop: async () => '', cancel: async () => { },
	});
	part.render({ mode: 'agent', queuedMessages: 0, approvalMode: 'manual', phase: 'ready', canInterrupt: false, models: [], isAutomaticModel: true, slashCommands: [], skillSelectors: [], canSelectAgent: false });
	assert.equal(part.element.querySelector('.ash-chat-model-preparation'), null);
	assert.equal(reads, 0);
	edit(part, 'Text still works');
	part.element.querySelector<HTMLButtonElement>('[data-action-id="workbench.action.chat.toggleSpeechToText"] button')!.click();
	await opened;
	await Promise.resolve();
	assert.deepEqual(categories, ['dictation']);
	assert.equal(part.element.querySelector('textarea')!.value, 'Text still works');
	assert.deepEqual({ reads, starts, prepared, cancelled }, { reads: 1, starts: 0, prepared: 0, cancelled: 0 });

	snapshot = { model: 'selected', available: false, sizeBytes: 0, status: { state: DictationModelState.Downloading, file: 'encoder.onnx', downloadedBytes: 2097152 } };
	changed.fire();
	part.setVisible(false);
	part.setVisible(true);
	assert.equal(reads, 1);
	assert.equal(part.element.querySelector('.ash-chat-model-preparation'), null);
	opened = new Promise<void>(resolve => { settingsOpened = resolve; });
	part.element.querySelector<HTMLButtonElement>('[data-action-id="workbench.action.chat.toggleSpeechToText"] button')!.click();
	await opened;
	assert.deepEqual(categories, ['dictation', 'dictation']);
	assert.deepEqual({ reads, starts, prepared, cancelled }, { reads: 2, starts: 0, prepared: 0, cancelled: 0 });
	await part.acceptInput();
	assert.deepEqual(sent, ['Text still works']);
});

test('Chat dictation session failure appears in notifications and releases the microphone', async () => {
	using notifications = new TestNotificationService();
	let endSession: ((error?: string) => void) | undefined;
	using part = inputPart(notifications, {
		start: async (_options, _onTranscript, onEnded) => {
			endSession = onEnded;
			return { stop: async () => { }, cancel: async () => { } };
		}
	});
	const microphone = part.element.querySelector<HTMLButtonElement>('[data-action-id="workbench.action.chat.toggleSpeechToText"] button');
	assert.ok(microphone);
	microphone.click();
	await new Promise(resolve => setTimeout(resolve, 0));
	assert.equal(part.element.querySelector<HTMLButtonElement>('[data-action-id="workbench.action.chat.toggleSpeechToText"] button')?.getAttribute('aria-pressed'), 'true');
	const failed = new DeferredPromise<void>();
	using notificationAdded = notifications.model.onDidAdd(() => { void failed.complete(); });
	endSession?.('HTTP 403');
	await failed.p;
	assert.deepEqual(notifications.model.getNotifications().map(item => ({ severity: item.severity, message: item.message })), [
		{ severity: Severity.Error, message: 'Dictation failed: Error: HTTP 403' },
	]);
	assert.equal(part.element.querySelector('.ash-chat-status-summary')?.textContent, 'Loading chat…');
	assert.notEqual(part.element.querySelector<HTMLButtonElement>('[data-action-id="workbench.action.chat.toggleSpeechToText"] button')?.getAttribute('aria-pressed'), 'true');
});

for (const layout of [undefined, 'compact'] as const) test(`Dictation replaces the selection and submission waits for final transcription (${layout ?? 'default'})`, async () => {
	let transcript!: (text: string, final: boolean) => void;
	let finishStop!: () => void;
	const stopRequested = new DeferredPromise<void>();
	const sent: string[] = [];
	using part = inputPart(sharedNotifications, {
		start: async (_options, onTranscript, onEnded) => {
			transcript = onTranscript;
			return { stop: async () => { await new Promise<void>(resolve => { finishStop = resolve; void stopRequested.complete(); }); transcript('replacement', true); onEnded(); }, cancel: async () => { } };
		},
	}, 'agent', { send: async text => { sent.push(text); } }, undefined, undefined, undefined, layout);
	part.render({ mode: 'agent', queuedMessages: 0, approvalMode: 'manual', phase: 'ready', canInterrupt: false, models: [], isAutomaticModel: true, slashCommands: [], skillSelectors: [], canSelectAgent: false });
	edit(part, 'before old after');
	const input = part.element.querySelector('textarea')!;
	input.setSelectionRange(7, 10);
	part.element.querySelector<HTMLButtonElement>('[data-action-id="workbench.action.chat.toggleSpeechToText"] button')!.click();
	await new Promise(resolve => setTimeout(resolve, 0));
	transcript('partial', false);
	assert.equal(input.value, 'before old after');
	assert.equal(part.element.querySelector('.ash-chat-dictation-preview')?.textContent, 'partial');
	const submit = part.acceptInput();
	await stopRequested.p;
	assert.deepEqual(sent, []);
	finishStop();
	await submit;
	assert.deepEqual(sent, ['before replacement after']);
});

for (const layout of [undefined, 'compact'] as const) test(`Enter submits an interim-only dictation after finalization (${layout ?? 'default'})`, async () => {
	const stopping = new DeferredPromise<void>();
	const finalization = new DeferredPromise<void>();
	const sent: string[] = [];
	let transcript!: (text: string, final: boolean) => void;
	using part = inputPart(sharedNotifications, {
		start: async (_options, onTranscript) => {
			transcript = onTranscript;
			return {
				stop: async () => {
					void stopping.complete();
					await finalization.p;
					onTranscript('Final recognized words', true);
				},
				cancel: async () => { },
			};
		},
	}, 'agent', { send: async text => { sent.push(text); } }, undefined, undefined, undefined, layout);
	part.render({ mode: 'agent', queuedMessages: 0, approvalMode: 'manual', phase: 'ready', canInterrupt: false, models: [], isAutomaticModel: true, slashCommands: [], skillSelectors: [], canSelectAgent: false });
	part.element.querySelector<HTMLButtonElement>('[data-action-id="workbench.action.chat.toggleSpeechToText"] button')!.click();
	await new Promise(resolve => setTimeout(resolve, 0));
	transcript('interim words', false);
	const input = part.element.querySelector('textarea')!;
	assert.equal(input.value, '');
	input.dispatchEvent(new browserEnvironment.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
	try {
		await new Promise(resolve => setTimeout(resolve, 0));
		assert.equal(stopping.isSettled, true);
		input.dispatchEvent(new browserEnvironment.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		assert.deepEqual(sent, []);
	} finally {
		await finalization.complete();
	}
	await new Promise(resolve => setTimeout(resolve, 0));
	assert.deepEqual(sent, ['Final recognized words']);
});

for (const layout of [undefined, 'compact'] as const) test(`Failed dictation finalization preserves the unsent draft (${layout ?? 'default'})`, async () => {
	using notifications = new TestNotificationService();
	const sent: string[] = [];
	using part = inputPart(notifications, {
		start: async () => ({ stop: async () => { throw new Error('transcription failed'); }, cancel: async () => { } }),
	}, 'agent', { send: async text => { sent.push(text); } }, undefined, undefined, undefined, layout);
	part.render({ mode: 'agent', queuedMessages: 0, approvalMode: 'manual', phase: 'ready', canInterrupt: false, models: [], isAutomaticModel: true, slashCommands: [], skillSelectors: [], canSelectAgent: false });
	edit(part, 'Existing draft');
	part.element.querySelector<HTMLButtonElement>('[data-action-id="workbench.action.chat.toggleSpeechToText"] button')!.click();
	await new Promise(resolve => setTimeout(resolve, 0));
	await assert.rejects(part.acceptInput(), /transcription failed/u);
	assert.deepEqual(sent, []);
	assert.equal(part.element.querySelector('textarea')!.value, 'Existing draft');
	assert.equal(notifications.model.getNotifications().length, 1);
	assert.match(notifications.model.getNotifications()[0]!.message, /Dictation failed: .*transcription failed/u);
	await part.acceptInput();
	assert.deepEqual(sent, ['Existing draft']);
});

for (const locale of ['en', 'zh-CN']) for (const layout of [undefined, 'compact'] as const) test(`Dictation stop circle keeps recognized text as an unsent draft (${layout ?? 'default'}, ${locale})`, async () => {
	initializeTestLocalization(locale);
	try {
		const sent: string[] = [];
		const inserted = new DeferredPromise<void>();
		let stopped = 0;
		using part = inputPart(sharedNotifications, {
			start: async (_options, onTranscript, onEnded) => ({
				stop: async () => { stopped++; onTranscript('Recognized words', true); onEnded(); },
				cancel: async () => { },
			}),
		}, 'agent', { send: async text => { sent.push(text); } }, undefined, undefined, undefined, layout);
		part.render({ mode: 'agent', queuedMessages: 0, approvalMode: 'manual', phase: 'ready', canInterrupt: false, models: [], isAutomaticModel: true, slashCommands: [], skillSelectors: [], canSelectAgent: false });
		const microphone = () => part.element.querySelector<HTMLButtonElement>('[data-action-id="workbench.action.chat.toggleSpeechToText"] button')!;
		assert.ok(microphone().querySelector('.ash-icon-mic'));
		microphone().click();
		await new Promise(resolve => setTimeout(resolve, 0));
		assert.equal(microphone().getAttribute('aria-label'), locale === 'en' ? 'Stop dictation' : '结束听写');
		assert.ok(microphone().querySelector('.ash-icon-stop-circle'));
		using changed = part.onDidChangeInputForTest(() => { if (part.element.querySelector('textarea')!.value === 'Recognized words') void inserted.complete(); });
		microphone().click();
		await inserted.p;
		await new Promise(resolve => setTimeout(resolve, 0));
		assert.equal(stopped, 1);
		assert.deepEqual(sent, []);
		assert.equal(microphone().getAttribute('aria-label'), locale === 'en' ? 'Dictate message' : '听写');
		assert.ok(microphone().querySelector('.ash-icon-mic'));
		if (layout === 'compact') assert.equal(part.element.querySelector('[data-action-id="ash.chat.input.send"]'), null);
		part.element.querySelector('textarea')!.dispatchEvent(new browserEnvironment.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		await new Promise(resolve => setTimeout(resolve, 0));
		assert.deepEqual(sent, ['Recognized words']);
	} finally { initializeTestLocalization('en'); }
});

test('submitting an edited dictated draft records aggregate accuracy once without sending transcript text', async () => {
	const events: { name: string; data: unknown; }[] = [];
	class Telemetry extends NullTelemetryServiceShape {
		override publicLog(name: string, data: Parameters<ITelemetryService['publicLog']>[1]): void { events.push({ name, data }); }
	}
	using part = inputPart(sharedNotifications, {
		start: async (_options, onTranscript) => ({ stop: async () => onTranscript('cat', true), cancel: async () => { } }),
	}, 'agent', { send: async () => { } }, undefined, undefined, new Telemetry());
	part.render({ mode: 'agent', queuedMessages: 0, approvalMode: 'manual', phase: 'ready', canInterrupt: false, models: [], isAutomaticModel: true, slashCommands: [], skillSelectors: [], canSelectAgent: false });
	part.element.querySelector<HTMLButtonElement>('[data-action-id="workbench.action.chat.toggleSpeechToText"] button')!.click();
	await new Promise(resolve => setTimeout(resolve, 0));
	const inserted = new DeferredPromise<void>();
	using changed = part.onDidChangeInputForTest(() => { if (part.element.querySelector('textarea')!.value === 'cat') void inserted.complete(); });
	part.element.querySelector<HTMLButtonElement>('[data-action-id="workbench.action.chat.toggleSpeechToText"] button')!.click();
	await inserted.p;
	edit(part, 'cats');
	await part.acceptInput();
	assert.deepEqual(events, [{ name: 'dictation.accuracy', data: { backend: 'cloud', surface: 'chat', submitted: true, dictatedLength: 3, submittedLength: 4, editDistance: 1 } }]);
});

test('Closing an input during microphone acquisition closes the resulting session', async () => {
	const acquiring = new DeferredPromise<void>();
	let completeStart!: (session: { stop(): Promise<void>; cancel(): Promise<void>; }) => void;
	let stopped = 0;
	const part = inputPart(sharedNotifications, { start: () => new Promise(resolve => { completeStart = resolve; void acquiring.complete(); }) });
	part.element.querySelector<HTMLButtonElement>('[data-action-id="workbench.action.chat.toggleSpeechToText"] button')!.click();
	await acquiring.p;
	assert.equal(part.element.querySelector<HTMLButtonElement>('[data-action-id="workbench.action.chat.toggleSpeechToText"] button')!.disabled, true);
	part.dispose();
	completeStart({ stop: async () => { stopped++; }, cancel: async () => { stopped++; } });
	await new Promise(resolve => setTimeout(resolve, 0));
	assert.equal(stopped, 1);
});


test('Shared dictation only changes its owning input and returns the complete transcript', async () => {
	using services = new InstantiationService();
	let transcript!: (text: string, final: boolean) => void;
	let ended!: (error?: string) => void;
	let stops = 0;
	const backend: TestDictationCapture = {
		getOptions: async () => ({ inputDevices: [], languages: [] }), start: async (_options, onTranscript, onEnded) => {
			transcript = onTranscript;
			ended = onEnded;
			return { stop: async () => { stops++; transcript('first second', true); ended(); }, cancel: async () => { stops++; } };
		},
	};
	services.registerInstance(IVoiceCodeTranscriptionBackendService, createTestDictationBackend(inputResources, backend));
	services.registerSingleton(ISpeechService, () => services.createInstance(SpeechService));
	services.registerSingleton(IChatSpeechToTextService, () => services.createInstance(ChatSpeechToTextService));
	registerTestDictationOnboarding(services);
	await services.get(IConfigurationService).updateValue('dictation.backend', 'cloud');
	if (!services.has(INotificationService)) services.registerInstance(INotificationService, sharedNotifications);
	const speech = services.get(IChatSpeechToTextService);
	using firstNotifications = new TestNotificationService();
	using secondNotifications = new TestNotificationService();
	using first = inputPart(firstNotifications, undefined, 'agent', {}, services);
	using second = inputPart(secondNotifications, undefined, 'agent', {}, services);
	const started = waitForSpeechState(speech, ChatSpeechToTextState.Recording);
	first.element.querySelector<HTMLButtonElement>('[data-action-id="workbench.action.chat.toggleSpeechToText"] button')!.click();
	await started;
	transcript('first', false);
	assert.equal(first.element.querySelector('.ash-chat-dictation-preview')!.textContent, 'first');
	assert.deepEqual([first.element.querySelector('textarea')!.value, second.element.querySelector('textarea')!.value], ['', '']);
	assert.equal(second.element.querySelector<HTMLButtonElement>('[data-action-id="workbench.action.chat.toggleSpeechToText"] button')!.disabled, true);
	second.setVisible(false);
	assert.equal(stops, 0);
	assert.equal(await speech.stopAndTranscribe(), 'first second');
	assert.deepEqual([first.element.querySelector('textarea')!.value, second.element.querySelector('textarea')!.value, stops], ['first second', '', 1]);
	assert.deepEqual([firstNotifications.model.getNotifications(), secondNotifications.model.getNotifications()], [[], []]);
});

test('Hiding the recording input discards stop-time text and permits another input to record', async () => {
	using services = new InstantiationService();
	let transcript!: (text: string, final: boolean) => void;
	let finishStop!: () => void;
	let stopRequested!: () => void;
	let stopReady = new Promise<void>(resolve => { stopRequested = resolve; });
	const backend: TestDictationCapture = {
		getOptions: async () => ({ inputDevices: [], languages: [] }), start: async (_options, onTranscript) => {
			transcript = onTranscript;
			const finish = () => new Promise<void>(resolve => { finishStop = () => { transcript('discarded', true); resolve(); }; stopRequested(); });
			return { stop: finish, cancel: finish };
		},
	};
	services.registerInstance(IVoiceCodeTranscriptionBackendService, createTestDictationBackend(inputResources, backend));
	services.registerSingleton(ISpeechService, () => services.createInstance(SpeechService));
	services.registerSingleton(IChatSpeechToTextService, () => services.createInstance(ChatSpeechToTextService));
	registerTestDictationOnboarding(services);
	await services.get(IConfigurationService).updateValue('dictation.backend', 'cloud');
	if (!services.has(INotificationService)) services.registerInstance(INotificationService, sharedNotifications);
	const speech = services.get(IChatSpeechToTextService);
	using first = inputPart(sharedNotifications, undefined, 'agent', {}, services);
	using second = inputPart(sharedNotifications, undefined, 'agent', {}, services);
	const started = waitForSpeechState(speech, ChatSpeechToTextState.Recording);
	first.element.querySelector<HTMLButtonElement>('[data-action-id="workbench.action.chat.toggleSpeechToText"] button')!.click();
	await started;
	transcript('interim', false);
	first.setVisible(false);
	await stopReady;
	const idle = waitForSpeechState(speech, ChatSpeechToTextState.Idle);
	finishStop();
	await idle;
	assert.deepEqual([first.element.querySelector('textarea')!.value, second.element.querySelector('textarea')!.value], ['', '']);
	assert.equal(first.element.querySelector('.ash-chat-dictation-preview')!.textContent, '');
	const restarted = waitForSpeechState(speech, ChatSpeechToTextState.Recording);
	second.element.querySelector<HTMLButtonElement>('[data-action-id="workbench.action.chat.toggleSpeechToText"] button')!.click();
	await restarted;
	transcript('new input', false);
	assert.equal(second.element.querySelector('.ash-chat-dictation-preview')!.textContent, 'new input');
	stopReady = new Promise<void>(resolve => { stopRequested = resolve; });
	const stopped = speech.stopAndTranscribe();
	await stopReady;
	finishStop();
	await stopped;
	assert.deepEqual([first.element.querySelector('textarea')!.value, second.element.querySelector('textarea')!.value], ['', 'discarded']);
});

test('A failed shared session notifies its window once without notifying unrelated inputs', async () => {
	using services = new InstantiationService();
	using windowNotifications = new TestNotificationService();
	services.registerInstance(INotificationService, windowNotifications);
	let ended!: (error?: string) => void;
	services.registerInstance(IVoiceCodeTranscriptionBackendService, createTestDictationBackend(inputResources, {
		getOptions: async () => ({ inputDevices: [], languages: [] }), start: async (_options, _onTranscript: (text: string, final: boolean) => void, onEnded: (error?: string) => void) => { ended = onEnded; return { stop: async () => { }, cancel: async () => { } }; },
	}));
	services.registerSingleton(ISpeechService, () => services.createInstance(SpeechService));
	services.registerSingleton(IChatSpeechToTextService, () => services.createInstance(ChatSpeechToTextService));
	registerTestDictationOnboarding(services);
	await services.get(IConfigurationService).updateValue('dictation.backend', 'cloud');
	if (!services.has(INotificationService)) services.registerInstance(INotificationService, sharedNotifications);
	const speech = services.get(IChatSpeechToTextService);
	using firstNotifications = new TestNotificationService();
	using secondNotifications = new TestNotificationService();
	using first = inputPart(firstNotifications, undefined, 'agent', {}, services);
	using second = inputPart(secondNotifications, undefined, 'agent', {}, services);
	const started = waitForSpeechState(speech, ChatSpeechToTextState.Recording);
	first.element.querySelector<HTMLButtonElement>('[data-action-id="workbench.action.chat.toggleSpeechToText"] button')!.click();
	await started;
	const notified = new DeferredPromise<void>();
	using notificationAdded = windowNotifications.model.onDidAdd(() => { void notified.complete(); });
	ended('capture lost');
	await notified.p;
	assert.deepEqual(windowNotifications.model.getNotifications().map(item => item.message), ['Dictation failed: Error: capture lost']);
	assert.deepEqual([firstNotifications.model.getNotifications(), secondNotifications.model.getNotifications()], [[], []]);
	assert.equal(speech.state, ChatSpeechToTextState.Idle);
});

async function waitForSpeechState(service: IChatSpeechToTextService, state: ChatSpeechToTextState): Promise<void> {
	await new Promise<void>(resolve => {
		const subscription = service.onDidChangeState(next => {
			if (next === state && (state !== ChatSpeechToTextState.Idle || !service.isBusy)) {
				subscription.dispose();
				resolve();
			}
		});
	});
}

test('Input construction rejects a missing window dictation service', () => {
	using services = new InstantiationService();
	assert.throws(() => services.createInstance(ChatInputPart, document.body, {} as ChatInputDelegate, {} as IContextMenuService, {} as IContextViewService, {} as IAccessibleViewService, sharedNotifications, ChatInputEditors, [], { modePicker: 'visible', modelPickerPosition: 'leading' }), /Unknown service: chatSpeechToTextService/);
});

test('Input construction requires the window attachment resolver', () => {
	using services = new InstantiationService();
	services.registerInstance(IChatSpeechToTextService, {} as IChatSpeechToTextService);
	services.registerInstance(IDictationOnboardingService, {} as IDictationOnboardingService);
	services.registerInstance(IQuickInputService, {} as IQuickInputService);
	services.registerInstance(IMenuService, {} as IMenuService);
	assert.throws(() => services.createInstance(ChatInputPart, document.body, {} as ChatInputDelegate, {} as IContextMenuService, {} as IContextViewService, {} as IAccessibleViewService, sharedNotifications, ChatInputEditors, [], { modePicker: 'visible', modelPickerPosition: 'leading' }), /Unknown service: chatAttachmentResolveService/u);
});


test('approval shows every exact target as text and dispatches both decisions', async () => {
	const responses: unknown[] = [];
	using part = inputPart(sharedNotifications, undefined, 'agent', { resolveInteraction: async response => { responses.push(response); } });
	const scopes = ['/tmp/a file.txt', String.raw`C:\Users\name\file.txt`, String.raw`\\server\share\file.txt`, '<img src=x onerror=alert(1)>', 'api.example.test'];
	const state: ChatInputState = {
		mode: 'agent', queuedMessages: 0, approvalMode: 'manual', phase: 'ready', canInterrupt: false, models: [], isAutomaticModel: true, slashCommands: [], skillSelectors: [], canSelectAgent: false,
		interaction: { requestId: 'approval-1', request: { type: 'approval', request: { reason: 'Review these actions', capabilities: scopes.map((scope, index) => ({ kind: index === 4 ? 'network' : 'fileWrite', scope })) } } },
	};
	part.render(state);
	const interaction = part.element.querySelector('.ash-chat-interaction')!;
	assert.deepEqual([...interaction.querySelectorAll('code')].map(node => node.textContent), scopes);
	assert.equal(interaction.querySelector('img'), null);
	assert.equal(interaction.querySelector('ul')?.getAttribute('aria-label'), 'Requested actions and targets');
	const focusedDecision = interaction.querySelector<HTMLButtonElement>('button')!;
	focusedDecision.focus();
	part.render({ ...state, queuedMessages: 1 });
	assert.equal(document.activeElement, focusedDecision);
	for (const label of ['Decline', 'Approve once']) {
		const button = [...interaction.querySelectorAll('button')].find(button => button.textContent === label)!;
		button.click();
	}
	assert.deepEqual(responses, [{ type: 'approval', response: { decision: 'decline' } }, { type: 'approval', response: { decision: 'approveOnce' } }]);
	part.render({ ...state, interaction: undefined });
	assert.equal(interaction.childElementCount, 0);
	assert.equal((interaction as HTMLElement).hidden, true);
});


test('Chat input retry restores the original Skill revision and backward selection', async () => {
	const failure = new DeferredPromise<void>();
	const sent: unknown[] = [];
	using part = inputPart(sharedNotifications, undefined, 'agent', {
		send: async (_text, _mode, skills) => {
			sent.push(skills);
			if (sent.length === 1) await failure.p;
		}
	});
	const state: ChatInputState = { mode: 'agent', queuedMessages: 0, approvalMode: 'manual', phase: 'ready', canInterrupt: false, models: [], isAutomaticModel: true, slashCommands: [], skillSelectors: [], canSelectAgent: false };
	const skill = (digest: string): ChatInputState['skillSelectors'][number] => ({ name: 'commit', description: 'Commit changes', source: 'user', skill: { id: { source: 'user:skill-source:test', name: 'commit' }, version: { type: 'pinnedDigest', digest } } });
	part.render({ ...state, skillSelectors: [skill('original')] });
	edit(part, '$commit review');
	const input = part.element.querySelector('textarea')!;
	input.setSelectionRange(2, 7, 'backward');
	const sending = part.acceptInput();
	part.render({ ...state, skillSelectors: [skill('updated')] });
	const rejected = assert.rejects(sending, /Request failed/u);
	await failure.error(new Error('Request failed'));
	await rejected;
	assert.equal(input.value, '$commit review');
	assert.deepEqual([input.selectionStart, input.selectionEnd, input.selectionDirection], [2, 7, 'backward']);
	await part.acceptInput();
	assert.deepEqual(sent, [[skill('original').skill], [skill('original').skill]]);
});

for (const layout of [undefined, 'compact'] as const) for (const outcome of ['success', 'failure'] as const) for (const replacement of ['attachment', 'emptied'] as const) test(`Submission cleanup preserves a draft created by its change listener (${layout ?? 'default'}, ${outcome}, ${replacement})`, async () => {
	const reply = new DeferredPromise<void>();
	const sent: string[] = [];
	using part = inputPart(sharedNotifications, undefined, 'agent', {
		send: async text => { sent.push(text); await reply.p; },
	}, undefined, undefined, undefined, layout);
	part.render({ mode: 'agent', queuedMessages: 0, approvalMode: 'manual', phase: 'ready', canInterrupt: false, models: [], isAutomaticModel: true, slashCommands: [], skillSelectors: [], canSelectAgent: false });
	edit(part, 'Original request');
	part.addContext({ id: 'old', kind: 'file', name: 'old.txt', resolve: async () => ({ name: 'old.txt', content: 'Original capture' }) });
	const original = (await part.captureDraft())!.draft;
	let replaced = false;
	using changed = part.onDidChangeInputForTest(() => {
		if (replaced || part.element.querySelector('textarea')!.value !== '') return;
		replaced = true;
		edit(part, 'Next request');
		if (replacement === 'attachment') {
			part.addContext({ id: 'next', kind: 'file', name: 'next.txt', resolve: async () => ({ name: 'next.txt', content: 'Next capture' }) });
		} else {
			edit(part, '');
		}
	});
	const sending = part.acceptInput();
	const settled = outcome === 'failure' ? assert.rejects(sending, /Original rejected/u) : sending;
	assert.equal(replaced, true);
	if (outcome === 'failure') await reply.error(new Error('Original rejected'));
	else await reply.complete();
	await settled;
	assert.deepEqual(sent, [original.text]);
	if (replacement === 'attachment') {
		const next = (await part.captureDraft())!.draft;
		assert.equal(next.text, 'Next request next.txt ');
		assert.deepEqual(next.contexts.map(context => ({ id: context.id, content: context.content })), [{ id: 'next', content: 'Next capture' }]);
	} else {
		assert.equal(part.element.querySelector('textarea')!.value, '');
		assert.equal(await part.captureDraft(), undefined);
	}
});

for (const layout of [undefined, 'compact'] as const) test(`Failed submission publishes one complete restored draft (${layout ?? 'default'})`, async () => {
	const reply = new DeferredPromise<void>();
	using part = inputPart(sharedNotifications, undefined, 'agent', { send: () => reply.p }, undefined, undefined, undefined, layout);
	part.render({ mode: 'agent', queuedMessages: 0, approvalMode: 'manual', phase: 'ready', canInterrupt: false, models: [], isAutomaticModel: true, slashCommands: [], skillSelectors: [], canSelectAgent: false });
	edit(part, 'Original request');
	part.addContext({ id: 'original-file', kind: 'file', name: 'original.txt', resolve: async () => ({ name: 'original.txt', content: 'Original capture' }) });
	const input = part.element.querySelector('textarea')!;
	input.setSelectionRange(2, 7, 'backward');
	const originalText = input.value;
	const sending = assert.rejects(part.acceptInput(), /Original rejected/u);
	const restored: { ids: string[]; selection: (number | string | null)[]; }[] = [];
	using changed = part.onDidChangeInputForTest(() => {
		if (input.value === originalText) restored.push({ ids: [...part.attachmentModel.getAttachmentIDs()], selection: [input.selectionStart, input.selectionEnd, input.selectionDirection] });
	});
	await reply.error(new Error('Original rejected'));
	await sending;
	assert.ok(restored.length > 0);
	for (const snapshot of restored) assert.deepEqual(snapshot, { ids: ['original-file'], selection: [2, 7, 'backward'] });
	assert.equal((await part.captureDraft())!.draft.contexts[0]!.content, 'Original capture');
});

for (const stage of ['clear', 'recovery'] as const) test(`Disposing the composer from its ${stage} notification retires submission cleanly`, async () => {
	const reply = new DeferredPromise<void>();
	let sends = 0;
	using part = inputPart(sharedNotifications, undefined, 'agent', { send: async () => { sends++; await reply.p; } });
	part.render({ mode: 'agent', queuedMessages: 0, approvalMode: 'manual', phase: 'ready', canInterrupt: false, models: [], isAutomaticModel: true, slashCommands: [], skillSelectors: [], canSelectAgent: false });
	edit(part, 'Original request');
	using changed = part.onDidChangeInputForTest(() => {
		const value = part.element.querySelector('textarea')?.value;
		if (stage === 'clear' ? value === '' : sends === 1 && value === 'Original request') part.dispose();
	});
	const sending = part.acceptInput();
	if (stage === 'recovery') {
		const rejected = assert.rejects(sending, /Original rejected/u);
		await reply.error(new Error('Original rejected'));
		await rejected;
	} else {
		await reply.complete();
		await sending;
		assert.equal(sends, 0);
	}
	assert.equal(part.element.isConnected, false);
});

test('Chat input failure does not restore over a new draft that was edited and emptied', async () => {
	const failure = new DeferredPromise<void>();
	using part = inputPart(sharedNotifications, undefined, 'agent', { send: () => failure.p });
	part.render({ mode: 'agent', queuedMessages: 0, approvalMode: 'manual', phase: 'ready', canInterrupt: false, models: [], isAutomaticModel: true, slashCommands: [], skillSelectors: [], canSelectAgent: false });
	const sending = part.acceptInput('Original');
	edit(part, 'New draft');
	edit(part, '');
	const rejected = assert.rejects(sending, /Request failed/u);
	await failure.error(new Error('Request failed'));
	await rejected;
	assert.equal(part.element.querySelector('textarea')!.value, '');
});

test('Chat input waits for file preparation before sending its inline reference and snapshot', async () => {
	using globals = installEditorTestGlobals({ FileReader: browserEnvironment.window.FileReader });
	const sent: string[] = [];
	using part = inputPart(sharedNotifications, undefined, 'agent', {
		send: async (text, _mode, _skills, contexts) => {
			assert.equal(text, 'input.txt ');
			for (const context of contexts ?? []) sent.push((await context.resolve()).content);
		}
	});
	part.render({ mode: 'agent', queuedMessages: 0, approvalMode: 'manual', phase: 'ready', canInterrupt: false, models: [], isAutomaticModel: true, slashCommands: [], skillSelectors: [], canSelectAgent: false });
	const attaching = part.attachFiles([new browserEnvironment.window.File(['file contents'], 'input.txt', { type: 'text/plain' })]);
	const sending = part.acceptInput();
	assert.deepEqual(sent, []);
	await Promise.all([attaching, sending]);
	assert.deepEqual(sent, ['file contents']);
	assert.equal(part.element.querySelector('.ash-chat-input-attachments'), null);
});

for (const layout of [undefined, 'compact'] as const) test(`Submission blocked during attachment preparation retains the draft for retry (${layout ?? 'default'})`, async () => {
	const prepared = new DeferredPromise<readonly ChatContextAttachment[]>();
	const sent: { text: string; contents: string[]; }[] = [];
	using notifications = new TestNotificationService();
	using part = inputPart(notifications, undefined, 'agent', {
		send: async (text, _mode, _skills, contexts) => {
			sent.push({ text, contents: await Promise.all((contexts ?? []).map(async context => (await context.resolve()).content)) });
		},
	}, undefined, undefined, undefined, layout);
	const ready: ChatInputState = { mode: 'agent', queuedMessages: 0, approvalMode: 'manual', phase: 'ready', canInterrupt: false, models: [], isAutomaticModel: true, slashCommands: [], skillSelectors: [], canSelectAgent: false };
	part.render(ready);
	edit(part, 'Keep this task');
	const acquiring = part.acquireContext(() => prepared.p);
	const sending = part.acceptInput();
	part.render({ ...ready, inputBlocked: true });
	await prepared.complete([{ id: 'held-file', kind: 'file', name: 'held.txt', resolve: async () => ({ name: 'held.txt', content: 'Captured content' }) }]);
	await Promise.all([acquiring, sending]);
	assert.deepEqual(sent, []);
	const draft = (await part.captureDraft())!.draft;
	assert.equal(draft.text, 'Keep this task held.txt ');
	assert.deepEqual(draft.contexts.map(context => context.content), ['Captured content']);
	assert.deepEqual(notifications.model.getNotifications(), []);
	part.render(ready);
	assert.deepEqual(sent, []);
	await part.acceptInput();
	assert.deepEqual(sent, [{ text: draft.text, contents: ['Captured content'] }]);
});

for (const layout of [undefined, 'compact'] as const) for (const input of [
	{ text: 'Keep this task', kind: 'message' },
	{ text: '/compact', kind: 'server command' },
	{ text: '/config', kind: 'local command' },
]) test(`Submission blocked during dictation finalization respects ${input.kind} eligibility (${layout ?? 'default'})`, async () => {
	const stopping = new DeferredPromise<void>();
	const finalization = new DeferredPromise<void>();
	const calls: string[] = [];
	using part = inputPart(sharedNotifications, {
		start: async () => ({
			stop: async () => { void stopping.complete(); await finalization.p; },
			cancel: async () => { },
		}),
	}, 'agent', {
		send: async () => { calls.push('message'); },
		executeServerCommand: async () => { calls.push('server command'); },
		executeCommand: async () => { calls.push('local command'); },
	}, undefined, undefined, undefined, layout);
	const ready: ChatInputState = { mode: 'agent', queuedMessages: 0, approvalMode: 'manual', phase: 'ready', canInterrupt: false, models: [], isAutomaticModel: true, slashCommands: [{ name: 'compact', description: 'Compact context', argumentMode: 'none' }], skillSelectors: [], canSelectAgent: false };
	part.render(ready);
	// Start capture while the draft is empty; slash commands intentionally hide the microphone.
	part.element.querySelector<HTMLButtonElement>('[data-action-id="workbench.action.chat.toggleSpeechToText"] button')!.click();
	await new Promise(resolve => setTimeout(resolve, 0));
	edit(part, input.text);
	const sending = part.acceptInput();
	await stopping.p;
	part.render({ ...ready, inputBlocked: true });
	await finalization.complete();
	await sending;
	if (input.kind === 'local command') {
		assert.deepEqual(calls, ['local command']);
	} else {
		assert.deepEqual(calls, []);
		assert.equal(part.element.querySelector('textarea')!.value, input.text);
		part.render(ready);
		assert.deepEqual(calls, []);
		await part.acceptInput();
		assert.deepEqual(calls, [input.kind]);
	}
});

test('Failed file preparation blocks the waiting send and notifies once while preserving the draft', async () => {
	using globals = installEditorTestGlobals({ FileReader: browserEnvironment.window.FileReader });
	using notifications = new TestNotificationService();
	const messages: string[] = [];
	using listener = notifications.model.onDidAdd(message => messages.push(message.message));
	let sends = 0;
	using part = inputPart(notifications, undefined, 'agent', { send: async () => { sends++; } });
	part.render({ mode: 'agent', queuedMessages: 0, approvalMode: 'manual', phase: 'ready', canInterrupt: false, models: [], isAutomaticModel: true, slashCommands: [], skillSelectors: [], canSelectAgent: false });
	edit(part, 'Keep original');
	const attaching = part.attachFiles([new browserEnvironment.window.File(['\0binary'], 'bad.bin')]);
	await assert.rejects(part.acceptInput(), /must contain nonempty UTF-8 text/u);
	await attaching;
	assert.equal(sends, 0);
	assert.equal(part.element.querySelector('textarea')!.value, 'Keep original');
	assert.equal(messages.length, 1);
});

test('Hiding an input cancels pending file preparation without sending or notifying', async () => {
	using globals = installEditorTestGlobals({ FileReader: browserEnvironment.window.FileReader });
	using notifications = new TestNotificationService();
	let errors = 0;
	using listener = notifications.model.onDidAdd(() => { errors++; });
	let sends = 0;
	using part = inputPart(notifications, undefined, 'agent', { send: async () => { sends++; } });
	part.render({ mode: 'agent', queuedMessages: 0, approvalMode: 'manual', phase: 'ready', canInterrupt: false, models: [], isAutomaticModel: true, slashCommands: [], skillSelectors: [], canSelectAgent: false });
	const attaching = part.attachFiles([new browserEnvironment.window.File(['file contents'], 'input.txt')]);
	const sending = assert.rejects(part.acceptInput(), isCancellationError);
	part.setVisible(false);
	await Promise.all([attaching, sending]);
	part.setVisible(true);
	assert.equal(sends, 0);
	assert.equal(errors, 0);
	assert.equal(await part.captureDraft(), undefined);
});


test('Editing a draft during file preparation cancels the waiting send and keeps both file references', async () => {
	using globals = installEditorTestGlobals({ FileReader: browserEnvironment.window.FileReader });
	const sent: { text: string; contents: string[]; }[] = [];
	using part = inputPart(sharedNotifications, undefined, 'agent', {
		send: async (text, _mode, _skills, contexts) => {
			sent.push({ text, contents: await Promise.all((contexts ?? []).map(async context => (await context.resolve()).content)) });
		}
	});
	part.render({ mode: 'agent', queuedMessages: 0, approvalMode: 'manual', phase: 'ready', canInterrupt: false, models: [], isAutomaticModel: true, slashCommands: [], skillSelectors: [], canSelectAgent: false });
	edit(part, 'Original request');
	const first = part.attachFiles([new browserEnvironment.window.File(['first contents'], 'first.txt')]);
	const sending = part.acceptInput();
	edit(part, 'Next request');
	const next = part.attachFiles([new browserEnvironment.window.File(['next contents'], 'next.txt')]);
	await Promise.all([first, sending, next]);
	assert.deepEqual(sent, []);
	const draft = await part.captureDraft();
	assert.equal(draft?.draft.text, 'Next request first.txt next.txt ');
	assert.deepEqual(draft?.draft.contexts.map(context => context.name), ['first.txt', 'next.txt']);
	await part.acceptInput();
	assert.deepEqual(sent, [{ text: 'Next request first.txt next.txt ', contents: ['first contents', 'next contents'] }]);
});


test('Disposing an input during preparation cancels sending without creating new UI', async () => {
	using globals = installEditorTestGlobals({ FileReader: browserEnvironment.window.FileReader });
	using notifications = new TestNotificationService();
	let sends = 0;
	const part = inputPart(notifications, undefined, 'agent', { send: async () => { sends++; } });
	part.render({ mode: 'agent', queuedMessages: 0, approvalMode: 'manual', phase: 'ready', canInterrupt: false, models: [], isAutomaticModel: true, slashCommands: [], skillSelectors: [], canSelectAgent: false });
	const attaching = part.attachFiles([new browserEnvironment.window.File(['file contents'], 'input.txt')]);
	const rejected = assert.rejects(part.acceptInput(), isCancellationError);
	part.dispose();
	await Promise.all([attaching, rejected]);
	assert.equal(sends, 0);
	assert.equal(part.element.isConnected, false);
	assert.deepEqual(notifications.model.getNotifications(), []);
});


test('A local settings command executes while file context is still being prepared', async () => {
	using globals = installEditorTestGlobals({ FileReader: browserEnvironment.window.FileReader });
	const commands: string[] = [];
	using part = inputPart(sharedNotifications, undefined, 'agent', { executeCommand: async invocation => { commands.push(invocation.commandId); } });
	const attaching = part.attachFiles([new browserEnvironment.window.File(['following context'], 'following.txt')]);
	const command = part.acceptInput('/config');
	assert.equal(commands.length, 1);
	await Promise.all([command, attaching]);
	const draft = await part.captureDraft();
	assert.equal(draft?.draft.text, 'following.txt ');
	assert.deepEqual(draft?.draft.contexts.map(context => context.name), ['following.txt']);
});


test('Pending attachment-only context exposes mouse Send and waits for acquisition', async () => {
	const preparation = new DeferredPromise<readonly Parameters<ChatInputPart['addContext']>[0][]>();
	const delivered = new DeferredPromise<void>();
	const sent: { text: string; contents: string[]; }[] = [];
	using part = inputPart(sharedNotifications, undefined, 'agent', {
		send: async (text, _mode, _skills, contexts) => {
			sent.push({ text, contents: await Promise.all((contexts ?? []).map(async context => (await context.resolve()).content)) });
			await delivered.complete();
		}
	});
	part.render({ mode: 'agent', queuedMessages: 0, approvalMode: 'manual', phase: 'ready', canInterrupt: false, models: [], isAutomaticModel: true, slashCommands: [], skillSelectors: [], canSelectAgent: false });
	const acquiring = part.acquireContext(() => preparation.p);
	const send = part.element.querySelector<HTMLButtonElement>('[data-action-id="ash.chat.input.send"] button');
	assert.ok(send);
	assert.equal(send.disabled, false);
	assert.equal(part.element.querySelector('[data-action-id="ash.chat.input.voice"]'), null);
	send.click();
	assert.equal(part.element.querySelector<HTMLButtonElement>('[data-action-id="ash.chat.input.send"] button')?.disabled, true);
	assert.deepEqual(sent, []);
	await preparation.complete([{ id: 'held-file', kind: 'file', name: 'held.txt', resolve: async () => ({ name: 'held.txt', content: 'held attachment contents' }) }]);
	await acquiring;
	await delivered.p;
	assert.deepEqual(sent, [{ text: 'held.txt ', contents: ['held attachment contents'] }]);
});

test('Canceling pending attachment-only context restores the empty mouse toolbar', async () => {
	const preparation = new DeferredPromise<readonly Parameters<ChatInputPart['addContext']>[0][]>();
	const controller = new AbortController();
	using part = inputPart(sharedNotifications);
	part.render({ mode: 'agent', queuedMessages: 0, approvalMode: 'manual', phase: 'ready', canInterrupt: false, models: [], isAutomaticModel: true, slashCommands: [], skillSelectors: [], canSelectAgent: false });
	const acquiring = part.acquireContext(() => preparation.p, controller.signal);
	const rejected = assert.rejects(acquiring, isCancellationError);
	assert.equal(part.element.querySelector<HTMLButtonElement>('[data-action-id="ash.chat.input.send"] button')?.disabled, false);
	controller.abort();
	await rejected;
	assert.equal(part.element.querySelector('[data-action-id="ash.chat.input.send"]'), null);
	assert.equal(part.element.querySelector<HTMLButtonElement>('[data-action-id="ash.chat.input.voice"] button')?.disabled, true);
	await preparation.complete([]);
});


test('A retired composer cannot restore its failed request into the reopened blank draft', async () => {
	const reply = new DeferredPromise<void>();
	const dispatched = new DeferredPromise<void>();
	using part = inputPart(sharedNotifications, undefined, 'agent', { send: async () => { await dispatched.complete(); await reply.p; } });
	part.render({ mode: 'agent', queuedMessages: 0, approvalMode: 'manual', phase: 'ready', canInterrupt: false, models: [], isAutomaticModel: true, slashCommands: [], skillSelectors: [], canSelectAgent: false });
	const sending = part.acceptInput('Request for the previous composer');
	const rejected = assert.rejects(sending, /Retired request failed/u);
	try {
		await dispatched.p;
		part.setVisible(false);
		part.setVisible(true);
		assert.equal(part.element.querySelector('textarea')!.value, '');
		await reply.error(new Error('Retired request failed'));
		await rejected;
		assert.equal(part.element.querySelector('textarea')!.value, '');
	} finally {
		await reply.error(new Error('Retired request failed'));
		await rejected;
	}
});


test('A reopened composer keeps its send locked when the retired send settles', async () => {
	const previousReply = new DeferredPromise<void>();
	const nextReply = new DeferredPromise<void>();
	const nextDispatched = new DeferredPromise<void>();
	const sent: string[] = [];
	using part = inputPart(sharedNotifications, undefined, 'agent', {
		send: async text => {
			sent.push(text);
			if (text === 'Previous request') await previousReply.p;
			else { await nextDispatched.complete(); await nextReply.p; }
		},
	});
	part.render({ mode: 'agent', queuedMessages: 0, approvalMode: 'manual', phase: 'ready', canInterrupt: false, models: [], isAutomaticModel: true, slashCommands: [], skillSelectors: [], canSelectAgent: false });
	const previous = assert.rejects(part.acceptInput('Previous request'), /Retired request failed/u);
	part.setVisible(false);
	part.setVisible(true);
	const next = part.acceptInput('Next request');
	try {
		await nextDispatched.p;
		await previousReply.error(new Error('Retired request failed'));
		await previous;
		await part.acceptInput('Duplicate next request');
		assert.deepEqual(sent, ['Previous request', 'Next request']);
		assert.equal(part.element.querySelector('textarea')!.value, '');
	} finally {
		await previousReply.error(new Error('Retired request failed'));
		await nextReply.complete();
		await Promise.all([previous, next]);
	}
});

test('An acknowledged handoff from a retired composer cannot clear the reopened draft', async () => {
	using part = inputPart(sharedNotifications);
	edit(part, 'Retained draft');
	const previous = await part.captureDraft();
	part.setVisible(false);
	part.setVisible(true);
	previous!.clear();
	assert.equal(part.element.querySelector('textarea')!.value, 'Retained draft');
});

test('Draft context resolved after retirement does not produce a new handoff', async () => {
	const resolving = new DeferredPromise<{ name: string; content: string; }>();
	using part = inputPart(sharedNotifications);
	edit(part, 'Retained draft');
	part.addContext({ id: 'slow-context', kind: 'file', name: 'slow.txt', resolve: () => resolving.p });
	const capturing = part.captureDraft();
	part.setVisible(false);
	part.setVisible(true);
	await resolving.complete({ name: 'slow.txt', content: 'Previous context' });
	assert.equal(await capturing, undefined);
	assert.equal(part.element.querySelector('textarea')!.value, 'Retained draft slow.txt ');
});

for (const submission of [
	{ kind: 'message', text: 'Old message' },
	{ kind: 'local command', text: '/config' },
	{ kind: 'server command', text: '/compact' },
]) {
	test(`Retiring input during synchronous draft clearing blocks the old ${submission.kind}`, async () => {
		const calls: string[] = [];
		using part = inputPart(sharedNotifications, undefined, 'agent', {
			send: async () => { calls.push('message'); },
			executeCommand: async () => { calls.push('local command'); },
			executeServerCommand: async () => { calls.push('server command'); },
		});
		part.render({ mode: 'agent', queuedMessages: 0, approvalMode: 'manual', phase: 'ready', canInterrupt: false, models: [], isAutomaticModel: true, slashCommands: [{ name: 'compact', description: 'Compact context', argumentMode: 'none' }], skillSelectors: [], canSelectAgent: false });
		edit(part, submission.text);
		let retired = false;
		using transition = part.onDidChangeInputForTest(() => {
			if (!retired && part.element.querySelector<HTMLTextAreaElement>('textarea')!.value === '') {
				retired = true;
				part.invalidatePendingInput();
				edit(part, 'New thread draft');
			}
		});
		await part.acceptInput();
		assert.equal(retired, true);
		assert.deepEqual(calls, []);
		assert.equal(part.element.querySelector<HTMLTextAreaElement>('textarea')!.value, 'New thread draft');
	});
}


test('Live App context survives inline draft submission and is revoked by its owning source', async () => {
	const sent: string[][] = [];
	using part = inputPart(sharedNotifications, undefined, 'agent', {
		send: async (_text, _mode, _skills, contexts) => { sent.push(await Promise.all((contexts ?? []).map(async context => (await context.resolve()).content))); },
	});
	part.render({ mode: 'agent', queuedMessages: 0, approvalMode: 'manual', phase: 'ready', canInterrupt: false, models: [], isAutomaticModel: true, slashCommands: [], skillSelectors: [], canSelectAgent: false });
	edit(part, 'First request');
	part.attachmentModel.addContext({ id: 'app', kind: 'mcpApp', lifetime: 'source', name: 'App context', resolve: async () => ({ name: 'App context', content: 'first source state' }) });
	await part.acceptInput();
	assert.equal(part.attachmentModel.size, 1);
	part.attachmentModel.addContext({ id: 'app', kind: 'mcpApp', lifetime: 'source', name: 'App context', resolve: async () => ({ name: 'App context', content: 'updated source state' }) });
	part.appendToDraft('Next request');
	await part.acceptInput();
	part.attachmentModel.delete('app');
	edit(part, 'Without App');
	await part.acceptInput();
	assert.deepEqual(sent, [['first source state'], ['updated source state'], []]);
});

test('Draft handoff carries user context and leaves source-owned App context with its producer', async () => {
	using part = inputPart(sharedNotifications);
	let sourceReads = 0;
	const source = { id: 'app', kind: 'mcpApp', lifetime: 'source' as const, name: 'App context', resolve: async () => { sourceReads++; return { name: 'App context', content: 'Live source context' }; } };
	edit(part, 'User draft');
	part.addContext(source);
	part.addContext({ id: 'file', kind: 'file', name: 'file.ts', resolve: async () => ({ name: 'file.ts', content: 'User file' }) });
	const captured = await part.captureDraft();
	assert.ok(captured);
	assert.deepEqual(captured.draft, {
		mode: 'agent', text: 'User draft  file.ts ',
		contexts: [{ id: 'file', kind: 'file', name: 'file.ts', content: 'User file', reference: { start: 12, end: 19 } }],
	});
	assert.equal(sourceReads, 0);
	using target = inputPart(sharedNotifications);
	target.restoreDraft(captured.draft);
	assert.deepEqual((await target.captureDraft())?.draft, captured.draft);
	captured.clear();
	assert.deepEqual(part.attachmentModel.attachments, [source]);
	assert.equal(await part.captureDraft(), undefined);
	assert.equal(sourceReads, 0);
});


test('permission requests approve only selected capabilities and can shorten the lifetime', async () => {
	const responses: unknown[] = [];
	using part = inputPart(sharedNotifications, undefined, 'agent', { resolveInteraction: async response => { responses.push(response); } });
	const state: ChatInputState = {
		mode: 'agent', queuedMessages: 0, approvalMode: 'manual', phase: 'ready', canInterrupt: false, models: [], isAutomaticModel: true, slashCommands: [], skillSelectors: [], canSelectAgent: false,
		interaction: {
			requestId: 'permissions-1', request: {
				type: 'permissions', request: {
					environmentId: 'local', reason: 'Read the requested files', duration: 'session',
					directories: [{ path: '/workspace/<img src=x>', permissions: ['readFiles', 'writeFiles'] }], networkHosts: ['api.example.test'],
				}
			}
		},
	};
	part.render(state);
	const interaction = part.element.querySelector('.ash-chat-interaction')!;
	assert.equal(interaction.querySelector('img'), null);
	const checkboxes = [...interaction.querySelectorAll<HTMLInputElement>('input[type=checkbox]')];
	assert.deepEqual(checkboxes.map(input => input.checked), [false, false, false]);
	checkboxes[0].checked = true;
	checkboxes[0].focus();
	part.render({ ...state, queuedMessages: 1 });
	assert.equal(document.activeElement, checkboxes[0]);
	assert.equal(interaction.querySelector<HTMLSelectElement>('select')!.value, 'turn');
	interaction.querySelector<HTMLFormElement>('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
	assert.deepEqual(responses, [{ type: 'permissions', response: { duration: 'turn', directories: [{ path: '/workspace/<img src=x>', permissions: ['readFiles'] }], networkHosts: [] } }]);
});


test('approval exposes only offered reusable decisions and renders exact argv as text', async () => {
	const responses: unknown[] = [];
	using part = inputPart(sharedNotifications, undefined, 'agent', { resolveInteraction: async response => { responses.push(response); } });
	part.render({
		mode: 'agent', queuedMessages: 0, approvalMode: 'manual', phase: 'ready', canInterrupt: false, models: [], isAutomaticModel: true, slashCommands: [], skillSelectors: [], canSelectAgent: false,
		interaction: {
			requestId: 'reusable', request: {
				type: 'approval', request: {
					reason: 'Exact action', capabilities: [{ kind: 'processSpawn', scope: '/workspace' }],
					command: { program: '/bin/echo', arguments: ['<img src=x>', 'a b'] }, allowedDecisions: ['decline', 'approveOnce', 'approveForSession', 'approveAndSaveRule']
				}
			}
		},
	});
	const interaction = part.element.querySelector('.ash-chat-interaction')!;
	assert.equal(interaction.querySelector('pre')?.textContent, '/bin/echo ["<img src=x>","a b"]');
	assert.equal(interaction.querySelector('img'), null);
	for (const label of ['Approve same action this session', 'Save approval for this exact action']) {
		[...interaction.querySelectorAll('button')].find(button => button.textContent === label)!.click();
	}
	assert.deepEqual(responses, [{ type: 'approval', response: { decision: 'approveForSession' } }, { type: 'approval', response: { decision: 'approveAndSaveRule' } }]);
});

test('peer-chat navigation isolates drafts and references while first-send materialization retains the live draft', async () => {
	using part = inputPart(sharedNotifications);
	const state: ChatInputState = { mode: 'agent', queuedMessages: 0, approvalMode: 'manual', phase: 'ready', canInterrupt: false, models: [], isAutomaticModel: true, slashCommands: [], skillSelectors: [], canSelectAgent: false };
	part.render({ ...state, draftIdentity: { id: 'draft', generation: 0 } });
	part.appendToDraft('Original draft');
	part.addContext({ id: 'file', name: 'private.txt', kind: 'file', resolve: async () => ({ name: 'private.txt', content: 'Original file snapshot' }) });
	const original = (await part.captureDraft())!.draft;
	part.render({ ...state, draftIdentity: { id: 'root', generation: 0 } });
	assert.deepEqual((await part.captureDraft())!.draft, original);
	part.render({ ...state, draftIdentity: { id: 'peer', generation: 1 } });
	assert.equal(await part.captureDraft(), undefined);
	part.appendToDraft('Peer draft');
	part.render({ ...state, draftIdentity: { id: 'root', generation: 2 } });
	assert.deepEqual((await part.captureDraft())!.draft, original);
	part.render({ ...state, draftIdentity: { id: 'peer', generation: 3 } });
	assert.equal((await part.captureDraft())!.draft.text, 'Peer draft');
	assert.deepEqual((await part.captureDraft())!.draft.contexts, []);
});


for (const mode of ['ask', 'plan'] as const) test(`peer-chat round trips restore ${mode} drafts and send mode independently of approvals`, async () => {
	let state: ChatInputState = { mode, queuedMessages: 0, approvalMode: 'manual', phase: 'ready', canInterrupt: false, models: [], isAutomaticModel: true, slashCommands: [], skillSelectors: [], canSelectAgent: false, draftIdentity: { id: 'A', generation: 0 } };
	const requests: unknown[] = [];
	using part = inputPart(sharedNotifications, undefined, mode, {
		selectMode: selected => { state = { ...state, mode: selected }; part.render(state); },
		send: async (text, selected) => { requests.push({ text, mode: selected, approval: state.approvalMode }); },
	});
	part.render(state);
	part.appendToDraft('Draft A');
	state = { ...state, mode: 'agent', approvalMode: 'auto', draftIdentity: { id: 'B', generation: 1 } };
	part.render(state);
	part.appendToDraft('Draft B');
	state = { ...state, draftIdentity: { id: 'A', generation: 2 } };
	part.render(state);
	assert.equal(state.mode, mode, 'Restored mode is published to the owning model');
	assert.equal(state.approvalMode, 'auto', 'Draft restoration does not restore approval policy');
	assert.equal((await part.captureDraft())!.draft.mode, mode);
	state = { ...state, approvalMode: 'manual', draftIdentity: { id: 'B', generation: 3 } };
	part.render(state);
	assert.equal(state.mode, 'agent');
	await part.acceptInput();
	state = { ...state, draftIdentity: { id: 'A', generation: 4 } };
	part.render(state);
	await part.acceptInput();
	assert.deepEqual(requests, [{ text: 'Draft B', mode: 'agent', approval: 'manual' }, { text: 'Draft A', mode, approval: 'manual' }]);
});

test('persistent Chat drafts retire consumed attachments when an untitled composer is promoted', async () => {
	using changes = new Emitter<void>();
	const model = { threadId: undefined as string | undefined, untitledSessionId: 'draft-promotion', onDidChange: changes.event };
	const drafts = new Map<string, Parameters<IChatDraftStorage['write']>[1]>();
	using part = inputPart(sharedNotifications, undefined, 'agent', {
		send: async () => { model.threadId = 'promoted-thread'; changes.fire(); },
	});
	part.bindDraftStorage(model as IChatWidgetModel, {
		read: id => drafts.get(id), write: (id, draft) => { drafts.set(id, draft); }, flush: async () => { },
	}, AshEvent.None);
	part.render({ mode: 'agent', queuedMessages: 0, approvalMode: 'manual', phase: 'ready', canInterrupt: false, models: [], isAutomaticModel: true, slashCommands: [], skillSelectors: [], canSelectAgent: false });
	edit(part, 'Consume this snapshot');
	part.addContext({ id: 'consumed', kind: 'file', name: 'consumed.txt', resolve: async () => ({ name: 'consumed.txt', content: 'Consumed snapshot' }) });
	await part.acceptInput();
	await Promise.resolve();
	assert.equal(drafts.get('untitled:draft-promotion'), undefined);
	assert.deepEqual(drafts.get('promoted-thread'), { mode: 'agent', text: '', contexts: [] });
	assert.equal(await part.captureDraft(), undefined);
});

test('an untouched empty Chat composer does not join a global storage flush on shutdown', () => {
	using shutdown = new Emitter<IWillShutdownEvent>();
	using part = inputPart(sharedNotifications);
	part.bindDraftStorage({ threadId: 'empty-thread', onDidChange: AshEvent.None } as IChatWidgetModel, {
		read: () => undefined,
		write: () => { assert.fail('No draft changed'); },
		flush: async () => { assert.fail('No draft needs flushing'); },
	}, shutdown.event);
	shutdown.fire({ reason: 'windowClose', join: () => { assert.fail('Empty composer must not block shutdown'); } });
});

test('Chat shutdown waits for file preparation and retains the draft when the storage flush fails', async () => {
	using globals = installEditorTestGlobals({ FileReader: browserEnvironment.window.FileReader });
	using shutdown = new Emitter<IWillShutdownEvent>();
	const drafts = new Map<string, Parameters<IChatDraftStorage['write']>[1]>();
	let flushes = 0;
	let sends = 0;
	using part = inputPart(sharedNotifications, undefined, 'agent', { send: async () => { sends++; } });
	part.bindDraftStorage({ threadId: 'shutdown-thread', onDidChange: AshEvent.None } as IChatWidgetModel, {
		read: id => drafts.get(id), write: (id, draft) => { drafts.set(id, draft); },
		flush: async () => { if (++flushes === 1) throw new Error('Storage unavailable'); },
	}, shutdown.event);
	edit(part, 'Keep my pending file');
	const attaching = part.attachFiles([new browserEnvironment.window.File(['Pending file snapshot'], 'shutdown.txt', { type: 'text/plain' })]);
	const operations: Promise<unknown>[] = [];
	const join = (operation: Promise<unknown> | (() => Promise<unknown>)): void => { operations.push(typeof operation === 'function' ? operation() : operation); };
	shutdown.fire({ reason: 'windowClose', join });
	await assert.rejects(Promise.all(operations), /Storage unavailable/u);
	await attaching;
	const saved = drafts.get('shutdown-thread')!;
	assert.equal(saved.contexts[0]?.content, 'Pending file snapshot');
	assert.match(saved.text, /Keep my pending file/u);
	assert.deepEqual((await part.captureDraft())?.draft, saved);
	operations.length = 0;
	shutdown.fire({ reason: 'windowClose', join });
	await Promise.all(operations);
	assert.equal(flushes, 2);
	assert.equal(sends, 0);
});

test('a hidden cleared composer does not overwrite the active renderer draft during shutdown', async () => {
	using shutdown = new Emitter<IWillShutdownEvent>();
	const drafts = new Map<string, Parameters<IChatDraftStorage['write']>[1]>();
	using part = inputPart(sharedNotifications);
	part.bindDraftStorage({ threadId: 'shared-thread', onDidChange: AshEvent.None } as IChatWidgetModel, {
		read: id => drafts.get(id), write: (id, draft) => { drafts.set(id, draft); }, flush: async () => { },
	}, shutdown.event);
	edit(part, 'Transfer to the other renderer');
	const transferred = (await part.captureDraft())!;
	transferred.clear();
	part.setVisible(false);
	const activeDraft = { ...transferred.draft, text: 'Continue in the active renderer' };
	drafts.set('shared-thread', activeDraft);
	const operations: Promise<unknown>[] = [];
	shutdown.fire({ reason: 'windowClose', join: operation => { operations.push(typeof operation === 'function' ? operation() : operation); } });
	await Promise.all(operations);
	assert.deepEqual(drafts.get('shared-thread'), activeDraft);
});
suite('chatInput browser component', () => {
	const browserTests = useBrowserTests();
	for (const locale of ['en', 'zh-CN']) for (const nextDraft of ['restore', 'typed', 'reentrant', 'emptied'] as const) test(`Compact failed submission preserves the owned draft and selection (${nextDraft}, ${locale})`, async () => {
		const { page } = browserTests;
		await page.goto(`/chatInput.html?inlineCode&compact&holdSubmission&locale=${locale}`);
		await page.evaluate(() => window.ashChatInputIntegration.showModels());
		const input = page.locator('.ash-chat-input-container .stanza-editor-input');
		await input.pressSequentially('Original request');
		await page.evaluate(() => window.ashChatInputIntegration.addHistoryContext());
		const original = await page.evaluate(() => window.ashChatInputIntegration.dropState().text);
		await input.press('Home');
		for (let i = 0; i < 7; i++) await input.press('ArrowRight');
		for (let i = 0; i < 5; i++) await input.press('Shift+ArrowLeft');
		expect(await page.evaluate(() => window.ashChatInputIntegration.inputSelection())).toEqual({ anchor: 7, active: 2 });
		if (nextDraft === 'reentrant') await page.evaluate(() => window.ashChatInputIntegration.replaceDraftOnClear());
		await input.press('Enter');
		await expect.poll(() => page.evaluate(() => window.ashChatInputIntegration.recoveryState().pending)).toBe(true);
		await expect.poll(() => page.evaluate(() => window.ashChatInputIntegration.dropState().text)).toBe(nextDraft === 'reentrant' ? 'Next request next.txt ' : '');
		if (nextDraft === 'typed' || nextDraft === 'emptied') {
			await input.pressSequentially('Next typed draft');
			if (nextDraft === 'typed') await page.evaluate(() => window.ashChatInputIntegration.addHistoryContext());
			else { await input.press('ControlOrMeta+A'); await input.press('Backspace'); }
		}
		const nextSelection = await page.evaluate(() => window.ashChatInputIntegration.inputSelection());
		const text = nextDraft === 'restore' ? original : nextDraft === 'reentrant' ? 'Next request next.txt ' : nextDraft === 'typed' ? 'Next typed draft draft.txt ' : '';
		await page.evaluate(() => window.ashChatInputIntegration.finishSubmission('Controlled rejection'));
		await expect.poll(() => page.evaluate(() => window.ashChatInputIntegration.dropState().text)).toBe(text);
		expect(await page.evaluate(() => window.ashChatInputIntegration.inputSelection())).toEqual(nextDraft === 'restore' ? { anchor: 7, active: 2 } : nextSelection);
		const contexts = nextDraft === 'emptied' ? [] : [{ name: nextDraft === 'reentrant' ? 'next.txt' : 'draft.txt', content: nextDraft === 'reentrant' ? 'Next captured content' : 'synthetic context' }];
		await expect.poll(() => page.evaluate(() => {
			const draft = window.ashChatInputIntegration.recoveryState().drafts.at(-1)!;
			return { text: draft.text, contexts: draft.contexts.map(context => ({ name: context.name, content: context.content })) };
		})).toEqual({ text, contexts });
		expect(await page.evaluate(() => window.ashChatInputIntegration.historyState())).toMatchObject({ submissions: [{ text: original }] });
		await expect(input).toBeFocused();
		await expect(page.locator('[data-action-id="ash.chat.input.send"]')).toHaveCount(0);
		if (text) {
			await input.press('Enter');
			await expect.poll(() => page.evaluate(() => window.ashChatInputIntegration.historyState())).toMatchObject({ submissions: [{ text: original }, { text }] });
			await expect.poll(() => page.evaluate(() => window.ashChatInputIntegration.dropState().text)).toBe('');
		}
	});

	for (const locale of ['en', 'zh-CN']) for (const stage of ['attachments', 'dictation'] as const) test(`Compact Enter retains the prepared draft when submission becomes blocked (${stage}, ${locale})`, async () => {
		const { page } = browserTests;
		await page.goto(`/chatInput.html?inlineCode&compact&contextSources&dropSources&dictation&locale=${locale}`);
		await page.evaluate(() => window.ashChatInputIntegration.showModels());
		const composer = page.locator('.ash-chat-input-container');
		const input = composer.locator('.stanza-editor-input');
		await input.pressSequentially('Review ');
		const microphone = composer.locator('[data-action-id="workbench.action.chat.toggleSpeechToText"] button');
		if (stage === 'attachments') {
			await dropResources(['file:///workspace/drop-pending.ts']);
			await expect.poll(() => page.evaluate(() => window.ashChatInputIntegration.dropState().pending)).toBe(true);
		} else {
			await microphone.click();
			await expect(microphone).toHaveAccessibleName(locale === 'en' ? 'Stop dictation' : '结束听写');
			await expect(microphone).toBeEnabled();
			await page.evaluate(() => window.ashChatInputIntegration.emitDictation('recognized task', false));
		}
		await input.press('Enter');
		if (stage === 'dictation') await expect.poll(() => page.evaluate(() => window.ashChatInputIntegration.dictationState().stops)).toBe(1);
		await page.evaluate(stage => {
			window.ashChatInputIntegration.setInputBlocked(true);
			if (stage === 'attachments') window.ashChatInputIntegration.releaseDropRead();
			else window.ashChatInputIntegration.finishDictation('recognized task');
		}, stage);
		const text = stage === 'attachments' ? 'Review drop-pending.ts ' : 'Review recognized task';
		await expect.poll(() => page.evaluate(() => window.ashChatInputIntegration.dropState().text)).toBe(text);
		await expect.poll(() => page.evaluate(() => window.ashChatInputIntegration.dropState().pending)).toBe(false);
		await expect(microphone).toHaveAccessibleName(locale === 'en' ? 'Dictate message' : '听写');
		expect(await page.evaluate(() => window.ashChatInputIntegration.historyState())).toMatchObject({ writes: [], submissions: [] });
		await expect(input).toBeEditable();
		await expect(input).toBeFocused();
		await expect(composer.locator('[data-action-id="ash.chat.input.send"]')).toHaveCount(0);
		await input.press('Enter');
		expect(await page.evaluate(() => window.ashChatInputIntegration.historyState())).toMatchObject({ writes: [], submissions: [] });
		await page.evaluate(() => window.ashChatInputIntegration.setInputBlocked(false));
		expect(await page.evaluate(() => window.ashChatInputIntegration.historyState())).toMatchObject({ submissions: [] });
		await input.press('Enter');
		await expect.poll(() => page.evaluate(() => window.ashChatInputIntegration.historyState())).toMatchObject({ submissions: [{ text }] });
		if (stage === 'attachments') await expect(page.getByLabel('Submission')).toContainText('first captured line');
		await expect.poll(() => page.evaluate(() => window.ashChatInputIntegration.dropState().text)).toBe('');
	});

	for (const outcome of ['success', 'empty', 'failure'] as const) test(`Rich compact input finalizes dictation before Enter submission (${outcome})`, async () => {
		const { page } = browserTests;
		await page.goto('/chatInput.html?inlineCode&compact&dictation');
		await page.evaluate(() => window.ashChatInputIntegration.showModels());
		const composer = page.locator('.ash-chat-input-container');
		const input = composer.locator('.stanza-editor-input');
		const microphone = composer.locator('[data-action-id="workbench.action.chat.toggleSpeechToText"] button');
		if (outcome === 'failure') {
			await input.focus();
			await page.keyboard.insertText('Keep this draft');
		}
		await microphone.click();
		await expect(microphone).toHaveAccessibleName('Stop dictation');
		await expect(microphone).toBeEnabled();
		await page.evaluate(() => window.ashChatInputIntegration.emitDictation('Still recognizing', false));
		await expect(page.locator('.ash-chat-dictation-preview')).toHaveText('Still recognizing');
		await expect(composer.locator('[data-action-id="ash.chat.input.send"]')).toHaveCount(0);
		await input.press('Enter');
		await expect.poll(() => page.evaluate(() => window.ashChatInputIntegration.dictationState().stops)).toBe(1);
		await input.press('Enter');
		const submissions = () => page.evaluate(() => (window.ashChatInputIntegration.historyState() as { submissions: { text: string; }[]; }).submissions.map(item => item.text));
		expect(await submissions()).toEqual([]);
		await page.evaluate(result => window.ashChatInputIntegration.finishDictation(
			result === 'success' ? 'Complete recognized task' : '', result === 'failure' ? 'Transcription unavailable' : undefined,
		), outcome);
		await expect(microphone).toHaveAccessibleName('Dictate message');
		if (outcome === 'success') {
			await expect.poll(submissions).toEqual(['Complete recognized task']);
		} else if (outcome === 'failure') {
			await expect.poll(() => page.evaluate(() => window.ashChatInputIntegration.dictationState().errors)).toEqual([expect.stringMatching(/Transcription unavailable/u)]);
			await expect(composer.locator('.view-lines')).toHaveText('Keep this draft');
			expect(await submissions()).toEqual([]);
			await input.press('Enter');
			await expect.poll(submissions).toEqual(['Keep this draft']);
		} else {
			expect(await submissions()).toEqual([]);
		}
		expect(await page.evaluate(() => window.ashChatInputIntegration.dictationState().stops)).toBe(1);
	});

	for (const locale of ['en', 'zh-CN']) for (const theme of ['light', 'dark', 'hcLight', 'hcDark']) test(`a corrupt saved image stays removable through undo, restore and clipboard in ${locale}, ${theme}`, async () => {
		const { page } = browserTests;
		const chinese = locale === 'zh-CN';
		await page.goto(`/chatInput.html?inlineCode=1&sendFailure=1&locale=${locale}&theme=${theme}`);
		await page.evaluate(() => window.ashChatInputIntegration.showModels());
		const input = page.getByRole('textbox', { name: 'Chat message', exact: true });
		await input.focus();
		await input.evaluate(element => {
			const transfer = new DataTransfer();
			const text = 'broken.png';
			transfer.setData('text/plain', text);
			transfer.setData('application/vnd.chat.attachment+json', JSON.stringify({
				version: 1, draft: {
					text, mode: 'agent', contexts: [{ id: 'broken', kind: 'image', name: text, content: 'data:image/png;base64,Y2FwdHVyZWQ=', reference: { start: 0, end: text.length } }],
				}
			}));
			element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
		});
		const message = chinese ? '无法预览：broken.png' : 'Preview unavailable: broken.png';
		const failed = page.getByRole('button', { name: message, exact: true });
		const remove = page.getByRole('button', { name: `${chinese ? '移除' : 'Remove'} broken.png`, exact: true });
		await expect(failed).toBeDisabled();
		await expect(page.locator('.ash-chat-image-reference-control')).toHaveAttribute('aria-busy', 'false');
		await expect(failed.locator('img')).toBeHidden();
		await input.press('Home');
		await input.press('Alt+Enter');
		await expect(page.locator('.ash-chat-image-reference-preview')).toHaveCount(0);
		await input.press('Tab');
		await expect(remove).toBeFocused();
		await remove.press('Delete');
		await expect(failed).toHaveCount(0);
		await expect(input).toBeFocused();
		await input.press('ControlOrMeta+z');
		await expect(failed).toBeDisabled();
		await input.press('ControlOrMeta+Shift+z');
		await expect(failed).toHaveCount(0);
		await input.press('ControlOrMeta+z');
		await expect(failed).toBeDisabled();
		assert.equal(await page.evaluate(() => window.ashChatInputIntegration.restoreCapturedDraft()), 'broken.png');
		await expect(failed).toBeDisabled();
		await input.press('ControlOrMeta+a');
		const copied = await input.evaluate(element => {
			const transfer = new DataTransfer();
			element.dispatchEvent(new ClipboardEvent('copy', { clipboardData: transfer, bubbles: true, cancelable: true }));
			return transfer.types.map(type => [type, transfer.getData(type)]);
		});
		await input.press('Backspace');
		await input.evaluate((element, values) => {
			const transfer = new DataTransfer();
			for (const [type, value] of values) transfer.setData(type!, value!);
			element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
		}, copied);
		await expect(failed).toBeDisabled();
		await expect(page.locator('.ash-chat-image-reference-control')).toHaveAccessibleName(message);
		await expect(page.getByLabel('Submission')).toHaveText('');
		const help = await page.evaluate(() => window.ashChatInputIntegration.contextAccessibility().help);
		assert.match(help!, chinese ? /无法解码/u : /cannot be decoded/u);
		await input.press('Enter');
		await expect(page.getByLabel('Submission')).toContainText('data:image/png;base64,Y2FwdHVyZWQ=');
		await expect(failed).toBeDisabled();
	});
	async function dropResources(values: readonly string[]): Promise<{ prevented: boolean; overlay: boolean; }> {
		return browserTests.page.getByRole('textbox', { name: 'Chat message', exact: true }).evaluate((element, values) => {
			const dataTransfer = new DataTransfer();
			dataTransfer.setData('ResourceURLs', JSON.stringify(values));
			dataTransfer.setData('text/uri-list', values.join('\r\n'));
			element.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer }));
			const overlay = element.closest('form')!.querySelector<HTMLElement>('.ash-chat-drop-overlay')!;
			const visible = !overlay.hidden && overlay.getBoundingClientRect().width > 0 && getComputedStyle(overlay).pointerEvents === 'none';
			const event = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer });
			element.dispatchEvent(event);
			return { prevented: event.defaultPrevented, overlay: visible };
		}, values);
	}
	const mixedDropResources = [
		'file:///workspace/drop-file.ts', 'file:///workspace/drop-folder', 'file:///workspace/drop-image.png',
		'file:///workspace/drop-range.ts#2,1-2,7', 'file:///workspace/drop-file.ts',
	];
	for (const locale of ['en', 'zh-CN']) test(`mixed resource drop controls stay visible and keyboard accessible across themes in ${locale}`, async () => {
		const { page } = browserTests;
		for (const theme of ['dark', 'light', 'hcDark', 'hcLight']) {
			await page.goto(`/chatInput.html?inlineCode&contextSources&dropSources&locale=${locale}&theme=${theme}`);
			await page.evaluate(() => window.ashChatInputIntegration.showModels());
			const input = page.getByRole('textbox', { name: 'Chat message', exact: true });
			await input.pressSequentially('Review ');
			assert.deepEqual(await dropResources(mixedDropResources), { prevented: true, overlay: true });
			const references = page.locator('.ash-chat-input-editor-host [role="group"]');
			await expect(references).toHaveCount(4);
			await expect(input).toBeFocused();
			expect(await references.evaluateAll(elements => elements.map(element => {
				const box = element.getBoundingClientRect();
				const composer = element.closest('.ash-chat-input-container')!.getBoundingClientRect();
				return { visible: box.width > 0 && box.height > 0, contained: box.left >= composer.left && box.right <= composer.right && box.top >= composer.top && box.bottom <= composer.bottom };
			})), theme).toEqual(Array.from({ length: 4 }, () => ({ visible: true, contained: true })));
			await input.press('Tab');
			const open = page.getByRole('button', { name: `${locale === 'zh-CN' ? '打开' : 'Open'} drop-file.ts`, exact: true });
			await expect(open).toBeFocused();
			await expect(open).toHaveCSS('outline-style', 'solid');
		}
	});
	test('a resource URI drop captures through the existing composer and restores its snapshot with undo', async () => {
		const { page } = browserTests;
		await page.goto('/chatInput.html?inlineCode=1&contextSources=1');
		const input = page.getByRole('textbox', { name: 'Chat message', exact: true });
		await input.pressSequentially('Review ');
		const prevented = await input.evaluate(element => {
			const dataTransfer = new DataTransfer();
			dataTransfer.setData('ResourceURLs', JSON.stringify(['file:///workspace/dropped.ts']));
			dataTransfer.setData('text/uri-list', 'file:///workspace/dropped.ts');
			const event = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer });
			element.dispatchEvent(event);
			return event.defaultPrevented;
		});
		assert.equal(prevented, true);
		const source = page.getByRole('button', { name: 'Open dropped.ts', exact: true });
		await expect(source).toBeVisible();
		await expect.poll(() => page.evaluate(() => window.ashChatInputIntegration.dropState().text)).toBe('Review dropped.ts ');
		await input.press('ControlOrMeta+z');
		await expect(source).toHaveCount(0);
		await expect.poll(() => page.evaluate(() => window.ashChatInputIntegration.dropState().text)).toBe('Review ');
		await input.press('ControlOrMeta+Shift+z');
		await source.click();
		await expect(page.getByLabel('Opened saved content')).toContainText('Workspace file content');
		await expect(page.getByLabel('Submission')).toHaveText('');
	});

	for (const locale of ['en', 'zh-CN']) test(`mixed resource drops share one snapshot and undo batch in ${locale}`, async () => {
		const { page } = browserTests;
		const chinese = locale === 'zh-CN';
		await page.goto(`/chatInput.html?inlineCode=1&contextSources=1&dropSources=1&sendFailure=1&locale=${locale}&theme=dark`);
		const input = page.getByRole('textbox', { name: 'Chat message', exact: true });
		await input.pressSequentially('Review done');
		await page.evaluate(() => window.ashChatInputIntegration.showModels());
		await input.press('Home');
		for (let i = 0; i < 7; i++) await input.press('ArrowRight');
		assert.deepEqual(await dropResources(mixedDropResources), { prevented: true, overlay: true });
		const names = ['drop-file.ts', 'drop-folder', 'drop-image.png', 'drop-range.ts (2)'];
		const references = page.locator('.ash-chat-input-editor-host [role="group"]');
		await expect(references).toHaveCount(4);
		await expect(input).toBeFocused();
		const help = await page.evaluate(() => window.ashChatInputIntegration.contextAccessibility().help);
		assert.match(help!, chinese ? /一次撤销可移除本次拖入/u : /Undo removes that drop in one step/u);
		await expect.poll(() => page.evaluate(() => window.ashChatInputIntegration.dropState().text)).toBe(`Review ${names.join(' ')} done`);
		await input.press('ControlOrMeta+z');
		await expect(references).toHaveCount(0);
		await expect.poll(() => page.evaluate(() => window.ashChatInputIntegration.dropState().text)).toBe('Review done');
		await input.press('ControlOrMeta+Shift+z');
		await expect(references).toHaveCount(4);
		await page.evaluate(() => window.ashChatInputIntegration.setDropSourceText('Changed after the drop'));
		await page.getByRole('button', { name: `${chinese ? '打开' : 'Open'} drop-file.ts`, exact: true }).click();
		await expect(page.getByLabel('Opened saved content')).toContainText('first captured line');
		await page.getByRole('button', { name: `${chinese ? '打开' : 'Open'} drop-range.ts (2)`, exact: true }).click();
		await expect.poll(async () => JSON.parse((await page.getByLabel('Opened saved content').textContent())!).at(-1).text).toBe('second');
		await page.locator('[data-action-id="ash.chat.input.send"] button').press('Enter');
		await expect(page.getByLabel('Submission')).toContainText('first captured line');
		await expect(page.getByLabel('Submission')).toContainText('child.ts');
		await expect(page.getByLabel('Submission')).toContainText('data:image/png;base64,');
		await expect(page.getByLabel('Submission')).not.toContainText('Changed after the drop');
		await expect(references).toHaveCount(4);
	});

	test('sending waits for a pending resource drop and captures its eventual reference text', async () => {
		const { page } = browserTests;
		await page.goto('/chatInput.html?inlineCode=1&contextSources=1&dropSources=1&sendFailure=1');
		const input = page.getByRole('textbox', { name: 'Chat message', exact: true });
		await input.pressSequentially('Review ');
		await page.evaluate(() => window.ashChatInputIntegration.showModels());
		await dropResources(['file:///workspace/drop-pending.ts']);
		await expect.poll(() => page.evaluate(() => window.ashChatInputIntegration.dropState().pending)).toBe(true);
		await page.locator('[data-action-id="ash.chat.input.send"] button').press('Enter');
		await expect(page.getByLabel('Submission')).toHaveText('');
		await page.evaluate(() => window.ashChatInputIntegration.releaseDropRead());
		await expect.poll(() => page.evaluate(() => window.ashChatInputIntegration.historyState())).toMatchObject({ submissions: [{ text: 'Review drop-pending.ts ' }] });
		await expect(page.getByLabel('Submission')).toContainText('first captured line');
	});

	for (const retirement of ['hide', 'dispose', 'replace'] as const) test(`a ${retirement} input cannot receive or refocus a late resource drop`, async () => {
		const { page } = browserTests;
		await page.goto('/chatInput.html?inlineCode=1&contextSources=1&dropSources=1');
		const input = page.getByRole('textbox', { name: 'Chat message', exact: true });
		await input.pressSequentially('Review ');
		await dropResources(['file:///workspace/drop-pending.ts']);
		await expect.poll(() => page.evaluate(() => window.ashChatInputIntegration.dropState().pending)).toBe(true);
		await page.evaluate(retirement => {
			if (retirement === 'hide') window.ashChatInputIntegration.setVisible(false);
			else if (retirement === 'dispose') window.ashChatInputIntegration.dispose();
			else window.ashChatInputIntegration.replaceDropDraft();
			const outside = document.createElement('button');
			outside.textContent = 'Outside drop target';
			document.body.append(outside);
			outside.focus();
			window.ashChatInputIntegration.releaseDropRead();
		}, retirement);
		if (retirement !== 'dispose') {
			await expect.poll(() => page.evaluate(() => window.ashChatInputIntegration.dropState().pending)).toBe(false);
			await expect.poll(() => page.evaluate(() => window.ashChatInputIntegration.dropState().text)).toBe(retirement === 'replace' ? 'Replacement draft' : 'Review ');
		} else await expect(page.locator('.ash-chat-input-part')).toHaveCount(0);
		await expect(page.getByRole('button', { name: 'Outside drop target', exact: true })).toBeFocused();
		await expect(page.getByRole('button', { name: 'Open drop-pending.ts', exact: true })).toHaveCount(0);
	});

	test('mixed resource errors and model changes cannot partially insert a drop', async () => {
		const { page } = browserTests;
		await page.goto('/chatInput.html?inlineCode=1&contextSources=1&dropSources=1');
		const input = page.getByRole('textbox', { name: 'Chat message', exact: true });
		await input.pressSequentially('Review ');
		await dropResources(['file:///workspace/drop-file.ts', 'file:///workspace/drop-missing.ts']);
		await expect.poll(() => page.evaluate(() => window.ashChatInputIntegration.dropState().pending)).toBe(false);
		await expect.poll(() => page.evaluate(() => window.ashChatInputIntegration.dropState().text)).toBe('Review ');
		await page.evaluate(() => window.ashChatInputIntegration.setImageCapability('text'));
		await dropResources(['file:///workspace/drop-image.png']);
		await expect.poll(() => page.evaluate(() => window.ashChatInputIntegration.dropState().pending)).toBe(false);
		assert.ok(!(await page.evaluate(() => window.ashChatInputIntegration.dropState().reads)).includes('bytes:file:///workspace/drop-image.png'));
		await page.evaluate(() => window.ashChatInputIntegration.setImageCapability('image'));
		await dropResources(['file:///workspace/drop-pending.ts', 'file:///workspace/drop-image.png']);
		await expect.poll(() => page.evaluate(() => window.ashChatInputIntegration.dropState().reads)).toContain('bytes:file:///workspace/drop-image.png');
		await page.evaluate(() => {
			window.ashChatInputIntegration.setImageCapability('text');
			window.ashChatInputIntegration.releaseDropRead();
		});
		await expect.poll(() => page.evaluate(() => window.ashChatInputIntegration.dropState().pending)).toBe(false);
		await expect.poll(() => page.evaluate(() => window.ashChatInputIntegration.dropState().text)).toBe('Review ');
		await expect(page.locator('.ash-chat-input-editor-host [role="group"]')).toHaveCount(0);
	});

	test('URI-list and native-file aliases capture one source range from its unsaved working copy', async () => {
		const { page } = browserTests;
		await page.goto('/chatInput.html?inlineCode=1&contextSources=1&dropSources=1');
		const input = page.getByRole('textbox', { name: 'Chat message', exact: true });
		await input.pressSequentially('Review ');
		await input.evaluate(element => {
			const dataTransfer = new DataTransfer();
			dataTransfer.setData('text/uri-list', '# source alias\r\nfile:///workspace/edited.ts#1,1-1,8\r\nfile:///workspace/edited.ts#1,1-1,8');
			const native = new File(['Stale native bytes'], 'edited.ts', { type: 'text/plain' });
			Object.defineProperty(native, 'path', { value: '/workspace/edited.ts' });
			dataTransfer.items.add(native);
			element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
		});
		await expect(page.locator('.ash-chat-input-editor-host [role="group"]')).toHaveCount(1);
		await page.getByRole('button', { name: 'Open edited.ts (1)', exact: true }).click();
		await expect.poll(async () => JSON.parse((await page.getByLabel('Opened saved content').textContent())!)[0].text).toBe('Unsaved');
		assert.deepEqual(await page.evaluate(() => window.ashChatInputIntegration.dropState().reads), []);
	});

	test('a folder with an image extension remains text context for a text-only model', async () => {
		const { page } = browserTests;
		await page.goto('/chatInput.html?inlineCode=1&contextSources=1&dropSources=1');
		await page.getByRole('textbox', { name: 'Chat message', exact: true }).focus();
		await page.evaluate(() => window.ashChatInputIntegration.setImageCapability('text'));
		await dropResources(['file:///workspace/drop-folder.PNG']);
		await expect(page.getByRole('button', { name: 'Open drop-folder.PNG', exact: true })).toBeVisible();
		assert.deepEqual(await page.evaluate(() => window.ashChatInputIntegration.dropState().reads), []);
	});

	test('invalid resource transfers do not edit the draft and ordinary URL drops remain unclaimed', async () => {
		const { page } = browserTests;
		await page.goto('/chatInput.html?inlineCode=1&contextSources=1&dropSources=1');
		await page.getByRole('textbox', { name: 'Chat message', exact: true }).pressSequentially('Review ');
		const results = await page.locator('form.ash-chat-input-container').evaluate(element => {
			return ['not-json', '[null]', '["command:unsafe"]', 'http'].map(data => {
				const dataTransfer = new DataTransfer();
				dataTransfer.setData(data === 'http' ? 'text/uri-list' : 'ResourceURLs', data === 'http' ? 'https://example.invalid/page' : data);
				const event = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer });
				element.dispatchEvent(event);
				return event.defaultPrevented;
			});
		});
		assert.deepEqual(results, [true, true, true, false]);
		assert.deepEqual(await page.evaluate(() => window.ashChatInputIntegration.dropState()), { text: 'Review ', pending: false, reads: [] });
		await expect(page.getByLabel('Opened sources')).toHaveText('[]');
	});
	for (const locale of ['en', 'zh-CN']) {
		for (const method of ['copy', 'cut'] as const) {
			test(`Editor code ${method} pastes as a frozen Chat reference through undo and send in ${locale}`, async function () {
				const { page } = browserTests;
				await page.goto(`/chatInput.html?inlineCode=1&locale=${locale}`);
				await page.evaluate(() => window.ashChatInputIntegration.showModels());
				const source = page.locator('#code-selection-source').getByRole('textbox');
				await source.press('ControlOrMeta+a');
				const copied = await source.evaluate((element, method) => {
					const transfer = new DataTransfer();
					element.dispatchEvent(new ClipboardEvent(method, { clipboardData: transfer, bubbles: true, cancelable: true }));
					return transfer.types.map(type => [type, transfer.getData(type)]);
				}, method);
				await source.press('ControlOrMeta+a');
				await source.pressSequentially('Changed after copying');
				const input = page.locator('.ash-chat-input-editor').getByRole('textbox');
				await input.pressSequentially('Explain ');
				await input.evaluate((element, values) => {
					const transfer = new DataTransfer();
					for (const [type, value] of values) transfer.setData(type!, value!);
					element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
				}, copied);
				await page.evaluate(() => window.ashChatInputIntegration.finishPaste());
				const reference = page.locator('.ash-chat-code-reference');
				await expect(reference).toHaveCount(0);
				const selector = page.locator('.stanza-editor-post-edit-selector button');
				await selector.click();
				await page.getByRole('menuitem', { name: locale === 'en' ? 'Pasted Code Attachment' : '粘贴为代码附件', exact: true }).click();
				await expect(reference).toHaveText('example.ts (1-5)');
				await expect(input).toBeFocused();
				await input.press('ControlOrMeta+z');
				await expect(reference).toHaveCount(0);
				await input.press('ControlOrMeta+Shift+z');
				await expect(reference).toHaveText('example.ts (1-5)');
				const accessibility = await page.evaluate(() => window.ashChatInputIntegration.contextAccessibility());
				expect(accessibility.help).toContain(locale === 'en' ? 'Paste options offers Pasted Code Attachment' : '可在粘贴选项中选择“粘贴为代码附件”');
				expect(await page.evaluate(() => window.ashChatInputIntegration.restoreCapturedDraft())).toBe('Explain example.ts (1-5)');
				await input.press('Enter');
				const submission = page.getByLabel('Submission', { exact: true });
				await expect(submission).toContainText('const unsaved = 42;');
				const contexts = JSON.parse((await submission.textContent())!);
				expect(contexts).toHaveLength(1);
				expect(contexts[0].content).toContain('first\nsecond\nconst unsaved = 42;\nreturn unsaved;\nlast');
				expect(contexts[0].content).not.toContain('Changed after copying');
			});
		}
	}

	test('A pending reference paste cannot return after an empty draft is hidden and shown again', async function () {
		const { page } = browserTests;
		await page.goto('/chatInput.html?inlineCode=1');
		await page.evaluate(() => {
			window.ashChatInputIntegration.showModels();
			window.ashChatInputIntegration.addDeferredContext('Snapshot from the retired draft');
		});
		const input = page.locator('.ash-chat-input-editor').getByRole('textbox');
		await input.press('ControlOrMeta+a');
		const copied = await input.evaluate(element => {
			const transfer = new DataTransfer();
			element.dispatchEvent(new ClipboardEvent('copy', { clipboardData: transfer, bubbles: true, cancelable: true }));
			return transfer.types.map(type => [type, transfer.getData(type)]);
		});
		await input.press('Backspace');
		await input.evaluate((element, values) => {
			const transfer = new DataTransfer();
			for (const [type, value] of values) transfer.setData(type!, value!);
			element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
			window.ashChatInputIntegration.setVisible(false);
			window.ashChatInputIntegration.setVisible(true);
		}, copied);
		await page.evaluate(async () => {
			await window.ashChatInputIntegration.finishPaste();
			window.ashChatInputIntegration.releaseReferencePreview();
		});
		// A subsequent copy/paste must work, without reviving the cancelled preparation.
		await input.pressSequentially('current draft');
		await input.press('ControlOrMeta+a');
		const ordinary = await input.evaluate(element => {
			const transfer = new DataTransfer();
			element.dispatchEvent(new ClipboardEvent('copy', { clipboardData: transfer, bubbles: true, cancelable: true }));
			return transfer.types.map(type => [type, transfer.getData(type)]);
		});
		await input.press('End');
		await input.evaluate((element, values) => {
			const transfer = new DataTransfer();
			for (const [type, value] of values) transfer.setData(type!, value!);
			element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
		}, ordinary);
		await page.evaluate(() => window.ashChatInputIntegration.finishPaste());
		await expect(page.locator('.ash-chat-code-reference')).toHaveCount(0);
		expect(await page.evaluate(() => window.ashChatInputIntegration.restoreCapturedDraft())).toBe('current draftcurrent draft');
	});

	for (const locale of ['en', 'zh-CN']) {
		for (const method of ['copy', 'cut'] as const) {
			test(`Chat reference ${method} preserves snapshots through paste options, undo, draft restore and send in ${locale}`, async function () {
				const { page } = browserTests;
				await page.goto(`/chatInput.html?inlineCode=1&locale=${locale}`);
				await page.evaluate(() => window.ashChatInputIntegration.showModels());
				const input = page.locator('.ash-chat-input-editor').getByRole('textbox');
				const reference = page.locator('.ash-chat-code-reference');
				await input.focus();
				await page.keyboard.type('Original ');
				await page.evaluate(() => window.ashChatInputIntegration.addHistoryContext());
				await input.press('ControlOrMeta+a');
				const copied = await input.evaluate((element, method) => {
					const transfer = new DataTransfer();
					element.dispatchEvent(new ClipboardEvent(method, { clipboardData: transfer, bubbles: true, cancelable: true }));
					return transfer.types.map(type => [type, transfer.getData(type)]);
				}, method);
				if (method === 'cut') {
					await expect(reference).toHaveCount(0);
					await input.press('ControlOrMeta+z');
					await expect(reference).toHaveText('draft.txt');
				}
				await input.press('ControlOrMeta+a');
				await input.press('Backspace');
				await page.keyboard.type('Later: ');
				await input.evaluate((element, values) => {
					const transfer = new DataTransfer();
					for (const [type, value] of values) transfer.setData(type!, value!);
					element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
				}, copied);
				await expect(reference).toHaveText('draft.txt');
				await expect(input).toBeFocused();
				const selector = page.locator('.stanza-editor-post-edit-selector button');
				await selector.click();
				await page.getByRole('menuitem', { name: locale === 'en' ? 'Insert Plain Text' : '插入纯文本', exact: true }).click();
				await expect(reference).toHaveCount(0);
				await selector.click();
				await page.getByRole('menuitem', { name: locale === 'en' ? 'Insert Prompt & Attachments' : '插入消息和附件', exact: true }).click();
				await expect(reference).toHaveText('draft.txt');
				await input.press('ControlOrMeta+z');
				await expect(reference).toHaveCount(0);
				await input.press('ControlOrMeta+Shift+z');
				await expect(reference).toHaveText('draft.txt');
				const accessibility = await page.evaluate(() => window.ashChatInputIntegration.contextAccessibility());
				expect(accessibility.help).toContain(locale === 'en' ? 'Undo and redo restore the pasted text and references together.' : '撤销和重做会一起恢复粘贴的文字与引用。');
				expect(await page.evaluate(() => window.ashChatInputIntegration.restoreCapturedDraft())).toBe('Later: Original draft.txt ');
				await input.press('Enter');
				await expect(page.getByLabel('Submission', { exact: true })).toHaveText(JSON.stringify([{ name: 'draft.txt', content: 'synthetic context' }]));
			});
		}
	}

	for (const locale of ['en', 'zh-CN']) {
		for (const theme of ['light', 'hcDark']) {
			test(`Reference hover updates a delayed snapshot, bounds its preview and keeps keyboard focus in ${locale} ${theme}`, async function () {
				const { page } = browserTests;
				await page.goto(`/chatInput.html?inlineCode=1&locale=${locale}&theme=${theme}`);
				await page.evaluate(() => window.ashChatInputIntegration.showModels());
				const text = '<img src=x onerror="alert(1)">\n```\n[link](command:unsafe)\n' + Array.from({ length: 30 }, (_, index) => `Captured line ${index + 1}`).join('\n');
				await page.evaluate(content => window.ashChatInputIntegration.addDeferredContext(content), text);
				const input = page.locator('.ash-chat-input-editor').getByRole('textbox');
				await input.press('Home');
				await input.press('ControlOrMeta+k');
				await input.press('ControlOrMeta+i');
				const hover = page.locator('.stanza-editor-hover:not([hidden])');
				const content = hover.locator('.stanza-editor-hover-content');
				await expect(content).toBeFocused();
				await page.evaluate(() => window.ashChatInputIntegration.releaseReferencePreview());
				await expect(hover.locator('pre')).toContainText('<img src=x onerror="alert(1)">');
				await expect(hover.locator('pre')).toContainText('[link](command:unsafe)');
				await expect(hover).toContainText(locale === 'en' ? 'Preview shortened. The full content is attached.' : '预览已缩短，完整内容已附加。');
				await expect(hover).not.toContainText('Captured line 10');
				await expect(hover.locator('img, a')).toHaveCount(0);
				await expect(content).toBeFocused();
				expect((await hover.boundingBox())!.width).toBeLessThanOrEqual(500);
				expect((await hover.locator('pre').boundingBox())!.height).toBeLessThanOrEqual(240);
				await page.locator('main').screenshot({ path: browserTests.info.outputPath('reference-content-preview.png') });
				await page.keyboard.press('Escape');
				await expect(input).toBeFocused();
				await expect(hover).toHaveCount(0);
				await page.locator('.ash-chat-code-reference').click();
				const opened = page.getByLabel('Opened saved content', { exact: true });
				await expect.poll(async () => JSON.parse((await opened.textContent())!).length).toBe(1);
				const snapshot = JSON.parse((await opened.textContent())!)[0];
				expect(snapshot).toMatchObject({ text, readOnly: true, pinned: true, label: locale === 'en' ? 'draft.txt — Saved content' : 'draft.txt — 已保存的内容' });
				expect(snapshot.resource).toMatch(/^chat-context-snapshot:\//u);
				await input.press('Home');
				await input.press('Alt+Enter');
				await expect.poll(async () => JSON.parse((await opened.textContent())!).length).toBe(2);
				expect(JSON.parse((await opened.textContent())!)[1]).toEqual(snapshot);
				await expect(page.getByLabel('Submission', { exact: true })).toHaveText('');
				await input.press('ControlOrMeta+a');
				await input.press('Alt+Enter');
				await expect.poll(async () => JSON.parse((await opened.textContent())!).length).toBe(2);
				await input.press('End');
				await input.press('Enter');
				await expect(page.getByLabel('Submission', { exact: true })).toHaveText(JSON.stringify([{ name: 'draft.txt', content: text }]));
			});
		}
	}

	for (const theme of ['light', 'dark', 'hcDark', 'hcLight']) {
		test(`Reference backgrounds use editor range geometry through selection and focus changes in ${theme}`, async function () {
			const { page } = browserTests;
			await page.goto(`/chatInput.html?inlineCode=1&theme=${theme}&locale=zh-CN`);
			await page.evaluate(() => {
				window.ashChatInputIntegration.showModels();
				window.ashChatInputIntegration.addHistoryContext();
				window.ashChatInputIntegration.appendToDraft('Explain this reference and the wrapped text around it.\nSecond line.');
			});
			await page.locator('main').evaluate(element => { element.style.width = '320px'; });
			const editor = page.locator('.ash-chat-input-editor');
			const input = editor.getByRole('textbox');
			const reference = editor.locator('.ash-chat-code-reference');
			await expect(reference).toHaveText('draft.txt');
			const chip = editor.locator('.ash-chat-code-reference-chip');
			const label = chip.locator('.ash-chat-code-reference-source > .ash-icon-label');
			await expect(label).toHaveCount(1);
			await expect(label.locator('.ash-chat-code-reference-icon')).toHaveCount(1);
			await expect(label.locator('.ash-chat-code-reference')).toHaveText('draft.txt');
			await expect(chip.locator('button')).toHaveCount(2);
			await expect(chip.getByRole('button', { name: '移除 draft.txt', exact: true })).toBeVisible();
			await expect(label).toHaveCSS('align-items', 'center');
			await expect(reference).toHaveCSS('font-size', '13px');
			await expect(reference).toHaveCSS('line-height', '18.2px');
			await expect(reference).toHaveCSS('display', 'block');
			await expect(chip).toHaveCSS('height', '20px');
			await expect(chip).toHaveCSS('border-radius', '4px');
			const idleBackground = await chip.evaluate(element => getComputedStyle(element).backgroundColor);
			const iconBounds = await label.locator('.ash-chat-code-reference-icon').boundingBox();
			const labelBounds = await label.boundingBox();
			expect(Math.abs(iconBounds!.y + iconBounds!.height / 2 - labelBounds!.y - labelBounds!.height / 2)).toBeLessThan(1);
			expect(idleBackground).not.toBe('rgba(0, 0, 0, 0)');
			await input.focus();
			await input.press('ControlOrMeta+a');
			await editor.screenshot({ path: browserTests.info.outputPath('selected-reference.png') });
			await expect(chip).toHaveClass(/selected/);
			const backgrounds = editor.locator('.stanza-editor-selection');
			expect(await backgrounds.count()).toBeGreaterThan(2);
			const selected = await backgrounds.first().evaluate(element => getComputedStyle(element).backgroundColor);
			await expect(chip).toHaveCSS('background-color', selected);
			await expect(chip).toHaveCSS('background-image', `linear-gradient(${idleBackground}, ${idleBackground})`);
			await input.blur();
			await expect(editor.locator('.view-overlays')).not.toHaveClass(/focused/);
			const inactive = await backgrounds.first().evaluate(element => getComputedStyle(element).backgroundColor);
			await expect(chip).toHaveCSS('background-color', inactive);
			await input.focus();
			await input.press('ArrowRight');
			await expect(chip).not.toHaveClass(/selected/);
			await expect(chip).toHaveCSS('background-color', idleBackground);
			await expect(chip).toHaveCSS('background-image', 'none');

		});
	}
	test('Inline attachments wrap as one IconLabel and reserve their full width after resizing', async function () {
		const { page } = browserTests;
		await page.goto('/chatInput.html?inlineCode=1&theme=light');
		await page.evaluate(() => window.ashChatInputIntegration.showModels());
		const main = page.locator('main');
		await main.evaluate(element => { element.style.width = '320px'; });
		const editor = page.locator('.ash-chat-input-editor');
		const input = editor.getByRole('textbox');
		await input.focus();
		const prefix = 'Explain this selected source code: ';
		await page.keyboard.type(prefix);
		await page.locator('#add-code-selection').click();
		await page.keyboard.type('after');
		const chip = editor.locator('.ash-chat-code-reference-chip');
		const object = editor.locator('[data-ash-inline-object="true"]');
		await expect(chip.locator('.ash-chat-code-reference-source > .ash-icon-label')).toHaveCount(1);
		await expect(object).toHaveCount(1);
		await expect.poll(async () => (await chip.boundingBox())!.y - (await editor.locator('.view-line').first().boundingBox())!.y).toBeGreaterThanOrEqual(20);
		for (const width of ['480px', '320px']) {
			await main.evaluate((element, width) => { element.style.width = width; }, width);
			await expect.poll(async () => {
				const [chipBox, objectBox] = await Promise.all([chip.boundingBox(), object.boundingBox()]);
				if (!chipBox || !objectBox) return undefined;
				return {
					height: chipBox.height,
					widthMatches: Math.abs(chipBox.width - objectBox.width) < 1,
					leftMatches: Math.abs(chipBox.x - objectBox.x) < 1,
					topMatches: Math.abs(chipBox.y - objectBox.y) < 1,
				};
			}).toEqual({ height: 20, widthMatches: true, leftMatches: true, topMatches: true });
		}
		expect(await page.evaluate(() => window.ashChatInputIntegration.restoreCapturedDraft())).toBe(`${prefix}example.ts (3-4) after`);
	});

	for (const locale of ['en', 'zh-CN']) {
		test(`References keep the caret outside a restored attachment at the message start in ${locale}`, async function () {
			const { page } = browserTests;
			await page.goto(`/chatInput.html?inlineCode=1&locale=${locale}&theme=light`);
			await page.evaluate(() => window.ashChatInputIntegration.showModels());
			const editor = page.locator('.ash-chat-input-editor');
			const input = editor.getByRole('textbox');
			await page.locator('#add-code-selection').click();
			const reference = editor.locator('.ash-chat-code-reference');
			await expect(reference).toHaveText('example.ts (3-4)');
			await input.press('End');
			await input.press('Backspace');
			await input.press('Backspace');
			await expect(reference).toHaveCount(0);
			await input.press('ControlOrMeta+z');
			await expect(reference).toHaveText('example.ts (3-4)');
			await input.press('Home');
			await input.press('ArrowRight');
			await expect.poll(() => page.evaluate(() => window.ashChatInputIntegration.inputSelection())).toEqual({ anchor: 16, active: 16 });
			await expect.poll(async () => {
				const slot = await editor.locator('.ash-chat-code-reference-chip').boundingBox();
				const caret = await editor.locator('.cursors-layer .cursor.primary').boundingBox();
				return caret!.x - slot!.x - slot!.width;
			}).toBeGreaterThanOrEqual(-1);
			await input.press('ArrowLeft');
			await expect.poll(() => page.evaluate(() => window.ashChatInputIntegration.inputSelection())).toEqual({ anchor: 0, active: 0 });
		});
		test(`References keep the caret outside their entire surface in ${locale}`, async function () {
			const { page } = browserTests;
			await page.goto(`/chatInput.html?inlineCode=1&locale=${locale}&theme=light`);
			await page.evaluate(() => window.ashChatInputIntegration.showModels());
			const editor = page.locator('.ash-chat-input-editor');
			const input = editor.getByRole('textbox');
			await input.focus();
			await page.keyboard.type('Before  after');
			await input.press('Home');
			for (let index = 0; index < 7; index++) await input.press('ArrowRight');
			await page.locator('#add-code-selection').click();
			const reference = editor.locator('.ash-chat-code-reference');
			await expect(reference).toHaveText('example.ts (3-4)');
			const selection = () => page.evaluate(() => window.ashChatInputIntegration.inputSelection());
			await input.press('Home');
			for (let index = 0; index < 7; index++) await input.press('ArrowRight');
			await expect.poll(selection).toEqual({ anchor: 7, active: 7 });
			await input.press('ArrowRight');
			await expect.poll(selection).toEqual({ anchor: 23, active: 23 });
			await expect.poll(async () => {
				const slot = await editor.locator('.ash-chat-code-reference-chip').boundingBox();
				const caret = await editor.locator('.cursors-layer .cursor.primary').boundingBox();
				return caret!.x - slot!.x - slot!.width;
			}).toBeGreaterThanOrEqual(-1);
			await input.press('ArrowLeft');
			await expect.poll(selection).toEqual({ anchor: 7, active: 7 });
			await input.press('Shift+ArrowRight');
			await expect.poll(selection).toEqual({ anchor: 7, active: 23 });
			await input.press('ArrowRight');
			await input.press(process.platform === 'darwin' ? 'Alt+ArrowLeft' : 'Control+ArrowLeft');
			await expect.poll(selection).toEqual({ anchor: 7, active: 7 });
			await input.press(process.platform === 'darwin' ? 'Alt+ArrowRight' : 'Control+ArrowRight');
			await expect.poll(selection).toEqual({ anchor: 23, active: 23 });
			await reference.dblclick();
			await expect.poll(selection).toEqual({ anchor: 7, active: 23 });
			await editor.screenshot({ path: browserTests.info.outputPath('atomic-reference.png') });
			await page.keyboard.type('replacement');
			await expect(reference).toHaveCount(0);
			expect(await page.evaluate(() => window.ashChatInputIntegration.restoreCapturedDraft())).toBe('Before replacement after');
		});
	}
	for (const { locale, multiRoot } of [
		{ locale: 'en', multiRoot: false },
		{ locale: 'zh-CN', multiRoot: false },
		{ locale: 'en', multiRoot: true },
		{ locale: 'zh-CN', multiRoot: true },
	]) {
		test(`Selected output uses its channel name and preserves the captured log in ${locale} ${multiRoot ? 'multi-root' : 'single-root'}`, async function () {
			const { page } = browserTests;
			await page.goto(`/chatInput.html?inlineCode=1&outputSelection=1&locale=${locale}&theme=light${multiRoot ? '&multiRootOutput=1' : ''}`);
			await page.evaluate(() => window.ashChatInputIntegration.showModels());
			await page.locator('main').evaluate(element => { element.style.width = '320px'; });
			await page.locator('#add-code-selection').click();
			const input = page.locator('.ash-chat-input-editor').getByRole('textbox');
			const reference = page.locator('.ash-chat-code-reference');
			const name = multiRoot ? 'rust-analyzer — ash (3-4)' : 'rust-analyzer (3-4)';
			await expect(reference).toHaveText(name);
			await expect(page.locator('.ash-chat-code-reference-icon.placeholder')).toHaveCount(1);
			await expect(page.locator('.ash-chat-code-reference-icon.placeholder')).toBeEmpty();
			await expect(input).toBeFocused();
			await reference.hover();
			let hover = page.locator('.ash-hover');
			await expect(hover).toContainText(name);
			await expect(hover.locator('pre')).toHaveText('Selected log entry\nAnother log entry\n');
			await expect(hover).not.toContainText('output:/');
			await expect(hover).not.toContainText('3dad1685');
			expect((await hover.boundingBox())!.width).toBeLessThanOrEqual(500);
			await input.press('Home');
			await expect(hover).toHaveCount(0);
			hover = page.locator('.stanza-editor-hover:not([hidden])');
			await input.press('ControlOrMeta+k');
			await input.press('ControlOrMeta+i');
			await expect(hover).toBeVisible();
			await expect(hover.locator('pre')).toContainText('Selected log entry');
			await expect(hover.locator('.stanza-editor-hover-content')).toBeFocused();
			await page.keyboard.press('Escape');
			await expect(hover).toHaveCount(0);
			await expect(input).toBeFocused();
			const bounds = await reference.boundingBox();
			expect(bounds!.height).toBeLessThan(30);
			await page.locator('#append-output-log').click();
			await page.locator('.ash-chat-code-reference-source').click();
			const opened = page.getByLabel('Opened saved content', { exact: true });
			await expect.poll(async () => JSON.parse((await opened.textContent())!).length).toBe(1);
			expect(JSON.parse((await opened.textContent())!)[0]).toMatchObject({ text: 'Selected log entry\nAnother log entry\n', readOnly: true, pinned: true });
			await expect(opened).not.toContainText('Later log entry');
			const accessibility = await page.evaluate(() => window.ashChatInputIntegration.contextAccessibility());
			expect(accessibility.content).toContain(name);
			expect(accessibility.help).toContain(locale === 'en' ? 'Hover over a reference' : '将鼠标悬停在引用上');
			expect(await page.evaluate(() => window.ashChatInputIntegration.restoreCapturedDraft())).toBe(`${name} `);
			await input.press('End');
			await input.press('Backspace');
			await input.press('Backspace');
			await expect(reference).toHaveCount(0);
			await input.press('ControlOrMeta+z');
			await expect(reference).toHaveText(name);
			await page.locator('main').screenshot({ path: browserTests.info.outputPath('inline-output-reference.png') });
			await input.press('Enter');
			await expect(page.getByLabel('Submission', { exact: true })).toHaveText(JSON.stringify([{
				name, content: `Source: output:/language-server.rust-analyzer.${'3dad1685'.repeat(8)}#3,1-5,1\n\nSelected log entry\nAnother log entry\n`,
			}]));
		});
	}
	for (const locale of ['en', 'zh-CN']) {
		test(`Selected Debug Console text reserves an empty icon in ${locale}`, async function () {
			const { page } = browserTests;
			await page.goto(`/chatInput.html?inlineCode=1&debugSelection=1&locale=${locale}&theme=light`);
			await page.evaluate(() => window.ashChatInputIntegration.showModels());
			await page.locator('#add-code-selection').click();
			const name = `${locale === 'en' ? 'Debug Console' : '调试控制台'} (3-4)`;
			const reference = page.locator('.ash-chat-code-reference');
			await expect(reference).toHaveText(name);
			const icon = page.locator('.ash-chat-code-reference-icon.placeholder');
			await expect(icon).toHaveCount(1);
			await expect(icon).toBeEmpty();
			expect((await icon.boundingBox())!.width).toBe(16);
			await reference.hover();
			await expect(page.locator('.ash-hover pre')).toHaveText('Debug result\nDebug detail\n');
		});
		for (const theme of ['light', 'dark', 'hcDark', 'hcLight']) {
			test(`Inline files and selected code use the message cursor and preserve snapshots in ${locale} ${theme}`, async function () {
				const { page } = browserTests;

				await page.goto(`/chatInput.html?inlineCode=1&locale=${locale}&theme=${theme}`);
				await page.evaluate(() => window.ashChatInputIntegration.showModels());
				const input = page.locator('.ash-chat-input-editor').getByRole('textbox');
				await input.focus();
				await page.keyboard.type('Explain  please');
				await input.press('Home');
				for (let index = 0; index < 8; index++) await input.press('ArrowRight');
				await page.getByRole('button', { name: locale === 'en' ? 'Add context' : '添加上下文', exact: true }).press('Enter');
				const picker = page.getByRole('dialog');
				await picker.getByRole('combobox').fill('edited');
				await picker.getByRole('option', { name: /edited.ts/ }).click();
				const wholeFile = page.locator('.ash-chat-code-reference').filter({ hasText: /^edited.ts$/ });
				await expect(wholeFile).toHaveText('edited.ts');
				await expect(input).toBeFocused();
				await page.locator('#add-code-selection').click();
				const reference = page.locator('.ash-chat-code-reference').filter({ hasText: /^example.ts \(3-4\)$/ });
				await expect(reference).toHaveText('example.ts (3-4)');
				await expect(wholeFile).toHaveText('edited.ts');
				const icons = page.locator('.ash-chat-code-reference-icon');
				await expect(icons).toHaveCount(2);
				await expect(icons.locator('.ash-icon-file')).toHaveCount(2);
				await expect(icons.first()).toHaveAttribute('aria-hidden', 'true');
				const iconBounds = await icons.nth(1).boundingBox();
				const textBounds = await reference.boundingBox();
				expect(iconBounds!.x + iconBounds!.width).toBeLessThanOrEqual(textBounds!.x + 1);
				await expect(reference).toHaveCSS('font-size', '13px');
				const alignment = await reference.evaluate(element => {
					const chip = element.closest('.ash-chat-code-reference-chip')!.getBoundingClientRect();
					const icon = element.closest('.ash-icon-label')!.querySelector('.ash-icon-label-icon')!.getBoundingClientRect();
					const line = element.getBoundingClientRect();
					const container = getComputedStyle(element.closest('.ash-icon-label-container')!);
					return {
						lineOffset: line.top + line.height / 2 - chip.top - chip.height / 2,
						iconOffset: icon.top + icon.height / 2 - chip.top - chip.height / 2,
						transform: container.transform,
						trim: getComputedStyle(element).textBoxTrim,
					};
				});
				expect(Math.abs(alignment.lineOffset)).toBeLessThan(0.5);
				expect(Math.abs(alignment.iconOffset)).toBeLessThan(0.5);
				expect(alignment.transform).toBe('none');
				expect(alignment.trim).toBe('none');
				await expect(input).toBeFocused();
				await reference.hover();
				const hover = page.locator('.ash-hover');
				await expect(hover.locator('pre')).toHaveText('const unsaved = 42;\nreturn unsaved;\n');
				await expect(hover).toContainText('/workspace/example.ts');
				await input.press('Escape');
				await expect(page.locator('.ash-chat-input-attachments')).toHaveCount(0);
				await expect(page.locator('.ash-aria-status').filter({ hasText: locale === 'en' ? 'Inserted example.ts (3-4) at the message cursor' : '已在消息光标处插入 example.ts (3-4)' })).toHaveCount(1);
				const accessibility = await page.evaluate(() => window.ashChatInputIntegration.contextAccessibility());
				expect(accessibility.help).toContain(locale === 'en' ? 'Add Selection to Chat' : '将选中代码加入聊天');
				expect(accessibility.content).toContain('example.ts (3-4)');
				const restored = await page.evaluate(() => window.ashChatInputIntegration.restoreCapturedDraft());
				expect(restored).toBe('Explain edited.ts example.ts (3-4) please');
				await expect(reference).toHaveText('example.ts (3-4)');
				await input.press('Home');
				for (let index = 0; index < 8; index++) await input.press('ArrowRight');
				await expect.poll(() => page.evaluate(() => window.ashChatInputIntegration.inputSelection())).toEqual({ anchor: 8, active: 8 });
				await input.press('ArrowRight');
				await expect.poll(() => page.evaluate(() => window.ashChatInputIntegration.inputSelection())).toEqual({ anchor: 17, active: 17 });
				await input.press('ArrowRight');
				await expect.poll(() => page.evaluate(() => window.ashChatInputIntegration.inputSelection())).toEqual({ anchor: 18, active: 18 });
				await input.press('Delete');
				await expect(reference).toHaveCount(0);
				await input.press('ControlOrMeta+z');
				// Undo restores a native selection; select the whole draft for the selected-color assertion.
				await input.press('ControlOrMeta+a');
				await expect(reference).toHaveText('example.ts (3-4)');
				const referenceStyle = () => page.evaluate(() => {
					const editor = document.querySelector('.ash-chat-input-editor .stanza-editor')!;
					const element = [...editor.querySelectorAll('.ash-chat-code-reference')].find(element => element.textContent === 'example.ts (3-4)')!;
					const { color } = getComputedStyle(element);
					const decoration = element.closest('.ash-chat-code-reference-chip')!;
					const probe = element.ownerDocument.createElement('span');
					probe.style.backgroundColor = 'var(--ash-input-background)';
					editor.append(probe);
					const channels = (value: string) => value.match(/[\d.]+/g)!.map(Number);
					let background = channels(getComputedStyle(probe).backgroundColor).slice(0, 3);
					probe.remove();
					// The reference fill follows the selection in paint order; alpha must be composited
					// before checking the text contrast of either selected or unselected references.
					for (const layer of [decoration]) {
						if (!layer) continue;
						const rgba = channels(getComputedStyle(layer).backgroundColor);
						const alpha = rgba[3] ?? 1;
						background = background.map((value, index) => rgba[index]! * alpha + value * (1 - alpha));
					}
					const fill = getComputedStyle(decoration).backgroundImage.match(/rgba?\([^)]+\)/)?.[0];
					if (fill) {
						const rgba = channels(fill);
						background = background.map((value, index) => rgba[index]! * (rgba[3] ?? 1) + value * (1 - (rgba[3] ?? 1)));
					}
					const luminance = (values: number[]) => {
						const channels = values.map(channel => channel / 255).map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
						return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
					};
					const foregroundLuminance = luminance(channels(color));
					const backgroundLuminance = luminance(background);
					return { foreground: color, background, radius: getComputedStyle(decoration).borderTopRightRadius, contrast: (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05) };
				});
				const selectedStyle = await referenceStyle();
				await input.press('ArrowRight');
				const normalStyle = await referenceStyle();
				expect(normalStyle.contrast, JSON.stringify(normalStyle)).toBeGreaterThanOrEqual(4.5);
				if (theme === 'dark') {
					// VS Code keeps the reference foreground over the selection and its translucent fill.
					expect(selectedStyle.contrast).toBeCloseTo(4.25395, 3);
				} else {
					expect(selectedStyle.contrast, JSON.stringify(selectedStyle)).toBeGreaterThanOrEqual(4.5);
				}
				for (const style of [selectedStyle, normalStyle]) {
					expect(style.radius).toBe('4px');
				}
				await page.locator('main').screenshot({ path: browserTests.info.outputPath('inline-file-references.png') });
				await input.press('Enter');
				await expect(page.getByLabel('Submission', { exact: true })).toHaveText(JSON.stringify([{ name: 'edited.ts', content: 'Unsaved editor text' }, { name: 'example.ts (3-4)', content: 'Source: file:///workspace/example.ts#3,1-5,1\n\nconst unsaved = 42;\nreturn unsaved;\n' }]));
				await expect(reference).toHaveCount(0);
				await expect(wholeFile).toHaveCount(0);
			});
		}
	}

	for (const locale of ['en', 'zh-CN']) {
		for (const theme of ['light', 'hcDark']) {
			for (const newChat of [true, false]) {
				test(`Stacked Sessions retain a growing ${newChat ? 'new' : 'existing'} chat input in ${locale} ${theme}`, async function () {
					const { page } = browserTests;

					await page.goto(`/chatInput.html?sessionsLayout=1${newChat ? '&newChat=1' : ''}&locale=${locale}&theme=${theme}`);
					await page.evaluate(() => window.ashChatInputIntegration.showModels());
					const body = page.locator('main');
					const host = page.locator('.ash-chat-pane-host');
					const sidebar = page.locator('.ash-chat-sessions-sidebar');
					const input = page.locator('.ash-chat-textarea-input');
					await expect(input).toBeVisible();
					await sidebar.getByRole('button').focus();
					await page.keyboard.press('Tab');
					await expect(input).toBeFocused();
					const draft = Array.from({ length: 10 }, (_, index) => `Keep draft line ${index + 1}`).join('\n');
					await input.fill(draft);
					await expect.poll(async () => {
						const bounds = await body.boundingBox();
						const chat = await host.boundingBox();
						const composer = await page.locator('.ash-chat-input-part').boundingBox();
						const sessions = await sidebar.boundingBox();
						return !!bounds && !!chat && !!composer && !!sessions && chat.height >= 116 && chat.height > bounds.height / 2
							&& composer.y >= chat.y && composer.y + composer.height <= bounds.y + bounds.height + 1
							&& composer.y + composer.height <= chat.y + chat.height + 1
							&& sessions.y + sessions.height <= chat.y + 1;
					}).toBe(true);
					await expect(input).toBeFocused();
					await expect(input).toHaveValue(draft);
					for (const width of [800, 240, 600]) {
						await page.locator('.ash-chat-view').evaluate((element, value) => { (element as HTMLElement).style.width = `${value}px`; }, width);
						await expect(body).toHaveClass(/sessions-stacked/u);
						await expect(input).toBeVisible();
						await expect(input).toHaveValue(draft);
						await expect(input).toBeFocused();
					}
					await page.locator('.ash-chat-view').evaluate(element => { (element as HTMLElement).style.width = '380px'; });
					if (locale === 'en' && theme === 'light' && !newChat) {
						await body.screenshot({ path: browserTests.info.outputPath('sessions-stacked.png') });
					}
					await body.evaluate(element => { element.classList.remove('sessions-sidebar-visible'); });
					await sidebar.evaluate(element => { element.setAttribute('hidden', ''); });
					await expect(input).toBeVisible();
					await expect(input).toHaveValue(draft);
					await expect(input).toBeFocused();
				});
			}
		}
	}

	test('Closed Sessions keep the full Chat transcript and composer at every width', async function () {
		const { page } = browserTests;

		await page.goto('/chatInput.html?sessionsLayout=closed');
		await page.evaluate(() => window.ashChatInputIntegration.showModels());
		for (const width of [800, 380, 240, 600]) {
			await page.locator('.ash-chat-view').evaluate((element, value) => { (element as HTMLElement).style.width = `${value}px`; }, width);
			await expect(page.locator('.ash-chat-sessions-sidebar')).toBeHidden();
			await expect(page.locator('.ash-chat-list-widget')).toBeVisible();
			await expect(page.locator('.ash-chat-textarea-input')).toBeVisible();
			const bounds = await page.locator('.ash-chat-pane-host').boundingBox();
			expect(bounds!.width).toBe(width);
		}
	});

	for (const locale of ['en', 'zh-CN']) {
		for (const theme of ['light', 'dark', 'hcLight', 'hcDark']) {
			test(`Editor changes leave the composer without an attachment bar in ${locale} ${theme}`, async function () {
				const { page } = browserTests;

				await page.goto(`/chatInput.html?inlineCode=1&locale=${locale}&theme=${theme}`);
				await page.evaluate(() => window.ashChatInputIntegration.showModels());
				const input = page.locator('.ash-chat-input-editor').getByRole('textbox');
				for (const file of ['file:///workspace/edited.ts', 'file:///workspace/other.ts']) {
					await page.evaluate(path => window.ashChatInputIntegration.setActiveFile(path), file);
					await expect(page.locator('.ash-chat-suggested-context')).toHaveCount(0);
					await expect(page.locator('.ash-chat-input-attachments')).toHaveCount(0);
				}
				await page.evaluate(() => window.ashChatInputIntegration.setActiveDiff('git-change:/staged/example.ts?side=original', 'git-change:/staged/example.ts?side=modified', 'Staged version'));
				await expect(page.locator('.ash-chat-suggested-context')).toHaveCount(0);
				await input.focus();
				const help = await page.evaluate(() => window.ashChatInputIntegration.inputAccessibility());
				expect(help).not.toContain(locale === 'en' ? 'The current editor file is suggested above the message.' : '消息上方会显示当前编辑文件的上下文建议。');
				await page.keyboard.type('Without context');
				await input.press('Enter');
				await expect(page.getByLabel('Submission', { exact: true })).toHaveText('[]');
				await page.getByRole('button', { name: locale === 'en' ? 'Add context' : '添加上下文', exact: true }).press('Enter');
				const picker = page.getByRole('dialog');
				await picker.getByRole('combobox').fill('edited');
				await picker.getByRole('option', { name: /edited.ts/ }).click();
				await expect(input).toBeFocused();
				await expect(page.locator('.ash-chat-code-reference')).toHaveText('edited.ts');
				await expect(page.locator('.ash-chat-suggested-context')).toHaveCount(0);
				await input.press('Enter');
				await expect(page.getByLabel('Submission', { exact: true })).toHaveText(JSON.stringify([{ name: 'edited.ts', content: 'Unsaved editor text' }]));
			});
		}
	}

	for (const locale of ['en', 'zh-CN']) {
		for (const theme of ['light', 'dark', 'hcLight', 'hcDark']) {
			test(`Context usage hover keeps two lines in ${locale} ${theme}`, async function () {
				const { page } = browserTests;

				await page.goto(`/chatInput.html?contextHover=1&locale=${locale}&theme=${theme}`);
				await page.evaluate(() => window.ashChatInputIntegration.showModels());
				await page.locator('main').evaluate(element => { element.style.width = '450px'; element.style.marginTop = '420px'; });
				const context = page.locator('.ash-chat-context-usage-button');
				await context.hover();
				const hover = page.getByRole('tooltip').locator('.ash-chat-context-usage-hover');
				for (const known of [true, false]) {
					if (!known) await page.evaluate(() => window.ashChatInputIntegration.setContextUsage(true));
					await expect(hover).toBeVisible();
					const lines = known
						? locale === 'en' ? ['Context budget: 25%', 'Estimated input tokens: 200 / 800'] : ['上下文预算：25%', '估算输入 token 数：200 / 800']
						: locale === 'en' ? ['Estimated context: 200 tokens', 'Context capacity unavailable.'] : ['上下文估算：200 个 token', '容量未知'];
					await expect(hover).toHaveText(lines.join('\n'));
					await expect(hover).toHaveCSS('white-space', 'pre-line');
					const linePositions = await hover.evaluate(element => {
						const text = element.firstChild!;
						const split = element.textContent!.indexOf('\n');
						const first = element.ownerDocument.createRange();
						first.setStart(text, 0);
						first.setEnd(text, split);
						const second = element.ownerDocument.createRange();
						second.setStart(text, split + 1);
						second.setEnd(text, text.textContent!.length);
						return { first: first.getBoundingClientRect().top, second: second.getBoundingClientRect().top };
					});
					expect(linePositions.second).toBeGreaterThan(linePositions.first);
					if (!known) await expect(hover).not.toContainText('%');
				}
				await context.click();
				await expect(page.getByRole('tooltip')).toBeHidden();
				await expect(page.getByRole('dialog', { name: locale === 'en' ? 'Context usage' : '上下文用量' })).toBeVisible();
			});
		}
	}

	for (const locale of ['en', 'zh-CN']) {
		for (const theme of ['light', 'dark', 'hcLight', 'hcDark']) {
			test(`Chat footer actions stay below the input and accept keyboard commands in ${locale} ${theme}`, async function () {
				const { page } = browserTests;

				await page.goto(`/chatInput.html?footerStatus=1&locale=${locale}&theme=${theme}`);
				await page.evaluate(() => window.ashChatInputIntegration.showModels());
				await page.locator('main').evaluate(element => {
					element.classList.add('ash-chat');
					const view = element.ownerDocument.createElement('div');
					view.className = 'ash-chat-view';
					const host = element.ownerDocument.createElement('div');
					host.className = 'ash-chat-pane-host';
					element.before(view);
					view.append(host);
					host.append(element);
					element.style.height = 'auto';
					element.style.marginTop = '420px';
				});
				const input = page.locator('.ash-chat-textarea-input');
				await input.fill('Keep my draft');
				const footer = page.locator('.ash-chat-secondary-toolbar');
				const add = footer.getByRole('button', { name: locale === 'en' ? 'Add context' : '添加上下文', exact: true });
				await expect(page.locator('.ash-chat-input-container').getByRole('button', { name: locale === 'en' ? 'Add context' : '添加上下文', exact: true })).toHaveCount(0);
				await expect(add).toBeVisible();
				const permissions = footer.getByRole('button', { name: locale === 'en' ? 'Permissions: Manual' : '权限：手动' });
				const context = footer.locator('.ash-chat-context-usage-button');
				const status = footer.getByRole('button', { name: 'Extension status' });
				await expect(footer.getByRole('button', { name: locale === 'en' ? 'Report an issue' : '报告问题' })).toHaveCount(0);
				await expect(permissions).toBeVisible();
				await expect(permissions).toHaveText(locale === 'en' ? 'Manual' : '手动');
				await expect(context).toBeVisible();
				await expect(context).toHaveText('');
				await expect(context).toHaveAttribute('aria-label', locale === 'en' ? 'Context budget: 25%, estimated input 200 of 800 tokens' : '上下文预算：25%，估算输入 200 / 800 个 token');
				await context.hover();
				await expect(context).toHaveAttribute('title', locale === 'en' ? 'Context budget: 25%\nEstimated input tokens: 200 / 800' : '上下文预算：25%\n估算输入 token 数：200 / 800');
				const ring = context.locator('svg');
				// Desktop can load the shared button rules after the widget's styles.
				await page.addStyleTag({ content: readFileSync('src/ash/base/browser/ui/button/button.css', 'utf8') });
				const ringBounds = await ring.boundingBox();
				const buttonBounds = (await context.boundingBox())!;
				expect([ringBounds!.width, ringBounds!.height]).toEqual([16, 16]);
				expect(ringBounds!.x + ringBounds!.width / 2).toBeCloseTo(buttonBounds.x + buttonBounds.width / 2, 5);
				expect(ringBounds!.y + ringBounds!.height / 2).toBeCloseTo(buttonBounds.y + buttonBounds.height / 2, 5);
				expect(await context.evaluate(element => element.getAnimations({ subtree: true }).length)).toBe(0);
				expect(await ring.locator('.ash-chat-context-usage-track').evaluate(element => getComputedStyle(element).stroke)).not.toBe('none');

				await expect(footer.getByText('Models & providers', { exact: true })).toHaveCount(0);
				await expect(status).toHaveCount(0);
				const composerBackground = {
					light: 'rgb(255, 255, 255)', dark: 'rgb(49, 49, 49)',
					hcLight: 'rgb(255, 255, 255)', hcDark: 'rgb(0, 0, 0)',
				}[theme]!;
				await expect(page.locator('.ash-chat-input-container')).toHaveCSS('background-color', composerBackground);
				const conversationBackground = { light: 'rgb(248, 248, 248)', dark: 'rgb(37, 37, 38)', hcLight: 'rgb(255, 255, 255)', hcDark: 'rgb(0, 0, 0)' }[theme]!;
				await expect(page.locator('main')).toHaveCSS('background-color', conversationBackground);
				await expect(page.locator('.ash-chat-view')).toHaveCSS('background-color', conversationBackground);
				await page.locator('main').evaluate(element => { element.style.setProperty('--ash-auxiliaryBar-background', 'rgb(250, 245, 240)'); });
				await expect(page.locator('main')).toHaveCSS('background-color', 'rgb(250, 245, 240)');
				await expect(page.locator('.ash-chat-input-container')).toHaveCSS('background-color', composerBackground);
				await page.locator('main').evaluate(element => { element.style.removeProperty('--ash-auxiliaryBar-background'); });

				const composer = await page.locator('.ash-chat-input-container').boundingBox();
				const footerBounds = await footer.boundingBox();
				expect(footerBounds!.y).toBeGreaterThanOrEqual(composer!.y + composer!.height);
				const addBounds = (await add.boundingBox())!;
				const permissionBounds = (await permissions.boundingBox())!;
				expect(permissionBounds.x - (addBounds.x + addBounds.width)).toBe(4);
				await add.focus();
				await page.keyboard.press('ArrowRight');
				await expect(permissions).toBeFocused();
				await page.keyboard.press('Enter');
				const picker = page.locator('.ash-action-widget');
				await expect(picker).toBeVisible();
				await expect(picker.locator('input')).toHaveCount(0);
				await expect(page.getByRole('combobox', { name: locale === 'en' ? 'Permissions' : '权限' })).toHaveCount(0);
				await expect(permissions).toHaveAttribute('aria-expanded', 'true');
				await expect(picker.getByRole('menuitemradio', { name: locale === 'en' ? 'Manual' : '手动', exact: true })).toHaveAttribute('aria-checked', 'true');
				const pickerBounds = (await picker.boundingBox())!;
				const permissionsBounds = (await permissions.boundingBox())!;
				expect(pickerBounds.y + pickerBounds.height).toBeLessThanOrEqual(permissionsBounds.y);
				if (locale === 'en' && theme === 'light') {
					await page.screenshot({ path: browserTests.info.outputPath('chat-permission-menu.png') });
				}
				await page.keyboard.press('Escape');
				await expect(picker).toBeHidden();
				await expect(permissions).toBeFocused();
				await expect(permissions).toHaveAttribute('aria-expanded', 'false');
				await permissions.click();
				await picker.getByRole('menuitemradio', { name: locale === 'en' ? 'Auto' : '自动', exact: true }).click();
				await expect(footer.getByRole('button', { name: locale === 'en' ? 'Permissions: Auto' : '权限：自动' })).toBeVisible();
				await expect(footer.getByRole('button', { name: locale === 'en' ? 'Permissions: Auto' : '权限：自动' })).toHaveText(locale === 'en' ? 'Auto' : '自动');
				await expect(picker).toBeHidden();
				await expect(page.getByLabel('Opened sources')).toHaveText('[{"approvalMode":"auto"}]');
				const updatedPermissions = footer.getByRole('button', { name: locale === 'en' ? 'Permissions: Auto' : '权限：自动' });
				await updatedPermissions.focus();
				await page.keyboard.press('Space');
				const autoOption = picker.getByRole('menuitemradio', { name: locale === 'en' ? 'Auto' : '自动', exact: true });
				await expect(autoOption).toBeFocused();
				await expect(autoOption).toHaveAttribute('aria-checked', 'true');
				await page.keyboard.press('ArrowDown');
				await expect(picker.getByRole('menuitemradio', { name: locale === 'en' ? 'Manual' : '手动', exact: true })).toBeFocused();
				await page.keyboard.press('Escape');
				await expect(updatedPermissions).toBeFocused();
				await updatedPermissions.click();
				await page.evaluate(() => window.ashChatInputIntegration.setVisible(false));
				await expect(picker).toBeHidden();
				await page.evaluate(() => window.ashChatInputIntegration.setVisible(true));
				await context.focus();
				await page.keyboard.press('Enter');
				const details = page.getByRole('dialog', { name: locale === 'en' ? 'Context usage' : '上下文用量' });
				await expect(details).toBeVisible();
				await expect(details).toBeFocused();
				await expect(context).toHaveAttribute('aria-expanded', 'true');
				await expect(details.locator('.ash-chat-context-details-summary')).toHaveText(locale === 'en' ? 'Estimated input: 200 / 800 tokens · 25%' : '估算输入：200 / 800 个 token · 25%');
				const accessibleDetails = await page.evaluate(() => window.ashChatInputIntegration.contextAccessibility());
				expect(accessibleDetails.content).toContain(locale === 'en' ? 'Estimated input: 200 / 800 tokens · 25%' : '估算输入：200 / 800 个 token · 25%');
				expect(accessibleDetails.help).toContain('Escape');
				await expect(details.getByRole('rowheader', { name: locale === 'en' ? 'Remaining input budget' : '剩余输入预算' }).locator('..')).toContainText('600');
				const detailsBounds = (await details.boundingBox())!;
				const contextBounds = (await context.boundingBox())!;
				expect(detailsBounds.y + detailsBounds.height).toBeLessThanOrEqual(contextBounds.y);
				await page.keyboard.press('Escape');
				await expect(details).toBeHidden();
				await expect(context).toBeFocused();
				await expect(context).toHaveAttribute('aria-expanded', 'false');
				await context.click();
				await page.keyboard.press('Tab');
				await expect(details.getByRole('button', { name: locale === 'en' ? 'Close context usage details' : '关闭上下文用量明细' })).toBeFocused();
				await page.keyboard.press('Tab');
				await expect(details).toBeHidden();
				await context.focus();
				await page.evaluate(() => window.ashChatInputIntegration.setFooterStatus(true));
				await expect(status).toBeVisible();
				await page.keyboard.press('Tab');
				await expect(status).toBeFocused();
				await page.keyboard.press('Enter');
				await expect(page.getByLabel('Opened sources')).toContainText('test.chat.status');
				await expect(input).toHaveValue('Keep my draft');
				for (const width of [240, 450]) {
					await page.locator('main').evaluate((element, width) => { element.style.width = `${width}px`; }, width);
					await expect(context).toBeVisible();
					await expect(status).toBeVisible();
					const bounds = await footer.boundingBox();
					for (const button of [add, updatedPermissions, context, status]) {
						const buttonBounds = await button.boundingBox();
						expect(buttonBounds!.x + buttonBounds!.width).toBeLessThanOrEqual(bounds!.x + bounds!.width + 1);
					}
				}
				await page.evaluate(() => window.ashChatInputIntegration.setFooterPhase('submitting'));
				await expect(footer.locator('.ash-chat-status-summary')).toHaveText(locale === 'en' ? 'Working…' : '正在运行…');
				await page.evaluate(() => window.ashChatInputIntegration.setFooterPhase('error', 'Connection was lost'));
				await expect(footer.locator('.ash-chat-status-summary')).toHaveText('Connection was lost');
				await page.evaluate(() => window.ashChatInputIntegration.setFooterPhase('ready'));
				await expect(footer.locator('.ash-chat-status-summary')).toBeHidden();
				if (locale === 'en' && theme === 'light') {
					await footer.screenshot({ path: browserTests.info.outputPath('chat-footer.png') });
				}
				await page.evaluate(() => window.ashChatInputIntegration.removeFooterStatus());
				await expect(status).toHaveCount(0);
				await context.click();
				await expect(details).toBeVisible();
				await page.evaluate(() => window.ashChatInputIntegration.setVisible(false));
				await expect(details).toHaveCount(0);
				await expect(context).toBeHidden();
				await page.evaluate(() => window.ashChatInputIntegration.setVisible(true));
				await expect(context).toBeVisible();
				await context.click();
				await expect(details).toBeVisible();
				await page.evaluate(() => window.ashChatInputIntegration.setContextUsage(false));
				await expect(details).toHaveCount(0);
				await expect(context).toHaveCount(0);
				await page.evaluate(() => window.ashChatInputIntegration.setContextUsage(true));
				await expect(context).toHaveAttribute('aria-label', locale === 'en' ? 'Context usage: 200 tokens, capacity unavailable' : '上下文用量：200 个 token，容量未知');
				await expect(ring.locator('.ash-chat-context-usage-track')).toHaveCSS('stroke-dasharray', 'none');
				await expect(ring.locator('.ash-chat-context-usage-value')).toHaveAttribute('stroke-dasharray', '0 100');
				await expect(ring.locator('.ash-chat-context-usage-value')).toBeHidden();
				await expect(context).toHaveAttribute('title', locale === 'en' ? 'Estimated context: 200 tokens\nContext capacity unavailable.' : '上下文估算：200 个 token\n容量未知');
				await expect(context).not.toHaveAttribute('aria-label', /%/);
				await context.click();
				await expect(details).toBeVisible();
				await expect(details.locator('.ash-chat-context-details-summary')).toHaveText(locale === 'en' ? '200 tokens · Capacity unavailable' : '200 个 token · 容量未知');
				await expect(details).not.toContainText('%');
				await expect(details.getByRole('columnheader')).toHaveCount(2);
				await expect(details.locator('.ash-chat-context-details-bar').locator('span')).toHaveCount(0);
				await expect(details.getByRole('rowheader', { name: locale === 'en' ? 'Remaining input budget' : '剩余输入预算' })).toHaveCount(0);
				await page.keyboard.press('Escape');
				await context.focus();
				const retainedButton = await context.elementHandle();
				await page.evaluate(() => window.ashChatInputIntegration.setContextUsage(true, 1000, 500));
				await expect(context).toHaveAttribute('aria-label', /50%/);
				await expect(context).toBeFocused();
				expect(await retainedButton!.evaluate(element => element.isConnected)).toBe(true);
				await expect(ring.locator('.ash-chat-context-usage-value')).toHaveAttribute('stroke-dasharray', '50 50');
				await context.click();
				await expect(details).toBeVisible();
				const close = details.getByRole('button', { name: locale === 'en' ? 'Close context usage details' : '关闭上下文用量明细' });
				await close.focus();
				await page.evaluate(() => window.ashChatInputIntegration.setContextUsage(true, 1000, 600));
				await expect(details.locator('.ash-chat-context-details-summary')).toContainText('60%');
				await expect(close).toBeFocused();
				await close.click();
				await expect(details).toBeHidden();
				await expect(context).toBeFocused();
				await context.click();
				await context.click();
				await expect(details).toBeHidden();
				await context.click();
				await input.click({ position: { x: 8, y: 8 } });
				await expect(details).toBeHidden();
				await expect(input).toBeFocused();
				await page.evaluate(() => window.ashChatInputIntegration.setContextUsage(true, 1000, 0));
				await expect(context).toHaveAttribute('aria-label', /0%/);
				await expect(ring.locator('.ash-chat-context-usage-value')).toBeHidden();
				await page.evaluate(() => window.ashChatInputIntegration.setContextUsage(true, 1000, 1500));
				await expect(context).toHaveAttribute('aria-label', /150%/);
				await expect(ring.locator('.ash-chat-context-usage-value')).toHaveAttribute('stroke-dasharray', '100 0');
				expect(await context.evaluate(element => element.getAnimations({ subtree: true }).length)).toBe(0);

				await page.evaluate(() => window.ashChatInputIntegration.openModels());
				await expect(page.getByRole('switch', { name: locale === 'en' ? 'Auto' : '自动', exact: true })).not.toBeChecked();
				await page.getByRole('menuitem', { name: locale === 'en' ? 'Add Models' : '添加模型' }).click();
				await expect(page.getByLabel('Opened sources')).toContainText('"command":"workbench.action.chat.manage"');
				await context.click();
				await expect(details).toBeVisible();
				await page.evaluate(() => window.ashChatInputIntegration.dispose());
				await expect(footer).toHaveCount(0);
				await expect(details).toHaveCount(0);
			});
		}
	}

	test('Input history pages older records and restores draft selection, attachments and pinned skills', async function () {
		const { page } = browserTests;

		await page.goto('/chatInput.html?history=1');
		const input = page.locator('.ash-chat-textarea-input');
		await input.fill('$commit draft ');
		await page.evaluate(() => { window.ashChatInputIntegration.addHistoryContext(); window.ashChatInputIntegration.setHistorySkill('original'); });
		const draft = await input.inputValue();
		expect(draft).toContain('draft.txt');
		await input.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(0, 0));
		await input.press('ArrowUp');
		await expect(input).toHaveValue('third input');
		await expect(input).not.toHaveValue(/draft\.txt/);
		await input.press('ArrowUp');
		await expect(input).toHaveValue('second input\nsecond line');
		await input.press('ArrowUp');
		await expect(input).toHaveValue('first input');
		await input.press('ArrowDown');
		await expect(input).toHaveValue('second input\nsecond line');
		await page.evaluate(() => window.ashChatInputIntegration.setHistorySkill('updated'));
		await input.press('Escape');
		await expect(input).toHaveValue(draft);
		expect(await input.evaluate((element: HTMLTextAreaElement) => [element.selectionStart, element.selectionEnd])).toEqual([0, 0]);
		await input.press('Enter');
		await expect.poll(() => page.evaluate(() => window.ashChatInputIntegration.historyState())).toMatchObject({
			writes: [draft], submissions: [{ text: draft, skills: [{ version: { type: 'pinnedDigest', digest: 'original' } }] }],
		});
		await expect(page.getByLabel('Submission', { exact: true })).toHaveText(JSON.stringify([{ name: 'draft.txt', content: 'synthetic context' }]));
	});

	for (const locale of ['en', 'zh-CN']) {
		test(`Input history search pages and fills text without sending in ${locale}`, async function () {
			const { page } = browserTests;

			await page.goto(`/chatInput.html?history=1&locale=${locale}`);
			const input = page.locator('.ash-chat-textarea-input');
			await input.fill('keep this draft');
			await input.press('Control+r');
			const search = page.getByRole('combobox', { name: locale === 'en' ? 'Search input history' : '搜索输入历史记录' });
			await expect(search).toBeVisible();
			await page.getByText(locale === 'en' ? 'Load more inputs' : '加载更多输入', { exact: true }).click();
			await page.getByText('first input', { exact: true }).first().click();
			await expect(search).toBeHidden();
			await expect(input).toHaveValue('first input');
			expect(await page.evaluate(() => window.ashChatInputIntegration.historyState())).toMatchObject({ writes: [], submissions: [] });
			await input.press('Escape');
			await expect(input).toHaveValue('keep this draft');
			await input.press('Control+r');
			await search.fill('second');
			await expect(page.getByText('second input', { exact: true })).toBeVisible();
			await search.press('Escape');
			await expect(input).toHaveValue('keep this draft');
			await expect(input).toBeFocused();
		});
	}

	test('Input history discards outdated search replies and safely closes a pending search', async function () {
		const { page } = browserTests;

		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto('/chatInput.html?history=1');
		const input = page.locator('.ash-chat-textarea-input');
		await input.fill('untouched draft');
		await input.press('Control+r');
		const search = page.getByRole('combobox', { name: 'Search input history' });
		await search.fill('wait-old');
		await expect.poll(() => page.evaluate(() => window.ashChatInputIntegration.historyState())).toMatchObject({ reads: expect.arrayContaining([expect.objectContaining({ text: 'wait-old' })]) });
		await search.fill('third');
		await expect(page.getByText('third input', { exact: true }).first()).toBeVisible();
		await page.evaluate(() => window.ashChatInputIntegration.releaseHistorySearch('wait-old'));
		await expect(page.getByText('third input', { exact: true }).first()).toBeVisible();
		await search.fill('wait-dispose');
		await expect.poll(() => page.evaluate(() => window.ashChatInputIntegration.historyState())).toMatchObject({ reads: expect.arrayContaining([expect.objectContaining({ text: 'wait-dispose' })]) });
		await page.evaluate(() => { window.ashChatInputIntegration.dispose(); window.ashChatInputIntegration.releaseHistorySearch('wait-dispose'); });
		await expect(search).toBeHidden();
		expect(errors).toEqual([]);
	});

	test('Input history never overwrites a draft edited while recall is pending', async function () {
		const { page } = browserTests;

		await page.goto('/chatInput.html?history=1');
		const input = page.locator('.ash-chat-textarea-input');
		await input.fill('original');
		await input.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(0, 0));
		await page.evaluate(() => window.ashChatInputIntegration.holdNextHistoryRead());
		await input.press('ArrowUp');
		await expect.poll(() => page.evaluate(() => window.ashChatInputIntegration.historyState())).toMatchObject({ reads: [expect.objectContaining({ text: '' })] });
		await input.fill('edited while loading');
		await page.evaluate(() => window.ashChatInputIntegration.releaseHistorySearch(''));
		await input.press('Escape');
		await expect(input).toHaveValue('edited while loading');
		await input.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(0, 0));
		await input.press('ArrowUp');
		await expect(input).toHaveValue('third input');
		await input.press('Escape');
		await expect(input).toHaveValue('edited while loading');
	});

	test('Chat textarea fallback starts compact and resizes with multiline content without losing focus', async function () {
		const { page } = browserTests;

		await page.goto('/chatInput.html');
		const composer = page.locator('.ash-chat-input-container');
		const input = composer.locator('.ash-chat-textarea-input');
		await expect(composer).toHaveCSS('height', '84px');
		await input.focus();
		await page.keyboard.insertText('First line\nSecond line');
		await expect(input).toHaveCSS('height', '40px');
		await page.keyboard.press('Shift+Enter');
		await page.keyboard.insertText('Third line');
		await expect(input).toHaveCSS('height', '60px');
		await expect(composer).toHaveCSS('height', '104px');
		await expect(input).toBeFocused();
		await page.keyboard.insertText('\n' + Array.from({ length: 50 }, (_, index) => `Line ${index}`).join('\n'));
		await expect(input).toHaveCSS('height', '314px');
		await expect(input).toBeFocused();
		await page.keyboard.press('ControlOrMeta+A');
		await page.keyboard.press('Backspace');
		await expect(composer).toHaveCSS('height', '84px');
		await expect(input).toBeFocused();
	});

	for (const locale of ['en', 'zh-CN']) {
		test(`model and mode menus share primary option typography in ${locale}`, async function () {
			const { page } = browserTests;

			await page.goto(`/chatInput.html?locale=${locale}`);
			await page.evaluate(() => window.ashChatInputIntegration.showModels());
			const typography = [];
			for (const [trigger, popup] of [
				['.ash-chat-input-mode-action', '.ash-chat-input-mode-menu'],
				['.ash-chat-input-model-action', '.ash-chat-model-picker'],
			]) {
				await page.locator(trigger).press('ArrowDown');
				const option = page.locator(popup).getByRole('menuitemradio').first();
				await expect(option).toBeVisible();
				typography.push(await option.evaluate(element => {
					const style = getComputedStyle(element);
					return { fontFamily: style.fontFamily, fontSize: style.fontSize, fontWeight: style.fontWeight };
				}));
				await page.keyboard.press('Escape');
				await expect(page.locator(trigger)).toBeFocused();
			}
			expect(typography[0].fontSize).toBe('13px');
			expect(typography[1]).toEqual(typography[0]);
		});

		test(`model and effort buttons share typography, pill corners and adjacent spacing in ${locale}`, async function () {
			const { page } = browserTests;

			await page.goto(`/chatInput.html?locale=${locale}`);
			await page.evaluate(() => window.ashChatInputIntegration.showModels());
			const mode = page.locator('.ash-chat-input-mode-action');
			const model = page.locator('.ash-chat-input-model-action');
			const effort = page.locator('.ash-chat-input-configuration-action');
			for (const width of [800, 400, 280]) {
				await page.setViewportSize({ width, height: 600 });
				await expect.poll(async () => {
					const metrics = await Promise.all([mode, model, effort].map(trigger => trigger.evaluate(element => {
						const style = getComputedStyle(element);
						const bounds = element.getBoundingClientRect();
						return {
							left: bounds.left, right: bounds.right, height: bounds.height,
							fontSize: style.fontSize, fontWeight: style.fontWeight,
							radius: style.borderRadius, padding: style.padding,
						};
					})));
					const [modeMetrics, modelMetrics, effortMetrics] = metrics;
					return {
						matchingTypography: modelMetrics.fontSize === effortMetrics.fontSize && modelMetrics.fontWeight === effortMetrics.fontWeight,
						matchingPillCorners: modelMetrics.radius === effortMetrics.radius && parseFloat(effortMetrics.radius) >= effortMetrics.height / 2,
						matchingPadding: modelMetrics.padding === effortMetrics.padding,
						matchingSpacing: Math.abs((modelMetrics.left - modeMetrics.right) - (effortMetrics.left - modelMetrics.right)) < 1,
						fits: effortMetrics.right <= width,
					};
				}).toEqual({ matchingTypography: true, matchingPillCorners: true, matchingPadding: true, matchingSpacing: true, fits: true });
			}
		});
	}

	for (const locale of ['en', 'zh-CN']) {
		test(`mode menu fits its contents and retains keyboard selection in ${locale}`, async function () {
			const { page } = browserTests;

			await page.goto(`/chatInput.html?locale=${locale}`);
			await page.evaluate(() => window.ashChatInputIntegration.showModels());
			const trigger = page.locator('[data-action-id="ash.chat.input.mode"] button');
			await trigger.press('ArrowDown');
			const menu = page.locator('.ash-chat-input-mode-menu');
			await expect(menu.getByRole('menuitemradio')).toHaveCount(5);
			const geometry = await menu.evaluate(element => ({
				width: element.getBoundingClientRect().width,
				overflow: element.scrollWidth - element.clientWidth,
			}));
			expect(geometry.width).toBeGreaterThanOrEqual(100);
			expect(geometry.width).toBeLessThan(240);
			expect(geometry.overflow).toBe(0);
			await expect(menu.getByRole('menuitemradio').first()).toBeFocused();
			await page.keyboard.press('ArrowDown');
			await expect(menu.getByRole('menuitemradio').nth(1)).toBeFocused();
			await page.keyboard.press('Enter');
			await expect(menu).toHaveCount(0);
		});
	}

	for (const locale of ['en', 'zh-CN']) {
		test(`approval targets and keyboard decisions use ${locale}`, async function () {
			const { page } = browserTests;

			const errors: string[] = [];
			page.on('pageerror', error => errors.push(error.message));
			await page.goto(locale === 'en' ? '/chatInput.html' : `/chatInput.html?locale=${locale}`);
			expect(errors).toEqual([]);
			const chinese = locale === 'zh-CN';
			const targets = page.getByRole('list', { name: chinese ? '请求的操作与目标' : 'Requested actions and targets' });
			await expect(targets.getByRole('listitem')).toHaveCount(10);
			await expect(targets.locator('code')).toHaveText(['/workspace/file with spaces.ts', String.raw`C:\Users\name\file.ts`, String.raw`\\server\share\file.ts`, 'pnpm test <script>', 'https://api.example.test', 'provider-key', 'issue:42', 'git.user.email', 'current window', `/workspace/${'a'.repeat(160)}.ts`]);
			await expect(targets.getByRole('listitem').first()).toHaveText(chinese ? '读取文件: /workspace/file with spaces.ts' : 'Read file: /workspace/file with spaces.ts');
			const decline = page.getByRole('button', { name: chinese ? '拒绝' : 'Decline', exact: true });
			const approve = page.getByRole('button', { name: chinese ? '批准一次' : 'Approve once', exact: true });
			await decline.focus();
			await page.evaluate(() => window.ashChatInputIntegration.refresh());
			await expect(decline).toBeFocused();
			await page.keyboard.press('Enter');
			await expect(page.getByRole('status', { name: 'Decision' })).toHaveText('decline');
			await page.keyboard.press('Tab');
			await expect(approve).toBeFocused();
			await page.keyboard.press('Space');
			await expect(page.getByRole('status', { name: 'Decision' })).toHaveText('approveOnce');
			await page.setViewportSize({ width: 320, height: 600 });
			expect(await targets.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
			expect(errors).toEqual([]);
		});
	}


	test('question controls resolve the editor background variable for each palette', async function () {
		const { page } = browserTests;

		await page.goto('/chatInput.html');
		await page.evaluate(() => window.ashChatInputIntegration.showQuestions());
		for (const background of ['rgb(30, 30, 30)', 'rgb(255, 255, 255)', 'rgb(0, 0, 0)']) {
			await page.locator('main').evaluate((element, value) => element.style.setProperty('--ash-editor-background', value), background);
			await expect(page.getByRole('textbox', { name: 'Your answer' })).toHaveCSS('background-color', background);
			await expect(page.getByRole('combobox', { name: 'Your choice' })).toHaveCSS('background-color', background);
		}
	});

	for (const { locale, surface } of ['en', 'zh-CN'].flatMap(locale => ['chat', 'cowork'].map(surface => ({ locale, surface })))) {
		test(`model options select effort and context independently in ${surface} ${locale}`, async function () {
			const { page } = browserTests;

			await page.goto(`/chatInput.html?locale=${locale}&surface=${surface}`);
			await page.evaluate(() => window.ashChatInputIntegration.showModels());
			const chinese = locale === 'zh-CN';
			const trigger = page.locator('.ash-chat-input-configuration-action');
			const menu = page.locator('.ash-chat-model-card-configurable');
			const lowCopy = chinese ? '较轻的推理，更快的响应' : 'Fast responses with lighter reasoning';
			const highCopy = chinese ? '为复杂问题提供更深入的推理' : 'Greater reasoning depth for complex problems';
			await expect(trigger).toHaveAttribute('aria-description', lowCopy);
			await expect(trigger).toHaveText(chinese ? '低' : 'Low');
			await trigger.press('ArrowDown');
			await expect(menu.locator('legend')).toHaveText(chinese ? ['推理强度', '上下文大小', '速度'] : ['Thinking Level', 'Context Size', 'Speed']);
			const contextDefault = menu.getByRole('radio', { name: chinese ? '272K（默认）' : '272K (Default)', exact: true });
			const expanded = menu.getByRole('radio', { name: '872K', exact: true });
			const low = menu.getByRole('radio', { name: chinese ? '低' : 'Low', exact: true });
			const high = menu.getByRole('radio', { name: chinese ? '高' : 'High', exact: true });
			await expect(contextDefault).toBeChecked();
			await expect(low).toHaveAttribute('aria-description', lowCopy);
			await expect(high).toHaveAttribute('aria-description', highCopy);
			await low.focus();
			await low.press('ArrowRight');
			await expect(high).toBeChecked();
			await expect(trigger).toHaveAttribute('aria-description', highCopy);
			await expect(trigger).toHaveText(chinese ? '高' : 'High');
			await expect(menu).toBeVisible();
			await expanded.focus();
			await expanded.press('Space');
			await expect(expanded).toBeChecked();
			await expect(high).toBeChecked();
			await expect(contextDefault).not.toBeChecked();
			await expect(menu.getByRole('radio')).toHaveCount(6);
			const geometry = await menu.evaluate(element => ({ overflow: element.scrollWidth - element.clientWidth, left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right }));
			expect(geometry.overflow).toBe(0);
			expect(geometry.left).toBeGreaterThanOrEqual(0);
			expect(geometry.right).toBeLessThanOrEqual(page.viewportSize()!.width);
			await contextDefault.focus();
			await contextDefault.press('Space');
			await expect(trigger).toHaveText(chinese ? '高' : 'High');
			await low.focus();
			await low.press('Space');
			await expect(trigger).toHaveText(chinese ? '低' : 'Low');
			await page.keyboard.press('Escape');
			await expect(trigger).toBeFocused();
			await expect(trigger).toHaveAttribute('aria-expanded', 'false');
		});
	}

	for (const { modelOptions, surface } of ['effort', 'context', 'none'].flatMap(modelOptions => ['chat', 'cowork'].map(surface => ({ modelOptions, surface })))) {
		test(`model options only show supported ${modelOptions} controls in ${surface}`, async function () {
			const { page } = browserTests;

			await page.goto(`/chatInput.html?modelOptions=${modelOptions}&surface=${surface}`);
			await page.evaluate(() => window.ashChatInputIntegration.showModels());
			const trigger = page.locator('.ash-chat-input-configuration-action');
			if (modelOptions === 'none') {
				await expect(trigger).toBeHidden();
				return;
			}
			await expect(trigger).toHaveText(modelOptions === 'effort' ? 'Low' : 'Model options');
			await expect(trigger).toHaveAccessibleName(modelOptions === 'effort' ? 'Model options: Low' : 'Model options');
			await trigger.press('ArrowDown');
			const menu = page.locator('.ash-chat-model-card-configurable');
			await expect(menu.locator('legend')).toHaveText(modelOptions === 'effort' ? 'Thinking Level' : 'Context Size');
			await expect(menu.getByRole('radiogroup')).toHaveCount(1);
			await expect(menu.getByRole('radio')).toHaveCount(2);
			const last = menu.getByRole('radio').last();
			await last.focus();
			await last.press('Space');
			await expect(trigger).toHaveText(modelOptions === 'effort' ? 'High' : 'Model options');
			await expect(last).toBeChecked();
			await page.keyboard.press('Escape');
		});
	}


	test('Mode picker keeps its Tab stop and shares menu activation, placement and dismissal', async function () {
		const { page } = browserTests;

		await page.goto('/chatInput.html');
		await page.evaluate(() => {
			window.ashChatInputIntegration.showModels();
			document.querySelector<HTMLElement>('main')!.style.marginTop = '300px';
		});
		const mode = page.locator('.ash-chat-input-mode-action');
		const model = page.locator('.ash-chat-input-model-action');
		const menu = page.locator('.ash-chat-input-mode-menu');
		await expect(mode).toHaveAttribute('tabindex', '0');
		await mode.focus();
		await page.keyboard.press('Tab');
		await expect(model).toBeFocused();
		await page.keyboard.press('Shift+Tab');
		await expect(mode).toBeFocused();
		await mode.hover();
		await page.mouse.down();
		await expect(menu).toBeVisible();
		await page.mouse.up();
		await expect(menu).toBeVisible();
		const trigger = (await mode.boundingBox())!;
		const popup = (await menu.boundingBox())!;
		expect(popup.y + popup.height).toBeLessThanOrEqual(trigger.y);
		await expect(menu.getByRole('menuitemradio')).toHaveCount(5);
		await page.keyboard.press('Escape');
		await expect(mode).toBeFocused();
		await expect(mode).toHaveAttribute('aria-expanded', 'false');
		for (const key of ['Enter', 'Space']) {
			await page.keyboard.down(key);
			await expect(menu).toBeVisible();
			await page.keyboard.up(key);
			await expect(menu).toBeVisible();
			await page.keyboard.press('Escape');
			await expect(mode).toBeFocused();
		}
		const modes: Record<string, { icon: string; color?: string; }> = {
			Agent: { icon: 'unlimited' }, Plan: { icon: 'plan', color: '--ash-charts-orange' }, Debug: { icon: 'debug', color: '--ash-charts-red' },
			Multitask: { icon: 'multitask', color: '--ash-charts-purple' }, Ask: { icon: 'chat-4', color: '--ash-charts-green' },
		};
		for (const name of ['Plan', 'Agent', 'Debug', 'Multitask', 'Ask']) {
			await mode.press('ArrowDown');
			const item = menu.getByRole('menuitemradio', { name, exact: true });
			await expect(item.locator(`[data-ash-icon-id="${modes[name]!.icon}"]`)).toBeVisible();
			await item.click();
			await expect(menu).toBeHidden();
			await expect(mode).toHaveText(name);
			await expect(mode.locator(`[data-ash-icon-id="${modes[name]!.icon}"]`)).toBeVisible();
			if (modes[name]!.color) {
				expect(await mode.evaluate((button, variable) => {
					const probe = document.createElement('span'); probe.style.color = `var(${variable})`; button.append(probe);
					try { return getComputedStyle(button).color === getComputedStyle(probe).color; } finally { probe.remove(); }
				}, modes[name]!.color!)).toBe(true);
			}
			await mode.press('ArrowDown');
			await expect(menu.getByRole('menuitemradio', { name, exact: true })).toBeFocused();
			await expect(menu.getByRole('menuitemradio').and(menu.locator('[aria-checked="true"]'))).toHaveCount(1);
			await expect(menu.getByRole('menuitemradio', { name, exact: true })).toHaveAttribute('aria-checked', 'true');
			await page.keyboard.press('Escape');
			await expect(mode).toBeFocused();
		}
		await model.press('Enter');
		await expect(page.getByRole('dialog', { name: 'Choose a chat model' })).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(model).toBeFocused();
	});

	for (const surface of ['chat', 'cowork']) {
		test(`Picker focus rings follow keyboard and pointer input in ${surface}`, async function () {
			const { page } = browserTests;

			await page.goto(`/chatInput.html?surface=${surface}`);
			await page.evaluate(() => window.ashChatInputIntegration.showModels());
			const model = page.locator('.ash-chat-input-model-action');
			const options = page.locator('.ash-chat-input-configuration-action');
			await model.focus();
			await page.keyboard.press('Tab');
			await expect(options).toBeFocused();
			await expect(options).toHaveCSS('outline-style', 'solid');
			await options.press('Enter');
			await page.keyboard.press('Escape');
			await expect(options).toBeFocused();
			await expect(options).toHaveCSS('outline-style', 'solid');
			await page.mouse.click(0, 0);
			await options.focus();
			await expect(options).toHaveCSS('outline-style', 'none');
			await page.keyboard.press('Shift+Tab');
			await expect(model).toBeFocused();
			await expect(model).toHaveCSS('outline-style', 'solid');
		});

		test(`model picker preserves width, Auto state and popup ownership in ${surface}`, async function () {
			const { page } = browserTests;

			await page.goto(`/chatInput.html?surface=${surface}&modelSet=multiple`);
			await page.evaluate(() => window.ashChatInputIntegration.showModels());
			const trigger = page.locator('.ash-chat-input-model-action');
			await trigger.press('ArrowDown');
			const picker = page.getByRole('dialog', { name: 'Choose a chat model' });
			const search = picker.locator('input[role=combobox]');
			const width = await picker.evaluate(element => element.getBoundingClientRect().width);
			expect(width).toBeGreaterThan(320);
			expect(width).toBeLessThanOrEqual(page.viewportSize()!.width * 0.8);
			await expect(search).toHaveCSS('outline-style', 'none');
			await expect(search).toHaveCSS('border-top-width', '0px');
			await expect(search).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
			const edges = await picker.evaluate(element => {
				const items = element.querySelector<HTMLElement>('.ash-action-widget-items')!;
				items.style.maxHeight = '28px';
				const row = items.querySelector('.ash-action-widget-action')!.getBoundingClientRect();
				const footer = element.querySelector('.ash-chat-model-picker-footer .ash-button')!.getBoundingClientRect();
				const result = { scrolls: items.scrollHeight > items.clientHeight, rowLeft: row.left, rowRight: row.right, footerLeft: footer.left, footerRight: footer.right };
				items.style.removeProperty('max-height');
				return result;
			});
			expect(edges.scrolls).toBe(true);
			expect(edges.rowLeft).toBe(edges.footerLeft);
			expect(edges.rowRight).toBe(edges.footerRight);
			await search.fill('test-model');
			await expect(picker.getByRole('menuitemradio')).toHaveCount(1);
			await expect(picker.getByRole('menuitemradio')).toHaveAccessibleName('Test Model');
			expect(await picker.evaluate(element => element.getBoundingClientRect().width)).toBe(width);
			await search.press('ArrowRight');
			const card = picker.getByRole('region', { name: 'Test Model', exact: true });
			await expect(card).toBeFocused();
			await expect(card).toHaveAttribute('aria-description', 'A model for everyday tasks');
			await expect(search).toHaveValue('test-model');
			expect(await picker.evaluate(element => element.getBoundingClientRect().width)).toBe(width);
			await card.press('Alt+ArrowLeft');
			await expect(search).toBeFocused();
			await search.fill('extended-model');
			await search.press('Enter');
			await expect(picker).toHaveCount(0);
			await expect(trigger).toHaveText('Extended model with a longer display name for coding');
			await expect(trigger).toBeFocused();
			await trigger.press('ArrowDown');
			await expect(picker.getByRole('menuitemradio', { name: 'Extended model with a longer display name for coding', exact: true })).toBeChecked();
			const auto = picker.getByRole('switch', { name: 'Auto', exact: true });
			await auto.press('Space');
			await expect(auto).toBeChecked();
			await expect(auto).toBeFocused();
			await expect(search).toBeHidden();
			await expect(picker.getByRole('menuitemradio')).toHaveCount(0);
			await expect(picker.getByRole('menuitem', { name: 'Add Models' })).toHaveCount(0);
			await auto.press('ControlOrMeta+f');
			await expect(auto).toBeFocused();
			await auto.press('Space');
			await expect(auto).not.toBeChecked();
			await expect(auto).toBeFocused();
			await expect(search).toBeVisible();
			await expect(picker.getByRole('menuitemradio')).toHaveCount(2);
			await page.locator('.ash-chat-input-configuration-action').click();
			await expect(picker.locator('.ash-chat-model-card-configurable')).toBeVisible();
			await page.keyboard.press('Escape');
			await expect(picker).toHaveCount(0);
			await expect(trigger).toHaveAttribute('aria-expanded', 'false');
			await trigger.click();
			await expect(picker).toBeVisible();
			await page.evaluate(() => window.ashChatInputIntegration.dispose());
			await expect(page.locator('.ash-action-widget')).toHaveCount(0);
		});
	}

	for (const locale of ['en', 'zh-CN']) {
		test(`model card refreshes provider descriptions without writing preferences in ${locale}`, async function () {
			const { page } = browserTests;

			await page.goto(`/chatInput.html?locale=${locale}&acceleration=multiple`);
			await page.evaluate(() => window.ashChatInputIntegration.showModels());
			const initial = await page.evaluate(() => window.ashChatInputIntegration.modelState());
			await page.locator('.ash-chat-input-model-action').press('ArrowDown');
			const search = page.getByRole('combobox');
			await search.press('ArrowRight');
			const card = page.locator('.ash-chat-model-card');
			await expect(card).toBeFocused();
			await page.evaluate(() => window.ashChatInputIntegration.setDescription('Updated provider description'));
			await expect(card.locator('.ash-chat-model-card-description')).toHaveText('Updated provider description');
			await expect(card).toHaveAttribute('aria-description', 'Updated provider description');
			await expect(card).toBeFocused();
			expect(await page.evaluate(() => window.ashChatInputIntegration.modelState())).toEqual(initial);
			await page.evaluate(() => window.ashChatInputIntegration.setDescription(null));
			await expect(card.locator('.ash-chat-model-card-description')).toBeHidden();
			await expect(card.getByRole('radio')).toHaveCount(7);
			await expect(card).toBeFocused();
			await page.evaluate(() => window.ashChatInputIntegration.setDescription('Restored provider description'));
			await expect(card.locator('.ash-chat-model-card-description')).toHaveText('Restored provider description');
			await expect(card).toBeFocused();
			await page.setViewportSize({ width: 320, height: 600 });
			expect(await card.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
			expect(await page.evaluate(() => window.ashChatInputIntegration.modelState())).toEqual(initial);
			await card.press('Escape');
			await expect(page.locator('.ash-chat-model-picker')).toHaveCount(0);
		});
	}


	for (const locale of ['en', 'zh-CN']) {
		test(`model card removes retired catalog entries without changing selection in ${locale}`, async function () {
			const { page } = browserTests;

			await page.goto(`/chatInput.html?locale=${locale}`);
			await page.evaluate(() => window.ashChatInputIntegration.showModels());
			const initial = await page.evaluate(() => window.ashChatInputIntegration.modelState());
			await page.locator('.ash-chat-input-model-action').press('ArrowDown');
			const search = page.getByRole('combobox');
			await search.press('ArrowRight');
			await expect(page.locator('.ash-chat-model-card')).toBeFocused();
			await page.evaluate(() => window.ashChatInputIntegration.setModelsAvailable(false));
			await expect(page.locator('.ash-chat-model-card-configurable')).toHaveCount(0);
			await expect(page.getByRole('menuitemradio')).toHaveCount(0);
			await expect(page.getByRole('button', { name: locale === 'en' ? 'Open Settings' : '打开设置', exact: true })).toBeFocused();
			expect(await page.evaluate(() => window.ashChatInputIntegration.modelState())).toMatchObject({ selectedModel: { provider: 'openai', model: 'test-model' }, automatic: false, preferenceWrites: [] });
			await page.evaluate(() => window.ashChatInputIntegration.setModelsAvailable(true));
			await search.press('ArrowRight');
			await expect(page.locator('.ash-chat-model-card')).toBeFocused();
			expect(await page.evaluate(() => window.ashChatInputIntegration.modelState())).toEqual(initial);
		});
	}


	for (const surface of ['chat', 'cowork']) {
		test(`Split picker activates on mouse down and keyboard press without a second activation in ${surface}`, async function () {
			const { page } = browserTests;

			await page.goto(`/chatInput.html?surface=${surface}`);
			await page.evaluate(() => window.ashChatInputIntegration.showModels());
			const control = page.locator('.ash-chat-model-picker-control');
			await expect(control).toHaveAttribute('role', 'group');
			await expect(control.locator(':scope > a[role="button"]')).toHaveCount(2);
			await page.evaluate(() => window.ashChatInputIntegration.openModels());
			await expect(page.getByRole('dialog', { name: 'Choose a chat model' })).toBeVisible();
			await page.keyboard.press('Escape');
			for (const { trigger, popup } of [
				{ trigger: control.locator('.ash-chat-input-model-action'), popup: page.getByRole('dialog', { name: 'Choose a chat model' }) },
				{ trigger: control.locator('.ash-chat-input-configuration-action'), popup: page.getByRole('dialog', { name: 'Choose a chat model' }) },
			]) {
				await trigger.hover();
				await page.mouse.down({ button: 'right' });
				await expect(popup).toBeHidden();
				await page.mouse.up({ button: 'right' });
				await page.mouse.down();
				await expect(popup).toBeVisible();
				await page.mouse.up();
				await expect(popup).toBeVisible();
				await page.keyboard.press('Escape');
				await expect(trigger).toBeFocused();
				for (const key of ['Enter', 'Space']) {
					await page.keyboard.down(key);
					await expect(popup).toBeVisible();
					await page.keyboard.up(key);
					await expect(popup).toBeVisible();
					await page.keyboard.press('Escape');
					await expect(trigger).toBeFocused();
				}
			}
		});

		test(`Model widget highlights only the hovered trigger in ${surface}`, async function () {
			const { page } = browserTests;

			await page.goto(`/chatInput.html?surface=${surface}`);
			await page.evaluate(() => window.ashChatInputIntegration.showModels());
			const control = page.locator('.ash-chat-model-picker-control');
			const model = control.locator('.ash-chat-input-model-action');
			const options = control.locator('.ash-chat-input-configuration-action');
			await page.mouse.move(0, 0);
			await expect(control).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
			if (surface === 'chat') {
				// Generic toolbar hover comes from the production Workbench host stylesheet.
				await page.locator('body').evaluate(element => element.classList.add('ash-workbench'));
				const context = page.locator('[data-action-id="ash.chat.input.attach"] button');
				await context.hover();
				const background = await context.evaluate(element => getComputedStyle(element).backgroundColor);
				expect(background).not.toBe('rgba(0, 0, 0, 0)');
				await model.hover();
				await expect(model).toHaveCSS('background-color', background);
				await expect(control).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
				await page.mouse.move(0, 0);
				await expect(model).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
				await expect(control).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
			}
			for (const background of ['rgb(45, 45, 45)', 'rgb(225, 225, 225)', 'rgb(255, 255, 0)']) {
				await control.evaluate((element, value) => element.style.setProperty('--ash-toolbar-hoverBackground', value), background);
				await model.hover();
				await expect(model).toHaveCSS('background-color', background);
				await expect(options).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
				await expect(control).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
				await options.hover();
				await expect(options).toHaveCSS('background-color', background);
				await expect(model).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
				await expect(control).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
				const modelBounds = (await model.boundingBox())!;
				const optionsBounds = (await options.boundingBox())!;
				expect(optionsBounds.x - modelBounds.x - modelBounds.width).toBeGreaterThan(0);
				await page.mouse.move((modelBounds.x + modelBounds.width + optionsBounds.x) / 2, modelBounds.y + modelBounds.height / 2);
				await expect(model).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
				await expect(options).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
				await expect(control).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
				await page.mouse.move(0, 0);
				await expect(model).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
				await expect(options).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
				await expect(control).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
			}
		});

		test(`Both model triggers retain independent Tab stops and toolbar navigation in ${surface}`, async function () {
			const { page } = browserTests;

			await page.goto(`/chatInput.html?surface=${surface}&modelSet=multiple`);
			await page.evaluate(() => window.ashChatInputIntegration.showModels());
			const control = page.locator('.ash-chat-model-picker-control');
			const model = control.locator('.ash-chat-input-model-action');
			const options = control.locator('.ash-chat-input-configuration-action');
			const retainedModel = await model.elementHandle();
			const retainedOptions = await options.elementHandle();
			await expect(control.getByRole('button')).toHaveCount(2);
			await expect(model).toHaveAttribute('tabindex', '0');
			await expect(options).toHaveAttribute('tabindex', '0');
			await model.focus();
			await page.keyboard.press('Tab');
			await expect(options).toBeFocused();
			await page.keyboard.press('Shift+Tab');
			await expect(model).toBeFocused();
			await model.press('ArrowRight');
			await expect(options).toBeFocused();
			await expect(options).toHaveAttribute('tabindex', '0');
			await expect(model).toHaveAttribute('tabindex', '0');
			await expect(options).toHaveAccessibleName('Model options: Low');
			await options.press('ArrowDown');
			await page.getByRole('radio', { name: 'High', exact: true }).focus();
			await page.keyboard.press('Space');
			await page.keyboard.press('Escape');
			await expect(options).toHaveText('High');
			await expect(options).toBeFocused();
			expect(await options.evaluate((current, retained) => current === retained, retainedOptions)).toBe(true);
			expect(await model.evaluate((current, retained) => current === retained, retainedModel)).toBe(true);
			await options.press('ArrowLeft');
			await expect(model).toBeFocused();
			await expect(model).toHaveAttribute('tabindex', '0');
			await expect(options).toHaveAttribute('tabindex', '0');
			await model.press('ArrowDown');
			const picker = page.getByRole('dialog', { name: 'Choose a chat model' });
			await picker.getByRole('switch', { name: 'Auto', exact: true }).press('Space');
			await expect(options).toBeHidden();
			await expect(options).toHaveAttribute('tabindex', '-1');
			await page.keyboard.press('Escape');
			await expect(model).toBeFocused();
			await model.press('ArrowDown');
			await picker.getByRole('switch', { name: 'Auto', exact: true }).press('Space');
			await page.keyboard.press('Escape');
			await expect(options).toBeVisible();
			await expect(options).toHaveAttribute('tabindex', '0');
			await page.setViewportSize({ width: 280, height: 600 });
			const geometry = await control.evaluate(element => ({ overflow: element.scrollWidth - element.clientWidth, right: element.getBoundingClientRect().right }));
			expect(geometry.overflow).toBe(0);
			expect(geometry.right).toBeLessThanOrEqual(280);
			await retainedModel?.dispose();
			await retainedOptions?.dispose();
		});

	}

	for (const locale of ['en', 'zh-CN']) {
		test(`retirement announcements update the open model menu and remain selectable in ${locale}`, async function () {
			const { page } = browserTests;

			await page.goto(`/chatInput.html?locale=${locale}`);
			await page.evaluate(() => window.ashChatInputIntegration.showModels());
			const trigger = page.locator('.ash-chat-input-model-action');
			await trigger.press('ArrowDown');
			const menu = page.locator('.ash-chat-model-picker');
			const row = menu.getByRole('menuitemradio', { name: 'Test Model', exact: true });
			await expect(row.locator('.ash-menu-badge')).toHaveCount(0);
			await page.evaluate(() => window.ashChatInputIntegration.setRetirement({}));
			const announced = locale === 'zh-CN' ? '即将退役' : 'Retiring soon';
			await expect(row.locator('.ash-menu-badge')).toHaveText(announced);
			await expect(row).toHaveAttribute('aria-description', new RegExp(announced));
			await page.evaluate(() => window.ashChatInputIntegration.setRetirement({ shutdownDate: '2027-01-31' }));
			const scheduled = locale === 'zh-CN' ? '将于 2027-01-31 退役' : 'Retires on 2027-01-31';
			await expect(row.locator('.ash-menu-badge')).toHaveText(scheduled);
			expect(await row.locator('.ash-menu-badge').evaluate(element => element.getBoundingClientRect().height)).toBeLessThan(28);
			await expect(row).toHaveAttribute('aria-description', new RegExp(scheduled));
			await page.setViewportSize({ width: 280, height: 600 });
			expect(await row.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
			const search = menu.getByRole('combobox');
			await search.fill('2027-01-31');
			await expect(row).toBeVisible();
			await search.fill('');
			await page.evaluate(() => window.ashChatInputIntegration.setRetirement(undefined));
			await expect(row.locator('.ash-menu-badge')).toHaveCount(0);
			await expect(row).not.toHaveAttribute('aria-description', /2027-01-31/);
			await page.evaluate(() => window.ashChatInputIntegration.setRetirement({ shutdownDate: '2027-01-31' }));
			await search.press('ArrowDown');
			await expect(row).toBeFocused();
			expect(await row.evaluate(element => getComputedStyle(element.querySelector('.ash-menu-badge')!).color === getComputedStyle(element).color)).toBe(true);
			await row.press('Enter');
			await expect(menu).toHaveCount(0);
			await expect(trigger).toBeFocused();
		});
	}

	test('Chat changes animate the latest values and preserve partial, error and focus states', async function () {
		const { page } = browserTests;

		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto('/chatInput.html?locale=en&theme=light');
		await page.evaluate(() => window.ashChatInputIntegration.setChanges({ files: 1, additions: 9, deletions: 9 }));
		const changes = page.locator('.ash-chat-changes-pill');
		await changes.focus();
		const transition = await page.evaluate(() => {
			window.ashChatInputIntegration.setChanges({ files: 2, additions: 100, deletions: 10, partial: true });
			const counters = [...document.querySelectorAll<HTMLElement>('.ash-chat-changes-pill .ash-animated-counter')];
			for (const counter of counters) for (const animation of counter.getAnimations({ subtree: true })) animation.pause();
			return counters.map(counter => ({ text: counter.textContent, marker: getComputedStyle(counter, '::after').content, animations: counter.getAnimations({ subtree: true }).length }));
		});
		expect(transition).toEqual([{ text: '+100', marker: '"*"', animations: 3 }, { text: '−10', marker: '"*"', animations: 3 }]);
		await expect(changes).toHaveAccessibleName('Open Conversation Changes: 2 files, 100 lines added, 10 lines removed. Line counts exclude files that cannot be compared as text.');
		await expect(changes).toBeFocused();
		await expect(changes.locator('.ash-chat-changes-statistics')).toHaveAttribute('aria-hidden', 'true');
		await page.evaluate(() => window.ashChatInputIntegration.setChangesError('Repository unavailable'));
		await expect(changes).toBeHidden();
		await expect(page.getByRole('textbox', { name: 'Chat message', exact: true })).toBeFocused();
		expect(await changes.evaluate(element => element.getAnimations({ subtree: true }).length)).toBe(0);
		await page.evaluate(() => window.ashChatInputIntegration.setChanges({ files: 1, additions: 3, deletions: 0 }));
		await expect(changes).toBeVisible();
		await expect(changes).toHaveText('1 file+3 −0');
		await expect(changes.locator('.ash-animated-counter-outgoing')).toHaveCount(0);
		await changes.focus();
		await page.evaluate(() => window.ashChatInputIntegration.setChanges(undefined));
		await expect(changes).toBeHidden();
		await expect(page.getByRole('textbox', { name: 'Chat message', exact: true })).toBeFocused();
		expect(errors).toEqual([]);
	});

	for (const locale of ['en', 'zh-CN']) {
		for (const theme of ['light', 'dark', 'hcLight', 'hcDark']) {
			for (const surface of ['code', 'cowork']) {
				test(`Chat changes button shows statistics above the input in ${locale} ${theme} ${surface}`, async function () {
					const { page } = browserTests;

					await page.goto(`/chatInput.html?locale=${locale}&theme=${theme}&surface=${surface}`);
					await page.evaluate(() => window.ashChatInputIntegration.showModels());
					const input = page.getByRole('textbox', { name: 'Chat message', exact: true });
					await input.fill('Keep my draft');
					const changes = page.locator('.ash-chat-changes-pill');
					await expect(changes).toBeHidden();
					await page.evaluate(() => window.ashChatInputIntegration.setChanges({ files: 3, additions: 677, deletions: 31 }));
					await expect(changes).toBeVisible();
					await expect(changes).toHaveText(locale === 'en' ? '3 files+677 −31' : '3 个文件+677 −31');
					await expect(changes).toHaveAccessibleName(locale === 'en' ? 'Open Conversation Changes: 3 files, 677 lines added, 31 lines removed' : '打开会话变更：3 个文件，新增 677 行，删除 31 行');
					for (const width of [240, 450]) {
						await page.locator('main').evaluate((element, width) => { element.style.width = `${width}px`; }, width);
						const button = (await changes.boundingBox())!;
						const composer = (await page.locator('.ash-chat-input-container').boundingBox())!;
						expect(button.y + button.height).toBeLessThanOrEqual(composer.y);
						expect(button.x + button.width).toBeLessThanOrEqual(composer.x + composer.width);
					}
					if (locale === 'en' && theme === 'light' && surface === 'code') {
						await page.locator('main').screenshot({ path: browserTests.info.outputPath('chat-changes-button.png') });
					}
					await changes.focus();
					await page.keyboard.press('Enter');
					await expect(page.getByLabel('Opened sources')).toHaveText('[{"changes":true}]');
					await expect(input).toHaveValue('Keep my draft');
					await page.evaluate(() => window.ashChatInputIntegration.setChanges({ files: 1, additions: 2, deletions: 0 }));
					await expect(changes).toHaveText(locale === 'en' ? '1 file+2 −0' : '1 个文件+2 −0');
					await expect(changes).toBeFocused();
					await page.keyboard.press('Space');
					await expect(page.getByLabel('Opened sources')).toHaveText('[{"changes":true},{"changes":true}]');
					await page.evaluate(() => window.ashChatInputIntegration.setChanges({ files: 0, additions: 0, deletions: 0 }));
					await expect(changes).toBeHidden();
					await expect(input).toBeFocused();
					await page.evaluate(() => window.ashChatInputIntegration.setChangesError('Repository unavailable'));
					await expect(changes).toBeHidden();
					await expect(page.getByRole('button', { name: /Changes unavailable|变更不可用/ })).toHaveCount(0);
					const help = await page.evaluate(() => window.ashChatInputIntegration.inputAccessibility());
					expect(help).toContain(locale === 'en' ? 'The button is hidden when there are no changes or the summary is unavailable.' : '没有变更或摘要不可用时，按钮会隐藏。');
					await expect(input).toHaveValue('Keep my draft');
				});
			}
		}
	}


	for (const locale of ['en', 'zh-CN']) {

		test(`Failed input restores its original Skill binding and cursor in ${locale}`, async function () {
			const { page } = browserTests;

			await page.goto(`/chatInput.html?locale=${locale}&history=1&sendFailure=1`);
			await page.evaluate(() => { window.ashChatInputIntegration.showModels(); window.ashChatInputIntegration.setHistorySkill('original'); });
			const input = page.locator('.ash-chat-textarea-input');
			await input.fill('$commit review');
			await input.evaluate(element => (element as HTMLTextAreaElement).setSelectionRange(2, 7, 'backward'));
			await input.press('Enter');
			await expect(input).toHaveValue('$commit review');
			await expect.poll(() => input.evaluate(element => { const input = element as HTMLTextAreaElement; return [input.selectionStart, input.selectionEnd, input.selectionDirection]; })).toEqual([2, 7, 'backward']);
			await page.evaluate(() => window.ashChatInputIntegration.setHistorySkill('updated'));
			await input.press('Enter');
			await expect.poll(() => page.evaluate(() => window.ashChatInputIntegration.historyState())).toMatchObject({
				submissions: [
					{ skills: [{ version: { type: 'pinnedDigest', digest: 'original' } }] },
					{ skills: [{ version: { type: 'pinnedDigest', digest: 'original' } }] },
				]
			});
		});
	}

	for (const locale of ['en', 'zh-CN']) {
		for (const method of ['paste', 'drop'] as const) {
			test(`Mixed ${method} inserts code and images at the message cursor in ${locale}`, async function () {
				const { page } = browserTests;
				const testInfo = browserTests.info;

				await page.goto(`/chatInput.html?inlineCode=1&locale=${locale}&history=1&sendFailure=1`);
				await page.evaluate(() => window.ashChatInputIntegration.showModels());
				const input = page.locator('.ash-chat-input-editor').getByRole('textbox');
				await input.focus();
				await page.keyboard.type('Review  please');
				await input.press('Home');
				for (let index = 0; index < 7; index++) await input.press('ArrowRight');
				const prevented = await input.evaluate((element, method) => {
					const transfer = new DataTransfer();
					transfer.items.add(new File(['const captured = 42;'], 'sample.ts', { type: 'text/plain' }));
					const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DQAAAEgQGALFXOsAAAAABJRU5ErkJggg=='), char => char.charCodeAt(0));
					transfer.items.add(new File([bytes], 'preview.png', { type: method === 'paste' ? '' : 'application/octet-stream' }));
					const event = method === 'paste'
						? new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true })
						: new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true });
					element.dispatchEvent(event);
					return event.defaultPrevented;
				}, method);
				expect(prevented).toBe(true);
				const reference = page.locator('.ash-chat-code-reference');
				await expect(reference).toHaveText('sample.ts');
				const bar = page.locator('.ash-chat-input-attachments');
				await expect(bar).toHaveCount(0);
				const thumbnail = page.locator('.ash-chat-image-reference-control').getByRole('img', { name: 'preview.png' });
				await expect(thumbnail).toBeVisible();
				await expect(input).toBeFocused();
				const accessibility = await page.evaluate(() => window.ashChatInputIntegration.contextAccessibility());
				expect(accessibility.help).toContain(locale === 'en' ? 'Activate the thumbnail or file name to preview the image' : '点击缩略图或文件名可预览图片');
				await page.getByRole('button', { name: locale === 'en' ? 'Preview preview.png' : '预览 preview.png', exact: true }).click();
				await expect(page.getByRole('dialog').getByRole('img', { name: 'preview.png' })).toBeVisible();
				await page.keyboard.press('Escape');
				await expect(page.getByRole('dialog')).toHaveCount(0);
				await page.getByRole('button', { name: locale === 'en' ? 'Remove preview.png' : '移除 preview.png', exact: true }).click();
				await expect(thumbnail).toHaveCount(0);
				await expect(reference).toHaveText('sample.ts');
				await input.press('ControlOrMeta+z');
				await expect(thumbnail).toBeVisible();
				expect(await page.evaluate(() => window.ashChatInputIntegration.restoreCapturedDraft())).toBe('Review sample.ts preview.png please');
				await expect(reference).toHaveText('sample.ts');
				await page.locator('main').screenshot({ path: testInfo.outputPath('mixed-file-context.png') });
				await input.press('Enter');
				await expect(page.getByLabel('Submission', { exact: true })).toContainText('const captured = 42;');
				await expect.poll(() => page.evaluate(() => window.ashChatInputIntegration.historyState())).toMatchObject({ submissions: [{ text: 'Review sample.ts preview.png please' }] });
				const submitted = JSON.parse((await page.getByLabel('Submission', { exact: true }).textContent())!);
				expect(submitted).toEqual([
					{ name: 'sample.ts', content: 'const captured = 42;' },
					expect.objectContaining({ name: 'preview.png', kind: 'image' }),
				]);
				await expect(reference).toHaveText('sample.ts');
				await expect(thumbnail).toBeVisible();
				await expect(bar).toHaveCount(0);
			});
		}
	}

	for (const theme of ['light', 'dark', 'hcLight', 'hcDark']) {
		test(`Inline image controls keep long names bounded and support keyboard preview and deletion in ${theme}`, async function () {
			const { page } = browserTests;
			const testInfo = browserTests.info;

			await page.goto(`/chatInput.html?inlineCode=1&locale=zh-CN&theme=${theme}`);
			await page.setViewportSize({ width: 400, height: 640 });
			await page.locator('main').evaluate(element => { element.style.width = '320px'; });
			await page.evaluate(() => window.ashChatInputIntegration.showModels());
			const input = page.locator('.ash-chat-input-editor').getByRole('textbox');
			await input.focus();
			await page.keyboard.insertText('对比图片：\n当前界面：\n参考设计：');
			await input.press('Home');
			await input.press('ArrowUp');
			await input.press('End');
			const name = 'current-layout-reference-with-a-long-file-name.png';
			await input.evaluate((element, name) => {
				const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
				const context = canvas.getContext('2d')!;
				context.fillStyle = '#e3edff'; context.fillRect(0, 0, 320, 180);
				context.fillStyle = '#2c5b9c'; context.font = '24px sans-serif'; context.fillText('Current layout', 24, 52);
				context.fillStyle = '#ffffff'; context.fillRect(24, 76, 272, 80);
				const bytes = Uint8Array.from(atob(canvas.toDataURL('image/png').split(',')[1]!), char => char.charCodeAt(0));
				const transfer = new DataTransfer(); transfer.items.add(new File([bytes], name, { type: 'image/png' }));
				element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
			}, name);
			const labels = page.locator('.ash-chat-image-reference-control .ash-button-label').first();
			await expect.poll(async () => (await labels.allTextContents()).join('')).toBe(name);
			const preview = page.getByRole('button', { name: `预览 ${name}`, exact: true });
			const remove = page.getByRole('button', { name: `移除 ${name}`, exact: true });
			await expect(preview).toBeVisible();
			await expect(remove).toBeVisible();
			const placement = await page.locator('.ash-chat-input-editor').evaluate(element => {
				const chip = element.querySelector('.ash-chat-image-reference-control')!;
				const label = chip.querySelector('.ash-button-label')!;
				const thumbnail = chip.querySelector('img')!;
				const remove = chip.querySelector('.ash-chat-attachment-remove')!;
				const bounds = element.getBoundingClientRect();
				return { overflow: element.scrollWidth > element.clientWidth, clipped: chip.getBoundingClientRect().right > bounds.right + 1, firstLabel: label.getBoundingClientRect().toJSON(), lastLabel: label.getBoundingClientRect().toJSON(), before: thumbnail.getBoundingClientRect().toJSON(), after: remove.getBoundingClientRect().toJSON() };
			});
			expect(placement.overflow).toBe(false);
			expect(placement.clipped).toBe(false);
			expect(placement.before.right).toBeLessThanOrEqual(placement.firstLabel.left + 1);
			expect(placement.after.left).toBeGreaterThanOrEqual(placement.lastLabel.right - 1);
			await page.locator('main').screenshot({ path: testInfo.outputPath('inline-image-wrapped.png') });
			await input.press('Tab');
			await expect(preview).toBeFocused();
			await preview.press('Enter');
			const dialog = page.getByRole('dialog', { name: `预览 ${name}` });
			await expect(dialog.getByRole('img', { name })).toBeVisible();
			const accessiblePreview = await page.evaluate(() => window.ashChatInputIntegration.contextAccessibility());
			expect(accessiblePreview.content).toContain(`图片预览：${name}`);
			expect(accessiblePreview.content).toContain('尺寸：320 × 180');
			await page.screenshot({ path: testInfo.outputPath('inline-image-preview.png') });
			await page.keyboard.press('Escape');
			await expect(preview).toBeFocused();
			await preview.press('Tab');
			await expect(remove).toBeFocused();
			await remove.press('Enter');
			await expect(preview).toHaveCount(0);
			await expect(input).toBeFocused();
			await input.press('ControlOrMeta+z');
			await expect(preview).toBeVisible();
			expect(await page.evaluate(() => window.ashChatInputIntegration.restoreCapturedDraft())).toContain(`当前界面： ${name}`);
			await expect(page.locator('.ash-chat-input-attachments')).toHaveCount(0);
			await labels.first().click();
			await expect(dialog).toBeVisible();
			await page.getByRole('button', { name: '关闭图片预览', exact: true }).click();
			await expect(dialog).toHaveCount(0);
		});
	}


	for (const locale of ['en', 'zh-CN']) {
		test(`Input accessibility help describes pending file preparation in ${locale}`, async function () {
			const { page } = browserTests;

			await page.goto(`/chatInput.html?locale=${locale}`);
			await page.locator('.ash-chat-textarea-input').focus();
			const help = await page.evaluate(() => window.ashChatInputIntegration.inputAccessibility());
			expect(help).toContain(locale === 'en' ? 'Sending waits until file preparation finishes; a failed preparation keeps the draft.' : '发送会等待文件准备完成；准备失败时会保留草稿。');
		});
	}


	for (const locale of ['en', 'zh-CN']) {
		for (const theme of ['light', 'dark', 'hcDark', 'hcLight']) {
			test(`permission subsets use keyboard controls in ${locale} ${theme}`, async function () {
				const { page } = browserTests;

				await page.goto(`/chatInput.html?permissions=1&locale=${locale}&theme=${theme}`);
				const chinese = locale === 'zh-CN';
				const read = page.getByRole('checkbox', { name: chinese ? '读取文件' : 'Read files', exact: true });
				const write = page.getByRole('checkbox', { name: chinese ? '写入文件' : 'Write files', exact: true });
				await expect(read).not.toBeChecked();
				await expect(write).not.toBeChecked();
				await read.focus();
				await page.keyboard.press('Space');
				await expect(read).toBeChecked();
				await page.evaluate(() => window.ashChatInputIntegration.refresh());
				await expect(read).toBeFocused();
				const duration = page.getByRole('combobox', { name: chinese ? '权限有效期' : 'Permission duration', exact: true });
				await expect(duration).toHaveValue('turn');
				await page.getByRole('button', { name: chinese ? '批准所选权限' : 'Approve selected', exact: true }).press('Enter');
				await expect(page.getByRole('status', { name: 'Decision' })).toHaveText(JSON.stringify({ duration: 'turn', directories: [{ path: '/workspace/<img src=x>', permissions: ['readFiles'] }], networkHosts: [] }));
				await expect(page.locator('.ash-chat-interaction img')).toHaveCount(0);
				await page.getByRole('button', { name: chinese ? '拒绝' : 'Decline', exact: true }).press('Space');
				await expect(page.getByRole('status', { name: 'Decision' })).toHaveText(JSON.stringify({ duration: 'turn', directories: [], networkHosts: [] }));
			});
		}
	}

	for (const surface of ['code', 'cowork']) {
		test(`Chat changes scope fences workspace responses and hidden polling in ${surface}`, async function () {
			const { page } = browserTests;

			await page.clock.install();
			await page.goto(`/chatInput.html?surface=${surface}`);
			await page.evaluate(() => { window.ashChatInputIntegration.showModels(); window.ashChatInputIntegration.setChangesScope('workspace'); });
			await expect.poll(() => page.evaluate(() => window.ashChatInputIntegration.workspaceChangesReads())).toBe(1);
			await page.evaluate(() => { window.ashChatInputIntegration.setChangesScope('conversation'); window.ashChatInputIntegration.releaseWorkspaceChanges({ files: 99, additions: 99, deletions: 99 }); });
			const changes = page.locator('.ash-chat-changes-pill');
			await expect(changes).toBeHidden();
			await page.evaluate(() => window.ashChatInputIntegration.setChangesScope('workspace'));
			await expect.poll(() => page.evaluate(() => window.ashChatInputIntegration.workspaceChangesReads())).toBe(2);
			await page.evaluate(() => window.ashChatInputIntegration.releaseWorkspaceChanges({ files: 2, additions: 3, deletions: 1 }));
			await expect(changes).toHaveAccessibleName('Open Workspace Changes: 2 files, 3 lines added, 1 lines removed');
			await page.evaluate(() => window.ashChatInputIntegration.setVisible(false));
			await page.clock.runFor(15000);
			expect(await page.evaluate(() => window.ashChatInputIntegration.workspaceChangesReads())).toBe(2);
			await page.evaluate(() => { window.ashChatInputIntegration.setVisible(true); window.ashChatInputIntegration.setChangesScope('conversation'); window.ashChatInputIntegration.setChanges({ files: 0, additions: 0, deletions: 0 }); });
			await expect(changes).toBeHidden();
			await page.evaluate(() => window.ashChatInputIntegration.setChangesError('Changes are unavailable. Open Changes to retry.'));
			await expect(changes).toBeHidden();
			await page.evaluate(() => window.ashChatInputIntegration.setChanges({ files: 1, additions: 3, deletions: 0 }));
			await expect(changes).toBeVisible();
			await changes.click();
			await expect(page.getByLabel('Opened sources')).toHaveText('[{"changes":true}]');
		});
	}

	test('Chat mode choices use the shared action widget and floating elevation across themes', async function () {
		const { page } = browserTests;

		for (const theme of ['light', 'dark', 'hcDark', 'hcLight']) {
			await page.goto(`/chatInput.html?theme=${theme}`);
			await page.evaluate(() => window.ashChatInputIntegration.showModels());
			const picker = page.locator('[data-action-id="ash.chat.input.mode"] button');
			await picker.press('ArrowDown');
			const widget = page.locator('.ash-action-widget.ash-chat-input-mode-menu');
			await expect(widget).toBeVisible();
			const geometry = await widget.evaluate(element => ({
				width: element.getBoundingClientRect().width,
				overflow: element.scrollWidth - element.clientWidth,
				truncated: [...element.querySelectorAll('.ash-button-label')].some(label => label.scrollWidth > label.clientWidth),
			}));
			expect(geometry.width).toBeGreaterThanOrEqual(100);
			expect(geometry.width).toBeLessThan(240);
			expect(geometry.overflow).toBe(0);
			expect(geometry.truncated).toBe(false);
			const shell = widget.locator('..');
			await expect(shell).toHaveCSS('box-shadow', 'none');
			await expect(shell).toHaveCSS('border-width', '0px');
			await expect(shell).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
			await expect(widget).toHaveCSS('box-shadow', theme.startsWith('hc') ? 'none' : 'rgba(0, 0, 0, 0.14) 0px 0px 12px 0px');
			await expect(widget).toHaveCSS('border-radius', '8px');
			await expect(widget).toHaveCSS('border-style', 'solid');
			expect(await widget.evaluate(element => Math.round(parseFloat(getComputedStyle(element).borderTopWidth)))).toBe(1);
			await expect(widget).toHaveCSS('font-size', '13px');
			const agent = widget.getByRole('menuitemradio', { name: 'Agent', exact: true });
			await expect(agent).toBeFocused();
			await expect(agent).toHaveAttribute('aria-checked', 'true');
			await expect(agent.locator('.ash-icon-label-icon [data-ash-icon-id="unlimited"]')).toBeVisible();
			await expect(agent.locator('.ash-menu-leading-check > [data-ash-icon-id="check"]')).toBeVisible();
			await agent.press('ArrowDown');
			await expect(widget.getByRole('menuitemradio', { name: 'Plan', exact: true })).toBeFocused();
			await page.keyboard.press('Escape');
			await expect(widget).toHaveCount(0);
			await expect(picker).toBeFocused();
		}
	});

	test('Chat input omits the unused find control and keeps the prompt evenly inset', async function () {
		const { page } = browserTests;

		await page.goto('/chatInput.html?inlineCode');
		const findOptions = page.locator('.stanza-editor-find-options-widget');
		await expect(findOptions).toHaveCount(0);
		const editorChrome = await page.locator('.ash-chat-input-editor').evaluate(editor => {
			const viewport = editor.querySelector<HTMLElement>('.stanza-editor');
			const placeholder = editor.querySelector<HTMLElement>('.stanza-editor-placeholder-text');
			const ruler = editor.querySelector<HTMLElement>('.decorationsOverviewRuler');
			const container = editor.closest<HTMLElement>('.ash-chat-input-container');
			const attachments = container?.querySelector<HTMLElement>('.ash-chat-input-attachments');
			if (!viewport || !placeholder || !ruler || !container) throw new Error(`Chat editor viewport is incomplete: ${JSON.stringify({ viewport: !!viewport, placeholder: !!placeholder, ruler: !!ruler, container: !!container })}`);
			const placeholderBounds = placeholder.getBoundingClientRect();
			const containerBounds = container.getBoundingClientRect();
			return {
				textInset: placeholderBounds.left - viewport.getBoundingClientRect().left,
				textTopInset: placeholderBounds.top - containerBounds.top,
				textLeftInset: placeholderBounds.left - containerBounds.left,
				editorTopInset: viewport.getBoundingClientRect().top - containerBounds.top,
				textInsetWithinEditor: placeholderBounds.top - viewport.getBoundingClientRect().top,
				attachmentsDisplay: attachments ? getComputedStyle(attachments).display : 'none',
				rulerDisplay: getComputedStyle(ruler).display,
				viewportBackground: getComputedStyle(viewport).backgroundColor,
				editorBackground: getComputedStyle(viewport).getPropertyValue('--ash-editor-background').trim(),
				inputBackground: getComputedStyle(viewport).getPropertyValue('--ash-input-background').trim(),
			};
		});
		expect(editorChrome.textInset).toBe(0);
		expect(editorChrome.textTopInset).toBe(9);
		expect(editorChrome.textLeftInset).toBe(9);
		expect(editorChrome.editorTopInset).toBe(9);
		expect(editorChrome.textInsetWithinEditor).toBe(0);
		expect(editorChrome.attachmentsDisplay).toBe('none');
		expect(editorChrome.rulerDisplay).toBe('none');
		expect(editorChrome.viewportBackground).toBe('rgba(0, 0, 0, 0)');
		expect(editorChrome.editorBackground).toBe(editorChrome.inputBackground);
	});

	test('Agent mode picker compacts when the model needs room', async function () {
		const { page } = browserTests;

		await page.goto('/chatInput.html?inlineCode');
		await page.evaluate(() => window.ashChatInputIntegration.showModels());
		const composer = page.locator('.ash-chat-input-container');
		const picker = composer.locator('[data-action-id="ash.chat.input.mode"] button');
		const label = picker.locator('.ash-icon-label-container');
		try {
			await composer.evaluate(element => { element.style.width = '380px'; });
			await expect(label).toBeVisible();
			await composer.evaluate(element => { element.style.width = '320px'; });
			await expect(label).toBeVisible();
			await composer.evaluate(element => { element.style.width = '180px'; });
			await expect(label).toBeHidden();
			await expect(picker.locator('.ash-icon-label-icon')).toBeVisible();
			await expect(picker.locator('.ash-chat-session-picker-indicator')).toBeVisible();
			await expect(picker).toHaveAttribute('aria-label', /^Mode: /);
			const triggerBounds = await picker.evaluate(button => {
				const icon = button.querySelector<HTMLElement>('.ash-icon-label-icon');
				const indicator = button.querySelector<HTMLElement>('.ash-chat-session-picker-indicator');
				if (!icon || !indicator) throw new Error('Agent mode trigger is incomplete');
				const buttonBounds = button.getBoundingClientRect();
				return {
					iconInside: icon.getBoundingClientRect().left >= buttonBounds.left,
					indicatorInside: indicator.getBoundingClientRect().right <= buttonBounds.right,
				};
			});
			expect(triggerBounds).toEqual({ iconInside: true, indicatorInside: true });
			await picker.press('ArrowDown');
			const menu = page.locator('.ash-chat-input-mode-menu');
			await expect(menu).toBeVisible();
			await menu.press('Escape');
			await expect(picker).toBeFocused();
			await composer.evaluate(element => { element.style.width = '380px'; });
			await expect(label).toBeVisible();
		} finally {
			await composer.evaluate(element => { element.style.removeProperty('width'); });
		}
	});

	test('Model picker uses free toolbar space before truncating its label', async function () {
		const { page } = browserTests;

		await page.goto('/chatInput.html?inlineCode');
		await page.evaluate(() => window.ashChatInputIntegration.showModels());
		const composer = page.locator('.ash-chat-input-container');
		const modelLabel = composer.locator('.ash-chat-input-model-action .ash-chat-input-picker-label');
		// The disconnected catalog only exposes a short label; exercise the toolbar with a longer model name.
		await modelLabel.evaluate(element => { element.textContent = 'GPT-5.6 Sol Extended Context Preview'; });
		const overflow = async (): Promise<number> => modelLabel.evaluate(element => element.scrollWidth - element.clientWidth);
		try {
			await composer.evaluate(element => { element.style.width = '520px'; });
			await expect.poll(overflow).toBeLessThanOrEqual(1);
			await composer.evaluate(element => { element.style.width = '280px'; });
			await expect.poll(overflow).toBeGreaterThan(1);
			const narrowLayout = await composer.evaluate(element => {
				const toolbar = element.querySelector<HTMLElement>('.ash-chat-input-toolbars');
				const model = element.querySelector<HTMLElement>('.ash-chat-input-model-selector');
				const mic = element.querySelector<HTMLElement>('.ash-chat-input-mic');
				const send = element.querySelector<HTMLElement>('.ash-chat-input-send, .ash-chat-input-voice');
				if (!toolbar || !model || !mic || !send) throw new Error('Chat toolbar is incomplete');
				return {
					modelBeforeMic: model.getBoundingClientRect().right <= mic.getBoundingClientRect().left,
					sendInsideToolbar: send.getBoundingClientRect().right <= toolbar.getBoundingClientRect().right + 1,
				};
			});
			expect(narrowLayout).toEqual({ modelBeforeMic: true, sendInsideToolbar: true });
			await composer.evaluate(element => { element.style.width = '520px'; });
			await expect.poll(overflow).toBeLessThanOrEqual(1);
		} finally {
			await composer.evaluate(element => { element.style.removeProperty('width'); });
		}
	});

	test('Chat input places the microphone beside voice or send at the right edge', async function () {
		const { page } = browserTests;

		await page.goto('/chatInput.html?inlineCode');
		await page.evaluate(() => window.ashChatInputIntegration.showModels());
		const chat = page.locator('main');
		const toolbar = chat.locator('.ash-chat-input-toolbars');
		const rightActionLayout = async (actionId: string) => toolbar.evaluate((element, id) => {
			const mic = element.querySelector<HTMLElement>('[data-action-id="workbench.action.chat.toggleSpeechToText"]');
			const action = element.querySelector<HTMLElement>(`[data-action-id="${id}"]`);
			if (!mic || !action) throw new Error('Chat input actions are incomplete');
			const micBounds = mic.getBoundingClientRect();
			const actionBounds = action.getBoundingClientRect();
			return {
				micLeft: micBounds.left,
				toolbarMiddle: element.getBoundingClientRect().left + element.getBoundingClientRect().width / 2,
				gap: actionBounds.left - micBounds.right,
				rightInset: element.getBoundingClientRect().right - actionBounds.right,
			};
		}, actionId);
		await expect(toolbar.locator('[data-action-id="ash.chat.input.attachment"]')).toHaveCount(0);
		await expect(toolbar.locator('[data-action-id="workbench.action.chat.toggleSpeechToText"] button')).toHaveCount(1);
		const voiceButton = toolbar.locator('[data-action-id="ash.chat.input.voice"] button');
		await expect(voiceButton).toBeVisible();
		const emptyLayout = await rightActionLayout('ash.chat.input.voice');
		expect(emptyLayout.micLeft).toBeGreaterThan(emptyLayout.toolbarMiddle);
		expect(emptyLayout.gap).toBeGreaterThanOrEqual(0);
		expect(emptyLayout.gap).toBeLessThanOrEqual(16);
		expect(emptyLayout.rightInset).toBeLessThanOrEqual(2);
		await expect(voiceButton.locator('[data-ash-icon-id="voice-mode"]')).toHaveCount(1);
		const shape = await voiceButton.evaluate(button => {
			const bounds = button.getBoundingClientRect();
			return { width: bounds.width, height: bounds.height, radius: getComputedStyle(button).borderRadius, background: getComputedStyle(button).backgroundColor };
		});
		expect(shape.width).toBe(shape.height);
		expect(shape.radius).toBe('50%');
		expect(shape.background).not.toBe('rgba(0, 0, 0, 0)');
		const input = chat.locator('.ash-chat-input-editor .stanza-editor-input');
		await input.focus();
		await page.keyboard.insertText('Hello');
		await expect(toolbar.locator('[data-action-id="ash.chat.input.voice"]')).toHaveCount(0);
		const sendButton = toolbar.locator('[data-action-id="ash.chat.input.send"] button');
		await expect(sendButton.locator('[data-ash-icon-id="arrow-up"]')).toHaveCount(1);
		await expect(sendButton).toHaveCSS('border-radius', '50%');
		const messageLayout = await rightActionLayout('ash.chat.input.send');
		expect(messageLayout.micLeft).toBeGreaterThan(messageLayout.toolbarMiddle);
		expect(messageLayout.gap).toBeGreaterThanOrEqual(0);
		expect(messageLayout.gap).toBeLessThanOrEqual(16);
		expect(messageLayout.rightInset).toBeLessThanOrEqual(2);
		await input.press('Home');
		await input.press('Shift+End');
		await page.keyboard.press('Backspace');
		await expect(toolbar.locator('[data-action-id="ash.chat.input.voice"] button')).toBeVisible();
		await page.keyboard.insertText('/config');
		await expect(toolbar.locator('[data-action-id="workbench.action.chat.toggleSpeechToText"]')).toHaveCount(0);
		const commandRightInset = await toolbar.evaluate(element => {
			const send = element.querySelector<HTMLElement>('[data-action-id="ash.chat.input.send"]');
			if (!send) throw new Error('Chat send action is missing');
			return element.getBoundingClientRect().right - send.getBoundingClientRect().right;
		});
		expect(commandRightInset).toBeLessThanOrEqual(2);
	});
});
