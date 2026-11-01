import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { localize, localize2 } from '../../../../../nls.js';
import { ChatRequestQueueKind } from '../../../../services/chat/common/chatService.js';
import { ChatContextKeys } from '../../common/actions/chatContextKeys.js';
import { IChatWidgetService, type IChatWidget } from '../chat.js';
import { IChatService, type QueuedMessage, type QueueMessageTarget } from '../../../../services/chat/common/chatService.js';
import { IQuickInputService, type IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { createUuid } from '../../../../../base/common/uuid.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { addDisposableListener, h } from '../../../../../base/browser/dom.js';
import { InputBox } from '../../../../../base/browser/ui/inputbox/inputbox.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { Dialog } from '../../../../../base/browser/ui/dialog/dialog.js';
import { defaultButtonStyles, defaultCheckboxStyles, defaultDialogStyles, defaultInputBoxStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { status } from '../../../../../base/browser/ui/aria/aria.js';

export class ChatQueueMessageAction extends Action2 {
	public static readonly ID = 'workbench.action.chat.queueMessage';
	constructor() {
		super({ id: ChatQueueMessageAction.ID, title: localize2('chat.queueMessage', 'Chat: Add Message to Queue'), f1: true, precondition: ChatContextKeys.enabled.isEqualTo(true) });
	}
	public override async run(accessor: ServicesAccessor): Promise<void> {
		const widget = accessor.get(IChatWidgetService).lastFocusedWidget;
		if (widget?.visible) { await widget.acceptInput(undefined, { queue: ChatRequestQueueKind.Queued }); }
	}
}

export class ChatSteerWithMessageAction extends Action2 {
	public static readonly ID = 'workbench.action.chat.steerWithMessage';
	constructor() {
		super({ id: ChatSteerWithMessageAction.ID, title: localize2('chat.steerWithMessage', 'Chat: Steer with Message'), f1: true, precondition: ChatContextKeys.enabled.isEqualTo(true) });
	}
	public override async run(accessor: ServicesAccessor): Promise<void> {
		const widget = accessor.get(IChatWidgetService).lastFocusedWidget;
		if (widget?.visible) { await widget.acceptInput(undefined, { queue: ChatRequestQueueKind.Steering }); }
	}
}

function messageTarget(message: QueuedMessage): QueueMessageTarget {
	return { sessionId: message.sessionId, threadId: message.threadId, commandId: message.commandId, expectedRevision: message.revision };
}

function readTarget(value: unknown): QueueMessageTarget | undefined {
	if (value === undefined) return undefined;
	const invalid = localize('chat.queue.invalidTarget', 'Choose a queued message with a valid identity and revision.');
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(invalid);
	const target = value as QueueMessageTarget;
	if ([target.sessionId, target.threadId, target.commandId].some(id => typeof id !== 'string' || !id.trim())
		|| !Number.isSafeInteger(target.expectedRevision) || target.expectedRevision < 0) {
		throw new TypeError(invalid);
	}
	return target;
}

/** The picker captures one conversation; focus changes never retarget its selection. */
async function selectMessage(accessor: ServicesAccessor, value?: unknown): Promise<{ message: QueuedMessage; widget: IChatWidget; } | undefined> {
	const target = readTarget(value);
	const registry = accessor.get(IChatWidgetService);
	const chat = accessor.get(IChatService);
	const quickInput = accessor.get(IQuickInputService);
	const notifications = accessor.get(INotificationService);
	const widget = registry.lastFocusedWidget;
	if (!widget?.visible || !widget.sessionId || !widget.threadId) return;
	const { sessionId, threadId } = widget;
	if (target && (target.sessionId !== sessionId || target.threadId !== threadId)) throw new TypeError(localize('chat.queue.invalidTarget', 'Choose a queued message with a valid identity and revision.'));
	const current = () => widget.visible && widget.sessionId === sessionId && widget.threadId === threadId && registry.getAllWidgets().includes(widget);
	const messages = await chat.getPendingRequests(sessionId, threadId);
	if (!current()) return;
	if (target) {
		const message = messages.find(item => item.commandId === target.commandId && item.revision === target.expectedRevision);
		if (!message) throw new Error(localize('chat.queue.conflict', 'This queued message changed or has already started. Choose it again from the queue.'));
		return { message, widget };
	}
	if (!messages.length) { notifications.info(localize('chat.queue.empty', 'This conversation has no queued messages.')); return; }
	using lifetime = new DisposableStore();
	const picker = lifetime.add(quickInput.createQuickPick<IQuickPickItem & { message: QueuedMessage; }>());
	picker.title = localize('chat.queue.choose', 'Choose a queued message');
	picker.ariaLabel = picker.title;
	picker.placeholder = localize('chat.queue.chooseHint', 'Messages are listed in queue order. Escape keeps the queue unchanged.');
	picker.sortByLabel = false;
	picker.items = messages.map(message => ({
		label: message.text.replace(/\s+/gu, ' ').trim() || localize('chat.queue.contextOnly', 'Message with attached context'),
		description: message.status === 'paused' ? localize('chat.queue.paused', 'Paused') : message.status === 'rejected' ? localize('chat.queue.rejected', 'Failed') : localize('chat.queue.pending', 'Queued'),
		detail: localize('chat.queue.contextCount', '{0} attached inputs', message.contextCount), message,
	}));
	return await new Promise(resolve => {
		lifetime.add(widget.onDidHide(() => picker.hide()));
		lifetime.add(widget.onDidChangeViewModel(() => { if (!current()) picker.hide(); }));
		lifetime.add(picker.onDidAccept(() => {
			const item = picker.selectedItems[0];
			if (!item || !current()) return;
			resolve({ message: item.message, widget });
			picker.hide();
		}));
		lifetime.add(picker.onDidHide(() => resolve(undefined)));
		picker.show();
	});
}

/** The dialog owns temporary multiline text; the composer and frozen input are untouched. */
async function editMessage(chat: IChatService, widget: IChatWidget, original: QueuedMessage): Promise<void> {
	const paused = await chat.pausePendingRequest(messageTarget(original));
	const current = () => widget.visible && widget.sessionId === paused.sessionId && widget.threadId === paused.threadId && widget.domNode.isConnected;
	const resume = () => original.status === 'pending' ? chat.resumePendingRequest(messageTarget(paused)).then(() => undefined) : Promise.resolve();
	if (!current()) { await resume(); return; }
	using lifetime = new DisposableStore();
	const content = h(widget.domNode.ownerDocument, 'div');
	const input = lifetime.add(new InputBox(content, { flexibleHeight: true, flexibleMaxHeight: 240, ariaLabel: localize('chat.queue.editTitle', 'Edit queued message'), inputBoxStyles: defaultInputBoxStyles }));
	input.value = paused.text;
	const hint = h(content.ownerDocument, 'p');
	hint.textContent = localize('chat.queue.editHint', 'The message is paused while editing. Ctrl or Command+Enter saves. Escape cancels. Attached inputs and the unsent draft are kept. Previously paused or failed messages stay paused when cancelled.');
	hint.id = createUuid();
	input.inputElement.setAttribute('aria-describedby', hint.id);
	const feedback = h(content.ownerDocument, 'p');
	feedback.setAttribute('role', 'alert');
	content.append(hint, feedback);
	const save = lifetime.add(new Button(content, { label: localize('chat.queue.save', 'Save queued message'), presentation: 'primary' }));
	save.enabled = !!input.value.trim();
	const dialog = lifetime.add(new Dialog(widget.domNode, localize('chat.queue.editTitle', 'Edit queued message'), undefined, {
		disableDefaultAction: true,
		buttonStyles: defaultButtonStyles, checkboxStyles: defaultCheckboxStyles, dialogStyles: defaultDialogStyles, inputBoxStyles: defaultInputBoxStyles,
		renderBody: container => container.append(content),
	}));
	let saved = false;
	let hidden = false;
	let pending: Promise<void> | undefined;
	try {
		const submit = (): void => {
			if (pending || !input.value.trim() || !current()) return;
			input.inputElement.readOnly = true;
			save.enabled = false;
			feedback.textContent = '';
			pending = chat.editPendingRequest(messageTarget(paused), input.value).then(() => {
				saved = true;
				status(localize('chat.queue.saved', 'Queued message saved.'));
				dialog.dispose();
			}, error => {
				if (!hidden) feedback.textContent = localize('chat.queue.saveFailed', 'Could not save queued message: {0}', String(error instanceof Error ? error.message : error));
			}).finally(() => {
				pending = undefined;
				input.inputElement.readOnly = false;
				save.enabled = !!input.value.trim();
			});
		};
		lifetime.add(save.onDidClick(submit));
		lifetime.add(addDisposableListener(input.inputElement, 'input', () => { save.enabled = !!input.value.trim(); }));
		lifetime.add(addDisposableListener(input.inputElement, 'keydown', event => {
			if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) { event.preventDefault(); event.stopPropagation(); submit(); }
		}));
		lifetime.add(widget.onDidHide(() => dialog.dispose()));
		lifetime.add(widget.onDidChangeViewModel(() => { if (!current()) dialog.dispose(); }));
		await dialog.show();
		hidden = true;
		await pending;
	} finally {
		if (!saved) await resume();
		if (current()) widget.focusInput();
	}
}

export class ChatEditPendingRequestAction extends Action2 {
	public static readonly ID = 'workbench.action.chat.editPendingRequest';
	constructor() { super({ id: ChatEditPendingRequestAction.ID, title: localize2('chat.queue.edit', 'Chat: Edit Queued Message'), f1: true, precondition: ChatContextKeys.enabled.isEqualTo(true) }); }
	public override async run(accessor: ServicesAccessor, value?: unknown): Promise<void> {
		const chat = accessor.get(IChatService);
		const selected = await selectMessage(accessor, value);
		if (selected) await editMessage(chat, selected.widget, selected.message);
	}
}

export class ChatRemovePendingRequestAction extends Action2 {
	public static readonly ID = 'workbench.action.chat.removePendingRequest';
	constructor() { super({ id: ChatRemovePendingRequestAction.ID, title: localize2('chat.queue.remove', 'Chat: Remove Queued Message'), f1: true, precondition: ChatContextKeys.enabled.isEqualTo(true) }); }
	public override async run(accessor: ServicesAccessor, value?: unknown): Promise<void> {
		const chat = accessor.get(IChatService);
		const selected = await selectMessage(accessor, value);
		if (selected) { await chat.removePendingRequest(messageTarget(selected.message)); status(localize('chat.queue.removed', 'Queued message removed.')); }
	}
}

export class ChatSendPendingImmediatelyAction extends Action2 {
	public static readonly ID = 'workbench.action.chat.sendPendingImmediately';
	constructor() { super({ id: ChatSendPendingImmediatelyAction.ID, title: localize2('chat.queue.sendNow', 'Chat: Send Queued Message Immediately'), f1: true, precondition: ChatContextKeys.enabled.isEqualTo(true) }); }
	public override async run(accessor: ServicesAccessor, value?: unknown): Promise<void> {
		const chat = accessor.get(IChatService);
		const selected = await selectMessage(accessor, value);
		if (selected) await chat.sendPendingRequestImmediately(messageTarget(selected.message));
	}
}

export class ChatRemoveAllPendingRequestsAction extends Action2 {
	public static readonly ID = 'workbench.action.chat.removeAllPendingRequests';
	constructor() { super({ id: ChatRemoveAllPendingRequestsAction.ID, title: localize2('chat.queue.removeAll', 'Chat: Remove All Queued Messages'), f1: true, precondition: ChatContextKeys.enabled.isEqualTo(true) }); }
	public override async run(accessor: ServicesAccessor): Promise<void> {
		const chat = accessor.get(IChatService);
		const widget = accessor.get(IChatWidgetService).lastFocusedWidget;
		if (!widget?.visible || !widget.sessionId || !widget.threadId) return;
		const messages = await chat.getPendingRequests(widget.sessionId, widget.threadId);
		// Remove only the revisions captured by this command; newly queued input stays queued.
		const results = await Promise.allSettled(messages.map(message => chat.removePendingRequest(messageTarget(message))));
		const failures = results.filter(result => result.status === 'rejected');
		if (failures.length) throw new AggregateError(failures.map(result => result.reason), localize('chat.queue.removeAllFailed', 'Removed {0} queued messages. {1} messages changed or could not be removed; check the queue again.', results.length - failures.length, failures.length));
		status(localize('chat.queue.removedCount', 'Removed {0} queued messages.', messages.length));
	}
}

export function registerChatQueueActions(): void {
	registerAction2(ChatQueueMessageAction);
	registerAction2(ChatSteerWithMessageAction);
	registerAction2(ChatEditPendingRequestAction);
	registerAction2(ChatRemovePendingRequestAction);
	registerAction2(ChatSendPendingImmediatelyAction);
	registerAction2(ChatRemoveAllPendingRequestsAction);
}
