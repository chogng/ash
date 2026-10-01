import { h as createDomElement } from '../../../../../base/browser/dom.js';
import { registerTestDictationServices } from '../../../../test/common/testDictationServices.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ChatSpeechToTextService, ChatSpeechToTextState, IChatSpeechToTextService } from '../../browser/speechToText/chatSpeechToTextService.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ChatInputEditors } from '../../browser/widget/input/chatInputEditorRegistry.js';
import assert from 'node:assert/strict';
import { test, suiteTeardown } from 'mocha';
import { JSDOM } from 'jsdom';
import type { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import type { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import type { IAccessibleViewService } from '../../../../../platform/accessibility/browser/accessibleView.js';
import { IDictationService } from '../../../../../platform/dictation/common/dictationService.js';
import { Event as AshEvent, Emitter } from '../../../../../base/common/event.js';
import { LocalTranscriptionModelState, type ILocalTranscriptionModelSnapshot } from '../../../../../platform/localTranscription/common/localTranscription.js';
import { NotificationSeverity } from '../../../../../platform/notification/common/notification.js';
import { NotificationService } from '../../../../services/notification/common/notificationService.js';
import { ChatInputPart } from '../../browser/widget/input/chatInputPart.js';
import { setARIAContainer } from '../../../../../base/browser/ui/aria/aria.js';
import type { ChatInputDelegate, ChatInputState } from '../../browser/widget/input/chatInput.js';

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
suiteTeardown(() => inputResources.dispose());
const sharedNotifications = new NotificationService();
setARIAContainer(document.body);
suiteTeardown(() => sharedNotifications.dispose());

function inputPart(notifications: NotificationService, dictation?: Pick<IDictationService, 'start'> & Partial<IDictationService>, mode: ChatInputState['mode'] = 'agent', delegate: Partial<ChatInputDelegate> = {}, sharedServices?: InstantiationService): ChatInputPart {
	const container = createDomElement(document, 'div');
	document.body.append(container);
	let state: ChatInputState = { mode, queuedMessages: 0, phase: 'loading', canInterrupt: false, models: [], isAutomaticModel: false, slashCommands: [], skillSelectors: [], canSelectAgent: false };
	const service: IDictationService | undefined = dictation ? { onDidChangePreparation: AshEvent.None, getOptions: async () => ({ inputDevices: [], languages: [] }), getPreparation: async () => undefined, prepareModel: async () => {}, cancelPreparation: async () => {}, ...dictation } : undefined;
	const services = sharedServices ?? inputResources.add(new InstantiationService());
	if (!sharedServices) {
		registerTestDictationServices(services, service);
	}
	const part = services.createInstance(ChatInputPart,container, { ...delegate, selectMode: selected => { state = { ...state, mode: selected }; part.render(state); } } as ChatInputDelegate, {} as IContextMenuService, { container: document.body } as IContextViewService, { getOpenAriaHint: () => undefined } as unknown as IAccessibleViewService, notifications, ChatInputEditors, []);
	part.render(state);
	return part;
}

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
	part.render({ mode: 'debug', queuedMessages: 0, phase: 'ready', canInterrupt: false, models: [], isAutomaticModel: true, slashCommands: [], skillSelectors: [], canSelectAgent: false });
	part.addContext({ id: 'file', kind: 'file', name: 'file.ts', resolve: async () => ({ name: 'file.ts', content: 'let value = 1;' }) });
	assert.equal(part.element.querySelector<HTMLButtonElement>('[data-action-id="ash.chat.input.send"] button')?.disabled, false);
	const pending = part.acceptInput();
	await part.acceptInput();
	edit(part, 'Next draft');
	complete();
	await pending;
	assert.deepEqual(sent, ['']);
	assert.equal(part.element.querySelector('textarea')?.value, 'Next draft');
	assert.equal(part.element.querySelector('.ash-chat-input-attachments')?.textContent, '');
});

test('Chat input keeps failed attachments and restores text for retry', async () => {
	using part = inputPart(sharedNotifications, undefined, 'agent', { send: async () => { throw new Error('Request failed'); } });
	part.render({ mode: 'agent', queuedMessages: 0, phase: 'ready', canInterrupt: false, models: [], isAutomaticModel: true, slashCommands: [], skillSelectors: [], canSelectAgent: false });
	part.addContext({ id: 'image', kind: 'image', name: 'image.png', resolve: async () => ({ name: 'image.png', content: 'data:image/png;base64,aGVsbG8=', kind: 'image' }) });
	await assert.rejects(part.acceptInput('Review image'), /Request failed/u);
	const captured = await part.captureDraft();
	assert.equal(captured?.draft.text, 'Review image');
	assert.equal(captured?.draft.contexts[0]?.kind, 'image');
});

