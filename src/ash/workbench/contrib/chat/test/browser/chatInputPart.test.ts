import '../../browser/chat.shared.contribution.js';
import { IChatSpeechToTextService, ChatSpeechToTextService } from '../../browser/speechToText/chatSpeechToTextService.js';
import { TestQuickInputService } from '../../../../../platform/quickinput/test/browser/testQuickInputService.js';
import { isCancellationError } from '../../../../../base/common/errors.js';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { installEditorTestGlobals } from '../../../../../editor/test/browser/editorTestGlobals.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
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
import { test, suiteTeardown } from 'mocha';
import { JSDOM } from 'jsdom';
import type { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { BrowserContextViewService } from '../../../../../platform/contextview/browser/contextViewService.js';
import { ActionWidgetService, IActionWidgetService } from '../../../../../platform/actionWidget/browser/actionWidget.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { InMemoryConfigurationService } from '../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import { ILanguageModelsService } from '../../common/languageModels.js';
import { IAccessibleViewService } from '../../../../../platform/accessibility/browser/accessibleView.js';
import { IVoiceCodeTranscriptionBackendService } from '../../../../../platform/renderer/common/dictation.js';
import { Event as AshEvent, Emitter } from '../../../../../base/common/event.js';
import { ILocalTranscriptionService, LocalTranscriptionModelState, type ILocalTranscriptionModelSnapshot } from '../../../../../platform/localTranscription/common/localTranscription.js';
import { NotificationSeverity } from '../../../../../platform/notification/common/notification.js';
import { NotificationService } from '../../../../services/notification/common/notificationService.js';
import { URI } from '../../../../../base/common/uri.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IChatSessionNavigationService } from '../../../../services/chat/common/chatSessionNavigationService.js';
import { ChatInputPart } from '../../browser/widget/input/chatInputPart.js';
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
const sharedNotifications = new NotificationService();
setARIAContainer(document.body);
suiteTeardown(() => sharedNotifications.dispose());

class ObservableInputPart extends ChatInputPart {
	readonly onDidChangeInputForTest = this.onDidChangeInput;
}

function inputPart(notifications: NotificationService, dictation?: TestDictationCapture, mode: ChatInputState['mode'] = 'agent', delegate: Partial<ChatInputDelegate> = {}, sharedServices?: InstantiationService, localTranscription?: ILocalTranscriptionService, telemetry?: ITelemetryService): ObservableInputPart {
	const container = document.createElement('div');
	document.body.append(container);
	let state: ChatInputState = { mode, queuedMessages: 0, approvalMode: 'manual', phase: 'loading', canInterrupt: false, models: [], isAutomaticModel: false, slashCommands: [], skillSelectors: [], canSelectAgent: false };
	const service = dictation ? createTestDictationBackend(inputResources, dictation) : undefined;
	const services = sharedServices ?? inputResources.add(new InstantiationService());
	if (!sharedServices) {
		services.registerInstance(INotificationService, notifications);
		if (telemetry) services.registerInstance(ITelemetryService, telemetry);
		services.registerSingleton(IConfigurationService, () => new TestConfigurationService({ source: dictation ? '{"dictation.backend":"cloud"}' : '{}' }));
		if (localTranscription) services.registerInstance(ILocalTranscriptionService, localTranscription);
		services.registerInstance(IVoiceCodeTranscriptionBackendService, service);
		services.registerSingleton(ISpeechService, () => services.createInstance(SpeechService));
		services.registerSingleton(IChatSpeechToTextService, () => services.createInstance(ChatSpeechToTextService));
		registerTestDictationOnboarding(services);
	}
	const partServices = inputResources.add(services.createChild());
	if (!partServices.has(IEditorService)) partServices.registerInstance(IEditorService, { ...emptyEditorServiceState, openEditor: async () => { }, focusActiveEditor() { } });
	if (!partServices.has(IMessageHistoryService)) partServices.registerInstance(IMessageHistoryService, undefined);
	if (!partServices.has(IQuickInputService)) partServices.registerSingleton(IQuickInputService, () => new TestQuickInputService({ container: document.body }));
	partServices.registerInstance(IOpenerService, { open: async () => true } as unknown as IOpenerService);
	partServices.registerInstance(ICommandService, { executeCommand: async () => undefined } as unknown as ICommandService);
	partServices.registerInstance(IContextKeyService, inputResources.add(new ContextKeyService()));
	partServices.registerSingleton(IMenuService, () => partServices.createInstance(MenuService));
	partServices.registerInstance(INotificationService, notifications);
	partServices.registerInstance(IChatSessionNavigationService, { openConversation: async () => { } } as unknown as IChatSessionNavigationService);
	const contextView = inputResources.add(new BrowserContextViewService(document.body));
	partServices.registerInstance(IContextViewService, contextView);
	if (!partServices.has(IConfigurationService)) partServices.registerInstance(IConfigurationService, inputResources.add(new InMemoryConfigurationService()));
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
	const part = partServices.createInstance(ObservableInputPart, container, { ...delegate, selectMode: selected => { state = { ...state, mode: selected }; part.render(state); } } as ChatInputDelegate, {} as IContextMenuService, { container: document.body } as IContextViewService, { getOpenAriaHint: () => undefined } as unknown as IAccessibleViewService, notifications, ChatInputEditors, [], { modePicker: 'visible', modelPickerPosition: 'leading' });
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
	using notifications = new NotificationService();
	using part = inputPart(notifications, { start: async () => { throw new Error('HTTP 403'); } });
	const failure = new DeferredPromise<void>();
	using notification = notifications.onDidAdd(() => { void failure.complete(); });
	part.element.querySelector<HTMLButtonElement>('[data-action-id="ash.chat.input.mic"] button')?.click();
	await failure.p;
	assert.deepEqual(notifications.getNotifications().map(item => ({ severity: item.severity, message: item.message })), [
		{ severity: NotificationSeverity.Error, message: 'Dictation failed: Error: HTTP 403' },
	]);
	assert.equal(part.element.querySelector('.ash-chat-status-summary')?.textContent, 'Loading chat…');
	assert.equal(part.element.querySelector<HTMLButtonElement>('[data-action-id="ash.chat.input.mic"] button')?.disabled, false);
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
		onDidTranscribe: AshEvent.None, onDidEnd: AshEvent.None,
		getModelStatus: async () => { reads++; return snapshot; },
		listModels: async () => [],
		prepareModel: () => { prepared++; throw new Error('Unexpected model preparation'); },
		importModel: () => { throw new Error('Unexpected model import'); },
		cancelModel: async () => { cancelled++; }, deleteModel: async () => { },
		pushAudio: async () => { }, start: async () => { starts++; }, stop: async () => '', cancel: async () => { },
		dispose() { }, [Symbol.dispose]() { },
	});
	part.render({ mode: 'agent', queuedMessages: 0, approvalMode: 'manual', phase: 'ready', canInterrupt: false, models: [], isAutomaticModel: true, slashCommands: [], skillSelectors: [], canSelectAgent: false });
	assert.equal(part.element.querySelector('.ash-chat-model-preparation'), null);
	assert.equal(reads, 0);
	edit(part, 'Text still works');
	part.element.querySelector<HTMLButtonElement>('[data-action-id="ash.chat.input.mic"] button')!.click();
	await opened;
	await Promise.resolve();
	assert.deepEqual(categories, ['dictation']);
	assert.equal(part.element.querySelector('textarea')!.value, 'Text still works');
	assert.deepEqual({ reads, starts, prepared, cancelled }, { reads: 1, starts: 0, prepared: 0, cancelled: 0 });

	snapshot = { model: 'selected', available: false, sizeBytes: 0, status: { state: LocalTranscriptionModelState.Downloading, file: 'encoder.onnx', downloadedBytes: 2097152 } };
	changed.fire();
	part.setVisible(false);
	part.setVisible(true);
	assert.equal(reads, 1);
	assert.equal(part.element.querySelector('.ash-chat-model-preparation'), null);
	opened = new Promise<void>(resolve => { settingsOpened = resolve; });
	part.element.querySelector<HTMLButtonElement>('[data-action-id="ash.chat.input.mic"] button')!.click();
	await opened;
	assert.deepEqual(categories, ['dictation', 'dictation']);
	assert.deepEqual({ reads, starts, prepared, cancelled }, { reads: 2, starts: 0, prepared: 0, cancelled: 0 });
	await part.acceptInput();
	assert.deepEqual(sent, ['Text still works']);
});

