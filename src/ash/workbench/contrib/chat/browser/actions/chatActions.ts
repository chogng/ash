import { Action2, MenuId, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IMessageHistoryService } from '../../../../../platform/messageHistory/common/messageHistory.js';
import { localize, localize2 } from '../../../../../nls.js';
import { createUuid } from '../../../../../base/common/uuid.js';
import { IAgentSessionService } from '../../../../../platform/agentHost/common/agentService.js';
import { IChatSessionNavigationService } from '../../../../services/chat/common/chatSessionNavigationService.js';
import { ChatContextKeys } from '../../common/actions/chatContextKeys.js';
import { IChatService, type RewriteChatRequestOptions } from '../../../../services/chat/common/chatService.js';

export function registerChatActions(): void {
	registerAction2(
		class ResendRequestAction extends Action2 {
			constructor() {
				super({
					id: 'workbench.action.chat.resendRequest',
					title: localize2('chat.edit.command', 'Send Edited Request'),
				});
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
		},
	);
	registerAction2(
		class AddChatToSessionAction extends Action2 {
			private readonly pending = new Map<string, Promise<void>>();
			constructor() {
				super({
					id: 'sessions.chatCompositeBar.addChat',
					title: localize2('chat.addToSession', 'New Chat in Session'),
					precondition: ChatContextKeys.enabled.isEqualTo(true),
					f1: true,
					menu: { id: MenuId.ChatTitle, group: '2_conversation', order: 1 },
				});
			}

			override async run(accessor: ServicesAccessor, context?: unknown): Promise<void> {
				const navigation = accessor.get(IChatSessionNavigationService);
				const source = context ?? navigation.getActiveConversation();
				if (
					!source ||
					typeof source !== 'object' ||
					!('sessionId' in source) ||
					!('threadId' in source) ||
					typeof source.sessionId !== 'string' ||
					!source.sessionId ||
					typeof source.threadId !== 'string' ||
					!source.threadId
				)
					return;
				const { sessionId, threadId } = source;
				const revision = navigation.revision;
				const previous = this.pending.get(sessionId);
				if (previous) return previous;
				const sessions = accessor.get(IAgentSessionService);
				const operation = (async () => {
					const result = await sessions.createThread({
						sessionId,
						commandId: createUuid(),
						title: localize('chat.title.new', 'New Chat'),
					});
					const active = navigation.getActiveConversation();
					if (navigation.revision === revision && active?.sessionId === sessionId && active.threadId === threadId) {
						await navigation.openConversation(result.session.sessionId, result.threadId);
					}
				})();
				this.pending.set(sessionId, operation);
				try {
					await operation;
				} finally {
					this.pending.delete(sessionId);
				}
			}
		},
	);
	registerAction2(
		class ClearChatInputHistoryAction extends Action2 {
			constructor() {
				super({
					id: 'workbench.action.chat.clearInputHistory',
					title: localize2('chat.history.clear', 'Chat: Clear Input History'),
					f1: true,
				});
			}

			async run(accessor: ServicesAccessor): Promise<void> {
				const history = accessor.get(IMessageHistoryService);
				if (!history) throw new Error(localize('chat.history.unavailable', 'Input history is unavailable on this connection.'));
				await history.clear();
			}
		},
	);
}
