import { browserEnvironment } from '../../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { InstantiationService } from '../../../../../../platform/instantiation/common/instantiationService.js';
import { CommandsRegistry } from '../../../../../../platform/commands/common/commands.js';
import { IChatWidgetService, type IChatWidget } from '../../../browser/chat.js';
import { registerChatQueueActions, ChatQueueMessageAction, ChatSteerWithMessageAction, ChatEditPendingRequestAction, ChatRemovePendingRequestAction, ChatSendPendingImmediatelyAction, ChatRemoveAllPendingRequestsAction } from '../../../browser/actions/chatQueueActions.js';
import { IChatService, type QueuedMessage } from '../../../../../services/chat/common/chatService.js';
import { IQuickInputService, type IQuickPick } from '../../../../../../platform/quickinput/common/quickInput.js';
import { TestQuickInputService } from '../../../../../../platform/quickinput/test/browser/testQuickInputService.js';
import { TestNotificationService } from '../../../../../services/notification/test/common/testNotificationService.js';
import { INotificationService } from '../../../../../../platform/notification/common/notification.js';
import { setARIAContainer } from '../../../../../../base/browser/ui/aria/aria.js';
import { Emitter } from '../../../../../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../../../../../base/common/lifecycle.js';
registerChatQueueActions();

test('queue commands carry an explicit intent to the focused composer without reading or clearing its draft', async () => {
	using services = new InstantiationService();
	const inputs: unknown[] = [];
	const widget = { visible: true, acceptInput: async (...args: unknown[]) => { inputs.push(args); } } as IChatWidget;
	services.registerInstance(IChatWidgetService, { lastFocusedWidget: widget } as unknown as IChatWidgetService);
	for (const id of [ChatQueueMessageAction.ID, ChatSteerWithMessageAction.ID]) {
		await services.invokeFunction(CommandsRegistry.getCommand(id)!);
	}
	assert.deepEqual(inputs, [[undefined, { queue: 'queued' }], [undefined, { queue: 'steering' }]]);
	Object.assign(widget, { visible: false });
	await services.invokeFunction(CommandsRegistry.getCommand(ChatQueueMessageAction.ID)!);
	assert.equal(inputs.length, 2);
});



function queueFixture() {
	const lifetime = new DisposableStore();
	// jsdom lacks native top-layer dialogs; product validation uses Electron's implementation.
	const prototype = browserEnvironment.window.HTMLDialogElement.prototype;
	for (const [name, value] of Object.entries({
		showModal(this: HTMLDialogElement) { this.setAttribute('open', ''); },
		close(this: HTMLDialogElement) { this.removeAttribute('open'); },
	})) {
		const previous = Object.getOwnPropertyDescriptor(prototype, name);
		Object.defineProperty(prototype, name, { configurable: true, writable: true, value });
		lifetime.add(toDisposable(() => { if (previous) Object.defineProperty(prototype, name, previous); else Reflect.deleteProperty(prototype, name); }));
	}
	const elementPrototype = browserEnvironment.window.HTMLElement.prototype;
	const previousScrollTo = Object.getOwnPropertyDescriptor(elementPrototype, 'scrollTo');
	Object.defineProperty(elementPrototype, 'scrollTo', {
		configurable: true, value(this: HTMLElement, options: ScrollToOptions) {
			this.scrollLeft = options.left ?? this.scrollLeft; this.scrollTop = options.top ?? this.scrollTop;
		}
	});
	lifetime.add(toDisposable(() => { if (previousScrollTo) Object.defineProperty(elementPrototype, 'scrollTo', previousScrollTo); else Reflect.deleteProperty(elementPrototype, 'scrollTo'); }));
	const document = browserEnvironment.window.document;
	const container = document.createElement('div'); document.body.append(container);
	lifetime.add(toDisposable(() => container.remove()));
	lifetime.add(setARIAContainer(container));
	const services = lifetime.add(new InstantiationService());
	const quickInput = lifetime.add(new TestQuickInputService({ container }));
	const changed = lifetime.add(new Emitter<void>());
	const hidden = lifetime.add(new Emitter<void>());
	const calls: unknown[] = [];
	const original: QueuedMessage = { sessionId: 'session', threadId: 'thread', commandId: 'queued', revision: 5, mode: 'agent', text: 'Original\nmessage', contextCount: 3, status: 'pending' };
	let message = original;
	let focus = 0;
	const widget = { sessionId: 'session', threadId: 'thread', visible: true, domNode: container, onDidHide: hidden.event, onDidChangeViewModel: changed.event, focusInput: () => { focus++; } } as unknown as IChatWidget;
	const chat = {
		getPendingRequests: async () => [message],
		pausePendingRequest: async (target: unknown) => { calls.push(['pause', target]); message = { ...message, status: 'paused', revision: 6 }; return message; },
		resumePendingRequest: async (target: unknown) => { calls.push(['resume', target]); message = { ...message, status: 'pending', revision: 7 }; return message; },
		editPendingRequest: async (target: unknown, text: string) => { calls.push(['edit', target, text]); message = { ...message, text, status: 'pending', revision: 7 }; return message; },
		removePendingRequest: async (target: unknown) => { calls.push(['remove', target]); return { ...message, status: 'cancelled' }; },
		sendPendingRequestImmediately: async (target: unknown) => { calls.push(['send', target]); },
	} as unknown as IChatService;
	services.registerInstance(IChatService, chat);
	services.registerInstance(IQuickInputService, quickInput);
	services.registerInstance(INotificationService, lifetime.add(new TestNotificationService()));
	services.registerInstance(IChatWidgetService, { lastFocusedWidget: widget, getAllWidgets: () => [widget] } as unknown as IChatWidgetService);
	const target = { sessionId: 'session', threadId: 'thread', commandId: 'queued', expectedRevision: 5 };
	return { services, quickInput, widget, changed, hidden, calls, chat, original, target, container, focus: () => focus, [Symbol.dispose]: () => lifetime.dispose() };
}