test('Chat dictation session failure appears in notifications and releases the microphone', async () => {
	using notifications = new NotificationService();
	let endSession: ((error?: string) => void) | undefined;
	using part = inputPart(notifications, {
		start: async (_options, _onTranscript, onEnded) => {
			endSession = onEnded;
			return { stop: async () => { }, cancel: async () => { } };
		}
	});
	const microphone = part.element.querySelector<HTMLButtonElement>('[data-action-id="ash.chat.input.mic"] button');
	assert.ok(microphone);
	microphone.click();
	await new Promise(resolve => setTimeout(resolve, 0));
	assert.equal(part.element.querySelector<HTMLButtonElement>('[data-action-id="ash.chat.input.mic"] button')?.getAttribute('aria-pressed'), 'true');
	const failed = new DeferredPromise<void>();
	using notificationAdded = notifications.onDidAdd(() => { void failed.complete(); });
	endSession?.('HTTP 403');
	await failed.p;
	assert.deepEqual(notifications.getNotifications().map(item => ({ severity: item.severity, message: item.message })), [
		{ severity: NotificationSeverity.Error, message: 'Dictation failed: Error: HTTP 403' },
	]);
	assert.equal(part.element.querySelector('.ash-chat-status-summary')?.textContent, 'Loading chat…');
	assert.notEqual(part.element.querySelector<HTMLButtonElement>('[data-action-id="ash.chat.input.mic"] button')?.getAttribute('aria-pressed'), 'true');
});

