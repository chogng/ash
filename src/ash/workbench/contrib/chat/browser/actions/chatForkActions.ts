import { createUuid } from '../../../../../base/common/uuid.js';
import { Lxicon } from '../../../../../base/common/lxicons.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, MenuId } from '../../../../../platform/actions/common/actions.js';
import { IAccessibilityService } from '../../../../../platform/accessibility/common/accessibility.js';
import { IAgentThreadService } from '../../../../../platform/agentHost/common/agentService.js';
import { buildOpenSessionLinkUri } from '../../../../../platform/agentHost/common/openSessionLink.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IChatService } from '../../../../services/chat/common/chatService.js';
import { IChatSessionNavigationService } from '../../../../services/chat/common/chatSessionNavigationService.js';
import { ChatContextKeys } from '../../common/actions/chatContextKeys.js';
import { getCompletedChatResponseSource } from '../../common/model/chatViewModel.js';
import { IChatWidgetService, unwrapChatResponseActionContext } from '../chat.js';

export const ForkConversationActionId = 'workbench.action.chat.forkConversation';

export interface IForkConversationOptions {
	readonly sessionId: string;
	readonly threadId: string;
	readonly beforeItemId: string;
	readonly toSide: boolean;
}

/** Each window selects its destination policy; history and directory copying stay backend-owned. */
export class ForkConversationAction extends Action2 {
	protected readonly target: 'session' | 'thread' = 'session';
	private readonly pending = new Map<string, Promise<void>>();

	constructor() {
		super({
			id: ForkConversationActionId,
			title: localize2('chat.forkConversation.label', 'Fork Conversation'),
			shortTitle: localize2('chat.forkConversation.response', 'Fork from this reply'),
			icon: Lxicon.fork,
			precondition: ChatContextKeys.enabled.isEqualTo(true),
			f1: true,
			menu: {
				id: MenuId.ChatMessageFooter,
				group: '1_conversation',
				order: 1,
				when: ContextKeyExpr.and(ChatContextKeys.enabled.isEqualTo(true), ChatContextKeys.responseCanFork.isEqualTo(true)),
			},
		});
	}

	override async run(accessor: ServicesAccessor, context?: unknown): Promise<void> {
		context = unwrapChatResponseActionContext(context);
		const navigation = accessor.get(IChatSessionNavigationService);
		const reply = context && typeof context === 'object' && 'canForkAfterResponse' in context && context.canForkAfterResponse === true
			? getCompletedChatResponseSource(context) : undefined;
		const source = reply ?? context ?? navigation.getActiveConversation();
		if (!source || typeof source !== 'object' || !('sessionId' in source) || !('threadId' in source)
			|| typeof source.sessionId !== 'string' || !source.sessionId || typeof source.threadId !== 'string' || !source.threadId) return;
		const { sessionId, threadId } = source;
		const beforeItemId = 'beforeItemId' in source ? source.beforeItemId : undefined;
		if (beforeItemId !== undefined && (typeof beforeItemId !== 'string' || !beforeItemId)) return;
		const checkpoint = reply ? { itemId: reply.itemId, boundary: 'after' as const }
			: beforeItemId ? { itemId: beforeItemId, boundary: 'before' as const } : undefined;
		const toSide = 'toSide' in source && source.toSide === true;
		const revision = navigation.revision;
		const key = JSON.stringify([sessionId, threadId, checkpoint?.itemId, checkpoint?.boundary]);
		const previous = this.pending.get(key);
		if (previous) return previous;
		const chat = accessor.get(IChatService);
		const threads = accessor.get(IAgentThreadService);
		const accessibility = accessor.get(IAccessibilityService);
		// Reply editors can be visible outside the main conversation pane. Their
		// conversation-link opener knows which editor should reveal the fork.
		const replyWidget = reply && !navigation.getActiveConversation() && navigation.prepareConversationLink
			? accessor.get(IChatWidgetService).getAllWidgets().find(widget => widget.visible && widget.sessionId === sessionId && widget.threadId === threadId)
			: undefined;
		const generation = replyWidget?.model?.composerGeneration;
		const opener = replyWidget ? accessor.get(IOpenerService) : undefined;
		const isReplyCurrent = () => replyWidget?.visible && replyWidget.model?.composerGeneration === generation
			&& replyWidget.sessionId === sessionId && replyWidget.threadId === threadId
			&& navigation.revision === revision && !navigation.getActiveConversation();
		const operation = (async () => {
			const { thread } = await chat.readThread(sessionId, threadId, { type: 'latest', turnLimit: 1 });
			const title = localize('chat.forked.title', 'Forked: {0}', thread.title);
			const result = await (checkpoint
				? chat.restoreCheckpoint({ sessionId, threadId, ...checkpoint, title })
				: threads.fork({ sessionId, threadId, commandId: createUuid(), target: this.target, title }));
			const active = navigation.getActiveConversation();
			if (navigation.revision === revision && active?.sessionId === sessionId && active.threadId === threadId) {
				if (toSide && navigation.openSideConversation) {
					await navigation.openSideConversation(result.sessionId, result.threadId);
				} else {
					await navigation.openConversation(result.sessionId, result.threadId);
				}
			} else if (opener && navigation.prepareConversationLink && isReplyCurrent()) {
				const address = await navigation.prepareConversationLink(result.sessionId, result.threadId);
				if (isReplyCurrent()) await opener.open(buildOpenSessionLinkUri(address.sessionId, address.threadId, address.connectionAuthority));
			}
			accessibility.status(localize('chat.forked.done', 'Conversation forked.'));
		})();
		this.pending.set(key, operation);
		try { await operation; } finally { this.pending.delete(key); }
	}
}
