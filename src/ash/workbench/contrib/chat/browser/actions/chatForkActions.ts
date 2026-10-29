import { createUuid } from '../../../../../base/common/uuid.js';
import { Lxicon } from '../../../../../base/common/lxicons.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, MenuId } from '../../../../../platform/actions/common/actions.js';
import { IAccessibilityService } from '../../../../../platform/accessibility/common/accessibility.js';
import { IAgentThreadService } from '../../../../../platform/agentHost/common/agentService.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IChatService } from '../../../../services/chat/common/chatService.js';
import { IChatSessionNavigationService } from '../../../../services/chat/common/chatSessionNavigationService.js';
import { ChatContextKeys } from '../../common/actions/chatContextKeys.js';

export const ForkConversationActionId = 'workbench.action.chat.forkConversation';

/** Each window selects its destination policy; history and directory copying stay backend-owned. */
export class ForkConversationAction extends Action2 {
	protected readonly target: 'session' | 'thread' = 'session';
	private readonly pending = new Map<string, Promise<void>>();

	constructor() {
		super({
			id: ForkConversationActionId,
			title: localize2('chat.forkConversation.label', 'Fork Conversation'),
			icon: Lxicon.fork,
			precondition: ChatContextKeys.enabled.isEqualTo(true),
			f1: true,
			menu: { id: MenuId.ChatTitle, group: '2_conversation', order: 2 },
		});
	}

	override async run(accessor: ServicesAccessor, context?: unknown): Promise<void> {
		const navigation = accessor.get(IChatSessionNavigationService);
		const source = context ?? navigation.getActiveConversation();
		if (!source || typeof source !== 'object' || !('sessionId' in source) || !('threadId' in source)
			|| typeof source.sessionId !== 'string' || !source.sessionId || typeof source.threadId !== 'string' || !source.threadId) return;
		const { sessionId, threadId } = source;
		const revision = navigation.revision;
		const key = JSON.stringify([sessionId, threadId]);
		const previous = this.pending.get(key);
		if (previous) return previous;
		const chat = accessor.get(IChatService);
		const threads = accessor.get(IAgentThreadService);
		const accessibility = accessor.get(IAccessibilityService);
		const operation = (async () => {
			const { thread } = await chat.readThread(sessionId, threadId, { type: 'latest', turnLimit: 1 });
			const result = await threads.fork({
				sessionId, threadId, commandId: createUuid(), target: this.target,
				title: localize('chat.forked.title', 'Forked: {0}', thread.title),
			});
			const active = navigation.getActiveConversation();
			if (navigation.revision === revision && active?.sessionId === sessionId && active.threadId === threadId) {
				await navigation.openConversation(result.sessionId, result.threadId);
			}
			accessibility.status(localize('chat.forked.done', 'Conversation forked.'));
		})();
		this.pending.set(key, operation);
		try { await operation; } finally { this.pending.delete(key); }
	}
}