test('Dictation replaces the selection and submission waits for final transcription', async () => {
	let transcript!: (text: string, final: boolean) => void;
	let finishStop!: () => void;
	const stopRequested = new DeferredPromise<void>();
	const sent: string[] = [];
	using part = inputPart(sharedNotifications, {
		start: async (_options, onTranscript, onEnded) => {
			transcript = onTranscript;
			return { stop: async () => { await new Promise<void>(resolve => { finishStop = resolve; void stopRequested.complete(); }); transcript('replacement', true); onEnded(); }, cancel: async () => { } };
		},
	}, 'agent', { send: async text => { sent.push(text); } });
	part.render({ mode: 'agent', queuedMessages: 0, approvalMode: 'manual', phase: 'ready', canInterrupt: false, models: [], isAutomaticModel: true, slashCommands: [], skillSelectors: [], canSelectAgent: false });
	edit(part, 'before old after');
	const input = part.element.querySelector('textarea')!;
	input.setSelectionRange(7, 10);
	part.element.querySelector<HTMLButtonElement>('[data-action-id="ash.chat.input.mic"] button')!.click();
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

test('submitting an edited dictated draft records aggregate accuracy once without sending transcript text', async () => {
	const events: { name: string; data: unknown; }[] = [];
	class Telemetry extends NullTelemetryServiceShape {
		override publicLog(name: string, data: Parameters<ITelemetryService['publicLog']>[1]): void { events.push({ name, data }); }
	}
	using part = inputPart(sharedNotifications, {
		start: async (_options, onTranscript) => ({ stop: async () => onTranscript('cat', true), cancel: async () => { } }),
	}, 'agent', { send: async () => { } }, undefined, undefined, new Telemetry());
	part.render({ mode: 'agent', queuedMessages: 0, approvalMode: 'manual', phase: 'ready', canInterrupt: false, models: [], isAutomaticModel: true, slashCommands: [], skillSelectors: [], canSelectAgent: false });
	part.element.querySelector<HTMLButtonElement>('[data-action-id="ash.chat.input.mic"] button')!.click();
	await new Promise(resolve => setTimeout(resolve, 0));
	const inserted = new DeferredPromise<void>();
	using changed = part.onDidChangeInputForTest(() => { if (part.element.querySelector('textarea')!.value === 'cat') void inserted.complete(); });
	part.element.querySelector<HTMLButtonElement>('[data-action-id="ash.chat.input.mic"] button')!.click();
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
	part.element.querySelector<HTMLButtonElement>('[data-action-id="ash.chat.input.mic"] button')!.click();
	await acquiring.p;
	assert.equal(part.element.querySelector<HTMLButtonElement>('[data-action-id="ash.chat.input.mic"] button')!.disabled, true);
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
	using firstNotifications = new NotificationService();
	using secondNotifications = new NotificationService();
	using first = inputPart(firstNotifications, undefined, 'agent', {}, services);
	using second = inputPart(secondNotifications, undefined, 'agent', {}, services);
	const started = waitForSpeechState(speech, ChatSpeechToTextState.Recording);
	first.element.querySelector<HTMLButtonElement>('[data-action-id="ash.chat.input.mic"] button')!.click();
	await started;
	transcript('first', false);
	assert.equal(first.element.querySelector('.ash-chat-dictation-preview')!.textContent, 'first');
	assert.deepEqual([first.element.querySelector('textarea')!.value, second.element.querySelector('textarea')!.value], ['', '']);
	assert.equal(second.element.querySelector<HTMLButtonElement>('[data-action-id="ash.chat.input.mic"] button')!.disabled, true);
	second.setVisible(false);
	assert.equal(stops, 0);
	assert.equal(await speech.stopAndTranscribe(), 'first second');
	assert.deepEqual([first.element.querySelector('textarea')!.value, second.element.querySelector('textarea')!.value, stops], ['first second', '', 1]);
	assert.deepEqual([firstNotifications.getNotifications(), secondNotifications.getNotifications()], [[], []]);
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
	first.element.querySelector<HTMLButtonElement>('[data-action-id="ash.chat.input.mic"] button')!.click();
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
	second.element.querySelector<HTMLButtonElement>('[data-action-id="ash.chat.input.mic"] button')!.click();
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
	using windowNotifications = new NotificationService();
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
	using firstNotifications = new NotificationService();
	using secondNotifications = new NotificationService();
	using first = inputPart(firstNotifications, undefined, 'agent', {}, services);
	using second = inputPart(secondNotifications, undefined, 'agent', {}, services);
	const started = waitForSpeechState(speech, ChatSpeechToTextState.Recording);
	first.element.querySelector<HTMLButtonElement>('[data-action-id="ash.chat.input.mic"] button')!.click();
	await started;
	const notified = new DeferredPromise<void>();
	using notificationAdded = windowNotifications.onDidAdd(() => { void notified.complete(); });
	ended('capture lost');
	await notified.p;
	assert.deepEqual(windowNotifications.getNotifications().map(item => item.message), ['Dictation failed: Error: capture lost']);
	assert.deepEqual([firstNotifications.getNotifications(), secondNotifications.getNotifications()], [[], []]);
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

test('Failed file preparation blocks the waiting send and notifies once while preserving the draft', async () => {
	using globals = installEditorTestGlobals({ FileReader: browserEnvironment.window.FileReader });
	using notifications = new NotificationService();
	const messages: string[] = [];
	using listener = notifications.onDidAdd(message => messages.push(message.message));
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
	using notifications = new NotificationService();
	let errors = 0;
	using listener = notifications.onDidAdd(() => { errors++; });
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
	using notifications = new NotificationService();
	let sends = 0;
	const part = inputPart(notifications, undefined, 'agent', { send: async () => { sends++; } });
	part.render({ mode: 'agent', queuedMessages: 0, approvalMode: 'manual', phase: 'ready', canInterrupt: false, models: [], isAutomaticModel: true, slashCommands: [], skillSelectors: [], canSelectAgent: false });
	const attaching = part.attachFiles([new browserEnvironment.window.File(['file contents'], 'input.txt')]);
	const rejected = assert.rejects(part.acceptInput(), isCancellationError);
	part.dispose();
	await Promise.all([attaching, rejected]);
	assert.equal(sends, 0);
	assert.equal(part.element.isConnected, false);
	assert.deepEqual(notifications.getNotifications(), []);
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