function edit(part: ChatInputPart, text: string): void {
	const input = part.element.querySelector('textarea');
	assert.ok(input);
	input.value = text;
	input.dispatchEvent(new Event('input', { bubbles: true }));
}

test('Chat configuration requests append without sending or replacing draft attachments', async () => {
	let sends = 0;
	using part = inputPart(sharedNotifications, undefined, 'debug', { send: async () => { sends++; } });
	edit(part, 'Existing draft');
	part.addContext({ id: 'file', kind: 'file', name: 'file.ts', resolve: async () => ({ name: 'file.ts', content: 'const answer = 42;' }) });
	const oldCapture = await part.captureDraft();
	part.appendToDraft('Configure Hooks');
	oldCapture?.clear();
	assert.deepEqual((await part.captureDraft())?.draft, {
		mode: 'debug', text: 'Existing draft\n\nConfigure Hooks', contexts: [{ id: 'file', kind: 'file', name: 'file.ts', content: 'const answer = 42;' }],
	});
	assert.equal(sends, 0);
});

test('Chat draft handoff moves text and resolved attachments after acknowledgement', async () => {
	using source = inputPart(sharedNotifications, undefined, 'debug');
	using target = inputPart(sharedNotifications);
	edit(source, 'Review this file');
	source.addContext({ id: 'src/file.ts', kind: 'file', name: 'file.ts', resolve: async () => ({ name: 'file.ts', content: 'const answer = 42;' }) });
	const captured = await source.captureDraft();
	assert.ok(captured);
	assert.deepEqual(captured.draft, {
		mode: 'debug',
		text: 'Review this file',
		contexts: [{ id: 'src/file.ts', kind: 'file', name: 'file.ts', content: 'const answer = 42;' }],
	});
	target.restoreDraft(captured.draft);
	assert.equal(target.element.querySelector('textarea')?.value, 'Review this file');
	assert.equal(target.element.querySelector('[data-action-id="ash.chat.input.mode"] button')?.textContent, 'Debug');
	assert.match(target.element.querySelector('.ash-chat-input-attachments')?.textContent ?? '', /file\.ts/u);
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

test('Chat dictation startup failure appears in notifications and leaves input status clear', async () => {
	using notifications = new NotificationService();
	using part = inputPart(notifications, { start: async () => { throw new Error('HTTP 403'); } });
	part.element.querySelector<HTMLButtonElement>('[data-action-id="ash.chat.input.mic"] button')?.click();
	await new Promise(resolve => setTimeout(resolve, 0));
	assert.deepEqual(notifications.getNotifications().map(item => ({ severity: item.severity, message: item.message })), [
		{ severity: NotificationSeverity.Error, message: 'Dictation failed: Error: HTTP 403' },
	]);
	assert.equal(part.element.querySelector('.ash-chat-status')?.textContent, 'Loading chat...');
});

test('Chat shows shared preparation, keeps text input usable and opens Dictation settings', async () => {
	using changed = new Emitter<void>();
	let snapshot: ILocalTranscriptionModelSnapshot | undefined = { model: 'selected', available: false, sizeBytes: 0 };
	let starts = 0;
	let prepared = 0;
	let cancelled = 0;
	const categories: unknown[] = [];
	const sent: string[] = [];
	using part = inputPart(sharedNotifications, {
		onDidChangePreparation: changed.event,
		getPreparation: async () => snapshot,
		prepareModel: async () => { prepared++; snapshot = { model: 'selected', available: false, sizeBytes: 0, status: { state: LocalTranscriptionModelState.Downloading, file: 'encoder.onnx', downloadedBytes: 2097152 } }; changed.fire(); },
		cancelPreparation: async () => { cancelled++; snapshot = { model: 'selected', available: false, sizeBytes: 0, status: { state: LocalTranscriptionModelState.Cancelled } }; changed.fire(); },
		start: async () => { starts++; return { stop: async () => {} }; },
	}, 'agent', { openModelSettings: async category => { categories.push(category); }, send: async text => { sent.push(text); } });
	part.render({ mode: 'agent', queuedMessages: 0, phase: 'ready', canInterrupt: false, models: [], isAutomaticModel: true, slashCommands: [], skillSelectors: [], canSelectAgent: false });
	await new Promise(resolve => setTimeout(resolve, 0));
	const bar = part.element.querySelector<HTMLElement>('.ash-chat-model-preparation')!;
	assert.equal(bar.hidden, false);
	part.element.querySelector<HTMLButtonElement>('[data-action-id="ash.chat.input.mic"] button')!.click();
	await new Promise(resolve => setTimeout(resolve, 0));
	assert.equal(starts, 0);
	[...bar.querySelectorAll('button')].find(button => button.textContent === 'Dictation settings')!.click();
	assert.deepEqual(categories, ['dictation']);
	[...bar.querySelectorAll('button')].find(button => button.textContent === 'Download model')!.click();
	await new Promise(resolve => setTimeout(resolve, 0));
	assert.equal(prepared, 1);
	assert.match(bar.textContent ?? '', /Downloading encoder.onnx: 2.0 MiB/);
	assert.equal(bar.querySelector('progress')!.hasAttribute('value'), false);
	assert.equal([...bar.querySelectorAll('button')].find(button => button.textContent === 'Download model')!.classList.contains('hidden'), true);
	assert.equal([...bar.querySelectorAll('button')].find(button => button.textContent === 'Cancel')!.classList.contains('hidden'), false);
	await part.acceptInput('Text still works');
	assert.deepEqual(sent, ['Text still works']);
	part.setVisible(false);
	assert.equal(cancelled, 0);
	part.setVisible(true);
	await new Promise(resolve => setTimeout(resolve, 0));
	[...bar.querySelectorAll('button')].find(button => button.textContent === 'Cancel')!.click();
	await new Promise(resolve => setTimeout(resolve, 0));
	assert.equal(cancelled, 1);
	snapshot = undefined;
	changed.fire();
	await new Promise(resolve => setTimeout(resolve, 0));
	assert.equal(bar.hidden, true);
});

test('Chat dictation session failure appears in notifications and releases the microphone', async () => {
	using notifications = new NotificationService();
	let endSession: ((error?: string) => void) | undefined;
	using part = inputPart(notifications, { start: async (_onTranscript, onEnded) => {
		endSession = onEnded;
		return { stop: async () => {} };
	} });
	const microphone = part.element.querySelector<HTMLButtonElement>('[data-action-id="ash.chat.input.mic"] button');
	assert.ok(microphone);
	microphone.click();
	await new Promise(resolve => setTimeout(resolve, 0));
	assert.equal(part.element.querySelector<HTMLButtonElement>('[data-action-id="ash.chat.input.mic"] button')?.getAttribute('aria-pressed'), 'true');
	endSession?.('HTTP 403');
	assert.deepEqual(notifications.getNotifications().map(item => ({ severity: item.severity, message: item.message })), [
		{ severity: NotificationSeverity.Error, message: 'Dictation failed: HTTP 403' },
	]);
	assert.equal(part.element.querySelector('.ash-chat-status')?.textContent, 'Loading chat...');
	assert.notEqual(part.element.querySelector<HTMLButtonElement>('[data-action-id="ash.chat.input.mic"] button')?.getAttribute('aria-pressed'), 'true');
});

test('Dictation replaces the selection and submission waits for final transcription', async () => {
	let transcript!: (text: string, final: boolean) => void;
	let finishStop!: () => void;
	const sent: string[] = [];
	using part = inputPart(sharedNotifications, {
		start: async (onTranscript, onEnded) => {
			transcript = onTranscript;
			return { stop: async () => { await new Promise<void>(resolve => { finishStop = resolve; }); transcript('replacement', true); onEnded(); } };
		},
	}, 'agent', { send: async text => { sent.push(text); } });
	part.render({ mode: 'agent', queuedMessages: 0, phase: 'ready', canInterrupt: false, models: [], isAutomaticModel: true, slashCommands: [], skillSelectors: [], canSelectAgent: false });
	edit(part, 'before old after');
	const input = part.element.querySelector('textarea')!;
	input.setSelectionRange(7, 10);
	part.element.querySelector<HTMLButtonElement>('[data-action-id="ash.chat.input.mic"] button')!.click();
	await new Promise(resolve => setTimeout(resolve, 0));
	transcript('partial', false);
	assert.equal(input.value, 'before old after');
	assert.equal(part.element.querySelector('.ash-chat-dictation-preview')?.textContent, 'partial');
	const submit = part.acceptInput();
	await Promise.resolve();
	assert.deepEqual(sent, []);
	finishStop();
	await submit;
	assert.deepEqual(sent, ['before replacement after']);
});

test('Closing an input during microphone acquisition closes the resulting session', async () => {
	let completeStart!: (session: { stop(): Promise<void> }) => void;
	let stopped = 0;
	const part = inputPart(sharedNotifications, { start: () => new Promise(resolve => { completeStart = resolve; }) });
	part.element.querySelector<HTMLButtonElement>('[data-action-id="ash.chat.input.mic"] button')!.click();
	await Promise.resolve();
	assert.equal(part.element.querySelector<HTMLButtonElement>('[data-action-id="ash.chat.input.mic"] button')!.disabled, true);
	part.dispose();
	completeStart({ stop: async () => { stopped++; } });
	await new Promise(resolve => setTimeout(resolve, 0));
	assert.equal(stopped, 1);
});


test('Shared dictation only changes its owning input and returns the complete transcript', async () => {
	using services = new InstantiationService();
	let transcript!: (text: string, final: boolean) => void;
	let ended!: (error?: string) => void;
	let stops = 0;
	const backend: IDictationService = {
		onDidChangePreparation: AshEvent.None, getOptions: async () => ({ inputDevices: [], languages: [] }),
		getPreparation: async () => undefined,
		prepareModel: async () => {},
		cancelPreparation: async () => {},
		start: async (onTranscript, onEnded) => {
			transcript = onTranscript;
			ended = onEnded;
			return { stop: async () => { stops++; transcript('second', true); ended(); } };
		},
	};
	registerTestDictationServices(services, backend);
	const speech = services.get(IChatSpeechToTextService);
	using firstNotifications = new NotificationService();
	using secondNotifications = new NotificationService();
	using first = inputPart(firstNotifications, undefined, 'agent', {}, services);
	using second = inputPart(secondNotifications, undefined, 'agent', {}, services);
	const started = waitForSpeechState(speech, ChatSpeechToTextState.Recording);
	first.element.querySelector<HTMLButtonElement>('[data-action-id="ash.chat.input.mic"] button')!.click();
	await started;
	transcript('first', true);
	assert.deepEqual([first.element.querySelector('textarea')!.value, second.element.querySelector('textarea')!.value], ['first', '']);
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
	const backend: IDictationService = {
		onDidChangePreparation: AshEvent.None, getOptions: async () => ({ inputDevices: [], languages: [] }),
		getPreparation: async () => undefined,
		prepareModel: async () => {},
		cancelPreparation: async () => {},
		start: async onTranscript => {
			transcript = onTranscript;
			return { stop: () => new Promise<void>(resolve => { finishStop = () => { transcript('discarded', true); resolve(); }; stopRequested(); }) };
		},
	};
	registerTestDictationServices(services, backend);
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
	transcript('new input', true);
	assert.deepEqual([first.element.querySelector('textarea')!.value, second.element.querySelector('textarea')!.value], ['', 'new input']);
	stopReady = new Promise<void>(resolve => { stopRequested = resolve; });
	const stopped = speech.stopAndTranscribe();
	await stopReady;
	finishStop();
	await stopped;
});

test('A failed shared session notifies its owning input only', async () => {
	using services = new InstantiationService();
	let ended!: (error?: string) => void;
	registerTestDictationServices(services, {
		onDidChangePreparation: AshEvent.None, getOptions: async () => ({ inputDevices: [], languages: [] }),
		getPreparation: async () => undefined,
		prepareModel: async () => {},
		cancelPreparation: async () => {},
		start: async (_onTranscript: (text: string, final: boolean) => void, onEnded: (error?: string) => void) => { ended = onEnded; return { stop: async () => {} }; },
	});
	const speech = services.get(IChatSpeechToTextService);
	using firstNotifications = new NotificationService();
	using secondNotifications = new NotificationService();
	using first = inputPart(firstNotifications, undefined, 'agent', {}, services);
	using second = inputPart(secondNotifications, undefined, 'agent', {}, services);
	const started = waitForSpeechState(speech, ChatSpeechToTextState.Recording);
	first.element.querySelector<HTMLButtonElement>('[data-action-id="ash.chat.input.mic"] button')!.click();
	await started;
	ended('capture lost');
	assert.deepEqual([firstNotifications.getNotifications().map(item => item.message), secondNotifications.getNotifications().map(item => item.message)], [['Dictation failed: capture lost'], []]);
	assert.equal(speech.state, ChatSpeechToTextState.Idle);
});

function waitForSpeechState(service: IChatSpeechToTextService, state: ChatSpeechToTextState): Promise<void> {
	return new Promise(resolve => {
		const subscription = service.onDidChangeState(next => {
			if (next === state) {
				subscription.dispose();
				resolve();
			}
		});
	});
}

test('Input construction rejects a missing window dictation service', () => {
	using services = new InstantiationService();
	assert.throws(() => services.createInstance(ChatInputPart, document.body, {} as ChatInputDelegate, {} as IContextMenuService, {} as IContextViewService, {} as IAccessibleViewService, sharedNotifications, ChatInputEditors, []), /Unknown service: chatSpeechToTextService/);
	services.registerInstance(IDictationService, undefined);
	services.registerSingleton(IChatSpeechToTextService, () => services.createInstance(ChatSpeechToTextService));
	assert.throws(() => services.createInstance(ChatInputPart, document.body, {} as ChatInputDelegate, {} as IContextMenuService, {} as IContextViewService, {} as IAccessibleViewService, sharedNotifications, ChatInputEditors, []), /Unknown service: dictationOnboardingService/);
});
