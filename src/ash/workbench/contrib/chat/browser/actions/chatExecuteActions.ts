import { KeyCode, KeyMod } from '../../../../../base/common/keyCodes.js';
import { Keybinding, physicalKey } from '../../../../../base/common/keybindings.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { KeybindingWeight } from '../../../../../platform/keybinding/common/keybindingsRegistry.js';
import { ChatRequestQueueKind } from '../../../../services/chat/common/chatService.js';
import { ChatContextKeys } from '../../common/actions/chatContextKeys.js';
import { IChatWidgetService, type IChatWidget, type IChatAcceptInputOptions } from '../chat.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IChatService, type RewriteChatRequestOptions } from '../../../../services/chat/common/chatService.js';
import { IChatSessionNavigationService } from '../../../../services/chat/common/chatSessionNavigationService.js';

export interface IChatExecuteActionContext {
	readonly widget?: IChatWidget;
	readonly inputValue?: string;
	readonly acceptInputOptions?: IChatAcceptInputOptions;
}

export function readExecuteContext(value: unknown): IChatExecuteActionContext {
	if (value === undefined) { return {}; }
	const invalid = localize('chat.execute.invalid', 'The chat execution context is invalid.');
	if (!value || typeof value !== 'object' || Array.isArray(value)) { throw new TypeError(invalid); }
	const context = value as IChatExecuteActionContext;
	if (context.widget !== undefined && (!context.widget || typeof context.widget !== 'object' || Array.isArray(context.widget))) { throw new TypeError(invalid); }
	if (context.inputValue !== undefined && typeof context.inputValue !== 'string') { throw new TypeError(invalid); }
	const options = context.acceptInputOptions;
	if (options !== undefined && (!options || typeof options !== 'object' || Array.isArray(options)
		|| Object.keys(options).some(key => key !== 'queue' && key !== 'cancelCurrentRequest' && key !== 'sideChat')
		|| options.queue !== undefined && options.queue !== ChatRequestQueueKind.Queued && options.queue !== ChatRequestQueueKind.Steering
		|| options.cancelCurrentRequest !== undefined && typeof options.cancelCurrentRequest !== 'boolean'
		|| options.cancelCurrentRequest === true && options.queue !== undefined
		|| options.sideChat !== undefined && typeof options.sideChat !== 'boolean'
		|| options.sideChat === true && (options.queue !== undefined || options.cancelCurrentRequest === true))) {
		throw new TypeError(invalid);
	}
	return context;
}

export class ChatSubmitAction extends Action2 {
	public static readonly ID = 'workbench.action.chat.submit';
	constructor() {
		super({ id: ChatSubmitAction.ID, title: localize2('chat.execute.submit', 'Chat: Send Message'), f1: true, precondition: ChatContextKeys.enabled.isEqualTo(true) });
	}
	public override async run(accessor: ServicesAccessor, value?: unknown): Promise<void> {
		const context = readExecuteContext(value);
		const widgets = accessor.get(IChatWidgetService);
		const widget = context.widget ?? widgets.lastFocusedWidget;
		if (!widget?.visible) { return; }
		if (!widgets.getAllWidgets().includes(widget)) { throw new TypeError(localize('chat.execute.invalid', 'The chat execution context is invalid.')); }
		await widget.acceptInput(context.inputValue, context.acceptInputOptions);
	}
}

export const CancelChatActionId = 'workbench.action.chat.cancel';

export class OpenModelPickerAction extends Action2 {
	public static readonly ID = 'workbench.action.chat.openModelPicker';
	constructor() {
		super({
			id: OpenModelPickerAction.ID, title: localize2('chat.execute.modelPicker', 'Chat: Open Model Picker'), f1: true, precondition: ChatContextKeys.enabled.isEqualTo(true), keybinding: {
				primary: Keybinding.single(physicalKey('Period', { primaryKey: true, altKey: true })), weight: KeybindingWeight.WorkbenchContrib, when: ChatContextKeys.inChatInput.isEqualTo(true),
			}
		});
	}
	public override run(accessor: ServicesAccessor): void {
		const widget = accessor.get(IChatWidgetService).lastFocusedWidget;
		if (widget?.visible) widget.input.openModelPicker();
	}
}

