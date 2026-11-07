import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { ChatResponseActionContext, IChatWidgetService, unwrapChatResponseActionContext } from '../../../../workbench/contrib/chat/browser/chat.js';
import { ChatContextKeys } from '../../../../workbench/contrib/chat/common/actions/chatContextKeys.js';
import { ChatGPTWidgetModel, ChatGPTResponseAvailableContext, ChatGPTResponseOnlineContext } from './chatGPTWidgetModel.js';
import { shareChatGPTConversation } from './chatGPTShare.js';

function responseTarget(accessor: ServicesAccessor, context: unknown) {
	const row = unwrapChatResponseActionContext(context);
	for (const widget of accessor.get(IChatWidgetService).getAllWidgets()) {
		const model = widget.model;
		if (!widget.visible || !(model instanceof ChatGPTWidgetModel)) continue;
		// The footer forwards the actual row. Resolve it in its visible widget so a
		// stale row or another backend cannot route an operation by matching IDs.
		const item = model.items.find(item => item === row);
		const target = item && model.getResponseActionTarget(item);
		if (target) return { ...target, model };
	}
	return undefined;
}

export function registerChatGPTResponseActions(): void {
	const available = ContextKeyExpr.and(ChatContextKeys.enabled.isEqualTo(true), ContextKeyExpr.has(ChatGPTResponseAvailableContext));
	const online = ContextKeyExpr.and(available, ContextKeyExpr.has(ChatGPTResponseOnlineContext));

	registerAction2(class ReadChatGPTResponseAction extends Action2 {
		constructor() {
			super({
				id: 'sessions.chatgpt.response.readAloud',
				title: localize2('chat.message.readAloud', 'Read aloud'),
				icon: Lxicon.unmute,
				menu: {
					id: MenuId.ChatMessageFooter, group: 'navigation', order: 2,
					when: ContextKeyExpr.and(online, ChatContextKeys.responseIsReadingAloud.isEqualTo(false)),
				},
			});
		}

		override async run(accessor: ServicesAccessor, context: unknown): Promise<void> {
			if (!(context instanceof ChatResponseActionContext)) return;
			const target = responseTarget(accessor, context);
			if (target?.online) {
				await context.read(signal => target.model.readResponseAloud(target.conversationId, target.messageId, context.window, signal));
			}
		}
	});

	registerAction2(class StopReadingChatGPTResponseAction extends Action2 {
		constructor() {
			super({
				id: 'sessions.chatgpt.response.stopReadAloud',
				title: localize2('chat.message.stopReadAloud', 'Stop reading aloud'),
				icon: Lxicon.mute,
				menu: {
					id: MenuId.ChatMessageFooter, group: 'navigation', order: 2,
					when: ContextKeyExpr.and(online, ChatContextKeys.responseIsReadingAloud.isEqualTo(true)),
				},
			});
		}

		override run(_accessor: ServicesAccessor, context: unknown): void {
			if (context instanceof ChatResponseActionContext) context.stop();
		}
	});

	registerAction2(class ForkChatGPTResponseAction extends Action2 {
		constructor() {
			super({
				id: 'sessions.chatgpt.response.fork',
				title: localize2('sessions.chatgpt.forkResponse', 'Fork in ChatGPT'),
				icon: Lxicon.fork,
				menu: { id: MenuId.ChatMessageFooter, group: '1_conversation', order: 1, when: online },
			});
		}

		override async run(accessor: ServicesAccessor, context: unknown): Promise<void> {
			const target = responseTarget(accessor, context);
			if (!target?.online) return;
			const url = `https://chatgpt.com/branch/${encodeURIComponent(target.conversationId)}/${encodeURIComponent(target.messageId)}`;
			if (!await accessor.get(IOpenerService).open(url, { openExternal: true })) {
				throw new Error(localize('sessions.chatgpt.openForkFailed', 'Could not open the conversation branch in ChatGPT.'));
			}
		}
	});

	registerAction2(class ShareChatGPTResponseAction extends Action2 {
		constructor() {
			super({
				id: 'sessions.chatgpt.response.share',
				title: localize2('sessions.chatgpt.shareResponse', 'Share ChatGPT response'),
				icon: Lxicon.share,
				menu: { id: MenuId.ChatMessageFooter, group: 'navigation', order: 11, when: online },
			});
		}

		override async run(accessor: ServicesAccessor, context: unknown): Promise<void> {
			const target = responseTarget(accessor, context);
			if (!target?.online) return;
			await shareChatGPTConversation(target.backend, accessor.get(IDialogService), accessor.get(IClipboardService),
				target.conversationId, target.title, target.messageId);
		}
	});

	registerAction2(class OpenChatGPTResponseConversationAction extends Action2 {
		constructor() {
			super({
				id: 'sessions.chatgpt.response.openOriginal',
				title: localize2('sessions.chatgpt.openConversationOnWeb', 'Open conversation in ChatGPT'),
				icon: Lxicon.openai,
				menu: { id: MenuId.ChatMessageFooter, group: 'navigation', order: 12, when: available },
			});
		}

		override async run(accessor: ServicesAccessor, context: unknown): Promise<void> {
			const target = responseTarget(accessor, context);
			if (!target) return;
			const url = `https://chatgpt.com/c/${encodeURIComponent(target.conversationId)}`;
			if (!await accessor.get(IOpenerService).open(url, { openExternal: true, fromUserGesture: true })) {
				throw new Error(localize('sessions.chatgpt.openConversationOnWebFailed', 'Could not open the conversation in ChatGPT.'));
			}
		}
	});
}
