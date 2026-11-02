import { Action2, MenuId, MenusRegistry, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { Keybinding, logicalKey } from '../../../../../base/common/keybindings.js';
import { KeybindingWeight } from '../../../../../platform/keybinding/common/keybindingsRegistry.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { Lxicon } from '../../../../../base/common/lxicons.js';
import { ChatConfiguration } from '../../common/constants.js';
import { ChatSubmitAction, readExecuteContext } from './chatExecuteActions.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { localize, localize2 } from '../../../../../nls.js';
import { ChatRequestQueueKind } from '../../../../services/chat/common/chatService.js';
import { ChatContextKeys } from '../../common/actions/chatContextKeys.js';
import { IChatWidgetService, type IChatWidget } from '../chat.js';
import { IChatService, type QueuedMessage, type QueueMessageTarget } from '../../../../services/chat/common/chatService.js';
import { IQuickInputService, type IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { status } from '../../../../../base/browser/ui/aria/aria.js';

const editingQueue = ChatContextKeys.editingRequestType.isEqualTo(ChatContextKeys.EditingRequestType.Queue);
const editingSteer = ChatContextKeys.editingRequestType.isEqualTo(ChatContextKeys.EditingRequestType.Steer);
const editingPending = ContextKeyExpr.or(editingQueue, editingSteer)!;
const steerDefault = ContextKeyExpr.equals(`config.${ChatConfiguration.RequestQueueingDefaultAction}`, 'steer');
const notEditingPending = ContextKeyExpr.and(
	ContextKeyExpr.notEquals(ChatContextKeys.editingRequestType.key, ChatContextKeys.EditingRequestType.Queue),
	ContextKeyExpr.notEquals(ChatContextKeys.editingRequestType.key, ChatContextKeys.EditingRequestType.Steer),
);
const effectiveQueue = ContextKeyExpr.or(editingQueue, ContextKeyExpr.and(notEditingPending, ContextKeyExpr.notEquals(`config.${ChatConfiguration.RequestQueueingDefaultAction}`, 'steer')))!;
const effectiveSteer = ContextKeyExpr.or(editingSteer, ContextKeyExpr.and(notEditingPending, steerDefault))!;
const queueAvailable = ContextKeyExpr.and(
	ChatContextKeys.enabled.isEqualTo(true), ChatContextKeys.inputHasText.isEqualTo(true), ChatContextKeys.inputBlocked.isEqualTo(false),
	ChatContextKeys.transcriptProgressActive.isEqualTo(false),
);
const queueVisible = ContextKeyExpr.and(
	ContextKeyExpr.or(ChatContextKeys.requestInProgress.isEqualTo(true), editingPending),
	ContextKeyExpr.notEquals(ChatContextKeys.editingRequestType.key, ChatContextKeys.EditingRequestType.Sent),
	ChatContextKeys.inputHasText.isEqualTo(true), ChatContextKeys.transcriptProgressActive.isEqualTo(false),
);

export class ChatQueueMessageAction extends Action2 {
	public static readonly ID = 'workbench.action.chat.queueMessage';
	constructor() {
		super({
			id: ChatQueueMessageAction.ID, title: localize2('chat.queueMessage', 'Chat: Add Message to Queue'),
			f1: true, precondition: ChatContextKeys.enabled.isEqualTo(true),
			keybinding: [
				{ primary: Keybinding.single(logicalKey('Enter')), when: ContextKeyExpr.and(queueAvailable, ChatContextKeys.inChatInput.isEqualTo(true), queueVisible, effectiveQueue), weight: KeybindingWeight.EditorContrib + 1 },
				{ primary: Keybinding.single(logicalKey('Enter', { altKey: true })), when: ContextKeyExpr.and(queueAvailable, ChatContextKeys.inChatInput.isEqualTo(true), queueVisible, effectiveSteer), weight: KeybindingWeight.EditorContrib + 1 },
			],
		});
	}
	public override async run(accessor: ServicesAccessor, value?: unknown): Promise<void> {
		const context = readExecuteContext(value);
		await accessor.get(ICommandService).executeCommand(ChatSubmitAction.ID, { ...context, acceptInputOptions: { queue: ChatRequestQueueKind.Queued } });
	}
}

export class ChatSteerWithMessageAction extends Action2 {
	public static readonly ID = 'workbench.action.chat.steerWithMessage';
	constructor() {
		super({
			id: ChatSteerWithMessageAction.ID, title: localize2('chat.steerWithMessage', 'Chat: Steer with Message'),
			f1: true, precondition: ChatContextKeys.enabled.isEqualTo(true),
			keybinding: [
				{ primary: Keybinding.single(logicalKey('Enter')), when: ContextKeyExpr.and(queueAvailable, ChatContextKeys.inChatInput.isEqualTo(true), queueVisible, effectiveSteer), weight: KeybindingWeight.EditorContrib + 1 },
				{ primary: Keybinding.single(logicalKey('Enter', { altKey: true })), when: ContextKeyExpr.and(queueAvailable, ChatContextKeys.inChatInput.isEqualTo(true), queueVisible, effectiveQueue), weight: KeybindingWeight.EditorContrib + 1 },
			],
		});
	}
	public override async run(accessor: ServicesAccessor, value?: unknown): Promise<void> {
		const context = readExecuteContext(value);
		await accessor.get(ICommandService).executeCommand(ChatSubmitAction.ID, { ...context, acceptInputOptions: { queue: ChatRequestQueueKind.Steering } });
	}
}

export class ChatAskInSideChatAction extends Action2 {
	static readonly ID = 'workbench.action.chat.askInSideChat';
	constructor() {
		super({ id: ChatAskInSideChatAction.ID, title: localize2('chat.askInSideChat', 'Ask in Side Chat'), precondition: queueAvailable, f1: false });
	}
	override async run(accessor: ServicesAccessor, value?: unknown): Promise<void> {
		const context = readExecuteContext(value);
		await accessor.get(ICommandService).executeCommand(ChatSubmitAction.ID, { ...context, acceptInputOptions: { sideChat: true } });
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


export class ChatEditPendingRequestAction extends Action2 {
	public static readonly ID = 'workbench.action.chat.editPendingRequest';
	constructor() { super({ id: ChatEditPendingRequestAction.ID, title: localize2('chat.queue.edit', 'Chat: Edit Queued Message'), f1: true, precondition: ChatContextKeys.enabled.isEqualTo(true) }); }
	public override async run(accessor: ServicesAccessor, value?: unknown): Promise<void> {
		const selected = await selectMessage(accessor, value);
		if (selected) await selected.widget.startEditing(selected.message.commandId);
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
	registerAction2(ChatAskInSideChatAction);
	registerAction2(ChatEditPendingRequestAction);
	registerAction2(ChatRemovePendingRequestAction);
	registerAction2(ChatSendPendingImmediatelyAction);
	registerAction2(ChatRemoveAllPendingRequestsAction);
	MenusRegistry.appendMenuItem(MenuId.ChatExecuteQueue, {
		command: { id: ChatQueueMessageAction.ID, title: localize2('chat.queuePicker.queue', 'Add to Queue'), icon: Lxicon.add, precondition: queueAvailable }, group: 'navigation', order: 1,
	});
	MenusRegistry.appendMenuItem(MenuId.ChatExecuteQueue, {
		command: { id: ChatSteerWithMessageAction.ID, title: localize2('chat.queuePicker.steer', 'Steer with Message'), icon: Lxicon.enter, precondition: queueAvailable }, group: 'navigation', order: 2,
	});
	MenusRegistry.appendMenuItem(MenuId.ChatExecute, {
		submenu: MenuId.ChatExecuteQueue, title: localize2('chat.queuePicker.label', 'Send a Follow-up Message'), when: queueVisible, group: 'navigation',
	});
}
