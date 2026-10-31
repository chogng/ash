import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IMessageHistoryService } from '../../../../../platform/messageHistory/common/messageHistory.js';
import { localize, localize2 } from '../../../../../nls.js';
import { IChatSessionNavigationService } from '../../../../services/chat/common/chatSessionNavigationService.js';
import { IChatService, type RewriteChatRequestOptions } from '../../../../services/chat/common/chatService.js';

export function registerChatActions(): void {
	registerAction2(class ResendRequestAction extends Action2 {
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
	});
	registerAction2(class ClearChatInputHistoryAction extends Action2 {
		constructor() {
			super({ id: 'workbench.action.chat.clearInputHistory', title: localize2('chat.history.clear', 'Chat: Clear Input History'), f1: true });
		}

		async run(accessor: ServicesAccessor): Promise<void> {
			const history = accessor.get(IMessageHistoryService);
			if (!history) throw new Error(localize('chat.history.unavailable', 'Input history is unavailable on this connection.'));
			await history.clear();
		}
	});
}