export class OpenModePickerAction extends Action2 {
	public static readonly ID = 'workbench.action.chat.openModePicker';
	constructor() {
		super({
			id: OpenModePickerAction.ID, title: localize2('chat.execute.modePicker', 'Chat: Open Mode or Agent Picker'), f1: true, precondition: ChatContextKeys.enabled.isEqualTo(true), keybinding: {
				primary: Keybinding.single(physicalKey('Period', { primaryKey: true })), weight: KeybindingWeight.WorkbenchContrib, when: ChatContextKeys.inChatInput.isEqualTo(true),
			}
		});
	}
	public override run(accessor: ServicesAccessor): void {
		const widget = accessor.get(IChatWidgetService).lastFocusedWidget;
		if (widget?.visible) widget.input.openModePicker();
	}
}

export class OpenPermissionPickerAction extends Action2 {
	public static readonly ID = 'workbench.action.chat.openPermissionPicker';
	constructor() {
		super({ id: OpenPermissionPickerAction.ID, title: localize2('chat.execute.permissionPicker', 'Chat: Open Permission Picker'), f1: true, precondition: ChatContextKeys.enabled.isEqualTo(true) });
	}
	public override run(accessor: ServicesAccessor): void {
		const widget = accessor.get(IChatWidgetService).lastFocusedWidget;
		if (widget?.visible) widget.input.openPermissionPicker();
	}
}

export class CancelAction extends Action2 {
	public static readonly ID = CancelChatActionId;
	constructor() {
		super({
			id: CancelAction.ID, title: localize2('chat.execute.cancel', 'Chat: Stop Task'), f1: true,
			// An active request remains cancellable when AI features are disabled.
			precondition: ContextKeyExpr.or(ChatContextKeys.enabled.isEqualTo(true), ChatContextKeys.hasActiveRequest.isEqualTo(true)),
			keybinding: {
				primary: KeyMod.CtrlCmd | KeyCode.Escape,
				mac: { primary: KeyMod.WinCtrl | KeyCode.Escape },
				win: { primary: KeyMod.Alt | KeyCode.Backspace },
				weight: KeybindingWeight.WorkbenchContrib,
				when: ContextKeyExpr.and(ChatContextKeys.inChatSession.isEqualTo(true), ChatContextKeys.hasActiveRequest.isEqualTo(true)),
			},
		});
	}
	public override run(accessor: ServicesAccessor, value?: unknown): void {
		const context = readExecuteContext(value);
		const widgets = accessor.get(IChatWidgetService);
		const widget = context.widget ?? widgets.lastFocusedWidget;
		if (!widget?.visible) { return; }
		if (!widgets.getAllWidgets().includes(widget)) { throw new TypeError(localize('chat.execute.invalid', 'The chat execution context is invalid.')); }
		widget.cancelTranscriptProgress?.();
	}
}

export function registerChatExecuteActions(): DisposableStore {
	const store = new DisposableStore();
	store.add(registerAction2(ChatSubmitAction));
	store.add(registerAction2(CancelAction));
	store.add(registerAction2(OpenModelPickerAction));
	store.add(registerAction2(OpenModePickerAction));
	store.add(registerAction2(OpenPermissionPickerAction));
	store.add(registerAction2(class ResendRequestAction extends Action2 {
		constructor() {
			super({ id: 'workbench.action.chat.resendRequest', title: localize2('chat.edit.command', 'Send Edited Request') });
		}

		override async run(accessor: ServicesAccessor, context: unknown): Promise<void> {
			const invalid = localize('chat.edit.invalid', 'Choose an accepted request and enter a non-empty message before sending.');
			if (!context || typeof context !== 'object') throw new TypeError(invalid);
			const value = context as Record<string, unknown>;
			for (const key of ['sessionId', 'threadId', 'turnId', 'itemId', 'text', 'commandId']) {
				if (typeof value[key] !== 'string' || !(value[key] as string).trim()) throw new TypeError(invalid);
			}
			const options = value as unknown as RewriteChatRequestOptions;
			const navigation = accessor.get(IChatSessionNavigationService);
			const revision = navigation.revision;
			const result = await accessor.get(IChatService).rewriteRequest(options);
			const active = navigation.getActiveConversation();
			if (navigation.revision === revision && active?.sessionId === options.sessionId && active.threadId === options.threadId) {
				await navigation.openConversation(result.sessionId, result.threadId);
			}
		}
	}));
	return store;
}
