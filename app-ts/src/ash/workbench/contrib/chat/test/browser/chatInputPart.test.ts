import assert from 'node:assert/strict';
import { test, suiteTeardown } from 'mocha';
import { JSDOM } from 'jsdom';
import type { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import type { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import type { IAccessibleViewService } from '../../../../../platform/accessibility/browser/accessibleView.js';
import type { IDictationService } from '../../../../../platform/dictation/common/dictationService.js';
import { NotificationSeverity } from '../../../../../platform/notification/common/notification.js';
import { NotificationService } from '../../../../services/notification/common/notificationService.js';
import { ChatInputPart } from '../../browser/widget/input/chatInputPart.js';
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

const sharedNotifications = new NotificationService();
suiteTeardown(() => sharedNotifications.dispose());

function inputPart(notifications: NotificationService, dictation?: IDictationService, mode: ChatInputState['mode'] = 'agent', delegate: Partial<ChatInputDelegate> = {}): ChatInputPart {
	const container = document.createElement('div');
	document.body.append(container);
	let state: ChatInputState = { mode, queuedMessages: 0, phase: 'loading', canInterrupt: false, models: [], isAutomaticModel: false, slashCommands: [], skillSelectors: [], canSelectAgent: false };
	const part = new ChatInputPart(container, { ...delegate, selectMode: selected => { state = { ...state, mode: selected }; part.render(state); } } as ChatInputDelegate, {} as IContextMenuService, { container: document.body } as IContextViewService, { getOpenAriaHint: () => undefined } as unknown as IAccessibleViewService, notifications, dictation);
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
