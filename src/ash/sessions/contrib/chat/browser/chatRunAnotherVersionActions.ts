import { createUuid } from '../../../../base/common/uuid.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ChatContextKeys } from '../../../../workbench/contrib/chat/common/actions/chatContextKeys.js';
import { isChatResponseFeedbackTarget } from '../../../../workbench/contrib/chat/common/chatResponseFeedback.js';
import { IChatService } from '../../../../workbench/services/chat/common/chatService.js';
import { IChatSessionNavigationService } from '../../../../workbench/services/chat/common/chatSessionNavigationService.js';
import { completedTurnChangeSets } from '../../../browser/turnMultiDiffSource.js';
import { SessionsWorkspaceModeContext } from '../../../common/contextkeys.js';

const code = SessionsWorkspaceModeContext.isEqualTo('code');

registerAction2(class RunAnotherChatVersionAction extends Action2 {
	private readonly pending = new Set<string>();

	constructor() {
		super({
			id: 'sessions.chat.runAnotherVersion',
			title: localize2('sessions.requestVersions.run', 'Run another version'),
			precondition: ContextKeyExpr.and(code, ChatContextKeys.enabled.isEqualTo(true)),
			menu: { id: MenuId.ChatMessageCheckpoint, group: '1_execution', order: 1, when: ContextKeyExpr.and(code, ChatContextKeys.requestCanRunAnotherVersion.isEqualTo(true)) },
		});
	}

	override async run(accessor: ServicesAccessor, target: unknown): Promise<void> {
		if (!isChatResponseFeedbackTarget(target)) return;
		const navigation = accessor.get(IChatSessionNavigationService);
		const revision = navigation.revision;
		const { sessionId, threadId, turnId, itemId } = target;
		const isCurrent = () => {
			const current = navigation.getActiveConversation();
			return revision === navigation.revision && current?.sessionId === sessionId && current.threadId === threadId;
		};
		const key = JSON.stringify([sessionId, threadId, turnId]);
		if (!isCurrent() || this.pending.has(key)) return;
		const chat = accessor.get(IChatService);
		this.pending.add(key);
		try {
			const changes = await chat.listTurnChanges(sessionId, threadId);
			if (!isCurrent()) return;
			if (!completedTurnChangeSets(changes, target).length) {
				throw new Error(localize('sessions.requestVersions.unavailable', 'The completed Git checkpoint for this request is unavailable.'));
			}
			const result = await chat.rewriteRequest({ sessionId, threadId, turnId, itemId, commandId: createUuid() });
			if (isCurrent()) await navigation.openConversation(result.sessionId, result.threadId);
		} finally {
			this.pending.delete(key);
		}
	}
});