async function ready(condition: () => boolean): Promise<void> {
	for (let i = 0; i < 200 && !condition(); i++) await new Promise(resolve => setTimeout(resolve, 0));
	assert.ok(condition(), 'expected queue editor or picker to become ready');
}

test('Queue edit saves multiline text at the paused revision and never uses the unsent composer', async () => {
	using f = queueFixture();
	const operation = f.services.invokeFunction(CommandsRegistry.getCommand(ChatEditPendingRequestAction.ID)!, f.target) as Promise<void>;
	await ready(() => !!f.container.querySelector('textarea'));
	const input = f.container.querySelector('textarea')!;
	assert.equal(input.value, 'Original\nmessage');
	input.value = 'Edited\nmessage';
	input.dispatchEvent(new browserEnvironment.window.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
	await ready(() => f.calls.length === 2);
	await ready(() => !f.container.querySelector('dialog[open]'));
	await operation;
	assert.deepEqual(f.calls, [['pause', f.target], ['edit', { ...f.target, expectedRevision: 6 }, 'Edited\nmessage']]);
	assert.equal(f.original.text, 'Original\nmessage');
	assert.equal(f.focus(), 1);
});

test('Cancelling queue editing resumes the original position with the paused revision', async () => {
	using f = queueFixture();
	const operation = f.services.invokeFunction(CommandsRegistry.getCommand(ChatEditPendingRequestAction.ID)!, f.target) as Promise<void>;
	await ready(() => !!f.container.querySelector('textarea'));
	f.container.querySelector('textarea')!.value = 'Do not save';
	f.container.querySelector('textarea')!.dispatchEvent(new browserEnvironment.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
	await operation;
	assert.deepEqual(f.calls, [['pause', f.target], ['resume', { ...f.target, expectedRevision: 6 }]]);
	assert.equal(f.original.text, 'Original\nmessage');
});

test('Failed queue edits retain text and keep the paused version for retry', async () => {
	using f = queueFixture();
	const save = f.chat.editPendingRequest.bind(f.chat);
	f.chat.editPendingRequest = async () => { throw new Error('Version changed elsewhere'); };
	const operation = f.services.invokeFunction(CommandsRegistry.getCommand(ChatEditPendingRequestAction.ID)!, f.target) as Promise<void>;
	await ready(() => !!f.container.querySelector('textarea'));
	const input = f.container.querySelector('textarea')!; input.value = 'Keep failed edit';
	const submit = () => input.dispatchEvent(new browserEnvironment.window.KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }));
	submit();
	await ready(() => Array.from(f.container.querySelectorAll('[role="alert"]')).some(element => element.textContent?.includes('Version changed')));
	assert.equal(input.value, 'Keep failed edit');
	assert.equal(f.calls.length, 1);
	f.chat.editPendingRequest = save; submit(); await operation;
	assert.deepEqual(f.calls.at(-1), ['edit', { ...f.target, expectedRevision: 6 }, 'Keep failed edit']);
});

test('Queue item actions reject stale or cross-conversation identities before mutation', async () => {
	using f = queueFixture();
	const remove = CommandsRegistry.getCommand(ChatRemovePendingRequestAction.ID)!;
	for (const target of [{ ...f.target, expectedRevision: 4 }, { ...f.target, threadId: 'elsewhere' }, { ...f.target, expectedRevision: -1 }, { ...f.target, commandId: '' }]) {
		await assert.rejects(async () => { await f.services.invokeFunction(remove, target); });
	}
	assert.deepEqual(f.calls, []);
	await f.services.invokeFunction(remove, f.target);
	await f.services.invokeFunction(CommandsRegistry.getCommand(ChatSendPendingImmediatelyAction.ID)!, f.target);
	assert.deepEqual(f.calls, [['remove', f.target], ['send', f.target]]);
});

test('A queue picker closes when its captured conversation changes without modifying a successor', async () => {
	using f = queueFixture();
	const operation = f.services.invokeFunction(CommandsRegistry.getCommand(ChatRemovePendingRequestAction.ID)!) as Promise<void>;
	await ready(() => !!f.quickInput.currentQuickInput);
	const picker = f.quickInput.currentQuickInput as IQuickPick<{ label: string; }>;
	assert.equal(picker.sortByLabel, false);
	assert.equal(picker.items[0].label, 'Original message');
	Object.assign(f.widget, { threadId: 'successor' }); f.changed.fire();
	await operation;
	assert.deepEqual(f.calls, []);
});


test('Remove All captures queue revisions and reports partial failures without cancelling new arrivals', async () => {
	using f = queueFixture();
	const second = { ...f.original, commandId: 'second', revision: 9 };
	f.chat.getPendingRequests = async () => [f.original, second];
	f.chat.removePendingRequest = async target => {
		f.calls.push(target);
		if (target.commandId === 'second') throw new Error('Already delivering');
		return { ...f.original, status: 'cancelled' };
	};
	await assert.rejects(async () => { await f.services.invokeFunction(CommandsRegistry.getCommand(ChatRemoveAllPendingRequestsAction.ID)!); }, /Removed 1 queued messages. 1 messages changed/);
	assert.deepEqual(f.calls, [f.target, { ...f.target, commandId: 'second', expectedRevision: 9 }]);
});
